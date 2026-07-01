/**
 * Lezer Worker — Incremental parsing + flat span extraction
 *
 * One of 2 warm pool workers. Owns per-object parse state (Tree + TreeFragments +
 * text mirror). Main thread never touches parse state.
 *
 * Protocol:
 *   Main → Worker: { type:'parse', id, language, version, text }   // full seed/reset — mirror = text
 *   Main → Worker: { type:'parse', id, language, version, edits }  // Yjs delta — splice mirror + incremental parse
 *   Main → Worker: { type:'remove', id }
 *   Main → Worker: { type:'clearAll' }
 *   Worker → Main: { type:'spans', id, version, spanData: Uint16Array, spanLineStart: Uint32Array }
 *                  (both ArrayBuffers transferred zero-copy)
 *
 * The worker keeps a per-id text mirror so edits arrive as tiny Yjs deltas
 * instead of the full re-serialized block text on every keystroke. The mirror
 * splice and the incremental `ChangedRange[]` both derive from one delta pass.
 *
 * Parsers load lazily per language via dynamic `import()` (see REGISTRY) — no
 * grammar is resident until the first block of that language appears. Steady
 * state stays synchronous; only the first block of a not-yet-loaded language
 * buffers (in arrival order) for the ~1-frame load, preserving per-id ordering.
 *
 * Lezer-tag → S mapping lives inline at the bottom of this file as `STYLE_HIGHLIGHTER`
 * (returns the stringified S int directly; `highlightTree` callback recovers via
 * `+classes | 0`). `code-theme.ts` carries its own copy of the same mapping for
 * the CodeMirror DOM theme — deliberate duplication so the main bundle never has
 * to import `@lezer/highlight`.
 */

import type { Parser, Tree } from '@lezer/common';
import { TreeFragment } from '@lezer/common';
import type { Highlighter, Tag } from '@lezer/highlight';
import { highlightTree, tags } from '@lezer/highlight';

import { S, writePackedTriples } from './code-tokens';

// ============================================================================
// Per-object state
// ============================================================================

interface ParseState {
  tree: Tree;
  fragments: readonly TreeFragment[];
  mirror: string; // worker-side text mirror — spliced per edit delta
}

const state = new Map<string, ParseState>();

// ============================================================================
// Lazy per-language parser registry — dynamic import(), configured on first use
// ============================================================================

// The configurable LR parser type — derived from a grammar module so we don't
// import `@lezer/lr` directly (pnpm won't resolve it from web; it's only a
// transitive dep of the grammar packages). `.configure()` lives on this type,
// not on `@lezer/common`'s abstract `Parser`.
type LRParser = typeof import('@lezer/javascript')['parser'];

// language → { load: dynamic import, configure?: post-load parser config }.
// `@lezer/javascript` backs both js/ts — the second import() resolves to the
// same already-fetched module chunk, so only the `.configure()` differs.
const REGISTRY: Record<string, { load: () => Promise<{ parser: LRParser }>; configure?: (p: LRParser) => Parser }> = {
  javascript: { load: () => import('@lezer/javascript'), configure: (p) => p.configure({ dialect: 'jsx' }) },
  typescript: { load: () => import('@lezer/javascript'), configure: (p) => p.configure({ dialect: 'ts jsx' }) },
  python: { load: () => import('@lezer/python') },
  // sql / html added later — one entry each (resolve exact grammar pkg then;
  // @lezer/html for HTML; SQL likely via @codemirror/lang-sql's parser).
};

const parsers = new Map<string, Parser>(); // loaded, configured
const loading = new Map<string, Promise<Parser>>(); // in-flight loads

/** Resolve a parser — cached if resident, else start (or join) its dynamic load. */
function getParser(language: string): Promise<Parser> {
  const cached = parsers.get(language);
  if (cached) return Promise.resolve(cached);

  const inFlight = loading.get(language);
  if (inFlight) return inFlight;

  const entry = REGISTRY[language] ?? REGISTRY.javascript;
  const promise = entry.load().then((mod) => {
    const configured = entry.configure ? entry.configure(mod.parser) : mod.parser;
    parsers.set(language, configured);
    loading.delete(language);
    return configured;
  });
  loading.set(language, promise);
  return promise;
}

// ============================================================================
// Parse
// ============================================================================

interface ChangedRange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

type DeltaOp = { retain?: number; insert?: string | object; delete?: number };

/**
 * Splice `mirror` per Yjs delta op AND derive the incremental `ChangedRange[]`
 * in one pass — both the fresh text and the ranges come from the same walk.
 * (Ported from the former main-thread `deltaToChangedRanges` + a mirror splice.)
 */
function applyEdits(mirror: string, edits: DeltaOp[]): { text: string; changes: ChangedRange[] } {
  const ranges: ChangedRange[] = [];
  let result = '';
  let posOld = 0; // read cursor into `mirror`
  let posNew = 0; // write cursor into `result`

  for (const op of edits) {
    if (op.retain) {
      result += mirror.slice(posOld, posOld + op.retain);
      posOld += op.retain;
      posNew += op.retain;
    } else if (op.delete) {
      const len = op.delete;
      ranges.push({ fromA: posOld, toA: posOld + len, fromB: posNew, toB: posNew });
      posOld += len;
    } else if (op.insert) {
      const ins = typeof op.insert === 'string' ? op.insert : '';
      result += ins;
      const len = ins.length;
      ranges.push({ fromA: posOld, toA: posOld, fromB: posNew, toB: posNew + len });
      posNew += len;
    }
  }
  // Untouched tail (delta ends before the mirror's end — Yjs omits a trailing retain).
  result += mirror.slice(posOld);

  // Merge adjacent ranges (select+type/paste → delete+insert at same position)
  let wi = 0;
  for (let i = 0; i < ranges.length; i++) {
    if (wi > 0 && ranges[wi - 1].toA === ranges[i].fromA && ranges[wi - 1].toB === ranges[i].fromB) {
      ranges[wi - 1].toA = ranges[i].toA;
      ranges[wi - 1].toB = ranges[i].toB;
    } else {
      ranges[wi++] = ranges[i];
    }
  }
  ranges.length = wi;

  return { text: result, changes: ranges };
}

function parse(id: string, parser: Parser, text: string, changes?: ChangedRange[]): Tree {
  const prev = state.get(id);

  let tree: Tree;
  let fragments: readonly TreeFragment[];

  if (prev && changes && changes.length > 0) {
    const updatedFragments = TreeFragment.applyChanges(prev.fragments, changes);
    tree = parser.parse(text, updatedFragments);
    fragments = TreeFragment.addTree(tree, updatedFragments);
  } else {
    tree = parser.parse(text);
    fragments = TreeFragment.addTree(tree);
  }

  state.set(id, { tree, fragments, mirror: text });
  return tree;
}

/**
 * Resolve text + incremental changes for a parse message, run the parse, and
 * emit spans. `msg.text` present → full seed/reset; else `msg.edits` (Yjs delta)
 * splices the existing mirror. The `seeded` guard on the main side ensures an
 * `edits` message never precedes its full seed, so `prev` is present here.
 */
function processParse(msg: { id: string; version: number; text?: string; edits?: DeltaOp[] }, parser: Parser): void {
  const { id, version } = msg;
  let text: string;
  let changes: ChangedRange[] | undefined;

  if (msg.text !== undefined) {
    text = msg.text;
  } else {
    const prev = state.get(id);
    if (!prev) return; // edits before seed — shouldn't happen (main gates via `seeded`)
    const applied = applyEdits(prev.mirror, msg.edits as DeltaOp[]);
    text = applied.text;
    changes = applied.changes;
  }

  const tree = parse(id, parser, text, changes);
  extractAndSendSpans(tree, text, id, version);
}

// ============================================================================
// Span extraction — walks tree, packs flat spanData / spanLineStart
// ============================================================================

// Reusable buffers — persisted across calls, zero allocation per parse beyond transfer.
let _workerLineOffsets = new Uint32Array(64); // [lineCap + 1]; sentinel slot included
const _hlBuf: number[] = [];
let _hlCount = 0;
const _lineBuf: number[] = [];
let _workerSpanData = new Uint16Array(256);

function ensureLineOffsetsCap(n: number): void {
  // Need slots [0..n] inclusive (n+1 slots), so the sentinel at index n always fits.
  if (_workerLineOffsets.length >= n + 1) return;
  let cap = _workerLineOffsets.length;
  while (cap < n + 1) cap *= 2;
  _workerLineOffsets = new Uint32Array(cap);
}

function ensureWorkerSpanCap(n: number): void {
  if (_workerSpanData.length >= n) return;
  let cap = _workerSpanData.length;
  while (cap < n) cap *= 2;
  _workerSpanData = new Uint16Array(cap);
}

function binarySearchLine(offsets: Uint32Array, lineCount: number, pos: number): number {
  let lo = 0;
  let hi = lineCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Walk the tree, build flat span buffers, post + transfer in one go. */
function extractAndSendSpans(tree: Tree, text: string, id: string, version: number): void {
  // 1. Build line-offset table via charCode-10 scan.
  let lineCount = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineCount++;
  }
  ensureLineOffsetsCap(lineCount);
  const lineOffsets = _workerLineOffsets;
  lineOffsets[0] = 0;
  let li = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineOffsets[li++] = i + 1;
  }
  // Sentinel: text.length + 1 so lineLen(i) = lineOffsets[i+1] - lineOffsets[i] - 1
  lineOffsets[lineCount] = text.length + 1;

  // 2. First pass: collect highlights into flat quad buffer [lineIdx, from, to, style].
  _hlCount = 0;
  highlightTree(tree, STYLE_HIGHLIGHTER, (from, to, classes) => {
    if (!classes) return;
    // STYLE_HIGHLIGHTER returns the stringified S enum value directly.
    const style = +classes | 0;

    let lineIdx = binarySearchLine(lineOffsets, lineCount, from);

    while (lineIdx < lineCount) {
      const lineStart = lineOffsets[lineIdx];
      const lineLen = lineOffsets[lineIdx + 1] - lineStart - 1;
      const lineEnd = lineStart + lineLen;

      if (from >= lineEnd) {
        lineIdx++;
        continue;
      }
      if (to <= lineStart) break;

      const tokenFrom = from > lineStart ? from - lineStart : 0;
      const tokenTo = to - lineStart < lineLen ? to - lineStart : lineLen;

      if (tokenFrom < tokenTo) {
        const idx = _hlCount * 4;
        if (idx + 3 >= _hlBuf.length) _hlBuf.length = idx + 64;
        _hlBuf[idx] = lineIdx;
        _hlBuf[idx + 1] = tokenFrom;
        _hlBuf[idx + 2] = tokenTo;
        _hlBuf[idx + 3] = style;
        _hlCount++;
      }

      if (to <= lineEnd) break;
      lineIdx++;
    }
  });

  // 3. Pre-grow working span buffer to upper bound (each highlight contributes ≤ 2 triples,
  //    each line ≤ 1 trailing-gap triple, plus 1 default-fill for highlight-free lines).
  const upperBoundTriples = _hlCount * 2 + lineCount + 1;
  ensureWorkerSpanCap(upperBoundTriples * 3);

  // 4. Allocate exact-sized spanLineStart for transfer.
  const spanLineStart = new Uint32Array(lineCount + 1);

  // 5. Sequential cursor scan — pack each line's triples into _workerSpanData.
  let writeOffset = 0;
  let cursor = 0;

  for (let i = 0; i < lineCount; i++) {
    spanLineStart[i] = writeOffset;
    const lineLen = lineOffsets[i + 1] - lineOffsets[i] - 1;
    const lineFrom = lineOffsets[i];

    if (cursor >= _hlCount || _hlBuf[cursor * 4] !== i) {
      // No highlights on this line — packs to 0 triples (empty) or 1 default-fill
      // (which becomes S.WHITESPACE for pure-ws lines via writePackedTriples).
      writeOffset = writePackedTriples(_workerSpanData, lineLen, _emptyBuf, 0, writeOffset, text, lineFrom);
      continue;
    }

    let count = 0;
    while (cursor < _hlCount && _hlBuf[cursor * 4] === i) {
      const base = cursor * 4;
      const tripleBase = count * 3;
      if (tripleBase + 2 >= _lineBuf.length) _lineBuf.length = tripleBase + 30;
      _lineBuf[tripleBase] = _hlBuf[base + 1];
      _lineBuf[tripleBase + 1] = _hlBuf[base + 2];
      _lineBuf[tripleBase + 2] = _hlBuf[base + 3];
      count++;
      cursor++;
    }
    writeOffset = writePackedTriples(_workerSpanData, lineLen, _lineBuf, count, writeOffset, text, lineFrom);
  }
  spanLineStart[lineCount] = writeOffset;

  // 6. Copy used prefix into a fresh transfer buffer (zero-copy on postMessage).
  const spanData = _workerSpanData.slice(0, writeOffset);

  (self as unknown as Worker).postMessage({ type: 'spans', id, version, spanData, spanLineStart }, [spanData.buffer, spanLineStart.buffer]);
}

const _emptyBuf: number[] = [];

// ============================================================================
// Lezer-tag → S mapping  (worker-side copy; the theme has its own — keep in sync)
// ============================================================================

// Modifier-set walk matches `@lezer/highlight`'s `tagHighlighter` semantics so
// modifier tags like `tags.local(tags.variableName)` resolve to their base. Walk
// returns on first match (most-specific → least-specific within each tag's set).
//
// Notable rules:
//   - `tags.separator` is deliberately unmapped → falls through to DEFAULT.
//   - `tags.definition(tags.propertyName)` → DEFAULT explicitly: `definition` has
//     lower Modifier.id than `function`, so for
//     `function(definition(propertyName))` the walk hits this entry BEFORE the
//     `function(propertyName)` → FUNCTION_CALL rule. One row covers obj-literal
//     keys, class fields, method shorthand, AND class methods.
//   - No fontWeight / fontStyle anywhere — Sweet Dracula is color-only.
const WORKER_RULES: readonly { tags: Tag[]; style: S }[] = [
  { tags: [tags.keyword, tags.operatorKeyword, tags.controlKeyword], style: S.KEYWORD },
  { tags: [tags.definitionKeyword], style: S.STORAGE },
  { tags: [tags.moduleKeyword, tags.modifier], style: S.MODIFIER },
  { tags: [tags.meta], style: S.LANG_VAR },
  { tags: [tags.string, tags.special(tags.string), tags.special(tags.brace), tags.regexp, tags.character], style: S.STRING },
  { tags: [tags.escape], style: S.OPERATOR },
  { tags: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], style: S.NUMBER },
  { tags: [tags.lineComment, tags.blockComment, tags.docComment], style: S.COMMENT },
  {
    tags: [tags.function(tags.definition(tags.variableName)), tags.className, tags.definition(tags.typeName)],
    style: S.FUNCTION_DEF,
  },
  { tags: [tags.definition(tags.propertyName)], style: S.DEFAULT },
  {
    tags: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    style: S.FUNCTION_CALL,
  },
  { tags: [tags.self], style: S.LANG_VAR },
  { tags: [tags.variableName, tags.definition(tags.variableName), tags.labelName], style: S.VARIABLE },
  { tags: [tags.typeName, tags.propertyName, tags.namespace], style: S.TYPE },
  { tags: [tags.tagName, tags.angleBracket], style: S.KEYWORD },
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
  { tags: [tags.derefOperator], style: S.OPERATOR },
  { tags: [tags.bracket, tags.squareBracket, tags.paren, tags.brace], style: S.DEFAULT },
  { tags: [tags.attributeName], style: S.ATTRIBUTE },
  { tags: [tags.invalid], style: S.INVALID },
];

const TAG_TO_S = new Map<Tag, S>();
for (const r of WORKER_RULES) for (const t of r.tags) TAG_TO_S.set(t, r.style);

// Pre-stringified per-S labels so the Highlighter callback never allocates.
const _classCache: string[] = [];
for (const r of WORKER_RULES) _classCache[r.style] = String(r.style);

const STYLE_HIGHLIGHTER: Highlighter = {
  style(tagList) {
    for (let i = 0; i < tagList.length; i++) {
      const set = tagList[i].set;
      for (let j = 0; j < set.length; j++) {
        const s = TAG_TO_S.get(set[j]);
        if (s !== undefined) return _classCache[s];
      }
    }
    return null;
  },
};

// ============================================================================
// Message handler — synchronous steady state, buffer-during-load per language
// ============================================================================

// Parse messages that arrived before their language's parser finished loading,
// keyed by language, kept in arrival order. Drained in order once loaded so an
// id's incremental fragment/mirror state stays consistent (language is fixed
// per edit, so per-id order is preserved).
const pending = new Map<string, { id: string; version: number; text?: string; edits?: DeltaOp[] }[]>();

self.onmessage = (e: MessageEvent) => {
  try {
    const msg = e.data;

    switch (msg.type) {
      case 'parse': {
        const language: string = msg.language;
        const parser = parsers.get(language);
        if (parser) {
          // Steady state — parser resident, process inline (no await).
          processParse(msg, parser);
          break;
        }
        // Parser not loaded — buffer this language's messages in arrival order.
        const queue = pending.get(language);
        if (queue) {
          queue.push(msg); // load already kicked off by the first buffered message
          break;
        }
        pending.set(language, [msg]);
        getParser(language).then((p) => {
          const drain = pending.get(language);
          pending.delete(language);
          if (!drain) return;
          for (const m of drain) {
            try {
              processParse(m, p);
            } catch (err) {
              console.error('[worker] crash (drain)', err);
            }
          }
        });
        break;
      }
      case 'remove':
        state.delete(msg.id);
        break;
      case 'clearAll':
        state.clear();
        pending.clear(); // stale buffered messages from a torn-down room never drain
        break;
    }
  } catch (err) {
    console.error('[worker] crash', err);
  }
};
