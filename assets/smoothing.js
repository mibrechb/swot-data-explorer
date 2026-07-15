function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function weightedLinear(x, y, weights, x0) {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) {
    const w = weights[i]; sw += w; sx += w * x[i]; sy += w * y[i]; sxx += w * x[i] * x[i]; sxy += w * x[i] * y[i];
  }
  const denom = sw * sxx - sx * sx;
  if (!sw) return NaN;
  if (Math.abs(denom) < 1e-12) return sy / sw;
  const b = (sw * sxy - sx * sy) / denom;
  return (sy - b * sx) / sw + b * x0;
}

export function lowess(x, y, fraction = 0.25, robustWeights = null) {
  const n = x.length;
  const span = Math.max(3, Math.ceil(n * fraction));
  return x.map((x0) => {
    const distances = x.map((value) => Math.abs(value - x0));
    const radius = [...distances].sort((a, b) => a - b)[Math.min(span - 1, n - 1)] || 1;
    const weights = distances.map((d, i) => {
      const u = Math.min(1, d / radius);
      const tri = Math.pow(1 - Math.pow(u, 3), 3);
      return tri * (robustWeights ? robustWeights[i] : 1);
    });
    return weightedLinear(x, y, weights, x0);
  });
}

export function robustLowess(x, y, fraction = 0.25, threshold = 4) {
  if (x.length < 4) return {fit: [...y], outliers: y.map(() => false)};
  const initial = lowess(x, y, fraction);
  const residuals = y.map((v, i) => v - initial[i]);
  const center = median(residuals);
  const mad = median(residuals.map((r) => Math.abs(r - center))) || 0;
  const scale = 1.4826 * mad;
  const outliers = residuals.map((r) => scale > 0 && Math.abs(r - center) > threshold * scale);
  const robustWeights = outliers.map((flag) => flag ? 0 : 1);
  return {fit: lowess(x, y, fraction, robustWeights), outliers};
}
