// Canonical example: create objects programmatically via window.__avlo, frame them,
// screenshot, and assert on state. This is the reference pattern for verifying a canvas
// change end-to-end. Run against `pnpm dev:web` (no workers needed):
//   node scripts/verify/demo.mjs

import assert from 'node:assert/strict';
import { launch } from './browser.mjs';

const h = await launch();
try {
  await h.openRoom();

  // Start clean, then build a deterministic scene through the dev bridge.
  await h.page.evaluate(() => {
    const a = window.__avlo;
    a.clearAll();
    a.createShape({ x: 100, y: 100, w: 240, h: 150, shapeType: 'rect', fillColor: '#dbeafe' });
    a.createShape({ x: 420, y: 160, w: 180, h: 180, shapeType: 'ellipse', color: '#db2777' });
    a.createText({ x: 120, y: 300, text: 'Verified via window.__avlo', fontSize: 28 });
    a.createNote({ x: 460, y: 380, text: 'headless, worker-free' });
  });

  // Frame everything and let a frame paint before the screenshot.
  await h.page.evaluate(() => window.__avlo.fit());
  await h.page.evaluate(() => window.__avlo.waitForIdle());
  const file = await h.snap('demo');

  const count = await h.page.evaluate(() => window.__avlo.count());
  console.log(`objects: ${count}`);
  console.log(`screenshot → ${file}`);

  assert.equal(count, 4, `expected 4 objects, got ${count}`);
  assert.equal(h.errors.length, 0, `unexpected console errors:\n${h.errors.join('\n')}`);
  console.log('✅ demo passed — 4 objects created and rendered, no console errors');
} finally {
  await h.close();
}
