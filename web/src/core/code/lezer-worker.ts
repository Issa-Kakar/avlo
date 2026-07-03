/**
 * Lezer Worker — Incremental parsing + fused span extraction into per-block SABs
 *
 * One of 2 warm pool workers. Owns per-object parse state (Tree + TreeFragments +
 * text mirror) AND each object's spans SharedArrayBuffer. Main thread never
 * touches parse state; it only copies out of the SAB on doorbell receipt.
 *
 * Protocol:
 *   Main → Worker: { type:'parse', id, language, version, text }    // full seed/reset — mirror = text
 *   Main → Worker: { type:'parse', id, language, version, edits }   // Yjs delta BATCHES (DeltaOp[][]) —
 *                  applied sequentially: each batch's retains are relative to the
 *                  post-previous-batch doc. One parse + one publish per message.
 *   Main → Worker: { type:'remove', id }
 *   Main → Worker: { type:'clearAll' }
 *   Worker → Main: { type:'spans', id, sab }          // doorbell — payload lives in the SAB
 *   Worker → Main: { type:'parse-failed', id }        // gate-release on crash/desync
 *
 * SAB publish protocol (single buffer per block — safe because main posts at
 * most one parse per block and only after consuming the previous doorbell, so
 * worker-write and main-copy strictly alternate; independently, the version
 * gate is a seqlock — a stale publish is never read):
 *   write spanLineStart + spanData + H_LINE_COUNT (plain)
 *   → Atomics.store(H_VERSION, version)   // release — covers the plain writes
 *   → postMessage doorbell (SAB rides as a handle; nothing is copied or transferred)
 * The SAB is (re)allocated by THIS worker, exact-sized from actual content with
 * pow2 headroom and a 4 KB floor, and freed by GC once both sides drop refs.
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
 * (returns the stringified S int directly; the highlight callback decodes the
 * TRAILING int — inherited scopes join classes as "inherited own", so the last
 * one is the most specific). `code-theme.ts` carries its own copy of the same
 * mapping for the CodeMirror DOM theme — deliberate duplication so the main
 * bundle never has to import `@lezer/highlight`.
 */

import type { Parser, Tree } from '@lezer/common';
import { TreeFragment } from '@lezer/common';
import type { Highlighter, Tag } from '@lezer/highlight';
import { highlightTree, tags } from '@lezer/highlight';

import { isAllWs, S, SAB_H_LINE_CAP, SAB_H_LINE_COUNT, SAB_H_VERSION, SAB_HDR_BYTES } from './code-tokens';

// Resolves to a boolean in Vite builds; false under the node parity harness
// (where import.meta.env is undefined).
const DEV = typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true;

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
  const promise = entry.load().then(
    (mod) => {
      const configured = entry.configure ? entry.configure(mod.parser) : mod.parser;
      parsers.set(language, configured);
      loading.delete(language);
      return configured;
    },
    (err) => {
      loading.delete(language); // don't cache the rejection — a later parse retries the load
      throw err;
    },
  );
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

interface ParseMsg {
  id: string;
  version: number;
  text?: string;
  edits?: DeltaOp[][];
}

/**
 * Resolve text + incremental changes for a parse message, run ONE parse over
 * the final text, and publish spans. `msg.text` present → full seed/reset;
 * else `msg.edits` (Yjs delta batches) splices the mirror batch by batch —
 * `TreeFragment.applyChanges` chains across batches without an intervening
 * parse (pure coordinate surgery on fragment offsets).
 */
function processParse(msg: ParseMsg, parser: Parser): void {
  const { id, version } = msg;
  let text: string;
  let fragments: readonly TreeFragment[] | undefined;

  if (msg.text !== undefined) {
    text = msg.text;
  } else {
    const prev = state.get(id);
    if (!prev) {
      // Edits before seed — shouldn't happen (main gates via `seeded`), but the
      // gate must still release; main's next edit re-seeds from scratch.
      postParseFailed(id);
      return;
    }
    text = prev.mirror;
    fragments = prev.fragments;
    for (const batch of msg.edits as DeltaOp[][]) {
      const applied = applyEdits(text, batch);
      text = applied.text;
      if (applied.changes.length > 0) fragments = TreeFragment.applyChanges(fragments, applied.changes);
    }
  }

  const tree = fragments ? parser.parse(text, fragments) : parser.parse(text);
  state.set(id, { tree, fragments: TreeFragment.addTree(tree, fragments), mirror: text });

  publishSpans(id, version, extractSpans(tree, text));
}

// ============================================================================
// Span extraction — ONE fused highlightTree walk packs gap-filled triples
// directly (no quad buffer, no binary search, no second pass). Relies on
// highlightTree's contract of ascending, non-overlapping ranges — the same
// order the old two-pass packer's cursor scan already depended on.
// ============================================================================

// Reusable scratches — persisted across parses, grow-only, zero allocation
// steady-state. The walk targets these (not the SAB) so overflow handling is a
// plain grow-with-copy and the publish copy happens once with sizes known.
let _workerLineOffsets = new Uint32Array(64); // [lineCount + 1] incl. sentinel
let _workerSpanLineStart = new Uint32Array(64); // [lineCount + 1] u16-slot offsets
let _workerSpanData = new Uint16Array(256); // packed [off, len, style] triples

function ensureLineCaps(n: number): void {
  // Need slots [0..n] inclusive (n+1 slots) so the sentinel/total entry fits.
  if (_workerLineOffsets.length >= n + 1) return;
  let cap = _workerLineOffsets.length;
  while (cap < n + 1) cap *= 2;
  const next = new Uint32Array(cap);
  next.set(_workerLineOffsets); // may grow mid-offsets-pass — preserve prefix
  _workerLineOffsets = next;
  _workerSpanLineStart = new Uint32Array(cap); // stamped after sizing — no preserve
}

function ensureWorkerSpanCap(n: number): void {
  if (_workerSpanData.length >= n) return;
  let cap = _workerSpanData.length;
  while (cap < n) cap *= 2;
  const next = new Uint16Array(cap);
  next.set(_workerSpanData); // grows mid-walk — preserve the packed prefix
  _workerSpanData = next;
}

// Fused-walk cursor state — module-level so the highlightTree callback is a
// hoisted function (no per-parse closure). Consumed within one extractSpans call.
let _text = '';
let _lineCount = 0;
let _line = 0;
let _lineStart = 0;
let _lineLen = 0;
let _posInLine = 0;
let _write = 0;
let _lastFrom = -1; // DEV ascending-order tripwire

function _emit(off: number, len: number, style: number): void {
  if (_write + 3 > _workerSpanData.length) ensureWorkerSpanCap(_write + 3);
  const sp = _workerSpanData;
  sp[_write] = off;
  sp[_write + 1] = len;
  sp[_write + 2] = style;
  _write += 3;
}

/** Trailing gap for the current line — no-op on empty or fully-covered lines. */
function _emitTrailingGap(): void {
  if (_posInLine < _lineLen) {
    _emit(_posInLine, _lineLen - _posInLine, isAllWs(_text, _lineStart + _posInLine, _lineStart + _lineLen) ? S.WHITESPACE : S.DEFAULT);
  }
}

/** Finish the current line (trailing gap) and advance the cursor one line. */
function _finishLine(): void {
  _emitTrailingGap();
  _line++;
  _lineStart = _workerLineOffsets[_line];
  _lineLen = _workerLineOffsets[_line + 1] - _lineStart - 1;
  _posInLine = 0;
  _workerSpanLineStart[_line] = _write;
}

const _onHighlight = (from: number, to: number, classes: string): void => {
  if (!classes) return;
  // Trailing-int decode: STYLE_HIGHLIGHTER returns a bare stringified S value,
  // but highlightTree space-joins an inherited class BEFORE the own one — the
  // last int is the most specific style.
  let style = 0;
  for (let i = classes.lastIndexOf(' ') + 1; i < classes.length; i++) style = style * 10 + (classes.charCodeAt(i) - 48);

  if (DEV) {
    if (from < _lastFrom) console.error('[worker] highlightTree emitted non-ascending range', _lastFrom, from);
    _lastFrom = from;
  }

  // Pointer 1: advance the line cursor to the highlight's starting line,
  // finishing each line passed (trailing gap + spanLineStart stamp).
  while (from >= _lineStart + _lineLen && _line + 1 < _lineCount) _finishLine();

  // Pointer 2: emit line-relative, clamped segments across the lines spanned.
  for (;;) {
    const tokenFrom = from > _lineStart ? from - _lineStart : 0;
    const rel = to - _lineStart;
    const tokenTo = rel < _lineLen ? rel : _lineLen;
    if (tokenFrom < tokenTo) {
      if (tokenFrom > _posInLine) {
        _emit(
          _posInLine,
          tokenFrom - _posInLine,
          isAllWs(_text, _lineStart + _posInLine, _lineStart + tokenFrom) ? S.WHITESPACE : S.DEFAULT,
        );
      }
      _emit(tokenFrom, tokenTo - tokenFrom, style);
      _posInLine = tokenTo;
    }
    if (to <= _lineStart + _lineLen || _line + 1 >= _lineCount) break;
    _finishLine();
  }
};

/** Pooled extraction result — `ls`/`sp` reference the live scratches (valid until
 *  the next extractSpans call); triples for line i live at `sp[ls[i] .. ls[i+1])`. */
export interface ExtractResult {
  lineCount: number;
  used: number;
  ls: Uint32Array;
  sp: Uint16Array;
}
const _extractResult: ExtractResult = { lineCount: 0, used: 0, ls: _workerSpanLineStart, sp: _workerSpanData };

/**
 * Fused extraction into the module scratches. Exported for the DEV parity
 * harness — pure w.r.t. everything but the scratches + pooled result.
 */
export function extractSpans(tree: Tree, text: string): ExtractResult {
  // 1. Line-offset table — single pass over the vectorized native indexOf.
  _workerLineOffsets[0] = 0;
  let li = 1;
  for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', nl + 1)) {
    ensureLineCaps(li + 1);
    _workerLineOffsets[li++] = nl + 1;
  }
  const lineCount = li;
  ensureLineCaps(lineCount);
  // Sentinel: text.length + 1 so lineLen(i) = lineOffsets[i+1] - lineOffsets[i] - 1
  _workerLineOffsets[lineCount] = text.length + 1;

  // 2. Reset cursors, stamp line 0, run the fused walk.
  _text = text;
  _lineCount = lineCount;
  _line = 0;
  _lineStart = 0;
  _lineLen = _workerLineOffsets[1] - 1;
  _posInLine = 0;
  _write = 0;
  _lastFrom = -1;
  _workerSpanLineStart[0] = 0;

  highlightTree(tree, STYLE_HIGHLIGHTER, _onHighlight);

  // 3. Drain the remaining lines, finish the last line's trailing gap, stamp
  //    the total-slots sentinel.
  while (_line + 1 < _lineCount) _finishLine();
  _emitTrailingGap();
  _workerSpanLineStart[lineCount] = _write;
  _text = '';
  _extractResult.lineCount = lineCount;
  _extractResult.used = _write;
  _extractResult.ls = _workerSpanLineStart;
  _extractResult.sp = _workerSpanData;
  return _extractResult;
}

// ============================================================================
// Per-object SAB slots — worker-owned, exact-sized, realloc-on-overflow.
// Same lifecycle as `state` (dropped on remove/clearAll → GC frees the SAB
// once main's entry is gone too).
// ============================================================================

interface SabSlot {
  sab: SharedArrayBuffer;
  hdr: Int32Array;
  ls: Uint32Array; // spanLineStart region — lineCap+1 u32 entries
  sp: Uint16Array; // spanData region — dataCap u16 slots
  lineCap: number;
  dataCap: number;
}

const sabSlots = new Map<string, SabSlot>();

// Floor so an empty seed doesn't guarantee a realloc on first typing (and SABs
// are page-granular anyway).
const MIN_SAB_BYTES = 4096;

function ensureSlot(id: string, lineCount: number, used: number): SabSlot {
  let slot = sabSlots.get(id);
  if (slot && lineCount <= slot.lineCap && used <= slot.dataCap) return slot;
  let lineCap = slot ? slot.lineCap : 16;
  while (lineCap < lineCount) lineCap *= 2;
  let dataCap = slot ? slot.dataCap : 512;
  while (dataCap < used) dataCap *= 2;
  const lsBytes = (lineCap + 1) * 4;
  const minData = (MIN_SAB_BYTES - SAB_HDR_BYTES - lsBytes) >> 1;
  if (dataCap < minData) dataCap = minData;
  const sab = new SharedArrayBuffer(SAB_HDR_BYTES + lsBytes + dataCap * 2);
  const hdr = new Int32Array(sab, 0, 8);
  hdr[SAB_H_LINE_CAP] = lineCap; // plain — covered by the first publish's release
  slot = {
    sab,
    hdr,
    ls: new Uint32Array(sab, SAB_HDR_BYTES, lineCap + 1),
    sp: new Uint16Array(sab, SAB_HDR_BYTES + lsBytes, dataCap),
    lineCap,
    dataCap,
  };
  sabSlots.set(id, slot);
  return slot;
}

// Pooled doorbell — postMessage structured-clones synchronously; the SAB rides
// as a handle (shared by reference), never copied or transferred.
const _spansMsg: { type: 'spans'; id: string; sab: SharedArrayBuffer | null } = { type: 'spans', id: '', sab: null };

function publishSpans(id: string, version: number, r: ExtractResult): void {
  const { lineCount, used } = r;
  const slot = ensureSlot(id, lineCount, used);
  slot.ls.set(r.ls.subarray(0, lineCount + 1));
  slot.sp.set(r.sp.subarray(0, used));
  slot.hdr[SAB_H_LINE_COUNT] = lineCount; // plain — covered by the release below
  Atomics.store(slot.hdr, SAB_H_VERSION, version); // publish (release edge)
  _spansMsg.id = id;
  _spansMsg.sab = slot.sab;
  (self as unknown as Worker).postMessage(_spansMsg);
}

/** Gate-release doorbell — a parse that produced no publish must still answer. */
function postParseFailed(id: string): void {
  (self as unknown as Worker).postMessage({ type: 'parse-failed', id });
}

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
const pending = new Map<string, ParseMsg[]>();

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case 'parse': {
      const language: string = msg.language;
      const parser = parsers.get(language);
      if (parser) {
        // Steady state — parser resident, process inline (no await).
        try {
          processParse(msg, parser);
        } catch (err) {
          console.error('[worker] crash', err);
          postParseFailed(msg.id);
        }
        break;
      }
      // Parser not loaded — buffer this language's messages in arrival order.
      const queue = pending.get(language);
      if (queue) {
        queue.push(msg); // load already kicked off by the first buffered message
        break;
      }
      pending.set(language, [msg]);
      getParser(language)
        .then((p) => {
          const drain = pending.get(language);
          pending.delete(language);
          if (!drain) return;
          for (const m of drain) {
            try {
              processParse(m, p);
            } catch (err) {
              console.error('[worker] crash (drain)', err);
              postParseFailed(m.id);
            }
          }
        })
        .catch((err) => {
          // Grammar chunk failed to load (e.g. first-ever offline fetch) —
          // release the gates so blocks stay live on the sync floor.
          console.error('[worker] parser load failed', language, err);
          const drain = pending.get(language);
          pending.delete(language);
          if (drain) for (const m of drain) postParseFailed(m.id);
        });
      break;
    }
    case 'remove': {
      state.delete(msg.id);
      sabSlots.delete(msg.id);
      // Scrub buffered parses for the removed id — a later drain would
      // otherwise resurrect state + a SAB for a dead object.
      for (const q of pending.values()) {
        for (let i = q.length - 1; i >= 0; i--) if (q[i].id === msg.id) q.splice(i, 1);
      }
      break;
    }
    case 'clearAll':
      state.clear();
      sabSlots.clear();
      pending.clear(); // stale buffered messages from a torn-down room never drain
      break;
  }
};
