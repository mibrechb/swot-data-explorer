function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function weightedLinear(x, y, weights, x0) {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;

  for (let i = 0; i < x.length; i += 1) {
    const w = weights[i];
    sw += w;
    sx += w * x[i];
    sy += w * y[i];
    sxx += w * x[i] * x[i];
    sxy += w * x[i] * y[i];
  }

  const denom = sw * sxx - sx * sx;

  if (!sw) return NaN;
  if (Math.abs(denom) < 1e-12) return sy / sw;

  const b = (sw * sxy - sx * sy) / denom;
  return (sy - b * sx) / sw + b * x0;
}

export function lowess(x, y, fraction = 0.25) {
  const n = x.length;

  if (!n) return [];
  if (n === 1) return [y[0]];

  const span = Math.min(
    n,
    Math.max(3, Math.ceil(n * fraction)),
  );

  return x.map((x0) => {
    const distances = x.map(
      (value) => Math.abs(value - x0),
    );

    const radius = [...distances]
      .sort((a, b) => a - b)[span - 1] || 1;

    const weights = distances.map((distance) => {
      const u = Math.min(1, distance / radius);
      return Math.pow(
        1 - Math.pow(u, 3),
        3,
      );
    });

    return weightedLinear(
      x,
      y,
      weights,
      x0,
    );
  });
}

export function robustLowess(
  x,
  y,
  fraction = 0.25,
  threshold = 4,
  iterations = 3,
) {
  const n = x.length;
  const outliers = Array(n).fill(false);
  let retainedIndexes = Array.from(
    {length: n},
    (_, index) => index,
  );

  if (n < 4) {
    return {
      fit: [...y],
      outliers,
      retainedIndexes,
    };
  }

  const maxIterations = Math.max(
    1,
    Math.floor(iterations),
  );

  for (
    let iteration = 0;
    iteration < maxIterations;
    iteration += 1
  ) {
    // Robust fitting is performed ONLY on observations that have not already
    // been rejected. Previously, zero-weight points still contributed their
    // x positions to the LOWESS neighbourhood radius.
    if (retainedIndexes.length < 4) break;

    const activeX = retainedIndexes.map(
      (index) => x[index],
    );
    const activeY = retainedIndexes.map(
      (index) => y[index],
    );

    const fit = lowess(
      activeX,
      activeY,
      fraction,
    );

    const residuals = activeY.map(
      (value, index) => value - fit[index],
    );

    const center = median(residuals);
    const mad = median(
      residuals.map(
        (residual) => Math.abs(residual - center),
      ),
    );
    const scale = 1.4826 * mad;

    if (!Number.isFinite(scale) || scale <= 0) break;

    const newlyRejected = retainedIndexes.filter(
      (_, activeIndex) =>
        Math.abs(residuals[activeIndex] - center) >
        threshold * scale,
    );

    if (!newlyRejected.length) break;

    const rejectedSet = new Set(newlyRejected);

    for (const index of newlyRejected) {
      outliers[index] = true;
    }

    retainedIndexes = retainedIndexes.filter(
      (index) => !rejectedSet.has(index),
    );
  }

  const retainedX = retainedIndexes.map(
    (index) => x[index],
  );
  const retainedY = retainedIndexes.map(
    (index) => y[index],
  );

  return {
    // fit corresponds only to retainedIndexes. Outliers are deliberately not
    // assigned a fitted point in the final robust curve.
    fit: lowess(
      retainedX,
      retainedY,
      fraction,
    ),
    outliers,
    retainedIndexes,
  };
}
