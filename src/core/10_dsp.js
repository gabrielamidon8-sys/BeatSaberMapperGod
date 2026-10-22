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

  // Tempo from the autocorrelation of the onset envelope (60-200 BPM, mild prior around 120).
  function estimateTempo(env, fps) {
    const minLag = Math.max(1, Math.floor(fps * 60 / 200) - 1);
    const maxLag = Math.ceil(fps * 60 / 60) + 2;
    const ac = new Float64Array(maxLag + 2);
    for (let L = minLag; L <= maxLag + 1; L++) ac[L] = autocorrAt(env, L);
    const at = function (lag) {
      const L = Math.floor(lag), f = lag - L;
      return ac[L] * (1 - f) + ac[L + 1] * f;
    };
    const scoreOf = function (bpm) {
      const w = Math.exp(-0.5 * Math.pow((Math.log2(bpm) - Math.log2(120)) / 1.2, 2));
      return at(fps * 60 / bpm) * (0.8 + 0.2 * w);
    };
    let bestBpm = 120, bestScore = -Infinity;
    for (let bpm = 60; bpm <= 200; bpm += 0.25) {
      const s = scoreOf(bpm);
      if (s > bestScore) { bestScore = s; bestBpm = bpm; }
    }
    // Resolve octave ambiguity: prefer the candidate closest to 120 BPM when it is nearly as strong.
    const cands = [bestBpm];
    if (bestBpm * 2 <= 200) cands.push(bestBpm * 2);
    if (bestBpm / 2 >= 60) cands.push(bestBpm / 2);
    let pick = bestBpm, pickScore = -Infinity;
    for (const c of cands) {
      const s = scoreOf(c) * (1 + 0.06 * Math.exp(-Math.abs(Math.log2(c / 120))));
      if (s > pickScore) { pickScore = s; pick = c; }
    }
    const zero = autocorrAt(env, 0) || 1;
    return { bpm: pick, confidence: Math.min(1, Math.max(0, bestScore / zero)) };
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

  // Local maxima of the (0..1 normalised) onset envelope: the song's note-worthy events.
  function onsetPeaks(env, fps) {
    const minSep = Math.max(1, Math.round(0.045 * fps));
    const out = [];
    let last = -1e9;
    for (let i = 1; i < env.length - 1; i++) {
      if (env[i] > 0.22 && env[i] >= env[i - 1] && env[i] > env[i + 1] && i - last >= minSep) { out.push(i / fps); last = i; }
    }
    return out;
  }

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
    const bands = new Float32Array(frames * NBANDS);
    const re = new Float64Array(N), im = new Float64Array(N);
    let prev = new Float64Array(nb), cur = new Float64Array(nb);

    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      let e = 0;
      for (let i = 0; i < N; i++) {
        const idx = off + i;
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
      }
      const tmp = prev; prev = cur; cur = tmp;
    }

    const W = Math.max(3, Math.round(fps));
    const onset = scaleByPercentile(movingMeanSubtract(flux, W), 0.97);
    const bassEnv = scaleByPercentile(movingMeanSubtract(fluxBass, W), 0.97);
    const highEnv = scaleByPercentile(movingMeanSubtract(fluxHigh, W), 0.97);

    // Tempo and a regular grid (regression on the tracked beats, outliers removed once).
    const tempo = estimateTempo(onset, fps);
    const peaks = onsetPeaks(onset, fps);
    const onsetRate = peaks.length / Math.max(1, duration);
    const detectedBpm = tempo.bpm;
    tempo.bpm = chooseOctave(tempo.bpm, onsetRate, opts);
    let beatFrames = trackBeats(onset, fps, tempo.bpm);
    let beatTimes = beatFrames.map(function (f) { return (f * hop + N / 2) / sr; });
    let P = 60 / tempo.bpm, A = 0;
    if (beatTimes.length >= 4) {
      let fit = fitGrid(beatTimes);
      P = fit.P;
      const keep = [];
      for (let i = 0; i < beatTimes.length; i++) {
        const r = Math.abs(beatTimes[i] - (fit.a + i * fit.P));
        if (r < 0.1 * fit.P) keep.push(beatTimes[i]);
      }
      if (keep.length >= 4) {
        // refit using only the kept beats (index is preserved by re-indexing against the fitted grid)
        const idx = [];
        for (let i = 0; i < beatTimes.length; i++) {
          if (Math.abs(beatTimes[i] - (fit.a + i * fit.P)) < 0.1 * fit.P) idx.push(i);
        }
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const i of idx) { const t = beatTimes[i]; sx += i; sy += t; sxx += i * i; sxy += i * t; }
        const m = idx.length, den = m * sxx - sx * sx;
        if (den) { P = (m * sxy - sx * sy) / den; A = (sy - P * sx) / m; }
        else { A = fit.a; }
      } else {
        A = fit.a;
      }
    } else {
      A = 0;
    }
    if (!(P > 0.2 && P < 1.5)) P = 60 / tempo.bpm;
    A = ((A % P) + P) % P; // phase in [0, P)
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

    return {
      sr: sr, hop: hop, fps: fps, duration: duration,
      bpm: bpm, period: P, phase: A, tempoConfidence: tempo.confidence,
      beatCount: K, beatTimes: beatT,
      beatEnergy: beatEnergy, beatBass: beatBass, beatHigh: beatHigh, beatOnset: beatOnset,
      downbeat: downbeat,
      onset: onset, frames: frames,
      onsetRate: onsetRate, onsetTimes: Float32Array.from(peaks),
      detectedBpm: detectedBpm, tempoOctave: tempo.bpm / detectedBpm,
      sections: sections
    };
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
    const fps = analysis.fps, env = analysis.onset;
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
  ns.onsetAt = onsetAt;
  ns.beatIndexAt = beatIndexAt;
  ns.timeToBeat = timeToBeat;
  ns.waveformPeaks = waveformPeaks;
  ns.makeFFT = makeFFT;
})(BSM);
