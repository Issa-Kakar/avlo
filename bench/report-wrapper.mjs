import { readFileSync } from 'node:fs'
const rows = readFileSync('results/tier2.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const key = (r) => [r.op, r.n, r.sel, r.frac, r.measure].join('|')
const P = new Map()
for (const r of rows) {
	if (!P.has(key(r))) P.set(key(r), {})
	P.get(key(r))[r.engine] = r
}
const f = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d))
const rat = (a, b) => (!b || a == null ? '—' : (a / b).toFixed(1) + '×')
const name = (r) => (r.op === 'gesture' ? `drag ${r.sel} of ${r.n}` : r.op === 'search' ? `search (${r.frac * 100}% area)` : `bulk load ${r.n}`)

console.log('='.repeat(100))
console.log('TIER 2 — the wrapper, driven as SpatialIndexManager drives it. Both return Set<TLShapeId>.')
console.log('='.repeat(100))
let bad = 0
for (const [, v] of P) if (v.rbush && v.flat && v.rbush.checksum !== v.flat.checksum) bad++
console.log(bad === 0 ? '\nparity: every cell returned identical result sets\n' : `\nPARITY BROKEN in ${bad} cells\n`)

console.log('ALLOCATION per operation (bytes)')
console.log('  ' + 'scenario'.padEnd(24) + 'rbush'.padStart(12) + 'flat'.padStart(12) + 'less'.padStart(9) + '   note')
for (const [, v] of P) {
	if (!v.rbush || v.rbush.measure !== 'alloc') continue
	console.log(
		'  ' + name(v.rbush).padEnd(24) + f(v.rbush.bytesPerOp, 1).padStart(12) + f(v.flat.bytesPerOp, 1).padStart(12) +
		rat(v.rbush.bytesPerOp, v.flat.bytesPerOp).padStart(9) +
		(v.rbush.mbPerSecAt60fps ? `   ${f(v.rbush.mbPerSecAt60fps, 1)} vs ${f(v.flat.mbPerSecAt60fps, 2)} MB/s at 60 fps` : '')
	)
}
console.log('\nTIME per operation')
console.log('  ' + 'scenario'.padEnd(24) + 'rbush ms'.padStart(12) + 'flat ms'.padStart(12) + 'faster'.padStart(9))
for (const [, v] of P) {
	if (!v.rbush || v.rbush.measure !== 'time') continue
	console.log('  ' + name(v.rbush).padEnd(24) + f(v.rbush.nsPerOp / 1e6, 4).padStart(12) + f(v.flat.nsPerOp / 1e6, 4).padStart(12) + rat(v.rbush.nsPerOp, v.flat.nsPerOp).padStart(9))
}
console.log('\nGARBAGE COLLECTION at production heap settings')
console.log('  ' + 'scenario'.padEnd(24) + 'engine'.padStart(7) + 'GCs'.padStart(7) + 'GC ms'.padStart(9) + 'worst pause'.padStart(13) + 'ms/frame'.padStart(10))
for (const [, v] of P) {
	if (!v.rbush || v.rbush.measure !== 'gc') continue
	for (const e of ['rbush', 'flat']) {
		const r = v[e]
		console.log('  ' + (e === 'rbush' ? name(r) : '').padEnd(24) + e.padStart(7) + String(r.gc.count).padStart(7) + f(r.gc.totalMs, 1).padStart(9) + (f(r.worstPauseMs, 2) + ' ms').padStart(13) + f(r.msPerTick, 3).padStart(10))
	}
}
