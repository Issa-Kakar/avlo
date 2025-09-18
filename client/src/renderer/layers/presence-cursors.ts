import { PresenceView, ViewTransform } from '@avlo/shared';

interface CursorTrail {
  points: Array<{ x: number; y: number; t: number }>;
  lastUpdate: number;
  lastPushTime: number;
  lastMovement: number; // tracks when cursor actually moved (for stop detection)
  lastPosition: { x: number; y: number } | null; // to detect actual movement
  length: number; // total world-distance of the polyline
}

const cursorTrails = new Map<string, CursorTrail>();

// Optimal whiteboard UX: smooth digital ink that flows naturally
const MAX_TRAIL_POINTS = 22;           // More points for ultra-smooth curves
const MAX_TRAIL_AGE = 550;             // ms, longer visibility for gesture clarity
const TRAIL_DECAY_TAU = 260;           // ms, slower fade for better visibility
const MIN_POINT_DIST = 0.35;           // world units, finer sampling for smoothness
const MIN_POINT_DT = 8;                // ms, 125Hz sampling for fluid motion
const MAX_TRAIL_LENGTH = 200;          // world units, comfortable trail length

// Natural stop behavior - no jarring transitions
const STOP_THRESHOLD = 80;             // ms of no movement = "stopped" 
const STOP_FADE_MULTIPLIER = 0.45;     // Gentle fade when stopped (55% reduction)
const MOVEMENT_EPSILON = 0.08;         // world units, sensitive movement detection

// Visual polish for professional feel
const TRAIL_LINE_WIDTH_MAX = 2.2;      // px at head, slightly thicker
const TRAIL_LINE_WIDTH_MIN = 0.4;      // px at tail, thinner taper
const FADE_POWER = 1.5;                // Gentler power curve for natural fade

// Helper to check if user prefers reduced motion
function prefersReducedMotion(): boolean {
  // Handle test environments where matchMedia may not be available or return undefined
  try {
    const result = window?.matchMedia?.('(prefers-reduced-motion: reduce)');
    return result?.matches ?? false;
  } catch {
    return false;
  }
}

// Clear all cursor trails (call on disconnect or room change)
export function clearCursorTrails(): void {
  cursorTrails.clear();
}

export function drawCursors(
  ctx: CanvasRenderingContext2D,
  presence: PresenceView,
  viewTransform: ViewTransform,
  gates: { awarenessReady: boolean; firstSnapshot: boolean },
): void {
  // Single render guard: ONLY draw when both gates are open
  // Presence intake continues always - we just don't render until both gates pass
  if (!gates.awarenessReady || !gates.firstSnapshot) {
    return;
  }

  const now = Date.now();

  // Performance optimizations based on peer count
  const peerCount = presence.users.size;
  const enableTrails = peerCount <= 25 && !prefersReducedMotion();

  // Update trails and render cursors
  presence.users.forEach((user, userId) => {
    if (!user.cursor) {
      // No cursor, skip rendering but keep trail aging
      return;
    }

    // Update trail
    let trail = cursorTrails.get(userId);
    if (!trail) {
      trail = { 
        points: [], 
        lastUpdate: now, 
        lastPushTime: 0, 
        lastMovement: now,
        lastPosition: null,
        length: 0 
      };
      cursorTrails.set(userId, trail);
    }

    // Check if cursor actually moved (for stop detection)
    const hasMoved = !trail.lastPosition || 
      Math.hypot(user.cursor.x - trail.lastPosition.x, user.cursor.y - trail.lastPosition.y) > MOVEMENT_EPSILON;
    
    if (hasMoved) {
      trail.lastMovement = now;
      trail.lastPosition = { x: user.cursor.x, y: user.cursor.y };
    }

    // --- add or skip point
    const last = trail.points[trail.points.length - 1];
    const dx = last ? (user.cursor.x - last.x) : 0;
    const dy = last ? (user.cursor.y - last.y) : 0;
    const moved = last ? Math.hypot(dx, dy) : Number.POSITIVE_INFINITY;
    const dt = last ? (now - trail.lastPushTime) : Number.POSITIVE_INFINITY;

    if (moved >= MIN_POINT_DIST && dt >= MIN_POINT_DT) {
      trail.points.push({ x: user.cursor.x, y: user.cursor.y, t: now });
      trail.lastPushTime = now;
      trail.length += Number.isFinite(moved) ? moved : 0;
    }
    // Always refresh lastUpdate for cleanup tracking
    trail.lastUpdate = now;

    // --- trim by age, count, and total length
    while (
      trail.points.length > 1 &&
      (
        (now - trail.points[0].t) > MAX_TRAIL_AGE ||
        trail.points.length > MAX_TRAIL_POINTS ||
        trail.length > MAX_TRAIL_LENGTH
      )
    ) {
      const p0 = trail.points.shift()!;
      const p1 = trail.points[0];
      if (p1) {
        trail.length -= Math.hypot(p1.x - p0.x, p1.y - p0.y);
      }
    }

    // Draw trail only if enabled (based on peer count and motion preference)
    if (enableTrails) {
      drawTrail(ctx, trail, viewTransform, user.color, now);
    }

    // Draw cursor pointer
    const [canvasX, canvasY] = viewTransform.worldToCanvas(user.cursor.x, user.cursor.y);
    drawCursorPointer(ctx, canvasX, canvasY, user.color);

    // Draw name label
    drawNameLabel(ctx, canvasX, canvasY, user.name, user.color);
  });

  // Cleanup old trails
  for (const [userId, trail] of cursorTrails.entries()) {
    if (now - trail.lastUpdate > MAX_TRAIL_AGE && !presence.users.has(userId)) {
      cursorTrails.delete(userId);
    }
  }
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  trail: CursorTrail,
  viewTransform: ViewTransform,
  color: string,
  now: number,
): void {
  if (trail.points.length < 2) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Detect if cursor has stopped moving
  const timeSinceMovement = now - trail.lastMovement;
  const isStopped = timeSinceMovement > STOP_THRESHOLD;
  
  // Apply aggressive fade multiplier when stopped
  const stopFade = isStopped ? STOP_FADE_MULTIPLIER : 1.0;

  // Three-pass rendering for ultra-smooth appearance
  const passes = [
    { widthMultiplier: 3.0, alphaMultiplier: 0.15 }, // Outer glow
    { widthMultiplier: 1.8, alphaMultiplier: 0.35 }, // Inner glow
    { widthMultiplier: 1.0, alphaMultiplier: 1.0 }   // Main stroke
  ];

  for (const pass of passes) {
    ctx.strokeStyle = color;
    
    // Draw each segment with its own alpha and width for gradient effect
    for (let i = 1; i < trail.points.length; i++) {
      const a = trail.points[i - 1];
      const b = trail.points[i];

      // Calculate normalized position in trail (0 = tail, 1 = head)
      const positionInTrail = i / trail.points.length;
      
      // Calculate age-based fade with smoother curve for visibility
      const age = now - b.t;
      const normalizedAge = Math.min(age / TRAIL_DECAY_TAU, 2.5); // cap at 2.5x tau
      const baseFade = Math.max(0, 1 - Math.pow(normalizedAge, FADE_POWER));
      
      // Position-based fade with softer curve for smoother gradient
      const positionFade = 0.3 + (0.7 * Math.pow(positionInTrail, 0.8));
      
      // Combine all fade factors
      let alpha = baseFade * stopFade * positionFade * pass.alphaMultiplier;
      
      // Skip if too faint (lower threshold for better visibility)
      if (alpha < 0.01) continue;

      // Smoother width taper for more elegant appearance
      const widthCurve = 0.5 + (0.5 * Math.pow(positionInTrail, 0.7));
      const baseWidth = TRAIL_LINE_WIDTH_MIN + 
        (TRAIL_LINE_WIDTH_MAX - TRAIL_LINE_WIDTH_MIN) * widthCurve;
      const width = baseWidth * pass.widthMultiplier;
      
      // Transform both points
      const [ax, ay] = viewTransform.worldToCanvas(a.x, a.y);
      const [bx, by] = viewTransform.worldToCanvas(b.x, b.y);

      // Draw segment with calculated alpha and width
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawCursorPointer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();

  // Draw pointer shape (triangle with tail)
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(x, y); // Tip
  ctx.lineTo(x - 4, y + 10); // Left
  ctx.lineTo(x + 1, y + 7); // Middle
  ctx.lineTo(x + 6, y + 12); // Right
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

  // Position label below and right of cursor
  const labelX = x + 8;
  const labelY = y + 14;

  // Measure text
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  const metrics = ctx.measureText(name);
  const padding = 4;
  const width = metrics.width + padding * 2;
  const height = 16;

  // Draw pill background
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, width, height, height / 2);
  ctx.fill();

  // Draw text
  ctx.fillStyle = '#FFFFFF';
  ctx.globalAlpha = 1;
  ctx.fillText(name, labelX + padding, labelY + 12);

  ctx.restore();
}
