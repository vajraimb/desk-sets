// Seeded pseudo-random numbers (sfc32). Same seed => same evolution, in every browser.

function hashSeed(seed) {
  // Accept numbers or strings; fold into four 32-bit words.
  const str = String(seed);
  let h1 = 0x9e3779b9, h2 = 0x243f6a88, h3 = 0xb7e15162, h4 = 0x6a09e667;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x85ebca6b);
    h2 = Math.imul(h2 ^ c, 0xc2b2ae35);
    h3 = Math.imul(h3 ^ c, 0x27d4eb2f);
    h4 = Math.imul(h4 ^ c, 0x165667b1);
  }
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function createRng(seed = 1) {
  let [a, b, c, d] = hashSeed(seed);

  function next() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  // Warm up so short seeds diverge quickly.
  for (let i = 0; i < 12; i++) next();

  let spareGauss = null;
  const rng = {
    seed,
    next,
    uniform(lo, hi) {
      return lo + (hi - lo) * next();
    },
    int(lo, hi) {
      // inclusive on both ends
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    chance(p) {
      return next() < p;
    },
    gauss() {
      if (spareGauss !== null) {
        const g = spareGauss;
        spareGauss = null;
        return g;
      }
      let u, v, s;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const m = Math.sqrt((-2 * Math.log(s)) / s);
      spareGauss = v * m;
      return u * m;
    },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
  return rng;
}
