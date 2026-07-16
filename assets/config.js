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

  // Curated examples used by the welcome dialog.
  // IDs must match the WFS/Hydrocron feature identifiers.
  welcomeDestinations: {
    lakes: [
      {name: 'Stausee Mattmark', lat: 46.039080113000374, lon: 7.9602166432414325, id: '2160048143', zoom: 13},
      {name: 'Upper Klamath Lake', lat: 42.410685487231795, lon: -121.9000745557349, id: '7740049563', zoom: 11},
      {name: 'Tonle Sap', lat: 12.868743975081028, lon: 104.09873395272251, id: '4420024363', zoom: 10},
    ],
    reaches: [
      {name: 'Mississippi River', lat: 31.1850047528024, lon: -91.58966477058752, id: '74230100041', zoom: 11},
      {name: 'Amazon River', lat: -1.9027785333342313, lon: -53.73299192863913, id: '62235700021', zoom: 11},
      {name: 'Mekong River', lat: 12.646028529727209, lon: 106.00550805282437, id: '44230000221', zoom: 11}
    ],
  },
};
