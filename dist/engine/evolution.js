// Genetic algorithm over GridBot genomes: species quotas, immigrants, tournament
// selection, uniform crossover, Gaussian mutation, and an out-of-sample gate.

import { createRng } from './rng.js';
import { backtest, FAMILIES } from './bot.js';

export const GENES = [
  { key: 'family', label: 'Family', type: 'family', min: 0, max: 3 },
  { key: 'lookback', label: 'Lookback', type: 'int', min: 10, max: 200, unit: ' bars' },
  { key: 'entryZ', label: 'Entry Z', type: 'float', min: 0.2, max: 2.5, unit: 'σ', digits: 2 },
  { key: 'levels', label: 'Levels', type: 'int', min: 2, max: 8, unit: '' },
  { key: 'spacing', label: 'Spacing', type: 'pct', min: 0.003, max: 0.03 },
  { key: 'mult', label: 'Size mult', type: 'float', min: 1, max: 2, unit: '×', digits: 2 },
  { key: 'tp', label: 'Take profit', type: 'pct', min: 0.003, max: 0.04 },
  { key: 'stop', label: 'Stop', type: 'pct', min: 0.01, max: 0.12 },
];

export const DEFAULT_CONFIG = {
  population: 96,
  elites: 4,
  immigrants: 8,
  tournament: 3,
  mutationRate: 0.18,
  mutationSigma: 0.12, // as a fraction of the gene's range
  trainFraction: 0.7,
  ddWeight: 0.6,
  minTrades: 4,
  tradePenalty: 0.05,
  gate: { minReturn: 0.01, maxDD: 0.1, minTrades: 3, minWinRate: 0.5 },
  capital: 10_000,
  fee: 0.0005,
};

export function formatGene(gene, value) {
  switch (gene.type) {
    case 'family':
      return FAMILIES[value];
    case 'int':
      return `${value}${gene.unit ?? ''}`;
    case 'pct':
      return `${(value * 100).toFixed(2)}%`;
    default:
      return `${value.toFixed(gene.digits ?? 2)}${gene.unit ?? ''}`;
  }
}

export function fitnessOf(train, config = DEFAULT_CONFIG) {
  const penalty = train.trades < config.minTrades ? (config.minTrades - train.trades) * config.tradePenalty : 0;
  return train.ret - config.ddWeight * train.maxDD - penalty;
}

export function passesGate(oos, gate = DEFAULT_CONFIG.gate) {
  return oos.ret > gate.minReturn && oos.maxDD < gate.maxDD && oos.trades >= gate.minTrades && oos.winRate >= gate.minWinRate;
}

export function gateReasons(oos, gate = DEFAULT_CONFIG.gate) {
  const out = [];
  if (!(oos.ret > gate.minReturn)) out.push(`return ${(oos.ret * 100).toFixed(1)}% ≤ ${(gate.minReturn * 100).toFixed(0)}%`);
  if (!(oos.maxDD < gate.maxDD)) out.push(`drawdown ${(oos.maxDD * 100).toFixed(1)}% ≥ ${(gate.maxDD * 100).toFixed(0)}%`);
  if (!(oos.trades >= gate.minTrades)) out.push(`${oos.trades} trades < ${gate.minTrades}`);
  if (!(oos.winRate >= gate.minWinRate)) out.push(`win rate ${(oos.winRate * 100).toFixed(0)}% < ${(gate.minWinRate * 100).toFixed(0)}%`);
  return out;
}

export class Evolution {
  constructor(candles, { seed = 1, config = {} } = {}) {
    this.candles = candles;
    this.seed = seed;
    this.config = { ...DEFAULT_CONFIG, ...config, gate: { ...DEFAULT_CONFIG.gate, ...(config.gate || {}) } };
    this.rng = createRng(seed);
    this.split = Math.max(2, Math.floor(candles.length * this.config.trainFraction));
    // Thin histories (recent IPOs) get a tighter lookback ceiling so that the
    // train window still leaves room for signals to fire.
    this.maxLookback = Math.max(10, Math.min(200, Math.floor(this.split / 4)));
    this.geneRanges = GENES.map((g) => (g.key === 'lookback' ? { ...g, max: this.maxLookback } : g));
    this.population = [];
    this.generation = 0;
    this.history = [];
    this.leader = null;
    this.leaderSince = 0;
    this.nextId = 1;
    this.lastStep = null;
    this.init();
  }

  get trainRange() {
    return [0, this.split];
  }

  get oosRange() {
    return [this.split, this.candles.length];
  }

  // ---- genomes -------------------------------------------------------------

  randomGene(gene) {
    if (gene.type === 'family') return this.rng.int(0, 3);
    if (gene.type === 'int') return this.rng.int(gene.min, gene.max);
    return this.rng.uniform(gene.min, gene.max);
  }

  randomGenome(family) {
    const g = {};
    for (const gene of this.geneRanges) g[gene.key] = this.randomGene(gene);
    if (family !== undefined) g.family = family;
    return g;
  }

  crossover(a, b) {
    const child = {};
    for (const gene of this.geneRanges) child[gene.key] = this.rng.chance(0.5) ? a[gene.key] : b[gene.key];
    return child;
  }

  mutate(genome) {
    const out = { ...genome };
    const { mutationRate, mutationSigma } = this.config;
    for (const gene of this.geneRanges) {
      if (gene.type === 'family') continue; // species membership is fixed by the quota slot
      if (!this.rng.chance(mutationRate)) continue;
      const range = gene.max - gene.min;
      let v = out[gene.key] + this.rng.gauss() * mutationSigma * range;
      v = Math.min(gene.max, Math.max(gene.min, v));
      out[gene.key] = gene.type === 'int' ? Math.round(v) : v;
    }
    return out;
  }

  // ---- evaluation ----------------------------------------------------------

  evaluate(ind) {
    const opts = { capital: this.config.capital, fee: this.config.fee };
    ind.train = backtest(ind.genome, this.candles, 0, this.split, opts);
    ind.oos = backtest(ind.genome, this.candles, this.split, this.candles.length, opts);
    ind.fitness = fitnessOf(ind.train, this.config);
    ind.passes = passesGate(ind.oos, this.config.gate);
    return ind;
  }

  makeIndividual(genome, origin, parents = []) {
    return this.evaluate({ id: this.nextId++, genome, origin, parents, born: this.generation, age: 0 });
  }

  tournament(pool) {
    let best = null;
    for (let i = 0; i < this.config.tournament; i++) {
      const c = this.rng.pick(pool);
      if (!best || c.fitness > best.fitness) best = c;
    }
    return best;
  }

  // ---- lifecycle -----------------------------------------------------------

  init() {
    const { population } = this.config;
    for (let i = 0; i < population; i++) {
      this.population.push(this.makeIndividual(this.randomGenome(i % FAMILIES.length), 'seed'));
    }
    this.pickLeader();
    this.record({ births: this.population.map((p) => p.id), deaths: [], survivors: [] });
  }

  pickLeader() {
    let best = null;
    for (const ind of this.population) {
      if (!ind.passes) continue;
      if (!best || ind.fitness > best.fitness) best = ind;
    }
    if (best && best !== this.leader) this.leaderSince = this.generation;
    if (!best) this.leaderSince = this.generation;
    this.leader = best;
    return best;
  }

  record(step) {
    const fits = this.population.map((p) => p.fitness);
    const best = this.population.reduce((a, b) => (b.fitness > a.fitness ? b : a));
    const passers = this.population.filter((p) => p.passes).length;
    const entry = {
      gen: this.generation,
      best: Math.max(...fits),
      mean: fits.reduce((a, b) => a + b, 0) / fits.length,
      bestId: best.id,
      leaderId: this.leader ? this.leader.id : null,
      leaderOOS: this.leader ? this.leader.oos.ret : null,
      leaderFitness: this.leader ? this.leader.fitness : null,
      passers,
      births: step.births.length,
      deaths: step.deaths.length,
    };
    this.history.push(entry);
    this.lastStep = { ...step, stats: entry };
    return entry;
  }

  /** Breed one generation. Returns the birth/death ledger for the UI. */
  stepGeneration() {
    const cfg = this.config;
    const prev = this.population;
    this.generation += 1;

    // Elites: top overall, best of each species, plus the deployed leader.
    const sorted = [...prev].sort((a, b) => b.fitness - a.fitness || a.id - b.id);
    const keep = new Set(sorted.slice(0, cfg.elites));
    for (let s = 0; s < FAMILIES.length; s++) {
      const bestOfSpecies = sorted.find((p) => p.genome.family === s);
      if (bestOfSpecies) keep.add(bestOfSpecies);
    }
    if (this.leader && prev.includes(this.leader)) keep.add(this.leader);
    const survivors = sorted.filter((p) => keep.has(p));
    for (const s of survivors) s.age += 1;
    const deaths = prev.filter((p) => !keep.has(p));

    const births = [];
    for (let i = 0; i < cfg.immigrants; i++) {
      births.push(this.makeIndividual(this.randomGenome(i % FAMILIES.length), 'immigrant'));
    }

    // Species quotas for offspring.
    const slots = cfg.population - survivors.length - births.length;
    const perSpecies = Math.floor(slots / FAMILIES.length);
    let extra = slots - perSpecies * FAMILIES.length;
    for (let s = 0; s < FAMILIES.length; s++) {
      let quota = perSpecies + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      const speciesPool = prev.filter((p) => p.genome.family === s);
      const pool = speciesPool.length >= 2 ? speciesPool : prev;
      for (let i = 0; i < quota; i++) {
        const pa = this.tournament(pool);
        const pb = this.tournament(pool);
        const child = this.mutate(this.crossover(pa.genome, pb.genome));
        child.family = s;
        births.push(this.makeIndividual(child, 'offspring', [pa.id, pb.id]));
      }
    }

    this.population = [...survivors, ...births];
    this.pickLeader();
    this.record({
      births: births.map((b) => b.id),
      deaths: deaths.map((d) => d.id),
      survivors: survivors.map((s) => s.id),
    });
    return this.lastStep;
  }

  speciesCounts() {
    const counts = FAMILIES.map(() => 0);
    for (const p of this.population) counts[p.genome.family] += 1;
    return counts;
  }
}
