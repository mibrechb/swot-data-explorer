"""Read spatially indexed SWOT orbit vectors for one map viewport."""
from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
from shapely.geometry import box


class FlatGeobufViewportReader:
    """Read and clip only FlatGeobuf features intersecting a viewport."""

    def __init__(self, path: Path):
        self.path = path

    def query(
        self,
        west: float,
        south: float,
        east: float,
        north: float,
    ) -> dict:
        """Return a GeoJSON FeatureCollection for the requested WGS84 bbox."""
        if not self.path.exists():
            raise FileNotFoundError(
                f'Missing precomputed orbit layer: {self.path}. '
                'Run preprocess_orbit_vectors.py first.'
            )

        bounds = (west, south, east, north)
        gdf = gpd.read_file(
            self.path,
            bbox=bounds,
            engine='pyogrio',
            use_arrow=True,
        )
        if gdf.empty:
            return {'type': 'FeatureCollection', 'features': []}

        if gdf.crs is None:
            raise ValueError(f'{self.path} has no CRS.')
        if not gdf.crs.equals('EPSG:4326'):
            gdf = gdf.to_crs('EPSG:4326')

        viewport = box(*bounds)
        gdf = gdf.loc[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
        gdf.geometry = gdf.geometry.intersection(viewport)
        gdf = gdf.loc[~gdf.geometry.is_empty].copy()

        return json.loads(gdf.to_json(drop_id=True))


def orbit_readers(
    project_dir: Path,
) -> tuple[FlatGeobufViewportReader, FlatGeobufViewportReader]:
    """Return viewport readers for overlap polygons and nadir tracks."""
    orbit_dir = project_dir / 'data' / 'orbit' / 'processed'
    return (
        FlatGeobufViewportReader(orbit_dir / 'swot_overlaps.fgb'),
        FlatGeobufViewportReader(orbit_dir / 'swot_nadir.fgb'),
    )
