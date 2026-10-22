// Builds dist/beat-mapper.html: every core module plus the default brain, inlined into the page template.
// Run: node build.js
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CORE_DIR = path.join(ROOT, 'src', 'core');
const TEMPLATE = path.join(ROOT, 'src', 'app', 'template.html');
const BRAIN = path.join(ROOT, 'data', 'default-brain.json');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, 'beat-mapper.html');

function noScriptEnd(js, label) {
  if (/<\/script/i.test(js)) throw new Error(label + ' contains "</script", which would end the page script early');
  return js;
}

// Core modules in filename order (00_, 10_, ...), the same order the test harness uses.
const coreFiles = fs.readdirSync(CORE_DIR).filter(f => f.endsWith('.js')).sort();
const core = coreFiles.map(f => fs.readFileSync(path.join(CORE_DIR, f), 'utf8')).join('\n;\n');

const brain = JSON.parse(fs.readFileSync(BRAIN, 'utf8'));
if (brain.format !== 'bsm-brain') throw new Error('default brain has the wrong format tag');
const brainJs = 'BSM.DEFAULT_BRAIN = ' + JSON.stringify(brain) + ';';

const bundle = noScriptEnd(core + '\n;\n' + brainJs, 'core bundle');

const template = fs.readFileSync(TEMPLATE, 'utf8');
if (template.split('/*__CORE__*/').length !== 2) throw new Error('template needs exactly one /*__CORE__*/ marker');

// A replacer function keeps any "$" in the code from being read as a replacement pattern.
const html = template.replace('/*__CORE__*/', () => bundle);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html);
console.log('core modules: ' + coreFiles.join(', '));
console.log('wrote ' + OUT + ' (' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB)');
