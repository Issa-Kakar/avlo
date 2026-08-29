// Builds a counting copy of the engine so the update fast-path mix can be
// REPORTED rather than asserted. Benchmark-only: counters are never in the
// timed or measured builds.
import { readFileSync, writeFileSync } from 'node:fs'
let s = readFileSync('lib/flatrtree.mjs', 'utf8')
const start = s.indexOf('  _updateArg(id) {')
const end = s.indexOf('\n  _relocate(', start)
if (start < 0 || end < 0) throw new Error('anchors moved — reinspect the bundle')
let body = s.slice(start, end)
const bump = (k) => `globalThis.__TIER[${k}]++; `
const before = body
body = body.replace('this._insertNew(id);', bump(0) + 'this._insertNew(id);')
body = body.replace(
	'boxes[ob + 3] = maxY;\n      return;',
	'boxes[ob + 3] = maxY;\n      ' + bump(1) + 'return;'
)
body = body.split('this._relocate(id, cell, node, cnt, pc);').join(bump(3) + 'this._relocate(id, cell, node, cnt, pc);')
body = body.split('this._recalcUpFrom(node);').join(bump(2) + 'this._recalcUpFrom(node);')
const inserted = (body.match(/__TIER\[/g) || []).length
if (inserted !== 6) throw new Error('expected 6 counter sites, patched ' + inserted)
if (body === before) throw new Error('no patch applied')
s = s.slice(0, start) + body + s.slice(end)
s = 'globalThis.__TIER = new Int32Array(4);\n' + s
writeFileSync('lib/flatrtree-instr.mjs', s)
console.log('wrote lib/flatrtree-instr.mjs with', inserted, 'counter sites')
