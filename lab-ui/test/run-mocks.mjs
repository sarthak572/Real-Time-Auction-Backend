// Starts the fake API (:4901) and fake Prometheus/Grafana (:4902) and keeps them running, for looking at the page by hand:
//   node test/run-mocks.mjs        then, in another terminal:
//   LAB_TARGET=http://127.0.0.1:4901 LAB_PROMETHEUS=http://127.0.0.1:4902 LAB_GRAFANA=http://127.0.0.1:4902 PORT=4900 npm start
import { startMockTarget, startMockObservability } from './mock-target.mjs';

await startMockTarget(4901, { wsLimit: 50 });
await startMockObservability(4902);
console.log('fake API on :4901, fake Prometheus/Grafana on :4902');
