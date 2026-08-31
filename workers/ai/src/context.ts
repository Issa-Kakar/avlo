import { AI_DATA_PART_CONTEXT, AI_MAX_CONTEXT_BYTES, AI_MAX_PROMPT_CHARS, CanvasContext } from '@avlo/shared';
import { convertToModelMessages, type ModelMessage, type ToolSet, type UIMessage } from 'ai';

/**
 * UIMessage history → model messages, with the canvas context inlined.
 *
 * The client ships context as a `data-canvasContext` part ON each user message
 * (persisted with the message — survives resume, keeps history append-only).
 * `convertToModelMessages` drops data parts by default; `convertDataPart`
 * turns ours into a text part IN PLACE (after the user's text, where the
 * client appends it). The rendering is deterministic — zod-parsed object,
 * fixed JSON.stringify, fixed header — so a message renders byte-identically
 * on every subsequent turn and the implicit prompt cache stays warm.
 *
 * Server-side re-validation lives here too (the client guards are UX, not
 * security): prompt length re-checked, context re-parsed against the shared
 * schema + byte-capped. Malformed/oversized context is silently dropped —
 * the turn proceeds text-only rather than failing.
 */

export class PromptTooLongError extends Error {
  constructor() {
    super('prompt too long');
  }
}

const contextType = `data-${AI_DATA_PART_CONTEXT}`;

export async function toModelMessages(messages: UIMessage[], tools: ToolSet): Promise<ModelMessage[]> {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    let chars = 0;
    for (const part of last.parts) if (part.type === 'text') chars += part.text.length;
    if (chars > AI_MAX_PROMPT_CHARS) throw new PromptTooLongError();
  }

  return convertToModelMessages(messages, {
    tools,
    ignoreIncompleteToolCalls: true,
    convertDataPart: (part) => {
      if (part.type !== contextType) return undefined; // other data parts (quota denials) never reach the model
      const parsed = CanvasContext.safeParse(part.data);
      if (!parsed.success) return undefined;
      const json = JSON.stringify(parsed.data);
      if (json.length > AI_MAX_CONTEXT_BYTES) return undefined;
      return { type: 'text', text: `[canvas context]\n${json}` };
    },
  });
}
