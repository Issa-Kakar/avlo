import { PresenceView, ViewTransform } from '@avlo/shared';

interface CursorTrail {
  points: Array<{ x: number; y: number; t: number }>;
  lastUpdate: number;
}

const cursorTrails = new Map<string, CursorTrail>();
const MAX_TRAIL_POINTS = 24;
const MAX_TRAIL_AGE = 600; // ms
const TRAIL_DECAY_RATE = 320; // ms

// Helper to check if user prefers reduced motion
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  const maxPoints = peerCount > 10 ? 12 : MAX_TRAIL_POINTS; // Reduce trail buffer size under load

  // Update trails and render cursors
  presence.users.forEach((user, userId) => {
    if (!user.cursor) {
      // No cursor, skip rendering but keep trail aging
      return;
    }

    // Update trail
    let trail = cursorTrails.get(userId);
    if (!trail) {
      trail = { points: [], lastUpdate: now };
      cursorTrails.set(userId, trail);
    }

    // Add new point if moved enough (matches cursor quantization)
    const lastPoint = trail.points[trail.points.length - 1];
    const distance = lastPoint
      ? Math.hypot(user.cursor.x - lastPoint.x, user.cursor.y - lastPoint.y)
      : Infinity;

    if (distance > 0.5) {
      // 0.5 world units threshold (same as cursor quantization)
      trail.points.push({
        x: user.cursor.x,
        y: user.cursor.y,
        t: now,
      });
      // Update lastUpdate when adding a point
      trail.lastUpdate = now;
    } else {
      // Still update lastUpdate to keep aging accurate even if not moving
      trail.lastUpdate = now;
    }

    // Trim old points (using dynamic maxPoints based on load)
    while (trail.points.length > 0) {
      if (now - trail.points[0].t > MAX_TRAIL_AGE || trail.points.length > maxPoints) {
        trail.points.shift();
      } else {
        break;
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
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Draw each segment with its own alpha for proper gradient effect
  for (let i = 1; i < trail.points.length; i++) {
    const prevPoint = trail.points[i - 1];
    const currPoint = trail.points[i];

    // Calculate alpha based on current point's age
    const age = now - currPoint.t;
    const alpha = Math.exp(-age / TRAIL_DECAY_RATE);

    if (alpha < 0.01) continue;

    // Transform both points
    const [prevX, prevY] = viewTransform.worldToCanvas(prevPoint.x, prevPoint.y);
    const [currX, currY] = viewTransform.worldToCanvas(currPoint.x, currPoint.y);

    // Draw this segment with its specific alpha
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(prevX, prevY);
    ctx.lineTo(currX, currY);
    ctx.stroke();
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
