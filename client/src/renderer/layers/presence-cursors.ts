// presence-cursors.ts — Laser-pointer feel: tapered width, slightly longer age/length, no snap/spring.
// Drop-in for your presence overlay drawer.

import { PresenceView, ViewTransform } from '@avlo/shared';

// ---------- Types ----------

type Pt = { x: number; y: number; t: number };

interface CursorTrail {
  points: Pt[];                 // oldest -> newest (raw history)
  lastUpdate: number;
  lastPushTime: number;
  lastMovement: number;
  lastPosition: { x: number; y: number } | null;
  length: number;               // running world-length of polyline
}

interface TrailProfile {
  // Pixi-like semantics / geometry
  historyPoints: number;        // "historySize" — raw buffer length
  resamplePoints: number;       // "ropeSize" — samples after cubic resample

  // Visuals (screen-space)
  headWidthPx: number;          // width near the cursor (fatter)
  tailWidthPx: number;          // width at the tail (thinner, tapered)

  // Multi-pass (normal compositing; subtle)
  outerWidthMul: number; outerAlpha: number;
  innerWidthMul: number; innerAlpha: number;
  mainWidthMul:  number; mainAlpha:  number;

  // Lifetime (fade window)
  decayMs: number;              // ultra short but a touch longer now
}

const cursorTrails = new Map<string, CursorTrail>();
const peerProfiles = new Map<string, TrailProfile>();

// ---------- Defaults tuned for "minimal laser pointer" ----------

const DEFAULT_TRAIL_PROFILE: TrailProfile = {
  historyPoints: 20,      // Pixi historySize
  resamplePoints: 100,    // Pixi ropeSize (smooth cubic)

  headWidthPx: 2.0,       // slightly thicker at the head
  tailWidthPx: 0.6,       // tapered, thin tail

  // Subtle three-pass (no additive)
  outerWidthMul: 1.6, outerAlpha: 0.05,
  innerWidthMul: 1.2, innerAlpha: 0.12,
  mainWidthMul:  1.0, mainAlpha:  0.75, // a hair stronger core for legibility

  decayMs: 140,           // was 80 — keep short but a tad longer for “laser”
};

// Perf/behavior guards
const REDUCED_MOTION_PEER_CAP = 25; // same guard you already use :contentReference[oaicite:2]{index=2}
const MIN_POINT_DIST = 0.25;        // world units; modest sampling threshold
const MIN_POINT_DT   = 8;           // ms; up to ~125 Hz sampling
const MOVE_EPSILON   = 0.06;        // world units; detect meaningful movement
const MAX_TRAIL_LENGTH = 260;       // world units; slightly longer rope
const MAX_TRAIL_AGE_MS = 300;       // peer cleanup if vanished
const STILL_CLEAR_MS   = 70;        // if idle briefly, clear immediately (no lingering)

// ---------- Public API ----------

export function clearCursorTrails(): void {
  cursorTrails.clear();
  peerProfiles.clear();
}

// Optional per-peer tuning at runtime
export function setPeerTrailProfile(userId: string, partial: Partial<TrailProfile>): void {
  const base = peerProfiles.get(userId) ?? DEFAULT_TRAIL_PROFILE;
  peerProfiles.set(userId, { ...base, ...partial });
}
export function resetPeerTrailProfile(userId: string): void {
  peerProfiles.delete(userId);
}

// ---------- Utilities ----------

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Catmull–Rom cubic interpolation for Pixi-like rope sampling
function catmullRom(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * (
      (2 * p1.x) + (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
    ),
    y: 0.5 * (
      (2 * p1.y) + (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
    ),
    t: p1.t + t * (p2.t - p1.t),
  };
}

function resampleTrail(raw: Pt[], totalSamples: number): Pt[] {
  if (raw.length < 4 || totalSamples <= raw.length) return raw;
  const out: Pt[] = [];
  const segments = raw.length - 3;
  const perSeg = Math.max(1, Math.floor(totalSamples / segments));
  for (let i = 0; i < segments; i++) {
    const p0 = raw[i], p1 = raw[i + 1], p2 = raw[i + 2], p3 = raw[i + 3];
    for (let s = 0; s < perSeg; s++) {
      out.push(catmullRom(p0, p1, p2, p3, s / perSeg));
    }
  }
  out.push(raw[raw.length - 1]);
  return out;
}

// ---------- Main entry (overlay render loop) ----------

export function drawCursors(
  ctx: CanvasRenderingContext2D,
  presence: PresenceView,
  viewTransform: ViewTransform,
  gates: { awarenessReady: boolean; firstSnapshot: boolean },
): void {
  // Respect your overlay gates (unchanged contract)
  if (!gates.awarenessReady || !gates.firstSnapshot) return; // :contentReference[oaicite:3]{index=3}

  const now = Date.now();
  const peerCount = presence.users.size;
  const enableTrails = peerCount <= REDUCED_MOTION_PEER_CAP && !prefersReducedMotion();

  presence.users.forEach((user, userId) => {
    const cursor = user.cursor;
    if (!cursor) return;

    const profile = peerProfiles.get(userId) ?? DEFAULT_TRAIL_PROFILE;

    // --- Ensure per-peer trail bucket
    let trail = cursorTrails.get(userId);
    if (!trail) {
      trail = {
        points: [],
        lastUpdate: now,
        lastPushTime: 0,
        lastMovement: now,
        lastPosition: null,
        length: 0,
      };
      cursorTrails.set(userId, trail);
    }

    // Movement detection (no smoothing or snap)
    const moved =
      !trail.lastPosition ||
      Math.hypot(cursor.x - trail.lastPosition.x, cursor.y - trail.lastPosition.y) > MOVE_EPSILON;

    if (moved) {
      trail.lastMovement = now;
      trail.lastPosition = { x: cursor.x, y: cursor.y };
    } else {
      // If idle briefly, clear trail so nothing lingers
      if (now - trail.lastMovement > STILL_CLEAR_MS && trail.points.length) {
        trail.points.length = 0;
        trail.length = 0;
      }
    }

    // --- Append point with light throttling
    const last = trail.points[trail.points.length - 1];
    const dt = last ? (now - trail.lastPushTime) : Number.POSITIVE_INFINITY;
    const dx = last ? cursor.x - last.x : 0;
    const dy = last ? cursor.y - last.y : 0;
    const dist = last ? Math.hypot(dx, dy) : Number.POSITIVE_INFINITY;

    if (dist >= MIN_POINT_DIST && dt >= MIN_POINT_DT) {
      trail.points.push({ x: cursor.x, y: cursor.y, t: now });
      trail.lastPushTime = now;
      trail.length += Number.isFinite(dist) ? dist : 0;

      // cap to historySize
      while (trail.points.length > profile.historyPoints) {
        const p0 = trail.points.shift()!;
        const p1 = trail.points[0];
        if (p1) trail.length -= Math.hypot(p1.x - p0.x, p1.y - p0.y);
      }
    }

    // --- Trim by age/length (short & clean)
    while (
      trail.points.length > 1 &&
      (
        (now - trail.points[0].t) > profile.decayMs ||
        trail.length > MAX_TRAIL_LENGTH
      )
    ) {
      const p0 = trail.points.shift()!;
      const p1 = trail.points[0];
      if (p1) trail.length -= Math.hypot(p1.x - p0.x, p1.y - p0.y);
    }

    trail.lastUpdate = now;

    // --- Draw trail
    if (enableTrails && trail.points.length > 1) {
      drawTrailLaser(ctx, trail, viewTransform, user.color, profile, now);
    }

    // --- Draw cursor head + name at manager-smoothed position
    const [cx, cy] = viewTransform.worldToCanvas(cursor.x, cursor.y);
    drawCursorPointer(ctx, cx, cy, user.color);
    drawNameLabel(ctx, cx, cy, user.name, user.color);
  });

  // Cleanup for peers that vanished
  for (const [userId, trail] of cursorTrails.entries()) {
    if (!presence.users.has(userId) && (now - trail.lastUpdate) > MAX_TRAIL_AGE_MS) {
      cursorTrails.delete(userId);
      peerProfiles.delete(userId);
    }
  }
}

// ---------- Drawing (tapered constant-width rope in screen-px, subtle) ----------

function drawTrailLaser(
  ctx: CanvasRenderingContext2D,
  trail: CursorTrail,
  viewTransform: ViewTransform,
  color: string,
  profile: TrailProfile,
  now: number,
): void {
  const raw = trail.points;
  if (raw.length < 2) return;

  // Pixi-like geometry: history → cubic → evenly sampled rope points
  const pts = profile.resamplePoints > 0
    ? resampleTrail(raw, profile.resamplePoints)
    : raw;

  ctx.save();

  // Keep normal compositing for minimal distraction (no additive)
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;

  const passes: Array<{ widthMul: number; alphaMul: number }> = [
    { widthMul: profile.outerWidthMul, alphaMul: profile.outerAlpha },
    { widthMul: profile.innerWidthMul, alphaMul: profile.innerAlpha },
    { widthMul: profile.mainWidthMul,  alphaMul: profile.mainAlpha  },
  ];

  for (const pass of passes) {
    // Draw segment-by-segment so we can taper and age-fade
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];

      // 0..1 along trail, tail→head; use a mild ease for nicer distribution
      const pos = i / pts.length;
      const posEase = Math.pow(pos, 0.65);

      // Tapered width: tail→head
      const baseWidthPx = profile.tailWidthPx + (profile.headWidthPx - profile.tailWidthPx) * posEase;
      const widthPx = Math.max(0.5, baseWidthPx * pass.widthMul);

      // Ultra-short age-based fade keyed to newer point
      const age = now - b.t;
      const k = Math.max(0, Math.min(1, 1 - age / profile.decayMs));
      const alpha = k * pass.alphaMul;
      if (alpha <= 0.01) continue;

      const [ax, ay] = viewTransform.worldToCanvas(a.x, a.y);
      const [bx, by] = viewTransform.worldToCanvas(b.x, b.y);

      ctx.globalAlpha = alpha;
      ctx.lineWidth = widthPx;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ---------- Cursor glyph & label ----------

function drawCursorPointer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();

  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(x, y);            // tip
  ctx.lineTo(x - 4, y + 10);
  ctx.lineTo(x + 1, y + 7);
  ctx.lineTo(x + 6, y + 12);
  ctx.closePath();

  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function drawNameLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  name: string,
  color: string,
): void {
  ctx.save();

  const labelX = x + 8;
  const labelY = y + 14;

  ctx.font = '11px system-ui, -apple-system, sans-serif';
  const metrics = ctx.measureText(name);
  const padding = 4;
  const width = metrics.width + padding * 2;
  const height = 16;

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  // Use roundRect if available; otherwise fallback to rect
  const rr = (ctx as any).roundRect;
  if (typeof rr === 'function') {
    rr.call(ctx, labelX, labelY, width, height, height / 2);
  } else {
    ctx.beginPath();
    ctx.rect(labelX, labelY, width, height);
  }
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.globalAlpha = 1;
  ctx.fillText(name, labelX + padding, labelY + 12);

  ctx.restore();
}
