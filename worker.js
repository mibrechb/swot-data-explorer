/**
 * Cloudflare Worker proxy for the SWOT Lake and River Explorer.
 *
 * The Worker is deliberately narrow: it proxies only the known Hydroweb WFS
 * layers and Hydrocron feature types used by the frontend. Orbit FlatGeobuf
 * files remain static GitHub Pages assets and do not pass through this Worker.
 */
const HYDROWEB_WFS_URL =
  'https://hydroweb.next.theia-land.fr/geoserver/REF_DATA/ows';
const HYDROCRON_URL =
  'https://soto.podaac.earthdatacloud.nasa.gov/hydrocron/v1/timeseries';

const ALLOWED_ORIGINS = new Set([
  'https://mibrechb.github.io',
  'http://127.0.0.1:8000',
  'http://localhost:8000',
]);

const WFS_LAYERS = new Set([
  'swot_prior_lake_db',
  'swot_prior_river_db',
  'REF_DATA:swot_prior_river_db_node',
]);
const HYDROCRON_FEATURES = new Set(['PriorLake', 'Reach', 'Node']);
const MAX_WFS_FEATURES = 5000;
const MAX_FIELDS_LENGTH = 4000;
const UPSTREAM_TIMEOUT_MS = 30000;

function allowedOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function corsHeaders(request) {
  const origin = allowedOrigin(request);
  return {
    ...(origin ? {'Access-Control-Allow-Origin': origin} : {}),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function responseHeaders(request, contentType = null) {
  return {
    ...corsHeaders(request),
    ...(contentType ? {'Content-Type': contentType} : {}),
    'X-Content-Type-Options': 'nosniff',
  };
}

function jsonError(request, message, status = 400, extraHeaders = {}) {
  return new Response(JSON.stringify({detail: message}), {
    status,
    headers: {
      ...responseHeaders(request, 'application/json; charset=utf-8'),
      ...extraHeaders,
    },
  });
}

function copyParams(source, target, allowedKeys) {
  for (const key of allowedKeys) {
    const value = source.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
}

function clientKey(request, route) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return `${ip}:${route}`;
}

async function enforceRateLimit(request, limiter, route) {
  if (!limiter) return null;
  const {success} = await limiter.limit({key: clientKey(request, route)});
  if (success) return null;
  return jsonError(request, 'Too many requests. Please try again shortly.', 429, {
    'Retry-After': '60',
  });
}

function parseWfsCount(incoming) {
  const raw =
    incoming.searchParams.get('count') ||
    incoming.searchParams.get('maxFeatures') ||
    String(MAX_WFS_FEATURES);
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WFS_FEATURES) {
    return null;
  }
  return value;
}

function validBbox(raw) {
  if (!raw) return false;
  const parts = raw.split(',');
  if (parts.length !== 4 && parts.length !== 5) return false;
  const coordinates = parts.slice(0, 4).map(Number);
  if (!coordinates.every(Number.isFinite)) return false;
  const [west, south, east, north] = coordinates;
  return (
    west >= -180 && east <= 180 && south >= -90 && north <= 90 &&
    west < east && south < north
  );
}

function validFeatureId(value) {
  return Boolean(value) && value.length <= 80 && /^[A-Za-z0-9_.:-]+$/.test(value);
}

async function proxy(request, targetUrl, cacheSeconds) {
  const startedAt = Date.now();
  try {
    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        'Accept': request.headers.get('Accept') || '*/*',
        'User-Agent': 'SWOT-Water-Explorer/1.0',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: {
        cacheEverything: true,
        cacheTtl: cacheSeconds,
      },
    });

    const headers = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(corsHeaders(request))) {
      headers.set(key, value);
    }
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', `public, max-age=${cacheSeconds}`);

    console.info(JSON.stringify({
      route: new URL(request.url).pathname,
      status: upstream.status,
      durationMs: Date.now() - startedAt,
    }));

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    console.error(JSON.stringify({
      route: new URL(request.url).pathname,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.name : 'UnknownError',
    }));
    return jsonError(request, 'Upstream service is unavailable.', 502);
  }
}

export default {
  async fetch(request, env) {
    const suppliedOrigin = request.headers.get('Origin');
    if (suppliedOrigin && !allowedOrigin(request)) {
      return jsonError(request, 'Origin is not allowed.', 403);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: responseHeaders(request),
      });
    }
    if (request.method !== 'GET') {
      return jsonError(request, 'Only GET is allowed.', 405, {
        'Allow': 'GET, OPTIONS',
      });
    }

    const incoming = new URL(request.url);

    if (incoming.pathname === '/api/wfs') {
      const rateLimited = await enforceRateLimit(
        request,
        env.WFS_RATE_LIMITER,
        'wfs',
      );
      if (rateLimited) return rateLimited;

      const layer =
        incoming.searchParams.get('typeNames') ||
        incoming.searchParams.get('typeName');
      if (!WFS_LAYERS.has(layer)) {
        return jsonError(request, `Unsupported WFS layer: ${layer}`);
      }
      if (!validBbox(incoming.searchParams.get('bbox'))) {
        return jsonError(request, 'A valid EPSG:4326 bounding box is required.');
      }
      const count = parseWfsCount(incoming);
      if (count === null) {
        return jsonError(
          request,
          `WFS count must be between 1 and ${MAX_WFS_FEATURES}.`,
        );
      }

      const target = new URL(HYDROWEB_WFS_URL);
      copyParams(incoming, target, [
        'service', 'version', 'request', 'outputFormat', 'bbox',
        'typeName', 'typeNames', 'srsName',
      ]);
      target.searchParams.set('count', String(count));
      return proxy(request, target, 300);
    }

    if (incoming.pathname === '/api/hydrocron') {
      const rateLimited = await enforceRateLimit(
        request,
        env.HYDROCRON_RATE_LIMITER,
        'hydrocron',
      );
      if (rateLimited) return rateLimited;

      const feature = incoming.searchParams.get('feature');
      if (!HYDROCRON_FEATURES.has(feature)) {
        return jsonError(request, `Unsupported feature: ${feature}`);
      }
      if (!validFeatureId(incoming.searchParams.get('feature_id'))) {
        return jsonError(request, 'Invalid feature_id.');
      }
      const fields = incoming.searchParams.get('fields') || '';
      if (!fields || fields.length > MAX_FIELDS_LENGTH) {
        return jsonError(request, 'Invalid fields parameter.');
      }

      const target = new URL(HYDROCRON_URL);
      copyParams(incoming, target, [
        'feature', 'feature_id', 'collection_name', 'output',
        'start_time', 'end_time', 'fields',
      ]);
      return proxy(request, target, 600);
    }

    return jsonError(request, 'Not found.', 404);
  },
};
