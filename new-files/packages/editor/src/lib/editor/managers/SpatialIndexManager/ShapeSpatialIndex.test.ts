import type { TLShapeId } from '@tldraw/tlschema'
import RBush from 'rbush'
import { describe, expect, it } from 'vitest'
import { ShapeSpatialIndex } from './ShapeSpatialIndex'

/**
 * The index is checked against two independent oracles on every step: a brute
 * force scan of a plain model map, and rbush itself. Any disagreement between
 * the three is a failure, so a bug would have to be reproduced identically by a
 * linear scan and by the library being replaced before it could hide.
 *
 * `validate()` runs alongside, which is a stricter check than the answers: it
 * proves every internal MBR is the exact union of its children, so a tree that
 * happened to return the right shapes through slack bounds would still fail.
 */

function makeRandom(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

interface Model {
	minX: number
	minY: number
	maxX: number
	maxY: number
	id: TLShapeId
}

function bruteForce(model: Map<TLShapeId, Model>, r: number[]): Set<TLShapeId> {
	const out = new Set<TLShapeId>()
	for (const m of model.values()) {
		if (r[0] <= m.maxX && r[2] >= m.minX && r[1] <= m.maxY && r[3] >= m.minY) out.add(m.id)
	}
	return out
}

function expectSameSet(actual: Set<TLShapeId>, expected: Set<TLShapeId>, what: string) {
	if (actual.size !== expected.size) {
		throw new Error(`${what}: size ${actual.size} !== ${expected.size}`)
	}
	for (const id of expected) {
		if (!actual.has(id)) throw new Error(`${what}: missing ${id}`)
	}
}

describe('ShapeSpatialIndex', () => {
	it('agrees with brute force and with rbush under random churn', { timeout: 120_000 }, () => {
		const random = makeRandom(12345)
		const index = new ShapeSpatialIndex()
		const model = new Map<TLShapeId, Model>()
		const rbush = new RBush<Model>()
		const rbushElements = new Map<TLShapeId, Model>()
		const query = index.acquireQuery()

		const ids: TLShapeId[] = []
		for (let i = 0; i < 600; i++) ids.push(`shape:fuzz${i}` as TLShapeId)

		const randomBox = () => {
			// A deliberate mix: some tiny, some enormous, some zero-area, some
			// wildly elongated. Elongated boxes are what a split that only sorts
			// by the lower coordinate handles badly, so they belong in the fuzz.
			const kind = random()
			const x = (random() - 0.5) * 20000
			const y = (random() - 0.5) * 20000
			let w: number, h: number
			if (kind < 0.1) {
				w = 0
				h = 0
			} else if (kind < 0.3) {
				w = random() * 6000
				h = random() * 3
			} else if (kind < 0.5) {
				w = random() * 3
				h = random() * 6000
			} else if (kind < 0.9) {
				w = random() * 200
				h = random() * 200
			} else {
				w = random() * 15000
				h = random() * 15000
			}
			return [x, y, x + w, y + h]
		}

		for (let step = 0; step < 4000; step++) {
			const id = ids[(random() * ids.length) | 0]
			const roll = random()

			if (roll < 0.45) {
				const [minX, minY, maxX, maxY] = randomBox()
				index.upsert(id, minX, minY, maxX, maxY)
				const existing = rbushElements.get(id)
				if (existing) rbush.remove(existing)
				const el: Model = { minX, minY, maxX, maxY, id }
				rbush.insert(el)
				rbushElements.set(id, el)
				model.set(id, el)
			} else if (roll < 0.6) {
				index.remove(id)
				const existing = rbushElements.get(id)
				if (existing) {
					rbush.remove(existing)
					rbushElements.delete(id)
				}
				model.delete(id)
			} else {
				const [minX, minY, maxX, maxY] = randomBox()
				const pad = random() * 4000
				const r = [minX - pad, minY - pad, maxX + pad, maxY + pad]
				const expected = bruteForce(model, r)

				expectSameSet(index.searchToSet(r[0], r[1], r[2], r[3], false), expected, `wide @${step}`)
				expectSameSet(index.searchToSet(r[0], r[1], r[2], r[3], true), expected, `narrow @${step}`)

				query.searchBounds(r[0], r[1], r[2], r[3])
				expect(query.size, `query size @${step}`).toBe(expected.size)
				const fromQuery = new Set<TLShapeId>()
				query.forEach((qid) => fromQuery.add(qid))
				expectSameSet(fromQuery, expected, `query forEach @${step}`)
				for (const candidate of ids) {
					expect(query.has(candidate), `query has(${candidate}) @${step}`).toBe(
						expected.has(candidate)
					)
				}

				const fromRbush = new Set(
					rbush.search({ minX: r[0], minY: r[1], maxX: r[2], maxY: r[3] }).map((e) => e.id)
				)
				expectSameSet(fromRbush, expected, `rbush oracle @${step}`)
			}

			if (step % 250 === 0) {
				index.validate()
				expect(index.getSize()).toBe(model.size)
			}
		}

		index.validate()
		expect(index.getSize()).toBe(model.size)
	})

	it('agrees with brute force after a bulk load', { timeout: 60_000 }, () => {
		const random = makeRandom(999)
		const index = new ShapeSpatialIndex()
		const model = new Map<TLShapeId, Model>()

		index.beginLoad(3000)
		for (let i = 0; i < 3000; i++) {
			const id = `shape:load${i}` as TLShapeId
			const x = random() * 50000
			const y = random() * 50000
			const w = random() < 0.2 ? random() * 8000 : random() * 300
			const h = random() < 0.2 ? random() * 8000 : random() * 300
			const el: Model = { minX: x, minY: y, maxX: x + w, maxY: y + h, id }
			model.set(id, el)
			index.stage(id, el.minX, el.minY, el.maxX, el.maxY)
		}
		index.commitLoad()
		index.validate()
		expect(index.getSize()).toBe(3000)

		for (let probe = 0; probe < 200; probe++) {
			const x = random() * 50000
			const y = random() * 50000
			const size = random() * 10000
			const r = [x, y, x + size, y + size]
			expectSameSet(
				index.searchToSet(r[0], r[1], r[2], r[3], false),
				bruteForce(model, r),
				'after load'
			)
		}

		// Rebuilding must not change any answer.
		index.rebuild()
		index.validate()
		for (let probe = 0; probe < 200; probe++) {
			const x = random() * 50000
			const y = random() * 50000
			const size = random() * 10000
			const r = [x, y, x + size, y + size]
			expectSameSet(
				index.searchToSet(r[0], r[1], r[2], r[3], false),
				bruteForce(model, r),
				'after rebuild'
			)
		}
	})

	it('drops shapes whose bounds are not indexable', () => {
		const index = new ShapeSpatialIndex()
		const good = 'shape:good' as TLShapeId
		const bad = 'shape:bad' as TLShapeId

		// `upsert` reports whether the index changed, which is what drives the
		// manager's epoch — so an unusable box on a shape that was never indexed
		// has to report no change.
		expect(index.upsert(good, 0, 0, 10, 10)).toBe(true)
		expect(index.upsert(bad, NaN, 0, 10, 10)).toBe(false)
		expect(index.has(bad)).toBe(false)
		expect(index.upsert(bad, 0, 0, Infinity, 10)).toBe(false)
		expect(index.upsert(bad, 10, 0, 0, 10)).toBe(false)
		expect(index.getSize()).toBe(1)

		// A shape that becomes un-indexable is removed rather than left stale,
		// and that is a change.
		expect(index.upsert(good, NaN, NaN, NaN, NaN)).toBe(true)
		expect(index.has(good)).toBe(false)
		expect(index.getSize()).toBe(0)
		index.validate()
	})

	it('recycles slots without leaking membership between shapes', () => {
		const index = new ShapeSpatialIndex()
		const query = index.acquireQuery()
		const a = 'shape:a' as TLShapeId
		const b = 'shape:b' as TLShapeId

		index.upsert(a, 0, 0, 10, 10)
		query.searchBounds(-1, -1, 11, 11)
		expect(query.has(a)).toBe(true)

		// `b` takes the slot `a` just freed. A stale stamp would make `b` look
		// like a hit from the search that only ever saw `a`.
		index.remove(a)
		index.upsert(b, 5000, 5000, 5010, 5010)
		expect(query.has(b)).toBe(false)

		query.searchBounds(-1, -1, 11, 11)
		expect(query.size).toBe(0)
		expect(query.has(b)).toBe(false)
		index.validate()
	})

	it('keeps two queries independent when one runs while the other is being read', () => {
		const index = new ShapeSpatialIndex()
		for (let i = 0; i < 200; i++) {
			index.upsert(`shape:n${i}` as TLShapeId, i * 10, 0, i * 10 + 5, 5)
		}
		const outer = index.acquireQuery().searchBounds(0, 0, 105, 5)
		const outerSize = outer.size
		const outerHas = 'shape:n3' as TLShapeId
		expect(outer.has(outerHas)).toBe(true)

		// A nested search — what a custom shape's geometry could do while the
		// outer result is still being walked.
		const inner = index.acquireQuery().searchBounds(1500, 0, 1600, 5)
		expect(inner.has(outerHas)).toBe(false)

		expect(outer.size).toBe(outerSize)
		expect(outer.has(outerHas)).toBe(true)
	})

	it('survives a page-sized clear and reload', () => {
		const index = new ShapeSpatialIndex()
		const query = index.acquireQuery()
		for (let i = 0; i < 500; i++) index.upsert(`shape:p${i}` as TLShapeId, i, i, i + 1, i + 1)
		query.searchBounds(0, 0, 1000, 1000)
		expect(query.size).toBe(500)

		index.clear()
		expect(index.getSize()).toBe(0)
		query.searchBounds(0, 0, 1000, 1000)
		expect(query.size).toBe(0)

		for (let i = 0; i < 300; i++) index.upsert(`shape:q${i}` as TLShapeId, i, i, i + 1, i + 1)
		query.searchBounds(0, 0, 1000, 1000)
		expect(query.size).toBe(300)
		expect(query.has('shape:p0' as TLShapeId)).toBe(false)
		index.validate()
	})

	it('wraps the membership generation without losing answers', { timeout: 60_000 }, () => {
		const index = new ShapeSpatialIndex()
		const query = index.acquireQuery()
		const id = 'shape:w' as TLShapeId
		index.upsert(id, 0, 0, 10, 10)
		// One more than the 16-bit generation space, so the refill path runs.
		for (let i = 0; i < 65600; i++) {
			query.searchBounds(-1, -1, 11, 11)
			if (!query.has(id)) throw new Error(`lost membership at search ${i}`)
		}
		query.searchBounds(1000, 1000, 1010, 1010)
		expect(query.has(id)).toBe(false)
	})

	it('answers the same either side of the small-result crossover', () => {
		// The query keeps a small result as a list and a large one as stamps.
		// Both representations have to answer identically, including at the
		// boundary and when a search shrinks back across it.
		const index = new ShapeSpatialIndex()
		const query = index.acquireQuery()
		const ids: TLShapeId[] = []
		for (let i = 0; i < 64; i++) {
			const id = `shape:c${i}` as TLShapeId
			ids.push(id)
			index.upsert(id, i * 10, 0, i * 10 + 5, 5)
		}

		for (const count of [0, 1, 15, 16, 17, 40, 64, 3, 0]) {
			query.searchBounds(-1, 0, count * 10 - 5, 5)
			expect(query.size, `size for ${count}`).toBe(count)
			const seen: TLShapeId[] = []
			query.forEach((id) => seen.push(id))
			expect(seen.length).toBe(count)
			for (let i = 0; i < 64; i++) {
				expect(query.has(ids[i]), `has(${i}) with ${count} matched`).toBe(i < count)
			}
		}

		// A removal has to reach both representations.
		for (const count of [8, 40]) {
			query.searchBounds(-1, 0, count * 10 - 5, 5)
			expect(query.has(ids[0])).toBe(true)
			index.remove(ids[0])
			expect(query.has(ids[0])).toBe(false)
			index.upsert(ids[0], 0, 0, 5, 5)
		}
		index.validate()
	})

	it('is still usable after dispose', () => {
		// The editor registers dispose as a disposable but does not tear down the
		// index computed with it, so a read afterwards schedules a rebuild against
		// a disposed index. That has to produce an empty index rather than a
		// broken one: an earlier version released the tree's argument channel
		// here, every box then read as NaN, and the insert path spun forever.
		const index = new ShapeSpatialIndex()
		index.upsert('shape:before' as TLShapeId, 0, 0, 10, 10)
		index.dispose()
		expect(index.getSize()).toBe(0)

		index.beginLoad(1)
		index.stage('shape:after' as TLShapeId, 5, 5, 15, 15)
		index.commitLoad()
		expect(index.getSize()).toBe(1)

		const found = index.searchToSet(0, 0, 20, 20, false)
		expect(found.has('shape:after' as TLShapeId)).toBe(true)
		expect(found.has('shape:before' as TLShapeId)).toBe(false)

		const query = index.acquireQuery().searchBounds(0, 0, 20, 20)
		expect(query.size).toBe(1)

		index.upsert('shape:third' as TLShapeId, 1, 1, 2, 2)
		index.remove('shape:after' as TLShapeId)
		index.validate()

		// And disposing twice is fine.
		index.dispose()
		index.dispose()
		expect(index.getSize()).toBe(0)
	})

	it('reports no-op bounds so the manager can skip prop-only updates', () => {
		const index = new ShapeSpatialIndex()
		const id = 'shape:m' as TLShapeId
		expect(index.matchesBounds(id, 0, 0, 10, 10)).toBe(false)
		index.upsert(id, 0, 0, 10, 10)
		expect(index.matchesBounds(id, 0, 0, 10, 10)).toBe(true)
		expect(index.matchesBounds(id, 0, 0, 10, 10.0001)).toBe(false)
		index.upsert(id, 1, 1, 11, 11)
		expect(index.matchesBounds(id, 0, 0, 10, 10)).toBe(false)
		expect(index.matchesBounds(id, 1, 1, 11, 11)).toBe(true)
	})
})
