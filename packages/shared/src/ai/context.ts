import { z } from 'zod/v4';
import { AiSimpleObject } from './actions';
import { AI_CONTEXT_VIEWPORT_CAP } from './limits';

/**
 * Canvas context — what the model SEES. Serialized client-side per user turn,
 * shipped as a `data-canvasContext` part on the user message, inlined into the
 * model prompt server-side (fixed format, after the user text — the layout is
 * deterministic so history stays byte-stable for implicit prompt caching).
 *
 * Three-tier fidelity (the tldraw-agent token model):
 *   `sel`      — selection, FULL detail (the user pointed at these)
 *   `vis`      — viewport, BLURRY tier: id/kind/text-snippet/bounds only
 *   `clusters` — everything else (offscreen + viewport overflow) as
 *                proximity-cluster summaries: bounds + counts, no ids
 *
 * Keys are deliberately terse — this block is resent every turn. Coordinates
 * are integers in chat-origin space (same space the actions speak).
 */

const int = z.number().int();

/** Blurry-tier object: enough to reference (`id`) + place, nothing more. */
export const AiBlurryObject = z.object({
  id: z.string(),
  /** ObjectKind. */
  k: z.string(),
  /** Text snippet (labels/notes/text), hard-capped. */
  t: z.string().max(80).optional(),
  x: int,
  y: int,
  w: int,
  h: int,
});
export type AiBlurryObject = z.infer<typeof AiBlurryObject>;

/** Cluster summary: `n` objects, per-kind counts `k`, covering bounds. */
export const AiClusterSummary = z.object({
  n: int.positive(),
  k: z.record(z.string(), int),
  x: int,
  y: int,
  w: int,
  h: int,
});
export type AiClusterSummary = z.infer<typeof AiClusterSummary>;

export const CanvasContext = z.object({
  v: z.literal(1),
  /** Viewport bounds [x, y, w, h] in chat-origin space. */
  vp: z.tuple([int, int, int, int]),
  sel: z.array(AiSimpleObject).max(50),
  vis: z.array(AiBlurryObject).max(AI_CONTEXT_VIEWPORT_CAP),
  clusters: z.array(AiClusterSummary).max(20),
  /** Board-wide kind → count. */
  counts: z.record(z.string(), int),
  title: z.string().max(120).optional(),
});
export type CanvasContext = z.infer<typeof CanvasContext>;
