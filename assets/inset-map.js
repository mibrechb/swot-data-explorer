import {CONFIG} from './config.js';

const WEB_MERCATOR_MAX_LAT = 85.05112878;

const DEFAULT_OPTIONS = {
  enabled:true,
  position:'bottomleft',
  width:262,
  height:154,
  padding:0,
  contextScale:3.2,
  minLongitudeSpan:48,
  minLatitudeSpan:34,

  // At close zooms the true viewport polygon becomes too small to read.
  viewportEmphasisZoom:12,
  viewportNormalStrokeWidth:2.4,
  viewportEmphasisStrokeWidth:4.5,

  landUrl:'https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json',
  countriesUrl:'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json',
};

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(
    'http://www.w3.org/2000/svg',
    name,
  );

  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value));
  });

  return element;
}

function loadScript(url, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);

  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find(
      (script) => script.src === url,
    );

    if (existing) {
      existing.addEventListener(
        'load',
        () => resolve(window[globalName]),
        {once:true},
      );
      existing.addEventListener('error', reject, {once:true});
      return;
    }

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.addEventListener(
      'load',
      () => resolve(window[globalName]),
      {once:true},
    );
    script.addEventListener('error', reject, {once:true});
    document.head.append(script);
  });
}

async function ensureLibraries() {
  await Promise.all([
    loadScript(
      'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js',
      'd3',
    ),
    loadScript(
      'https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js',
      'topojson',
    ),
  ]);
}

function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const value = (name, fallback) =>
    style.getPropertyValue(name).trim() || fallback;

  return {
    ocean:value('--inset-ocean', '#eef3f5'),
    land:value('--inset-land', '#9caab2'),
    border:value('--inset-border', '#d7e0e4'),
    countries:value('--inset-country-border', '#ffffff'),
    accent:value('--inset-viewport', '#d7191c'),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeLongitude(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function longitudeNear(lon, center) {
  let value = lon;
  while (value - center > 180) value -= 360;
  while (value - center < -180) value += 360;
  return value;
}

function mercatorY(lat) {
  const clamped = clamp(
    lat,
    -WEB_MERCATOR_MAX_LAT,
    WEB_MERCATOR_MAX_LAT,
  );
  const radians = clamped * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

function visibleLongitudeSpan(map) {
  // Derive the horizontal geographic span from Leaflet's projected world
  // width instead of west/east LatLng bounds. This stays continuous when the
  // viewport crosses ±180° and, importantly, when it becomes wider than one
  // complete 360° world at the minimum zoom level.
  const zoom = map.getZoom();
  const pixelWorldBounds = map.getPixelWorldBounds(zoom);

  const worldPixelWidth =
    pixelWorldBounds?.getSize?.().x ||
    256 * Math.pow(2, zoom);

  return 360 * map.getSize().x / Math.max(1, worldPixelWidth);
}

function adaptiveInsetScale(map, options, width, height) {
  const bounds = map.getBounds();
  const center = map.getCenter();

  const centerLon = normalizeLongitude(center.lng);
  const centerLat = clamp(
    center.lat,
    -WEB_MERCATOR_MAX_LAT,
    WEB_MERCATOR_MAX_LAT,
  );

  const visibleLonSpan = Math.min(
    360,
    Math.max(.0001, visibleLongitudeSpan(map)),
  );

  const visibleYSpan = Math.max(
    .000001,
    mercatorY(bounds.getNorth()) -
      mercatorY(bounds.getSouth()),
  );

  const desiredLonSpan = Math.min(
    360,
    Math.max(
      options.minLongitudeSpan,
      visibleLonSpan * options.contextScale,
    ),
  );

  const halfMinLat = options.minLatitudeSpan / 2;
  const minimumYSpan = Math.max(
    .000001,
    mercatorY(centerLat + halfMinLat) -
      mercatorY(centerLat - halfMinLat),
  );

  const fullWorldSpan = 2 * Math.PI;

  const desiredYSpan = Math.min(
    fullWorldSpan,
    Math.max(
      minimumYSpan,
      visibleYSpan * options.contextScale,
    ),
  );

  const availableWidth = Math.max(
    1,
    width - 2 * options.padding,
  );
  const availableHeight = Math.max(
    1,
    height - 2 * options.padding,
  );

  const desiredLonRadians =
    desiredLonSpan * Math.PI / 180;

  const desiredScale = Math.min(
    availableWidth / Math.max(desiredLonRadians, 1e-9),
    availableHeight / Math.max(desiredYSpan, 1e-9),
  );

  // Maximum zoom-out = cover the complete inset box.
  const worldCoverScale = Math.max(
    availableWidth / fullWorldSpan,
    availableHeight / fullWorldSpan,
  );

  return {
    centerLon,
    centerLat,
    scale:Math.max(worldCoverScale, desiredScale),
  };
}

export async function createGlobalInset(map) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...(CONFIG.insetMap || {}),
  };

  if (options.enabled === false) return null;

  await ensureLibraries();

  const {d3, topojson} = window;
  const control = L.control({position:options.position});

  let container;
  let svg;
  let clipRect;
  let worldStrip;
  let viewport;
  let resizeObserver = null;

  let landFeature = null;
  let countryBorderMesh = null;
  let graticuleGeometry = null;

  let projection = null;
  let path = null;
  let worldWidth = 0;
  let worldTop = 0;
  let worldBottom = 0;

  let renderedScale = null;
  let renderedWidth = null;
  let renderedHeight = null;

  let rafId = null;
  let geometryDirty = true;

  const worldCopies = [];

  function clearWorldCopies() {
    for (const group of worldCopies) group.remove();
    worldCopies.length = 0;
  }

  function createWorldCopy(index, colors) {
    const group = svgElement('g', {
      class:'global-inset-world-copy',
      transform:`translate(${index * worldWidth},0)`,
    });

    group.append(
      svgElement('path', {
        class:'global-inset-graticule',
        fill:'none',
        stroke:colors.border,
        d:path(graticuleGeometry) || '',
      }),
      svgElement('path', {
        class:'global-inset-land',
        fill:colors.land,
        d:path(landFeature) || '',
      }),
      svgElement('path', {
        class:'global-inset-country-borders',
        fill:'none',
        stroke:colors.countries,
        d:path(countryBorderMesh) || '',
      }),
    );

    worldStrip.append(group);
    worldCopies.push(group);
  }

  function rebuildGeometry(frame, width, height) {
    const colors = themeColors();

    projection = d3.geoMercator()
      .center([0, 0])
      .rotate([0, 0])
      .scale(frame.scale)
      .translate([0, 0])
      .precision(.2);

    path = d3.geoPath(projection);

    worldWidth = 2 * Math.PI * frame.scale;
    worldTop = projection([0, WEB_MERCATOR_MAX_LAT])[1];
    worldBottom = projection([0, -WEB_MERCATOR_MAX_LAT])[1];

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    clipRect.setAttribute('width', width);
    clipRect.setAttribute('height', height);

    clearWorldCopies();

    // Fixed neighboring copies provide continuous horizontal coverage.
    // Because the strip translation is wrapped modulo one world width, these
    // copies never need to be rebuilt or repositioned while panning.
    for (let index = -2; index <= 2; index += 1) {
      createWorldCopy(index, colors);
    }

    renderedScale = frame.scale;
    renderedWidth = width;
    renderedHeight = height;
    geometryDirty = false;
  }

  function updateTransforms() {
    if (
      !container ||
      !svg ||
      !landFeature
    ) {
      return;
    }

    const width = container.clientWidth || options.width;
    const height = container.clientHeight || options.height;
    const frame = adaptiveInsetScale(
      map,
      options,
      width,
      height,
    );

    const scaleChanged =
      renderedScale == null ||
      Math.abs(frame.scale - renderedScale) > 1e-6;

    if (
      geometryDirty ||
      scaleChanged ||
      renderedWidth !== width ||
      renderedHeight !== height
    ) {
      rebuildGeometry(frame, width, height);
    }

    const projectedCenter = projection([
      frame.centerLon,
      frame.centerLat,
    ]);

    const translateX =
      width / 2 - projectedCenter[0];

    let translateY =
      height / 2 - projectedCenter[1];

    const minTranslateY =
      height - worldBottom;
    const maxTranslateY =
      -worldTop;

    translateY = clamp(
      translateY,
      minTranslateY,
      maxTranslateY,
    );

    // Move the already-rendered strip only. The world copies themselves stay
    // at stable multiples of worldWidth. This avoids the double-shift that
    // could move all SVG geometry outside the clip box and leave the inset
    // blank.
    //
    // Reduce the horizontal translation modulo one world width so the same
    // fixed set of copies can provide continuous east/west coverage forever.
    const wrappedTranslateX =
      ((translateX + worldWidth / 2) % worldWidth + worldWidth) %
        worldWidth -
      worldWidth / 2;

    worldStrip.setAttribute(
      'transform',
      `translate(${wrappedTranslateX},${translateY})`,
    );

    // Keep the red viewport independent of longitude wrapping. Its horizontal
    // size is derived from Leaflet's projected viewport/world size, so the
    // footprint remains correct across the antimeridian and when the main map
    // becomes wider than one complete world at minimum zoom.
    const bounds = map.getBounds();

    const north = clamp(
      bounds.getNorth(),
      -WEB_MERCATOR_MAX_LAT,
      WEB_MERCATOR_MAX_LAT,
    );
    const south = clamp(
      bounds.getSouth(),
      -WEB_MERCATOR_MAX_LAT,
      WEB_MERCATOR_MAX_LAT,
    );

    const latitudeToScreenY = (lat) => {
      const [, y] = projection([0, lat]);
      return y + translateY;
    };

    // Horizontal footprint of the main map in inset pixels. Using the
    // projected viewport span avoids the old ±180° / ±360° wrap ambiguity.
    const mainLonSpan = visibleLongitudeSpan(map);
    const halfViewportWidth =
      mainLonSpan * Math.PI / 180 * renderedScale / 2;

    let viewportLeft = width / 2 - halfViewportWidth;
    let viewportRight = width / 2 + halfViewportWidth;

    // Once the main viewport spans a complete world (or more), every
    // longitude represented by this periodic inset is visible. Represent that
    // cleanly as the complete inset width instead of choosing an arbitrary
    // neighboring world copy.
    if (mainLonSpan >= 360) {
      viewportLeft = 0;
      viewportRight = width;
    }

    const points = [
      [viewportLeft, latitudeToScreenY(north)],
      [viewportRight, latitudeToScreenY(north)],
      [viewportRight, latitudeToScreenY(south)],
      [viewportLeft, latitudeToScreenY(south)],
    ]
      .map(([x, y]) => `${x},${y}`)
      .join(' ');

    const colors = themeColors();

    // Always show the exact current viewport rectangle. At close zoom levels
    // the rectangle can become very small, so only its styling changes:
    // increase the outline width and remove the fill.
    const emphasized =
      map.getZoom() >= options.viewportEmphasisZoom;

    viewport.setAttribute('points', points);

    // Use inline SVG styles rather than presentation attributes. A CSS
    // stroke-width rule has higher precedence than an SVG presentation
    // attribute and could therefore make the configurable widths appear to
    // have no effect.
    viewport.style.stroke = colors.accent;
    viewport.style.strokeWidth =
      `${emphasized
        ? options.viewportEmphasisStrokeWidth
        : options.viewportNormalStrokeWidth}px`;

    if (emphasized) {
      viewport.style.fill = 'none';
      viewport.style.fillOpacity = '0';
    } else {
      viewport.style.fill = colors.accent;
      viewport.style.fillOpacity = '.10';
    }
  }

  function scheduleTransformUpdate() {
    if (rafId != null) return;

    rafId = requestAnimationFrame(() => {
      rafId = null;
      updateTransforms();
    });
  }

  function scheduleGeometryUpdate() {
    geometryDirty = true;
    scheduleTransformUpdate();
  }

  async function loadBasemap() {
    const [landResponse, countriesResponse] = await Promise.all([
      fetch(options.landUrl),
      fetch(options.countriesUrl),
    ]);

    if (!landResponse.ok || !countriesResponse.ok) {
      throw new Error('Inset basemap data could not be loaded.');
    }

    const [landTopology, countriesTopology] = await Promise.all([
      landResponse.json(),
      countriesResponse.json(),
    ]);

    landFeature = topojson.feature(
      landTopology,
      landTopology.objects.land,
    );

    countryBorderMesh = topojson.mesh(
      countriesTopology,
      countriesTopology.objects.countries,
      (a, b) => a !== b,
    );

    graticuleGeometry = d3.geoGraticule10();

    scheduleGeometryUpdate();
  }

  control.onAdd = () => {
    container = L.DomUtil.create(
      'div',
      'leaflet-control global-inset',
    );

    container.style.setProperty(
      '--global-inset-width',
      `${options.width}px`,
    );
    container.style.setProperty(
      '--global-inset-height',
      `${options.height}px`,
    );

    container.setAttribute('role', 'img');
    container.setAttribute(
      'aria-label',
      'Global overview map showing the current map extent',
    );

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    svg = svgElement('svg', {
      class:'global-inset-svg',
      'aria-hidden':'true',
    });

    const defs = svgElement('defs');
    const clipPath = svgElement(
      'clipPath',
      {id:'global-inset-clip'},
    );

    clipRect = svgElement('rect', {
      x:0,
      y:0,
    });

    clipPath.append(clipRect);
    defs.append(clipPath);

    const clippedGroup = svgElement('g', {
      'clip-path':'url(#global-inset-clip)',
    });

    worldStrip = svgElement('g', {
      class:'global-inset-world-strip',
    });

    viewport = svgElement('polygon', {
      class:'global-inset-viewport',
    });

    clippedGroup.append(
      worldStrip,
      viewport,
    );
    svg.append(defs, clippedGroup);
    container.append(svg);

    resizeObserver = new ResizeObserver(
      scheduleGeometryUpdate,
    );
    resizeObserver.observe(container);

    // Panning: transform-only update, throttled to one animation frame.
    map.on('move', scheduleTransformUpdate);

    // Zoom/resize can change scale and therefore rebuild paths.
    map.on('zoomend resize', scheduleGeometryUpdate);

    void loadBasemap().catch((error) => {
      console.error(error);
      container.classList.add('global-inset--error');
    });

    return container;
  };

  control.onRemove = () => {
    map.off('move', scheduleTransformUpdate);
    map.off('zoomend resize', scheduleGeometryUpdate);

    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    resizeObserver?.disconnect();
  };

  control.addTo(map);

  return {
    control,
    render:scheduleGeometryUpdate,
    remove:() => control.remove(),
  };
}
