/* A small Ogg Vorbis encoder, so the app can turn any song it can decode (MP3, WAV, M4A, ...) into the song.ogg
 * a Beat Saber map folder needs, entirely in the browser.
 *
 * Design (a deliberately simple but fully standard Vorbis I stream):
 *   - one block size (2048), one mode, no channel coupling, so every packet is the same shape
 *   - floor type 1 with two points, held flat (the spectral envelope is carried by the residue instead)
 *   - residue type 1 in 16-coefficient partitions. Each partition picks a "class" = a quantiser step on a
 *     geometric ladder, chosen from the partition's own loudness (so quantisation noise follows the music),
 *     or the all-zero class. Each class has its own Huffman codebook, built from this song's statistics.
 *   - two passes: pass one quantises everything and counts; pass two writes books and packets.
 * The result decodes with any Vorbis decoder (checked against libvorbis and ffmpeg in test/ogg-check.py). */
(function (ns) {
  'use strict';

  const M = 1024, N = 2 * M;          // coefficients per block, window length
  const PART = 16;                     // residue partition size
  const QMAX = 15;                     // largest quantised magnitude
  const LADDER = 1.45;                 // step ratio between classes
  const MAX_CLASSES = 40;
  const QUALITY = {
    small:    { rho: 0.62, base: 0.0016, end: 704 },   // ~ 15 kHz
    balanced: { rho: 0.46, base: 0.0010, end: 800 },   // ~ 17 kHz
    high:     { rho: 0.32, base: 0.0006, end: 880 }    // ~ 19 kHz
  };

  /* ---------- bits ---------- */
  function BitWriter() { this.bytes = []; this.cur = 0; this.n = 0; }
  BitWriter.prototype.write = function (value, bits) {
    value = value >>> 0;
    while (bits > 0) {
      const take = Math.min(bits, 8 - this.n);
      this.cur |= (value & ((1 << take) - 1)) << this.n;
      this.n += take; value >>>= take; bits -= take;
      if (this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
    }
  };
  BitWriter.prototype.finish = function () {
    if (this.n > 0) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
    return Uint8Array.from(this.bytes);
  };

  // Vorbis 32-bit float packing: 21-bit mantissa, 10-bit exponent (bias 788), sign
  function packFloat(v) {
    if (v === 0) return 0;
    const sign = v < 0 ? 0x80000000 : 0;
    const a = Math.abs(v);
    const e = Math.floor(Math.log2(a));
    let mant = Math.round(a * Math.pow(2, 20 - e));
    let ex = e + 788 - 20;
    if (mant >= (1 << 21)) { mant >>= 1; ex++; }
    return (sign | (ex << 21) | mant) >>> 0;
  }

  /* ---------- Huffman ---------- */
  // optimal code lengths for the given weights (all entries get a code)
  function huffLengths(weights) {
    const n = weights.length;
    if (n === 1) return [1];
    let nodes = weights.map(function (w, i) { return { w: Math.max(w, 1e-9), leaf: i }; });
    while (nodes.length > 1) {
      nodes.sort(function (a, b) { return a.w - b.w; });
      const a = nodes.shift(), b = nodes.shift();
      nodes.push({ w: a.w + b.w, a: a, b: b });
    }
    const out = new Array(n).fill(0);
    (function walk(nd, d) { if (nd.leaf !== undefined) out[nd.leaf] = Math.max(1, d); else { walk(nd.a, d + 1); walk(nd.b, d + 1); } })(nodes[0], 0);
    return out;
  }
  // lengths must be bounded; flatten the weights until they are
  function boundedLengths(counts, maxLen) {
    let w = counts.map(function (c) { return c + 1; });
    for (let tries = 0; tries < 20; tries++) {
      const l = huffLengths(w);
      if (Math.max.apply(null, l) <= maxLen) return l;
      const tot = w.reduce(function (a, b) { return a + b; }, 0);
      w = w.map(function (x) { return x + tot / 4096 * (tries + 1); });
    }
    return huffLengths(w.map(function () { return 1; }));
  }
  // entries MUST be in non-decreasing length order; returns {code, len} per entry (canonical, MSB-first)
  function codewords(lengths) {
    const out = [];
    let code = 0, prev = lengths[0];
    for (let i = 0; i < lengths.length; i++) {
      if (i > 0) { code = (code + 1) * Math.pow(2, lengths[i] - prev); prev = lengths[i]; }
      out.push({ code: code, len: lengths[i] });
    }
    return out;
  }
  function putCode(bw, cw) {                        // Huffman codes are read from the stream most significant bit first
    for (let b = cw.len - 1; b >= 0; b--) bw.write(Math.floor(cw.code / Math.pow(2, b)) & 1, 1);
  }

  /* ---------- transform ---------- */
  const WIN = new Float64Array(N);
  for (let i = 0; i < N; i++) { const s = Math.sin((i + 0.5) * Math.PI / N); WIN[i] = Math.sin(Math.PI / 2 * s * s); }

  function makeMdct() {
    const H = M / 2;
    const fft = ns.makeFFT(H);
    const re = new Float64Array(H), im = new Float64Array(H);
    const twr = new Float64Array(H), twi = new Float64Array(H), t2r = new Float64Array(H), t2i = new Float64Array(H);
    for (let n = 0; n < H; n++) {
      const a = -Math.PI * (n + 0.25) / M; twr[n] = Math.cos(a); twi[n] = Math.sin(a);
      const b = -Math.PI * n / M; t2r[n] = Math.cos(b); t2i[n] = Math.sin(b);
    }
    const u = new Float64Array(M);
    const scale = 2 / M;                      // matches the decoders' inverse transform (measured: unity gain)
    // x: windowed 2M samples -> out: M coefficients (orthonormal MDCT)
    return function (x, out) {
      const h = M / 2;
      for (let n = 0; n < h; n++) {
        u[n] = -x[3 * h - 1 - n] - x[3 * h + n];
        u[h + n] = x[n] - x[M - 1 - n];
      }
      for (let n = 0; n < H; n++) {
        const a = u[2 * n], b = u[M - 1 - 2 * n];
        re[n] = a * twr[n] - b * twi[n];
        im[n] = a * twi[n] + b * twr[n];
      }
      fft(re, im);
      for (let k = 0; k < H; k++) {
        const yr = re[k] * t2r[k] - im[k] * t2i[k];
        const yi = re[k] * t2i[k] + im[k] * t2r[k];
        out[2 * k] = yr * scale;
        out[M - 1 - 2 * k] = -yi * scale;
      }
    };
  }
  ns._mdctForTest = makeMdct;

  /* ---------- the encoder ---------- */
  function ilog(v) { let n = 0; while (v > 0) { n++; v >>>= 1; } return n; }

  function writeCodebook(bw, lengths, mults, delta) {
    bw.write(0x564342, 24);
    bw.write(1, 16);                                   // dimensions
    bw.write(lengths.length, 24);
    bw.write(0, 1);                                    // not ordered
    bw.write(0, 1);                                    // not sparse
    for (const l of lengths) bw.write(l - 1, 5);
    if (!mults) { bw.write(0, 4); return; }
    bw.write(1, 4);                                    // lookup type 1
    bw.write(packFloat(delta.min), 32);
    bw.write(packFloat(delta.step), 32);
    const bits = Math.max(1, ilog(Math.max.apply(null, mults)));
    bw.write(bits - 1, 4);
    bw.write(0, 1);                                    // not a sequence
    for (const m of mults) bw.write(m, bits);
  }

  const crcTable = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = (i << 24) >>> 0;
      for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? (((r << 1) ^ 0x04C11DB7) >>> 0) : ((r << 1) >>> 0);
      t[i] = r;
    }
    return t;
  })();
  function oggCrc(bytes) {
    let c = 0;
    for (let i = 0; i < bytes.length; i++) c = (((c << 8) >>> 0) ^ crcTable[((c >>> 24) & 0xff) ^ bytes[i]]) >>> 0;
    return c;
  }

  // packets: [{ data: Uint8Array, granule: number }]; headers go on their own pages as the spec asks
  function oggPages(packets, serial) {
    const pages = [];
    let seq = 0;
    const emit = function (group, flags, granule) {
      const segs = [];
      let size = 0;
      for (const p of group) {
        let n = p.data.length;
        while (n >= 255) { segs.push(255); n -= 255; }
        segs.push(n);
        size += p.data.length;
      }
      const page = new Uint8Array(27 + segs.length + size);
      page.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);
      const dv = new DataView(page.buffer);
      dv.setUint32(6, granule % 4294967296, true);
      dv.setUint32(10, Math.floor(granule / 4294967296), true);
      dv.setUint32(14, serial, true);
      dv.setUint32(18, seq++, true);
      page[26] = segs.length;
      page.set(segs, 27);
      let off = 27 + segs.length;
      for (const p of group) { page.set(p.data, off); off += p.data.length; }
      dv.setUint32(22, oggCrc(page), true);
      pages.push(page);
    };
    emit([packets[0]], 0x02, 0);                       // identification header alone, beginning of stream
    emit([packets[1], packets[2]], 0, 0);              // comment + setup
    let group = [], segCount = 0, i = 3;
    while (i < packets.length) {
      const p = packets[i];
      const segs = Math.floor(p.data.length / 255) + 1;
      if (group.length && (segCount + segs > 240 || group.length >= 24)) {
        emit(group, 0, group[group.length - 1].granule);
        group = []; segCount = 0;
      }
      group.push(p); segCount += segs; i++;
    }
    if (group.length) emit(group, 0x04, group[group.length - 1].granule);
    let total = 0;
    for (const p of pages) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of pages) { out.set(p, o); o += p.length; }
    return out;
  }

  /* encodeOgg(channels: Float32Array[] (1 or 2), sampleRate, opts) -> Uint8Array (an .ogg file)
   * opts: { quality: 'small'|'balanced'|'high', title, artist, onProgress(0..1), yieldEvery, yieldFn } */
  ns.encodeOgg = function (channels, sampleRate, opts) {
    opts = opts || {};
    const q0 = QUALITY[opts.quality] || QUALITY.balanced;
    // coefficient units here are 1/sqrt(M/2) of an orthonormal transform; keep the noise floors in the same absolute terms
    const q = { rho: q0.rho, base: q0.base * Math.sqrt(2 / M), end: q0.end };
    const nch = channels.length >= 2 ? 2 : 1;
    const len = channels[0].length;
    const nBlocks = Math.ceil(len / M) + 1;
    const END = q.end - (q.end % PART);
    const nPart = END / PART;
    const mdct = makeMdct();
    const buf = new Float64Array(N), coef = new Float64Array(M);
    const stepOf = function (k) { return q.base * Math.pow(LADDER, k); };

    // ---- pass 1: transform and quantise; remember classes and values ----
    const cls = new Uint8Array(nBlocks * nch * nPart);
    const val = new Int8Array(nBlocks * nch * END);
    const clsHist = new Float64Array(MAX_CLASSES + 1);
    const valHist = [];
    for (let k = 0; k <= MAX_CLASSES; k++) valHist.push(new Float64Array(2 * QMAX + 1));
    const rmsP = new Float64Array(nPart);
    const invLn = 1 / Math.log(LADDER);
    for (let b = 0; b < nBlocks; b++) {
      for (let c = 0; c < nch; c++) {
        const src = channels[c], start = (b - 1) * M;
        for (let i = 0; i < N; i++) { const idx = start + i; buf[i] = (idx >= 0 && idx < len ? Math.max(-1, Math.min(1, src[idx])) : 0) * WIN[i]; }
        mdct(buf, coef);
        for (let p = 0; p < nPart; p++) {
          let s2 = 0;
          for (let i = 0; i < PART; i++) { const v = coef[p * PART + i]; s2 += v * v; }
          rmsP[p] = Math.sqrt(s2 / PART);
        }
        const ci = (b * nch + c) * nPart, vi = (b * nch + c) * END;
        for (let p = 0; p < nPart; p++) {
          let peak = 0;
          for (let i = 0; i < PART; i++) peak = Math.max(peak, Math.abs(coef[p * PART + i]));
          // loudness of this partition and its neighbours decide the step (a little masking by neighbours)
          const nb = 0.5 * ((p > 0 ? rmsP[p - 1] : rmsP[p]) + (p + 1 < nPart ? rmsP[p + 1] : rmsP[p]));
          const loud = 0.7 * rmsP[p] + 0.3 * nb;
          let step = Math.max(q.base, q.rho * loud, peak / QMAX);
          if (peak < q.base * 0.5) { cls[ci + p] = 0; clsHist[0]++; continue; }
          let k = Math.min(MAX_CLASSES - 1, Math.max(0, Math.ceil(Math.log(step / q.base) * invLn - 1e-9)));
          const d = stepOf(k);
          let any = false;
          for (let i = 0; i < PART; i++) {
            let v = Math.round(coef[p * PART + i] / d);
            if (v > QMAX) v = QMAX; else if (v < -QMAX) v = -QMAX;
            val[vi + p * PART + i] = v;
            if (v) any = true;
          }
          if (!any) { cls[ci + p] = 0; clsHist[0]++; continue; }
          cls[ci + p] = k + 1;                          // 0 is reserved for the all-zero partition
          clsHist[k + 1]++;
          for (let i = 0; i < PART; i++) valHist[k + 1][val[vi + p * PART + i] + QMAX]++;
        }
      }
      if (opts.onProgress && b % 200 === 0) opts.onProgress(0.5 * b / nBlocks);
    }

    // ---- books ----
    // classes actually used, ordered by their Huffman length (needed so codewords are canonical)
    let used = [];
    for (let k = 0; k <= MAX_CLASSES; k++) if (clsHist[k] > 0 || k === 0) used.push(k);
    if (used.length < 2) used.push(used.indexOf(1) < 0 ? 1 : 2);   // a codebook needs at least two entries here
    const cLen0 = boundedLengths(used.map(function (k) { return clsHist[k]; }), 20);
    const order = used.map(function (k, i) { return i; }).sort(function (a, b) { return cLen0[a] - cLen0[b] || a - b; });
    const classOrder = order.map(function (i) { return used[i]; });          // classOrder[newIndex] = original class
    const classLen = order.map(function (i) { return cLen0[i]; });
    const newIndex = new Int16Array(MAX_CLASSES + 1).fill(-1);
    classOrder.forEach(function (orig, ni) { newIndex[orig] = ni; });
    const classCode = codewords(classLen);

    // value books for every class that has a quantiser
    const valBooks = {};
    for (const orig of classOrder) {
      if (orig === 0) continue;
      const hist = Array.from(valHist[orig]);
      const lens = boundedLengths(hist, 24);
      const idx = lens.map(function (l, i) { return i; }).sort(function (a, b) { return lens[a] - lens[b] || a - b; });
      const sortedLens = idx.map(function (i) { return lens[i]; });
      valBooks[orig] = { mults: idx, lens: sortedLens, codes: codewords(sortedLens), where: new Int16Array(2 * QMAX + 1) };
      idx.forEach(function (v, e) { valBooks[orig].where[v] = e; });          // value index -> entry
    }

    // ---- headers ----
    const mk = function (type, fn) { const bw = new BitWriter(); bw.write(type, 8); for (const ch of 'vorbis') bw.write(ch.charCodeAt(0), 8); fn(bw); return bw.finish(); };
    const ident = mk(1, function (bw) {
      bw.write(0, 32); bw.write(nch, 8); bw.write(sampleRate, 32);
      bw.write(0, 32); bw.write(0, 32); bw.write(0, 32);
      bw.write(11, 4); bw.write(11, 4); bw.write(1, 1);
    });
    const vendor = 'BeatForge';
    const comments = [];
    if (opts.title) comments.push('TITLE=' + opts.title);
    if (opts.artist) comments.push('ARTIST=' + opts.artist);
    const comment = mk(3, function (bw) {
      const put = function (s) { const b = ns.textToBytes(s); bw.write(b.length, 32); for (const x of b) bw.write(x, 8); };
      put(vendor); bw.write(comments.length, 32);
      for (const c of comments) put(c);
      bw.write(1, 1);
    });
    const books = [];                                   // [{ lengths, mults, delta }]
    books.push({ lengths: classLen, mults: null });
    const bookOf = {};
    for (const orig of classOrder) {
      if (orig === 0) continue;
      const step = stepOf(orig - 1);
      bookOf[orig] = books.length;
      books.push({ lengths: valBooks[orig].lens, mults: valBooks[orig].mults, delta: { min: -QMAX * step, step: step } });
    }
    const setup = mk(5, function (bw) {
      bw.write(books.length - 1, 8);
      for (const b of books) writeCodebook(bw, b.lengths, b.mults, b.delta);
      bw.write(0, 6); bw.write(0, 16);                  // time domain: one placeholder
      bw.write(0, 6); bw.write(1, 16);                  // one floor, type 1
      bw.write(0, 5);                                   // no partitions: just the two end points
      bw.write(0, 2);                                   // multiplier 1 (range 256)
      bw.write(10, 4);                                  // x range 1024
      bw.write(0, 6); bw.write(1, 16);                  // one residue, type 1
      bw.write(0, 24); bw.write(END, 24); bw.write(PART - 1, 24);
      bw.write(classOrder.length - 1, 6);
      bw.write(0, 8);                                   // classbook = book 0
      for (let i = 0; i < classOrder.length; i++) {
        const orig = classOrder[i];
        if (orig === 0) { bw.write(0, 3); bw.write(0, 1); }
        else { bw.write(1, 3); bw.write(0, 1); }        // stage 0 only
      }
      for (let i = 0; i < classOrder.length; i++) if (classOrder[i] !== 0) bw.write(bookOf[classOrder[i]], 8);
      bw.write(0, 6); bw.write(0, 16);                  // one mapping, type 0
      bw.write(0, 1); bw.write(0, 1); bw.write(0, 2);   // one submap, no coupling, reserved
      bw.write(0, 8); bw.write(0, 8); bw.write(0, 8);   // time, floor 0, residue 0
      bw.write(0, 6);                                   // one mode
      bw.write(0, 1); bw.write(0, 16); bw.write(0, 16); bw.write(0, 8);
      bw.write(1, 1);
    });

    // ---- pass 2: audio packets ----
    const packets = [{ data: ident, granule: 0 }, { data: comment, granule: 0 }, { data: setup, granule: 0 }];
    for (let b = 0; b < nBlocks; b++) {
      const bw = new BitWriter();
      bw.write(0, 1);                                   // audio packet (one mode, so no mode bits)
      for (let c = 0; c < nch; c++) { bw.write(1, 1); bw.write(255, 8); bw.write(255, 8); }   // floor: flat, value 1.0
      for (let p = 0; p < nPart; p++) {
        for (let c = 0; c < nch; c++) {
          const orig = cls[(b * nch + c) * nPart + p];
          putCode(bw, classCode[newIndex[orig]]);
        }
        for (let c = 0; c < nch; c++) {
          const orig = cls[(b * nch + c) * nPart + p];
          if (orig === 0) continue;
          const vb = valBooks[orig], vi = (b * nch + c) * END + p * PART;
          for (let i = 0; i < PART; i++) putCode(bw, vb.codes[vb.where[val[vi + i] + QMAX]]);
        }
      }
      const granule = b === nBlocks - 1 ? len : b * M;
      packets.push({ data: bw.finish(), granule: Math.min(granule, len) });
      if (opts.onProgress && b % 200 === 0) opts.onProgress(0.5 + 0.5 * b / nBlocks);
    }
    return oggPages(packets, (Math.random() * 4294967295) >>> 0);
  };

  ns.OGG_QUALITY = Object.keys(QUALITY);
})(BSM);
