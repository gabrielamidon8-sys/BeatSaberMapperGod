// Loads the core modules into a fresh namespace (same code the browser build inlines).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const CORE_DIR = path.join(__dirname, '..', 'src', 'core');
function loadCore() {
  const files = fs.readdirSync(CORE_DIR).filter(f => f.endsWith('.js')).sort();
  const src = files.map(f => fs.readFileSync(path.join(CORE_DIR, f), 'utf8')).join('\n;\n');
  const BSM = new Function(src + '\n;return BSM;')();
  BSM.inflateRaw = async (b) => new Uint8Array(zlib.inflateRawSync(Buffer.from(b)));
  return BSM;
}
module.exports = { loadCore };
