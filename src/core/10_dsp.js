/* Audio analysis: spectral onsets, tempo, a constant-tempo beat grid (Beat Saber
 * needs constant BPM), downbeats, per-beat energy and song sections. */
(function (ns) {
  'use strict';
  const FFT_N = 1024;

  function makeFFT(n) {
    const levels = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, y = 0;
      for (let k = 0; k < levels; k++) { y = (y << 1) | (x & 1); x >>= 1; }
      rev[i] = y;
    }
    const cosT = new Float64Array(n / 2), sinT = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cosT[i] = Math.cos(2 * Math.PI * i / n);
      sinT[i] = Math.sin(2 * Math.PI * i / n);
    }
    return function (re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tr = re[l] * cosT[k] + im[l] * sinT[k];
            const ti = im[l] * cosT[k] - re[l] * sinT[k];
            re[l] = re[j] - tr; im[l] = im[j] - ti;
            re[j] += tr; im[j] += ti;
          }
        }
      }
    };
  }

  // Subtract a centred moving mean (half-wave rectified) - removes slow background.
  function movingMeanSubtract(x, W) {
    const n = x.length, out = new Float32Array(n), pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
    const h = Math.max(1, W >> 1);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
      const m = (pre[b] - pre[a]) / (b - a);
      out[i] = Math.max(0, x[i] - m);
    }
    return out;
  }

  function scaleByPercentile(x, p) {
    const s = Float64Array.from(x).sort();
    let ref = s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    if (!(ref > 0)) ref = 1;
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = Math.min(1, x[i] / ref);
    return out;
  }

  function autocorrAt(env, lag) {
    const n = env.length - lag;
    if (n <= 0) return 0;
    let s = 0;
    for (let t = 0; t < n; t++) s += env[t] * env[t + lag];
    return s / n;
  }

  // Tempo from the autocorrelation of the onset envelope (60-200 BPM, mild prior around 120). A candidate must also
  // repeat at 2, 3 and 4 beats and have a half-beat texture: that rejects 3:2 mistakes (172.8 read as 115.2).
  function estimateTempo(env, fps) {
    const minLag = 1;
    const maxBeatLag = Math.ceil(fps * 60 / 60) + 2;
    const maxLag = maxBeatLag * 4 + 3;
    const ac = new Float64Array(maxLag + 2);
    for (let L = minLag; L <= maxLag + 1; L++) ac[L] = autocorrAt(env, L);
    const zero = autocorrAt(env, 0) || 1;
    const at = function (lag) {
      if (lag < 1) return 0;
      const L = Math.floor(lag), f = lag - L;
      if (L + 1 >= ac.length) return 0;
      return ac[L] * (1 - f) + ac[L + 1] * f;
    };
    const rawOf = function (bpm) {
      const L = fps * 60 / bpm;
      return at(L) + 0.75 * at(2 * L) + 0.5 * at(3 * L) + 0.5 * at(4 * L) + 0.45 * at(L / 2);
    };
    const scoreOf = function (bpm) {
      const w = Math.exp(-0.5 * Math.pow((Math.log2(bpm) - Math.log2(120)) / 1.2, 2));
      return rawOf(bpm) * (0.8 + 0.2 * w);
    };
    let bestBpm = 120, bestScore = -Infinity;
    for (let bpm = 60; bpm <= 200; bpm += 0.1) {
      const sc = scoreOf(bpm);
      if (sc > bestScore) { bestScore = sc; bestBpm = bpm; }
    }
    // Resolve octave ambiguity: prefer the candidate closest to 120 BPM when it is nearly as strong.
    const cands = [bestBpm];
    if (bestBpm * 2 <= 200) cands.push(bestBpm * 2);
    if (bestBpm / 2 >= 60) cands.push(bestBpm / 2);
    let pick = bestBpm, pickScore = -Infinity;
    for (const c of cands) {
      const sc = scoreOf(c) * (1 + 0.06 * Math.exp(-Math.abs(Math.log2(c / 120))));
      if (sc > pickScore) { pickScore = sc; pick = c; }
    }
    return { bpm: pick, confidence: Math.min(1, Math.max(0, at(fps * 60 / pick) / zero)) };
  }

  /* Exact tempo and beat phase. Fold the onset envelope on a trial period: when the period is exactly right every
   * beat lands on the same phase and the folded profile becomes a sharp spike, so the score (sum of squares) peaks.
   * Coarse-to-fine over a growing part of the song gives a period accurate to a few parts per million; a regression
   * of the local phase over the song then removes whatever drift is left. */
  function foldProfile(env, fps, P, B, n, prof, from) {
    prof.fill(0);
    const Pf = P * fps, m = Math.min((from || 0) + n, env.length);
    for (let f = from || 0; f < m; f++) {
      const v = env[f];
      if (v < 0.03) continue;
      const x = ((f / Pf) % 1) * B, b0 = Math.floor(x), fr = x - b0;
      prof[b0 % B] += v * (1 - fr);
      prof[(b0 + 1) % B] += v * fr;
    }
  }
  function foldScore(env, fps, P, B, n, prof, from) {
    foldProfile(env, fps, P, B, n, prof, from);
    let sc = 0;
    for (let b = 0; b < B; b++) sc += prof[b] * prof[b];
    return sc;
  }
  // Concentration of the onsets on a trial period: length of the resultant vector of the onset phases at harmonics
  // 1, 2 and 4 of the beat (not 3, so a 3:2 mistake cannot score well). Smooth in P, no binning artefacts.
  function periodScore(T, W, P, i0, i1) {
    let r1 = 0, q1 = 0, r2 = 0, q2 = 0, r4 = 0, q4 = 0, sw = 0;
    const TP = 2 * Math.PI / P;
    for (let i = i0; i < i1; i++) {
      const th = T[i] * TP, c = Math.cos(th), sn = Math.sin(th), w = W[i];
      const c2 = c * c - sn * sn, s2 = 2 * c * sn, c4 = c2 * c2 - s2 * s2, s4 = 2 * c2 * s2;
      r1 += w * c; q1 += w * sn; r2 += w * c2; q2 += w * s2; r4 += w * c4; q4 += w * s4; sw += w;
    }
    if (sw <= 0) return 0;
    return ((r1 * r1 + q1 * q1) + 0.6 * (r2 * r2 + q2 * q2) + 0.4 * (r4 * r4 + q4 * q4)) / (sw * sw);
  }
  function lowerIdx(T, t) { let lo = 0, hi = T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; } return lo; }
  // Beam search over the period: each stage keeps the best few local maxima, so a false alias from an early
  // (short) stage cannot lock the answer in. Returns { P, score } at full song length.
  function refineTempo(T, W, duration, bpm0, span) {
    if (T.length < 16) return { P: 60 / bpm0, score: 0 };
    // the busiest stretch of the song is the best place to start (intros are often beatless)
    const win = Math.min(duration, 24);
    let w0 = 0, bestN = -1;
    for (let t0 = 0; t0 + win <= duration + 1e-9; t0 += 2) {
      const n = lowerIdx(T, t0 + win) - lowerIdx(T, t0);
      if (n > bestN) { bestN = n; w0 = t0; }
    }
    const a2 = Math.max(0, Math.min(w0 - 23, duration - 70));
    const stages = [
      [span || 0.02, 5e-5, lowerIdx(T, w0), lowerIdx(T, w0 + win)],
      [4e-4, 1e-5, lowerIdx(T, a2), lowerIdx(T, a2 + 70)],
      [8e-5, 2e-6, 0, T.length],
      [1.2e-5, 4e-7, 0, T.length]
    ];
    let centers = [60 / bpm0];
    for (let si = 0; si < stages.length; si++) {
      const st = stages[si], found = [];
      for (const c of centers) {
        const steps = Math.round(st[0] / st[1]);
        const sc = new Float64Array(2 * steps + 1);
        for (let k = -steps; k <= steps; k++) sc[k + steps] = periodScore(T, W, c * (1 + k * st[1]), st[2], st[3]);
        for (let k = 0; k < sc.length; k++) {
          if ((k === 0 || sc[k] >= sc[k - 1]) && (k === sc.length - 1 || sc[k] > sc[k + 1])) found.push({ P: c * (1 + (k - steps) * st[1]), s: sc[k] });
        }
      }
      found.sort(function (a, b) { return b.s - a.s; });
      const keep = [];
      for (const f of found) {
        if (keep.every(function (q) { return Math.abs(q.P / f.P - 1) > st[1] * 3; })) keep.push(f);
        if (keep.length >= 8) break;
      }
      centers = keep.map(function (q) { return q.P; });
      if (si === stages.length - 1) return { P: keep[0].P, score: keep[0].s };
    }
  }
  // Move the phase onto the weighted centre of the onsets that sit near the beat (sub-frame accurate).
  function centreGrid(T, W, P, A) {
    for (let it = 0; it < 3; it++) {
      let sx = 0, sw = 0;
      const tol = Math.min(0.03, 0.12 * P);
      for (let k = Math.ceil((T[0] - A) / P); ; k++) {
        const g = A + k * P;
        if (g > T[T.length - 1] + P) break;
        const j = lowerIdx(T, g - tol);
        for (let q = j; q < T.length && T[q] <= g + tol; q++) { sx += W[q] * (T[q] - g); sw += W[q]; }
      }
      if (sw > 0) A += sx / sw;
    }
    return ((A % P) + P) % P;
  }

  // Phase of the beat grid: peak of the folded profile of the phase envelope (kick-weighted), sub-bin by parabola.
  function foldPhase(phaseEnv, fps, P, from, to) {
    const B = 192, prof = new Float64Array(B);
    prof.fill(0);
    const Pf = P * fps;
    for (let f = from; f < Math.min(to, phaseEnv.length); f++) {
      const v = phaseEnv[f];
      if (v < 0.03) continue;
      const x = ((f / Pf) % 1) * B, b0 = Math.floor(x), fr = x - b0;
      prof[b0 % B] += v * (1 - fr);
      prof[(b0 + 1) % B] += v * fr;
    }
    const sm = new Float64Array(B);
    for (let b = 0; b < B; b++) sm[b] = 0.25 * prof[(b + B - 1) % B] + 0.5 * prof[b] + 0.25 * prof[(b + 1) % B];
    let bi = 0;
    for (let b = 1; b < B; b++) if (sm[b] > sm[bi]) bi = b;
    const y0 = sm[(bi + B - 1) % B], y1 = sm[bi], y2 = sm[(bi + 1) % B];
    const den = y0 - 2 * y1 + y2;
    const d = den < 0 ? 0.5 * (y0 - y2) / den : 0;
    let w = 0; for (let b = 0; b < B; b++) w += prof[b];
    return { phase: (((bi + d) / B) % 1 + 1) % 1 * P, weight: w, peak: y1 };
  }

  // Dynamic-programming beat tracker (Ellis 2007) with a fixed period.
  function trackBeats(env, fps, bpm) {
    const P = fps * 60 / bpm;
    const F = env.length;
    const score = new Float64Array(F);
    const back = new Int32Array(F).fill(-1);
    const lambda = 100;
    for (let t = 0; t < F; t++) {
      let best = -Infinity, bt = -1;
      const tmin = Math.max(0, Math.floor(t - 2 * P));
      const tmax = Math.floor(t - P / 2);
      for (let tau = tmin; tau <= tmax; tau++) {
        const d = (t - tau) / P;
        const v = score[tau] - lambda * Math.pow(Math.log(d), 2);
        if (v > best) { best = v; bt = tau; }
      }
      if (bt >= 0) { score[t] = env[t] + best; back[t] = bt; }
      else score[t] = env[t];
    }
    const tailStart = Math.max(0, F - Math.ceil(P));
    let t = tailStart;
    for (let i = tailStart; i < F; i++) if (score[i] > score[t]) t = i;
    const path = [];
    while (t >= 0) { path.push(t); t = back[t]; }
    path.reverse();
    return path;
  }

  // Least-squares fit of beat times: t_i = a + i * P.
  function fitGrid(times) {
    const n = times.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += times[i]; sxx += i * i; sxy += i * times[i]; }
    const den = n * sxx - sx * sx;
    const P = den ? (n * sxy - sx * sy) / den : 0.5;
    const a = (sy - P * sx) / n;
    return { P: P, a: a };
  }

  // Beat tracker + robust regression: precise on real songs once the period is already close (it follows
  // the actual beats instead of a statistic). Returns null when the track is unusable.
  const DRIFT_FIX = false;   // the comb-phase line is only reported: on real songs the beat tracker is the better period
  function dpRefine(onset, fps, P0) {
    const path = trackBeats(onset, fps, 60 / P0);
    const times = path.map(function (f) { return f / fps; });
    if (times.length < 8) return null;
    let fit = fitGrid(times);
    for (let pass = 0; pass < 2; pass++) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
      for (let i = 0; i < times.length; i++) {
        if (Math.abs(times[i] - (fit.a + i * fit.P)) >= 0.1 * fit.P) continue;
        sx += i; sy += times[i]; sxx += i * i; sxy += i * times[i]; m++;
      }
      const den = m * sxx - sx * sx;
      if (m < 8 || !den) return null;
      const Pn = (m * sxy - sx * sy) / den;
      fit = { P: Pn, a: (sy - Pn * sx) / m };
    }
    return fit;
  }

  // Local maxima of the (0..1 normalised) onset envelope: the song's note-worthy events. Times are interpolated
  // between frames (parabola through the peak) so they are good to about a millisecond.
  function onsetPeaksW(env, fps, thr, sepSec) {
    const minSep = Math.max(1, Math.round((sepSec || 0.045) * fps));
    const t = [], w = [];
    let last = -1e9;
    const th = thr === undefined ? 0.22 : thr;
    for (let i = 1; i < env.length - 1; i++) {
      if (env[i] > th && env[i] >= env[i - 1] && env[i] > env[i + 1] && i - last >= minSep) {
        const y0 = env[i - 1], y1 = env[i], y2 = env[i + 1], den = y0 - 2 * y1 + y2;
        const d = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0;
        t.push((i + d) / fps); w.push(y1); last = i;
      }
    }
    return { t: t, w: w };
  }
  function onsetPeaks(env, fps) { return onsetPeaksW(env, fps).t; }

  // Pick the metrical octave. Autocorrelation often finds half time (92.5 for a 185 BPM song). If onsets arrive
  // much faster than the pulse, the real beat is the faster octave. opts.bpmHint (a map's own BPM) wins when the
  // detected tempo is an exact octave of it; opts.tempoScale (0.5 or 2) is the user's manual override.
  function chooseOctave(bpm, onsetRate, opts) {
    let tb = bpm;
    const hint = opts && opts.bpmHint;
    if (hint) {
      let best = null;
      for (const f of [0.5, 1, 2]) {
        const c = bpm * f;
        if (Math.abs(Math.log(c / hint)) < 0.06 && (!best || Math.abs(Math.log(c / hint)) < Math.abs(Math.log(best / hint)))) best = c;
      }
      if (best) return best;
    }
    while (tb < 100 && onsetRate / (tb / 60) > 3.2 && tb * 2 <= 210) tb *= 2;
    if (opts && opts.tempoScale) tb *= opts.tempoScale;
    return Math.max(50, Math.min(240, tb));
  }

  /* analyzeAudio(samples: Float32Array mono, sr: number, opts?: { bpmHint, tempoScale }) -> analysis object */
  function analyzeAudio(samples, sr, opts) {
    const N = FFT_N;
    const hop = Math.max(1, Math.round(sr / 100));
    const fps = sr / hop;
    const n = samples.length;
    const duration = n / sr;
    const frames = Math.max(8, Math.floor((n - N) / hop) + 1);
    const fft = makeFFT(N);
    const nb = N / 2 + 1;
    const binHz = sr / N;
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));

    const BANDS = [[30, 120], [120, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 8000], [8000, 16000]];
    const NBANDS = BANDS.length;
    const bandBins = BANDS.map(function (b) {
      return [Math.max(1, Math.round(b[0] / binHz)), Math.min(nb - 1, Math.round(b[1] / binHz))];
    });
    const bassLo = Math.max(1, Math.round(30 / binHz)), bassHi = Math.min(nb - 1, Math.round(200 / binHz));
    const highLo = Math.min(nb - 1, Math.round(3000 / binHz));

    const flux = new Float32Array(frames);
    const fluxBass = new Float32Array(frames);
    const fluxHigh = new Float32Array(frames);
    const rms = new Float32Array(frames);
    // instrument sensing: flux per spectral region, plus where the mid-range energy sits (a pitch proxy)
    const GR = [[30, 150], [150, 500], [500, 3000], [3000, 8000], [8000, 16000]].map(function (g) {
      return [Math.max(1, Math.round(g[0] / binHz)), Math.min(nb - 1, Math.round(g[1] / binHz))];
    });
    const gflux = GR.map(function () { return new Float32Array(frames); });
    const midCent = new Float32Array(frames);
    const lo3 = Math.max(1, Math.round(500 / binHz)), hi3 = Math.min(nb - 1, Math.round(3000 / binHz));
    const bands = new Float32Array(frames * NBANDS);
    const re = new Float64Array(N), im = new Float64Array(N);
    let prev = new Float64Array(nb), cur = new Float64Array(nb);

    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      let e = 0;
      for (let i = 0; i < N; i++) {
        const idx = off + i - (N >> 1);   // frame f is centred on f*hop, so f/fps is the true time
        if (idx < 0) { re[i] = 0; im[i] = 0; continue; }
        const s = idx < n ? samples[idx] : 0;
        re[i] = s * win[i]; im[i] = 0; e += s * s;
      }
      rms[f] = Math.sqrt(e / N);
      fft(re, im);
      for (let k = 0; k < nb; k++) {
        cur[k] = Math.log(1 + 100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]) / N);
      }
      for (let b = 0; b < NBANDS; b++) {
        const lo = bandBins[b][0], hi = bandBins[b][1];
        let s = 0;
        for (let k = lo; k <= hi; k++) s += cur[k];
        bands[f * NBANDS + b] = s / Math.max(1, hi - lo + 1);
      }
      if (f > 0) {
        let fa = 0, fb = 0, fh = 0;
        for (let k = 1; k < nb; k++) {
          const d = cur[k] - prev[k];
          if (d > 0) {
            fa += d;
            if (k >= bassLo && k <= bassHi) fb += d;
            if (k >= highLo) fh += d;
          }
        }
        flux[f] = fa; fluxBass[f] = fb; fluxHigh[f] = fh;
        for (let g = 0; g < GR.length; g++) {
          let gs = 0;
          for (let k = GR[g][0]; k <= GR[g][1]; k++) { const d = cur[k] - prev[k]; if (d > 0) gs += d; }
          gflux[g][f] = gs;
        }
      }
      {
        let wsum = 0, lsum = 0;
        for (let k = lo3; k <= hi3; k++) { wsum += cur[k]; lsum += cur[k] * Math.log2(k * binHz / 500); }
        midCent[f] = wsum > 0 ? ns.clamp(lsum / wsum / Math.log2(6), 0, 1) : 0.5;
      }
      const tmp = prev; prev = cur; cur = tmp;
    }

    const W = Math.max(3, Math.round(fps));
    const onset = scaleByPercentile(movingMeanSubtract(flux, W), 0.97);
    const bassEnv = scaleByPercentile(movingMeanSubtract(fluxBass, W), 0.97);
    const highEnv = scaleByPercentile(movingMeanSubtract(fluxHigh, W), 0.97);

    const gEnv = gflux.map(function (g) { return scaleByPercentile(movingMeanSubtract(g, W), 0.97); });
    const inst = senseInstruments(gEnv, midCent, fps, frames);
    // a more sensitive onset curve: any instrument's attack counts
    const onset2 = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      onset2[f] = Math.max(onset[f], 0.95 * inst.env.kick[f], 0.9 * inst.env.snare[f], 0.75 * inst.env.hat[f], 0.9 * inst.env.lead[f]);
    }

    // Tempo and a regular grid (regression on the tracked beats, outliers removed once).
    const tempo = estimateTempo(onset, fps);
    const peaks = onsetPeaks(onset, fps);
    const onsetRate = peaks.length / Math.max(1, duration);
    const detectedBpm = tempo.bpm;
    tempo.bpm = chooseOctave(tempo.bpm, onsetRate, opts);
    // exact period and phase from folding (see refineTempo); the old beat tracker is not needed any more
    const phaseEnv = new Float32Array(frames);
    for (let f = 0; f < frames; f++) phaseEnv[f] = Math.min(1, onset2[f] + 0.7 * inst.env.kick[f] + 0.4 * bassEnv[f]);
    const pk = onsetPeaksW(onset2, fps, 0.18, 0.04);
    let best = null;
    {
      const base = tempo.bpm;
      const ratios = (opts && opts.tempoScale) ? [1] : [1, 1.5, 2 / 3, 4 / 3, 0.75];
      const cand = [];
      for (const r of ratios) {
        const b = base * r;
        if (b < 62 || b > 215) continue;
        const rf = refineTempo(pk.t, pk.w, duration, b, r === 1 ? 0.02 : 0.012);
        cand.push({ r: r, P: rf.P, score: rf.score });
      }
      best = cand[0];
      // a different ratio only wins when its onsets are clearly more concentrated than the first guess
      for (const c of cand) if (c.r !== 1 && c.score > cand[0].score * 1.3 && c.score > best.score) best = c;
      tempo.ratioFix = best.r;
      if (opts && opts.bpmHint) {   // a map's own BPM settles any 3:2 ambiguity
        for (const c of cand) if (Math.abs(Math.log((60 / c.P) / opts.bpmHint)) < 0.02) { best = c; break; }
      }
    }
    let P = best.P;
    if (!(P > 0.2 && P < 1.5)) P = 60 / tempo.bpm;
    let A = foldPhase(phaseEnv, fps, P, 0, frames).phase;
    {
      const dp = dpRefine(onset, fps, P);
      if (dp && Math.abs(dp.P / P - 1) < 8e-4) { P = dp.P; A = ((dp.a % P) + P) % P; }
    }
    // the phase envelope is kick-weighted; re-centre on the actual onsets near each beat
    {
      const kt = [], kw = [];
      for (let q = 0; q < pk.t.length; q++) { kt.push(pk.t[q]); const f = Math.min(frames - 1, Math.round(pk.t[q] * fps)); kw.push(pk.w[q] * (0.5 + inst.env.kick[f] + 0.3 * bassEnv[f])); }
      A = centreGrid(kt, kw, P, A);
    }
    // residual drift: the local phase of the onset comb (circular mean at the half beat, no window, so a drift of any
    // size is visible) in every ~12 s chunk, then a line through those phases corrects the period. Iterated.
    const drift = { beforeMs: 0, afterMs: 0, slopePpm: 0, chunks: 0 };
    const kt2 = [], kw2 = [];
    for (let q = 0; q < pk.t.length; q++) { kt2.push(pk.t[q]); const f = Math.min(frames - 1, Math.round(pk.t[q] * fps)); kw2.push(pk.w[q] * (0.5 + inst.env.kick[f] + 0.3 * bassEnv[f])); }
    const localPhases = function (Pg, Ag) {
      const pts = [], CH = 12, half = Pg / 2, TPI = 4 * Math.PI / Pg;
      for (let c0 = 0; c0 + CH * 0.6 <= duration; c0 += CH) {
        const i0 = lowerIdx(pk.t, c0), i1 = lowerIdx(pk.t, c0 + CH);
        let r = 0, q = 0, sw = 0;
        for (let i = i0; i < i1; i++) { const th = pk.t[i] * TPI, w = pk.w[i]; r += w * Math.cos(th); q += w * Math.sin(th); sw += w; }
        if (i1 - i0 < 12 || sw <= 0 || Math.sqrt(r * r + q * q) / sw < 0.12) continue;
        let d = Math.atan2(q, r) / TPI - (((Ag % half) + half) % half);
        d -= Math.round(d / half) * half;
        pts.push({ t: (Math.min(duration, c0 + CH) + c0) / 2, d: d });
      }
      return pts;
    };
    const fitLine = function (pts) {
      let st = 0, sd = 0, stt = 0, std = 0;
      pts.forEach(function (q) { st += q.t; sd += q.d; stt += q.t * q.t; std += q.t * q.d; });
      const n = pts.length, den = n * stt - st * st;
      return den ? (n * std - st * sd) / den : 0;
    };
    const spreadMs = function (pts, slope) {
      let lo = Infinity, hi = -Infinity;
      pts.forEach(function (q) { const r = q.d - slope * q.t; lo = Math.min(lo, r); hi = Math.max(hi, r); });
      return (hi - lo) * 1000;
    };
    {
      let pts = localPhases(P, A);
      if (pts.length >= 5) {
        drift.chunks = pts.length;
        drift.beforeMs = spreadMs(pts, 0);
        let total = 0;
        for (let it = 0; it < 3; it++) {
          pts = localPhases(P, A);
          if (pts.length < 5) break;
          const slope = fitLine(pts);
          if (Math.abs(slope) > 6e-4 || Math.abs(slope) < 1e-6) break;
          const gain = spreadMs(pts, 0) - spreadMs(pts, slope);
          if (it === 0 && (gain < 3 || !DRIFT_FIX)) break;       // phases are flat enough: leave the period alone
          P *= (1 + slope); total += slope;
        }
        if (total) { A = centreGrid(kt2, kw2, P, A); drift.slopePpm = Math.round(total * 1e6); }
        drift.afterMs = spreadMs(localPhases(P, A), 0);
      }
    }
    const bpm = 60 / P;

    // Beat lattice t_k = A + k*P for k = 0..K-1 (covers the whole song).
    const K = Math.max(2, Math.ceil((duration - A) / P) + 2);
    const beatT = new Float64Array(K + 1);
    for (let k = 0; k <= K; k++) beatT[k] = A + k * P;

    // Per-beat features.
    const beatEnergyRaw = new Float64Array(K);
    const beatBass = new Float32Array(K), beatHigh = new Float32Array(K), beatOnset = new Float32Array(K);
    const beatBands = new Float32Array(K * NBANDS);
    for (let k = 0; k < K; k++) {
      const f0 = Math.min(frames - 1, Math.max(0, Math.floor(beatT[k] * fps)));
      const f1 = Math.min(frames, Math.max(f0 + 1, Math.floor(beatT[k + 1] * fps)));
      let er = 0, bb = 0, hh = 0, oo = 0;
      const bandAcc = new Float64Array(NBANDS);
      for (let f = f0; f < f1; f++) {
        er += rms[f];
        if (bassEnv[f] > bb) bb = bassEnv[f];
        if (highEnv[f] > hh) hh = highEnv[f];
        if (onset[f] > oo) oo = onset[f];
        for (let b = 0; b < NBANDS; b++) bandAcc[b] += bands[f * NBANDS + b];
      }
      const cnt = Math.max(1, f1 - f0);
      beatEnergyRaw[k] = Math.log(er / cnt + 1e-5);
      beatBass[k] = bb; beatHigh[k] = hh; beatOnset[k] = oo;
      for (let b = 0; b < NBANDS; b++) beatBands[k * NBANDS + b] = bandAcc[b] / cnt;
    }
    // timbral brightness per beat: high-band minus low-band level, scaled across the song (dark / warm .. bright / airy)
    const beatBright = new Float32Array(K);
    {
      const raw = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        let hi = 0, lo = 0;
        for (let b = 5; b < NBANDS; b++) hi += beatBands[k * NBANDS + b];
        for (let b = 1; b < 4; b++) lo += beatBands[k * NBANDS + b];
        raw[k] = hi / (NBANDS - 5) - lo / 3;
      }
      const srt = Float64Array.from(raw).sort();
      const lo5 = srt[Math.floor(0.05 * (K - 1))], hi95 = srt[Math.floor(0.95 * (K - 1))];
      for (let k = 0; k < K; k++) beatBright[k] = ns.clamp((raw[k] - lo5) / Math.max(1e-6, hi95 - lo5), 0, 1);
    }
    const sortedE = Float64Array.from(beatEnergyRaw).sort();
    const eLo = sortedE[Math.floor(0.05 * (K - 1))], eHi = sortedE[Math.floor(0.95 * (K - 1))];
    const beatEnergy = new Float32Array(K);
    for (let k = 0; k < K; k++) beatEnergy[k] = ns.clamp((beatEnergyRaw[k] - eLo) / Math.max(1e-6, eHi - eLo), 0, 1);

    // Downbeat: which of the 4 phases carries the strongest bass hits.
    let downbeat = 0, bestDb = -Infinity;
    for (let o = 0; o < 4; o++) {
      let on = 0, cOn = 0, off = 0, cOff = 0;
      for (let k = 0; k < K; k++) {
        if (k % 4 === o) { on += beatBass[k]; cOn++; } else { off += beatBass[k]; cOff++; }
      }
      const sc = (cOn ? on / cOn : 0) - (cOff ? off / cOff : 0);
      if (sc > bestDb) { bestDb = sc; downbeat = o; }
    }

    // Sections from beat-synchronous spectral novelty.
    const sections = detectSections(beatBands, beatEnergy, K, NBANDS, downbeat);
    const peaks2 = onsetPeaks(onset2, fps);
    const study = studyBars(inst, A, P, downbeat, K, sections);

    return {
      sr: sr, hop: hop, fps: fps, duration: duration,
      bpm: bpm, period: P, phase: A, tempoConfidence: tempo.confidence,
      beatCount: K, beatTimes: beatT,
      beatEnergy: beatEnergy, beatBright: beatBright, beatBass: beatBass, beatHigh: beatHigh, beatOnset: beatOnset,
      downbeat: downbeat,
      onset: onset, frames: frames,
      onsetRate: onsetRate, onsetTimes: Float32Array.from(peaks2), onset2: onset2,
      inst: inst.events, instEnv: inst.env, study: study,
      detectedBpm: detectedBpm, tempoOctave: tempo.bpm / detectedBpm,
      sections: sections, drift: drift
    };
  }

  /* Instrument sensing. Each spectral region's attack curve is peak-picked into events:
   *   kick   low band attacks (30-150 Hz)
   *   snare  attacks that are loud in both the low-mid body and the high noise, not just the low end (snare, clap)
   *   hat    attacks in the air band (3-16 kHz) with no body
   *   lead   mid-range attacks (500-3000 Hz): synths, vocals, guitars; carries a pitch proxy 0..1
   * Events are {t, s (strength 0..1), p (pitch proxy, lead only)}. */
  function senseInstruments(gEnv, midCent, fps, frames) {
    const low = gEnv[0], lowmid = gEnv[1], mid = gEnv[2], hi = gEnv[3], air = gEnv[4];
    const env = { kick: new Float32Array(frames), snare: new Float32Array(frames), hat: new Float32Array(frames), lead: new Float32Array(frames) };
    for (let f = 0; f < frames; f++) {
      env.kick[f] = Math.max(0, low[f] - 0.3 * Math.max(mid[f], hi[f]));
      env.snare[f] = Math.sqrt(Math.max(0, lowmid[f]) * Math.max(0, Math.max(hi[f], air[f]))) * (1 - 0.5 * Math.min(1, low[f]));
      env.hat[f] = Math.max(0, Math.max(hi[f], air[f]) - 0.6 * Math.max(lowmid[f], low[f]));
      env.lead[f] = Math.max(0, mid[f] - 0.4 * Math.max(env.snare[f], low[f]));
    }
    const sep = { kick: 0.14, snare: 0.12, hat: 0.07, lead: 0.07 }, thr = { kick: 0.5, snare: 0.42, hat: 0.45, lead: 0.45 };
    const events = {};
    for (const name of ['kick', 'snare', 'hat', 'lead']) {
      const e = env[name], minSep = Math.max(1, Math.round(sep[name] * fps)), out = [];
      let last = -1e9;
      for (let i = 1; i < frames - 1; i++) {
        if (e[i] > thr[name] && e[i] >= e[i - 1] && e[i] > e[i + 1] && i - last >= minSep) {
          const ev = { t: i / fps, s: Math.min(1, e[i]) };
          if (name === 'lead') ev.p = midCent[Math.min(frames - 1, i + 2)];
          out.push(ev); last = i;
        }
      }
      events[name] = out;
    }
    return { events: events, env: env };
  }

  // Strongest attack of each instrument within +/- win seconds of t, plus the lead's pitch proxy.
  function instAt(an, t, win) {
    const r = { kick: 0, snare: 0, hat: 0, lead: 0, pitch: 0.5 };
    const fps = an.fps, c = Math.round(t * fps), w = Math.max(1, Math.round(win * fps));
    const lo = Math.max(0, c - w), hi = Math.min(an.frames - 1, c + w);
    for (const name of ['kick', 'snare', 'hat', 'lead']) {
      const e = an.instEnv[name];
      let m = 0;
      for (let f = lo; f <= hi; f++) if (e[f] > m) m = e[f];
      r[name] = m > 1 ? 1 : m;
    }
    if (r.lead > 0.3) {
      let bestD = 1e9;
      for (const ev of an.inst.lead) { const d = Math.abs(ev.t - t); if (d < bestD) { bestD = d; r.pitch = ev.p; } if (ev.t > t + 1) break; }
    }
    return r;
  }
  // Name of the instrument driving an attack at t ('' when nothing clear).
  function dominantInst(r) {
    let best = '', v = 0.3;
    const wgt = { kick: 1.0, snare: 1.0, lead: 0.9, hat: 0.7 };
    for (const name of ['kick', 'snare', 'lead', 'hat']) if (r[name] * wgt[name] > v) { v = r[name] * wgt[name]; best = name; }
    return best;
  }

  /* Song study at bar level. Every bar becomes a 16-slot x 4-instrument attack signature; bars that sound alike
   * (cosine similarity) are linked to their earliest similar bar, so the generator can repeat choreography where
   * the music repeats. Also reports the texture of each section (what plays how often). */
  function studyBars(inst, A, P, downbeat, K, sections) {
    const names = ['kick', 'snare', 'hat', 'lead'];
    const firstBeat = ((downbeat % 4) + 4) % 4;
    const nBars = Math.max(0, Math.floor((K - firstBeat) / 4));
    const sig = [];
    for (let j = 0; j < nBars; j++) sig.push(new Float32Array(64));
    names.forEach(function (name, ni) {
      for (const ev of inst.events[name]) {
        const q = (ev.t - A) / P - firstBeat;              // beats since the first bar start
        if (q < 0) continue;
        const j = Math.floor(q / 4);
        if (j >= nBars) continue;
        const slot = Math.min(15, Math.max(0, Math.round((q - 4 * j) * 4)));
        sig[j][ni * 16 + slot] = Math.max(sig[j][ni * 16 + slot], ev.s);
      }
    });
    const norm = sig.map(function (v) { let t = 0; for (let i = 0; i < 64; i++) t += v[i] * v[i]; return Math.sqrt(t); });
    const partner = new Int32Array(nBars).fill(-1), sim = new Float32Array(nBars);
    for (let j = 1; j < nBars; j++) {
      if (norm[j] < 0.5) continue;
      let best = -1, bs = 0.82;
      for (let i = 0; i < j; i++) {
        if (norm[i] < 0.5) continue;
        let d = 0; for (let x = 0; x < 64; x++) d += sig[j][x] * sig[i][x];
        const c = d / (norm[i] * norm[j]);
        if (c > bs + 1e-9 || (best < 0 && c >= bs)) { bs = c; best = i; }
      }
      if (best >= 0) { partner[j] = best; sim[j] = bs; }
    }
    const texture = sections.map(function (sec) {
      const rate = {};
      const t0 = A + sec.start * P, t1 = A + sec.end * P;
      for (const name of names) {
        let c = 0; for (const ev of inst.events[name]) if (ev.t >= t0 && ev.t < t1) c++;
        rate[name] = +(c / Math.max(1, sec.end - sec.start)).toFixed(2);   // events per beat
      }
      return rate;
    });
    let linked = 0; for (let j = 0; j < nBars; j++) if (partner[j] >= 0) linked++;
    return { firstBeat: firstBeat, bars: nBars, partner: partner, sim: sim, texture: texture, linkedShare: nBars ? linked / nBars : 0 };
  }

  function detectSections(beatBands, beatEnergy, K, NB, downbeat) {
    if (K < 24) return [{ start: 0, end: K, energy: meanOf(beatEnergy, 0, K), level: 'mid', drop: false }];
    // z-score each band across the song
    const V = new Float64Array(K * NB);
    for (let b = 0; b < NB; b++) {
      let m = 0; for (let k = 0; k < K; k++) m += beatBands[k * NB + b];
      m /= K;
      let v = 0; for (let k = 0; k < K; k++) v += Math.pow(beatBands[k * NB + b] - m, 2);
      const sd = Math.sqrt(v / K) || 1;
      for (let k = 0; k < K; k++) V[k * NB + b] = (beatBands[k * NB + b] - m) / sd;
    }
    const W = 8;
    const D = new Float64Array(K);
    for (let k = W; k < K - W; k++) {
      let dist = 0;
      for (let b = 0; b < NB; b++) {
        let a1 = 0, a2 = 0;
        for (let j = 0; j < W; j++) { a1 += V[(k - W + j) * NB + b]; a2 += V[(k + j) * NB + b]; }
        dist += Math.pow(a2 / W - a1 / W, 2);
      }
      D[k] = Math.sqrt(dist);
    }
    let m = 0, cnt = 0; for (let k = W; k < K - W; k++) { m += D[k]; cnt++; }
    m /= Math.max(1, cnt);
    let sd = 0; for (let k = W; k < K - W; k++) sd += Math.pow(D[k] - m, 2);
    sd = Math.sqrt(sd / Math.max(1, cnt));
    const thr = m + 0.5 * sd;
    const cand = [];
    for (let k = W; k < K - W; k++) {
      if (D[k] < thr) continue;
      let isPeak = true;
      for (let j = -4; j <= 4; j++) { if (j && D[k + j] > D[k]) { isPeak = false; break; } }
      if (isPeak) cand.push({ k: k, v: D[k] });
    }
    cand.sort(function (a, b) { return b.v - a.v; });
    const chosen = [];
    for (const c of cand) {
      if (chosen.every(function (x) { return Math.abs(x - c.k) >= 12; })) chosen.push(c.k);
    }
    // snap to bar starts and build sections
    const bounds = [0];
    for (const k of chosen.sort(function (a, b) { return a - b; })) {
      const bar = Math.round((k - downbeat) / 4) * 4 + downbeat;
      if (bar > 0 && bar < K) bounds.push(bar);
    }
    bounds.push(K);
    const uniq = [];
    for (const b of bounds) {
      if (!uniq.length) { uniq.push(b); continue; }
      if (b - uniq[uniq.length - 1] >= 8) uniq.push(b);
      else if (b === K && uniq.length > 1) uniq[uniq.length - 1] = K; // merge a too-short tail
    }
    if (uniq[uniq.length - 1] !== K) uniq.push(K);
    const out = [];
    for (let i = 0; i + 1 < uniq.length; i++) {
      const s = uniq[i], e = uniq[i + 1];
      out.push({ start: s, end: e, energy: meanOf(beatEnergy, s, e), level: 'mid', drop: false });
    }
    if (!out.length) out.push({ start: 0, end: K, energy: meanOf(beatEnergy, 0, K), level: 'mid', drop: false });
    for (let i = 0; i < out.length; i++) {
      const e = out[i].energy;
      out[i].level = e < 0.3 ? 'low' : (e < 0.62 ? 'mid' : 'high');
      out[i].drop = i > 0 && (e - out[i - 1].energy) > 0.2;
    }
    return out;
  }

  function meanOf(arr, s, e) {
    let t = 0; for (let k = s; k < e; k++) t += arr[k];
    return e > s ? t / (e - s) : 0;
  }

  // Max onset strength within +/- win seconds of time t (0..1).
  function onsetAt(analysis, t, win) {
    const fps = analysis.fps, env = analysis.onset2 || analysis.onset;
    const c = Math.round(t * fps), w = Math.max(1, Math.round(win * fps));
    let m = 0;
    for (let f = Math.max(0, c - w); f <= Math.min(env.length - 1, c + w); f++) if (env[f] > m) m = env[f];
    return m;
  }

  // Beat index k containing time t.
  function beatIndexAt(analysis, t) {
    const k = Math.floor((t - analysis.phase) / analysis.period);
    return ns.clamp(k, 0, analysis.beatCount - 1);
  }

  // Beat Saber beat coordinate for a song time (constant BPM, offset 0).
  function timeToBeat(analysis, t) { return t / analysis.period; }

  // Downsampled waveform peaks for drawing.
  function waveformPeaks(samples, count) {
    const out = new Float32Array(count);
    const step = samples.length / count;
    for (let i = 0; i < count; i++) {
      let m = 0;
      const a = Math.floor(i * step), b = Math.min(samples.length, Math.floor((i + 1) * step));
      for (let j = a; j < b; j++) { const v = Math.abs(samples[j]); if (v > m) m = v; }
      out[i] = m;
    }
    return out;
  }

  ns.analyzeAudio = analyzeAudio;
  ns.__tempoDebug = { foldScore: foldScore, refineTempo: refineTempo, foldPhase: foldPhase };
  ns.onsetAt = onsetAt;
  ns.instAt = instAt;
  ns.dominantInst = dominantInst;
  ns.beatIndexAt = beatIndexAt;
  ns.timeToBeat = timeToBeat;
  ns.waveformPeaks = waveformPeaks;
  ns.makeFFT = makeFFT;
})(BSM);
