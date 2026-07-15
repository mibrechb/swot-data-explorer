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

  initialCenter: [47.05190700320289, 8.309239494839204],
  initialZoom: 9,
  minZoom: {lake: 9, reach: 9, node: 13},
  maxFeatures: 5000,
  debounceMs: 350,
  startTime: '2022-02-01T00:00:00Z',
  observationFrequencyOpacity: 0.4,
  orbitMinZoom: 7,
};
