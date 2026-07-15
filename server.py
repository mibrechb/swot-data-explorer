"""Serve the SWOT web explorer locally and proxy approved API requests."""

from __future__ import annotations

import logging
import os
import re
import ssl
import time
from pathlib import Path
from typing import Any

import certifi
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

PROJECT_DIR = Path(__file__).resolve().parent

HYDROWEB_WFS_URL = (
    'https://hydroweb.next.theia-land.fr/geoserver/REF_DATA/ows'
)
HYDROCRON_URL = (
    'https://soto.podaac.earthdatacloud.nasa.gov/'
    'hydrocron/v1/timeseries'
)

ALLOWED_WFS_LAYERS = {
    'swot_prior_lake_db',
    'swot_prior_river_db',
    'REF_DATA:swot_prior_river_db_node',
}
ALLOWED_HYDROCRON_FEATURES = {'PriorLake', 'Reach', 'Node'}

MAX_WFS_FEATURES = 5000
MAX_FIELDS_LENGTH = 4000
UPSTREAM_TIMEOUT_SECONDS = 30.0
FEATURE_ID_PATTERN = re.compile(r'^[A-Za-z0-9_.:-]{1,80}$')

LOGGER = logging.getLogger('swot.local')
app = FastAPI(title='SWOT Lake and River Explorer')


@app.middleware('http')
async def local_development_headers(request: Request, call_next):
    """Disable frontend caching and add basic response hardening."""
    started_at = time.perf_counter()
    response = await call_next(request)

    if request.url.path == '/' or request.url.path.startswith('/assets/'):
        response.headers['Cache-Control'] = 'no-store, max-age=0'
        response.headers['Pragma'] = 'no-cache'

    response.headers['X-Content-Type-Options'] = 'nosniff'

    if request.url.path.startswith('/api/'):
        LOGGER.info(
            'route=%s status=%s duration_ms=%d',
            request.url.path,
            response.status_code,
            round((time.perf_counter() - started_at) * 1000),
        )

    return response


def _ssl_context() -> ssl.SSLContext | bool:
    """Return an SSL verifier using certifi or a configured CA bundle."""
    if os.getenv('SWOT_DISABLE_SSL_VERIFY') == '1':
        LOGGER.warning('TLS certificate verification is disabled.')
        return False

    ca_bundle = os.getenv('SWOT_CA_BUNDLE', certifi.where())
    return ssl.create_default_context(cafile=ca_bundle)


def _forward_headers(
    upstream: httpx.Response,
    cache_seconds: int,
) -> dict[str, str]:
    """Return only response headers useful to the browser."""
    headers = {
        'Cache-Control': f'public, max-age={cache_seconds}',
    }

    content_disposition = upstream.headers.get('content-disposition')
    if content_disposition:
        headers['Content-Disposition'] = content_disposition

    return headers


async def _proxy_get(
    url: str,
    params: dict[str, Any],
    cache_seconds: int,
) -> Response:
    """Perform one guarded server-to-server GET request."""
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(
                UPSTREAM_TIMEOUT_SECONDS,
                connect=UPSTREAM_TIMEOUT_SECONDS,
            ),
            follow_redirects=True,
            verify=_ssl_context(),
            trust_env=True,
            headers={
                'Accept': 'application/json,text/csv,*/*',
                'User-Agent': 'SWOT-Water-Explorer/1.0',
            },
        ) as client:
            upstream = await client.get(url, params=params)
    except httpx.HTTPError as error:
        LOGGER.exception(
            'Upstream request failed: url=%s error=%s',
            url,
            type(error).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail='Upstream service is unavailable.',
        ) from error

    if upstream.status_code >= 400:
        LOGGER.warning(
            'Upstream returned status=%s url=%s',
            upstream.status_code,
            upstream.url,
        )

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get(
            'content-type',
            'application/octet-stream',
        ),
        headers=_forward_headers(upstream, cache_seconds),
    )


def _validate_bbox(raw_bbox: str | None) -> None:
    """Validate a WGS84 bbox with an optional fifth CRS component."""
    if not raw_bbox:
        raise HTTPException(
            status_code=400,
            detail='A valid EPSG:4326 bounding box is required.',
        )

    parts = raw_bbox.split(',')
    if len(parts) not in {4, 5}:
        raise HTTPException(
            status_code=400,
            detail='bbox must contain west,south,east,north.',
        )

    try:
        west, south, east, north = map(float, parts[:4])
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail='bbox coordinates must be numeric.',
        ) from error

    valid = (
        -180 <= west < east <= 180
        and -90 <= south < north <= 90
    )
    if not valid:
        raise HTTPException(
            status_code=400,
            detail='bbox is outside valid WGS84 bounds.',
        )


def _parse_wfs_count(params: dict[str, str]) -> int:
    """Return a validated WFS feature-count limit."""
    raw_count = (
        params.get('count')
        or params.get('maxFeatures')
        or str(MAX_WFS_FEATURES)
    )

    if not raw_count.isdigit():
        raise HTTPException(
            status_code=400,
            detail=(
                f'WFS count must be between 1 and {MAX_WFS_FEATURES}.'
            ),
        )

    count = int(raw_count)
    if not 1 <= count <= MAX_WFS_FEATURES:
        raise HTTPException(
            status_code=400,
            detail=(
                f'WFS count must be between 1 and {MAX_WFS_FEATURES}.'
            ),
        )

    return count


@app.get('/api/health')
async def health() -> dict[str, str]:
    """Return a simple local health response."""
    return {'status': 'ok'}


@app.get('/api/wfs')
async def proxy_wfs(request: Request) -> Response:
    """Proxy one approved Hydroweb WFS GetFeature request."""
    params = dict(request.query_params)
    layer = params.get('typeNames') or params.get('typeName')

    if params.get('service', 'WFS') != 'WFS':
        raise HTTPException(status_code=400, detail='Only WFS is allowed.')

    if params.get('request', 'GetFeature') != 'GetFeature':
        raise HTTPException(
            status_code=400,
            detail='Only GetFeature is allowed.',
        )

    if layer not in ALLOWED_WFS_LAYERS:
        raise HTTPException(
            status_code=400,
            detail=f'Unsupported WFS layer: {layer!r}',
        )

    _validate_bbox(params.get('bbox'))
    count = _parse_wfs_count(params)

    allowed_keys = {
        'service',
        'version',
        'request',
        'outputFormat',
        'bbox',
        'typeName',
        'typeNames',
        'srsName',
    }
    safe_params = {
        key: value
        for key, value in params.items()
        if key in allowed_keys
    }
    safe_params['count'] = str(count)

    return await _proxy_get(
        HYDROWEB_WFS_URL,
        safe_params,
        cache_seconds=300,
    )


@app.get('/api/hydrocron')
async def proxy_hydrocron(request: Request) -> Response:
    """Proxy one approved Hydrocron time-series request."""
    params = dict(request.query_params)
    feature = params.get('feature')
    feature_id = params.get('feature_id', '')
    fields = params.get('fields', '')

    if feature not in ALLOWED_HYDROCRON_FEATURES:
        raise HTTPException(
            status_code=400,
            detail=f'Unsupported Hydrocron feature: {feature!r}',
        )

    if not FEATURE_ID_PATTERN.fullmatch(feature_id):
        raise HTTPException(status_code=400, detail='Invalid feature_id.')

    if not params.get('collection_name'):
        raise HTTPException(
            status_code=400,
            detail='collection_name is required.',
        )

    if not fields or len(fields) > MAX_FIELDS_LENGTH:
        raise HTTPException(
            status_code=400,
            detail='Invalid fields parameter.',
        )

    allowed_keys = {
        'feature',
        'feature_id',
        'collection_name',
        'output',
        'start_time',
        'end_time',
        'fields',
    }
    safe_params = {
        key: value
        for key, value in params.items()
        if key in allowed_keys
    }

    return await _proxy_get(
        HYDROCRON_URL,
        safe_params,
        cache_seconds=600,
    )


app.mount(
    '/',
    StaticFiles(directory=PROJECT_DIR, html=True),
    name='site',
)
