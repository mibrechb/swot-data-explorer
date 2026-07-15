# SWOT Water Explorer

Responsive Leaflet + Plotly explorer for SWOT lakes, river reaches, and nodes.

## Web-hosting architecture

The production frontend is fully static and can be hosted with GitHub Pages.

```text
GitHub Pages
  ├── index.html and assets/
  └── data/orbit/processed/*.fgb
       └── direct browser FlatGeobuf viewport queries

Cloudflare Worker
  ├── /api/wfs       -> Hydroweb GeoServer
  └── /api/hydrocron -> PO.DAAC Hydrocron
```

Hydroweb currently returns WFS data without an `Access-Control-Allow-Origin`
header, so browser `fetch()` calls from GitHub Pages are blocked by CORS. The
Worker only forwards the two upstream APIs and adds the required CORS response
headers. It performs no geospatial processing.

The orbit layers do not use the Worker. The browser reads the spatially indexed
FlatGeobuf files directly from the same GitHub Pages origin, using HTTP Range
requests and the current Leaflet bounding box.

## Local development

Install dependencies and start the bundled FastAPI server:

```bash
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8000 --reload
```

Open `http://127.0.0.1:8000`. With `apiBaseUrl: ''`, WFS and Hydrocron use the
local FastAPI proxy. Orbit FlatGeobuf is read directly as a static file in both
local and production modes.

## Generate the orbit files

The repository must contain these generated files:

```text
data/orbit/processed/swot_overlaps.fgb
data/orbit/processed/swot_nadir.fgb
```

Generate them once with:

```bat
python preprocess_orbit_vectors.py ^
  --swath E:\path\to\swot_swath.shp ^
  --nadir E:\path\to\swot_nadir.shp
```

Do not store these files with Git LFS when publishing through GitHub Pages;
commit the actual files so Pages can serve byte-range requests.

## Deploy the frontend to GitHub Pages

1. Commit the site, including `.nojekyll` and both `.fgb` files.
2. In the repository settings, enable Pages from the branch/root containing
   `index.html`.
3. Deploy the Worker as described below.
4. Set `assets/config.js`:

```js
apiBaseUrl: 'https://your-worker.example.workers.dev',
```

The FlatGeobuf paths stay relative and require no production API URL.

## Deploy the Cloudflare Worker

1. Copy `wrangler.toml.example` to `wrangler.toml`.
2. In `worker.js`, replace `https://YOUR_USERNAME.github.io` with the exact
   Pages origin. For a project site this is still the origin only, without the
   repository path.
3. Deploy:

```bash
npx wrangler deploy
```

4. Put the resulting Worker origin into `assets/config.js` and redeploy Pages.

The Worker accepts only the known Hydroweb layers and Hydrocron feature types;
it is not a general-purpose open proxy.

## Configuration

- `assets/config.js`: Worker origin, orbit file paths, initial map and zooms.
- `assets/fields.js`: feature types, variables, labels, units, and metadata.
- `assets/styles.css`: layout and visual design.
- `worker.js`: production WFS/Hydrocron CORS proxy.
- `server.py`: local development server and proxy.

## Responsive interface

- Desktop and landscape: the details panel slides in from the right.
- Mobile and portrait: the details view covers the page and provides a back button.
- The selected geometry remains highlighted until another feature is selected or the feature type changes.

## Configuration

- `assets/config.js`: API base, initial map location, zoom thresholds, dates.
- `assets/fields.js`: feature types, variables, labels, units, metadata, smoothing defaults.
- `assets/styles.css`: layout and visual design.

## Windows/Conda TLS troubleshooting

The proxy uses the `certifi` CA bundle explicitly. If a company VPN or TLS-inspecting
proxy uses a private root certificate, export that certificate as PEM and set:

```bat
set SWOT_CA_BUNDLE=E:\path\to\corporate-ca-bundle.pem
python -m uvicorn server:app --host 127.0.0.1 --port 8000 --reload
```

For a temporary diagnostic only, certificate verification can be disabled:

```bat
set SWOT_DISABLE_SSL_VERIFY=1
python -m uvicorn server:app --host 127.0.0.1 --port 8000 --reload
```

Do not deploy with `SWOT_DISABLE_SSL_VERIFY=1`.

### Timestamp validation

Hydrocron rows are plotted only when `time_str` is a valid string timestamp inside the configured observation window. Empty values, `no_data`, numeric epoch-like values, sentinel values, dates before `CONFIG.startTime`, and future dates are ignored. This prevents malformed timestamps from appearing near 1970.

## v12 selection fix

The high-z-index selected-feature Leaflet pane has `pointer-events: none` so its full-map SVG renderer cannot block clicks on other water geometries after a selection is made or cleared.


## Hydrocron product versions

The application configuration uses the Version D Hydrocron collections:

- `SWOT_L2_HR_LakeSP_D` for lakes
- `SWOT_L2_HR_RiverSP_D` for reaches and nodes

The `version=2.0.0` parameter in WFS requests is the OGC WFS protocol version, not a SWOT data-product version.


## Version 15 UI adjustments

- Restored the compact top-left brand block with linked SOS-WATER logo, title, and subtitle.
- Only the product code `SWOT_L2_HR_RiverSP_D` is linked in the subtitle.
- Orbit overlap polygons now use white outlines for clearer separation.


## World overview inset

On landscape screens at least 900 px wide, a compact world overview is shown in the lower-left. It uses a subdued label-free basemap, tracks the main-map extent with a red rectangle, and can be clicked to recenter the main map. It is hidden on portrait and mobile layouts.


## Version 19

- Initial y-axis limits use only standard-quality Observation points.
- Y-axis padding is based on the observed span, not the absolute variable magnitude.
- Suspect, rejected, and LOWESS-outlier markers are smaller; suspect uses an open diamond.
- The overview uses one ROI representation at a time: rectangle below zoom 10, point from zoom 10.
- The geocoder is positioned to the right of the overview on wide landscape screens.
- The sliding panel remains light grey while the variable/plot/smoothing card is white.


## Version 21 interface updates

- Renamed the variable section to **Variable selection**.
- Added a matching **Smoothing settings** heading.
- Replaced the panel download, back, and close symbols with the supplied SVG icons.
- Changed the Hydrocron loading message to **Loading data from Hydrocron…**.


## Version 22

- Added reach consensus and gauge-constrained consensus discharge variables with discharge-specific uncertainty and quality flags.
- Enabled LOWESS by default for both discharge variables.
- Initial quality-aware y-ranges include accepted and suspect observations.
- Updated accepted and suspect marker styling.


## Version 23

- Masks Hydrocron numeric fill values `-999`, `-999.0`, `-999999999999`, and `-999999999999.0`.
- Prevents JavaScript `Number(null)` from turning missing observations into plotted zeros.
- Displays missing uncertainty or quality values as `N/A` in Plotly hover labels.


## Version 25 changes

- Observation-frequency classes now show mean revisit interval using the 20.86-day science-orbit repeat cycle.
- Node markers use a larger transparent interaction target so compact nodes remain reliably clickable.


## Hydrocron units

Do not add `{field}_unit` names to the Hydrocron `fields` request. Hydrocron automatically returns unit columns for requested fields when units are available. The frontend reads those automatically returned columns for labels, axes, metadata, and hover text.
