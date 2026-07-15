export const CONFIG = {
  // Keep this empty for the local FastAPI server. For GitHub Pages, set it to
  // the deployed Cloudflare Worker origin, without a trailing slash.
  // Example: 'https://swot-explorer-api.example.workers.dev'
  apiBaseUrl: '',

  // Same-origin, spatially indexed FlatGeobuf assets. The browser reads only
  // features intersecting the current viewport by using HTTP Range requests.
  orbitFiles: {
    overlaps: './data/orbit/processed/swot_overlaps.fgb',
    nadir: './data/orbit/processed/swot_nadir.fgb',
  },

  initialCenter: [52.13, 5.29],
  initialZoom: 10,
  minZoom: {lake: 8, reach: 8, node: 10},
  maxFeatures: 5000,
  debounceMs: 350,
  startTime: '2022-02-01T00:00:00Z',
  observationFrequencyOpacity: 0.52,
  orbitMinZoom: 4,
};
