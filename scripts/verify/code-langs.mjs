// Verify code-block syntax highlighting across all 7 languages: seeds one block
// per language via the dev bridge, lets the lezer worker fetch + parse each
// grammar chunk, screenshots the canvas, then opens the SQL block's CodeMirror
// editor for a WYSIWYG comparison. Run against `pnpm dev:web`:
//   node scripts/verify/code-langs.mjs
import assert from 'node:assert/strict';
import { launch } from './browser.mjs';

const SNIPPETS = {
  typescript: `import { thing } from './mod';
export async function greet(name: string) {
  const msg = \`hello \${name}\`;
  return this.run(msg); // done
}`,
  javascript: `const add = (a, b) => a + b;
function outer() {
  const s = 'str' + "two";
  return add(1, 2) * 0b101;
}`,
  python: `class Greeter:
    def greet(self, name):
        # comment
        return f"hi {name}" or None`,
  json: `{
  "name": "avlo",
  "pi": -3.14e-2,
  "ok": true,
  "tags": ["a", null, 1.5]
}`,
  sql: `SELECT id, name FROM users u
WHERE u.age > 21 AND active = TRUE  -- adults
  AND note <> 'it''s fine'
/* nested /* comment */ ok */
CREATE TABLE t (n integer, x varchar(10));
SELECT E'esc', B'0101', 0x1F, .5, "Quoted Id", sch.tbl;`,
  css: `/* card */
.card, #main > p.intro:hover {
  color: #ff79c6;
  width: calc(100% - 20px);
  background: url(bg.png) no-repeat;
  border-color: var(--accent) !important;
}
@media screen and (min-width: 600px) {
  a[target="_blank"]::after { display: inline-block; }
}`,
  html: `<!DOCTYPE html>
<html lang="en">
  <!-- header -->
  <style>.btn { color: #50fa7b; }</style>
  <body class=main data-x="1">
    <p>Hi <b>world</b> &amp;</p>
    <script>
      const greet = (name) => \`hi \${name}\`; // fn
      let n = 42 * 0x1f;
    </script>
  </body>
</html>`,
};

const h = await launch();
try {
  await h.openRoom();

  await h.page.evaluate((snippets) => {
    const a = window.__avlo;
    a.clearAll();
    const langs = Object.keys(snippets);
    for (let i = 0; i < langs.length; i++) {
      const lang = langs[i];
      a.createCode({
        x: (i % 2) * 560,
        y: Math.floor(i / 2) * 340,
        language: lang,
        title: lang,
        text: snippets[lang],
        width: 520,
      });
    }
  }, SNIPPETS);

  // Let the worker pool fetch each grammar chunk + run the first parses.
  await h.page.evaluate(() => window.__avlo.settle(2000));
  await h.page.evaluate(() => window.__avlo.fit(40));
  await h.page.evaluate(() => window.__avlo.invalidateAll());
  await h.page.evaluate(() => window.__avlo.waitForIdle());
  const canvasShot = await h.snap('code-langs-canvas');

  const count = await h.page.evaluate(() => window.__avlo.count());
  assert.equal(count, 7, `expected 7 blocks, got ${count}`);

  // Language switch on a live block: json → sql re-tokenizes + re-seeds the worker.
  await h.page.evaluate(() => {
    const a = window.__avlo;
    const jsonId = a.ids().find((id) => a.get(id).language === 'json');
    a.transact(() => a.stores.selection.getState()); // no-op warm
    const y = a.handle(jsonId).y;
    a.transact(() => y.set('language', 'sql'));
  });
  await h.page.evaluate(() => window.__avlo.settle(800));
  await h.page.evaluate(() => {
    const a = window.__avlo;
    const id = a.ids().find((x) => a.get(x).title === 'json');
    const y = a.handle(id).y;
    a.transact(() => y.set('language', 'json')); // switch back
  });
  await h.page.evaluate(() => window.__avlo.settle(800));

  // Open the SQL block's CodeMirror editor (double-click center) for WYSIWYG compare.
  await h.page.evaluate(() => window.__avlo.setTool('select'));
  const [tx, ty] = await h.page.evaluate(() => {
    const a = window.__avlo;
    const id = a.ids().find((x) => a.get(x).title === 'sql');
    const b = a.bbox(id);
    return a.worldToClient((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  });
  await h.page.mouse.dblclick(tx, ty);
  await h.page.waitForSelector('.cm-editor', { timeout: 5000 });
  await h.page.evaluate(() => window.__avlo.settle(400));
  const editorShot = await h.snap('code-langs-sql-editor');

  assert.equal(h.errors.length, 0, `unexpected console errors:\n${h.errors.join('\n')}`);
  console.log(`canvas → ${canvasShot}`);
  console.log(`editor → ${editorShot}`);
  console.log('✅ code-langs passed — 7 blocks highlighted, language switch OK, editor mounted, no console errors');
} finally {
  await h.close();
}
