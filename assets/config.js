export const CONFIG = {
  // Keep empty for the local FastAPI server. For GitHub Pages, set to
  // deployed Cloudflare Worker origin-
  // Example: 'https://swot-explorer-api.example.workers.dev'
  apiBaseUrl: 'https://swot-explorer-api.michael-brechbuehler.workers.dev',

  // Spatially indexed FlatGeobuf assets, browser reads only
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
