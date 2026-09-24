// Controller: ticker loading, generation timeline, gene-pool view model, paper
// trading clock and DOM/canvas rendering.

import { TICKERS, loadCandles } from './data/index.js';
import { Evolution, GENES, formatGene, gateReasons } from './engine/evolution.js';
import { GridBot, FAMILIES, FAMILY_SHORT } from './engine/bot.js';
import { O, C, buyAndHold } from './engine/series.js';
import {
  prepare, drawLoop, drawFitness, drawGenePool, hitNode, drawSparkline, drawTape, drawPaper,
  SPECIES_COLORS, pct, money, price, fmtTime,
} from './ui/draw.js';

const STAGES = ['Observe', 'Hypothesize', 'Mutate', 'Backtest', 'Select', 'Deploy'];
const CYCLE_MS = 4800; // one generation at 1×
const PAPER_BARS_PER_SEC = 2.5; // at 1×
const SPEEDS = [1, 2, 4, 8];
const SLOTS_PER_SPECIES = 40;

const $ = (id) => document.getElementById(id);
const el = {
  boot: $('boot'), bootMsg: $('bootMsg'),
  tabs: $('tickerTabs'), btnRun: $('btnRun'), btnStep: $('btnStep'), speedGroup: $('speedGroup'),
  seedForm: $('seedForm'), seedInput: $('seedInput'),
  genLabel: $('genLabel'), stageLabel: $('stageLabel'), tfLabel: $('tfLabel'),
  cvLoop: $('cvLoop'), stageList: $('stageList'), loopStats: $('loopStats'), loopHint: $('loopHint'),
  cvFitness: $('cvFitness'),
  cvPool: $('cvPool'), speciesLegend: $('speciesLegend'),
  genomeWho: $('genomeWho'), genomeBody: $('genomeBody'),
  cvPaper: $('cvPaper'), paperStats: $('paperStats'), paperHint: $('paperHint'), fillLog: $('fillLog'), btnReplay: $('btnReplay'),
  cvTape: $('cvTape'), tapeTitle: $('tapeTitle'), tapeStats: $('tapeStats'), tapeNotice: $('tapeNotice'), tapeInterval: $('tapeInterval'),
};

// ---- URL params --------------------------------------------------------------

const params = new URLSearchParams(location.search);
const state = {
  symbol: (params.get('ticker') || TICKERS[0].symbol).toUpperCase(),
  seed: params.get('seed') || '2026',
  speed: SPEEDS.includes(Number(params.get('speed'))) ? Number(params.get('speed')) : 1,
  warm: Math.max(0, Math.min(500, parseInt(params.get('warm') || '0', 10) || 0)),
  running: !params.has('paused'),
  meta: null, // manifest entry
  data: null, // candle module
  evo: null,
  displayedGen: 0,
  displayedLeaderId: null,
  selectedId: null,
  nodes: [],
  slots: FAMILIES.map(() => new Array(SLOTS_PER_SPECIES).fill(false)),
  cycle: null,
  elapsed: 0,
  paper: null,
  paperAcc: 0,
  inspectorKey: '',
  lastFrame: 0,
};
if (!TICKERS.some((t) => t.symbol === state.symbol)) state.symbol = TICKERS[0].symbol;

function syncURL() {
  const p = new URLSearchParams(location.search);
  p.set('ticker', state.symbol);
  p.set('seed', state.seed);
  p.set('speed', String(state.speed));
  history.replaceState(null, '', `${location.pathname}?${p.toString()}`);
}

// ---- gene pool view model ----------------------------------------------------

function takeSlot(species) {
  const arr = state.slots[species];
  let i = arr.indexOf(false);
  if (i < 0) { arr.push(false); i = arr.length - 1; }
  arr[i] = true;
  return i;
}

function addNode(ind, revealed, now) {
  const species = ind.genome.family;
  const node = { id: ind.id, ind, species, slot: takeSlot(species), state: revealed ? 'alive' : 'born', t0: now, revealed };
  if (!revealed) node.state = 'born';
  state.nodes.push(node);
  return node;
}

function killNode(id, now, instant = false) {
  const n = state.nodes.find((x) => x.id === id);
  if (!n) return;
  if (instant) return removeNode(n);
  n.state = 'dying';
  n.t0 = now;
}

function removeNode(n) {
  state.slots[n.species][n.slot] = false;
  state.nodes = state.nodes.filter((x) => x !== n);
  if (state.selectedId === n.id) state.selectedId = null;
}

function rebuildNodes() {
  state.nodes = [];
  state.slots = FAMILIES.map(() => new Array(SLOTS_PER_SPECIES).fill(false));
  const sorted = [...state.evo.population].sort((a, b) => a.id - b.id);
  for (const ind of sorted) addNode(ind, true, performance.now());
}

// ---- paper trading -----------------------------------------------------------

function resetPaper() {
  const evo = state.evo;
  const [start, end] = evo.oosRange;
  const capital = evo.config.capital;
  state.paper = {
    start, end, capital,
    cursor: start - 1,
    bot: null,
    botLeaderId: null,
    cash: capital,
    equity: [],
    marks: [],
    log: [],
    done: false,
    logDirty: true,
  };
  state.paperAcc = 0;
  deployLeader(true);
}

function logPaper(kind, bar, desc, right) {
  const t = bar >= 0 && bar < state.data.candles.length ? fmtTime(state.data.candles[bar][0]) : '';
  state.paper.log.unshift({ kind, t, desc, right, fresh: true });
  if (state.paper.log.length > 80) state.paper.log.length = 80;
  state.paper.logDirty = true;
}

function describeEvent(ev) {
  if (ev.type === 'fill') {
    return ['fill', `L${ev.level} ${ev.level === 0 ? 'market' : 'limit'} buy ${ev.qty.toFixed(3)} @ ${price(ev.price)}`, `-${money(ev.notional)}`];
  }
  const kind = ev.reason === 'tp' ? 'tp' : ev.reason === 'stop' ? 'stop' : 'swap';
  const label = ev.reason === 'tp' ? 'Take profit' : ev.reason === 'stop' ? 'Stop out' : 'Swap close';
  return [kind, `${label} ${ev.qty.toFixed(3)} @ ${price(ev.price)}`, pct(ev.pnl / (state.paper.bot?.initialCapital || state.paper.capital), 2)];
}

function deployLeader(initial = false) {
  const paper = state.paper;
  const leader = state.evo.leader;
  const leaderId = leader ? leader.id : null;
  state.displayedLeaderId = leaderId;
  if (!paper || paper.done) return;
  if (paper.botLeaderId === leaderId && !initial) return;
  if (paper.botLeaderId === leaderId && initial && paper.bot) return;
  const candles = state.data.candles;
  const barIdx = Math.max(paper.start, paper.cursor);
  if (paper.bot) {
    const px = candles[barIdx][C];
    const events = paper.bot.liquidate(px, barIdx, 'swap');
    for (const ev of events) {
      const [kind, desc, right] = describeEvent(ev);
      logPaper(kind, barIdx, desc, right);
      paper.marks.push({ type: 'exit', reason: 'swap', bar: barIdx, price: ev.price });
    }
    paper.cash = paper.bot.cash;
  }
  paper.botLeaderId = leaderId;
  if (leader) {
    paper.bot = new GridBot(leader.genome, { capital: paper.cash, fee: state.evo.config.fee });
    logPaper('swap', paper.cursor >= paper.start ? paper.cursor : paper.start, `Deploy #${leader.id} ${FAMILIES[leader.genome.family]} (gen ${state.evo.generation})`, money(paper.cash));
  } else {
    paper.bot = null;
    logPaper('arm', paper.cursor >= paper.start ? paper.cursor : paper.start, 'No gate survivor — book sits in cash', money(paper.cash));
  }
}

function advancePaper(dt) {
  const paper = state.paper;
  if (!paper || paper.done) return;
  state.paperAcc += (dt / 1000) * PAPER_BARS_PER_SEC * state.speed;
  const candles = state.data.candles;
  let steps = Math.floor(state.paperAcc);
  state.paperAcc -= steps;
  while (steps-- > 0 && !paper.done) {
    paper.cursor += 1;
    if (paper.cursor >= paper.end) {
      paper.cursor = paper.end - 1;
      paper.done = true;
      const eq = paper.bot ? paper.bot.equity(candles[paper.cursor][C]) : paper.cash;
      logPaper('end', paper.cursor, `Tape complete — ${paper.bot?.position ? 'open position marked at close' : 'flat'}`, money(eq));
      break;
    }
    if (paper.bot) {
      const events = paper.bot.step(candles, paper.cursor);
      for (const ev of events) {
        const [kind, desc, right] = describeEvent(ev);
        logPaper(kind, paper.cursor, desc, right);
        paper.marks.push({ type: ev.type, reason: ev.reason, bar: paper.cursor, price: ev.price });
      }
      paper.equity.push(paper.bot.equity(candles[paper.cursor][C]));
    } else {
      paper.equity.push(paper.cash);
    }
  }
}

// ---- generation timeline -----------------------------------------------------

function newCycle() {
  state.cycle = { ledger: null, immigrants: false, offspring: false, revealed: 0, deaths: false, deployed: false };
}

function runGenerationInstant() {
  const now = performance.now();
  const cyc = state.cycle;
  if (cyc.ledger) {
    // A generation was already bred mid-cycle: finish revealing it instead of
    // breeding another, so Step always advances the counter by exactly one.
    for (const ind of cyc.newborn) if (!state.nodes.some((n) => n.id === ind.id)) addNode(ind, true, now);
    for (const n of state.nodes) if (!n.revealed) { n.revealed = true; n.state = 'alive'; }
    if (!cyc.deaths) for (const id of cyc.ledger.deaths) killNode(id, now, true);
  } else {
    const ledger = state.evo.stepGeneration();
    const byId = new Map(state.evo.population.map((p) => [p.id, p]));
    for (const id of ledger.births) addNode(byId.get(id), true, now);
    for (const id of ledger.deaths) killNode(id, now, true);
  }
  state.displayedGen = state.evo.generation;
  deployLeader();
  state.elapsed = 0;
  newCycle();
}

function progressCycle(now) {
  const evo = state.evo;
  const cyc = state.cycle;
  const progress = state.elapsed / CYCLE_MS;
  const stage = Math.min(5, Math.floor(progress * STAGES.length));

  if (stage >= 1 && !cyc.ledger) {
    cyc.ledger = evo.stepGeneration();
    cyc.byId = new Map(evo.population.map((p) => [p.id, p]));
    cyc.newborn = cyc.ledger.births.map((id) => cyc.byId.get(id));
  }
  if (stage >= 1 && !cyc.immigrants) {
    cyc.immigrants = true;
    for (const ind of cyc.newborn.filter((b) => b.origin === 'immigrant')) addNode(ind, false, now);
  }
  if (stage >= 2 && !cyc.offspring) {
    cyc.offspring = true;
    for (const ind of cyc.newborn.filter((b) => b.origin === 'offspring')) addNode(ind, false, now);
  }
  if (stage === 3 || (stage > 3 && cyc.revealed < cyc.newborn.length)) {
    const frac = stage > 3 ? 1 : Math.min(1, progress * STAGES.length - 3);
    const target = Math.ceil(frac * cyc.newborn.length);
    const bornNodes = state.nodes.filter((n) => !n.revealed).sort((a, b) => a.id - b.id);
    for (let i = 0; i < bornNodes.length && cyc.revealed < target; i++) {
      bornNodes[i].revealed = true;
      bornNodes[i].state = 'alive';
      cyc.revealed += 1;
    }
  }
  if (stage >= 4 && !cyc.deaths) {
    cyc.deaths = true;
    for (const id of cyc.ledger.deaths) killNode(id, now);
  }
  if (stage >= 5 && !cyc.deployed) {
    cyc.deployed = true;
    state.displayedGen = evo.generation;
    deployLeader();
  }
  if (progress >= 1) {
    state.elapsed -= CYCLE_MS;
    newCycle();
  }
  return stage;
}

// ---- rendering: DOM ----------------------------------------------------------

function kv(container, rows) {
  container.innerHTML = rows
    .map(([k, v, cls]) => `<div><dt>${k}</dt><dd class="${cls || ''}">${v}</dd></div>`)
    .join('');
}

const signCls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

function renderStatic() {
  const { meta, data, evo } = state;
  const candles = data.candles;
  const [s, e] = evo.oosRange;
  const bh = buyAndHold(candles, s, e);
  el.tfLabel.textContent = meta.interval;
  el.tapeInterval.textContent = `${meta.interval} bars · Yahoo Finance · fetched ${data.fetchedAt.slice(0, 10)}`;
  el.tapeTitle.innerHTML = `${meta.symbol} <small>${data.name}${data.exchange ? ' · ' + data.exchange : ''}</small>`;
  kv(el.tapeStats, [
    ['Bars', `${candles.length} <small>× ${meta.interval}</small>`],
    ['Train', `${evo.split} <small>bars</small>`],
    ['Out-of-sample', `${candles.length - evo.split} <small>bars</small>`],
    ['From', fmtTime(candles[0][0], false) + ` <small>${new Date(candles[0][0] * 1000).getUTCFullYear()}</small>`],
    ['Split', fmtTime(candles[evo.split][0], false)],
    ['To', fmtTime(candles[candles.length - 1][0], false) + ` <small>${new Date(candles[candles.length - 1][0] * 1000).getUTCFullYear()}</small>`],
    ['B&H OOS return', pct(bh.ret), signCls(bh.ret)],
    ['B&H OOS drawdown', pct(-bh.maxDD), 'neg'],
    ['Max lookback', `${evo.maxLookback} <small>bars</small>`],
  ]);
  const thin = candles.length < 1000;
  el.tapeNotice.hidden = !thin;
  if (thin) {
    el.tapeNotice.textContent = `Thin history: ${meta.symbol} has only ${candles.length} ${meta.interval} bars since ${meta.start} (${evo.split} train / ${candles.length - evo.split} OOS). Lookback is capped at ${evo.maxLookback} bars and the gate needs ${evo.config.gate.minTrades} OOS trades, so expect few survivors and treat every number as anecdotal.`;
  }
  el.speciesLegend.innerHTML = FAMILIES.map((f, i) => `<i style="--c:${SPECIES_COLORS[i]}"></i>${f}`).join('');
  for (const b of el.tabs.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.symbol === state.symbol));
  el.seedInput.value = state.seed;
  document.title = `Desk SETS — ${meta.symbol} · 8-name US watchlist`;
}

function renderControls(stage) {
  el.btnRun.textContent = state.running ? 'Pause' : 'Run';
  el.btnRun.classList.toggle('running', state.running);
  el.genLabel.textContent = String(state.displayedGen);
  el.stageLabel.textContent = state.running ? STAGES[stage] : 'paused';
  for (const b of el.speedGroup.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === state.speed));
  }
  for (const li of el.stageList.children) {
    const s = Number(li.dataset.stage);
    li.classList.toggle('active', state.running && s === stage);
    li.classList.toggle('done', state.running && s < stage);
  }
}

let loopStatsKey = '';
function renderLoopStats() {
  const evo = state.evo;
  const key = `${evo.generation}:${state.nodes.length}:${state.displayedLeaderId}`;
  if (key === loopStatsKey) return;
  loopStatsKey = key;
  const counts = evo.speciesCounts();
  const last = evo.history[evo.history.length - 1];
  const closes = state.data.candles.slice(0, evo.split).map((c) => c[C]);
  const n = Math.min(50, closes.length);
  const rets = [];
  for (let i = closes.length - n + 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const vol = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length);
  kv(el.loopStats, [
    ['Population', `${evo.population.length}`],
    ['Gate passers', `${last.passers}`, last.passers ? 'pos' : 'warn'],
    ['Tape σ / bar', `${(vol * 100).toFixed(2)}%`],
    ['Births / deaths', `${last.births} <small>/</small> ${last.deaths}`],
    ['Leader since', state.displayedLeaderId ? `gen ${evo.leaderSince}` : '—'],
    ['Gate', `<small>OOS &gt;${(evo.config.gate.minReturn * 100).toFixed(0)}% · DD &lt;${(evo.config.gate.maxDD * 100).toFixed(0)}% · ≥${evo.config.gate.minTrades} trades · WR ≥${(evo.config.gate.minWinRate * 100).toFixed(0)}%</small>`, 'wide'],
    ['Species', counts.map((c, i) => `<span style="color:${SPECIES_COLORS[i]}">${FAMILY_SHORT[i]}</span> ${c}`).join(' <small>·</small> '), 'wide'],
  ]);
  el.loopHint.textContent = `${CYCLE_MS / 1000 / state.speed}s per generation`;
}

function findIndividual(id) {
  if (id === null || id === undefined) return null;
  const node = state.nodes.find((n) => n.id === id && n.state !== 'dying');
  return node ? node.ind : null;
}

function renderInspector() {
  const evo = state.evo;
  const selected = findIndividual(state.selectedId);
  const target = selected || findIndividual(state.displayedLeaderId);
  const key = `${target ? target.id : 'none'}:${state.displayedGen}:${state.displayedLeaderId}:${state.symbol}`;
  if (key === state.inspectorKey) return;
  state.inspectorKey = key;

  if (!target) {
    el.genomeWho.textContent = '';
    el.genomeBody.innerHTML = `<div class="empty">No config has passed the out-of-sample gate yet.<br/>The pool keeps evolving; the paper book sits in cash.<br/><small>Gate: OOS return &gt; ${(evo.config.gate.minReturn * 100).toFixed(0)}%, drawdown &lt; ${(evo.config.gate.maxDD * 100).toFixed(0)}%, ≥ ${evo.config.gate.minTrades} trades, win rate ≥ ${(evo.config.gate.minWinRate * 100).toFixed(0)}%.</small><br/><br/>Click any node in the gene pool to inspect it.</div>`;
    return;
  }
  const isLeader = target.id === state.displayedLeaderId;
  el.genomeWho.textContent = isLeader ? 'deployed leader' : 'selected node · Esc for leader';
  const species = target.genome.family;
  const reasons = gateReasons(target.oos, evo.config.gate);
  const parents = target.parents.length
    ? `offspring of ${target.parents.map((p) => `<button data-inspect="${p}">#${p}</button>`).join(' × ')}`
    : target.origin === 'seed' ? 'founding population' : 'random immigrant';
  const bhTrain = buyAndHold(state.data.candles, ...evo.trainRange);
  const bhOOS = buyAndHold(state.data.candles, ...evo.oosRange);
  const block = (title, m, bh, id) => `
    <div class="result">
      <h4><span>${title}</span><span class="mono">${m.trades} trades</span></h4>
      <div class="row"><span>Return</span><span class="${signCls(m.ret)}">${pct(m.ret)}</span></div>
      <div class="row"><span>Max drawdown</span><span class="neg">${pct(-m.maxDD)}</span></div>
      <div class="row"><span>Win rate</span><span>${m.trades ? (m.winRate * 100).toFixed(0) + '%' : '—'}</span></div>
      <div class="row"><span>Exposure</span><span>${(m.exposure * 100).toFixed(0)}%${m.openAtEnd ? ' <small>open at end</small>' : ''}</span></div>
      <div class="row"><span>Buy &amp; hold</span><span class="${signCls(bh.ret)}">${pct(bh.ret)} <small style="color:var(--faint)">/ ${pct(-bh.maxDD)}</small></span></div>
      <canvas class="spark" id="${id}"></canvas>
    </div>`;
  el.genomeBody.innerHTML = `
    <div class="genome-title">
      <span class="name">#${target.id} <span class="tag species" style="--c:${SPECIES_COLORS[species]}">${FAMILIES[species]}</span></span>
      <span>
        ${isLeader ? '<span class="tag leader">LEADER</span> ' : ''}
        <span class="tag ${target.passes ? 'ok' : 'fail'}">${target.passes ? 'PASSES GATE' : 'FAILS GATE'}</span>
        <span class="tag mono">fitness ${pct(target.fitness)}</span>
      </span>
    </div>
    <div class="genes">
      ${evo.geneRanges.map((g) => {
        const v = target.genome[g.key];
        const w = g.type === 'family' ? 100 : ((v - g.min) / (g.max - g.min)) * 100;
        return `<div class="gene"><span class="lbl">${g.label}</span><span class="bar"><i style="--w:${w.toFixed(1)}%;--c:${SPECIES_COLORS[species]}"></i></span><span class="val">${formatGene(g, v)}</span></div>`;
      }).join('')}
    </div>
    <div class="results">
      ${block('Train 70%', target.train, bhTrain, 'sparkTrain')}
      ${block('Out-of-sample 30%', target.oos, bhOOS, 'sparkOOS')}
    </div>
    ${reasons.length ? `<div class="gate-reasons">Gate: ${reasons.join(' · ')}</div>` : ''}
    <div class="lineage"><b>Lineage</b> · born gen ${target.born} · ${parents} · survived ${target.age} generation${target.age === 1 ? '' : 's'}</div>
  `;
  for (const [id, m, color] of [['sparkTrain', target.train, SPECIES_COLORS[species]], ['sparkOOS', target.oos, '#2dd4bf']]) {
    const cv = document.getElementById(id);
    const { ctx, w, h } = prepare(cv);
    drawSparkline(ctx, w, h, m.curve, color, evo.config.capital);
  }
  el.genomeBody.querySelectorAll('[data-inspect]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.inspect);
      if (findIndividual(id)) state.selectedId = id;
      else b.textContent = `#${id} (dead)`;
    }),
  );
}

let paperStatsKey = '';
function renderPaperStats() {
  const paper = state.paper;
  const candles = state.data.candles;
  const cur = Math.max(paper.start, paper.cursor);
  const px = candles[Math.min(cur, paper.end - 1)][C];
  const snap = paper.bot ? paper.bot.snapshot(px) : null;
  const equity = snap ? snap.equity : paper.cash;
  const key = `${paper.cursor}:${equity.toFixed(2)}:${paper.botLeaderId}:${paper.done}`;
  if (key !== paperStatsKey) {
    paperStatsKey = key;
    const barsDone = Math.max(0, paper.cursor - paper.start + 1);
    const bhNow = barsDone ? candles[cur][C] / candles[paper.start][O] - 1 : 0;
    const ret = equity / paper.capital - 1;
    const pos = snap?.position;
    const unreal = pos ? (px - pos.avgEntry) * snap.qty : 0;
    const closed = paper.bot ? paper.bot.trades : [];
    const wins = closed.filter((t) => t.pnl > 0).length;
    const leader = findIndividual(paper.botLeaderId);
    kv(el.paperStats, [
      ['Equity', money(equity), signCls(ret)],
      ['Return', pct(ret, 2), signCls(ret)],
      ['Buy & hold', pct(bhNow, 2), signCls(bhNow)],
      ['Cash', money(snap ? snap.cash : paper.cash)],
      ['Position', pos ? `${snap.qty.toFixed(2)} <small>@ ${price(pos.avgEntry)}</small>` : snap?.pendingEntry ? 'arming grid' : 'flat'],
      ['Unrealized', pos ? money(unreal) : '—', signCls(unreal)],
      ['Grid', pos ? `${pos.fills}/${pos.levels.length} <small>filled</small>` : '—'],
      ['Closed trades', `${closed.length} <small>${closed.length ? `· ${wins}W ${closed.length - wins}L` : ''}</small>`],
      ['Bar', `${barsDone}<small>/${paper.end - paper.start}</small>`],
      ['Bot', leader ? `#${leader.id} <small>${FAMILY_SHORT[leader.genome.family]}</small>` : paper.bot ? `#${paper.botLeaderId} <small>retired</small>` : 'idle', leader ? '' : 'warn'],
      ['Last price', price(px)],
      ['Fee / side', `${(state.evo.config.fee * 100).toFixed(2)}%`],
    ]);
    el.paperHint.textContent = paper.done
      ? 'out-of-sample tape complete'
      : `${paper.cursor >= paper.start ? fmtTime(candles[cur][0]) : 'waiting for first bar'} · ${(PAPER_BARS_PER_SEC * state.speed).toFixed(1)} bars/s`;
  }
  if (paper.logDirty) {
    paper.logDirty = false;
    el.fillLog.innerHTML = paper.log.length
      ? paper.log.map((e) => `<li class="${e.fresh ? 'new' : ''}"><span class="t">${e.t}</span><span class="k ${e.kind}">${e.kind.toUpperCase()}</span><span class="d">${e.desc}</span><span class="p ${e.kind === 'tp' ? 'pos' : e.kind === 'stop' ? 'neg' : ''}">${e.right ?? ''}</span></li>`).join('')
      : '<li class="empty">No fills yet.</li>';
    for (const e of paper.log) e.fresh = false;
  }
}

// ---- rendering: canvases -----------------------------------------------------

function renderCanvases(stage, now) {
  const evo = state.evo;
  {
    const { ctx, w, h } = prepare(el.cvLoop);
    drawLoop(ctx, w, h, { stage, progress: state.elapsed / CYCLE_MS, gen: state.displayedGen, running: state.running });
  }
  {
    const { ctx, w, h } = prepare(el.cvFitness);
    drawFitness(ctx, w, h, evo.history.slice(0, state.displayedGen + 1));
  }
  {
    // retire finished death animations
    for (const n of [...state.nodes]) if (n.state === 'dying' && now - n.t0 > 650) removeNode(n);
    const fits = state.nodes.filter((n) => n.revealed).map((n) => n.ind.fitness);
    const minFit = fits.length ? Math.min(...fits) : 0;
    const maxFit = fits.length ? Math.max(...fits) : 1;
    const { ctx, w, h } = prepare(el.cvPool);
    drawGenePool(ctx, w, h, state.nodes, {
      leaderId: state.displayedLeaderId, selectedId: state.selectedId, now, minFit, maxFit, lineage: true,
    });
  }
  {
    const paper = state.paper;
    const { ctx, w, h } = prepare(el.cvPaper);
    const cur = Math.min(paper.end - 1, Math.max(paper.start - 1, paper.cursor));
    const px = state.data.candles[Math.max(paper.start, cur)][C];
    drawPaper(ctx, w, h, {
      candles: state.data.candles, start: paper.start, end: paper.end, cursor: cur,
      snapshot: paper.bot ? paper.bot.snapshot(px) : null,
      marks: paper.marks, equity: paper.equity,
      bh: state.paperBH, capital: paper.capital,
    });
  }
  {
    const { ctx, w, h } = prepare(el.cvTape);
    drawTape(ctx, w, h, state.data.candles, evo.split, state.paper.cursor);
  }
}

// ---- main loop ---------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  if (!state.evo) return;
  const dt = Math.min(250, now - (state.lastFrame || now));
  state.lastFrame = now;
  let stage = Math.min(5, Math.floor((state.elapsed / CYCLE_MS) * STAGES.length));
  if (state.running) {
    state.elapsed += dt * state.speed;
    stage = progressCycle(now);
    advancePaper(dt);
  }
  if (document.hidden) return;
  renderControls(stage);
  renderLoopStats();
  renderInspector();
  renderPaperStats();
  renderCanvases(stage, now);
}

// ---- lifecycle ---------------------------------------------------------------

async function loadTicker(symbol, { warm = 0 } = {}) {
  const meta = TICKERS.find((t) => t.symbol === symbol) || TICKERS[0];
  el.bootMsg.textContent = `Loading ${meta.symbol} candles…`;
  clearTimeout(bootTimer);
  el.boot.style.display = '';
  el.boot.classList.remove('hidden');
  const token = (state.loadToken = (state.loadToken || 0) + 1);
  const data = await loadCandles(meta.symbol);
  if (warm) el.bootMsg.textContent = `Evolving ${warm} generations on ${meta.symbol}…`;
  await new Promise((r) => setTimeout(r, 10)); // let the overlay paint before the warm-up burst
  if (token !== state.loadToken) return; // a newer ticker click won the race
  startEvolution({ warm, meta, data });
  syncURL();
  hideBoot();
}

let bootTimer = null;
function hideBoot() {
  el.boot.classList.add('hidden');
  clearTimeout(bootTimer);
  bootTimer = setTimeout(() => { if (el.boot.classList.contains('hidden')) el.boot.style.display = 'none'; }, 450);
}

function startEvolution({ warm = 0, meta = state.meta, data = state.data } = {}) {
  // Swap tape and evolution in the same synchronous step so no frame sees a mix.
  state.symbol = meta.symbol;
  state.meta = meta;
  state.data = data;
  state.evo = new Evolution(data.candles, { seed: state.seed });
  for (let i = 0; i < warm; i++) state.evo.stepGeneration();
  state.displayedGen = state.evo.generation;
  state.selectedId = null;
  state.inspectorKey = '';
  loopStatsKey = '';
  paperStatsKey = '';
  state.elapsed = 0;
  newCycle();
  rebuildNodes();
  const [s, e] = state.evo.oosRange;
  state.paperBH = [];
  for (let j = s; j < e; j++) state.paperBH.push((state.evo.config.capital * state.data.candles[j][C]) / state.data.candles[s][O]);
  resetPaper();
  renderStatic();
}

function setRunning(v) {
  state.running = v;
  state.lastFrame = performance.now();
}

function setSpeed(s) {
  state.speed = s;
  loopStatsKey = '';
  syncURL();
}

function buildTabs() {
  el.tabs.innerHTML = '';
  for (const t of TICKERS) {
    const b = document.createElement('button');
    b.dataset.symbol = t.symbol;
    b.innerHTML = `${t.symbol}<span class="bars">${t.bars}</span>`;
    b.title = `${t.name} · ${t.bars} × ${t.interval} bars · ${t.start} → ${t.end}${t.bars < 1000 ? ' · thin history' : ''}`;
    b.classList.toggle('thin', t.bars < 1000);
    b.addEventListener('click', () => {
      if (t.symbol === state.symbol) return;
      loadTicker(t.symbol, { warm: state.warm });
    });
    el.tabs.appendChild(b);
  }
}

function wireControls() {
  el.btnRun.addEventListener('click', () => setRunning(!state.running));
  el.btnStep.addEventListener('click', () => {
    setRunning(false);
    runGenerationInstant();
  });
  el.speedGroup.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
  el.seedForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const seed = el.seedInput.value.trim() || '2026';
    state.seed = seed;
    el.seedInput.blur();
    startEvolution({ warm: 0 });
    syncURL();
  });
  el.btnReplay.addEventListener('click', () => resetPaper());
  el.cvPool.addEventListener('click', (e) => {
    const rect = el.cvPool.getBoundingClientRect();
    const n = hitNode(state.nodes, e.clientX - rect.left, e.clientY - rect.top);
    state.selectedId = n ? n.id : null;
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Space') { e.preventDefault(); setRunning(!state.running); }
    else if (e.key === 'ArrowRight') { setRunning(false); runGenerationInstant(); }
    else if (e.key === 'Escape') state.selectedId = null;
    else if (['1', '2', '3', '4'].includes(e.key)) setSpeed(SPEEDS[Number(e.key) - 1]);
  });
  document.addEventListener('visibilitychange', () => { state.lastFrame = performance.now(); });
}

async function main() {
  buildTabs();
  wireControls();
  await loadTicker(state.symbol, { warm: state.warm });
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  el.bootMsg.textContent = `Failed to start: ${err.message}`;
});
