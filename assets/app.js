import {CONFIG} from './config.js';
import {FEATURE_CONFIG, META_LABELS, variableLabel, variableUnit} from './fields.js';
import {robustLowess} from './smoothing.js';

const state = {
  featureType: 'lake',
  featureLayer: null,
  selectionLayer: null,
  selectedFeature: null,
  dataframe: [],
  rawCsv: '',
  selectedFeatureId: '',
  abortController: null,
  debounceTimer: null,
  overlapLayer: null,
  nadirLayer: null,
  frequencyEnabled: false,
  frequencyAbortController: null,
  hydrocronAbortController: null,
  selectionRequestId: 0,
};

const map = L.map('map', {
  zoomControl: false,
  preferCanvas: true,
}).setView(CONFIG.initialCenter, CONFIG.initialZoom);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);


// Lightweight world overview map. It is visually hidden by CSS on mobile and
// portrait layouts, but remains synchronised whenever the main map moves.
const overviewMap = L.map('overview-map', {
  attributionControl: false,
  zoomControl: false,
  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  boxZoom: false,
  keyboard: false,
  touchZoom: false,
  tap: false,
  preferCanvas: true,
  maxBounds: [[-85, -180], [85, 180]],
  maxBoundsViscosity: 1,
}).setView([18, 0], 0);

L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
  {
    minZoom: 0,
    maxZoom: 5,
    noWrap: true,
    opacity: 0.82,
    subdomains: 'abcd',
  },
).addTo(overviewMap);

const overviewViewport = L.rectangle(map.getBounds(), {
  color: '#d7191c',
  weight: 3,
  opacity: 1,
  fillColor: '#d7191c',
  fillOpacity: 0.08,
  interactive: false,
}).addTo(overviewMap);

const overviewViewportMarker = L.circleMarker(map.getCenter(), {
  radius: 5,
  color: '#d7191c',
  weight: 3,
  opacity: 1,
  fillColor: '#d7191c',
  fillOpacity: 0.18,
  interactive: false,
}).addTo(overviewMap);

function updateOverviewMap() {
  const bounds = map.getBounds();
  const showMarker = map.getZoom() >= 10;

  overviewViewport.setBounds(bounds);
  overviewViewport.setStyle({opacity: showMarker ? 0 : 1, fillOpacity: showMarker ? 0 : 0.08});
  overviewViewportMarker.setLatLng(bounds.getCenter());
  overviewViewportMarker.setStyle({opacity: showMarker ? 1 : 0, fillOpacity: showMarker ? 0.18 : 0});
}

map.on('move zoom resize', updateOverviewMap);

overviewMap.on('click', (event) => {
  map.setView(event.latlng, map.getZoom());
});

window.addEventListener('resize', () => {
  overviewMap.invalidateSize({pan: false});
  updateOverviewMap();
});

// Ensure the inset renders at its final CSS dimensions after initial layout.
setTimeout(() => {
  overviewMap.invalidateSize({pan: false});
  updateOverviewMap();
}, 0);

if (L.Control?.geocoder) {
  L.Control.geocoder({
    defaultMarkGeocode: false,
    position: 'bottomleft',
    placeholder: 'Search place…',
    collapsed: true,
  })
    .on('markgeocode', (event) => {
      const bbox = event.geocode?.bbox;
      if (bbox) map.fitBounds(bbox, {maxZoom: 13});
      else if (event.geocode?.center) map.setView(event.geocode.center, 13);
    })
    .addTo(map);
}

map.createPane('orbit-overlaps');
map.getPane('orbit-overlaps').style.zIndex = 350;
map.createPane('orbit-nadir');
map.getPane('orbit-nadir').style.zIndex = 360;
map.createPane('water-features');
map.getPane('water-features').style.zIndex = 430;
map.createPane('selected-feature');
map.getPane('selected-feature').style.zIndex = 450;
map.getPane('selected-feature').style.pointerEvents = 'none';

const els = {
  status: document.querySelector('#map-status'),
  panel: document.querySelector('#details-panel'),
  panelBack: document.querySelector('#panel-back'),
  panelClose: document.querySelector('#panel-close'),
  panelDownload: document.querySelector('#panel-download'),
  panelKicker: document.querySelector('#panel-kicker'),
  panelFeatureIcon: document.querySelector('#panel-feature-icon'),
  panelSubtitle: document.querySelector('#panel-subtitle'),
  metadata: document.querySelector('#metadata'),
  variable: document.querySelector('#variable-select'),
  plot: document.querySelector('#plot'),
  loading: document.querySelector('#plot-loading'),
  loadingText: document.querySelector('#plot-loading-text'),
  spinner: document.querySelector('#plot-spinner'),
  smoothing: document.querySelector('#smoothing-enabled'),
  includeSuspect: document.querySelector('#include-suspect'),
  includeSuspectRow: document.querySelector('#include-suspect-row'),
  smoothness: document.querySelector('#smoothness'),
  smoothnessValue: document.querySelector('#smoothness-value'),
  threshold: document.querySelector('#outlier-threshold'),
  thresholdValue: document.querySelector('#outlier-value'),
  frequencyToggle: document.querySelector('#frequency-toggle'),
  frequencyLegend: document.querySelector('#frequency-legend'),
  dataDescription: document.querySelector('#data-description-content'),
};

els.panelDownload.disabled = true;

function apiUrl(path, params) {
  const base = CONFIG.apiBaseUrl.replace(/\/$/, '');
  return `${base}${path}?${params.toString()}`;
}

function setStatus(message, persistent = false) {
  els.status.textContent = message;
  els.status.style.display = 'block';
  if (!persistent) {
    setTimeout(() => {
      if (els.status.textContent === message) els.status.style.display = 'none';
    }, 2200);
  }
}

function getFeatureId(properties) {
  const cfg = FEATURE_CONFIG[state.featureType];
  for (const field of cfg.idCandidates) {
    if (properties[field] != null) return String(properties[field]);
  }
  throw new Error(`No supported ${state.featureType} identifier found.`);
}

function geometryStyle() {
  if (state.featureType === 'lake') {
    return {color: '#16718d', weight: 2.5, fillColor: '#38a4c0', fillOpacity: 0.18};
  }
  if (state.featureType === 'reach') {
    return {color: '#176b87', weight: 4, opacity: 0.9};
  }
  return {radius: 4.5, color: '#fff', weight: 1.8, fillColor: '#176b87', fillOpacity: 0.9};
}

function selectedStyle() {
  if (state.featureType === 'lake') {
    return {color: '#ef8b2c', weight: 4, fillColor: '#ffb260', fillOpacity: 0.3};
  }
  if (state.featureType === 'reach') {
    return {color: '#ef5a34', weight: 7, opacity: 1};
  }
  return {radius: 8, color: '#fff', weight: 2, fillColor: '#ef5a34', fillOpacity: 1};
}

function nodeIcon(selected = false) {
  const size = selected ? 16 : 14;

  return L.divIcon({
    className: selected
      ? 'node-feature-marker selected'
      : 'node-feature-marker',
    html: '<span></span>',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function makeGeoJson(data, selected = false) {
  const style = selected ? selectedStyle() : geometryStyle();

  return L.geoJSON(data, {
    pane: selected ? 'selected-feature' : 'water-features',
    interactive: !selected,
    bubblingMouseEvents: !selected,
    style: () => style,

    pointToLayer: (_, latlng) => {
      if (state.featureType === 'node') {
        return L.marker(latlng, {
          pane: selected ? 'selected-feature' : 'water-features',
          icon: nodeIcon(selected),
          interactive: !selected,
          bubblingMouseEvents: !selected,
          keyboard: false,
          riseOnHover: !selected,
        });
      }

      return L.circleMarker(latlng, {
        ...style,
        pane: selected ? 'selected-feature' : 'water-features',
        interactive: !selected,
        bubblingMouseEvents: !selected,
      });
    },

    onEachFeature: selected ? undefined : (feature, layer) => {
      layer.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        selectFeature(feature);
      });

      if (state.featureType !== 'node') {
        layer.on({
          mouseover: () => {
            layer.setStyle({
              weight: (style.weight || 1) + 2,
            });
          },
          mouseout: () => {
            if (state.featureLayer) {
              state.featureLayer.resetStyle(layer);
            }
          },
        });
      }
    },
  });
}


const SCIENCE_ORBIT_REPEAT_DAYS = 20.86;

const OVERLAP_PALETTE = [
  '#ffffb2',
  '#fecc5c',
  '#fd8d3c',
  '#f03b20',
  '#bd0026',
  '#7a0177',
  '#2c7fb8',
  '#41ab5d',
  '#238443',
  '#54278f',
  '#756bb1',
  '#636363',
];

function overlapCount(properties = {}) {
  const value = properties.n_overlaps ??
    properties.overflights ??
    properties.count ??
    properties.overlap_count;
  return Math.max(1, Math.trunc(Number(value) || 1));
}

function visibleOverlapClasses(featureCollection) {
  return [...new Set(
    (featureCollection.features || []).map((feature) =>
      overlapCount(feature.properties)),
  )].sort((left, right) => left - right);
}

function categoricalColorMap(classes) {
  return new Map(classes.map((value, index) => [
    value,
    OVERLAP_PALETTE[index % OVERLAP_PALETTE.length],
  ]));
}

function averageRevisitDays(overflightCount) {
  return SCIENCE_ORBIT_REPEAT_DAYS / Math.max(1, overflightCount);
}

function formatRevisitDays(overflightCount) {
  return `${averageRevisitDays(overflightCount).toFixed(1)} days`;
}

function renderFrequencyLegend(classes, colorMap) {
  const categoryHtml = classes.map((value) => `
    <span>
      <i class="frequency-chip" style="background:${colorMap.get(value)}"></i>
      ${value} (${formatRevisitDays(value)})
    </span>
  `).join('');

  els.frequencyLegend.innerHTML = `
    <strong>Overflights per 21-day orbit<br><span>(scientific orbit, v09)</span></strong>
    <div class="frequency-categories" aria-label="Overflight categories">
      ${categoryHtml || '<span>No overlap polygons in view</span>'}
    </div>
    <div class="nadir-key"><span></span>Nadir track</div>
  `;
}

function nadirStartTime(properties = {}) {
  return String(properties.START_TIME ?? 'Unknown');
}

function lineCoordinateSequences(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  if (geometry.type === 'GeometryCollection') {
    return geometry.geometries.flatMap(lineCoordinateSequences);
  }
  return [];
}

function longestLineCoordinates(geometry) {
  const lines = lineCoordinateSequences(geometry).filter((line) => line.length > 1);
  if (!lines.length) return null;
  return lines.reduce((longest, line) => {
    const lineLength = line.reduce((total, coordinate, index) => {
      if (index === 0) return total;
      const previous = line[index - 1];
      return total + Math.hypot(
        coordinate[0] - previous[0],
        coordinate[1] - previous[1],
      );
    }, 0);
    const longestLength = longest.reduce((total, coordinate, index) => {
      if (index === 0) return total;
      const previous = longest[index - 1];
      return total + Math.hypot(
        coordinate[0] - previous[0],
        coordinate[1] - previous[1],
      );
    }, 0);
    return lineLength > longestLength ? line : longest;
  });
}

function lineLabelPlacement(feature) {
  const coordinates = longestLineCoordinates(feature.geometry);
  if (!coordinates) return null;

  const projected = coordinates.map(([longitude, latitude]) =>
    map.latLngToLayerPoint([latitude, longitude]));
  const segmentLengths = projected.slice(1).map((point, index) =>
    point.distanceTo(projected[index]));
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
  if (totalLength < 45) return null;

  const target = totalLength / 2;
  let travelled = 0;
  let segmentIndex = 0;
  while (segmentIndex < segmentLengths.length - 1 &&
         travelled + segmentLengths[segmentIndex] < target) {
    travelled += segmentLengths[segmentIndex];
    segmentIndex += 1;
  }

  const start = projected[segmentIndex];
  const end = projected[segmentIndex + 1];
  const fraction = segmentLengths[segmentIndex] === 0
    ? 0
    : (target - travelled) / segmentLengths[segmentIndex];
  const midpoint = L.point(
    start.x + (end.x - start.x) * fraction,
    start.y + (end.y - start.y) * fraction,
  );
  const latlng = map.layerPointToLatLng(midpoint);
  let angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
  let arrow = '→';
  if (angle > 90 || angle < -90) {
    angle += angle > 90 ? -180 : 180;
    arrow = '←';
  }

  return {latlng, angle, arrow};
}

function addNadirLabels(layer, featureCollection) {
  for (const feature of featureCollection.features || []) {
    const placement = lineLabelPlacement(feature);
    if (!placement) continue;
    const startTime = nadirStartTime(feature.properties);
    const html = `<span style="transform:rotate(${placement.angle}deg)">` +
      `${startTime}</span>`;
    L.marker(placement.latlng, {
      pane: 'orbit-nadir',
      interactive: false,
      icon: L.divIcon({
        className: 'nadir-line-label',
        html,
        iconSize: null,
      }),
    }).addTo(layer);
  }
}

function removeFrequencyLayer() {
  state.frequencyAbortController?.abort();
  state.frequencyAbortController = null;
  if (state.overlapLayer) map.removeLayer(state.overlapLayer);
  if (state.nadirLayer) map.removeLayer(state.nadirLayer);
  state.overlapLayer = null;
  state.nadirLayer = null;
  els.frequencyLegend.hidden = true;
}

function orbitFileUrl(path) {
  return new URL(path, document.baseURI).href;
}

async function readOrbitFlatGeobuf(path, bounds, signal) {
  if (!globalThis.flatgeobuf?.deserialize) {
    throw new Error('FlatGeobuf browser library is unavailable.');
  }

  const rectangle = {
    minX: bounds.getWest(),
    minY: bounds.getSouth(),
    maxX: bounds.getEast(),
    maxY: bounds.getNorth(),
  };
  const features = [];
  const source = globalThis.flatgeobuf.deserialize(
    orbitFileUrl(path),
    rectangle,
  );

  for await (const feature of source) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    features.push(feature);
  }

  return {type: 'FeatureCollection', features};
}

async function loadObservationFrequency() {
  if (!state.frequencyEnabled) return;
  if (map.getZoom() < CONFIG.orbitMinZoom) {
    removeFrequencyLayer();
    state.frequencyEnabled = true;
    els.frequencyToggle.checked = true;
    setStatus(
      `Zoom to level ${CONFIG.orbitMinZoom} to load observation frequency.`,
      true,
    );
    return;
  }
  state.frequencyAbortController?.abort();
  state.frequencyAbortController = new AbortController();
  const bounds = map.getBounds();
  setStatus('Loading SWOT orbit vectors…', true);
  try {
    const [overlaps, nadir] = await Promise.all([
      readOrbitFlatGeobuf(
        CONFIG.orbitFiles.overlaps,
        bounds,
        state.frequencyAbortController.signal,
      ),
      readOrbitFlatGeobuf(
        CONFIG.orbitFiles.nadir,
        bounds,
        state.frequencyAbortController.signal,
      ),
    ]);

    const overlapClasses = visibleOverlapClasses(overlaps);
    const overlapColors = categoricalColorMap(overlapClasses);
    const overlapLayer = L.geoJSON(overlaps, {
      pane: 'orbit-overlaps',
      style: (feature) => ({
        color: '#ffffff',
        weight: 1.8,
        fillColor: overlapColors.get(overlapCount(feature.properties)),
        fillOpacity: CONFIG.observationFrequencyOpacity,
      }),
      onEachFeature: (feature, layer) => {
        const count = overlapCount(feature.properties);
        layer.bindTooltip(
          `<strong>${count} overflight${count === 1 ? '' : 's'}</strong><br>Average revisit: ${formatRevisitDays(count)}<br>per 21-day science orbit`,
          {sticky: true},
        );
      },
    });

    const nadirLayer = L.layerGroup([], {pane: 'orbit-nadir'});
    const nadirLines = L.geoJSON(nadir, {
      pane: 'orbit-nadir',
      style: {
        color: '#151515',
        weight: 3.2,
        opacity: 0.95,
        dashArray: '8 5',
      },
      interactive: false,
    });
    nadirLines.addTo(nadirLayer);
    addNadirLabels(nadirLayer, nadir);

    overlapLayer.addTo(map);
    nadirLayer.addTo(map);
    if (state.overlapLayer) map.removeLayer(state.overlapLayer);
    if (state.nadirLayer) map.removeLayer(state.nadirLayer);
    state.overlapLayer = overlapLayer;
    state.nadirLayer = nadirLayer;
    state.featureLayer?.bringToFront();
    state.selectionLayer?.bringToFront();
    renderFrequencyLegend(overlapClasses, overlapColors);
    els.frequencyLegend.hidden = false;
    setStatus(
      `Loaded ${overlaps.features?.length || 0} overlap polygons and ${nadir.features?.length || 0} nadir tracks.`,
    );
  } catch (error) {
    if (error.name !== 'AbortError') {
      setStatus(`Observation-frequency layer failed: ${error.message}`, true);
    }
  }
}

function buildWfsParams() {
  const cfg = FEATURE_CONFIG[state.featureType];
  const bounds = map.getBounds();
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    outputFormat: 'application/json',
    bbox: [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
      'EPSG:4326',
    ].join(','),
  });
  if (state.featureType === 'node') params.set('typeNames', cfg.layer);
  else params.set('typeName', cfg.layer);
  if (state.featureType !== 'lake') {
    params.set('srsName', 'EPSG:4326');
    params.set('count', String(CONFIG.maxFeatures));
  }
  return params;
}

async function loadVisibleFeatures() {
  const minZoom = CONFIG.minZoom[state.featureType];
  if (map.getZoom() < minZoom) {
    if (state.featureLayer) map.removeLayer(state.featureLayer);
    state.featureLayer = null;
    setStatus(`Zoom to level ${minZoom} to load ${state.featureType}s.`, true);
    return;
  }

  state.abortController?.abort();
  state.abortController = new AbortController();
  setStatus(`Loading visible ${state.featureType}s…`, true);

  try {
    const response = await fetch(apiUrl('/api/wfs', buildWfsParams()), {
      signal: state.abortController.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const payload = await response.json();
    const nextLayer = makeGeoJson(payload);
    nextLayer.addTo(map);
    if (state.featureLayer) map.removeLayer(state.featureLayer);
    state.featureLayer = nextLayer;
    const count = payload.features?.length || 0;
    const featureNoun = {lake: 'lake', reach: 'reach', node: 'node'}[state.featureType];
    const featurePlural = {lake: 'lakes', reach: 'reaches', node: 'nodes'}[state.featureType];
    setStatus(`Loaded ${count.toLocaleString()} ${count === 1 ? featureNoun : featurePlural}.`);
    state.selectionLayer?.bringToFront();
  } catch (error) {
    if (error.name !== 'AbortError') {
      setStatus(`Geometry request failed: ${error.message}`, true);
    }
  }
}

function scheduleGeometryLoad() {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    loadVisibleFeatures();
    if (state.frequencyEnabled) loadObservationFrequency();
  }, CONFIG.debounceMs);
}

function openPanel() {
  els.panel.classList.add('open');
  els.panel.setAttribute('aria-hidden', 'false');
}

function clearSelection() {
  state.selectionRequestId += 1;
  state.hydrocronAbortController?.abort();
  state.hydrocronAbortController = null;
  if (state.selectionLayer) map.removeLayer(state.selectionLayer);
  state.selectionLayer = null;
  state.selectedFeature = null;
  state.dataframe = [];
  els.metadata.innerHTML = '';
  els.dataDescription.innerHTML = '';
  els.variable.innerHTML = '';
  els.plot.style.display = 'none';
  Plotly.purge(els.plot);
}

function closePanel({clear = true} = {}) {
  els.panel.classList.remove('open');
  els.panel.setAttribute('aria-hidden', 'true');
  if (clear) clearSelection();
}

function normalise(value) {
  if (value == null) return null;

  const text = String(value).trim();
  if (
    text === '' ||
    text.toLowerCase() === 'no_data' ||
    text === '-999' ||
    text === '-999.0' ||
    text === '-999999999999' ||
    text === '-999999999999.0'
  ) {
    return null;
  }
  return value;
}

function finiteNumber(value) {
  const normalised = normalise(value);
  if (normalised == null) return null;

  const number = Number(normalised);
  return Number.isFinite(number) ? number : null;
}

function titleCase(value) {
  return String(value)
    .toLocaleLowerCase()
    .replace(/(^|[\s\-'/])\p{L}/gu, (match) => match.toLocaleUpperCase());
}

function displayMetadataValue(field, value) {
  if (field === 'lake_name' || field === 'river_name') {
    return titleCase(String(value).split(';')[0].trim());
  }
  if (field === 'p_date_t0') {
    const text = String(value).trim();
    const isoDate = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (isoDate) return isoDate;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed)
      ? new Date(parsed).toISOString().slice(0, 10)
      : text;
  }
  return value;
}

function renderMetadata(rows) {
  const cfg = FEATURE_CONFIG[state.featureType];
  const firstValue = (field) => rows
    .map((row) => normalise(row[field]))
    .find((value) => value !== null && value !== '');

  els.metadata.innerHTML = cfg.metadata
    .filter((field) => !field.endsWith('_id'))
    .map((field) => {
      const value = firstValue(field);
      if (value == null) return '';
      const [label, unit] = META_LABELS[field] || [field, ''];
      const displayed = displayMetadataValue(field, value);
      return `<div class="metadata-row"><span>${label}</span><strong>${displayed}${unit ? ` ${unit}` : ''}</strong></div>`;
    })
    .join('');
}

function queryFields() {
  const cfg = FEATURE_CONFIG[state.featureType];
  const fields = [
    ...cfg.variables,
    ...cfg.metadata,
    ...(cfg.qualityFields || []),
  ];
  return [...new Set([
    'time_str',
    ...fields,
  ])].join(',');
}

async function selectFeature(feature) {
  state.selectionRequestId += 1;
  const requestId = state.selectionRequestId;
  state.hydrocronAbortController?.abort();
  state.hydrocronAbortController = new AbortController();

  state.selectedFeature = feature;
  if (state.selectionLayer) map.removeLayer(state.selectionLayer);
  state.selectionLayer = makeGeoJson(feature, true).addTo(map);
  state.selectionLayer.bringToFront();

  const id = getFeatureId(feature.properties || {});
  state.selectedFeatureId = id;
  state.rawCsv = '';
  els.panelDownload.disabled = true;
  const cfg = FEATURE_CONFIG[state.featureType];
  els.panelFeatureIcon.src = cfg.icon;
  els.panelFeatureIcon.alt = '';
  els.panelKicker.textContent = cfg.label;
  els.panelSubtitle.textContent = `ID${id}`;
  openPanel();
  els.metadata.innerHTML = '';
  els.plot.style.display = 'none';
  els.loading.style.display = 'flex';
  els.spinner.hidden = false;
  els.loadingText.textContent = 'Loading data from Hydrocron…';

  const endTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const params = new URLSearchParams({
    output: 'csv',
    start_time: CONFIG.startTime,
    end_time: endTime,
    fields: queryFields(),
    feature: cfg.feature,
    feature_id: id,
    collection_name: cfg.collection,
  });

  try {
    const response = await fetch(apiUrl('/api/hydrocron', params), {
      signal: state.hydrocronAbortController.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    let text = await response.text();
    try {
      const payload = JSON.parse(text);
      text = payload?.results?.csv || text;
    } catch (_) {
      // Hydrocron may already return raw CSV.
    }
    state.rawCsv = text;
    els.panelDownload.disabled = false;
    const parsed = Papa.parse(text, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
    });
    if (requestId !== state.selectionRequestId) return;

    state.dataframe = parsed.data.map((row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, normalise(value)]),
    ));
    if (!state.dataframe.length) throw new Error('No observations returned.');
    renderMetadata(state.dataframe);
    renderDataDescription();
    const initialVariable = populateVariables();
    renderPlot(false, initialVariable);
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== state.selectionRequestId) return;
    els.spinner.hidden = true;
    els.loadingText.textContent = `Data request failed: ${error.message}`;
  }
}

function fieldUnit(field) {
  return variableUnit(field);
}

function renderDataDescription() {
  const isLake = state.featureType === 'lake';
  if (isLake) {
    els.dataDescription.innerHTML = `
      <p>Lake observations shown are from <strong>SWOT_L2_HR_LakeSP_D</strong>. This dataset provides geolocated surface water measurements for lakes, derived from high-resolution radar observations collected by the Ka-band Radar Interferometer (KaRIn) on the SWOT satellite. The variables contained include water surface elevation, surface area, and quality indicators.</p>
      <div class="dataset-citation">
        <p>SWOT. (2025). <em>SWOT Level 2 Lake Single-Pass Vector Data Product</em> [Dataset]. NASA Physical Oceanography Distributed Active Archive Center. <a href="https://doi.org/10.5067/SWOT-LAKESP-D" target="_blank" rel="noopener noreferrer">https://doi.org/10.5067/SWOT-LAKESP-D</a></p>
      </div>`;
    return;
  }
  els.dataDescription.innerHTML = `
    <p>River reach and node observations are from <strong>SWOT_L2_HR_RiverSP_D</strong>. This dataset provides hydrologic measurements for predefined river reaches and nodes, derived from high-resolution radar observations collected by the Ka-band Radar Interferometer (KaRIn) aboard the SWOT satellite. The variables contained include water surface elevation, slope, width, area, and discharge estimates for each reach, along with corresponding node-level details. Discharge is currently not yet included in Version D and is being disseminated separately in <strong>SWOT_L4_HR_DAWG_SOS_DISCHARGE_V3</strong>. However, Hydrocron integration is underway and being tracked in <a href="https://github.com/podaac/hydrocron/issues/308" target="_blank" rel="noopener noreferrer">podaac/hydrocron issue 308</a>.</p>
    <div class="dataset-citation">
      <p>SWOT. (2025). <em>SWOT Level 2 River Single-Pass Vector Data Product</em> [Dataset]. NASA Physical Oceanography Distributed Active Archive Center. <a href="https://doi.org/10.5067/SWOT-RIVERSP-D" target="_blank" rel="noopener noreferrer">https://doi.org/10.5067/SWOT-RIVERSP-D</a></p>
    </div>`;
}

function populateVariables() {
  const cfg = FEATURE_CONFIG[state.featureType];
  const available = cfg.variables.filter((variable) => state.dataframe.some(
    (row) => finiteNumber(row[variable]) !== null,
  ));
  els.variable.innerHTML = available
    .map((variable) => `<option value="${variable}">${variableLabel(variable)}</option>`)
    .join('');
  const initial = available.includes(cfg.defaultVariable) ? cfg.defaultVariable : available[0];
  els.variable.value = initial || '';
  els.smoothing.checked = cfg.smoothDefaults.includes(initial);
  els.includeSuspect.checked = true;
  els.includeSuspectRow.hidden = state.featureType !== 'lake';
  return initial;
}

function parseObservationTime(value) {
  const text = String(value ?? '').trim();
  if (text.toLowerCase() === 'no_data') return null;

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function paddedNumericRange(values, paddingFraction = 0.07) {
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return null;

  const minimum = Math.min(...finiteValues);
  const maximum = Math.max(...finiteValues);
  const span = maximum - minimum;

  // Use the observed spread for padding
  const padding = span > 0
    ? span * paddingFraction
    : Math.max(Math.abs(minimum) * 0.001, 0.01);
  return [minimum - padding, maximum + padding];
}

function qualityClass(value) {
  if (value == null || value === '') return 'rejected';
  const quality = Number(value);
  if (!Number.isFinite(quality)) return 'rejected';
  if (quality === 0) return 'observation';
  if (quality === 1) return 'suspect';
  return 'rejected';
}

function variableQualityConfig(variable) {
  if (state.featureType !== 'lake') return null;

  const uncertaintyFields = {
    wse: 'wse_u',
    area_total: 'area_tot_u',
    ds1_l: 'ds1_l_u',
    ds1_q: 'ds1_q_u',
    ds2_l: 'ds2_l_u',
    ds2_q: 'ds2_q_u',
  };
  const uncertaintyField = uncertaintyFields[variable];
  if (!uncertaintyField) return null;

  return {
    qualityField: 'quality_f',
    uncertaintyField,
    includeSuspectInFit: els.includeSuspect.checked,
  };
}

function qualityHoverTemplate(variable, config) {
  const valueUnit = fieldUnit(variable);
  const uncertaintyUnit = fieldUnit(config.uncertaintyField);
  return [
    '%{x|%Y-%m-%d %H:%M:%S}',
    `${variable}: %{y}${valueUnit ? ` ${valueUnit}` : ''}`,
    `${config.uncertaintyField}: %{customdata[0]}${uncertaintyUnit ? ` ${uncertaintyUnit}` : ''}`,
    `${config.qualityField}: %{customdata[1]}`,
    '<extra></extra>',
  ].join('<br>');
}

function traceHover(row, config) {
  if (!config) return [];
  const uncertainty = normalise(row[config.uncertaintyField]);
  const quality = normalise(row[config.qualityField]);
  return [uncertainty ?? 'N/A', quality ?? 'N/A'];
}

function renderPlot(preserveViewport = true, selectedVariable = null) {
  const variable = selectedVariable || els.variable.value;
  if (!variable || !state.dataframe.length) {
    els.spinner.hidden = true;
    return;
  }

  const previous = preserveViewport && els.plot.data?.length ? {
    x: els.plot.layout?.xaxis?.range,
    y: els.plot.layout?.yaxis?.range,
  } : null;

  const qualityConfig = variableQualityConfig(variable);
  const rows = state.dataframe
    .map((row) => ({
      ...row,
      time: parseObservationTime(row.time_str),
      value: finiteNumber(row[variable]),
      quality: qualityConfig ? row[qualityConfig.qualityField] : null,
    }))
    .filter((row) => row.time !== null && row.value !== null)
    .sort((a, b) => a.time - b.time);

  if (!rows.length) {
    els.spinner.hidden = true;
    els.loadingText.textContent = 'No valid observations available.';
    return;
  }

  const hasQualityClasses = qualityConfig !== null;
  const standardRows = hasQualityClasses
    ? rows.filter((row) => qualityClass(row.quality) === 'observation')
    : rows;
  const suspectRows = hasQualityClasses
    ? rows.filter((row) => qualityClass(row.quality) === 'suspect')
    : [];
  const rejectedRows = hasQualityClasses
    ? rows.filter((row) => qualityClass(row.quality) === 'rejected')
    : [];

  const smoothingEnabled = els.smoothing.checked;
  const fitRows = qualityConfig?.includeSuspectInFit
    ? [...standardRows, ...suspectRows].sort((a, b) => a.time - b.time)
    : standardRows;
  const smoothX = fitRows.map((row) => row.time.getTime());
  const smoothY = fitRows.map((row) => row.value);
  const smooth = smoothingEnabled
    ? robustLowess(
      smoothX,
      smoothY,
      Number(els.smoothness.value),
      Number(els.threshold.value),
    )
    : {fit: [...smoothY], outliers: smoothY.map(() => false)};

  const lowessOutlierSet = new Set(
    smoothingEnabled
      ? fitRows.filter((_, index) => smooth.outliers[index])
      : [],
  );
  const acceptedRows = standardRows.filter((row) => !lowessOutlierSet.has(row));
  const displayedSuspectRows = suspectRows.filter((row) => !lowessOutlierSet.has(row));
  const lowessOutlierRows = smoothingEnabled
    ? fitRows.filter((row) => lowessOutlierSet.has(row))
    : [];

  const variableUnit = fieldUnit(variable);
  const defaultHover = `%{x|%Y-%m-%d %H:%M:%S}<br>${variable}: %{y}${variableUnit ? ` ${variableUnit}` : ''}<extra></extra>`;
  const hovertemplate = qualityConfig
    ? qualityHoverTemplate(variable, qualityConfig)
    : defaultHover;

  const traces = [{
    x: acceptedRows.map((row) => row.time),
    y: acceptedRows.map((row) => row.value),
    customdata: acceptedRows.map((row) => traceHover(row, qualityConfig)),
    mode: 'markers',
    name: 'Observation',
    marker: {size: 6, color: '#2d80b7'},
    hovertemplate,
  }];

  if (hasQualityClasses) {
    traces.push({
      x: displayedSuspectRows.map((row) => row.time),
      y: displayedSuspectRows.map((row) => row.value),
      customdata: displayedSuspectRows.map((row) => traceHover(row, qualityConfig)),
      mode: 'markers',
      name: 'Observation (suspect)',
      marker: {
        size: 6,
        color: '#49c8f3',
        symbol: 'circle',
        line: {width: 0.8, color: '#49c8f3'},
      },
      hovertemplate,
    });
    traces.push({
      x: rejectedRows.map((row) => row.time),
      y: rejectedRows.map((row) => row.value),
      customdata: rejectedRows.map((row) => traceHover(row, qualityConfig)),
      mode: 'markers',
      name: 'Observation (rejected)',
      visible: 'legendonly',
      marker: {
        size: 5,
        color: '#8d96a0',
        symbol: 'circle-open',
        line: {width: 1.2, color: '#8d96a0'},
      },
      hovertemplate,
    });
  }

  if (smoothingEnabled) {
    traces.push({
      x: lowessOutlierRows.map((row) => row.time),
      y: lowessOutlierRows.map((row) => row.value),
      customdata: lowessOutlierRows.map((row) => traceHover(row, qualityConfig)),
      mode: 'markers',
      name: 'Outlier (LOWESS)',
      marker: {
        symbol: 'x-thin',
        size: 6,
        color: '#d62728',
        line: {width: 1},
      },
      hovertemplate,
    });
    traces.push({
      x: fitRows.map((row) => row.time),
      y: smooth.fit,
      mode: 'lines',
      name: 'Fit (LOWESS)',
      line: {width: 3, color: '#c8442c'},
      hoverinfo: 'skip',
    });
  }

  const firstTime = rows[0]?.time;
  const lastTime = rows.at(-1)?.time;
  const initialXRange = firstTime && lastTime ? [firstTime, lastTime] : null;
  // Use visible accepted and suspect observations for the initial range.
  // Rejected observations, LOWESS outliers, and the fit do not expand it.
  const initialYValues = [
    ...acceptedRows.map((row) => row.value),
    ...displayedSuspectRows.map((row) => row.value),
  ];
  const initialYRange = paddedNumericRange(initialYValues);

  const layout = {
    margin: {l: 72, r: 20, t: 18, b: 50},
    height: 430,
    showlegend: true,
    legend: {orientation: 'h', y: 1.08, x: 0},
    xaxis: {
      type: 'date',
      fixedrange: false,
      showline: true,
      linecolor: '#000',
      linewidth: 1,
      mirror: false,
      range: initialXRange,
      rangeslider: {visible: true, range: initialXRange},
    },
    yaxis: {
      title: variableLabel(variable),
      fixedrange: false,
      automargin: true,
      showline: true,
      linecolor: '#000',
      linewidth: 1,
      mirror: false,
      range: initialYRange,
      autorange: initialYRange ? false : true,
    },
    dragmode: 'zoom',
    hovermode: 'x unified',
    paper_bgcolor: 'white',
    plot_bgcolor: '#f7f8f8',
  };

  if (previous?.x) layout.xaxis.range = previous.x;
  if (previous?.y) {
    layout.yaxis.range = previous.y;
    layout.yaxis.autorange = false;
  }

  Plotly.react(els.plot, traces, layout, {
    responsive: true,
    displaylogo: false,
    scrollZoom: true,
    modeBarButtonsToRemove: ['select2d', 'lasso2d'],
    toImageButtonOptions: {
      format: 'png',
      filename: `swot_${state.featureType}_${state.selectedFeatureId || 'timeseries'}`,
      scale: 3,
    },
  });
  els.spinner.hidden = true;
  els.loading.style.display = 'none';
  els.plot.style.display = 'block';
}

document.querySelectorAll('[data-feature]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.feature === state.featureType) return;
    state.featureType = button.dataset.feature;
    document.querySelectorAll('[data-feature]').forEach((candidate) => {
      candidate.classList.toggle('active', candidate === button);
    });
    if (state.featureLayer) map.removeLayer(state.featureLayer);
    state.featureLayer = null;
    closePanel({clear: true});
    loadVisibleFeatures();
  });
});

function downloadSelectedCsv() {
  if (!state.rawCsv) return;
  const blob = new Blob([state.rawCsv], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `hydrocron_${state.featureType}_${state.selectedFeatureId || 'selection'}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

els.panelBack.addEventListener('click', () => closePanel({clear: true}));
els.panelClose.addEventListener('click', () => closePanel({clear: true}));
els.panelDownload.addEventListener('click', downloadSelectedCsv);
els.variable.addEventListener('change', () => {
  els.smoothing.checked = FEATURE_CONFIG[state.featureType]
    .smoothDefaults.includes(els.variable.value);
  renderPlot(false);
});
els.smoothing.addEventListener('change', () => renderPlot(true));
els.includeSuspect.addEventListener('change', () => renderPlot(true));
els.smoothness.addEventListener('input', () => {
  els.smoothnessValue.value = Number(els.smoothness.value).toFixed(2);
  renderPlot(true);
});
els.threshold.addEventListener('input', () => {
  els.thresholdValue.value = Number(els.threshold.value).toFixed(1);
  renderPlot(true);
});

els.frequencyToggle.addEventListener('change', () => {
  state.frequencyEnabled = els.frequencyToggle.checked;
  if (state.frequencyEnabled) loadObservationFrequency();
  else removeFrequencyLayer();
});
map.on('moveend zoomend', scheduleGeometryLoad);
loadVisibleFeatures();
