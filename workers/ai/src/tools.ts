import {
  AI_TOOL_CANVAS,
  AI_TOOL_CANVAS_READ,
  AI_TOOL_GENERATE_IMAGE,
  CanvasReadInput,
  CanvasToolInput,
  type GenerateImageInput,
  GenerateImageInput as GenerateImageInputSchema,
} from '@avlo/shared';
import { type ToolSet, tool } from 'ai';

/**
 * The model-visible tool vocabulary. Two rules hold everywhere:
 *
 *  1. `canvas` and `canvas_read` have NO `execute` — they surface in the
 *     browser via `useAgentChat`'s `onToolCall`, where the client validates
 *     (same shared Zod), remaps short-ids, and applies to the Y.Doc. The
 *     worker never touches a doc.
 *  2. Server-executed tools receive validated input plus whatever narrow port
 *     the agent hands them — NEVER the request, env, or headers. The LLM has
 *     no path to ambient authority.
 *
 * Descriptions are byte-stable (part of the cached prompt prefix). The tool
 * SET varies only by deploy-time config (images on/off) — never per request.
 */

export interface ImageGenResult {
  assetId: string;
  width: number;
  height: number;
  mimeType: string;
}

/** Narrow capability port for generate_image — quota + generation, nothing else. */
export interface ImageGenPort {
  enabled: boolean;
  generate(input: GenerateImageInput): Promise<ImageGenResult | { error: string }>;
}

const canvasTool = tool({
  description:
    'Apply a batch of actions to the whiteboard (create/update/move/label/delete). Batch all related actions into one call. Returns per-action results; actions referencing unknown ids are dropped.',
  inputSchema: CanvasToolInput,
  // no execute — client-side
});

const canvasReadTool = tool({
  description:
    'Read fresh canvas state: area "viewport" (default), "selection", or "all"; detail "blurry" (bounds + text snippets) or "full". Optionally pass specific ids. Use before acting when context is missing or stale.',
  inputSchema: CanvasReadInput,
  // no execute — client-side
});

export function makeTools(image: ImageGenPort): ToolSet {
  const tools: ToolSet = {
    [AI_TOOL_CANVAS]: canvasTool,
    [AI_TOOL_CANVAS_READ]: canvasReadTool,
  };
  if (image.enabled) {
    tools[AI_TOOL_GENERATE_IMAGE] = tool({
      description:
        'Generate an image from a text prompt. Returns an assetId you can place on the canvas with a create action of kind "image". Counts against a small daily budget.',
      inputSchema: GenerateImageInputSchema,
      execute: (input) => image.generate(input),
    });
  }
  return tools;
}
