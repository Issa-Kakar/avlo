// Deterministic workload generation. Seeded so every run of every engine sees
// byte-identical input; the orchestrator relies on that for parity.

export function mulberry32(seed) {
	let a = seed >>> 0
	return function () {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Box-Muller, one value per call (the discarded twin costs nothing here). */
function gauss(rnd) {
	const u = 1 - rnd()
	const v = rnd()
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * Three datasets, reported side by side on purpose:
 *
 *  uniform   — the classic benchmark distribution and rbush's best case:
 *              no clustering for a bulk loader to exploit, no size spread.
 *  clustered — what a whiteboard actually looks like. People work in pockets;
 *              the page is mostly empty.
 *  board     — clustered, plus the two things a real tldraw page has that
 *              break uniformity: frames (huge, overlapping) and arrows
 *              (long, thin, high aspect ratio).
 *
 * Every dataset returns boxes as a flat Float64Array [minX,minY,maxX,maxY]*n
 * so neither engine gets a layout advantage from the generator.
 */
export function makeBoxes(kind, n, seed = 1) {
	const rnd = mulberry32(seed)
	const boxes = new Float64Array(n * 4)
	// Target ~5% areal coverage, which is roughly what a working board looks like.
	const world = Math.sqrt((n * 120 * 120) / 0.05)

	if (kind === 'uniform') {
		for (let i = 0; i < n; i++) {
			const w = 20 + rnd() * 180
			const h = 20 + rnd() * 180
			const x = rnd() * (world - w)
			const y = rnd() * (world - h)
			const j = i << 2
			boxes[j] = x
			boxes[j + 1] = y
			boxes[j + 2] = x + w
			boxes[j + 3] = y + h
		}
		return { boxes, n, world, kind }
	}

	const clusters = Math.max(1, Math.ceil(n / 150))
	const cx = new Float64Array(clusters)
	const cy = new Float64Array(clusters)
	for (let c = 0; c < clusters; c++) {
		cx[c] = rnd() * world
		cy[c] = rnd() * world
	}
	const spread = world / Math.sqrt(clusters) / 3

	for (let i = 0; i < n; i++) {
		const c = (rnd() * clusters) | 0
		let w, h
		const roll = kind === 'board' ? rnd() : 1
		if (roll < 0.03) {
			// frame
			w = 800 + rnd() * 2200
			h = 600 + rnd() * 1400
		} else if (roll < 0.15) {
			// arrow / connector — long and thin, either orientation
			const long = 200 + rnd() * 1300
			const thin = 4 + rnd() * 36
			if (rnd() < 0.5) {
				w = long
				h = thin
			} else {
				w = thin
				h = long
			}
		} else {
			w = 30 + rnd() * 220
			h = 30 + rnd() * 220
		}
		const x = cx[c] + gauss(rnd) * spread
		const y = cy[c] + gauss(rnd) * spread
		const j = i << 2
		boxes[j] = x
		boxes[j + 1] = y
		boxes[j + 2] = x + w
		boxes[j + 3] = y + h
	}
	return { boxes, n, world, kind }
}

/** Query rects sized so that each returns, on average, `frac` of the items. */
export function makeQueries(ds, count, frac, seed = 7) {
	const rnd = mulberry32(seed)
	// Side length from the areal fraction; the clustered sets return more than
	// `frac` inside a cluster and fewer outside, which is realistic.
	const side = ds.world * Math.sqrt(frac)
	const q = new Float64Array(count * 4)
	for (let i = 0; i < count; i++) {
		const x = rnd() * (ds.world - side)
		const y = rnd() * (ds.world - side)
		const j = i << 2
		q[j] = x
		q[j + 1] = y
		q[j + 2] = x + side
		q[j + 3] = y + side
	}
	return q
}

/** rbush's element objects, minted once, outside every measured window. */
export function makeElements(ds) {
	const { boxes, n } = ds
	const els = new Array(n)
	for (let i = 0; i < n; i++) {
		const j = i << 2
		els[i] = { minX: boxes[j], minY: boxes[j + 1], maxX: boxes[j + 2], maxY: boxes[j + 3], id: i }
	}
	return els
}

/** A fixed random permutation of [0,n), for op ordering both engines share. */
export function permutation(n, seed = 3) {
	const rnd = mulberry32(seed)
	const p = new Uint32Array(n)
	for (let i = 0; i < n; i++) p[i] = i
	for (let i = n - 1; i > 0; i--) {
		const j = (rnd() * (i + 1)) | 0
		const t = p[i]
		p[i] = p[j]
		p[j] = t
	}
	return p
}
