import test from 'node:test';
import assert from 'node:assert/strict';
import { Evolution, fitnessOf, passesGate, gateReasons, GENES, DEFAULT_CONFIG } from '../dist/engine/evolution.js';
import { createRng } from '../dist/engine/rng.js';
import { FAMILIES } from '../dist/engine/bot.js';

function tape(n, seed) {
  const rng = createRng(seed);
  const out = [];
  let px = 50;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o * (1 + rng.gauss() * 0.01 + 0.0002);
    const h = Math.max(o, c) * (1 + Math.abs(rng.gauss()) * 0.004);
    const l = Math.min(o, c) * (1 - Math.abs(rng.gauss()) * 0.004);
    out.push([1_700_000_000 + i * 3600, o, h, l, c, 1000]);
    px = c;
  }
  return out;
}

const genomesOf = (evo) => evo.population.map((p) => [p.id, p.genome, p.fitness]);

test('seeded rng is deterministic and well distributed', () => {
  const a = createRng('42'), b = createRng('42'), c = createRng('43');
  const xs = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b.next()));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, () => c.next()));
  const r = createRng(1);
  let mean = 0;
  for (let i = 0; i < 20_000; i++) mean += r.next();
  assert.ok(Math.abs(mean / 20_000 - 0.5) < 0.01);
  for (let i = 0; i < 1000; i++) {
    const v = r.int(2, 8);
    assert.ok(v >= 2 && v <= 8 && Number.isInteger(v));
  }
});

test('same seed reproduces the same evolution, different seeds diverge', () => {
  const candles = tape(600, 9);
  const a = new Evolution(candles, { seed: 'alpha' });
  const b = new Evolution(candles, { seed: 'alpha' });
  const c = new Evolution(candles, { seed: 'beta' });
  for (let i = 0; i < 4; i++) { a.stepGeneration(); b.stepGeneration(); c.stepGeneration(); }
  assert.deepEqual(genomesOf(a), genomesOf(b));
  assert.deepEqual(a.history, b.history);
  assert.notDeepEqual(genomesOf(a), genomesOf(c));
});

test('population size is constant and every species keeps a foothold', () => {
  const candles = tape(600, 2);
  const evo = new Evolution(candles, { seed: 5 });
  for (let i = 0; i < 6; i++) {
    const step = evo.stepGeneration();
    assert.equal(evo.population.length, DEFAULT_CONFIG.population);
    assert.equal(step.births.length + step.survivors.length, DEFAULT_CONFIG.population);
    assert.equal(step.deaths.length + step.survivors.length, DEFAULT_CONFIG.population);
    const counts = evo.speciesCounts();
    assert.equal(counts.length, FAMILIES.length);
    for (const n of counts) assert.ok(n >= 1, `species died out: ${counts}`);
    const immigrants = step.births.filter((id) => evo.population.find((p) => p.id === id).origin === 'immigrant');
    assert.equal(immigrants.length, DEFAULT_CONFIG.immigrants);
  }
});

test('genes stay inside their ranges after crossover and mutation', () => {
  const candles = tape(700, 4);
  const evo = new Evolution(candles, { seed: 77 });
  for (let i = 0; i < 5; i++) evo.stepGeneration();
  for (const p of evo.population) {
    for (const gene of evo.geneRanges) {
      const v = p.genome[gene.key];
      assert.ok(v >= gene.min && v <= gene.max, `${gene.key}=${v} out of range`);
      if (gene.type === 'int' || gene.type === 'family') assert.ok(Number.isInteger(v));
    }
    assert.ok(p.genome.lookback <= evo.maxLookback);
  }
});

test('thin histories tighten the lookback ceiling', () => {
  const evo = new Evolution(tape(200, 1), { seed: 1 });
  assert.equal(evo.split, 140);
  assert.equal(evo.maxLookback, 35);
  const wide = new Evolution(tape(2400, 1), { seed: 1 });
  assert.equal(wide.maxLookback, 200);
});

test('elites and the leader survive selection', () => {
  const candles = tape(800, 8);
  const evo = new Evolution(candles, { seed: 3 });
  for (let i = 0; i < 3; i++) evo.stepGeneration();
  const before = [...evo.population].sort((a, b) => b.fitness - a.fitness);
  const leader = evo.leader;
  const step = evo.stepGeneration();
  for (const e of before.slice(0, DEFAULT_CONFIG.elites)) assert.ok(step.survivors.includes(e.id), `elite ${e.id} died`);
  if (leader) assert.ok(step.survivors.includes(leader.id), 'leader died');
});

test('fitness rewards return, punishes drawdown and too few trades', () => {
  const base = { ret: 0.2, maxDD: 0.1, trades: 10 };
  assert.ok(Math.abs(fitnessOf(base) - (0.2 - 0.06)) < 1e-12);
  assert.ok(fitnessOf({ ...base, trades: 1 }) < fitnessOf(base));
  assert.ok(fitnessOf({ ...base, maxDD: 0.3 }) < fitnessOf(base));
});

test('gate requires OOS return, drawdown, trade count and win rate', () => {
  const good = { ret: 0.05, maxDD: 0.04, trades: 6, winRate: 0.66 };
  assert.equal(passesGate(good), true);
  assert.equal(passesGate({ ...good, ret: 0.005 }), false);
  assert.equal(passesGate({ ...good, maxDD: 0.11 }), false);
  assert.equal(passesGate({ ...good, trades: 2 }), false);
  assert.equal(passesGate({ ...good, winRate: 0.4 }), false);
  assert.equal(gateReasons({ ret: -0.02, maxDD: 0.2, trades: 1, winRate: 0 }).length, 4);
  assert.equal(gateReasons(good).length, 0);
});

test('the leader always passes the gate and has the best fitness among passers', () => {
  const candles = tape(900, 12);
  const evo = new Evolution(candles, { seed: 21 });
  for (let i = 0; i < 5; i++) evo.stepGeneration();
  const passers = evo.population.filter((p) => p.passes);
  if (!passers.length) {
    assert.equal(evo.leader, null);
    return;
  }
  assert.ok(evo.leader.passes);
  assert.equal(evo.leader.fitness, Math.max(...passers.map((p) => p.fitness)));
});

test('GENES describes all eight genes', () => {
  assert.deepEqual(GENES.map((g) => g.key), ['family', 'lookback', 'entryZ', 'levels', 'spacing', 'mult', 'tp', 'stop']);
});
