# SWOT orbit vectors

Place the original science-orbit shapefiles anywhere on disk and run the
preprocessing script once. The generated web layers are written to
`processed/`.

```bash
python preprocess_orbit_vectors.py \
  --swath path/to/swot_science_hr_2.0s_4.0s_Aug2021-v5_swath.shp \
  --nadir path/to/swot_science_hr_2.0s_4.0s_Aug2021-v5_nadir.shp
```

Generated files:

- `processed/swot_overlaps.geojson`: unique overlap polygons with `n_overlaps`
- `processed/swot_nadir.geojson`: nadir lines with `ID_SEG`, `ID_PASS`, and `START_TIME`

Use `--bbox WEST SOUTH EAST NORTH` only when intentionally building a regional
subset. Omit it for the complete science orbit.
