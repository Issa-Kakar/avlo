// Sync-floor ↔ Lezer-ceiling parity harness (node).
// Run from web/:  pnpm dlx tsx scripts/token-parity.mjs
//
// Runs the REAL syncTokenizeInto against the REAL grammar parsers with the
// WORKER_RULES mapping, compares per-character PALETTE COLOR (not S id — twin
// greens/whites are equivalent), prints mismatch runs per language.
//
// Expected state: javascript/json/sql/css/html report PERFECT PARITY on this
// corpus; typescript/python report only the documented needs-AST flickers
// (type-position names, generic <>, template/f-string interpolation bodies,
// PascalCase, interface-method call heuristic).
//
// RULES below is a copy of lezer-worker.ts WORKER_RULES — keep in sync.
import { highlightTree, tags } from '@lezer/highlight';

import { syncTokenizeInto } from '../src/core/code/code-tokenizer.ts';
import { CODE_THEME, S } from '../src/core/code/code-tokens.ts';

const PAL = CODE_THEME.palette;

// --- WORKER_RULES copy (keep in sync with lezer-worker.ts while testing) ---
const RULES = [
  { tags: [tags.keyword, tags.operatorKeyword, tags.controlKeyword], style: S.KEYWORD },
  { tags: [tags.definitionKeyword], style: S.STORAGE },
  { tags: [tags.moduleKeyword, tags.modifier], style: S.MODIFIER },
  { tags: [tags.meta], style: S.LANG_VAR },
  {
    tags: [tags.string, tags.special(tags.string), tags.special(tags.brace), tags.regexp, tags.character, tags.attributeValue],
    style: S.STRING,
  },
  { tags: [tags.escape], style: S.OPERATOR },
  { tags: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.color], style: S.NUMBER },
  { tags: [tags.lineComment, tags.blockComment, tags.docComment], style: S.COMMENT },
  { tags: [tags.function(tags.definition(tags.variableName)), tags.className, tags.definition(tags.typeName)], style: S.FUNCTION_DEF },
  { tags: [tags.definition(tags.propertyName)], style: S.DEFAULT },
  { tags: [tags.function(tags.variableName), tags.function(tags.propertyName)], style: S.FUNCTION_CALL },
  { tags: [tags.self], style: S.LANG_VAR },
  { tags: [tags.variableName, tags.definition(tags.variableName)], style: S.VARIABLE },
  { tags: [tags.typeName, tags.propertyName, tags.namespace], style: S.TYPE },
  { tags: [tags.tagName, tags.angleBracket], style: S.KEYWORD },
  { tags: [tags.unit], style: S.KEYWORD },
  {
    tags: [
      tags.operator,
      tags.compareOperator,
      tags.logicOperator,
      tags.arithmeticOperator,
      tags.bitwiseOperator,
      tags.updateOperator,
      tags.definitionOperator,
      tags.typeOperator,
      tags.controlOperator,
    ],
    style: S.OPERATOR,
  },
  { tags: [tags.derefOperator, tags.function(tags.punctuation)], style: S.OPERATOR },
  { tags: [tags.bracket, tags.squareBracket, tags.paren, tags.brace], style: S.DEFAULT },
  { tags: [tags.attributeName, tags.labelName], style: S.ATTRIBUTE },
  { tags: [tags.invalid], style: S.INVALID },
];
const TAG_TO_S = new Map();
for (const r of RULES) for (const t of r.tags) TAG_TO_S.set(t, r.style);
const HL = {
  style(tagList) {
    for (const tag of tagList) {
      for (const t of tag.set) {
        const s = TAG_TO_S.get(t);
        if (s !== undefined) return String(s);
      }
    }
    return null;
  },
};

async function getParser(lang) {
  if (lang === 'javascript') return (await import('@lezer/javascript')).parser.configure({ dialect: 'jsx' });
  if (lang === 'typescript') return (await import('@lezer/javascript')).parser.configure({ dialect: 'ts jsx' });
  if (lang === 'python') return (await import('@lezer/python')).parser;
  if (lang === 'json') return (await import('@lezer/json')).parser;
  if (lang === 'css') return (await import('@lezer/css')).parser;
  if (lang === 'sql') return (await import('../src/core/code/vendor/sql/index.ts')).parser;
  if (lang === 'html') {
    const [html, css, js] = await Promise.all([import('@lezer/html'), import('@lezer/css'), import('@lezer/javascript')]);
    return html.parser.configure({
      wrap: html.configureNesting(
        [
          { tag: 'script', attrs: (a) => a.type === 'text/typescript' || a.lang === 'ts', parser: js.parser.configure({ dialect: 'ts' }) },
          {
            tag: 'script',
            attrs: (a) => a.type === 'text/babel' || a.type === 'text/jsx',
            parser: js.parser.configure({ dialect: 'jsx' }),
          },
          { tag: 'script', attrs: (a) => a.type === 'text/typescript-jsx', parser: js.parser.configure({ dialect: 'jsx ts' }) },
          {
            tag: 'script',
            attrs: (a) => /^(importmap|speculationrules|application\/(.+\+)?json)$/i.test(a.type),
            parser: js.parser.configure({ top: 'SingleExpression' }),
          },
          {
            tag: 'script',
            attrs: (a) => !a.type || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^module$|^$/i.test(a.type),
            parser: js.parser,
          },
          {
            tag: 'style',
            attrs: (a) => (!a.lang || a.lang === 'css') && (!a.type || /^(text\/)?(x-)?(stylesheet|css)$/i.test(a.type)),
            parser: css.parser,
          },
        ],
        [{ name: 'style', parser: css.parser.configure({ top: 'Styles' }) }],
      ),
    });
  }
  throw new Error(lang);
}

function buildSource(text) {
  const lines = [];
  lines.push(0);
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines.push(i + 1);
  lines.push(text.length + 1); // sentinel
  return { fullText: text, lineStart: Uint32Array.from(lines), lineCount: lines.length - 1 };
}

function syncColors(text, lang) {
  const source = buildSource(text);
  const out = {
    spanData: new Uint16Array(8),
    spanCap: 8,
    spanLineStart: new Uint32Array(source.lineCount + 1),
    lineCap: source.lineCount,
    lineCount: 0,
  };
  syncTokenizeInto(source, lang, out);
  const colors = new Array(text.length).fill(PAL[S.DEFAULT]);
  for (let li = 0; li < source.lineCount; li++) {
    const lineFrom = source.lineStart[li];
    for (let t = out.spanLineStart[li]; t < out.spanLineStart[li + 1]; t += 3) {
      const off = out.spanData[t],
        len = out.spanData[t + 1],
        style = out.spanData[t + 2];
      for (let k = 0; k < len; k++) colors[lineFrom + off + k] = PAL[style === S.WHITESPACE ? S.DEFAULT : style];
    }
  }
  return colors;
}

function lezerColors(text, parser) {
  const colors = new Array(text.length).fill(PAL[S.DEFAULT]);
  highlightTree(parser.parse(text), HL, (from, to, cls) => {
    const parts = cls.split(' ');
    const s = Number(parts[parts.length - 1]);
    for (let k = from; k < to; k++) colors[k] = PAL[s];
  });
  return colors;
}

const CORPUS = {
  typescript: `import { thing } from './mod';
export async function greet(name: string): Promise<void> {
  const msg = \`hello \${name} — \${1 + 2}\`;
  class Foo extends Bar {}
  type Alias = { x: number };
  interface Shape { area(): number }
  let n = 0x1f + 3.14e2;
  obj.method(n);
  // line comment
  /* block
     comment */
  return this.run(msg);
}`,
  javascript: `const add = (a, b) => a + b;
function outer() {
  const s = 'str\\n' + "two";
  return add(1, 2) * 0b101;
}`,
  python: `import os
# a comment
class Greeter:
    def greet(self, name):
        msg = f"hi {name}"
        doc = """triple
        string"""
        return msg or None
print(Greeter().greet(True))`,
  json: `{
  "name": "avlo",
  "version": 2,
  "pi": -3.14e-2,
  "ok": true,
  "nope": false,
  "nil": null,
  "tags": ["a", "b\\"c", 0, 1.5],
  "nested": { "deep": { "x": [] } }
}`,
  sql: `SELECT id, name FROM users u
WHERE u.age > 21 AND active = TRUE  -- adults only
  AND note <> 'it''s fine'
/* outer /* nested */ comment */
ORDER BY created_at DESC;
CREATE TABLE t (n integer, b bit, x varchar(10));
SELECT E'esc\\n', B'0101', 0x1F, x'FF', .5, 1e3, "Quoted Id", sch.tbl FROM t;
SELECT 'multi
line string' FROM dual;`,
  css: `/* card styles */
.card, #main > p.intro:hover {
  color: #ff79c6;
  margin: 0 auto 10.5px -2em;
  width: calc(100% - 20px);
  background: url(img/bg.png) no-repeat;
  font: 16px/1.5 "JetBrains Mono", monospace;
  --accent: rgb(80, 250, 123);
  border-color: var(--accent) !important;
}
@media screen and (min-width: 600px) {
  a[target="_blank"]::after { content: "\\2197"; display: inline-block; }
}
@keyframes slide-in {
  from { opacity: 0; }
  to { opacity: 1; }
}`,
  html: `<!DOCTYPE html>
<html lang="en">
  <!-- header section -->
  <head>
    <meta charset="utf-8">
    <title>Demo &amp; Test</title>
    <style>
      .btn { color: #50fa7b; padding: 4px 8px; }
    </style>
  </head>
  <body class=main data-x="1">
    <p>Hello <b>world</b> &#169;</p>
    <script>
      const greet = (name) => \`hi \${name}\`;
      function add(a, b) { return a + b; } // sum
      let n = 42 * 0x1f;
    </script>
  </body>
</html>`,
};

const NAME_BY_HEX = {
  '#F8F8F2': 'fg',
  '#FF79C6': 'pink',
  '#8BE9FD': 'cyan',
  '#F1FA8C': 'yellow',
  '#BD93F9': 'purple',
  '#AEAEAE': 'grey',
  '#50FA7B': 'green',
  '#FF5555': 'red',
};

for (const [lang, text] of Object.entries(CORPUS)) {
  const parser = await getParser(lang);
  const sync = syncColors(text, lang);
  const lez = lezerColors(text, parser);
  const mismatches = [];
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) === 10 || sync[i] === lez[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && text.charCodeAt(j) !== 10 && sync[j] !== lez[j]) j++;
    mismatches.push(
      `  [${i},${j}) ${JSON.stringify(text.slice(i, j))} sync=${NAME_BY_HEX[sync[i]] ?? sync[i]} lezer=${NAME_BY_HEX[lez[i]] ?? lez[i]}`,
    );
    i = j;
  }
  console.log(`== ${lang}: ${mismatches.length === 0 ? 'PERFECT PARITY' : `${mismatches.length} mismatch run(s)`}`);
  for (const m of mismatches) console.log(m);
}
