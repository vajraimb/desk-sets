import test from 'node:test';
import assert from 'node:assert/strict';
import { GridBot, backtest } from '../dist/engine/bot.js';
import { indicatorsFor, C, H, L, O } from '../dist/engine/series.js';
import { createRng } from '../dist/engine/rng.js';

const bar = (o, h, l, c, t = 0) => [t, o, h, l, c, 1000];

// Grid: 3 levels 10% apart, doubling size, 5% TP, 10% stop below the deepest level.
const GENOME = { family: 0, lookback: 5, entryZ: 1, levels: 3, spacing: 0.1, mult: 2, tp: 0.05, stop: 0.1 };

/** A bot whose signal fires only on the listed bar indices. */
function scriptedBot(genome, fireOn, opts) {
  const bot = new GridBot(genome, opts);
  bot.signal = (_candles, j) => fireOn.includes(j);
  return bot;
}

function run(bot, candles) {
  const events = [];
  for (let j = 0; j < candles.length; j++) {
    for (const e of bot.step(candles, j, indicatorsFor(candles, bot.genome.lookback))) events.push(e);
  }
  return events;
}

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('signal on close of bar j executes at the open of bar j+1', () => {
  const candles = [bar(100, 101, 99, 100), bar(100, 101, 99, 100), bar(104, 106, 103, 105), bar(105, 106, 104, 105)];
  const bot = scriptedBot(GENOME, [1], { fee: 0 });
  const events = run(bot, candles);
  assert.equal(events[0].type, 'fill');
  assert.equal(events[0].bar, 2);
  assert.equal(events[0].price, 104); // the open of bar 2, not the close of bar 1
});

test('grid levels, sizing and average entry follow the genome', () => {
  const candles = [
    bar(100, 101, 99, 100),
    bar(100, 101, 99, 100), // signal fires here
    bar(100, 101, 99, 100), // L0 market buy @100
    bar(99, 99.5, 85, 88), // low 85 hits L1 @90 but not L2 @80
  ];
  const bot = scriptedBot(GENOME, [1], { fee: 0, capital: 7000 });
  const events = run(bot, candles);
  const base = 7000 / 7; // weights 1 + 2 + 4
  const [f0, f1] = events;
  near(f0.price, 100);
  near(f0.notional, base);
  near(f1.price, 90);
  near(f1.notional, 2 * base);
  const qty = base / 100 + (2 * base) / 90;
  near(bot.qty, qty);
  near(bot.position.avgEntry, (3 * base) / qty);
  near(bot.cash, 7000 - 3 * base);
  const snap = bot.snapshot(88);
  assert.deepEqual(snap.position.levels.map((l) => l.filled), [true, true, false]);
  near(snap.position.stop, 80 * 0.9);
});

test('a gap below a level fills at the open, not the level', () => {
  const candles = [bar(100, 101, 99, 100), bar(100, 101, 99, 100), bar(100, 101, 99, 100), bar(87, 89, 86, 88)];
  const bot = scriptedBot(GENOME, [1], { fee: 0 });
  const events = run(bot, candles);
  assert.equal(events[1].level, 1);
  assert.equal(events[1].price, 87);
});

test('adverse-first: when a bar spans both the stop and the take-profit, the stop wins', () => {
  // L0 @100, L1 @90, L2 @80, stop @72, TP @105 (avg entry 100 after a single fill)
  const candles = [bar(100, 101, 99, 100), bar(100, 101, 99, 100), bar(100, 100.5, 99.5, 100), bar(100, 120, 60, 110)];
  const bot = scriptedBot(GENOME, [1], { fee: 0 });
  const events = run(bot, candles);
  const exit = events.find((e) => e.type === 'exit');
  assert.equal(exit.reason, 'stop');
  assert.equal(exit.bar, 3);
  near(exit.price, 72);
  assert.equal(bot.qty, 0);
  assert.equal(bot.trades.length, 1);
  assert.ok(bot.trades[0].pnl < 0);
});

test('take-profit on a bar with fresh fills is only honoured at the close', () => {
  const candles = [
    bar(100, 101, 99, 100),
    bar(100, 101, 99, 100), // signal
    bar(100, 100.5, 99.5, 100), // L0 @100
    bar(95, 130, 89, 96), // fills L1 @90 and the high clears TP, but the close does not
    bar(96, 130, 95, 120), // next bar: TP hit -> exit at max(tp, open)
  ];
  const bot = scriptedBot(GENOME, [1], { fee: 0 });
  const events = run(bot, candles);
  const exits = events.filter((e) => e.type === 'exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].reason, 'tp');
  assert.equal(exits[0].bar, 4);
  const base = 10_000 / 7;
  const qty = base / 100 + (2 * base) / 90;
  const avg = (3 * base) / qty;
  near(exits[0].price, Math.max(avg * 1.05, 96));
});

test('a gap up through the take-profit exits at the open', () => {
  const candles = [bar(100, 101, 99, 100), bar(100, 101, 99, 100), bar(100, 100.5, 99.5, 100), bar(112, 115, 111, 113)];
  const bot = scriptedBot(GENOME, [1], { fee: 0 });
  const events = run(bot, candles);
  const exit = events.find((e) => e.type === 'exit');
  assert.equal(exit.reason, 'tp');
  assert.equal(exit.price, 112);
});

test('fees are charged on every fill and exit', () => {
  const fee = 0.001;
  const candles = [bar(100, 101, 99, 100), bar(100, 101, 99, 100), bar(100, 100.5, 99.5, 100), bar(106, 107, 105, 106)];
  const bot = scriptedBot(GENOME, [1], { fee, capital: 7000 });
  const events = run(bot, candles);
  const base = 7000 / ((1 + fee) * 7);
  const qty = base / 100;
  const expectedCash = 7000 - base * (1 + fee) + qty * 106 * (1 - fee);
  near(bot.cash, expectedCash, 1e-9);
  near(events[0].fee, base * fee);
  near(events[1].fee, qty * 106 * fee);
  assert.equal(bot.trades.length, 1);
  near(bot.trades[0].pnl, expectedCash - 7000);
});

test('metrics: return, drawdown, win rate and mark-to-market of an open position', () => {
  const candles = [
    bar(100, 101, 99, 100),
    bar(100, 101, 99, 100), // signal
    bar(100, 100.5, 99.5, 100), // L0
    bar(106, 107, 105, 106), // TP -> win
    bar(106, 107, 105, 106), // signal again
    bar(100, 101, 99, 100), // L0 @100
    bar(100, 100.5, 99.5, 98), // open at end, marked at 98
  ];
  const bot = scriptedBot(GENOME, [1, 4], { fee: 0 });
  run(bot, candles);
  const m = bot.metrics(98);
  assert.equal(m.trades, 1);
  assert.equal(m.wins, 1);
  assert.equal(m.winRate, 1);
  assert.equal(m.openAtEnd, true);
  const base = 10_000 / 7;
  const afterTp = 10_000 + (base / 100) * 6;
  const base2 = afterTp / 7;
  near(m.finalEquity, afterTp - base2 + (base2 / 100) * 98);
  assert.ok(m.maxDD > 0 && m.maxDD < 0.01);
});

test('liquidate closes the book at the given price and disarms pending entries', () => {
  const candles = [bar(100, 101, 99, 100), bar(100, 101, 99, 100), bar(100, 100.5, 99.5, 100)];
  const bot = scriptedBot(GENOME, [1], { fee: 0 });
  run(bot, candles);
  assert.ok(bot.position);
  const ev = bot.liquidate(101, 2);
  assert.equal(ev[0].reason, 'swap');
  assert.equal(bot.qty, 0);
  assert.equal(bot.position, null);
  assert.equal(bot.pendingEntry, false);
});

function randomWalk(n, seed) {
  const rng = createRng(seed);
  const out = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o * (1 + rng.gauss() * 0.012);
    const h = Math.max(o, c) * (1 + Math.abs(rng.gauss()) * 0.005);
    const l = Math.min(o, c) * (1 - Math.abs(rng.gauss()) * 0.005);
    out.push([1_700_000_000 + i * 3600, o, h, l, c, 1000]);
    px = c;
  }
  return out;
}

test('no peeking: rewriting the future never changes past fills or exits', () => {
  const a = randomWalk(600, 11);
  const k = 400;
  const b = a.map((c) => [...c]);
  for (let j = k + 1; j < b.length; j++) {
    b[j][O] *= 0.7; b[j][H] *= 0.7; b[j][L] *= 0.7; b[j][C] *= 0.7;
  }
  for (const family of [0, 1, 2, 3]) {
    const genome = { family, lookback: 20, entryZ: 0.4, levels: 4, spacing: 0.01, mult: 1.3, tp: 0.01, stop: 0.05 };
    const botA = new GridBot(genome), botB = new GridBot(genome);
    const evA = run(botA, a), evB = run(botB, b);
    const upTo = (evs) => evs.filter((e) => e.bar <= k);
    assert.deepEqual(upTo(evA), upTo(evB), `family ${family} peeked`);
    assert.deepEqual(botA.equityCurve.slice(0, k + 1), botB.equityCurve.slice(0, k + 1));
    assert.ok(upTo(evA).length > 0, `family ${family} should trade on this tape`);
  }
});

test('backtest over a window only consumes that window', () => {
  const candles = randomWalk(500, 5);
  const genome = { family: 3, lookback: 15, entryZ: 2, levels: 3, spacing: 0.01, mult: 1, tp: 0.01, stop: 0.05 };
  const full = backtest(genome, candles, 0, 500);
  const tail = backtest(genome, candles, 350, 500);
  assert.ok(full.trades >= tail.trades);
  assert.ok(Number.isFinite(tail.ret));
  assert.equal(tail.curve.length, Math.min(120, 151));
});
