/* Beat Saber Generative Mapper - core utilities.
 * Plain JavaScript, no dependencies. Works in the browser (single HTML file)
 * and in Node (tests). Everything hangs off the global namespace BSM. */
var BSM = (typeof BSM !== 'undefined' && BSM) ? BSM : {};

(function (ns) {
  'use strict';
  ns.VERSION = '1.0.0';

  // ---------- small math helpers ----------
  ns.clamp = function (x, a, b) { return Math.min(b, Math.max(a, x)); };
  ns.lerp = function (a, b, t) { return a + (b - a) * t; };
  ns.mean = function (arr) {
    if (!arr || !arr.length) return 0;
    let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  };
  ns.median = function (arr) {
    if (!arr || !arr.length) return 0;
    const s = Float64Array.from(arr).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // ---------- seeded random numbers (mulberry32) ----------
  ns.makeRng = function (seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    const rng = function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.int = function (n) { return Math.floor(rng() * n); };
    rng.pick = function (arr) { return arr[Math.floor(rng() * arr.length)]; };
    rng.chance = function (p) { return rng() < p; };
    rng.gumbel = function () { return -Math.log(-Math.log(Math.max(1e-12, rng()))); };
    rng.weighted = function (weights) {
      let s = 0; for (let i = 0; i < weights.length; i++) s += weights[i];
      let r = rng() * s;
      for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
      return weights.length - 1;
    };
    return rng;
  };

  // ---------- CRC32 + ZIP (store) writer ----------
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  ns.crc32 = function (bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  // files: [{ name: 'Info.dat', data: Uint8Array }] -> Uint8Array zip (uncompressed)
  ns.zipStore = function (files) {
    const enc = new TextEncoder();
    const locals = [], centrals = [];
    let offset = 0;
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data;
      const crc = ns.crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);          // UTF-8 names
      lv.setUint16(8, 0, true);               // method 0 = stored
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x21, true);           // 1980-01-01
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      locals.push(local, data);

      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      centrals.push(cen);
      offset += local.length + data.length;
    }
    const cenSize = centrals.reduce(function (a, c) { return a + c.length; }, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cenSize, true);
    ev.setUint32(16, offset, true);
    const all = locals.concat(centrals, [eocd]);
    const total = all.reduce(function (a, c) { return a + c.length; }, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  };

  // ZIP reader. inflateRaw(Uint8Array) -> Promise<Uint8Array> is injected so this runs in Node and browsers.
  ns.unzipAll = async function (buf, inflateRaw) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    const minPos = Math.max(0, buf.length - 22 - 65557);
    for (let i = buf.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .zip file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = new Map();
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      const lnlen = dv.getUint16(lho + 26, true);
      const lxlen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lnlen + lxlen;
      const raw = buf.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error('Unsupported zip compression (' + method + ') in ' + name);
      out.set(name, data);
    }
    return out;
  };

  ns.bytesToText = function (bytes) { return new TextDecoder().decode(bytes); };
  ns.textToBytes = function (s) { return new TextEncoder().encode(s); };

  // Case-insensitive lookup of a file inside an unzipped Map.
  ns.findFile = function (files, name) {
    if (files.has(name)) return files.get(name);
    const lower = name.toLowerCase();
    for (const [k, v] of files) {
      if (k.toLowerCase() === lower || k.toLowerCase().endsWith('/' + lower)) return v;
    }
    return null;
  };
})(BSM);
