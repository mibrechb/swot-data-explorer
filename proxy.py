"""Optional CORS proxy for the static SWOT web explorer."""
from __future__ import annotations

from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

ALLOWED_HOSTS = {
    'hydroweb.next.theia-land.fr',
    'soto.podaac.earthdatacloud.nasa.gov',
}

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['GET'],
    allow_headers=['*'],
)


@app.get('/proxy')
async def proxy(url: str = Query(...)) -> Response:
    """Proxy only the configured Hydroweb and Hydrocron hosts."""
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS:
        raise HTTPException(status_code=400, detail='Host is not allowed.')
    async with httpx.AsyncClient(timeout=90) as client:
        upstream = await client.get(url)
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get('content-type'),
    )
