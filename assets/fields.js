export const FEATURE_CONFIG = {
  lake: {
    label: 'Lake',
    icon: './assets/icon_lake.svg',
    layer: 'swot_prior_lake_db',
    idCandidates: ['fid', 'lake_id'],
    feature: 'PriorLake',
    collection: 'SWOT_L2_HR_LakeSP_D',
    variables: ['wse', 'area_total', 'ds1_l', 'ds1_q', 'ds2_l', 'ds2_q'],
    defaultVariable: 'wse',
    smoothDefaults: ['wse', 'area_total', 'ds1_l', 'ds1_q', 'ds2_l', 'ds2_q'],
    qualityFields: [
      'quality_f', 'wse_u', 'area_tot_u',
      'ds1_l_u', 'ds1_q_u', 'ds2_l_u', 'ds2_q_u',
    ],
    metadata: [
      'lake_name', 'lake_id', 'p_ref_wse', 'p_ref_area',
      'p_date_t0', 'p_storage',
    ],
  },
  reach: {
    label: 'River reach',
    icon: './assets/icon_reach.svg',
    layer: 'swot_prior_river_db',
    idCandidates: ['reach_id', 'fid'],
    feature: 'Reach',
    collection: 'SWOT_L2_HR_RiverSP_D',
    variables: ['wse', 'width', 'slope'],
    defaultVariable: 'wse',
    smoothDefaults: ['wse', 'width'],
    metadata: ['reach_id', 'river_name', 'p_length', 'p_wse', 'p_width'],
  },
  node: {
    label: 'River node',
    icon: './assets/icon_node.svg',
    layer: 'REF_DATA:swot_prior_river_db_node',
    idCandidates: ['node_id', 'fid'],
    feature: 'Node',
    collection: 'SWOT_L2_HR_RiverSP_D',
    variables: ['wse'],
    defaultVariable: 'wse',
    smoothDefaults: ['wse'],
    metadata: ['node_id', 'reach_id', 'river_name', 'p_length', 'p_wse', 'p_width'],
  },
};

export const VARIABLE_META = {
  wse: ['Water Surface Elevation', 'm'],
  width: ['River Width', 'm'],
  slope: ['Water Surface Slope', 'm/km'],
  d_x_area: ['Area Change', 'm²'],
  area_total: ['Total Water Area', 'km²'],
  ds1_l: ['Direct storage change, lin. model', 'km³'],
  ds1_q: ['Direct storage change, quad. model', 'km³'],
  ds2_l: ['Incr. storage change, lin. model', 'km³'],
  ds2_q: ['Incr. storage change, quad. model', 'km³'],
};

export const META_LABELS = {
  lake_name: ['Lake name', ''],
  lake_id: ['Lake ID', ''],
  reach_id: ['Reach ID', ''],
  node_id: ['Node ID', ''],
  river_name: ['River name', ''],
  p_ref_wse: ['Prior water surface elevation', 'm'],
  p_ref_area: ['Prior area', 'km²'],
  p_date_t0: ['Storage-change reference date', ''],
  p_storage: ['Prior storage', 'km³'],
  p_length: ['Prior length', 'm'],
  p_wse: ['Prior water surface elevation', 'm'],
  p_width: ['Prior width', 'm'],
};

export function variableLabel(name) {
  const [label, unit] = VARIABLE_META[name] || [name.replaceAll('_', ' '), ''];
  return unit ? `${label} (${unit}; ${name})` : `${label} (${name})`;
}

export function variableUnit(name) {
  if (VARIABLE_META[name]) return VARIABLE_META[name][1];
  if (name.endsWith('_u')) {
    const baseName = name.slice(0, -2);
    return (VARIABLE_META[baseName] || ['', ''])[1];
  }
  return '';
}

