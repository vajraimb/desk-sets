# Desk SETS — 8-name US watchlist

A self-evolving trading-strategy lab that runs entirely in your browser. A genetic algorithm breeds long-only **grid-DCA** strategies on real hourly candles for eight US equities, kills everything that fails on data it has never seen, and paper-trades the survivor on the out-of-sample tape — live, with a dashboard.

**Watchlist:** TSLA · MOD · FN · SPCX · LITE · TTMI · NVDA · ALAB

**96 configs per generation · 8 genes · 4 species · ~2 400 real hourly bars per name · plain ES modules · no build, no npm install, no API keys, no brokerage.**

The architecture is inspired by [SETS MACHINE](https://github.com/Shelpid/SETS) (Self Evolving Trading System) by Shelpid. This project is an independent re-implementation adapted to an equities watchlist; it is not affiliated with or endorsed by that project.

> **This is a research toy.** It is not a trading bot, it holds no keys, and it never touches real money. Read [Honest limitations](#honest-limitations) before drawing any conclusion from the numbers.

## Run locally

Requires Python 3 (only to serve static files) and a modern browser.

```bash
git clone https://github.com/vajraimb/desk-sets.git
cd desk-sets
python -m http.server 8000 --directory dist
```

Open **http://localhost:8000**. The root `index.html` also forwards to `dist/`, so the repo works as-is on GitHub Pages (Settings → Pages → deploy from `main` / root).

### Controls

- **Ticker pills** in the header switch between the eight names. Each switch loads that ticker's candles and restarts the evolution with the current seed. A red dot on a pill marks a thin history (SPCX).
- **Run / Pause**, **Step** (one generation instantly), speed **1× 2× 4× 8×**.
- **Seed** + **Reseed**: the same seed always grows the same evolution on the same tape.
- **Click a node** in the gene pool to inspect its genome, train and out-of-sample results, and lineage. **Esc** returns to the deployed leader.
- **Replay tape** restarts the paper book on the out-of-sample window.
- Keyboard: **Space** run/pause · **→** step · **1–4** speed · **Esc** back to leader.
- URL options: `?ticker=NVDA`, `?seed=42`, `?speed=4`, `?warm=50` (evolve 50 generations instantly on load and on ticker switch), `?paused`.

Panels stack on phones; nothing scrolls sideways.

## How it works

### The genome

Each strategy is a long-only grid-DCA bot described by eight genes:

| Gene | Range | Role |
| --- | --- | --- |
| `family` | 4 species | Entry logic: **Momentum** (z-score above +Z), **Mean revert** (below −Z), **Vol breakout** (close above the previous N-bar high), **Range grid** (quiet, within ±Z/2 of the mean) |
| `lookback` | 10–200 bars | Window for the rolling mean, deviation and breakout high (capped at a quarter of the train window on thin histories) |
| `entryZ` | 0.2–2.5 σ | How far price must stretch before the bot arms a grid |
| `levels` | 2–8 | Number of buy orders in the grid |
| `spacing` | 0.3–3 % | Distance between grid levels |
| `mult` | 1–2× | Size multiplier per deeper level |
| `tp` | 0.3–4 % | Take-profit above the average entry |
| `stop` | 1–12 % | Stop below the deepest level; closes everything |

The first level is a market buy at the open; deeper levels are resting limit buys. The whole allocation (10 000 paper dollars, fractional shares) is spread across the levels by `mult`, so a fully filled grid is fully invested and never levered.

### The loop

| Stage | What happens |
| --- | --- |
| **Observe** | Read the volatility of the train tape |
| **Hypothesize** | Inject 8 random immigrants |
| **Mutate** | Species-quota slots filled by tournament selection inside each species, uniform crossover, Gaussian mutation (p = 0.18 per gene) |
| **Backtest** | Every newcomer is backtested on the train window (first 70 %) and the out-of-sample window (last 30 %) |
| **Select** | Top 4 overall, the best of each species and the current leader survive; everyone else dies |
| **Deploy** | Best train fitness among configs that pass the gate becomes the paper-trading leader |

- **Fitness** = train return − 0.6 × train max drawdown, minus 5 % per missing trade below 4 trades.
- **Gate** (out-of-sample): return > 1 %, max drawdown < 10 %, at least 3 trades, win rate ≥ 50 %.

### No peeking

- Signals are computed on the **close of bar j** and executed at the **open of bar j+1**. Tests rewrite the future and assert that no earlier indicator, fill or exit changes.
- Inside a bar, fills are processed **adverse-first**: grid buys, then the stop, then take-profit. On a bar that also filled new levels, take-profit is only honoured at the close.
- Gaps fill at the open (worse than the level for buys, better for TP — both handled).
- Every fill and exit pays a **0.05 %** fee of notional: zero commission plus a spread/slippage haircut. Open positions are marked to the last close.
- The paper panel replays the out-of-sample candles bar by bar with the **same `GridBot` class** that scored the backtests. When a new leader is deployed mid-tape, the previous bot's position is closed at the current close (logged as `SWAP`) and the new bot inherits the cash. Buy & hold over the same bars is drawn alongside.

## Data

Candles live under `dist/data/`, one ES module per ticker plus a manifest (`index.js`). They are **regular-session hourly bars from Yahoo Finance's public chart API** (`[unixSeconds, open, high, low, close, volume]`), capped at the last 2 400 bars (about 16 months of trading). Yahoo only serves intraday history for the last 730 days, so that is the ceiling.

| Ticker | Bars | Range |
| --- | --- | --- |
| TSLA, MOD, FN, LITE, TTMI, NVDA, ALAB | 2 400 × 1h | 2025-05-07 → 2026-09-22 |
| SPCX | 488 × 1h | 2026-06-12 → 2026-09-22 (recent listing) |

Thin histories are handled, not hidden: the Tape panel shows the exact range, the lookback gene is capped so signals can still fire, and an amber notice warns that the gate will pass few configs and every number is anecdotal.

### Refresh the data

Standard library only, no key:

```bash
python tools/fetch_data.py                       # all 8 names, 1h bars, last 2400
python tools/fetch_data.py --tickers TSLA NVDA   # a subset
python tools/fetch_data.py --interval 1d --bars 1300   # daily bars (~5 years) instead
```

The tool writes `dist/data/<TICKER>.js` and regenerates `dist/data/index.js`. On GitHub, the [Refresh candles](.github/workflows/refresh-data.yml) workflow runs the same command weekly (and on demand from the Actions tab), runs the tests, and commits the new candles. The dashboard reads the interval from the manifest and shows it in the controls row (`Bar 1h`), so switching to daily bars needs no code change. Yahoo's endpoint is unofficial and may change or rate-limit; the script retries and falls back to shorter windows for names that listed less than 730 days ago.

## Tests

Node 18+ (no dependencies):

```bash
node --test tests/*.test.mjs
```

The suite covers: causal rolling statistics (future edits never change past values), signal-at-close / fill-at-next-open timing, grid sizing and average entry, gap fills, adverse-first stop-vs-TP ordering, fee accounting, mark-to-market metrics, a family-by-family no-peek test on a random walk, seeded determinism of the evolution, constant population with species quotas, gene bounds after mutation, elite and leader survival, fitness and gate logic.

## Sample results (seed 2026, 50 generations)

Train 2025-05-07 → 2026-04-27, out-of-sample 2026-04-27 → 2026-09-22 (SPCX: 341 train / 147 OOS bars from 2026-06-12).

| Ticker | Leader species | Train return / DD | OOS return / DD | OOS trades / win rate | Buy & hold, same OOS bars |
| --- | --- | --- | --- | --- | --- |
| TSLA | Mean revert | +69.2% / 6.8% | **+7.8% / 8.7%** | 10 / 90% | +3.2% / 33.9% |
| MOD | Momentum | +49.0% / 11.2% | **+13.9% / 9.5%** | 12 / 100% | −19.6% / 45.6% |
| FN | Vol breakout | +86.0% / 10.1% | **+8.7% / 6.6%** | 9 / 89% | −42.0% / 49.8% |
| SPCX | Momentum | +28.5% / 6.9% | **+7.8% / 3.9%** | 6 / 100% | +15.2% / 7.1% |
| LITE | Vol breakout | +118.5% / 16.4% | **+16.4% / 9.9%** | 6 / 100% | +13.1% / 43.5% |
| TTMI | Momentum | +80.2% / 6.1% | **+6.8% / 10.0%** | 21 / 90% | −9.6% / 55.2% |
| NVDA | Mean revert | +105.6% / 11.2% | **+27.6% / 9.1%** | 14 / 93% | +9.6% / 19.4% |
| ALAB | Momentum | +74.4% / 6.8% | **+3.0% / 9.7%** | 18 / 94% | +83.8% / 50.2% |

Reproduce any row with `?ticker=FN&seed=2026&warm=50&paused` and read the Genome inspector.

## Honest limitations

Read this before getting excited about the table above.

- **The leader is picked using the out-of-sample data.** Choosing "best fitness among gate passers" reuses the OOS window as a selection filter. With 96 configs per generation and dozens of generations, some configs will look good out-of-sample by chance. The OOS numbers are optimistic, not a forecast.
- **The OOS window is short** (about 5 months of hourly bars, 147 bars for SPCX) with a handful of trades. That is a sanity check, not evidence of an edge.
- **Buy & hold is the honest baseline.** In this window several names fell hard (FN −42 %, MOD −20 %), so a long-only grid that spends most of its time in cash with a stop looks great by comparison. On ALAB, buy & hold made +84 % while the leader made +3 %. Most of the "outperformance" is being flat during drawdowns, not skill.
- **Drawdowns cluster just under the 10 % gate** and win rates near 90–100 % come from wide stops that were rarely hit. That is exactly the tail risk a grid-DCA book carries: many small wins, occasional large losses when the stop finally triggers.
- **Hourly equity bars have gaps.** Overnight and weekend gaps are real; the bot fills at the open when price gaps through a level, stop or TP, but it cannot model halts, illiquidity, borrow, or that your limit order might not be at the front of the queue.
- **Fees are a flat 5 bp haircut.** Real slippage on small caps and on volatile opens is worse. Fractional shares are assumed.
- **Survivorship in the watchlist itself.** These eight names were chosen by a human, after the fact.
- **Data quality.** Yahoo's unofficial chart API occasionally repeats or omits bars; the fetch tool de-duplicates and drops null bars but does not adjust for splits inside the window.

Desk SETS is for watching evolutionary search, selection pressure and overfitting happen in front of you. Do not connect it to money.

## Under the hood

```text
index.html             Redirects to dist/ (for GitHub Pages)
dist/
  index.html           Dashboard shell and controls
  app.js               Controller: generation timeline, gene-pool view model, paper clock, rendering
  style.css            Responsive dark dashboard
  engine/
    rng.js             Seeded randomness (sfc32)
    series.js          Causal rolling mean / std / z-score / previous high, drawdown, buy & hold
    bot.js             GridBot: signals, grid fills, TP, stop, fees, metrics; backtest()
    evolution.js       Genome ranges, crossover, mutation, species quotas, fitness, gate
  ui/draw.js           Canvas painters: ring, fitness history, gene pool, paper grid, tape
  data/
    index.js           Manifest of bundled tickers + lazy loader
    <TICKER>.js        Hourly candles per ticker
tools/fetch_data.py    Refreshes dist/data from Yahoo Finance (stdlib only)
tests/*.test.mjs       node --test suite
```

## License

MIT for the code in this repository. Market data is fetched from Yahoo Finance for personal research use; check their terms before redistributing.
