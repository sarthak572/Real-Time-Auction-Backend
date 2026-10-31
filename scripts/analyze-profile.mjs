// Summarises a V8 .cpuprofile: where did the CPU time go?
// Usage: node scripts/analyze-profile.mjs profile.cpuprofile [topN]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const topN = Number(process.argv[3] ?? 25);
const profile = JSON.parse(readFileSync(file, 'utf8'));

const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map(); // node id -> microseconds spent in that function itself
for (let i = 0; i < profile.samples.length; i++) {
  self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);

function categoryOf(cf) {
  const { url, functionName } = cf;
  if (functionName === '(idle)') return 'idle (waiting for work)';
  if (functionName === '(garbage collector)') return 'garbage collection';
  if (functionName === '(program)') return 'native/other (program)';
  if (!url) return 'native (no source)';
  const nm = /node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/.exec(url);
  if (nm) return 'lib: ' + nm[1].replace('\\', '/');
  if (url.startsWith('node:')) return 'node core: ' + url.replace('node:', '').split('/')[0];
  if (/[\\/]dist[\\/]/.test(url)) return 'our code: ' + url.split(/[\\/]dist[\\/]/)[1];
  return 'other: ' + url.slice(-40);
}

const byCategory = new Map();
const byFunction = new Map();
for (const [id, us] of self) {
  const cf = nodes.get(id).callFrame;
  const cat = categoryOf(cf);
  byCategory.set(cat, (byCategory.get(cat) ?? 0) + us);
  const where = (cf.url || '').replace(/^.*[\\/](node_modules|dist)[\\/]/, '$1/').replace(/^file:\/\/\//, '');
  const key = `${cf.functionName || '(anonymous)'}  ${where}:${cf.lineNumber + 1}`;
  byFunction.set(key, (byFunction.get(key) ?? 0) + us);
}

const pct = (us) => ((us / total) * 100).toFixed(1).padStart(5) + '%';
const idle = byCategory.get('idle (waiting for work)') ?? 0;
console.log(`profile length: ${(total / 1e6).toFixed(1)} s of samples; busy (not idle): ${(((total - idle) / total) * 100).toFixed(1)}%\n`);

console.log('=== where the time goes, by category (share of ALL samples) ===');
for (const [k, v] of [...byCategory].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(pct(v), k);

console.log(`\n=== top ${topN} functions by self time ===`);
for (const [k, v] of [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, topN)) console.log(pct(v), k);
