import { readFileSync } from 'node:fs'

const rows = readFileSync(process.argv[2] ?? 'results/tier1.jsonl', 'utf8')
	.trim()
	.split('\n')
	.map((l) => JSON.parse(l))

const key = (r) => [r.data, r.n, r.op, r.measure, r.frac ?? '', r.px ?? '', r.sel ?? '', r.gesture ?? ''].join('|')
const pairs = new Map()
for (const r of rows) {
	const k = key(r)
	if (!pairs.has(k)) pairs.set(k, {})
	pairs.get(k)[r.engine] = r
}

const num = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d))
const ratio = (a, b) =>
	b === 0 || b === null || a === null || b === undefined || a === undefined ? '—' : (a / b).toFixed(1) + '×'
const pad = (s, w, right = true) => (right ? String(s).padStart(w) : String(s).padEnd(w))

function table(title, filter, cols) {
	const sel = [...pairs.entries()].filter(([k, v]) => v.rbush && v.flat && filter(v.rbush))
	if (!sel.length) return
	console.log('\n' + title)
	console.log('  ' + cols.map((c) => pad(c.h, c.w, c.r !== false)).join('  '))
	console.log('  ' + cols.map((c) => '-'.repeat(c.w)).join('  '))
	for (const [, v] of sel) {
		console.log('  ' + cols.map((c) => pad(c.f(v.rbush, v.flat), c.w, c.r !== false)).join('  '))
	}
}

const label = (r) => `${r.data}/${r.n}`

console.log('='.repeat(96))
console.log('TIER 1 — raw engine: rbush 3.0.1 vs FlatRTree. No wrapper, no Set, no id mapping.')
console.log('='.repeat(96))

table(
	'ALLOCATION per operation (bytes) — exact, measured in GC-free windows',
	(r) => r.measure === 'alloc' && r.op !== 'load',
	[
		{ h: 'dataset/n', w: 16, f: (a) => label(a), r: false },
		{ h: 'op', w: 8, f: (a) => a.op, r: false },
		{ h: 'hits', w: 7, f: (a) => (a.op === 'search' ? num(a.avgHits, 0) : '') },
		{ h: 'rbush B', w: 11, f: (a) => num(a.bytesPerOp) },
		{ h: 'flat B', w: 9, f: (a, b) => num(b.bytesPerOp) },
		{ h: 'less garbage', w: 13, f: (a, b) => (b.bytesPerOp < 1 ? '>1000×' : ratio(a.bytesPerOp, b.bytesPerOp)) },
		{ h: 'check', w: 7, f: (a, b) => (a.linear && b.linear ? (a.checkMode === 'repeat' ? 'repeat' : 'linear') : 'NO') },
	]
)

table(
	'TIME per operation (ns) — minimum of 7 runs',
	(r) => r.measure === 'time' && r.op !== 'load',
	[
		{ h: 'dataset/n', w: 16, f: (a) => label(a), r: false },
		{ h: 'op', w: 8, f: (a) => a.op, r: false },
		{ h: 'hits', w: 7, f: (a) => (a.op === 'search' ? num(a.avgHits, 0) : '') },
		{ h: 'rbush ns', w: 11, f: (a) => num(a.nsPerOp, 0) },
		{ h: 'flat ns', w: 9, f: (a, b) => num(b.nsPerOp, 0) },
		{ h: 'faster', w: 8, f: (a, b) => ratio(a.nsPerOp, b.nsPerOp) },
	]
)

table(
	'BULK LOAD (whole tree)',
	(r) => r.op === 'load',
	[
		{ h: 'dataset/n', w: 16, f: (a) => label(a), r: false },
		{ h: 'measure', w: 9, f: (a) => a.measure, r: false },
		{ h: 'rbush', w: 14, f: (a) => (a.measure === 'time' ? num(a.nsPerOp / 1e6, 3) + ' ms' : a.bytesPerOp == null ? a.reason ?? '—' : num(a.bytesPerOp / 1048576, 2) + ' MB') },
		{ h: 'flat', w: 14, f: (a, b) => (a.measure === 'time' ? num(b.nsPerOp / 1e6, 3) + ' ms' : b.bytesPerOp == null ? b.reason ?? '—' : num(b.bytesPerOp / 1048576, 2) + ' MB') },
		{ h: 'better', w: 8, f: (a, b) => (a.measure === 'time' ? ratio(a.nsPerOp, b.nsPerOp) : a.bytesPerOp == null || b.bytesPerOp == null ? '—' : ratio(a.bytesPerOp, b.bytesPerOp)) },
	]
)

table(
	'RETAINED SIZE of the index structure itself (after a full collection)',
	(r) => r.measure === 'retained',
	[
		{ h: 'dataset/n', w: 16, f: (a) => label(a), r: false },
		{ h: 'rbush total', w: 13, f: (a) => num(a.retainedBytes / 1048576, 2) + ' MB' },
		{ h: 'flat total', w: 12, f: (a, b) => num(b.retainedBytes / 1048576, 2) + ' MB' },
		{ h: 'rbush B/item', w: 13, f: (a) => num(a.retainedPerItem, 1) },
		{ h: 'flat B/item', w: 12, f: (a, b) => num(b.retainedPerItem, 1) },
		{ h: 'leaner', w: 8, f: (a, b) => ratio(a.retainedBytes, b.retainedBytes) },
	]
)
