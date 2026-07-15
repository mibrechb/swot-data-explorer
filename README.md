# SWOT Water Explorer

This repository contains a responsive data explorer based on Leaflet and Plotly for data from the Surface Water and Ocean Topography (SWOT) mission. 

A mapview allows to display lake, river reach and river node geometries from the SWOT Prior Lake and SWOT SWORD River Dataset served by THEIA Hydroweb GeoServer. Selecting features allows to load and plot corresponding SWOT Level 2 River and Lake Single-Pass data server over the Hydrocron API.

Additional features include an observation frequency layer, a geosearch integration, line fitting based on LOWESS as well as download capabilities for raw data and figures.

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