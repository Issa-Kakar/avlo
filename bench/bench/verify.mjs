// Parity gate. A speed number from a tree that answers wrongly is worth
// nothing, so every benchmark run in this directory is gated on this passing.
//
// Three oracles, not two: brute force is the ground truth, rbush is the
// incumbent, and the flat tree's own structural validate() checks the
// invariants a query cannot see (exact MBRs, parent/child agreement, the
// cell map, free lists).

import RBush from 'rbush'
import { FlatRTree } from '../lib/flatrtree.mjs'
import { makeBoxes, makeQueries, mulberry32 } from '../lib/data.mjs'

const N = +(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 4000)
const ROUNDS = +(process.argv.find((a) => a.startsWith('--rounds='))?.slice(9) ?? 60)

let failures = 0
function fail(msg) {
	failures++
	console.log('  FAIL: ' + msg)
}

for (const kind of ['uniform', 'clustered', 'board']) {
	for (let seed = 1; seed <= 3; seed++) {
		const ds = makeBoxes(kind, N, seed)
		const cur = new Float64Array(ds.boxes)
		const live = new Uint8Array(N).fill(1)

		const rb = new RBush()
		const els = new Array(N)
		for (let i = 0; i < N; i++) {
			const j = i << 2
			els[i] = { minX: cur[j], minY: cur[j + 1], maxX: cur[j + 2], maxY: cur[j + 3], id: i }
		}
		rb.load(els.slice())

		const ft = new FlatRTree()
		const ids = new Uint32Array(N)
		for (let i = 0; i < N; i++) ids[i] = i
		ft.load(N, ids, cur)

		const rnd = mulberry32(seed * 977)

		const check = (tag) => {
			ft.validate()
			const qs = makeQueries(ds, 40, 0.02, seed + 11)
			// plus a few degenerate probes: zero-area, and a rect covering everything
			for (let q = 0; q < 43; q++) {
				let a, b, c, d
				if (q < 40) {
					const j = q << 2
					a = qs[j]
					b = qs[j + 1]
					c = qs[j + 2]
					d = qs[j + 3]
				} else if (q === 40) {
					a = c = cur[0]
					b = d = cur[1] // zero-area probe on a live corner
				} else if (q === 41) {
					a = b = -1e9
					c = d = 1e9 // everything
				} else {
					a = b = 1e8
					c = d = 1e8 + 1 // nothing
				}

				const brute = new Set()
				for (let i = 0; i < N; i++) {
					if (!live[i]) continue
					const j = i << 2
					if (cur[j] <= c && cur[j + 2] >= a && cur[j + 1] <= d && cur[j + 3] >= b) brute.add(i)
				}
				const rset = new Set(rb.search({ minX: a, minY: b, maxX: c, maxY: d }).map((e) => e.id))
				const cnt = ft.search(a, b, c, d)
				const fset = new Set()
				for (let k = 0; k < cnt; k++) fset.add(ft.results[k])
				const pcnt = ft.searchPrecise(a, b, c, d)
				const pset = new Set()
				for (let k = 0; k < pcnt; k++) pset.add(ft.results[k])

				const eq = (x, y) => x.size === y.size && [...x].every((v) => y.has(v))
				if (!eq(brute, rset)) fail(`${kind}/${seed}/${tag}/q${q}: rbush != brute (${rset.size} vs ${brute.size})`)
				if (!eq(brute, fset)) fail(`${kind}/${seed}/${tag}/q${q}: flat != brute (${fset.size} vs ${brute.size})`)
				if (!eq(brute, pset)) fail(`${kind}/${seed}/${tag}/q${q}: flatPrecise != brute (${pset.size} vs ${brute.size})`)
			}
		}

		check('loaded')

		for (let round = 0; round < ROUNDS; round++) {
			const ops = 200
			for (let o = 0; o < ops; o++) {
				const id = (rnd() * N) | 0
				const j = id << 2
				const roll = rnd()
				if (roll < 0.45 && live[id]) {
					// move: small step, big jump, or a resize -- all three tiers
					const mode = rnd()
					let dx, dy, dw, dh
					if (mode < 0.5) {
						dx = (rnd() - 0.5) * 12
						dy = (rnd() - 0.5) * 12
						dw = dh = 0
					} else if (mode < 0.8) {
						dx = (rnd() - 0.5) * 4000
						dy = (rnd() - 0.5) * 4000
						dw = dh = 0
					} else {
						dx = dy = 0
						dw = (rnd() - 0.5) * 300
						dh = (rnd() - 0.5) * 300
					}
					const nx0 = cur[j] + dx
					const ny0 = cur[j + 1] + dy
					const nx1 = Math.max(nx0, cur[j + 2] + dx + dw)
					const ny1 = Math.max(ny0, cur[j + 3] + dy + dh)
					cur[j] = nx0
					cur[j + 1] = ny0
					cur[j + 2] = nx1
					cur[j + 3] = ny1
					const e = els[id]
					rb.remove(e)
					e.minX = nx0
					e.minY = ny0
					e.maxX = nx1
					e.maxY = ny1
					rb.insert(e)
					ft.update(id, nx0, ny0, nx1, ny1)
				} else if (roll < 0.7 && live[id]) {
					rb.remove(els[id])
					if (!ft.remove(id)) fail(`${kind}/${seed}: flat.remove said absent for a live id`)
					live[id] = 0
				} else if (!live[id]) {
					// reinsert at a fresh spot -- ids are reused in tldraw (undo replays them)
					const x = rnd() * ds.world
					const y = rnd() * ds.world
					cur[j] = x
					cur[j + 1] = y
					cur[j + 2] = x + 30 + rnd() * 200
					cur[j + 3] = y + 30 + rnd() * 200
					const e = els[id]
					e.minX = cur[j]
					e.minY = cur[j + 1]
					e.maxX = cur[j + 2]
					e.maxY = cur[j + 3]
					rb.insert(e)
					ft.insert(id, cur[j], cur[j + 1], cur[j + 2], cur[j + 3])
					live[id] = 1
				}
			}
			let liveCount = 0
			for (let i = 0; i < N; i++) liveCount += live[i]
			if (ft.getSize() !== liveCount) fail(`${kind}/${seed}/r${round}: size ${ft.getSize()} != ${liveCount}`)
			if (round % 15 === 0) check('r' + round)
		}
		check('final')
		// rebuild must preserve the answer set
		ft.rebuild()
		check('rebuilt')
		console.log(`  ok  ${kind}/seed${seed}: ${ROUNDS} rounds, ${ft.getSize()} live`)
	}
}

console.log(failures === 0 ? '\nPARITY OK — flat, rbush and brute force agree everywhere' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
