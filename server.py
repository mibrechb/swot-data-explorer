"""Serve the SWOT web explorer and proxy approved upstream requests."""
from __future__ import annotations

import logging
import os
import ssl
from pathlib import Path
from typing import Any

import certifi
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from orbit_vectors import orbit_readers

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

LOGGER = logging.getLogger('swot.proxy')
app = FastAPI(title='SWOT Water Explorer')

@app.middleware('http')
async def disable_frontend_cache(request: Request, call_next):
    """Prevent stale JavaScript and CSS during local development."""
    response = await call_next(request)
    if request.url.path == '/' or request.url.path.startswith('/assets/'):
        response.headers['Cache-Control'] = 'no-store, max-age=0'
        response.headers['Pragma'] = 'no-cache'
    return response



def _ssl_context() -> ssl.SSLContext | bool:
    """Return an SSL verifier using certifi or a configured CA bundle.

    Set ``SWOT_CA_BUNDLE`` to a corporate CA bundle when required.
    ``SWOT_DISABLE_SSL_VERIFY=1`` is available only as a temporary local
    diagnostic and should never be used for a public deployment.
    """
    if os.getenv('SWOT_DISABLE_SSL_VERIFY') == '1':
        LOGGER.warning('TLS certificate verification is disabled.')
        return False

    ca_bundle = os.getenv('SWOT_CA_BUNDLE', certifi.where())
    return ssl.create_default_context(cafile=ca_bundle)


def _forward_headers(upstream: httpx.Response) -> dict[str, str]:
    """Return only response headers useful to the browser."""
    headers = {
        'Cache-Control': upstream.headers.get(
            'cache-control',
            'public, max-age=300',
        ),
    }
    content_disposition = upstream.headers.get('content-disposition')
    if content_disposition:
        headers['Content-Disposition'] = content_disposition
    return headers


async def _proxy_get(url: str, params: dict[str, Any]) -> Response:
    """Perform one guarded server-to-server GET request."""
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(90.0, connect=30.0),
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
            'Upstream request failed: %s %s',
            url,
            type(error).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail=(
                f'Upstream request failed ({type(error).__name__}): '
                f'{error}'
            ),
        ) from error

    if upstream.status_code >= 400:
        LOGGER.error(
            'Upstream returned HTTP %s for %s: %s',
            upstream.status_code,
            upstream.url,
            upstream.text[:500],
        )

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get(
            'content-type',
            'application/octet-stream',
        ),
        headers=_forward_headers(upstream),
    )


@app.get('/api/health')
async def health() -> dict[str, str]:
    """Return a simple local health response."""
    return {'status': 'ok'}


@app.get('/api/wfs')
async def proxy_wfs(request: Request) -> Response:
    """Proxy an approved Hydroweb WFS GetFeature request."""
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

    allowed_keys = {
        'service',
        'version',
        'request',
        'outputFormat',
        'bbox',
        'typeName',
        'typeNames',
        'srsName',
        'count',
        'maxFeatures',
    }
    safe_params = {
        key: value
        for key, value in params.items()
        if key in allowed_keys
    }
    return await _proxy_get(HYDROWEB_WFS_URL, safe_params)


@app.get('/api/hydrocron')
async def proxy_hydrocron(request: Request) -> Response:
    """Proxy an approved Hydrocron time-series request."""
    params = dict(request.query_params)
    feature = params.get('feature')

    if feature not in ALLOWED_HYDROCRON_FEATURES:
        raise HTTPException(
            status_code=400,
            detail=f'Unsupported Hydrocron feature: {feature!r}',
        )
    if not params.get('feature_id'):
        raise HTTPException(status_code=400, detail='feature_id is required.')
    if not params.get('collection_name'):
        raise HTTPException(
            status_code=400,
            detail='collection_name is required.',
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
    return await _proxy_get(HYDROCRON_URL, safe_params)


def _parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    try:
        west, south, east, north = [float(value) for value in bbox.split(',')]
    except (TypeError, ValueError) as error:
        raise HTTPException(
            status_code=400,
            detail='bbox must be west,south,east,north.',
        ) from error
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(status_code=400, detail='bbox is outside WGS84 bounds.')
    return west, south, east, north


@app.get('/api/orbit-overlaps')
async def orbit_overlaps(bbox: str) -> JSONResponse:
    """Return precomputed overlap polygons intersecting the viewport."""
    bounds = _parse_bbox(bbox)
    overlaps, _ = orbit_readers(PROJECT_DIR)
    try:
        payload = overlaps.query(*bounds)
    except (FileNotFoundError, OSError, ValueError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return JSONResponse(payload, headers={'Cache-Control': 'public, max-age=86400'})


@app.get('/api/orbit-nadir')
async def orbit_nadir(bbox: str) -> JSONResponse:
    """Return precomputed nadir tracks intersecting the viewport."""
    bounds = _parse_bbox(bbox)
    _, nadir = orbit_readers(PROJECT_DIR)
    try:
        payload = nadir.query(*bounds)
    except (FileNotFoundError, OSError, ValueError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return JSONResponse(payload, headers={'Cache-Control': 'public, max-age=86400'})


app.mount(
    '/',
    StaticFiles(directory=PROJECT_DIR, html=True),
    name='site',
)
