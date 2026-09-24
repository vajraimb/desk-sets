// GridBot: the long-only grid-DCA strategy that both the backtester and the paper
// trader run. One class, one code path, so what gets scored is what gets traded.
//
// Timing model (no peeking):
//   * signal() is evaluated on the CLOSE of bar j.
//   * A grid armed by that signal opens on the OPEN of bar j+1.
//   * Inside a bar, fills are processed adverse-first: grid buys, then the stop,
//     then take-profit. On a bar that also filled new levels, TP is only checked
//     against the close, not the high.
//   * Every fill and exit pays `fee` of notional (default 5 bp: zero commission
//     plus a realistic spread/slippage haircut for liquid US equities).

import { O, H, L, C, indicatorsFor, maxDrawdown } from './series.js';

export const FAMILIES = ['Momentum', 'Mean revert', 'Vol breakout', 'Range grid'];
export const FAMILY_SHORT = ['MOM', 'REV', 'BRK', 'RNG'];
export const DEFAULT_FEE = 0.0005;
export const DEFAULT_CAPITAL = 10_000;

export class GridBot {
  constructor(genome, { capital = DEFAULT_CAPITAL, fee = DEFAULT_FEE } = {}) {
    this.genome = genome;
    this.fee = fee;
    this.reset(capital);
  }

  reset(capital = this.initialCapital ?? DEFAULT_CAPITAL) {
    this.initialCapital = capital;
    this.cash = capital;
    this.qty = 0;
    this.position = null;
    this.pendingEntry = false;
    this.trades = [];
    this.equityCurve = [];
    this.barsInPosition = 0;
    this.barsSeen = 0;
    this.lastIndex = -1;
  }

  equity(price) {
    return this.cash + this.qty * price;
  }

  // ---- signals -------------------------------------------------------------

  /** Pure function of bars 0..j (via causal indicators). */
  signal(candles, j, ind) {
    const g = this.genome;
    const z = ind.z[j];
    if (Number.isNaN(z)) return false;
    const close = candles[j][C];
    switch (g.family) {
      case 0: // Momentum: stretched above the rolling mean
        return z > g.entryZ;
      case 1: // Mean revert: stretched below the rolling mean
        return z < -g.entryZ;
      case 2: { // Vol breakout: close clears the previous N-bar high (plus a small buffer)
        const ph = ind.prevHigh[j];
        return !Number.isNaN(ph) && close > ph * (1 + g.entryZ * 0.001);
      }
      case 3: // Range grid: quiet, near the mean
        return Math.abs(z) < g.entryZ * 0.5;
      default:
        return false;
    }
  }

  // ---- order handling ------------------------------------------------------

  openGrid(bar, j, events) {
    const g = this.genome;
    const anchor = bar[O];
    let weightSum = 0;
    for (let k = 0; k < g.levels; k++) weightSum += Math.pow(g.mult, k);
    // Reserve fees up front so a fully filled grid never goes negative on cash.
    const base = this.cash / ((1 + this.fee) * weightSum);
    const levels = [];
    for (let k = 0; k < g.levels; k++) {
      levels.push({
        k,
        price: anchor * (1 - k * g.spacing),
        notional: base * Math.pow(g.mult, k),
        filled: false,
        fillPrice: null,
        qty: 0,
        bar: null,
      });
    }
    this.position = {
      anchor,
      openedAt: j,
      levels,
      avgEntry: 0,
      cost: 0,
      cashBefore: this.cash,
      fills: 0,
    };
    this.fill(levels[0], anchor, j, events); // level 0 is a market buy at the open
  }

  fill(level, price, j, events) {
    const pos = this.position;
    const qty = level.notional / price;
    const fee = level.notional * this.fee;
    this.cash -= level.notional + fee;
    this.qty += qty;
    pos.cost += level.notional;
    pos.avgEntry = pos.cost / this.qty;
    pos.fills += 1;
    level.filled = true;
    level.fillPrice = price;
    level.qty = qty;
    level.bar = j;
    events.push({ type: 'fill', bar: j, level: level.k, price, qty, notional: level.notional, fee });
  }

  stopPrice() {
    const g = this.genome;
    const deepest = this.position.levels[g.levels - 1].price;
    return deepest * (1 - g.stop);
  }

  tpPrice() {
    return this.position.avgEntry * (1 + this.genome.tp);
  }

  closeAll(price, j, reason, events) {
    const pos = this.position;
    const proceeds = this.qty * price;
    const fee = proceeds * this.fee;
    this.cash += proceeds - fee;
    const pnl = this.cash - pos.cashBefore;
    const trade = {
      openedAt: pos.openedAt,
      closedAt: j,
      reason,
      fills: pos.fills,
      avgEntry: pos.avgEntry,
      exit: price,
      pnl,
      ret: pnl / pos.cashBefore,
    };
    this.trades.push(trade);
    events.push({ type: 'exit', bar: j, reason, price, qty: this.qty, pnl, fee });
    this.qty = 0;
    this.position = null;
  }

  // ---- main loop -----------------------------------------------------------

  /**
   * Process bar `j` of `candles`. Bars must be fed in order. Returns the list of
   * events (fills / exits) that happened on this bar.
   */
  step(candles, j, ind = indicatorsFor(candles, this.genome.lookback)) {
    const bar = candles[j];
    const events = [];
    this.barsSeen += 1;
    this.lastIndex = j;

    if (this.pendingEntry && !this.position) {
      this.pendingEntry = false;
      this.openGrid(bar, j, events);
    }

    if (this.position) {
      this.barsInPosition += 1;
      const pos = this.position;
      let filledThisBar = false;

      // 1. Adverse first: resting grid buys that the bar's low reached.
      for (const level of pos.levels) {
        if (level.filled) continue;
        if (bar[L] <= level.price) {
          // A gap below the level fills at the open, otherwise at the level.
          this.fill(level, Math.min(level.price, bar[O]), j, events);
          filledThisBar = true;
        }
      }

      // 2. Stop below the deepest level closes everything.
      const stop = this.stopPrice();
      if (bar[L] <= stop) {
        this.closeAll(Math.min(stop, bar[O]), j, 'stop', events);
      } else {
        // 3. Take-profit above the average entry.
        const tp = this.tpPrice();
        if (!filledThisBar && bar[H] >= tp) {
          this.closeAll(Math.max(tp, bar[O]), j, 'tp', events);
        } else if (filledThisBar && bar[C] >= tp) {
          this.closeAll(bar[C], j, 'tp', events);
        }
      }
    }

    // Signal on this bar's close arms a grid for the next bar's open.
    if (!this.position) this.pendingEntry = this.signal(candles, j, ind);

    this.equityCurve.push(this.equity(bar[C]));
    return events;
  }

  /** Close any open position at `price` (used when a new leader takes over the paper book). */
  liquidate(price, j, reason = 'swap') {
    const events = [];
    if (this.position) this.closeAll(price, j, reason, events);
    this.pendingEntry = false;
    return events;
  }

  /** Read-only view for the UI. */
  snapshot(price) {
    const pos = this.position;
    return {
      cash: this.cash,
      qty: this.qty,
      equity: this.equity(price),
      pendingEntry: this.pendingEntry,
      trades: this.trades.length,
      position: pos
        ? {
            anchor: pos.anchor,
            openedAt: pos.openedAt,
            avgEntry: pos.avgEntry,
            fills: pos.fills,
            tp: this.tpPrice(),
            stop: this.stopPrice(),
            levels: pos.levels.map((l) => ({ ...l })),
          }
        : null,
    };
  }

  /** Summary statistics. Any open position is marked to `lastPrice` (no exit fee). */
  metrics(lastPrice) {
    const finalEquity = this.equity(lastPrice);
    const curve = [this.initialCapital, ...this.equityCurve];
    const wins = this.trades.filter((t) => t.pnl > 0).length;
    const n = this.trades.length;
    return {
      ret: finalEquity / this.initialCapital - 1,
      maxDD: maxDrawdown(curve),
      trades: n,
      wins,
      winRate: n ? wins / n : 0,
      exposure: this.barsSeen ? this.barsInPosition / this.barsSeen : 0,
      openAtEnd: !!this.position,
      finalEquity,
      curve: downsample(curve, 120),
    };
  }
}

export function downsample(arr, points) {
  if (arr.length <= points) return Array.from(arr);
  const out = new Array(points);
  for (let i = 0; i < points; i++) {
    out[i] = arr[Math.round((i * (arr.length - 1)) / (points - 1))];
  }
  return out;
}

/** Run one genome over candles[start, end) and return its metrics. */
export function backtest(genome, candles, start, end, opts = {}) {
  const ind = indicatorsFor(candles, genome.lookback);
  const bot = new GridBot(genome, opts);
  for (let j = start; j < end; j++) bot.step(candles, j, ind);
  return bot.metrics(candles[end - 1][C]);
}
