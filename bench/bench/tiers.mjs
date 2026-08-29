// What fraction of a gesture's updates actually take the tree's O(1) path.
// Reported so nobody has to take "it has fast paths" on trust -- and so the
// travel-per-tick that produces a given speedup can be checked against the mix
// it implies. A benchmark that nudges shapes a few percent of their width parks
// everything in tier 1; the counts below say when that is happening.

import { FlatRTree } from '../lib/flatrtree-instr.mjs'
import { makeBoxes } from '../lib/data.mjs'

const N = 20000
const SEL = 200
const TICKS = 60
const ds = makeBoxes('board', N, 1)
const ids = new Uint32Array(N)
for (let i = 0; i < N; i++) ids[i] = i

console.log('update fast-path mix — 200-shape drag, 60 ticks, board data, n=20000\n')
console.log('  travel/tick   tier1 O(1)      recalc     relocate')
console.log('  -----------  -----------  ----------  -----------')

for (const px of [1, 4, 12, 32, 96]) {
	const cur = new Float64Array(ds.boxes)
	const t = new FlatRTree()
	t.load(N, ids, cur)
	globalThis.__TIER.fill(0)
	for (let tick = 0; tick < TICKS; tick++) {
		for (let k = 0; k < SEL; k++) {
			const j = k << 2
			cur[j] += px
			cur[j + 2] += px
			t.update(k, cur[j], cur[j + 1], cur[j + 2], cur[j + 3])
		}
	}
	t.validate()
	const T = globalThis.__TIER
	const tot = T[0] + T[1] + T[2] + T[3]
	const pct = (v) => ((100 * v) / tot).toFixed(1) + '%'
	console.log(
		'  ' + String(px + ' units').padStart(11) + '  ' + pct(T[1]).padStart(11) + '  ' + pct(T[2]).padStart(10) + '  ' + pct(T[3]).padStart(11)
	)
}
console.log('\n(a shape here is ~220 units wide, so 12 units/tick is a brisk but ordinary drag)')
