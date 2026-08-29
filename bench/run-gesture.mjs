// Gesture matrix. Note the flag split: allocation cells run with a huge young
// generation so the window stays GC-free and the byte count is exact, while GC
// cells run at Node's DEFAULT heap settings, because the whole point of those
// is what collection behaviour a user would actually experience.

import { execFileSync } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'

const CLEAN = ['--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256']
const PROD = ['--expose-gc']
const OUT = 'results/gesture.jsonl'
writeFileSync(OUT, '')

function run(opts) {
	const flags = opts.measure === 'gc' ? PROD : CLEAN
	const args = [...flags, 'bench/gesture.mjs', ...Object.entries(opts).map(([k, v]) => `--${k}=${v}`)]
	const stdout = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 1 << 24 })
	const line = stdout.split('\n').find((l) => l.startsWith('###JSON###'))
	if (!line) throw new Error('no result from ' + JSON.stringify(opts) + '\n' + stdout)
	appendFileSync(OUT, JSON.stringify(JSON.parse(line.slice(10))) + '\n')
}

const cells = []
const ENGINES = ['rbush', 'flat']
const MEASURES = ['alloc', 'time', 'gc']

// The three gesture shapes the maintainers' own perf PRs are written in.
const SCENARIOS = [
	{ gesture: 'drag', n: 2500, sel: 1, px: 12 }, // "dragging a single shape on ~2.5K shapes"
	{ gesture: 'drag', n: 2000, sel: 2000, px: 12 }, // "a 2000-shape, 60-tick gesture"
	{ gesture: 'drag', n: 20000, sel: 200, px: 12 },
	{ gesture: 'resize', n: 2000, sel: 2000, px: 12 },
	{ gesture: 'resize', n: 20000, sel: 200, px: 12 },
]

for (const s of SCENARIOS)
	for (const engine of ENGINES) for (const measure of MEASURES) cells.push({ ...s, engine, measure, data: 'board' })

// Travel sweep: how much of the result depends on how fast the pointer moves.
// Reported in full so the fast-path mix is visible rather than chosen.
for (const px of [1, 4, 12, 32, 96])
	for (const engine of ENGINES)
		for (const measure of ['alloc', 'time'])
			cells.push({ gesture: 'drag', n: 20000, sel: 200, px, engine, measure, data: 'board' })

console.error(`${cells.length} gesture cells`)
let i = 0
for (const c of cells) {
	i++
	process.stderr.write(`\r[${i}/${cells.length}] ${c.engine} ${c.gesture} n=${c.n} sel=${c.sel} px=${c.px} ${c.measure}      `)
	run(c)
}
process.stderr.write('\ndone\n')
