/**
 * Lezer Worker — Incremental parsing + TextRun extraction via gap-fill
 *
 * One of 2 warm pool workers. Owns per-object parse state (Tree + TreeFragments).
 * Main thread never touches parse state.
 *
 * Protocol:
 *   Main → Worker: { type:'parse', id, text, language, version, changes? }
 *   Main → Worker: { type:'remove', id }
 *   Main → Worker: { type:'clearAll' }
 *   Worker → Main: { type:'runs', id, version, runs: TextRun[][] }
 */

import { parser as jsParser } from '@lezer/javascript';
import { parser as pythonParser } from '@lezer/python';
import { highlightTree } from '@lezer/highlight';
import { tagHighlighter, tags } from '@lezer/highlight';
import { TreeFragment } from '@lezer/common';
import type { Tree, Parser } from '@lezer/common';

import type { TextRun, SparseHighlight } from './code-shared';
import { TAG_STYLES, highlightsToRuns } from './code-shared';

// ============================================================================
// Tag Highlighter — expanded tag list for complete coloring
// ============================================================================

const styleHighlighter = tagHighlighter([
  { tag: tags.keyword, class: 'keyword' },
  { tag: tags.string, class: 'string' },
  { tag: tags.special(tags.string), class: 'string' },
  { tag: tags.escape, class: 'string' },
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
  // Expanded tags
  { tag: tags.separator, class: 'punctuation' },
  { tag: tags.bracket, class: 'punctuation' },
  { tag: tags.angleBracket, class: 'punctuation' },
  { tag: tags.squareBracket, class: 'punctuation' },
  { tag: tags.paren, class: 'punctuation' },
  { tag: tags.brace, class: 'punctuation' },
  { tag: tags.derefOperator, class: 'punctuation' },
  { tag: tags.meta, class: 'keyword' },
  { tag: tags.self, class: 'keyword' },
  { tag: tags.atom, class: 'number' },
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
// Run extraction — walks tree, maps Lezer tags to SparseHighlights, gap-fills
// ============================================================================

function extractRuns(tree: Tree, text: string): TextRun[][] {
  const lines = text.split('\n');
  const highlightsPerLine: SparseHighlight[][] = Array.from({ length: lines.length }, () => []);

  // Build line offset table for fast line lookup
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  }

  highlightTree(tree, styleHighlighter, (from, to, classes) => {
    const style = TAG_STYLES[classes];
    if (!style) return;

    let lineIdx = binarySearchLine(lineOffsets, from);

    while (lineIdx < lines.length) {
      const lineStart = lineOffsets[lineIdx];
      const lineEnd = lineStart + lines[lineIdx].length;

      if (from >= lineEnd) { lineIdx++; continue; }
      if (to <= lineStart) break;

      const tokenFrom = Math.max(0, from - lineStart);
      const tokenTo = Math.min(lines[lineIdx].length, to - lineStart);

      if (tokenFrom < tokenTo) {
        highlightsPerLine[lineIdx].push({
          from: tokenFrom,
          to: tokenTo,
          color: style.color,
          bold: !!style.bold,
        });
      }

      if (to <= lineEnd) break;
      lineIdx++;
    }
  });

  // Gap-fill each line
  return lines.map((line, i) => highlightsToRuns(line, highlightsPerLine[i]));
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
      const runs = extractRuns(tree, text);
      (self as unknown as Worker).postMessage({ type: 'runs', id, version, runs });
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
