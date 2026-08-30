import {CONFIG} from './config.js';
import {FEATURE_CONFIG, META_LABELS, variableLabel, variableUnit} from './fields.js?v=44';
import {lowess, robustLowess} from './smoothing.js?v=41';
import {createGlobalInset} from './inset-map.js?v=35';

const state = {
  featureType: 'lake',
  basemap: 'street',
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
  guidedNavigation: false,
  dischargeMarkerLayer: null,
  dischargeReachIds: null,
  dischargeReachIdsPromise: null,
};

const MAP_STYLE = {
  street: {
    lakeStroke: '#16718d',
    lakeFill: '#38a4c0',
    feature: '#176b87',
    discharge: '#176b87',
    selectedLakeStroke: '#ef8b2c',
    selectedLakeFill: '#ffb260',
    selected: '#ef5a34',
    nadir: '#151515',
  },
  satellite: {
    lakeStroke: '#69dcff',
    lakeFill: '#63d6ff',
    feature: '#63d6ff',
    discharge: '#63d6ff',
    selectedLakeStroke: '#ffd166',
    selectedLakeFill: '#ffb84d',
    selected: '#ffb347',
    nadir: '#ffffff',
  },
};

function activeMapStyle() {
  return MAP_STYLE[state.basemap];
}

function applyBasemapTheme(mode) {
  state.basemap = mode;
  document.documentElement.dataset.basemap = mode;

  const style = activeMapStyle();
  const root = document.documentElement.style;
  root.setProperty('--map-feature-color', style.feature);
  root.setProperty('--map-discharge-color', style.discharge);
  root.setProperty('--map-selected-color', style.selected);
}

const WEB_MERCATOR_BOUNDS = L.latLngBounds(
  [-85.05112878, -180],
  [85.05112878, 180],
);

const map = L.map('map', {
  zoomControl: false,
  preferCanvas: true,
  worldCopyJump: true,

  // Longitude is intentionally unbounded/wrapping. Latitude remains clamped
  // to the valid Web Mercator range.
  maxBounds: L.latLngBounds(
    [-85.05112878, -Infinity],
    [85.05112878, Infinity],
  ),
  maxBoundsViscosity: 1,
}).setView(CONFIG.initialCenter, CONFIG.initialZoom);

// Do not allow the viewport to become taller than one Web Mercator world.
// This keeps the map within the valid latitude range on any screen size.
function updateWorldMinZoom() {
  const mapHeight = Math.max(1, map.getSize().y);

  // Horizontal world repetition is intentional. Only prevent zooming out
  // farther than one Web Mercator world vertically.
  const minZoom = Math.max(
    0,
    Math.ceil(Math.log2(mapHeight / 256)),
  );

  map.setMinZoom(minZoom);

  if (map.getZoom() < minZoom) {
    map.setZoom(minZoom, {animate:false});
  }
}

updateWorldMinZoom();
map.on('resize', updateWorldMinZoom);

const streetBasemap = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  },
);

const satelliteBasemap = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    attribution:
      'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, ' +
      'Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
  },
);

streetBasemap.addTo(map);

const basemapControl = L.control.layers(
  {
    'Street map': streetBasemap,
    'Satellite': satelliteBasemap,
  },
  null,
  {
    position: 'topleft',
    collapsed: true,
  },
).addTo(map);

basemapControl.getContainer()?.classList.add('basemap-selector');

applyBasemapTheme('street');

map.on('baselayerchange', (event) => {
  applyBasemapTheme(
    event.layer === satelliteBasemap ? 'satellite' : 'street',
  );
  refreshMapSymbology();

  if (state.frequencyEnabled) {
    void loadObservationFrequency();
  }
});



// Responsive projected global inset. It follows the main viewport while
// remaining more zoomed out, and stops at the Web Mercator world extent.
document.querySelector('#overview-control')?.remove();

void createGlobalInset(map).catch((error) => {
  console.error('Inset map failed:', error);
});

if (L.Control?.geocoder) {
  const photonGeocoder = L.Control.Geocoder.photon();

  L.Control.geocoder({
    geocoder: photonGeocoder,
    defaultMarkGeocode: false,
    position: 'bottomright',
    placeholder: 'Type place…',
    collapsed: true,
    suggestMinLength: 3,
    suggestTimeout: 250,
    showUniqueResult: false,
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
map.createPane('discharge-availability');
map.getPane('discharge-availability').style.zIndex = 480;
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
  qualityControls: document.querySelector('#lake-quality-controls'),
  includeSuspect: document.querySelector('#include-suspect'),
  includeRejected: document.querySelector('#include-rejected'),
  iceDisplayMode: document.querySelector('#ice-display-mode'),
  showUncertainty: document.querySelector('#show-uncertainty'),
  smoothness: document.querySelector('#smoothness'),
  smoothnessValue: document.querySelector('#smoothness-value'),
  threshold: document.querySelector('#outlier-threshold'),
  thresholdValue: document.querySelector('#outlier-value'),
  smoothingMaxGap: document.querySelector('#smoothing-max-gap'),
  smoothingMaxGapValue: document.querySelector('#smoothing-max-gap-value'),
  frequencyToggle: document.querySelector('#frequency-toggle'),
  frequencyLegend: document.querySelector('#frequency-legend'),
  dataDescription: document.querySelector('#data-description-content'),
  welcomeDialog: document.querySelector('#welcome-dialog'),
  welcomeClose: document.querySelector('#welcome-close'),
  welcomeStart: document.querySelector('#welcome-start'),
  welcomeLake: document.querySelector('#welcome-lake'),
  welcomeReach: document.querySelector('#welcome-reach'),
};

els.panelDownload.disabled = true;
prepareStatusStack();

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function resizePlot() {
  if (
    !els.plot ||
    !els.plot.data?.length ||
    els.plot.offsetParent === null
  ) {
    return;
  }

  Plotly.Plots.resize(els.plot);
}

function schedulePlotResize() {
  requestAnimationFrame(() => {
    requestAnimationFrame(resizePlot);
  });
}

function apiUrl(path, params) {
  const base = CONFIG.apiBaseUrl.replace(/\/$/, '');
  return `${base}${path}?${params.toString()}`;
}

function prepareStatusStack() {
  els.status.textContent = '';
  Object.assign(els.status.style, {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '7px',
    width: 'min(92vw, 560px)',
    padding: '0',
    background: 'transparent',
    boxShadow: 'none',
    borderRadius: '0',
    pointerEvents: 'none',
  });
}

function statusChannel(message) {
  if (/orbit|overlap|nadir|observation[- ]frequency/i.test(message)) return 'orbit';
  if (/discharge|reach ID list/i.test(message)) return 'discharge';
  if (/hydrocron|data request/i.test(message)) return 'data';
  if (
    /loading visible|geometry request|zoom to level|loaded .* (lake|lakes|reach|reaches|node|nodes)/i
      .test(message)
  ) return 'geometry';
  return 'general';
}

function setStatus(message, persistent = false) {
  const key = statusChannel(message);
  let toast = els.status.querySelector(`[data-status-key="${key}"]`);

  if (!toast) {
    toast = document.createElement('div');
    toast.dataset.statusKey = key;
    Object.assign(toast.style, {
      display: 'block',
      maxWidth: '100%',
      padding: '8px 13px',
      borderRadius: '12px',
      background: 'rgba(16,32,47,.90)',
      color: '#fff',
      boxShadow: '0 8px 24px rgba(15,31,45,.18)',
      fontSize: '12px',
      lineHeight: '1.35',
      pointerEvents: 'none',
    });
    els.status.append(toast);
  }

  toast.textContent = message;
  clearTimeout(toast._hideTimer);

  if (!persistent) {
    toast._hideTimer = setTimeout(() => toast.remove(), 2800);
  }

  while (els.status.children.length > 4) {
    els.status.firstElementChild?.remove();
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
  const style = activeMapStyle();

  if (state.featureType === 'lake') {
    return {
      color: style.lakeStroke,
      weight: 2.5,
      fillColor: style.lakeFill,
      fillOpacity: 0.18,
    };
  }

  if (state.featureType === 'reach') {
    return {
      color: style.feature,
      weight: 4,
      opacity: 0.95,
    };
  }

  return {
    radius: 4.5,
    color: '#fff',
    weight: 1.8,
    fillColor: style.feature,
    fillOpacity: 0.95,
  };
}

function selectedStyle() {
  const style = activeMapStyle();

  if (state.featureType === 'lake') {
    return {
      color: style.selectedLakeStroke,
      weight: 4,
      fillColor: style.selectedLakeFill,
      fillOpacity: 0.3,
    };
  }

  if (state.featureType === 'reach') {
    return {
      color: style.selected,
      weight: 7,
      opacity: 1,
    };
  }

  return {
    radius: 8,
    color: '#fff',
    weight: 2,
    fillColor: style.selected,
    fillOpacity: 1,
  };
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
  const selectedFeatureStyle = selected ? selectedStyle() : null;

  return L.geoJSON(data, {
    pane: selected ? 'selected-feature' : 'water-features',
    interactive: !selected,
    bubblingMouseEvents: !selected,
    style: (feature) => selected
      ? selectedFeatureStyle
      : geometryStyle(feature),

    pointToLayer: (feature, latlng) => {
      const style = selected
        ? selectedFeatureStyle
        : geometryStyle(feature);

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
        const baseStyle = geometryStyle(feature);
        layer.on({
          mouseover: () => {
            layer.setStyle({
              weight: (baseStyle.weight || 1) + 2,
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


function refreshMapSymbology() {
  if (state.featureLayer) {
    state.featureLayer.eachLayer((layer) => {
      if (state.featureType === 'node') {
        layer.setIcon?.(nodeIcon(false));
      } else {
        layer.setStyle?.(geometryStyle());
      }
    });
  }

  if (state.selectionLayer) {
    state.selectionLayer.eachLayer((layer) => {
      if (state.featureType === 'node') {
        layer.setIcon?.(nodeIcon(true));
      } else {
        layer.setStyle?.(selectedStyle());
      }
    });
  }

  if (state.featureType === 'reach' && state.featureLayer) {
    renderDischargeMarkers(state.featureLayer);
  }
}


const REACH_DISCHARGE_COLLECTION = 'SWOT_L2_HR_RiverSP_2.0';
const REACH_DISCHARGE_ID_FILE =
  './data/discharge/reach-ids_SWOT_L4_HR_DAWG_SOS_DISCHARGE_V3.json';

// Hydrocron exposes the L4 SoS fields through Version 2.0 reach calls.
// dschg_c is kept as a separate L2/NRT field; it remains unselectable when empty.
const REACH_DISCHARGE_FIELDS = [
  'dschg_c',
  'sos_consensus_q',
  'sos_hivdi_q',
  'sos_metroman_q',
  'sos_momma_q',
  'sos_sad_q',
  'sos_sic4dvar_q',
  'sos_lakeflow_q',
];

async function loadDischargeReachIds() {
  if (state.dischargeReachIds) return state.dischargeReachIds;

  if (!state.dischargeReachIdsPromise) {
    state.dischargeReachIdsPromise = fetch(
      new URL(REACH_DISCHARGE_ID_FILE, document.baseURI),
    )
      .then((response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then((values) => {
        if (!Array.isArray(values)) {
          throw new Error('Expected a JSON array of reach IDs.');
        }
        state.dischargeReachIds = new Set(values.map(String));
        return state.dischargeReachIds;
      })
      .catch((error) => {
        state.dischargeReachIds = new Set();
        setStatus(
          `Discharge reach ID list could not be loaded: ${error.message}`,
          true,
        );
        return state.dischargeReachIds;
      });
  }

  return state.dischargeReachIdsPromise;
}

function reachHasL4Discharge(feature) {
  if (state.featureType !== 'reach' || !state.dischargeReachIds) return false;
  const reachId = feature?.properties?.reach_id;
  return reachId != null && state.dischargeReachIds.has(String(reachId));
}

function clearDischargeMarkers() {
  if (state.dischargeMarkerLayer) map.removeLayer(state.dischargeMarkerLayer);
  state.dischargeMarkerLayer = null;
}

function dischargeMarkerCenter(layer) {
  if (typeof layer.getCenter === 'function') {
    try {
      return layer.getCenter();
    } catch (_) {
      // Fall through to bounds.
    }
  }
  const bounds = layer.getBounds?.();
  return bounds?.isValid?.() ? bounds.getCenter() : null;
}

function renderDischargeMarkers(featureLayer) {
  clearDischargeMarkers();
  if (state.featureType !== 'reach' || !state.dischargeReachIds?.size) return;

  const markers = L.layerGroup();

  featureLayer.eachLayer((layer) => {
    const feature = layer.feature;
    if (!feature || !reachHasL4Discharge(feature)) return;

    const center = dischargeMarkerCenter(layer);
    if (!center) return;

    const icon = L.divIcon({
      className: '',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      html: `
        <span style="
          width:30px;height:30px;display:flex;align-items:center;justify-content:center;
          border:2px solid #fff;border-radius:50%;
          background:${activeMapStyle().discharge};
          box-shadow:0 2px 8px rgba(16,32,47,.28);
        ">
          <img
            src="./assets/img/icon_discharge.svg"
            alt=""
            style="
              width:16px;height:16px;display:block;
              object-fit:contain;
              filter:brightness(0) invert(1);
              pointer-events:none;
            "
          >
        </span>`,
    });

    const marker = L.marker(center, {
      pane: 'discharge-availability',
      icon,
      keyboard: true,
      riseOnHover: false,
      zIndexOffset: 2000,
    });

    marker.on('click', (event) => {
      L.DomEvent.stopPropagation(event);
      selectFeature(feature);
    });

    marker.addTo(markers);
  });

  state.dischargeMarkerLayer = markers.addTo(map);
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
  const viewport = L.bounds(L.point(0, 0), map.getSize());
  const segments = [];

  for (const line of lineCoordinateSequences(feature.geometry)) {
    for (let i = 1; i < line.length; i += 1) {
      const start = map.latLngToContainerPoint([
        line[i - 1][1],
        line[i - 1][0],
      ]);
      const end = map.latLngToContainerPoint([
        line[i][1],
        line[i][0],
      ]);

      const clipped = L.LineUtil.clipSegment(
        start,
        end,
        viewport,
        false,
      );

      if (!clipped) continue;

      const length = clipped[0].distanceTo(clipped[1]);
      if (length > 0) {
        segments.push({
          start: clipped[0],
          end: clipped[1],
          length,
        });
      }
    }
  }

  const totalLength = segments.reduce(
    (sum, segment) => sum + segment.length,
    0,
  );

  if (totalLength < 45) return null;

  let remaining = totalLength / 2;

  for (const segment of segments) {
    if (remaining > segment.length) {
      remaining -= segment.length;
      continue;
    }

    const fraction = remaining / segment.length;
    const point = L.point(
      segment.start.x +
        (segment.end.x - segment.start.x) * fraction,
      segment.start.y +
        (segment.end.y - segment.start.y) * fraction,
    );

    let angle = Math.atan2(
      segment.end.y - segment.start.y,
      segment.end.x - segment.start.x,
    ) * 180 / Math.PI;

    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;

    return {
      latlng: map.containerPointToLatLng(point),
      angle,
    };
  }

  return null;
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
        color: activeMapStyle().nadir,
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

async function loadVisibleFeatures(targetId = null) {
  const minZoom = CONFIG.minZoom[state.featureType];
  const featureNoun = {lake: 'lake', reach: 'reach', node: 'node'}[state.featureType];
  const featurePlural = {lake: 'lakes', reach: 'reaches', node: 'nodes'}[state.featureType];

  if (map.getZoom() < minZoom) {
    if (state.featureLayer) map.removeLayer(state.featureLayer);
    state.featureLayer = null;
    clearDischargeMarkers();
    setStatus(`Zoom to level ${minZoom} to load ${featurePlural}.`, true);
    return null;
  }

  state.abortController?.abort();
  const controller = new AbortController();
  state.abortController = controller;
  setStatus(`Loading visible ${featurePlural}…`, true);

  try {
    const dischargeIdsRequest = state.featureType === 'reach'
      ? loadDischargeReachIds()
      : Promise.resolve(null);

    const response = await fetch(apiUrl('/api/wfs', buildWfsParams()), {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    const [payload] = await Promise.all([
      response.json(),
      dischargeIdsRequest,
    ]);

    if (state.abortController !== controller) return null;

    const nextLayer = makeGeoJson(payload);
    nextLayer.addTo(map);

    if (state.featureLayer) map.removeLayer(state.featureLayer);
    state.featureLayer = nextLayer;

    renderDischargeMarkers(nextLayer);

    const count = payload.features?.length || 0;
    setStatus(
      `Loaded ${count.toLocaleString()} ${count === 1 ? featureNoun : featurePlural}.`,
    );
    state.selectionLayer?.bringToFront();

    if (targetId != null) {
      const requestedId = String(targetId);
      const feature = payload.features?.find((candidate) => {
        try {
          return getFeatureId(candidate.properties || {}) === requestedId;
        } catch {
          return false;
        }
      });

      if (!feature) {
        setStatus(
          `${featureNoun} ID ${requestedId} was not found in the loaded area.`,
          true,
        );
        return {payload, layer: nextLayer, selected: false};
      }

      void selectFeature(feature);
      return {payload, layer: nextLayer, selected: true};
    }

    return {payload, layer: nextLayer};
  } catch (error) {
    if (error.name !== 'AbortError') {
      setStatus(`Geometry request failed: ${error.message}`, true);
    }
    return null;
  }
}

function scheduleGeometryLoad() {
  if (state.guidedNavigation) return;

  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    loadVisibleFeatures();
    if (state.frequencyEnabled) loadObservationFrequency();
  }, CONFIG.debounceMs);
}

function openPanel() {
  els.panel.classList.add('open');
  els.panel.setAttribute('aria-hidden', 'false');

  schedulePlotResize();
  els.panel.addEventListener('transitionend', resizePlot, {once: true});
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
    return titleCase(String(value).replaceAll(';', ', '));
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

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric.toFixed(1);
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

function queryFields({includeDischarge = false} = {}) {
  const cfg = FEATURE_CONFIG[state.featureType];
  const dischargeFields = new Set(REACH_DISCHARGE_FIELDS);
  const variables = includeDischarge
    ? REACH_DISCHARGE_FIELDS
    : cfg.variables.filter((field) => !dischargeFields.has(field));

  const fields = [
    ...variables,
    ...(includeDischarge ? [] : cfg.metadata),
    ...(includeDischarge ? [] : (cfg.qualityFields || [])),
  ];

  return [...new Set(['time_str', ...fields])].join(',');
}

async function fetchHydrocronCsv(params, signal) {
  const response = await fetch(apiUrl('/api/hydrocron', params), {signal});
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

  let text = await response.text();
  try {
    const payload = JSON.parse(text);
    text = payload?.results?.csv || text;
  } catch (_) {
    // Hydrocron may already return raw CSV.
  }
  return text;
}
async function fetchOptionalHydrocronCsv(
  params,
  signal,
  label = 'Hydrocron request',
) {
  try {
    return await fetchHydrocronCsv(params, signal);
  } catch (error) {
    if (error.name === 'AbortError') throw error;

    // Missing feature IDs are possible in either product collection. Treat
    // these as an unavailable dataset for the selected feature rather than
    // failing the complete panel request.
    console.info(`${label} returned no data:`, error.message);
    return null;
  }
}


function parseHydrocronRows(csvText) {
  const parsed = Papa.parse(csvText, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });

  return parsed.data.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalise(value)]),
  ));
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
  const baseParams = {
    output: 'csv',
    start_time: CONFIG.startTime,
    end_time: endTime,
    feature: cfg.feature,
    feature_id: id,
  };

  const primaryParams = new URLSearchParams({
    ...baseParams,
    fields: queryFields(),
    collection_name: cfg.collection,
  });

  try {
    const signal = state.hydrocronAbortController.signal;

    // Both product requests are independent. Version D remains preferred, but
    // a missing Version D feature must not suppress otherwise valid L4 data.
    const primaryRequest = fetchOptionalHydrocronCsv(
      primaryParams,
      signal,
      `${cfg.collection} request`,
    );

    const hasL4Discharge =
      state.featureType === 'reach' && reachHasL4Discharge(feature);

    const dischargeRequest = hasL4Discharge
      ? fetchOptionalHydrocronCsv(
        new URLSearchParams({
          ...baseParams,
          fields: queryFields({includeDischarge: true}),
          collection_name: REACH_DISCHARGE_COLLECTION,
        }),
        signal,
        'L4 discharge request',
      )
      : Promise.resolve(null);

    const [primaryCsv, dischargeCsv] = await Promise.all([
      primaryRequest,
      dischargeRequest,
    ]);

    if (requestId !== state.selectionRequestId) return;

    let primaryRows = [];
    if (primaryCsv) {
      try {
        primaryRows = parseHydrocronRows(primaryCsv);
      } catch (error) {
        console.info(
          'Primary Hydrocron response could not be parsed:',
          error.message,
        );
      }
    }

    let dischargeRows = [];
    if (dischargeCsv) {
      try {
        dischargeRows = parseHydrocronRows(dischargeCsv);
      } catch (error) {
        console.info(
          'L4 discharge response could not be parsed:',
          error.message,
        );
      }
    }

    // Version D is preferred for the normal variables, but L4-only reaches
    // remain usable when Version D has no matching feature ID.
    state.dataframe = [
      ...primaryRows,
      ...dischargeRows,
    ];

    state.rawCsv = primaryCsv || dischargeCsv || '';
    els.panelDownload.disabled = !state.rawCsv;

    if (!state.dataframe.length) {
      renderDataDescription();
      els.spinner.hidden = true;
      els.loadingText.textContent =
        'No SWOT observations were found for this feature in the available datasets.';
      setStatus('No observations found for this feature.');
      return;
    }

    renderMetadata(state.dataframe);
    renderDataDescription();
    const initialVariable = populateVariables();
    renderPlot(false, initialVariable);

    if (!primaryRows.length && dischargeRows.length) {
      setStatus(
        'Version D data unavailable; showing available L4 discharge data.',
      );
    }
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
      <p>Lake observations shown are from <strong>SWOT_L2_HR_LakeSP_D</strong>.
      This dataset provides geolocated surface water measurements for lakes, derived
      from high-resolution radar observations collected by the Ka-band Radar
      Interferometer (KaRIn) on the SWOT satellite. The main variable contained is
      water surface elevation. From April to July 2023, data may be unusually
      frequent or absent before the transition from calibration to operational
      orbit.</p>
      <div class="dataset-citation">
        <p>SWOT. (2025). <em>SWOT Level 2 Lake Single-Pass Vector Data Product</em> 
        [Dataset]. NASA Physical Oceanography Distributed Active Archive Center. 
        <a href="https://doi.org/10.5067/SWOT-LAKESP-D" target="_blank" 
        rel="noopener noreferrer">https://doi.org/10.5067/SWOT-LAKESP-D</a></p>
      </div>`;
    return;
  }

  const hasL4Discharge =
    state.featureType === 'reach' && reachHasL4Discharge(state.selectedFeature);

  const dischargeDescription = hasL4Discharge ? `
    <div style="margin-top:14px">
    <p>This reach has additional <strong>SWOT Level 4 Sword of Science (SoS) River Discharge, Version 3</strong> data available. Sword of Science data products are generated from the open-source SWOT Confluence program and contain river discharge parameter estimates. The individual discharge algorithms may have sparse coverage, while the consensus estimate is generally the most complete. All displayed discharge values are treated as m³/s.</p>
    <div class="dataset-citation">
      <p>SWOT Discharge Algorithm Working Group (DAWG). 2025. <em>SWOT discharge prior information and processing outputs.</em> Ver. 3.0. PO.DAAC, CA, USA.
      <a href="https://doi.org/10.5067/SWOT-SOS-RD3" target="_blank"
      rel="noopener noreferrer">https://doi.org/10.5067/SWOT-SOS-RD3</a></p>
    </div>
    </div>` : '';

  els.dataDescription.innerHTML = `
    <p>River reach and node observations are from <strong>SWOT_L2_HR_RiverSP_D</strong>.
    This dataset provides hydrologic measurements for predefined river reaches and nodes,
    derived from high-resolution radar observations collected by the Ka-band Radar
    Interferometer (KaRIn) aboard the SWOT satellite. From April to July 2023, data may be
    unusually frequent or absent before the transition from calibration to operational orbit.</p>
    <div class="dataset-citation">
      <p>SWOT. (2025). <em>SWOT Level 2 River Single-Pass Vector Data Product</em>
      [Dataset]. NASA Physical Oceanography Distributed Active Archive Center.
      <a href="https://doi.org/10.5067/SWOT-RIVERSP-D" target="_blank"
      rel="noopener noreferrer">https://doi.org/10.5067/SWOT-RIVERSP-D</a></p>
    </div>
    ${dischargeDescription}`;
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

  const isLake = state.featureType === 'lake';
  els.qualityControls.hidden = !isLake;

  if (isLake) {
    // Keep the default lake plot complete and simple. Suspect observations
    // remain visible, uncertainty is shown, and ice information is opt-in as
    // a visual highlight rather than an automatic filter.
    els.includeSuspect.checked = true;
    els.includeRejected.checked = false;
    els.iceDisplayMode.value = 'none';
    els.showUncertainty.checked = true;
    updateIceAvailability();
  }

  updateUncertaintyAvailability(initial);
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

const LAKE_UNCERTAINTY_FIELDS = {
  wse: 'wse_u',
  area_total: 'area_tot_u',
  ds1_l: 'ds1_l_u',
  ds1_q: 'ds1_q_u',
  ds2_l: 'ds2_l_u',
  ds2_q: 'ds2_q_u',
};

function variableQualityConfig(variable) {
  if (state.featureType !== 'lake') return null;

  const uncertaintyField = LAKE_UNCERTAINTY_FIELDS[variable];
  if (!uncertaintyField) return null;

  return {
    qualityField: 'quality_f',
    uncertaintyField,
    iceClimField: 'ice_clim_f',
    iceDynamicField: 'ice_dyn_f',
  };
}

function updateUncertaintyAvailability(variable) {
  if (!els.showUncertainty) return;

  if (state.featureType !== 'lake') {
    els.showUncertainty.checked = false;
    els.showUncertainty.disabled = true;
    return;
  }

  const uncertaintyField = LAKE_UNCERTAINTY_FIELDS[variable];
  const hasUncertainty = Boolean(
    uncertaintyField &&
    state.dataframe.some(
      (row) => finiteNumber(row[uncertaintyField]) !== null,
    )
  );

  els.showUncertainty.disabled = !hasUncertainty;
  if (!hasUncertainty) els.showUncertainty.checked = false;
}

function iceFlagValue(value) {
  const flag = finiteNumber(value);
  return flag === 0 || flag === 1 || flag === 2 ? flag : null;
}

function iceFlagged(value) {
  const flag = iceFlagValue(value);
  return flag === 1 || flag === 2;
}

function climatologicalIceLabel(value) {
  const flag = iceFlagValue(value);
  if (flag === 0) return 'no ice expected';
  if (flag === 1) return 'uncertain / possible ice';
  if (flag === 2) return 'full ice expected';
  return 'not available';
}

function dynamicIceLabel(value) {
  const flag = iceFlagValue(value);
  if (flag === 0) return 'no ice';
  if (flag === 1) return 'partial ice';
  if (flag === 2) return 'full ice';
  return 'not available';
}

function iceHoverValue(value) {
  const flag = iceFlagValue(value);
  return flag === null ? 'N/A' : flag;
}

const ICE_CLIM_HALF_WINDOW_DAYS = 10.5;
const ICE_DYNAMIC_HALF_WINDOW_DAYS = 1;

function selectedIceModes() {
  const mode = els.iceDisplayMode?.value || 'none';

  return {
    climatology: mode === 'climatology' || mode === 'both',
    dynamic: mode === 'dynamic' || mode === 'both',
  };
}

function mergeTimeIntervals(intervals) {
  const sorted = [...intervals]
    .sort((a, b) => a[0].getTime() - b[0].getTime());

  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);

    if (
      previous &&
      interval[0].getTime() <= previous[1].getTime()
    ) {
      if (interval[1].getTime() > previous[1].getTime()) {
        previous[1] = interval[1];
      }
      continue;
    }

    merged.push([new Date(interval[0]), new Date(interval[1])]);
  }

  return merged;
}

function iceBackgroundShapes(rows) {
  if (state.featureType !== 'lake') return [];

  const modes = selectedIceModes();
  const dayMs = 86400000;
  const shapes = [];

  if (modes.climatology) {
    const climatologyIntervals = rows
      .filter((row) => iceFlagged(row.iceClim))
      .map((row) => {
        const t = row.time.getTime();
        return [
          new Date(t - ICE_CLIM_HALF_WINDOW_DAYS * dayMs),
          new Date(t + ICE_CLIM_HALF_WINDOW_DAYS * dayMs),
        ];
      });

    for (const [x0, x1] of mergeTimeIntervals(climatologyIntervals)) {
      shapes.push({
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0,
        x1,
        y0: 0,
        y1: 1,
        fillcolor: 'rgba(106, 190, 222, 0.13)',
        line: {width: 0},
        layer: 'below',
      });
    }
  }

  if (modes.dynamic) {
    for (const row of rows.filter((item) => iceFlagged(item.iceDynamic))) {
      const t = row.time.getTime();

      shapes.push({
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0: new Date(t - ICE_DYNAMIC_HALF_WINDOW_DAYS * dayMs),
        x1: new Date(t + ICE_DYNAMIC_HALF_WINDOW_DAYS * dayMs),
        y0: 0,
        y1: 1,
        fillcolor: 'rgba(38, 137, 177, 0.28)',
        line: {width: 0},
        layer: 'below',
      });
    }
  }

  return shapes;
}

function iceLegendTraces(rows) {
  if (state.featureType !== 'lake') return [];

  const modes = selectedIceModes();
  const traces = [];

  if (
    modes.climatology &&
    rows.some((row) => iceFlagged(row.iceClim))
  ) {
    traces.push({
      x: [null],
      y: [null],
      mode: 'lines',
      name: 'Pot. ice-affected (ice_clim_f)',
      line: {
        color: 'rgba(106, 190, 222, 0.42)',
        width: 9,
      },
      hoverinfo: 'skip',
    });
  }

  if (
    modes.dynamic &&
    rows.some((row) => iceFlagged(row.iceDynamic))
  ) {
    traces.push({
      x: [null],
      y: [null],
      mode: 'lines',
      name: 'Pot. ice-affected (ice_dyn_f)',
      line: {
        color: 'rgba(38, 137, 177, 0.72)',
        width: 5,
      },
      hoverinfo: 'skip',
    });
  }

  return traces;
}

function iceFlagAvailability(field) {
  const valid = state.dataframe
    .map((row) => iceFlagValue(row[field]))
    .filter((value) => value !== null);

  return {
    available: valid.length > 0,
    flagged: valid.filter((value) => value === 1 || value === 2).length,
  };
}

function updateIceAvailability() {
  if (!els.iceDisplayMode || state.featureType !== 'lake') return;

  const clim = iceFlagAvailability('ice_clim_f');
  const dynamic = iceFlagAvailability('ice_dyn_f');
  const climOption = els.iceDisplayMode.querySelector(
    'option[value="climatology"]',
  );
  const dynamicOption = els.iceDisplayMode.querySelector(
    'option[value="dynamic"]',
  );
  const bothOption = els.iceDisplayMode.querySelector(
    'option[value="both"]',
  );

  if (climOption) {
    climOption.disabled = !clim.available;
    climOption.textContent = clim.available
      ? `Climatology (ice_clim_f) · ${clim.flagged} flagged`
      : 'Climatology (ice_clim_f) · unavailable';
  }

  if (dynamicOption) {
    dynamicOption.disabled = !dynamic.available;
    dynamicOption.textContent = dynamic.available
      ? `Dynamic (ice_dyn_f) · ${dynamic.flagged} flagged`
      : 'Dynamic (ice_dyn_f) · unavailable';
  }

  if (bothOption) {
    bothOption.disabled = !(clim.available && dynamic.available);
    bothOption.textContent = clim.available && dynamic.available
      ? 'Both ice flags'
      : 'Both ice flags · unavailable';
  }

  const selected = els.iceDisplayMode.selectedOptions[0];
  if (selected?.disabled) {
    els.iceDisplayMode.value = 'none';
  }
}

function uncertaintyErrorBars(rows, config) {
  if (
    !config ||
    !els.showUncertainty.checked ||
    els.showUncertainty.disabled
  ) {
    return undefined;
  }

  const values = rows.map(
    (row) => finiteNumber(row[config.uncertaintyField]) ?? 0,
  );

  if (!values.some((value) => value > 0)) return undefined;

  return {
    type: 'data',
    array: values,
    visible: true,
    thickness: 0.8,
    width: 2,
    color: 'rgba(16,32,47,.35)',
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
    `${config.iceDynamicField}: %{customdata[2]}`,
    `${config.iceClimField}: %{customdata[3]}`,
    '<extra></extra>',
  ].join('<br>');
}

function traceHover(row, config) {
  if (!config) return [];
  const uncertainty = finiteNumber(row[config.uncertaintyField]);
  const quality = finiteNumber(row[config.qualityField]);

  return [
    uncertainty ?? 'N/A',
    quality ?? 'N/A',
    iceHoverValue(row[config.iceDynamicField]),
    iceHoverValue(row[config.iceClimField]),
  ];
}

function splitRowsByGap(rows, maxGapMs) {
  const segments = [];

  for (const row of rows) {
    const current = segments.at(-1);

    if (
      !current ||
      !current.length ||
      row.time.getTime() -
        current.at(-1).time.getTime() <= maxGapMs
    ) {
      if (!current) segments.push([]);
      segments.at(-1).push(row);
    } else {
      segments.push([row]);
    }
  }

  return segments;
}

function segmentedRobustLowess(
  rows,
  fraction,
  threshold,
  maxGapDays,
) {
  const maxGapMs =
    Math.max(1, maxGapDays) * 86400000;

  const sourceSegments = splitRowsByGap(
    rows,
    maxGapMs,
  );

  const outlierSet = new Set();
  const traceX = [];
  const traceY = [];

  for (const segment of sourceSegments) {
    const x = segment.map(
      (row) => row.time.getTime(),
    );
    const y = segment.map(
      (row) => row.value,
    );

    const result = robustLowess(
      x,
      y,
      fraction,
      threshold,
      3,
    );

    segment.forEach((row, index) => {
      if (result.outliers[index]) {
        outlierSet.add(row);
      }
    });

    // Completely remove rejected observations before the final LOWESS fit.
    // Re-split after removal as well: an outlier cannot act as a bridge that
    // causes the final curve to span a gap larger than the user's limit.
    const retainedRows = result.retainedIndexes.map(
      (index) => segment[index],
    );

    const finalSegments = splitRowsByGap(
      retainedRows,
      maxGapMs,
    );

    for (const finalSegment of finalSegments) {
      if (!finalSegment.length) continue;

      if (traceX.length) {
        // Nulls tell Plotly not to connect independent fit segments.
        traceX.push(null);
        traceY.push(null);
      }

      const finalX = finalSegment.map(
        (row) => row.time.getTime(),
      );
      const finalY = finalSegment.map(
        (row) => row.value,
      );
      const finalFit = lowess(
        finalX,
        finalY,
        fraction,
      );

      finalSegment.forEach((row, index) => {
        traceX.push(row.time);
        traceY.push(finalFit[index]);
      });
    }
  }

  return {
    outlierSet,
    traceX,
    traceY,
  };
}

async function renderPlot(
  preserveViewport = true,
  selectedVariable = null,
) {
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
      iceClim: qualityConfig ? row[qualityConfig.iceClimField] : null,
      iceDynamic: qualityConfig ? row[qualityConfig.iceDynamicField] : null,
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
    ? rows.filter(
      (row) => qualityClass(row.quality) === 'observation',
    )
    : rows;

  const suspectRows = hasQualityClasses && els.includeSuspect.checked
    ? rows.filter(
      (row) => qualityClass(row.quality) === 'suspect',
    )
    : [];

  const rejectedRows = hasQualityClasses
    ? rows.filter(
      (row) => qualityClass(row.quality) === 'rejected',
    )
    : [];

  const smoothingEnabled = els.smoothing.checked;
  const fitRows = [...standardRows, ...suspectRows]
    .sort((a, b) => a.time - b.time);

  const smooth = smoothingEnabled
    ? segmentedRobustLowess(
      fitRows,
      Number(els.smoothness.value),
      Number(els.threshold.value),
      Number(els.smoothingMaxGap.value),
    )
    : {
      outlierSet: new Set(),
      traceX: fitRows.map((row) => row.time),
      traceY: fitRows.map((row) => row.value),
    };

  const lowessOutlierSet = smooth.outlierSet;
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
    error_y: uncertaintyErrorBars(acceptedRows, qualityConfig),
    hovertemplate,
  }];

  if (hasQualityClasses) {
    traces.push({
      x: displayedSuspectRows.map((row) => row.time),
      y: displayedSuspectRows.map((row) => row.value),
      customdata: displayedSuspectRows.map(
        (row) => traceHover(row, qualityConfig),
      ),
      mode: 'markers',
      name: 'Observation (suspect)',
      marker: {
        size: 6,
        color: '#49c8f3',
        symbol: 'circle',
        line: {width: 0.8, color: '#49c8f3'},
      },
      error_y: uncertaintyErrorBars(
        displayedSuspectRows,
        qualityConfig,
      ),
      hovertemplate,
    });

    if (els.includeRejected.checked) {
      traces.push({
        x: rejectedRows.map((row) => row.time),
        y: rejectedRows.map((row) => row.value),
        customdata: rejectedRows.map(
          (row) => traceHover(row, qualityConfig),
        ),
        mode: 'markers',
        name: 'Observation (rejected)',
        marker: {
          size: 5,
          color: '#8d96a0',
          symbol: 'circle-open',
          line: {width: 1.2, color: '#8d96a0'},
        },
        error_y: uncertaintyErrorBars(
          rejectedRows,
          qualityConfig,
        ),
        hovertemplate,
      });
    }

    traces.push(...iceLegendTraces(rows));
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
      error_y: uncertaintyErrorBars(
        lowessOutlierRows,
        qualityConfig,
      ),
      hovertemplate,
    });
    traces.push({
      x: smooth.traceX,
      y: smooth.traceY,
      mode: 'lines',
      name: 'Fit (LOWESS)',
      connectgaps: false,
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
    autosize: true,
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
    shapes: hasQualityClasses
      ? iceBackgroundShapes(rows)
      : [],
  };

  if (previous?.x) layout.xaxis.range = previous.x;
  if (previous?.y) {
    layout.yaxis.range = previous.y;
    layout.yaxis.autorange = false;
  }

  // Plotly must measure a visible container. Show the plot first, wait for
  // layout, and only then render it at the panel's actual width.
  els.spinner.hidden = true;
  els.loading.style.display = 'none';
  els.plot.style.display = 'block';

  await nextAnimationFrame();

  await Plotly.react(els.plot, traces, layout, {
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

  schedulePlotResize();
}

function closeWelcomeDialog() {
  if (els.welcomeDialog?.open) els.welcomeDialog.close();
}

function configuredDestinations(featureType) {
  const key = featureType === 'lake' ? 'lakes' : 'reaches';
  const values = CONFIG.welcomeDestinations?.[key];
  return Array.isArray(values) ? values.filter((item) =>
    Number.isFinite(Number(item?.lat)) &&
    Number.isFinite(Number(item?.lon)) &&
    item?.id != null) : [];
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function setFeatureType(featureType) {
  if (!FEATURE_CONFIG[featureType]) return;
  state.featureType = featureType;
  document.querySelectorAll('[data-feature]').forEach((button) => {
    button.classList.toggle('active', button.dataset.feature === featureType);
  });
  if (state.featureLayer) map.removeLayer(state.featureLayer);
  state.featureLayer = null;
  clearDischargeMarkers();
  closePanel({clear: true});
}

function moveMapTo(lat, lon, zoom) {
  const featureLocation = L.latLng(Number(lat), Number(lon));

  const isMobile = window.matchMedia(
    '(max-width: 760px), (orientation: portrait) and (max-width: 900px)',
  ).matches;

  const panelWidth = isMobile
    ? 0
    : els.panel.getBoundingClientRect().width;

  // Shift the map center to the right so the configured feature appears
  // centered in the unobstructed map area left of the details panel.
  const projectedFeature = map.project(featureLocation, zoom);
  const adjustedCenter = map.unproject(
    projectedFeature.add(L.point(panelWidth / 2, 0)),
    zoom,
  );

  const alreadyThere =
    map.getZoom() === zoom &&
    map.getCenter().distanceTo(adjustedCenter) < 1;

  if (alreadyThere) return Promise.resolve();

  return new Promise((resolve) => {
    map.once('moveend', resolve);
    map.setView(adjustedCenter, zoom, {animate: true});
  });
}

async function takeMeToFeature(featureType) {
  const destinations = configuredDestinations(featureType);
  if (!destinations.length) {
    setStatus(`No welcome ${featureType} destinations are configured.`, true);
    return;
  }

  const destination = randomItem(destinations);
  const zoom = Number(destination.zoom) ||
    Math.max(CONFIG.minZoom[featureType], featureType === 'lake' ? 11 : 12);

  state.guidedNavigation = true;
  clearTimeout(state.debounceTimer);
  state.abortController?.abort();

  try {
    closeWelcomeDialog();
    setFeatureType(featureType);

    await moveMapTo(destination.lat, destination.lon, zoom);
    await loadVisibleFeatures(destination.id);
  } catch (error) {
    if (error.name !== 'AbortError') {
      setStatus(
        `Could not open ${destination.name || `the selected ${featureType}`}: ${error.message}`,
        true,
      );
    }
  } finally {
    state.guidedNavigation = false;
  }
}

function openWelcomeDialog() {
  if (!els.welcomeDialog || els.welcomeDialog.open) return;
  const lakesConfigured = configuredDestinations('lake').length > 0;
  const reachesConfigured = configuredDestinations('reach').length > 0;
  els.welcomeLake.disabled = !lakesConfigured;
  els.welcomeReach.disabled = !reachesConfigured;
  els.welcomeLake.title = lakesConfigured ? '' : 'Add lake examples in config.js';
  els.welcomeReach.title = reachesConfigured ? '' : 'Add reach examples in config.js';
  els.welcomeDialog.showModal();
  els.welcomeStart?.focus();
}

els.welcomeClose?.addEventListener('click', closeWelcomeDialog);
els.welcomeStart?.addEventListener('click', closeWelcomeDialog);
els.welcomeLake?.addEventListener('click', () => takeMeToFeature('lake'));
els.welcomeReach?.addEventListener('click', () => takeMeToFeature('reach'));
els.welcomeDialog?.addEventListener('click', (event) => {
  if (event.target === els.welcomeDialog) closeWelcomeDialog();
});
window.addEventListener('load', openWelcomeDialog, {once:true});

document.querySelectorAll('[data-feature]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.feature === state.featureType) return;
    setFeatureType(button.dataset.feature);
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
document.querySelectorAll('.settings-disclosure').forEach((section) => {
  section.addEventListener('toggle', () => {
    if (section.open) return;

    section.querySelectorAll('.setting-help-text').forEach((item) => {
      item.hidden = true;
    });
    section.querySelectorAll('.setting-help-button').forEach((item) => {
      item.setAttribute('aria-expanded', 'false');
    });
  });
});

document.querySelectorAll('.setting-help-button').forEach((button) => {
  button.addEventListener('click', () => {
    const targetId = button.dataset.helpTarget;
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) return;

    const willOpen = target.hidden;

    // Keep the section compact: show at most one detailed help item at once.
    const section = button.closest('.settings-disclosure');
    section?.querySelectorAll('.setting-help-text').forEach((item) => {
      item.hidden = true;
    });
    section?.querySelectorAll('.setting-help-button').forEach((item) => {
      item.setAttribute('aria-expanded', 'false');
    });

    target.hidden = !willOpen;
    button.setAttribute(
      'aria-expanded',
      willOpen ? 'true' : 'false',
    );
  });
});

els.variable.addEventListener('change', () => {
  els.smoothing.checked = FEATURE_CONFIG[state.featureType]
    .smoothDefaults.includes(els.variable.value);
  updateUncertaintyAvailability(els.variable.value);
  renderPlot(false);
});
els.smoothing.addEventListener('change', () => renderPlot(true));
els.includeSuspect.addEventListener('change', () => renderPlot(true));
els.includeRejected.addEventListener('change', () => renderPlot(true));
els.iceDisplayMode.addEventListener('change', () => renderPlot(true));
els.showUncertainty.addEventListener('change', () => renderPlot(true));
els.smoothness.addEventListener('input', () => {
  els.smoothnessValue.value = Number(els.smoothness.value).toFixed(2);
  renderPlot(true);
});
els.threshold.addEventListener('input', () => {
  els.thresholdValue.value = Number(els.threshold.value).toFixed(1);
  renderPlot(true);
});
els.smoothingMaxGap.addEventListener('input', () => {
  els.smoothingMaxGapValue.value =
    `${Number(els.smoothingMaxGap.value)} d`;
  renderPlot(true);
});

els.frequencyToggle.addEventListener('change', () => {
  state.frequencyEnabled = els.frequencyToggle.checked;
  if (state.frequencyEnabled) loadObservationFrequency();
  else removeFrequencyLayer();
});
map.on('moveend zoomend', scheduleGeometryLoad);
loadVisibleFeatures();
