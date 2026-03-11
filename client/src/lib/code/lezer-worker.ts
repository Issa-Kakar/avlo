/**
 * Lezer Worker — Incremental parsing + RunSpans extraction
 *
 * One of 2 warm pool workers. Owns per-object parse state (Tree + TreeFragments).
 * Main thread never touches parse state.
 *
 * Protocol:
 *   Main → Worker: { type:'parse', id, text, language, version, changes? }
 *   Main → Worker: { type:'remove', id }
 *   Main → Worker: { type:'clearAll' }
 *   Worker → Main: { type:'spans', id, version, spans: RunSpans[] }  (transferred)
 */

import { parser as jsParser } from '@lezer/javascript';
import { parser as pythonParser } from '@lezer/python';
import { highlightTree } from '@lezer/highlight';
import { tagHighlighter, tags } from '@lezer/highlight';
import { TreeFragment } from '@lezer/common';
import type { Tree, Parser } from '@lezer/common';

import type { RunSpans } from './code-tokens';
import { TAG_STYLE_INDEX, packRunSpans, EMPTY_SPANS } from './code-tokens';

// ============================================================================
// Tag Highlighter — expanded tag list for complete coloring
// ============================================================================

const styleHighlighter = tagHighlighter([
  { tag: tags.keyword, class: 'keyword' },
  { tag: tags.self, class: 'variable' },
  { tag: tags.definitionKeyword, class: 'def-keyword' },
  { tag: [tags.moduleKeyword, tags.modifier], class: 'modifier' },
  { tag: tags.meta, class: 'modifier' },
  { tag: tags.string, class: 'string' },
  { tag: [tags.special(tags.string), tags.special(tags.brace)], class: 'string' },
  { tag: [tags.escape, tags.regexp, tags.character], class: 'string' },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom],
    class: 'number',
  },
  { tag: [tags.lineComment, tags.blockComment, tags.docComment], class: 'comment' },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.function(tags.definition(tags.variableName)),
    ],
    class: 'function',
  },
  {
    tag: [tags.className, tags.definition(tags.propertyName), tags.definition(tags.typeName)],
    class: 'function',
  },
  {
    tag: [tags.variableName, tags.definition(tags.variableName), tags.labelName],
    class: 'variable',
  },
  {
    tag: [tags.typeName, tags.propertyName, tags.tagName, tags.angleBracket, tags.namespace],
    class: 'type',
  },
  {
    tag: [
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
    class: 'operator',
  },
  { tag: tags.derefOperator, class: 'deref' },
  { tag: tags.attributeName, class: 'attribute' },
  {
    tag: [tags.separator, tags.bracket, tags.squareBracket, tags.paren, tags.brace],
    class: 'punctuation',
  },
  { tag: tags.invalid, class: 'invalid' },
]);

// ============================================================================
// Per-object state
// ============================================================================

interface ParseState {
  tree: Tree;
  fragments: readonly TreeFragment[];
}

const state = new Map<string, ParseState>();

// ============================================================================
// Cached configured parsers — created once at worker startup
// ============================================================================

const tsParser = jsParser.configure({ dialect: 'ts jsx' });
const jsxParser = jsParser.configure({ dialect: 'jsx' });

function getParser(language: string): Parser {
  if (language === 'python') return pythonParser;
  if (language === 'typescript') return tsParser;
  return jsxParser;
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

function parse(id: string, text: string, language: string, changes?: ChangedRange[]): Tree {
  const parser = getParser(language);
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

  state.set(id, { tree, fragments });
  return tree;
}

// ============================================================================
// Span extraction — walks tree, maps Lezer tags to RunSpans via packRunSpans
// ============================================================================

// Reusable buffers — persisted across calls, zero allocation per parse
let _lineBuf: number[] = [];
let _hlBuf: number[] = [];
let _hlCount = 0;

function extractSpans(tree: Tree, text: string): RunSpans[] {
  const lines = text.split('\n');
  const lineCount = lines.length;
  const spans: RunSpans[] = new Array(lineCount);

  // Build line offset table for fast line lookup
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lineCount - 1; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  }

  // First pass: collect highlights into flat quad buffer [lineIdx, from, to, style]
  // Zero object allocation — reuses _hlBuf across calls
  _hlCount = 0;

  highlightTree(tree, styleHighlighter, (from, to, classes) => {
    const style = TAG_STYLE_INDEX[classes];
    if (style === undefined) return;

    let lineIdx = binarySearchLine(lineOffsets, from);

    while (lineIdx < lineCount) {
      const lineStart = lineOffsets[lineIdx];
      const lineEnd = lineStart + lines[lineIdx].length;

      if (from >= lineEnd) {
        lineIdx++;
        continue;
      }
      if (to <= lineStart) break;

      const tokenFrom = Math.max(0, from - lineStart);
      const tokenTo = Math.min(lines[lineIdx].length, to - lineStart);

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

  // Second pass: sequential cursor scan — O(highlights) total
  // highlightTree emits in document order, so quads are sorted by lineIdx
  let cursor = 0;

  for (let i = 0; i < lineCount; i++) {
    if (cursor >= _hlCount || _hlBuf[cursor * 4] !== i) {
      spans[i] = lines[i].length === 0 ? EMPTY_SPANS : packRunSpans(lines[i].length, [], 0);
      continue;
    }

    let count = 0;
    let j = cursor;
    while (j < _hlCount && _hlBuf[j * 4] === i) {
      const base = j * 4;
      const tripleBase = count * 3;
      if (tripleBase + 2 >= _lineBuf.length) _lineBuf.length = tripleBase + 30;
      _lineBuf[tripleBase] = _hlBuf[base + 1];
      _lineBuf[tripleBase + 1] = _hlBuf[base + 2];
      _lineBuf[tripleBase + 2] = _hlBuf[base + 3];
      count++;
      j++;
    }
    cursor = j;
    spans[i] = packRunSpans(lines[i].length, _lineBuf, count);
  }

  return spans;
}

function binarySearchLine(offsets: number[], pos: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ============================================================================
// Message handler
// ============================================================================

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case 'parse': {
      const { id, text, language, version, changes } = msg;
      const tree = parse(id, text, language, changes);
      const spans = extractSpans(tree, text);
      // Transfer ArrayBuffers — zero-copy. Worker arrays become detached.
      const transfer = [];
      for (let i = 0; i < spans.length; i++) {
        if (spans[i].byteLength > 0) transfer.push(spans[i].buffer);
      }
      (self as unknown as Worker).postMessage({ type: 'spans', id, version, spans }, transfer);
      break;
    }
    case 'remove':
      state.delete(msg.id);
      break;
    case 'clearAll':
      state.clear();
      break;
  }
};
