from pathlib import Path
import json

import numpy as np
import xarray as xr


directory = Path(r'E:\RS\SWOT SWORD SOS')
path_out = Path(
    'reach-ids_SWOT_L4_HR_DAWG_SOS_DISCHARGE_V3.json'
)

reach_ids = set()

for path in directory.glob('*.nc'):
    try:
        with xr.open_dataset(
            path,
            group='consensus',
            decode_cf=False,
            mask_and_scale=False,
        ) as ds_consensus:
            q = ds_consensus['consensus_q']

            consensus_q = q.values
            valid_min = q.attrs.get('valid_min', 0)
            valid_max = q.attrs.get('valid_max', np.inf)

    except (OSError, KeyError):
        continue

    with xr.open_dataset(
        path,
        group='reaches',
        drop_variables=['river_name', 'time'],
    ) as ds_reaches:
        ids = ds_reaches['reach_id'].values

    n_valid = 0

    for reach_id, values in zip(ids, consensus_q):
        values = np.asarray(values, dtype=float)

        valid = (
            np.isfinite(values)
            & (values >= valid_min)
            & (values <= valid_max)
        )

        if valid.any():
            reach_ids.add(int(reach_id))
            n_valid += 1

    print(
        f'{path.name}: '
        f'{n_valid:,}/{len(ids):,} reaches with discharge'
    )

reach_ids = sorted(reach_ids)

with path_out.open('w', encoding='utf-8') as file:
    json.dump(reach_ids, file)

print(f'Total: {len(reach_ids):,} unique reaches with discharge. Identifiers written to {path_out}.')