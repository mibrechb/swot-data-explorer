"""Precompute spatially indexed SWOT orbit vectors as FlatGeobuf files.

The script converts the science-orbit swath and nadir inputs once. The web
application subsequently reads only features intersecting the current map
viewport by passing a bounding-box filter to GDAL/Pyogrio.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import geopandas as gpd
from shapely.ops import polygonize, unary_union


DEFAULT_OUTPUT_DIR = Path('data/orbit/processed')


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--swath',
        type=Path,
        required=True,
        help='Path to the SWOT swath vector file.',
    )
    parser.add_argument(
        '--nadir',
        type=Path,
        required=True,
        help='Path to the SWOT nadir vector file.',
    )
    parser.add_argument(
        '--output-dir',
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help='Directory for generated FlatGeobuf files.',
    )
    parser.add_argument(
        '--bbox',
        nargs=4,
        type=float,
        metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'),
        help='Optional one-time preprocessing subset in WGS84.',
    )
    return parser.parse_args()


def _read_wgs84(path: Path) -> gpd.GeoDataFrame:
    """Read a vector file and return it in geographic WGS84 coordinates."""
    gdf = gpd.read_file(path, engine='pyogrio')
    if gdf.crs is None:
        raise ValueError(f'{path} has no CRS.')
    return gdf.to_crs('EPSG:4326')


def _subset(
    gdf: gpd.GeoDataFrame,
    bbox: list[float] | None,
) -> gpd.GeoDataFrame:
    """Optionally limit preprocessing to one WGS84 bounding box."""
    if not bbox:
        return gdf
    west, south, east, north = bbox
    return gdf.cx[west:east, south:north].copy()


def build_overlap_polygons(swaths: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Polygonise swath boundaries and count covering swaths per polygon."""
    if swaths.empty:
        return gpd.GeoDataFrame(
            {'n_overlaps': []},
            geometry=[],
            crs='EPSG:4326',
        )

    boundaries = unary_union(swaths.geometry.boundary.to_list())
    polygons = list(polygonize(boundaries))
    cells = gpd.GeoDataFrame({'geometry': polygons}, crs=swaths.crs)
    cells = cells.loc[~cells.geometry.is_empty].copy()

    representative_points = gpd.GeoDataFrame(
        geometry=cells.geometry.representative_point(),
        index=cells.index,
        crs=cells.crs,
    )
    joined = gpd.sjoin(
        representative_points,
        swaths[['geometry']],
        how='left',
        predicate='within',
    )
    counts = joined.groupby(joined.index)['index_right'].count().astype('int16')
    cells['n_overlaps'] = counts.reindex(cells.index, fill_value=0)
    return cells.loc[
        cells['n_overlaps'] > 0,
        ['n_overlaps', 'geometry'],
    ].copy()


def prepare_nadir(nadir: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Keep the nadir attributes required by the web map."""
    required = ['ID_PASS', 'START_TIME']
    missing = [column for column in required if column not in nadir.columns]
    if missing:
        raise ValueError(f'Nadir file is missing columns: {missing}')

    optional = ['ID_SEG'] if 'ID_SEG' in nadir.columns else []
    output = nadir[optional + required + ['geometry']].copy()
    output['START_TIME'] = output['START_TIME'].astype('string')
    return output


def _write_flatgeobuf(gdf: gpd.GeoDataFrame, path: Path) -> None:
    """Write a FlatGeobuf file with its packed spatial index enabled."""
    if path.exists():
        path.unlink()
    gdf.to_file(
        path,
        driver='FlatGeobuf',
        engine='pyogrio',
        SPATIAL_INDEX='YES',
    )


def main() -> None:
    args = _parse_args()
    swaths = _subset(_read_wgs84(args.swath), args.bbox)
    nadir = _subset(_read_wgs84(args.nadir), args.bbox)

    overlaps = build_overlap_polygons(swaths)
    nadir_output = prepare_nadir(nadir)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    overlap_path = args.output_dir / 'swot_overlaps.fgb'
    nadir_path = args.output_dir / 'swot_nadir.fgb'

    _write_flatgeobuf(overlaps, overlap_path)
    _write_flatgeobuf(nadir_output, nadir_path)

    print(f'Wrote {len(overlaps):,} overlap polygons to {overlap_path}')
    print(f'Wrote {len(nadir_output):,} nadir tracks to {nadir_path}')


if __name__ == '__main__':
    main()
