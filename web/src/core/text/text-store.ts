/**
 * TEXT STORE — the SoA data plane for every text-bearing cache entry
 * (text objects, sticky notes, shape labels, connector labels).
 *
 * One entry = one dense u32 slot ("ts") into interleaved global columns, plus
 * five shared pools holding the variable-length tiers of EVERY entry side by
 * side — the typed arrays are interleaved ACROSS entries, not stored one heap
 * object per id. Entries reference their pool data by (base, count, cap)
 * ranges; all in-range indices (paragraph→token, token→segment, line→run) are
 * ENTRY-RELATIVE so a range can relocate with a base update and nothing else.
 *
 * Layout (literal strides, FlatRTree-style):
 *
 *   R: Uint32Array, stride 16 (`ts << 4`) — ranges + packed status word
 *     +0 paraBase  +1 paraCount  +2 paraCap     (paraTok holds paraCount+1)
 *     +3 tokBase   +4 tokCount   +5 tokCap      (tokSeg  holds tokCount+1)
 *     +6 segBase   +7 segCount   +8 segCap
 *     +9 lineBase +10 lineCount +11 lineCap     (lineRunStart holds lineCount+1)
 *    +12 runBase  +13 runCount  +14 runCap
 *    +15 status: bit0 CONTENT_VALID | bit1 ALL_BOLD | bit2 ALL_ITALIC
 *               | famCode << 8 (0xFF = unset)
 *
 *   S: Float64Array, stride 8 (`ts << 3`) — scalars, NaN = stale
 *     +0 measuredFontSize   (NaN ⇒ advance-width lanes stale; the staleness
 *                            probe is the ordinary `S[b] === fontSize` compare —
 *                            NaN never equals, so stale falls through free)
 *     +1 layoutWidthReq     (the flow maxWidth as REQUESTED: Infinity = auto —
 *                            one value encodes both the mode and the number;
 *                            NaN = no layout committed yet)
 *     +2 layFontSize  +3 layLineHeight  +4 layBoxWidth
 *     +5 noteDerivedFontSize (NaN = stale)
 *     +6 measuredLineHeight  +7 spare
 *
 *   frameCol: Float64Array, stride 4 (`ts << 2`) — derived frame x,y,w,h;
 *     NaN in lane 0 = invalid.
 *
 * Pools (two repack groups):
 *   content — paraTok u32 · tokSeg u32 + tokAdvW f64 · segText string[] +
 *             segStyle u8 (bit0 bold | bit1 italic | bits2-3 spaceMode) +
 *             segFontIdx u16 + segHl u16 + segAdvW f64
 *   layout  — lineRunStart u32 + lineAdvW f64 + lineAlignW f64 ·
 *             runText string[] + runFontIdx u16 + runHl u16 + runAdvW f64 +
 *             runAdvX f64
 *
 * tokSeg word packing: `segStartRel | kind << 31` (kind: 0 word, 1 space) —
 * the kind rides the word every consumer already loads. The trailing sentinel
 * entry (index tokCount) carries no kind bit, so its masked value is segCount.
 *
 * Allocation: tail bump with 25%+8 slack rounded to 8 (`(n+(n>>2)+8)&~7`);
 * a relayout that fits its caps reuses ranges in place, growth reallocates at
 * the tail and the old caps become garbage. When a pool's garbage passes half
 * its length the GROUP is repacked: fresh arrays (deliberately not resized in
 * place — mirrors FlatRTree's measured fresh-alloc preference), live ranges
 * copied in slot order, bases rewritten. Repack runs only at entry boundaries
 * (inside alloc*, before any bases are handed out, and at release) — callers
 * hoist pool arrays AFTER the alloc call, never across it.
 *
 * Measured views: `measuredViewOf(ts)` hands out ONE per-slot descriptor
 * object exposing the pool lanes + bases (the transform engine freezes it at
 * gesture begin and holds it across frames). Every operation that moves or
 * replaces content-tier storage refreshes live descriptors, so a held view is
 * always coherent — the exact semantics the old per-entry reused buffers had.
 * `releaseTextSlot` detaches the slot's view onto EMPTY arrays with zero
 * counts, so a ref held past deletion reads as empty content, never garbage.
 *
 * The app-slot accelerator (`textSlotFast`) memoizes appSlot→ts so draw paths
 * resolve entries with one Int32 load instead of a string-keyed Map.get. It is
 * filled lazily on first draw and cleared through the ts→appSlot backlink at
 * release; an app slot recycled to a new object always misses first (its old
 * entry's release cleared the cell) and re-resolves through the id map.
 *
 * This module is pure storage: no Yjs, no canvas, no measurement imports.
 */

import type { FrameTuple } from '../types/geometry';

// --- status word bits (R[+15]) ---
export const TS_CONTENT_VALID = 1;
export const TS_ALL_BOLD = 2;
export const TS_ALL_ITALIC = 4;
export const TS_FAM_SHIFT = 8;

/** Measured-content view — pool lanes + entry bases. All in-range index values
 *  are entry-relative; consumers add the bases. Held refs stay coherent across
 *  pool relocation (the store refreshes live views on every content-tier move). */
export interface MeasuredContent {
  famCode: number;
  lineHeight: number;
  paraTok: Uint32Array;
  paraBase: number;
  paraCount: number;
  tokSeg: Uint32Array;
  tokAdvW: Float64Array;
  tokBase: number;
  tokCount: number;
  segText: string[];
  segStyle: Uint8Array;
  segFontIdx: Uint16Array;
  segHl: Uint16Array;
  segAdvW: Float64Array;
  segBase: number;
  segCount: number;
}

const EMPTY_U32 = new Uint32Array(0);
const EMPTY_U16 = new Uint16Array(0);
const EMPTY_U8 = new Uint8Array(0);
const EMPTY_F64 = new Float64Array(0);
const EMPTY_STR: string[] = [];

// =============================================================================
// SLOT FABRIC
// =============================================================================

const SLOT_CAP0 = 64;

let _slotCap = SLOT_CAP0;
let _slotHW = 0; // high water — slots ever handed out live in [0, _slotHW)
let _free = new Int32Array(SLOT_CAP0);
let _freeLen = 0;

const _tsById = new Map<string, number>();

let _R = new Uint32Array(SLOT_CAP0 << 4);
let _S = new Float64Array(SLOT_CAP0 << 3);
let _frame = new Float64Array(SLOT_CAP0 << 2);
let _uniHl = new Uint16Array(SLOT_CAP0);
let _idBySlot: (string | null)[] = new Array(SLOT_CAP0).fill(null);
let _frameTuple: (FrameTuple | null)[] = new Array(SLOT_CAP0).fill(null);
let _view: (MeasuredContent | null)[] = new Array(SLOT_CAP0).fill(null);
let _appSlotOfTs = new Int32Array(SLOT_CAP0).fill(-1);

// App-slot accelerator — grown on demand by appSlot, -1 filled.
let _tsByAppSlot = new Int32Array(256).fill(-1);

function growSlots(needed: number): void {
  let cap = _slotCap;
  cap = cap + (cap >> 1) + 16;
  if (cap < needed) cap = needed;
  const nR = new Uint32Array(cap << 4);
  nR.set(_R);
  _R = nR;
  const nS = new Float64Array(cap << 3);
  nS.set(_S);
  _S = nS;
  const nF = new Float64Array(cap << 2);
  nF.set(_frame);
  _frame = nF;
  const nH = new Uint16Array(cap);
  nH.set(_uniHl);
  _uniHl = nH;
  const nFree = new Int32Array(cap);
  nFree.set(_free);
  _free = nFree;
  const nA = new Int32Array(cap).fill(-1);
  nA.set(_appSlotOfTs);
  _appSlotOfTs = nA;
  _idBySlot.length = cap;
  _frameTuple.length = cap;
  _view.length = cap;
  for (let i = _slotCap; i < cap; i++) {
    _idBySlot[i] = null;
    _frameTuple[i] = null;
    _view[i] = null;
  }
  _slotCap = cap;
}

export function textSlotOf(id: string): number {
  const ts = _tsById.get(id);
  return ts === undefined ? -1 : ts;
}

export function ensureTextSlot(id: string): number {
  const hit = _tsById.get(id);
  if (hit !== undefined) return hit;
  let ts: number;
  if (_freeLen > 0) {
    ts = _free[--_freeLen];
  } else {
    if (_slotHW === _slotCap) growSlots(_slotHW + 1);
    ts = _slotHW++;
  }
  // init columns
  const b16 = ts << 4;
  for (let i = 0; i < 15; i++) _R[b16 + i] = 0;
  _R[b16 + 15] = 0xff << TS_FAM_SHIFT;
  const b8 = ts << 3;
  _S[b8] = Number.NaN;
  _S[b8 + 1] = Number.NaN;
  _S[b8 + 2] = 0;
  _S[b8 + 3] = 0;
  _S[b8 + 4] = 0;
  _S[b8 + 5] = Number.NaN;
  _S[b8 + 6] = 0;
  _S[b8 + 7] = 0;
  _frame[ts << 2] = Number.NaN;
  _uniHl[ts] = 0;
  _idBySlot[ts] = id;
  _appSlotOfTs[ts] = -1;
  _tsById.set(id, ts);
  return ts;
}

/** appSlot→ts memoized resolve for draw paths — one Int32 load on the hit path.
 *  Coherence: release clears the cell through the backlink, so a hit is always
 *  live and correct; misses fall back to the id map and prime the cell. */
export function textSlotFast(appSlot: number, id: string): number {
  if (appSlot >= _tsByAppSlot.length) {
    const next = new Int32Array(appSlot + (appSlot >> 1) + 64).fill(-1);
    next.set(_tsByAppSlot);
    _tsByAppSlot = next;
  }
  let ts = _tsByAppSlot[appSlot];
  if (ts >= 0) return ts;
  const hit = _tsById.get(id);
  if (hit === undefined) return -1;
  ts = hit;
  _tsByAppSlot[appSlot] = ts;
  _appSlotOfTs[ts] = appSlot;
  return ts;
}

export function releaseTextSlot(id: string): void {
  const ts = _tsById.get(id);
  if (ts === undefined) return;
  const b16 = ts << 4;
  // free content + layout ranges (garbage accounting + string scrub)
  freeContentRanges(b16);
  freeLayoutRanges(b16);
  // accel teardown through the backlink
  const as = _appSlotOfTs[ts];
  if (as >= 0 && as < _tsByAppSlot.length && _tsByAppSlot[as] === ts) _tsByAppSlot[as] = -1;
  _appSlotOfTs[ts] = -1;
  // detach any held measured view onto empty storage — a transform ref held
  // past deletion reads zero paragraphs, never another entry's data
  const v = _view[ts];
  if (v !== null) {
    v.paraTok = EMPTY_U32;
    v.tokSeg = EMPTY_U32;
    v.tokAdvW = EMPTY_F64;
    v.segText = EMPTY_STR;
    v.segStyle = EMPTY_U8;
    v.segFontIdx = EMPTY_U16;
    v.segHl = EMPTY_U16;
    v.segAdvW = EMPTY_F64;
    v.paraBase = 0;
    v.tokBase = 0;
    v.segBase = 0;
    v.paraCount = 0;
    v.tokCount = 0;
    v.segCount = 0;
    _view[ts] = null;
  }
  _idBySlot[ts] = null;
  _tsById.delete(id);
  _free[_freeLen++] = ts;
  maybeRepackContent();
  maybeRepackLayout();
}

// =============================================================================
// POOLS
// =============================================================================

function slackOf(n: number): number {
  return (n + (n >> 2) + 8) & ~7;
}

// --- content group ---
let _paraTok: Uint32Array = new Uint32Array(256);
let _paraLen = 0;
let _gPara = 0;

let _tokSeg: Uint32Array = new Uint32Array(512);
let _tokAdvW: Float64Array = new Float64Array(512);
let _tokLen = 0;
let _gTok = 0;

let _segText: string[] = new Array(512).fill('');
let _segStyle: Uint8Array = new Uint8Array(512);
let _segFontIdx: Uint16Array = new Uint16Array(512);
let _segHl: Uint16Array = new Uint16Array(512);
let _segAdvW: Float64Array = new Float64Array(512);
let _segLen = 0;
let _gSeg = 0;

// --- layout group ---
let _lineRunStart: Uint32Array = new Uint32Array(512);
let _lineAdvW: Float64Array = new Float64Array(512);
let _lineAlignW: Float64Array = new Float64Array(512);
let _lineLen = 0;
let _gLine = 0;

let _runText: string[] = new Array(1024).fill('');
let _runFontIdx: Uint16Array = new Uint16Array(1024);
let _runHl: Uint16Array = new Uint16Array(1024);
let _runAdvW: Float64Array = new Float64Array(1024);
let _runAdvX: Float64Array = new Float64Array(1024);
let _runLen = 0;
let _gRun = 0;

function growU32(a: Uint32Array, need: number): Uint32Array {
  const next = new Uint32Array(need + (need >> 1) + 64);
  next.set(a);
  return next;
}
function growU16(a: Uint16Array, need: number): Uint16Array {
  const next = new Uint16Array(need + (need >> 1) + 64);
  next.set(a);
  return next;
}
function growU8(a: Uint8Array, need: number): Uint8Array {
  const next = new Uint8Array(need + (need >> 1) + 64);
  next.set(a);
  return next;
}
function growF64(a: Float64Array, need: number): Float64Array {
  const next = new Float64Array(need + (need >> 1) + 64);
  next.set(a);
  return next;
}
function growStr(a: string[], need: number): string[] {
  const cap = need + (need >> 1) + 64;
  for (let i = a.length; i < cap; i++) a[i] = '';
  return a;
}

function freeContentRanges(b16: number): void {
  const R = _R;
  _gPara += R[b16 + 2];
  _gTok += R[b16 + 5];
  const segBase = R[b16 + 6];
  const segCap = R[b16 + 8];
  for (let i = segBase, e = segBase + segCap; i < e; i++) _segText[i] = ''; // unpin strings
  _gSeg += segCap;
  R[b16 + 2] = 0;
  R[b16 + 5] = 0;
  R[b16 + 8] = 0;
  R[b16 + 1] = 0;
  R[b16 + 4] = 0;
  R[b16 + 7] = 0;
}

function freeLayoutRanges(b16: number): void {
  const R = _R;
  _gLine += R[b16 + 11];
  const runBase = R[b16 + 12];
  const runCap = R[b16 + 14];
  for (let i = runBase, e = runBase + runCap; i < e; i++) _runText[i] = '';
  _gRun += runCap;
  R[b16 + 11] = 0;
  R[b16 + 14] = 0;
  R[b16 + 10] = 0;
  R[b16 + 13] = 0;
}

/**
 * Reserve content-tier ranges for `ts` sized (pc paragraphs, tc tokens, sc
 * segments). Reuses the existing ranges in place when every cap fits, else
 * frees them and tail-allocates fresh ones (repack may run first — a safe
 * point, since the caller's data still lives in staging). Callers hoist pool
 * arrays AFTER this call, never across it.
 */
export function allocContentRanges(ts: number, pc: number, tc: number, sc: number): void {
  maybeRepackContent();
  const b16 = ts << 4;
  const R = _R;
  const needP = pc + 1;
  const needT = tc + 1;
  if (needP <= R[b16 + 2] && needT <= R[b16 + 5] && sc <= R[b16 + 8]) {
    // in-place: scrub shrunk string tail so big pasted strings don't linger
    const segBase = R[b16 + 6];
    for (let i = segBase + sc, e = segBase + R[b16 + 7]; i < e; i++) _segText[i] = '';
    R[b16 + 1] = pc;
    R[b16 + 4] = tc;
    R[b16 + 7] = sc;
    syncViewIfAny(ts);
    return;
  }
  freeContentRanges(b16);
  const capP = slackOf(needP);
  const capT = slackOf(needT);
  const capS = slackOf(sc);
  if (_paraLen + capP > _paraTok.length) _paraTok = growU32(_paraTok, _paraLen + capP);
  if (_tokLen + capT > _tokSeg.length) {
    _tokSeg = growU32(_tokSeg, _tokLen + capT);
    _tokAdvW = growF64(_tokAdvW, _tokLen + capT);
  }
  if (_segLen + capS > _segStyle.length) {
    _segText = growStr(_segText, _segLen + capS);
    _segStyle = growU8(_segStyle, _segLen + capS);
    _segFontIdx = growU16(_segFontIdx, _segLen + capS);
    _segHl = growU16(_segHl, _segLen + capS);
    _segAdvW = growF64(_segAdvW, _segLen + capS);
  }
  R[b16] = _paraLen;
  R[b16 + 1] = pc;
  R[b16 + 2] = capP;
  _paraLen += capP;
  R[b16 + 3] = _tokLen;
  R[b16 + 4] = tc;
  R[b16 + 5] = capT;
  _tokLen += capT;
  R[b16 + 6] = _segLen;
  R[b16 + 7] = sc;
  R[b16 + 8] = capS;
  _segLen += capS;
  refreshAllViews();
}

/** Layout-tier sibling of allocContentRanges (lc lines, rc runs). */
export function allocLayoutRanges(ts: number, lc: number, rc: number): void {
  maybeRepackLayout();
  const b16 = ts << 4;
  const R = _R;
  const needL = lc + 1;
  if (needL <= R[b16 + 11] && rc <= R[b16 + 14]) {
    const runBase = R[b16 + 12];
    for (let i = runBase + rc, e = runBase + R[b16 + 13]; i < e; i++) _runText[i] = '';
    R[b16 + 10] = lc;
    R[b16 + 13] = rc;
    return;
  }
  freeLayoutRanges(b16);
  const capL = slackOf(needL);
  const capR = slackOf(rc);
  if (_lineLen + capL > _lineRunStart.length) {
    _lineRunStart = growU32(_lineRunStart, _lineLen + capL);
    _lineAdvW = growF64(_lineAdvW, _lineLen + capL);
    _lineAlignW = growF64(_lineAlignW, _lineLen + capL);
  }
  if (_runLen + capR > _runFontIdx.length) {
    _runText = growStr(_runText, _runLen + capR);
    _runFontIdx = growU16(_runFontIdx, _runLen + capR);
    _runHl = growU16(_runHl, _runLen + capR);
    _runAdvW = growF64(_runAdvW, _runLen + capR);
    _runAdvX = growF64(_runAdvX, _runLen + capR);
  }
  R[b16 + 9] = _lineLen;
  R[b16 + 10] = lc;
  R[b16 + 11] = capL;
  _lineLen += capL;
  R[b16 + 12] = _runLen;
  R[b16 + 13] = rc;
  R[b16 + 14] = capR;
  _runLen += capR;
}

// =============================================================================
// REPACK — fresh-array rebuild when a group's garbage passes half its length
// =============================================================================

function maybeRepackContent(): void {
  if ((_gPara > 1024 && _gPara > _paraLen >> 1) || (_gTok > 1024 && _gTok > _tokLen >> 1) || (_gSeg > 1024 && _gSeg > _segLen >> 1)) {
    repackContent();
  }
}

function maybeRepackLayout(): void {
  if ((_gLine > 1024 && _gLine > _lineLen >> 1) || (_gRun > 2048 && _gRun > _runLen >> 1)) repackLayout();
}

function repackContent(): void {
  const liveP = _paraLen - _gPara;
  const liveT = _tokLen - _gTok;
  const liveS = _segLen - _gSeg;
  const nParaTok = new Uint32Array(slackOf(liveP + (liveP >> 2) + 64));
  const nTokSeg = new Uint32Array(slackOf(liveT + (liveT >> 2) + 64));
  const nTokAdvW = new Float64Array(nTokSeg.length);
  const segCapNew = slackOf(liveS + (liveS >> 2) + 64);
  const nSegText: string[] = new Array(segCapNew).fill('');
  const nSegStyle = new Uint8Array(segCapNew);
  const nSegFontIdx = new Uint16Array(segCapNew);
  const nSegHl = new Uint16Array(segCapNew);
  const nSegAdvW = new Float64Array(segCapNew);
  let cp = 0;
  let ct = 0;
  let cs = 0;
  const R = _R;
  for (let ts = 0; ts < _slotHW; ts++) {
    if (_idBySlot[ts] === null) continue;
    const b16 = ts << 4;
    const nP = R[b16 + 1] + 1;
    const nT = R[b16 + 4] + 1;
    const nS = R[b16 + 7];
    // New cap = min(slackOf(n), old cap) — never larger than the range being
    // replaced, so Σ new caps ≤ live and the exact-reserve arithmetic holds.
    let cap = slackOf(nP);
    if (cap > R[b16 + 2]) cap = R[b16 + 2];
    nParaTok.set(_paraTok.subarray(R[b16], R[b16] + nP), cp);
    R[b16] = cp;
    R[b16 + 2] = cap;
    cp += cap;
    cap = slackOf(nT);
    if (cap > R[b16 + 5]) cap = R[b16 + 5];
    nTokSeg.set(_tokSeg.subarray(R[b16 + 3], R[b16 + 3] + nT), ct);
    nTokAdvW.set(_tokAdvW.subarray(R[b16 + 3], R[b16 + 3] + nT), ct);
    R[b16 + 3] = ct;
    R[b16 + 5] = cap;
    ct += cap;
    cap = slackOf(nS);
    if (cap > R[b16 + 8]) cap = R[b16 + 8];
    const sb = R[b16 + 6];
    for (let i = 0; i < nS; i++) nSegText[cs + i] = _segText[sb + i];
    nSegStyle.set(_segStyle.subarray(sb, sb + nS), cs);
    nSegFontIdx.set(_segFontIdx.subarray(sb, sb + nS), cs);
    nSegHl.set(_segHl.subarray(sb, sb + nS), cs);
    nSegAdvW.set(_segAdvW.subarray(sb, sb + nS), cs);
    R[b16 + 6] = cs;
    R[b16 + 8] = cap;
    cs += cap;
  }
  _paraTok = nParaTok;
  _tokSeg = nTokSeg;
  _tokAdvW = nTokAdvW;
  _segText = nSegText;
  _segStyle = nSegStyle;
  _segFontIdx = nSegFontIdx;
  _segHl = nSegHl;
  _segAdvW = nSegAdvW;
  _paraLen = cp;
  _tokLen = ct;
  _segLen = cs;
  _gPara = 0;
  _gTok = 0;
  _gSeg = 0;
  refreshAllViews();
}

function repackLayout(): void {
  const liveL = _lineLen - _gLine;
  const liveR = _runLen - _gRun;
  const lineCapNew = slackOf(liveL + (liveL >> 2) + 64);
  const nLineRunStart = new Uint32Array(lineCapNew);
  const nLineAdvW = new Float64Array(lineCapNew);
  const nLineAlignW = new Float64Array(lineCapNew);
  const runCapNew = slackOf(liveR + (liveR >> 2) + 64);
  const nRunText: string[] = new Array(runCapNew).fill('');
  const nRunFontIdx = new Uint16Array(runCapNew);
  const nRunHl = new Uint16Array(runCapNew);
  const nRunAdvW = new Float64Array(runCapNew);
  const nRunAdvX = new Float64Array(runCapNew);
  let cl = 0;
  let cr = 0;
  const R = _R;
  for (let ts = 0; ts < _slotHW; ts++) {
    if (_idBySlot[ts] === null) continue;
    const b16 = ts << 4;
    const nL = R[b16 + 10] + 1;
    const nRn = R[b16 + 13];
    let cap = slackOf(nL);
    if (cap > R[b16 + 11]) cap = R[b16 + 11]; // min(slack, old cap) — see repackContent
    const lb = R[b16 + 9];
    nLineRunStart.set(_lineRunStart.subarray(lb, lb + nL), cl);
    nLineAdvW.set(_lineAdvW.subarray(lb, lb + nL), cl);
    nLineAlignW.set(_lineAlignW.subarray(lb, lb + nL), cl);
    R[b16 + 9] = cl;
    R[b16 + 11] = cap;
    cl += cap;
    cap = slackOf(nRn);
    if (cap > R[b16 + 14]) cap = R[b16 + 14];
    const rb = R[b16 + 12];
    for (let i = 0; i < nRn; i++) nRunText[cr + i] = _runText[rb + i];
    nRunFontIdx.set(_runFontIdx.subarray(rb, rb + nRn), cr);
    nRunHl.set(_runHl.subarray(rb, rb + nRn), cr);
    nRunAdvW.set(_runAdvW.subarray(rb, rb + nRn), cr);
    nRunAdvX.set(_runAdvX.subarray(rb, rb + nRn), cr);
    R[b16 + 12] = cr;
    R[b16 + 14] = cap;
    cr += cap;
  }
  _lineRunStart = nLineRunStart;
  _lineAdvW = nLineAdvW;
  _lineAlignW = nLineAlignW;
  _runText = nRunText;
  _runFontIdx = nRunFontIdx;
  _runHl = nRunHl;
  _runAdvW = nRunAdvW;
  _runAdvX = nRunAdvX;
  _lineLen = cl;
  _runLen = cr;
  _gLine = 0;
  _gRun = 0;
}

// =============================================================================
// MEASURED VIEWS
// =============================================================================

function fillView(v: MeasuredContent, ts: number): void {
  const b16 = ts << 4;
  const R = _R;
  v.famCode = (R[b16 + 15] >>> TS_FAM_SHIFT) & 255;
  v.lineHeight = _S[(ts << 3) + 6];
  v.paraTok = _paraTok;
  v.paraBase = R[b16];
  v.paraCount = R[b16 + 1];
  v.tokSeg = _tokSeg;
  v.tokAdvW = _tokAdvW;
  v.tokBase = R[b16 + 3];
  v.tokCount = R[b16 + 4];
  v.segText = _segText;
  v.segStyle = _segStyle;
  v.segFontIdx = _segFontIdx;
  v.segHl = _segHl;
  v.segAdvW = _segAdvW;
  v.segBase = R[b16 + 6];
  v.segCount = R[b16 + 7];
}

export function measuredViewOf(ts: number): MeasuredContent {
  let v = _view[ts];
  if (v === null) {
    v = {
      famCode: 0,
      lineHeight: 0,
      paraTok: EMPTY_U32,
      paraBase: 0,
      paraCount: 0,
      tokSeg: EMPTY_U32,
      tokAdvW: EMPTY_F64,
      tokBase: 0,
      tokCount: 0,
      segText: EMPTY_STR,
      segStyle: EMPTY_U8,
      segFontIdx: EMPTY_U16,
      segHl: EMPTY_U16,
      segAdvW: EMPTY_F64,
      segBase: 0,
      segCount: 0,
    };
    _view[ts] = v;
  }
  fillView(v, ts);
  return v;
}

export function syncViewIfAny(ts: number): void {
  const v = _view[ts];
  if (v !== null) fillView(v, ts);
}

function refreshAllViews(): void {
  for (let ts = 0; ts < _slotHW; ts++) {
    const v = _view[ts];
    if (v !== null && _idBySlot[ts] !== null) fillView(v, ts);
  }
}

// =============================================================================
// FRAME TUPLES (compat views over frameCol)
// =============================================================================

export function frameTupleOf(ts: number): FrameTuple {
  let t = _frameTuple[ts];
  if (t === null) {
    t = [0, 0, 0, 0];
    _frameTuple[ts] = t;
  }
  return t;
}

// =============================================================================
// HIGHLIGHT INTERN
// =============================================================================

export const HL_STRINGS: string[] = [''];
const _hlToIdx = new Map<string, number>();

export function internHighlight(color: string): number {
  const hit = _hlToIdx.get(color);
  if (hit !== undefined) return hit;
  const idx = HL_STRINGS.length;
  HL_STRINGS[idx] = color;
  _hlToIdx.set(color, idx);
  return idx;
}

// =============================================================================
// COLUMN / POOL ACCESS (hoist per operation; re-fetch after any alloc call)
// =============================================================================

export function getR(): Uint32Array {
  return _R;
}
export function getS(): Float64Array {
  return _S;
}
export function getFrameCol(): Float64Array {
  return _frame;
}
export function getUniHlCol(): Uint16Array {
  return _uniHl;
}
export function getParaTok(): Uint32Array {
  return _paraTok;
}
export function getTokSeg(): Uint32Array {
  return _tokSeg;
}
export function getTokAdvW(): Float64Array {
  return _tokAdvW;
}
export function getSegText(): string[] {
  return _segText;
}
export function getSegStyle(): Uint8Array {
  return _segStyle;
}
export function getSegFontIdx(): Uint16Array {
  return _segFontIdx;
}
export function getSegHl(): Uint16Array {
  return _segHl;
}
export function getSegAdvW(): Float64Array {
  return _segAdvW;
}
export function getLineRunStart(): Uint32Array {
  return _lineRunStart;
}
export function getLineAdvW(): Float64Array {
  return _lineAdvW;
}
export function getLineAlignW(): Float64Array {
  return _lineAlignW;
}
export function getRunText(): string[] {
  return _runText;
}
export function getRunFontIdx(): Uint16Array {
  return _runFontIdx;
}
export function getRunHl(): Uint16Array {
  return _runHl;
}
export function getRunAdvW(): Float64Array {
  return _runAdvW;
}
export function getRunAdvX(): Float64Array {
  return _runAdvX;
}

// =============================================================================
// RESET
// =============================================================================

export function resetTextStore(): void {
  _slotCap = SLOT_CAP0;
  _slotHW = 0;
  _free = new Int32Array(SLOT_CAP0);
  _freeLen = 0;
  _tsById.clear();
  _R = new Uint32Array(SLOT_CAP0 << 4);
  _S = new Float64Array(SLOT_CAP0 << 3);
  _frame = new Float64Array(SLOT_CAP0 << 2);
  _uniHl = new Uint16Array(SLOT_CAP0);
  _idBySlot = new Array(SLOT_CAP0).fill(null);
  _frameTuple = new Array(SLOT_CAP0).fill(null);
  _view = new Array(SLOT_CAP0).fill(null);
  _appSlotOfTs = new Int32Array(SLOT_CAP0).fill(-1);
  _tsByAppSlot = new Int32Array(256).fill(-1);
  _paraTok = new Uint32Array(256);
  _paraLen = 0;
  _gPara = 0;
  _tokSeg = new Uint32Array(512);
  _tokAdvW = new Float64Array(512);
  _tokLen = 0;
  _gTok = 0;
  _segText = new Array(512).fill('');
  _segStyle = new Uint8Array(512);
  _segFontIdx = new Uint16Array(512);
  _segHl = new Uint16Array(512);
  _segAdvW = new Float64Array(512);
  _segLen = 0;
  _gSeg = 0;
  _lineRunStart = new Uint32Array(512);
  _lineAdvW = new Float64Array(512);
  _lineAlignW = new Float64Array(512);
  _lineLen = 0;
  _gLine = 0;
  _runText = new Array(1024).fill('');
  _runFontIdx = new Uint16Array(1024);
  _runHl = new Uint16Array(1024);
  _runAdvW = new Float64Array(1024);
  _runAdvX = new Float64Array(1024);
  _runLen = 0;
  _gRun = 0;
  HL_STRINGS.length = 1;
  _hlToIdx.clear();
}
