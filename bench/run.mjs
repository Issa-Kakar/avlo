// Orchestrator. Every cell is its own process: one engine, one op, one measure.
// Serial on purpose -- the box has 4 vCPU and a parallel run poisons timings.

import { execFileSync } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'

const FLAGS = ['--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256']
const OUT = 'results/tier1.jsonl'
writeFileSync(OUT, '')

function run(opts) {
	const args = [...FLAGS, 'bench/ops.mjs', ...Object.entries(opts).map(([k, v]) => `--${k}=${v}`)]
	const stdout = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 1 << 24 })
	const line = stdout.split('\n').find((l) => l.startsWith('###JSON###'))
	if (!line) throw new Error('no result from ' + JSON.stringify(opts) + '\n' + stdout)
	const rec = JSON.parse(line.slice(10))
	appendFileSync(OUT, JSON.stringify(rec) + '\n')
	return rec
}

const cells = []
const push = (o) => cells.push(o)

const DATASETS = ['uniform', 'clustered', 'board']
const ENGINES = ['rbush', 'flat']

// core ops at a large-canvas size
for (const data of DATASETS)
	for (const op of ['search', 'insert', 'update', 'remove', 'load'])
		for (const engine of ENGINES)
			for (const measure of ['alloc', 'time']) push({ engine, data, n: 20000, op, measure, frac: 0.01 })

// how search scales with result size
for (const data of ['uniform', 'board'])
	for (const frac of [0.0001, 0.001, 0.01, 0.1])
		for (const engine of ENGINES)
			for (const measure of ['alloc', 'time']) push({ engine, data, n: 20000, op: 'search', frac, measure })

// how the gap moves with page size
for (const n of [2000, 20000, 100000])
	for (const op of ['update', 'search'])
		for (const engine of ENGINES)
			for (const measure of ['alloc', 'time']) push({ engine, data: 'board', n, op, measure, frac: 0.01 })

// retained size of everything the engine needs to answer
for (const data of DATASETS)
	for (const n of [2000, 20000, 100000])
		for (const engine of ENGINES) push({ engine, data, n, op: 'search', measure: 'retained' })

console.error(`${cells.length} cells`)
let i = 0
for (const c of cells) {
	i++
	process.stderr.write(`\r[${i}/${cells.length}] ${c.engine} ${c.data} n=${c.n} ${c.op} ${c.measure} ${c.frac ?? ''}     `)
	run(c)
}
process.stderr.write('\ndone\n')
