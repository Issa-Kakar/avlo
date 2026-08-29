import { execFileSync } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'
const CLEAN = ['--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256']
const PROD = ['--expose-gc']
const OUT = 'results/tier2.jsonl'
writeFileSync(OUT, '')
function run(opts) {
	const flags = opts.measure === 'gc' ? PROD : CLEAN
	const args = [...flags, 'bench/wrapper.mjs', ...Object.entries(opts).map(([k, v]) => `--${k}=${v}`)]
	const stdout = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 1 << 24 })
	const line = stdout.split('\n').find((l) => l.startsWith('###JSON###'))
	if (!line) throw new Error('no result from ' + JSON.stringify(opts) + '\n' + stdout)
	appendFileSync(OUT, JSON.stringify(JSON.parse(line.slice(10))) + '\n')
}
const cells = []
for (const s of [
	{ op: 'gesture', n: 2500, sel: 1 },
	{ op: 'gesture', n: 2000, sel: 2000 },
	{ op: 'gesture', n: 20000, sel: 200 },
])
	for (const engine of ['rbush', 'flat'])
		for (const measure of ['alloc', 'time', 'gc']) cells.push({ ...s, engine, measure, data: 'board', px: 12 })
for (const frac of [0.0001, 0.001, 0.01, 0.1])
	for (const engine of ['rbush', 'flat'])
		for (const measure of ['alloc', 'time'])
			cells.push({ op: 'search', n: 20000, frac, engine, measure, data: 'board', sel: 1 })
for (const engine of ['rbush', 'flat'])
	for (const measure of ['alloc', 'time']) cells.push({ op: 'load', n: 20000, engine, measure, data: 'board', sel: 1 })
console.error(`${cells.length} tier2 cells`)
let i = 0
for (const c of cells) {
	i++
	process.stderr.write(`\r[${i}/${cells.length}] ${c.engine} ${c.op} n=${c.n} sel=${c.sel} ${c.measure} ${c.frac ?? ''}    `)
	run(c)
}
process.stderr.write('\ndone\n')
