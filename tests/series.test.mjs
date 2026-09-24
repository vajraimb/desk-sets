import test from 'node:test';
import assert from 'node:assert/strict';
import { rollingMean, rollingStd, previousHigh, zScore, indicatorsFor, maxDrawdown, buyAndHold, C, H } from '../dist/engine/series.js';
import { createRng } from '../dist/engine/rng.js';

function syntheticCandles(n, seed = 3) {
  const rng = createRng(seed);
  const out = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o * (1 + rng.gauss() * 0.01);
    const h = Math.max(o, c) * (1 + Math.abs(rng.gauss()) * 0.004);
    const l = Math.min(o, c) * (1 - Math.abs(rng.gauss()) * 0.004);
    out.push([1_700_000_000 + i * 3600, o, h, l, c, 1000]);
    px = c;
  }
  return out;
}

test('rollingMean matches a naive window average', () => {
  const v = [1, 2, 3, 4, 5, 6];
  const m = rollingMean(v, 3);
  assert.ok(Number.isNaN(m[0]) && Number.isNaN(m[1]));
  assert.equal(m[2], 2);
  assert.equal(m[5], 5);
});

test('rollingStd is population std over the window', () => {
  const v = [2, 4, 4, 4, 5, 5, 7, 9];
  const s = rollingStd(v, 8);
  assert.ok(Math.abs(s[7] - 2) < 1e-12);
});

test('previousHigh excludes the current bar', () => {
  const highs = [1, 5, 2, 3, 10, 4];
  const ph = previousHigh(highs, 3);
  assert.ok(Number.isNaN(ph[2]));
  assert.equal(ph[3], 5); // bars 0..2
  assert.equal(ph[4], 5); // bars 1..3, the 10 at index 4 is not visible yet
  assert.equal(ph[5], 10);
});

test('indicators are causal: changing a future bar leaves earlier values untouched', () => {
  const a = syntheticCandles(300);
  const b = a.map((c) => [...c]);
  const k = 180;
  for (let j = k + 1; j < b.length; j++) {
    b[j][C] *= 1.5;
    b[j][H] *= 1.5;
  }
  const ia = indicatorsFor(a, 40);
  const ib = indicatorsFor(b, 40);
  for (let j = 0; j <= k; j++) {
    for (const key of ['mean', 'std', 'z', 'prevHigh']) {
      const x = ia[key][j], y = ib[key][j];
      assert.ok((Number.isNaN(x) && Number.isNaN(y)) || x === y, `${key}[${j}] leaked the future`);
    }
  }
  // and the future did actually change
  assert.notEqual(ia.mean[k + 40], ib.mean[k + 40]);
});

test('zScore is NaN where std is zero', () => {
  const closes = [5, 5, 5, 5];
  const mean = rollingMean(closes, 2);
  const std = rollingStd(closes, 2);
  const z = zScore(closes, mean, std);
  assert.ok(z.every((v) => Number.isNaN(v)));
});

test('maxDrawdown measures the worst peak-to-trough', () => {
  assert.equal(maxDrawdown([100, 120, 90, 130, 65, 140]), 0.5);
  assert.equal(maxDrawdown([1, 2, 3]), 0);
});

test('buyAndHold enters at the first open and exits at the last close', () => {
  const candles = [
    [0, 100, 101, 99, 100, 1],
    [1, 100, 110, 100, 110, 1],
    [2, 110, 112, 100, 121, 1],
  ];
  const bh = buyAndHold(candles, 0, 3);
  assert.ok(Math.abs(bh.ret - 0.21) < 1e-12);
  assert.equal(bh.maxDD, 0);
});
