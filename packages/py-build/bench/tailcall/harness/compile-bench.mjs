// Measures pure WebAssembly.compile() wall time for a module, under whatever
// V8 flags this process was launched with. Run with --liftoff-only for baseline
// tier cost, --no-liftoff for top-tier (TurboFan) cost.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const iters = Number(process.argv[3] ?? 5);
const src = readFileSync(path);

const times = [];
for (let i = 0; i < iters; i++) {
  // fresh copy each round so V8 cannot reuse an internal cache keyed on the buffer
  const bytes = new Uint8Array(src.byteLength);
  bytes.set(src);
  const t0 = performance.now();
  await WebAssembly.compile(bytes);
  times.push(performance.now() - t0);
}

const sorted = [...times].sort((a, b) => a - b);
console.log(
  'COMPILE_JSON:' +
    JSON.stringify({
      file: path,
      first: times[0],
      min: sorted[0],
      median: sorted[Math.floor(sorted.length / 2)],
      all: times.map((t) => Math.round(t * 100) / 100),
    }),
);
