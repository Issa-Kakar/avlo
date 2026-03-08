/**
 * Lezer Worker — Incremental parsing + token extraction
 *
 * One of 2 warm pool workers. Owns per-object parse state (Tree + TreeFragments).
 * Main thread never touches parse state.
 *
 * Protocol:
 *   Main → Worker: { type:'parse', id, text, language, changes? }
 *   Main → Worker: { type:'remove', id }
 *   Main → Worker: { type:'clearAll' }
 *   Worker → Main: { type:'tokens', id, tokens: CodeToken[][] }
 */

import { parser as jsParser } from '@lezer/javascript';
import { parser as pythonParser } from '@lezer/python';
import { highlightTree } from '@lezer/highlight';
import { tagHighlighter, tags } from '@lezer/highlight';
import { TreeFragment } from '@lezer/common';
import type { Tree, Parser } from '@lezer/common';

import type { CodeToken } from './code-system';
import { TAG_STYLES, CODE_DEFAULT } from './code-system';

// ============================================================================
// Tag Highlighter — maps Lezer tags to TAG_STYLES keys
// ============================================================================

const styleHighlighter = tagHighlighter([
  { tag: tags.keyword, class: 'keyword' },
  { tag: tags.string, class: 'string' },
  { tag: tags.number, class: 'number' },
  { tag: [tags.lineComment, tags.blockComment], class: 'comment' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: 'function' },
  { tag: tags.variableName, class: 'variable' },
  { tag: [tags.typeName, tags.className], class: 'type' },
  { tag: [tags.operator, tags.compareOperator, tags.logicOperator], class: 'operator' },
  { tag: tags.propertyName, class: 'variable' },
  { tag: tags.bool, class: 'number' },
  { tag: tags.null, class: 'number' },
  { tag: tags.regexp, class: 'string' },
  { tag: tags.definition(tags.variableName), class: 'variable' },
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
// Parser selection
// ============================================================================

function getParser(language: string): Parser {
  if (language === 'python') return pythonParser;
  if (language === 'typescript') return jsParser.configure({ dialect: 'ts jsx' });
  return jsParser.configure({ dialect: 'jsx' });
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
    // Incremental: apply changes to fragments, then parse
    const updatedFragments = TreeFragment.applyChanges(prev.fragments, changes);
    tree = parser.parse(text, updatedFragments);
    fragments = TreeFragment.addTree(tree, updatedFragments);
  } else {
    // Full parse
    tree = parser.parse(text);
    fragments = TreeFragment.addTree(tree);
  }

  state.set(id, { tree, fragments });
  return tree;
}

// ============================================================================
// Token extraction — walks tree, maps Lezer tags to colors, splits multi-line
// ============================================================================

function extractTokens(tree: Tree, text: string): CodeToken[][] {
  const lines = text.split('\n');
  const result: CodeToken[][] = Array.from({ length: lines.length }, () => []);

  // Build line offset table for fast line lookup
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1); // +1 for \n
  }

  highlightTree(tree, styleHighlighter, (from, to, classes) => {
    const style = TAG_STYLES[classes] ?? { color: CODE_DEFAULT };

    // Find which lines this span covers
    let lineIdx = binarySearchLine(lineOffsets, from);

    while (lineIdx < lines.length) {
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
        result[lineIdx].push({
          from: tokenFrom,
          to: tokenTo,
          color: style.color,
          bold: style.bold,
        });
      }

      if (to <= lineEnd) break;
      lineIdx++;
    }
  });

  return result;
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
      const { id, text, language, changes } = msg;
      const tree = parse(id, text, language, changes);
      const tokens = extractTokens(tree, text);
      (self as unknown as Worker).postMessage({ type: 'tokens', id, tokens });
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
