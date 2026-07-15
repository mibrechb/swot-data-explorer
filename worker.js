/**
 * Cloudflare Worker proxy for GitHub Pages.
 *
 * The orbit FlatGeobuf files are NOT proxied. They are read directly from the
 * GitHub Pages repository with browser HTTP Range requests.
 */
const HYDROWEB_WFS_URL =
  'https://hydroweb.next.theia-land.fr/geoserver/REF_DATA/ows';
const HYDROCRON_URL =
  'https://soto.podaac.earthdatacloud.nasa.gov/hydrocron/v1/timeseries';

// Replace the example GitHub Pages origin before deployment. Localhost entries
// allow testing the deployed Worker from the local FastAPI site.
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
    'Vary': 'Origin',
  };
}

function jsonError(request, message, status = 400) {
  return new Response(JSON.stringify({detail: message}), {
    status,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'application/json',
    },
  });
}

function copyParams(source, target, allowedKeys) {
  for (const key of allowedKeys) {
    const value = source.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
}

async function proxy(request, targetUrl) {
  const upstream = await fetch(targetUrl.toString(), {
    headers: {
      'Accept': request.headers.get('Accept') || '*/*',
      'User-Agent': 'SWOT-Water-Explorer/1.0',
    },
  });
  const headers = new Headers(upstream.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'public, max-age=300');
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export default {
  async fetch(request) {
    if (!allowedOrigin(request) && request.headers.get('Origin')) {
      return jsonError(request, 'Origin is not allowed.', 403);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: corsHeaders(request)});
    }
    if (request.method !== 'GET') {
      return jsonError(request, 'Only GET is allowed.', 405);
    }

    const incoming = new URL(request.url);

    if (incoming.pathname === '/api/wfs') {
      const layer =
        incoming.searchParams.get('typeNames') ||
        incoming.searchParams.get('typeName');
      if (!WFS_LAYERS.has(layer)) {
        return jsonError(request, `Unsupported WFS layer: ${layer}`);
      }
      const target = new URL(HYDROWEB_WFS_URL);
      copyParams(incoming, target, [
        'service', 'version', 'request', 'outputFormat', 'bbox',
        'typeName', 'typeNames', 'srsName', 'count', 'maxFeatures',
      ]);
      return proxy(request, target);
    }

    if (incoming.pathname === '/api/hydrocron') {
      const feature = incoming.searchParams.get('feature');
      if (!HYDROCRON_FEATURES.has(feature)) {
        return jsonError(request, `Unsupported feature: ${feature}`);
      }
      const target = new URL(HYDROCRON_URL);
      copyParams(incoming, target, [
        'feature', 'feature_id', 'collection_name', 'output',
        'start_time', 'end_time', 'fields',
      ]);
      return proxy(request, target);
    }

    return jsonError(request, 'Not found.', 404);
  },
};
