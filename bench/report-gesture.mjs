import { readFileSync } from 'node:fs'
const rows = readFileSync('results/gesture.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const key = (r) => [r.gesture, r.n, r.sel, r.px, r.measure].join('|')
const P = new Map()
for (const r of rows) {
	if (!P.has(key(r))) P.set(key(r), {})
	P.get(key(r))[r.engine] = r
}
const f = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d))
const rat = (a, b) => (!b || a === null || a === undefined ? '—' : (a / b).toFixed(1) + '×')
const scen = (r) => `${r.gesture} ${r.sel} of ${r.n}`

console.log('='.repeat(100))
console.log('GESTURES — one tick = upsert every selected shape, then the frame\'s one viewport query')
console.log('='.repeat(100))

console.log('\nALLOCATION per frame (exact, GC-free windows). 60 fps => the MB/s column.')
console.log('  ' + 'scenario'.padEnd(22) + 'px/tick'.padStart(8) + 'rbush KB'.padStart(11) + 'flat BYTES'.padStart(10) + 'less'.padStart(9) + '   rbush MB/s   flat MB/s')
console.log('  ' + '-'.repeat(22) + ' '.repeat(1) + '-'.repeat(7) + ' ' + '-'.repeat(10) + ' ' + '-'.repeat(9) + ' ' + '-'.repeat(8) + '   ' + '-'.repeat(10) + '  ' + '-'.repeat(10))
for (const [, v] of P) {
	if (!v.rbush || v.rbush.measure !== 'alloc') continue
	console.log(
		'  ' + scen(v.rbush).padEnd(22) + String(v.rbush.px).padStart(8) +
		f(v.rbush.bytesPerTick / 1024).padStart(11) + f(v.flat.bytesPerTick, 1).padStart(10) +
		(v.flat.bytesPerTick < 1 ? 'total' : rat(v.rbush.bytesPerTick, v.flat.bytesPerTick)).padStart(9) +
		f(v.rbush.mbPerSecAt60fps, 1).padStart(13) + f(v.flat.mbPerSecAt60fps, 5).padStart(12)
	)
}

console.log('\nTIME per frame (min of 9). Budget is 16.67 ms at 60 fps — and the index is one part of a frame.')
console.log('  ' + 'scenario'.padEnd(22) + 'px/tick'.padStart(8) + 'rbush ms'.padStart(11) + 'flat ms'.padStart(10) + 'faster'.padStart(9) + '  rbush % of frame')
for (const [, v] of P) {
	if (!v.rbush || v.rbush.measure !== 'time') continue
	console.log(
		'  ' + scen(v.rbush).padEnd(22) + String(v.rbush.px).padStart(8) +
		f(v.rbush.msPerTick, 3).padStart(11) + f(v.flat.msPerTick, 3).padStart(10) +
		rat(v.rbush.msPerTick, v.flat.msPerTick).padStart(9) + f(v.rbush.budgetPct, 1).padStart(15) + '%'
	)
}

console.log('\nGARBAGE COLLECTION at production heap settings (Node defaults, no semi-space override)')
console.log('  ' + 'scenario'.padEnd(22) + 'engine'.padStart(7) + 'GCs'.padStart(7) + 'GC ms'.padStart(9) + 'worst pause'.padStart(13) + 'GCs/1000 frames'.padStart(17) + 'ms/frame'.padStart(10))
for (const [, v] of P) {
	if (!v.rbush || v.rbush.measure !== 'gc') continue
	for (const e of ['rbush', 'flat']) {
		const r = v[e]
		console.log(
			'  ' + (e === 'rbush' ? scen(r) : '').padEnd(22) + e.padStart(7) + String(r.gc.count).padStart(7) +
			f(r.gc.totalMs, 1).padStart(9) + (f(r.worstPauseMs, 2) + ' ms').padStart(13) +
			f((r.gc.count * 1000) / r.ticks, 1).padStart(17) + f(r.msPerTick, 3).padStart(10)
		)
	}
}
