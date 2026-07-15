"""SWOT orbit-based observation-frequency layer generation.

The mean repeat interval from the 21-day science orbit is 21 / N days,
where N is the number of swath overflights covering a location during one
orbit cycle. The swath polygons are downloaded once and cached locally.
"""
from __future__ import annotations

import logging
import math
import os
import ssl
import zipfile
from functools import lru_cache
from pathlib import Path
from tempfile import NamedTemporaryFile

import certifi
import httpx
import shapefile
from shapely.geometry import Point, box, shape
from shapely.strtree import STRtree

LOGGER = logging.getLogger('swot.frequency')
SWATH_URL = (
    'https://www.aviso.altimetry.fr/fileadmin/documents/missions/Swot/'
    'swot_science_hr_Aug2021-v05_shapefile_swath.zip'
)
ORBIT_PERIOD_DAYS = 21.0


class OrbitSwathIndex:
    """Spatial index of SWOT science-orbit swath polygons."""

    def __init__(self, data_dir: Path, verify: ssl.SSLContext | bool):
        self.data_dir = data_dir
        self.verify = verify
        self._geometries = None
        self._tree = None

    def _download(self, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        LOGGER.info('Downloading SWOT orbit swaths from %s', SWATH_URL)
        with httpx.Client(
            timeout=httpx.Timeout(180.0, connect=30.0),
            follow_redirects=True,
            verify=self.verify,
            trust_env=True,
            headers={'User-Agent': 'SWOT-Water-Explorer/1.0'},
        ) as client:
            response = client.get(SWATH_URL)
            response.raise_for_status()
            with NamedTemporaryFile(
                dir=destination.parent,
                suffix='.zip.tmp',
                delete=False,
            ) as temporary:
                temporary.write(response.content)
                temporary_path = Path(temporary.name)
        temporary_path.replace(destination)

    def _ensure_shapefile(self) -> Path:
        orbit_dir = self.data_dir / 'orbit'
        matches = list(orbit_dir.rglob('*swath.shp'))
        if matches:
            return matches[0]

        archive = orbit_dir / 'swot_science_orbit_swath.zip'
        if not archive.exists():
            self._download(archive)
        extract_dir = orbit_dir / 'swath'
        extract_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as zip_file:
            zip_file.extractall(extract_dir)
        matches = list(extract_dir.rglob('*swath.shp'))
        if not matches:
            raise RuntimeError('The orbit archive did not contain a swath shapefile.')
        return matches[0]

    def load(self) -> None:
        """Load the swath polygons and construct an STRtree once."""
        if self._tree is not None:
            return
        shp_path = self._ensure_shapefile()
        reader = shapefile.Reader(str(shp_path))
        geometries = [shape(item.__geo_interface__) for item in reader.shapes()]
        self._geometries = geometries
        self._tree = STRtree(geometries)
        LOGGER.info('Loaded %d SWOT swath polygons.', len(geometries))

    def overflight_count(self, longitude: float, latitude: float) -> int:
        """Return the number of science-orbit swaths covering a point."""
        self.load()
        point = Point(longitude, latitude)
        matches = self._tree.query(point)
        count = 0
        for match in matches:
            geometry = (
                self._geometries[int(match)]
                if hasattr(match, '__index__')
                else match
            )
            if geometry.covers(point):
                count += 1
        return count


@lru_cache(maxsize=128)
def build_frequency_geojson(
    index: OrbitSwathIndex,
    west: float,
    south: float,
    east: float,
    north: float,
    cell_size: float,
) -> dict:
    """Build a gridded GeoJSON frequency layer for one map viewport."""
    if east <= west or north <= south:
        return {'type': 'FeatureCollection', 'features': []}

    columns = max(1, math.ceil((east - west) / cell_size))
    rows = max(1, math.ceil((north - south) / cell_size))
    if columns * rows > 3000:
        cell_size *= math.sqrt((columns * rows) / 3000)

    features = []
    y = south
    while y < north:
        y2 = min(y + cell_size, north)
        x = west
        while x < east:
            x2 = min(x + cell_size, east)
            center_x = (x + x2) / 2
            center_y = (y + y2) / 2
            overflights = index.overflight_count(center_x, center_y)
            if overflights:
                mean_days = ORBIT_PERIOD_DAYS / overflights
                features.append({
                    'type': 'Feature',
                    'geometry': box(x, y, x2, y2).__geo_interface__,
                    'properties': {
                        'mean_days': round(mean_days, 2),
                        'overflights_per_orbit': overflights,
                    },
                })
            x = x2
        y = y2

    return {
        'type': 'FeatureCollection',
        'features': features,
        'properties': {
            'orbit_period_days': ORBIT_PERIOD_DAYS,
            'cell_size_degrees': round(cell_size, 4),
            'method': 'cell-centre swath overlap count',
        },
    }


def default_ssl_context() -> ssl.SSLContext | bool:
    """Return the same configurable TLS verifier as the proxy server."""
    if os.getenv('SWOT_DISABLE_SSL_VERIFY') == '1':
        return False
    ca_bundle = os.getenv('SWOT_CA_BUNDLE', certifi.where())
    return ssl.create_default_context(cafile=ca_bundle)
