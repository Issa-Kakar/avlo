import { z } from 'zod/v4';

/**
 * The `canvas` tool wire schema — the ONLY shape in which the model mutates a
 * board. One tool call = `{ actions: AiAction[] }`, a small discriminated
 * union (tldraw-agent-proven): cheap to stream, trivial to validate, and each
 * action renders as one row in the panel via its `intent` string.
 *
 * Conventions (mirrored in the system prompt + the client executor):
 * - Ids are SHORT ids (`s1`, `s2`, …) — never ULIDs. Existing objects get
 *   short ids from the context serializer; the model mints NEW short ids for
 *   its creations and the client maps them to real ULIDs. An action that
 *   references an unknown id is DROPPED (reported in the tool result), never
 *   guessed at.
 * - Coordinates are INTEGERS in per-conversation chat-origin space (small,
 *   stable numbers across a whole conversation — the client owns the offset).
 * - Colors are `#rrggbb` hex (the palette is suggested in the prompt).
 *
 * The server validates tool INPUT via this schema (AI SDK inputSchema); the
 * client re-parses before touching the Y.Doc — model output is untrusted at
 * every boundary.
 */

/** Short-id: existing (serializer-assigned) AND model-minted object handles. */
export const AI_SHORT_ID_RE = /^s\d{1,5}$/;

const sid = z.string().regex(AI_SHORT_ID_RE);
const int = z.number().int();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const intent = z.string().max(200).optional();

/** Stored `shapeType` values (`tools/types.ts` `ShapeType`), minus `line` (v1). */
export const AiShapeVariant = z.enum(['rect', 'ellipse', 'diamond', 'roundedRect', 'triangle']);
export type AiShapeVariant = z.infer<typeof AiShapeVariant>;

const AiShapeObject = z.object({
  id: sid,
  kind: z.literal('shape'),
  shape: AiShapeVariant,
  x: int,
  y: int,
  w: int.positive(),
  h: int.positive(),
  color: hexColor.optional(),
  fill: hexColor.optional(),
  text: z.string().max(2_000).optional(),
});

const AiTextObject = z.object({
  id: sid,
  kind: z.literal('text'),
  x: int,
  y: int,
  text: z.string().max(10_000),
  size: int.min(8).max(200).optional(),
  color: hexColor.optional(),
});

const AiNoteObject = z.object({
  id: sid,
  kind: z.literal('note'),
  x: int,
  y: int,
  text: z.string().max(2_000),
  fill: hexColor.optional(),
});

/**
 * Connector: anchor to shapes by short-id (`fromId`/`toId` — preferred; the
 * client resolves edge anchors) and/or free endpoints. Each end needs an
 * anchor OR a point; the executor drops underspecified ends.
 */
const AiConnectorObject = z.object({
  id: sid,
  kind: z.literal('connector'),
  fromId: sid.optional(),
  toId: sid.optional(),
  x1: int.optional(),
  y1: int.optional(),
  x2: int.optional(),
  y2: int.optional(),
  startCap: z.enum(['none', 'arrow']).optional(),
  endCap: z.enum(['none', 'arrow']).optional(),
  color: hexColor.optional(),
});

/**
 * Image placement — `assetId` must have been GRANTED by a prior
 * `generate_image` tool result in this conversation; the executor rejects
 * anything else (the model can't conjure references into the asset store).
 */
const AiImageObject = z.object({
  id: sid,
  kind: z.literal('image'),
  x: int,
  y: int,
  w: int.positive(),
  h: int.positive(),
  assetId: z.string().max(64),
});

export const AiSimpleObject = z.discriminatedUnion('kind', [AiShapeObject, AiTextObject, AiNoteObject, AiConnectorObject, AiImageObject]);
export type AiSimpleObject = z.infer<typeof AiSimpleObject>;

/** Flat prop patch for `update` — every field optional, whitelist-executed. */
export const AiUpdatableProps = z.object({
  x: int.optional(),
  y: int.optional(),
  w: int.positive().optional(),
  h: int.positive().optional(),
  color: hexColor.optional(),
  fill: hexColor.optional(),
  text: z.string().max(10_000).optional(),
});
export type AiUpdatableProps = z.infer<typeof AiUpdatableProps>;

/**
 * The action union. v1 executes create/update/delete/move/label; the
 * `.loose()` placeholders parse (so a model that emits them degrades
 * gracefully) and the executor answers `{ status: 'unsupported' }` — the
 * model is told to fall back to primitive actions.
 */
export const AiAction = z.discriminatedUnion('_type', [
  z.object({ _type: z.literal('create'), intent, object: AiSimpleObject }),
  z.object({ _type: z.literal('update'), intent, id: sid, props: AiUpdatableProps }),
  z.object({ _type: z.literal('delete'), intent, ids: z.array(sid).min(1).max(100) }),
  z.object({ _type: z.literal('move'), intent, id: sid, x: int, y: int }),
  z.object({ _type: z.literal('label'), intent, id: sid, text: z.string().max(2_000) }),
  // Designed-for, not yet executable (see docs/ai/protocol.md):
  z.looseObject({ _type: z.literal('place'), intent }),
  z.looseObject({ _type: z.literal('align'), intent }),
  z.looseObject({ _type: z.literal('stack'), intent }),
  z.looseObject({ _type: z.literal('distribute'), intent }),
  z.looseObject({ _type: z.literal('create_diagram'), intent }),
  z.looseObject({ _type: z.literal('pen'), intent }),
]);
export type AiAction = z.infer<typeof AiAction>;

/** `canvas` tool input. */
export const CanvasToolInput = z.object({ actions: z.array(AiAction).min(1).max(50) });
export type CanvasToolInput = z.infer<typeof CanvasToolInput>;

/** `canvas_read` tool input — on-demand context refresh (the agent's eyes). */
export const CanvasReadInput = z.object({
  area: z.enum(['viewport', 'selection', 'all']).default('viewport'),
  detail: z.enum(['blurry', 'full']).default('blurry'),
  ids: z.array(sid).max(50).optional(),
});
export type CanvasReadInput = z.infer<typeof CanvasReadInput>;

/** `generate_image` tool input (server-executed; stubbed in v1). */
export const GenerateImageInput = z.object({
  prompt: z.string().min(1).max(2_000),
  aspect: z.enum(['square', 'wide', 'tall']).default('square'),
});
export type GenerateImageInput = z.infer<typeof GenerateImageInput>;

/** Per-action execution outcome, summarized back to the model as tool output. */
export interface AiActionResult {
  /** Index into the submitted actions array. */
  i: number;
  status: 'ok' | 'dropped' | 'unsupported';
  /** Short-id of a created object (echoes the model's minted id). */
  id?: string;
  /** Human/model-readable reason for dropped/unsupported. */
  reason?: string;
}
