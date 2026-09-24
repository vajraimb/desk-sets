// Causal rolling statistics. Every value at index j is computed from bars 0..j only,
// so a signal read at the close of bar j can never see bar j+1.
//
// Candles are arrays: [unixSeconds, open, high, low, close, volume].
export const T = 0, O = 1, H = 2, L = 3, C = 4, V = 5;

export function rollingMean(values, n) {
  const out = new Float64Array(values.length).fill(NaN);
  let sum = 0;
  for (let j = 0; j < values.length; j++) {
    sum += values[j];
    if (j >= n) sum -= values[j - n];
    if (j >= n - 1) out[j] = sum / n;
  }
  return out;
}

export function rollingStd(values, n) {
  // Two-pass inside the window to stay numerically honest on long tapes.
  const out = new Float64Array(values.length).fill(NaN);
  for (let j = n - 1; j < values.length; j++) {
    let mean = 0;
    for (let k = j - n + 1; k <= j; k++) mean += values[k];
    mean /= n;
    let acc = 0;
    for (let k = j - n + 1; k <= j; k++) {
      const d = values[k] - mean;
      acc += d * d;
    }
    out[j] = Math.sqrt(acc / n);
  }
  return out;
}

// Highest high of the n bars *before* j (excludes bar j itself).
export function previousHigh(highs, n) {
  const out = new Float64Array(highs.length).fill(NaN);
  for (let j = n; j < highs.length; j++) {
    let m = -Infinity;
    for (let k = j - n; k < j; k++) if (highs[k] > m) m = highs[k];
    out[j] = m;
  }
  return out;
}

export function zScore(closes, mean, std) {
  const out = new Float64Array(closes.length).fill(NaN);
  for (let j = 0; j < closes.length; j++) {
    if (Number.isNaN(mean[j]) || !(std[j] > 0)) continue;
    out[j] = (closes[j] - mean[j]) / std[j];
  }
  return out;
}

const cache = new WeakMap();

/**
 * Indicator bundle for one lookback, memoised per candle array so that 96 genomes
 * sharing a lookback do not recompute the same series.
 */
export function indicatorsFor(candles, lookback) {
  let byLookback = cache.get(candles);
  if (!byLookback) {
    byLookback = new Map();
    cache.set(candles, byLookback);
  }
  let ind = byLookback.get(lookback);
  if (ind) return ind;

  const closes = new Float64Array(candles.length);
  const highs = new Float64Array(candles.length);
  for (let j = 0; j < candles.length; j++) {
    closes[j] = candles[j][C];
    highs[j] = candles[j][H];
  }
  const mean = rollingMean(closes, lookback);
  const std = rollingStd(closes, lookback);
  ind = {
    lookback,
    mean,
    std,
    z: zScore(closes, mean, std),
    prevHigh: previousHigh(highs, lookback),
  };
  byLookback.set(lookback, ind);
  return ind;
}

export function maxDrawdown(equity) {
  let peak = -Infinity;
  let worst = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = peak > 0 ? (peak - e) / peak : 0;
    if (dd > worst) worst = dd;
  }
  return worst;
}

export function buyAndHold(candles, start, end) {
  // Enter at the open of `start`, mark at every close, exit at the last close.
  if (end - start < 2) return { ret: 0, maxDD: 0 };
  const entry = candles[start][O];
  const equity = [];
  for (let j = start; j < end; j++) equity.push(candles[j][C] / entry);
  return { ret: candles[end - 1][C] / entry - 1, maxDD: maxDrawdown(equity) };
}
