// Canvas painters. All functions receive a 2D context already scaled for the
// device pixel ratio and draw in CSS pixels.

import { O, H, L, C } from '../engine/series.js';
import { FAMILY_SHORT } from '../engine/bot.js';

export const SPECIES_COLORS = ['#f5b942', '#60a5fa', '#f472b6', '#34d399'];
const AMBER = '#f5b942';
const TEAL = '#2dd4bf';
const RED = '#f87171';
const GREEN = '#4ade80';
const MUTED = '#8b9bb0';
const FAINT = '#55657a';
const GRIDLINE = '#1c2735';
const MONO = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Resize a canvas backing store to its CSS box and return a scaled context. */
export function prepare(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 150;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export const pct = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
export const money = (x) => x.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const price = (x) => (x >= 1000 ? x.toFixed(0) : x >= 100 ? x.toFixed(2) : x.toFixed(3));

export function fmtTime(unix, withTime = true) {
  const d = new Date(unix * 1000);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'America/New_York' });
  if (!withTime) return date;
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  return `${date} ${time}`;
}

// ---- evolution ring --------------------------------------------------------

export function drawLoop(ctx, w, h, { stage, progress, gen, running }) {
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 8;
  const N = 6;
  const gap = 0.08;
  ctx.lineWidth = 7;
  ctx.lineCap = 'butt';
  for (let i = 0; i < N; i++) {
    const a0 = -Math.PI / 2 + (i / N) * Math.PI * 2 + gap / 2;
    const a1 = -Math.PI / 2 + ((i + 1) / N) * Math.PI * 2 - gap / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.strokeStyle = i < stage ? '#2a3a4d' : GRIDLINE;
    ctx.stroke();
    if (i === stage) {
      const frac = Math.min(1, Math.max(0, progress * N - stage));
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * frac);
      ctx.strokeStyle = AMBER;
      ctx.stroke();
    } else if (i < stage) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a1);
      ctx.strokeStyle = 'rgba(245,185,66,0.45)';
      ctx.stroke();
    }
  }
  // inner glow ring
  ctx.beginPath();
  ctx.arc(cx, cy, r - 12, 0, Math.PI * 2);
  ctx.strokeStyle = running ? 'rgba(45,212,191,0.35)' : 'rgba(85,101,122,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#e6edf3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 26px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(String(gen), cx, cy - 6);
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.fillStyle = MUTED;
  ctx.fillText(running ? 'GENERATION' : 'PAUSED', cx, cy + 14);
}

// ---- fitness history -------------------------------------------------------

function axisLayout(w, h, left = 44, right = 12, top = 12, bottom = 22) {
  return { x0: left, x1: w - right, y0: top, y1: h - bottom, pw: w - left - right, ph: h - top - bottom };
}

function niceStep(range, target = 4) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

export function drawFitness(ctx, w, h, history) {
  const L_ = axisLayout(w, h);
  if (history.length < 1) return;
  const vals = [];
  for (const e of history) {
    vals.push(e.best, e.mean);
    if (e.leaderOOS !== null) vals.push(e.leaderOOS);
  }
  let lo = Math.min(0, ...vals), hi = Math.max(0.05, ...vals);
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const n = Math.max(history.length, 12);
  const gx = (i) => L_.x0 + (i / (n - 1)) * L_.pw;
  const gy = (v) => L_.y1 - ((v - lo) / (hi - lo)) * L_.ph;

  ctx.font = MONO;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  const step = niceStep(hi - lo);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = gy(v);
    ctx.strokeStyle = Math.abs(v) < 1e-9 ? '#34465b' : GRIDLINE;
    ctx.beginPath(); ctx.moveTo(L_.x0, y); ctx.lineTo(L_.x1, y); ctx.stroke();
    ctx.fillStyle = FAINT;
    ctx.fillText(`${(v * 100).toFixed(0)}%`, L_.x0 - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xStep = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += xStep) {
    ctx.fillStyle = FAINT;
    ctx.fillText(String(i), gx(i), L_.y1 + 6);
  }

  const line = (key, color, width) => {
    ctx.beginPath();
    let started = false;
    history.forEach((e, i) => {
      const v = e[key];
      if (v === null || v === undefined) { started = false; return; }
      const x = gx(i), y = gy(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  line('mean', MUTED, 1.2);
  line('best', AMBER, 2);
  // leader OOS as dots
  history.forEach((e, i) => {
    if (e.leaderOOS === null) return;
    ctx.beginPath();
    ctx.arc(gx(i), gy(e.leaderOOS), 2.4, 0, Math.PI * 2);
    ctx.fillStyle = TEAL;
    ctx.fill();
  });
  const last = history[history.length - 1];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = AMBER;
  ctx.fillText(pct(last.best), Math.min(gx(history.length - 1) + 6, L_.x1 - 44), gy(last.best));
}

// ---- gene pool -------------------------------------------------------------

/**
 * nodes: [{ id, ind, species, slot, state, t0, ... }] where the painter writes
 * back x, y, r for hit testing. Layout: 4 species columns, slot grid inside.
 */
export function drawGenePool(ctx, w, h, nodes, { leaderId, selectedId, now, minFit, maxFit, lineage }) {
  const cols = 4;
  const padX = 10, padTop = 26, padBottom = 8;
  const colW = (w - padX * 2) / cols;
  const rows = 8, sub = 5;
  const cellW = (colW - 10) / sub;
  const cellH = (h - padTop - padBottom) / rows;

  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (let s = 0; s < cols; s++) {
    const x = padX + s * colW;
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    ctx.fillRect(x + 2, padTop - 8, colW - 4, h - padTop - padBottom + 12);
    ctx.fillStyle = SPECIES_COLORS[s];
    ctx.fillText(FAMILY_SHORT[s], x + colW / 2, 8);
  }

  const range = Math.max(1e-6, maxFit - minFit);
  // Node radius scales with the cell so narrow (phone) canvases never overlap.
  const rMax = Math.max(3.5, Math.min(9.5, Math.min(cellW, cellH) / 2 - 1.5));
  const rMin = Math.max(2, rMax * 0.35);
  const pos = new Map();
  for (const n of nodes) {
    const col = n.slot % sub, row = Math.floor(n.slot / sub);
    n.x = padX + n.species * colW + 5 + col * cellW + cellW / 2;
    n.y = padTop + row * cellH + cellH / 2;
    const f = n.ind.fitness;
    const norm = n.revealed ? (f - minFit) / range : 0.3;
    n.r = rMin + norm * (rMax - rMin);
    pos.set(n.id, n);
  }

  // lineage pulses for freshly born offspring
  if (lineage) {
    for (const n of nodes) {
      if (n.state !== 'born' || !n.ind.parents.length) continue;
      const age = (now - n.t0) / 900;
      if (age > 1) continue;
      for (const pid of n.ind.parents) {
        const p = pos.get(pid);
        if (!p) continue;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(n.x, n.y);
        ctx.strokeStyle = `rgba(230,237,243,${0.35 * (1 - age)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  for (const n of nodes) {
    const color = SPECIES_COLORS[n.species];
    let alpha = 1, scale = 1;
    if (n.state === 'born') {
      const age = Math.min(1, (now - n.t0) / 500);
      scale = 0.2 + 0.8 * age;
      alpha = age;
    } else if (n.state === 'dying') {
      const age = Math.min(1, (now - n.t0) / 600);
      alpha = 1 - age;
      scale = 1 + age * 0.6;
    }
    const r = n.r * scale;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    if (n.revealed) {
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha * (n.ind.fitness > 0 ? 0.95 : 0.45);
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = alpha;
    if (n.state === 'dying') {
      ctx.beginPath();
      ctx.moveTo(n.x - r, n.y - r); ctx.lineTo(n.x + r, n.y + r);
      ctx.moveTo(n.x + r, n.y - r); ctx.lineTo(n.x - r, n.y + r);
      ctx.strokeStyle = RED;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (n.revealed && n.ind.passes && n.state !== 'dying') {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(230,237,243,0.85)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    if (n.id === leaderId) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 300);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 5 + pulse * 2, 0, Math.PI * 2);
      ctx.strokeStyle = AMBER;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (n.id === selectedId && n.id !== leaderId) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = TEAL;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }
}

export function hitNode(nodes, x, y) {
  let best = null, bd = Infinity;
  for (const n of nodes) {
    if (n.state === 'dying' || n.x === undefined) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < Math.max(10, n.r + 4) && d < bd) { best = n; bd = d; }
  }
  return best;
}

// ---- sparkline -------------------------------------------------------------

export function drawSparkline(ctx, w, h, curve, color, base) {
  if (!curve || curve.length < 2) return;
  const lo = Math.min(...curve, base ?? Infinity), hi = Math.max(...curve, base ?? -Infinity);
  const gy = (v) => h - 3 - ((v - lo) / Math.max(1e-9, hi - lo)) * (h - 6);
  if (base !== undefined) {
    ctx.strokeStyle = GRIDLINE;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, gy(base)); ctx.lineTo(w, gy(base)); ctx.stroke();
  }
  ctx.beginPath();
  curve.forEach((v, i) => {
    const x = (i / (curve.length - 1)) * w;
    if (i === 0) ctx.moveTo(x, gy(v)); else ctx.lineTo(x, gy(v));
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ---- tape overview ---------------------------------------------------------

export function drawTape(ctx, w, h, candles, split, cursor) {
  const n = candles.length;
  if (!n) return;
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { if (c[L] < lo) lo = c[L]; if (c[H] > hi) hi = c[H]; }
  const gx = (i) => (i / (n - 1)) * w;
  const gy = (v) => h - 14 - ((v - lo) / (hi - lo)) * (h - 22);
  // OOS shading
  ctx.fillStyle = 'rgba(45,212,191,0.08)';
  ctx.fillRect(gx(split), 0, w - gx(split), h);
  ctx.strokeStyle = 'rgba(45,212,191,0.5)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(gx(split), 0); ctx.lineTo(gx(split), h); ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = gx(i), y = gy(candles[i][C]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = MUTED;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  if (cursor !== undefined && cursor !== null && cursor >= split && cursor < n) {
    ctx.beginPath();
    ctx.arc(gx(cursor), gy(candles[cursor][C]), 3, 0, Math.PI * 2);
    ctx.fillStyle = AMBER;
    ctx.fill();
  }
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = FAINT;
  ctx.textAlign = 'left';
  ctx.fillText('TRAIN 70%', 4, h - 2);
  ctx.fillStyle = TEAL;
  ctx.textAlign = 'right';
  ctx.fillText('OUT-OF-SAMPLE 30%', w - 4, h - 2);
}

// ---- paper grid chart ------------------------------------------------------

/**
 * Draw the OOS tape up to `cursor`, the live grid, fills and the paper equity
 * versus buy & hold in a lower strip.
 */
export function drawPaper(ctx, w, h, { candles, start, end, cursor, snapshot, marks, equity, bh, capital }) {
  const stripH = 54;
  const chart = axisLayout(w, h - stripH, 8, 62, 10, 6);
  const strip = { x0: chart.x0, x1: chart.x1, y0: h - stripH + 8, y1: h - 18 };
  // Expanding x-window: readable from the first bar, growing until it spans the
  // whole out-of-sample range.
  const visEnd = Math.min(end, Math.max(start + 80, cursor + 30));
  const n = visEnd - start;
  // Price range covers everything in the visible window (revealed and ghost), so
  // the ghost tape is never clamped flat.
  let lo = Infinity, hi = -Infinity;
  for (let j = start; j < visEnd; j++) {
    if (candles[j][L] < lo) lo = candles[j][L];
    if (candles[j][H] > hi) hi = candles[j][H];
  }
  if (snapshot?.position) {
    const p = snapshot.position;
    lo = Math.min(lo, p.stop, ...p.levels.map((l) => l.price));
    hi = Math.max(hi, p.tp);
  }
  if (!(hi > lo)) { lo = lo * 0.98; hi = hi * 1.02 || lo + 1; }
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  const gx = (j) => chart.x0 + ((j - start) / Math.max(1, n - 1)) * chart.pw;
  const gy = (v) => chart.y1 - ((v - lo) / (hi - lo)) * chart.ph;

  ctx.font = MONO;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const step = niceStep(hi - lo, 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = gy(v);
    ctx.strokeStyle = GRIDLINE;
    ctx.beginPath(); ctx.moveTo(chart.x0, y); ctx.lineTo(chart.x1, y); ctx.stroke();
    ctx.fillStyle = FAINT;
    ctx.fillText(price(v), chart.x1 + 6, y);
  }

  // unrevealed tape ghost
  ctx.strokeStyle = 'rgba(85,101,122,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let j = Math.max(start, cursor); j < visEnd; j++) {
    const x = gx(j), y = gy(Math.min(hi, Math.max(lo, candles[j][C])));
    if (j === Math.max(start, cursor)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // revealed candles: wick + close line
  ctx.lineWidth = 1;
  for (let j = start; j <= cursor && j < end; j++) {
    const c = candles[j];
    ctx.strokeStyle = c[C] >= c[O] ? 'rgba(74,222,128,0.35)' : 'rgba(248,113,113,0.35)';
    ctx.beginPath(); ctx.moveTo(gx(j), gy(c[H])); ctx.lineTo(gx(j), gy(c[L])); ctx.stroke();
  }
  ctx.beginPath();
  for (let j = start; j <= cursor && j < end; j++) {
    const x = gx(j), y = gy(candles[j][C]);
    if (j === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#d5dee8';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // grid levels, TP and stop
  if (snapshot?.position && cursor >= start) {
    const p = snapshot.position;
    const xa = gx(p.openedAt), xb = gx(Math.min(end - 1, cursor));
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (const lvl of p.levels) {
      const y = gy(lvl.price);
      ctx.beginPath();
      ctx.moveTo(xa, y); ctx.lineTo(chart.x1, y);
      ctx.strokeStyle = lvl.filled ? 'rgba(96,165,250,0.9)' : 'rgba(96,165,250,0.4)';
      ctx.setLineDash(lvl.filled ? [] : [3, 3]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = lvl.filled ? '#60a5fa' : 'rgba(96,165,250,0.55)';
      ctx.fillText(`L${lvl.k}${lvl.filled ? ' ✓' : ''}`, xa + 4, y - 1);
    }
    const yt = gy(p.tp), ys = gy(p.stop);
    ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(xa, yt); ctx.lineTo(chart.x1, yt); ctx.strokeStyle = GREEN; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(xa, ys); ctx.lineTo(chart.x1, ys); ctx.strokeStyle = RED; ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = GREEN; ctx.fillText(`TP ${price(p.tp)}`, xa + 4, yt - 1);
    ctx.fillStyle = RED; ctx.fillText(`STOP ${price(p.stop)}`, xa + 4, ys - 1);
    ctx.font = MONO;
    ctx.textBaseline = 'middle';
    // avg entry marker
    const ya = gy(p.avgEntry);
    ctx.beginPath(); ctx.moveTo(xb - 6, ya); ctx.lineTo(xb + 6, ya);
    ctx.strokeStyle = AMBER; ctx.lineWidth = 2; ctx.stroke();
  }

  // fill / exit marks
  for (const m of marks) {
    if (m.bar > cursor || m.bar < start) continue;
    const x = gx(m.bar), y = gy(m.price);
    ctx.beginPath();
    if (m.type === 'fill') {
      ctx.moveTo(x, y + 5); ctx.lineTo(x - 4, y - 3); ctx.lineTo(x + 4, y - 3); ctx.closePath();
      ctx.fillStyle = '#60a5fa';
    } else {
      ctx.moveTo(x, y - 5); ctx.lineTo(x - 4, y + 3); ctx.lineTo(x + 4, y + 3); ctx.closePath();
      ctx.fillStyle = m.reason === 'tp' ? GREEN : m.reason === 'stop' ? RED : AMBER;
    }
    ctx.fill();
  }

  // cursor
  if (cursor >= start && cursor < end) {
    ctx.strokeStyle = 'rgba(245,185,66,0.5)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(gx(cursor), chart.y0); ctx.lineTo(gx(cursor), strip.y1); ctx.stroke();
    ctx.setLineDash([]);
  }

  // equity strip
  ctx.fillStyle = 'rgba(255,255,255,0.02)';
  ctx.fillRect(strip.x0, strip.y0, strip.x1 - strip.x0, strip.y1 - strip.y0);
  const eqVals = [capital];
  for (let i = 0; i < equity.length; i++) eqVals.push(equity[i]);
  for (let j = start; j <= cursor && j < end; j++) eqVals.push(bh[j - start]);
  let elo = Math.min(...eqVals), ehi = Math.max(...eqVals);
  if (!(ehi > elo)) { ehi = elo + 1; }
  const ey = (v) => strip.y1 - ((v - elo) / (ehi - elo)) * (strip.y1 - strip.y0);
  ctx.strokeStyle = GRIDLINE;
  ctx.beginPath(); ctx.moveTo(strip.x0, ey(capital)); ctx.lineTo(strip.x1, ey(capital)); ctx.stroke();
  ctx.beginPath();
  for (let j = start; j <= cursor && j < end; j++) {
    const x = gx(j), y = ey(bh[j - start]);
    if (j === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(139,155,176,0.7)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < equity.length; i++) {
    const x = gx(start + i), y = ey(equity[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = TEAL;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillStyle = TEAL;
  ctx.fillText('PAPER EQUITY', strip.x0 + 4, strip.y1 + 14);
  ctx.fillStyle = MUTED;
  ctx.fillText('BUY & HOLD', strip.x0 + 92, strip.y1 + 14);
  ctx.textAlign = 'right';
  ctx.fillStyle = FAINT;
  if (cursor >= start && cursor < end) ctx.fillText(fmtTime(candles[Math.min(cursor, end - 1)][0]), strip.x1, strip.y1 + 14);
}
