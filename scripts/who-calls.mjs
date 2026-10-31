// Shows the call chains that lead to a function in a V8 .cpuprofile.
// Usage: node scripts/who-calls.mjs profile.cpuprofile <functionName> [depth]
import { readFileSync } from 'node:fs';

const [file, target, depthArg] = process.argv.slice(2);
const depth = Number(depthArg ?? 6);
const profile = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const self = new Map();
for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
const total = [...self.values()].reduce((a, b) => a + b, 0);

const chains = new Map();
for (const n of profile.nodes) {
  if (n.callFrame.functionName !== target) continue;
  const us = self.get(n.id) ?? 0;
  if (!us) continue;
  const names = [];
  for (let id = n.id, i = 0; id !== undefined && i <= depth; id = parent.get(id), i++) {
    const cf = byId.get(id).callFrame;
    names.push(`${cf.functionName || '(anon)'} ${(cf.url || '').replace(/^.*[\\/](node_modules|dist)[\\/]/, '$1/')}:${cf.lineNumber + 1}`);
  }
  const key = names.join('\n      <- ');
  chains.set(key, (chains.get(key) ?? 0) + us);
}
for (const [k, v] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
  console.log(`${((v / total) * 100).toFixed(2)}%  ${k}\n`);
}
