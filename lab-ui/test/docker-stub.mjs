// Stands in for the docker CLI during the smoke test: records the arguments it was called with.
import fs from 'node:fs';

fs.appendFileSync(process.env.STUB_LOG, process.argv.slice(2).join(' ') + '\n');
