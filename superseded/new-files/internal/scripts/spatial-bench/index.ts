/**
 * Driver: runs every (implementation, dataset, size) in its own process and
 * prints the comparison.
 *
 * From the repo root:
 *   yarn tsx internal/scripts/spatial-bench/index.ts
 *   yarn tsx internal/scripts/spatial-bench/index.ts --sizes 10000,100000 --datasets board
 */
import { execFileSync } from 'child_process'
import path from 'path'

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : process.argv[i + 1]
}

const sizes = arg('sizes', '1000,10000,100000').split(',').map(Number)
const datasets = arg('datasets', 'board,uniform').split(',')
const impls = arg('impls', 'rbush,flat').split(',')
const seed = arg('seed', '1')
const runner = path.join(__dirname, 'run-one.ts')

interface Row {
	label: string
	unit: 'ns' | 'us' | 'ms' | 'MB' | 'count'
	key: string
	/** true when a smaller number is better (everything here except hit counts) */
	lowerIsBetter: boolean
}

const ROWS: Row[] = [
	{ label: 'bulk load (cold, whole page)', key: 'loadCold', unit: 'ms', lowerIsBetter: true },
	{ label: 'bulk load (warm, whole page)', key: 'loadWarm', unit: 'ms', lowerIsBetter: true },
	{ label: 'heap held by the index', key: 'heapAfterLoad', unit: 'MB', lowerIsBetter: true },
	{ label: 'search: 100% viewport', key: 'searchViewport', unit: 'us', lowerIsBetter: true },
	{
		label: '  ... as a Set<TLShapeId>',
		key: 'searchViewportToSet',
		unit: 'us',
		lowerIsBetter: true,
	},
	{ label: 'search: zoomed out ~10x', key: 'searchZoomedOut', unit: 'us', lowerIsBetter: true },
	{
		label: '  ... as a Set<TLShapeId>',
		key: 'searchZoomedOutToSet',
		unit: 'us',
		lowerIsBetter: true,
	},
	{ label: 'search: fit to page', key: 'searchWide', unit: 'us', lowerIsBetter: true },
	{ label: '  ... as a Set<TLShapeId>', key: 'searchWideToSet', unit: 'us', lowerIsBetter: true },
	{ label: 'hit test at a point', key: 'searchPoint', unit: 'us', lowerIsBetter: true },
	{
		label: 'cull-shaped (search + membership)',
		key: 'cullShaped',
		unit: 'us',
		lowerIsBetter: true,
	},
	{ label: 'drag 1 shape (per frame)', key: 'drag1PerFrame', unit: 'us', lowerIsBetter: true },
	{ label: 'drag 20 shapes (per frame)', key: 'drag20PerFrame', unit: 'us', lowerIsBetter: true },
	{ label: 'drag 200 shapes (per frame)', key: 'drag200PerFrame', unit: 'us', lowerIsBetter: true },
	{ label: 'relocate a shape across the page', key: 'teleport', unit: 'us', lowerIsBetter: true },
	{ label: 'insert one shape', key: 'insert', unit: 'us', lowerIsBetter: true },
	{ label: 'remove one shape', key: 'remove', unit: 'us', lowerIsBetter: true },
]

function format(value: number, unit: Row['unit']): string {
	switch (unit) {
		case 'ns':
			return `${value.toFixed(0)} ns`
		case 'us':
			return `${(value / 1000).toFixed(value < 10000 ? 3 : 1)} µs`
		case 'ms':
			return `${(value / 1e6).toFixed(2)} ms`
		case 'MB':
			return `${(value / 1048576).toFixed(2)} MB`
		default:
			return String(value)
	}
}

function runChild(impl: string, dataset: string, n: number): any {
	const out = execFileSync(
		process.execPath,
		[
			'--expose-gc',
			require.resolve('tsx/cli'),
			runner,
			'--impl',
			impl,
			'--dataset',
			dataset,
			'--n',
			String(n),
			'--seed',
			seed,
		],
		{ encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] }
	)
	const line = out
		.trim()
		.split('\n')
		.filter((l) => l.startsWith('{'))
		.pop()
	if (!line) throw new Error(`no result from ${impl}/${dataset}/${n}`)
	return JSON.parse(line)
}

for (const dataset of datasets) {
	for (const n of sizes) {
		const byImpl: Record<string, any> = {}
		for (const impl of impls) {
			process.stderr.write(`  running ${impl} ${dataset} n=${n}...\n`)
			byImpl[impl] = runChild(impl, dataset, n)
			if (byImpl[impl].error) throw new Error(byImpl[impl].error)
		}
		const base = byImpl[impls[0]]
		const hits = [
			`viewport ${base.searchViewportHits.toFixed(1)}`,
			`zoomed-out ${base.searchZoomedOutHits.toFixed(0)}`,
			`fit ${base.searchWideHits.toFixed(0)}`,
			`point ${base.searchPointHits.toFixed(2)}`,
		].join(', ')
		const cull = `cull-shaped suite: ${base.cullShapedProbes.toLocaleString()} membership probes against ${base.cullShapedHits.toFixed(0)} matched shapes per search`

		console.log('')
		console.log(`### ${dataset}, ${n.toLocaleString()} shapes`)
		console.log(`shapes returned per search: ${hits}`)
		console.log(cull)
		console.log('')
		const nameCol = 36
		const valCol = 14
		let header = 'measurement'.padEnd(nameCol)
		for (const impl of impls) header += impl.padStart(valCol)
		if (impls.length === 2) header += 'speedup'.padStart(12)
		console.log(header)
		console.log('-'.repeat(header.length))
		for (const row of ROWS) {
			if (byImpl[impls[0]][row.key] === undefined) continue
			let line = row.label.padEnd(nameCol)
			for (const impl of impls) line += format(byImpl[impl][row.key], row.unit).padStart(valCol)
			if (impls.length === 2) {
				const a = byImpl[impls[0]][row.key]
				const b = byImpl[impls[1]][row.key]
				const ratio = row.lowerIsBetter ? a / b : b / a
				line += `${ratio.toFixed(2)}x`.padStart(12)
			}
			console.log(line)
		}
	}
}
