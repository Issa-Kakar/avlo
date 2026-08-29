import type { TLShapeId } from '@tldraw/tlschema'
import RBush from 'rbush'
import { describe, expect, it } from 'vitest'
import { ShapeSpatialIndex } from './ShapeSpatialIndex'

const id = (n: number) => `shape:s${n}` as TLShapeId

/** Deterministic, so a failure is reproducible from the seed alone. */
function rng(seed: number) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

interface Box {
	minX: number
	minY: number
	maxX: number
	maxY: number
	id: TLShapeId
}

function bruteForce(live: Map<TLShapeId, Box>, q: Box): Set<TLShapeId> {
	const out = new Set<TLShapeId>()
	for (const [k, b] of live) {
		if (b.minX <= q.maxX && b.maxX >= q.minX && b.minY <= q.maxY && b.maxY >= q.minY) out.add(k)
	}
	return out
}

describe('ShapeSpatialIndex', () => {
	it('inserts, finds, and removes', () => {
		const ix = new ShapeSpatialIndex()
		expect(ix.getSize()).toBe(0)
		expect(ix.upsert(id(1), 0, 0, 10, 10)).toBe(true)
		expect(ix.getSize()).toBe(1)
		expect(ix.has(id(1))).toBe(true)
		expect(ix.search(5, 5, 6, 6, false)).toEqual(new Set([id(1)]))
		expect(ix.search(50, 50, 60, 60, false).size).toBe(0)
		expect(ix.remove(id(1))).toBe(true)
		expect(ix.remove(id(1))).toBe(false)
		expect(ix.getSize()).toBe(0)
	})

	it('reports an unchanged upsert as no change', () => {
		const ix = new ShapeSpatialIndex()
		ix.upsert(id(1), 0, 0, 10, 10)
		expect(ix.upsert(id(1), 0, 0, 10, 10)).toBe(false)
		expect(ix.upsert(id(1), 0, 0, 10, 11)).toBe(true)
	})

	it('matchesBounds tracks the stored box', () => {
		const ix = new ShapeSpatialIndex()
		ix.upsert(id(1), 1, 2, 3, 4)
		expect(ix.matchesBounds(id(1), 1, 2, 3, 4)).toBe(true)
		expect(ix.matchesBounds(id(1), 1, 2, 3, 5)).toBe(false)
		expect(ix.matchesBounds(id(99), 1, 2, 3, 4)).toBe(false)
	})

	it('drops shapes whose bounds are not indexable', () => {
		const ix = new ShapeSpatialIndex()
		expect(ix.upsert(id(1), NaN, 0, 10, 10)).toBe(false)
		expect(ix.upsert(id(2), 0, 0, Infinity, 10)).toBe(false)
		expect(ix.upsert(id(3), 10, 0, 0, 10)).toBe(false) // inverted
		expect(ix.getSize()).toBe(0)
		// a shape that becomes un-indexable leaves the index
		ix.upsert(id(4), 0, 0, 10, 10)
		expect(ix.upsert(id(4), NaN, 0, 10, 10)).toBe(true)
		expect(ix.has(id(4))).toBe(false)
	})

	it('hits zero-area boxes on all four edges', () => {
		const ix = new ShapeSpatialIndex()
		ix.upsert(id(1), 0, 0, 10, 10)
		// rbush's intersection is inclusive; a point probe on the boundary hits
		for (const [x, y] of [
			[0, 0],
			[10, 10],
			[0, 10],
			[5, 0],
		]) {
			expect(ix.search(x, y, x, y, true), `probe ${x},${y}`).toEqual(new Set([id(1)]))
		}
		// a zero-area shape is findable too
		ix.upsert(id(2), 20, 20, 20, 20)
		expect(ix.search(20, 20, 20, 20, true)).toEqual(new Set([id(2)]))
	})

	it('does not leak membership when a slot is recycled', () => {
		const ix = new ShapeSpatialIndex()
		ix.upsert(id(1), 0, 0, 10, 10)
		ix.remove(id(1))
		// id(2) takes the slot id(1) just freed
		ix.upsert(id(2), 0, 0, 10, 10)
		const found = ix.search(5, 5, 6, 6, false)
		expect(found).toEqual(new Set([id(2)]))
		expect(found.has(id(1))).toBe(false)
	})

	it('reuses ids after removal, the way undo replays them', () => {
		const ix = new ShapeSpatialIndex()
		ix.upsert(id(1), 0, 0, 10, 10)
		ix.remove(id(1))
		ix.upsert(id(1), 100, 100, 110, 110)
		expect(ix.search(5, 5, 6, 6, false).size).toBe(0)
		expect(ix.search(105, 105, 106, 106, false)).toEqual(new Set([id(1)]))
		ix.validate()
	})

	it('is reusable after clear and after dispose', () => {
		const ix = new ShapeSpatialIndex()
		for (let i = 0; i < 200; i++) ix.upsert(id(i), i, i, i + 5, i + 5)
		ix.clear()
		expect(ix.getSize()).toBe(0)
		expect(ix.search(-1e6, -1e6, 1e6, 1e6, false).size).toBe(0)

		// dispose must not be terminal: the editor registers it as a disposable
		// but does not tear down the computed that repopulates the index, so a
		// read after disposal refills it. A structure that could be made
		// permanently unusable would turn that into a hang.
		ix.dispose()
		for (let i = 0; i < 200; i++) ix.upsert(id(i), i, i, i + 5, i + 5)
		expect(ix.getSize()).toBe(200)
		ix.validate()
	})

	it('bulk loads through rebuildFrom, skipping invalid and duplicate entries', () => {
		const ix = new ShapeSpatialIndex()
		ix.rebuildFrom(100, (add) => {
			for (let i = 0; i < 100; i++) add(id(i), i * 10, 0, i * 10 + 8, 8)
			add(id(0), 0, 0, 1, 1) // duplicate
			add(id(500), NaN, 0, 1, 1) // invalid
		})
		expect(ix.getSize()).toBe(100)
		ix.validate()
		expect(ix.search(0, 0, 8, 8, false)).toEqual(new Set([id(0)]))
		// a second rebuild replaces rather than accumulates
		ix.rebuildFrom(3, (add) => {
			add(id(900), 0, 0, 1, 1)
			add(id(901), 5, 5, 6, 6)
			add(id(902), 9, 9, 10, 10)
		})
		expect(ix.getSize()).toBe(3)
		ix.validate()
	})

	it('agrees with brute force and with rbush under mixed mutation', () => {
		const N = 600
		for (const seed of [1, 2, 3]) {
			const rnd = rng(seed * 7919)
			const ix = new ShapeSpatialIndex()
			const rb = new RBush<Box>()
			const live = new Map<TLShapeId, Box>()

			for (let i = 0; i < N; i++) {
				const x = rnd() * 4000
				const y = rnd() * 4000
				const b: Box = { minX: x, minY: y, maxX: x + rnd() * 200, maxY: y + rnd() * 200, id: id(i) }
				live.set(b.id, b)
				rb.insert(b)
				ix.upsert(b.id, b.minX, b.minY, b.maxX, b.maxY)
			}

			for (let round = 0; round < 40; round++) {
				for (let op = 0; op < 60; op++) {
					const n = (rnd() * N) | 0
					const key = id(n)
					const roll = rnd()
					const existing = live.get(key)
					if (roll < 0.45 && existing) {
						// small nudge, big jump, or resize -- all three update tiers
						const mode = rnd()
						const dx = mode < 0.5 ? (rnd() - 0.5) * 10 : mode < 0.8 ? (rnd() - 0.5) * 3000 : 0
						const grow = mode >= 0.8 ? (rnd() - 0.5) * 250 : 0
						rb.remove(existing)
						existing.minX += dx
						existing.minY += dx
						existing.maxX = Math.max(existing.minX, existing.maxX + dx + grow)
						existing.maxY = Math.max(existing.minY, existing.maxY + dx + grow)
						rb.insert(existing)
						ix.upsert(key, existing.minX, existing.minY, existing.maxX, existing.maxY)
					} else if (roll < 0.7 && existing) {
						rb.remove(existing)
						live.delete(key)
						expect(ix.remove(key)).toBe(true)
					} else if (!existing) {
						const x = rnd() * 4000
						const y = rnd() * 4000
						const b: Box = {
							minX: x,
							minY: y,
							maxX: x + rnd() * 200,
							maxY: y + rnd() * 200,
							id: key,
						}
						live.set(key, b)
						rb.insert(b)
						ix.upsert(key, b.minX, b.minY, b.maxX, b.maxY)
					}
				}

				expect(ix.getSize()).toBe(live.size)
				ix.validate()

				for (let q = 0; q < 6; q++) {
					const x = rnd() * 4000
					const y = rnd() * 4000
					const qb: Box = { minX: x, minY: y, maxX: x + 400, maxY: y + 400, id: id(-1) }
					const expected = bruteForce(live, qb)
					expect(ix.search(qb.minX, qb.minY, qb.maxX, qb.maxY, false)).toEqual(expected)
					expect(ix.search(qb.minX, qb.minY, qb.maxX, qb.maxY, true)).toEqual(expected)
					expect(new Set(rb.search(qb).map((e) => e.id))).toEqual(expected)
				}
			}
		}
	})
})
