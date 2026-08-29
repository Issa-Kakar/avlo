/**
 * Deterministic data generators for the spatial-index benchmark.
 *
 * Two distributions, and the difference between them is the point of the
 * exercise:
 *
 * - `uniform` is rbush's own benchmark shape — independent boxes of one size
 *   scattered over a square. Nothing about it rewards a smarter split, and it
 *   is the fairest possible ground for the incumbent.
 * - `board` is what a whiteboard actually looks like: shapes bunched into
 *   working areas with empty space between them, a long tail of arrows and
 *   connectors whose bounding boxes are extremely elongated, and a few large
 *   frames that contain everything else. Elongated items are where a split
 *   that only ever sorts by the lower coordinate loses: it files a long arrow
 *   under wherever its left end happens to be.
 */

/** mulberry32 — small, fast, and seeded, so every run compares the same data. */
export function makeRandom(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export interface Dataset {
	/** count */
	n: number
	/** flat [minX, minY, maxX, maxY] * n */
	boxes: Float64Array
	/** world extent, for sizing search rects */
	world: { minX: number; minY: number; maxX: number; maxY: number }
	name: string
}

/** rbush's benchmark distribution: `n` boxes of side `size` over a 100x100 square. */
export function uniform(n: number, seed: number, size = 1): Dataset {
	const random = makeRandom(seed)
	const boxes = new Float64Array(n * 4)
	const span = 100 - size
	for (let i = 0; i < n; i++) {
		const x = random() * span
		const y = random() * span
		const b = i * 4
		boxes[b] = x
		boxes[b + 1] = y
		boxes[b + 2] = x + size * random()
		boxes[b + 3] = y + size * random()
	}
	return { n, boxes, world: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, name: 'uniform' }
}

/**
 * Whiteboard-shaped data.
 *
 * Density is held at roughly one shape per 400x400 units of board, which is
 * about what a busy tldraw page looks like, so the world grows with `n` rather
 * than the boxes piling up.
 *
 * Mix: 68% small shapes clustered into working areas, 14% labels, 13% arrows
 * and connectors (long, thin, often spanning two clusters), 5% frames.
 */
export function board(n: number, seed: number): Dataset {
	const random = makeRandom(seed)
	const side = Math.sqrt(n) * 400
	const clusterCount = Math.max(1, Math.round(n / 400))
	const cx = new Float64Array(clusterCount)
	const cy = new Float64Array(clusterCount)
	for (let i = 0; i < clusterCount; i++) {
		cx[i] = random() * side
		cy[i] = random() * side
	}
	const clusterRadius = 1400
	const boxes = new Float64Array(n * 4)
	for (let i = 0; i < n; i++) {
		const roll = random()
		const c = (random() * clusterCount) | 0
		const b = i * 4
		let x: number, y: number, w: number, h: number
		if (roll < 0.68) {
			// geo / note / draw: modest boxes inside a working area
			x = cx[c] + (random() - 0.5) * clusterRadius * 2
			y = cy[c] + (random() - 0.5) * clusterRadius * 2
			w = 60 + random() * 240
			h = 50 + random() * 200
		} else if (roll < 0.82) {
			// text labels: small and wide
			x = cx[c] + (random() - 0.5) * clusterRadius * 2
			y = cy[c] + (random() - 0.5) * clusterRadius * 2
			w = 40 + random() * 300
			h = 18 + random() * 30
		} else if (roll < 0.95) {
			// arrows / connectors: elongated, frequently spanning two clusters
			const c2 = (random() * clusterCount) | 0
			const sameArea = random() < 0.75
			const x1 = cx[c] + (random() - 0.5) * clusterRadius * 2
			const y1 = cy[c] + (random() - 0.5) * clusterRadius * 2
			const x2 = sameArea
				? x1 + (random() - 0.5) * clusterRadius
				: cx[c2] + (random() - 0.5) * clusterRadius * 2
			const y2 = sameArea
				? y1 + (random() - 0.5) * clusterRadius
				: cy[c2] + (random() - 0.5) * clusterRadius * 2
			x = Math.min(x1, x2)
			y = Math.min(y1, y2)
			w = Math.max(2, Math.abs(x2 - x1))
			h = Math.max(2, Math.abs(y2 - y1))
		} else {
			// frames: large containers
			x = cx[c] - clusterRadius + (random() - 0.5) * 400
			y = cy[c] - clusterRadius + (random() - 0.5) * 400
			w = 1200 + random() * 3000
			h = 900 + random() * 2200
		}
		boxes[b] = x
		boxes[b + 1] = y
		boxes[b + 2] = x + w
		boxes[b + 3] = y + h
	}
	return {
		n,
		boxes,
		world: {
			minX: -clusterRadius,
			minY: -clusterRadius,
			maxX: side + clusterRadius,
			maxY: side + clusterRadius,
		},
		name: 'board',
	}
}

export function makeDataset(kind: string, n: number, seed: number): Dataset {
	if (kind === 'uniform') return uniform(n, seed)
	if (kind === 'board') return board(n, seed)
	throw new Error(`unknown dataset: ${kind}`)
}

/** `count` search rects covering `fraction` of the world's area, placed at random. */
export function makeSearchRects(
	data: Dataset,
	count: number,
	fraction: number,
	seed: number
): Float64Array {
	const random = makeRandom(seed)
	const { world } = data
	const worldW = world.maxX - world.minX
	const worldH = world.maxY - world.minY
	const w = worldW * Math.sqrt(fraction)
	const h = worldH * Math.sqrt(fraction)
	const out = new Float64Array(count * 4)
	for (let i = 0; i < count; i++) {
		const x = world.minX + random() * (worldW - w)
		const y = world.minY + random() * (worldH - h)
		const b = i * 4
		out[b] = x
		out[b + 1] = y
		out[b + 2] = x + w
		out[b + 3] = y + h
	}
	return out
}

/** `count` points drawn from the positions of real items, so hit tests land the
 *  way a cursor does rather than in empty space. */
export function makeProbePoints(data: Dataset, count: number, seed: number): Float64Array {
	const random = makeRandom(seed)
	const out = new Float64Array(count * 2)
	for (let i = 0; i < count; i++) {
		const j = ((random() * data.n) | 0) * 4
		out[i * 2] = data.boxes[j] + (data.boxes[j + 2] - data.boxes[j]) * random()
		out[i * 2 + 1] = data.boxes[j + 1] + (data.boxes[j + 3] - data.boxes[j + 1]) * random()
	}
	return out
}
