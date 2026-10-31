// Runs the compiled API and records a V8 CPU profile for a window while it is under load.
// Usage: PROFILE_START_S=80 PROFILE_SECONDS=30 PROFILE_OUT=profile.cpuprofile node scripts/profile-server.mjs
// (all the normal API environment variables apply: PORT, BID_IMPL, ...). The server keeps running after the profile is written.
import inspector from 'node:inspector';
import { writeFileSync } from 'node:fs';

const startAfter = Number(process.env.PROFILE_START_S ?? 80) * 1000;
const length = Number(process.env.PROFILE_SECONDS ?? 30) * 1000;
const out = process.env.PROFILE_OUT ?? 'profile.cpuprofile';

const session = new inspector.Session();
session.connect();
session.post('Profiler.enable');
session.post('Profiler.setSamplingInterval', { interval: 500 }); // microseconds: 2,000 samples per second

setTimeout(() => {
  session.post('Profiler.start');
  console.error(`[profile] recording for ${length / 1000}s`);
  setTimeout(() => {
    session.post('Profiler.stop', (err, result) => {
      if (err) return console.error('[profile] failed', err);
      writeFileSync(out, JSON.stringify(result.profile));
      console.error(`[profile] written to ${out}`);
    });
  }, length);
}, startAfter);

await import('../dist/server.js');
