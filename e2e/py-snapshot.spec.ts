import { expect, test } from './fixtures';

/**
 * P2 owned-snapshot lifecycle over a REAL browser: cold boot + capture →
 * `opfs:/py/<hash>/numpy.snap` lands → reload → restored boot (trace-asserted)
 * → warm re-run in the same generation (no new boot). Timing/RAM ledgers are
 * the owner's browser board — this spec pins CORRECTNESS of the loop only.
 *
 * Needs the FULL dev stack (`pnpm dev`: vite + workers — the py worker serves
 * the lock-pinned artifacts out of local R2; seed via `pnpm py:seed`). The
 * auto-started `pnpm dev:web` alone cannot serve /api/py.
 */

declare global {
  interface Window {
    __avloPyTraces?: string[];
  }
}

/** Parsed sup-side boot trace lines (`{th:'sup', kind:'boot', path, …}`). */
const supBoots = () =>
  (window.__avloPyTraces ?? [])
    .map((l) => JSON.parse(l) as { th: string; kind: string; path?: string })
    .filter((t) => t.th === 'sup' && t.kind === 'boot');

test('owned snapshot: cold+capture → OPFS → restore → warm run', async ({ page, avlo }) => {
  test.setTimeout(240_000);
  await avlo.openRoom();
  // A cold Vite dep-optimizer cache forces a full page reload moments after
  // the first load, which would wipe the bridge and kill an in-flight run.
  // Settle it, then re-enter on the optimized module graph deterministically.
  await page.waitForTimeout(2_500);
  await page.reload();
  await page.waitForFunction(() => window.__avlo?.hasRoom() === true);

  const id = await page.evaluate(() =>
    window.__avlo!.createCode({
      x: 300,
      y: 300,
      language: 'python',
      text: 'import numpy\nprint(int(numpy.ones(4).sum()))',
    }),
  );

  // Run 1 — no snapshot exists: cold boot + bake + capture riding the boot.
  await page.evaluate((bid) => window.__avlo!.runCode(bid), id);
  await page.waitForFunction((bid) => window.__avlo?.get(bid)?.outputStatus === 'ok', id, { timeout: 120_000 });
  expect(await page.evaluate((bid) => window.__avlo!.get(bid)?.output, id)).toContain('4');
  expect(await page.evaluate(supBoots)).toEqual([expect.objectContaining({ path: 'cold boot + capture (no valid snapshot)' })]);

  // The supervisor's fire-and-forget OPFS write overlaps the run — wait for
  // the set's .snap to land (main thread sees the same origin OPFS).
  await page.waitForFunction(
    async () => {
      try {
        const py = await (await navigator.storage.getDirectory()).getDirectoryHandle('py');
        for await (const name of py.keys()) {
          const dir = await py.getDirectoryHandle(name);
          try {
            await dir.getFileHandle('numpy.snap');
            return true;
          } catch {
            /* not yet */
          }
        }
      } catch {
        /* py dir not created yet */
      }
      return false;
    },
    undefined,
    { timeout: 60_000 },
  );

  // Reload — fresh workers, same origin storage. The block persists via
  // y-indexeddb; the snapshot via OPFS.
  await page.reload();
  await page.waitForFunction(() => window.__avlo?.hasRoom() === true);

  // Run 2 — the executor's snap-probe hits and the boot restores. Clear the
  // persisted output first so the ok-wait below observes THIS run.
  await page.evaluate((bid) => {
    window.__avlo!.transact(() => {
      window.__avlo!.handle(bid)!.y.delete('output');
      window.__avlo!.handle(bid)!.y.delete('outputStatus');
    });
  }, id);
  await page.evaluate((bid) => window.__avlo!.runCode(bid), id);
  await page.waitForFunction((bid) => window.__avlo?.get(bid)?.outputStatus === 'ok', id, { timeout: 120_000 });
  expect(await page.evaluate((bid) => window.__avlo!.get(bid)?.output, id)).toContain('4');
  expect(await page.evaluate(supBoots)).toEqual([expect.objectContaining({ path: 'restored OPFS snapshot' })]);

  // Run 3 — warm run in the SAME generation (inside the 15 s idle window):
  // no new boot line, same correct result (the blit reset keeps numpy baked).
  await page.evaluate((bid) => {
    window.__avlo!.transact(() => {
      window.__avlo!.handle(bid)!.y.delete('output');
      window.__avlo!.handle(bid)!.y.delete('outputStatus');
    });
  }, id);
  await page.evaluate((bid) => window.__avlo!.runCode(bid), id);
  await page.waitForFunction((bid) => window.__avlo?.get(bid)?.outputStatus === 'ok', id, { timeout: 30_000 });
  expect(await page.evaluate((bid) => window.__avlo!.get(bid)?.output, id)).toContain('4');
  expect(await page.evaluate(supBoots)).toHaveLength(1); // still just the restore boot
});
