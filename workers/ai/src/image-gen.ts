import type { GenerateImageInput } from '@avlo/shared';
import { sha256Hex } from '@avlo/worker-shared';
import type { AiWorkerEnv } from './env';
import { IMAGE_MODEL_WORKERS_AI } from './providers';
import type { ImageGenResult } from './tools';

/**
 * FLUX (Workers AI) → content-addressed write into the SHARED assets bucket —
 * the exact key scheme the images worker serves (`GET /:key`, bare 64-hex;
 * unfurl is the direct-shared-bucket-write precedent, H8 satisfied by the
 * `IMAGES` binding). The returned assetId is the client's capability to place
 * the image (`create` kind:"image" accepts only assetIds granted by a tool
 * result in this conversation).
 *
 * Registered only when `AI_IMAGES_ENABLED=1` (see tools.ts) — flux-1-schnell
 * emits 1024² JPEG today; verify dims/mime when enabling for real, and swap
 * the model for `gemini-3.1-flash-image` via the registry when that lane opens.
 */

const FLUX_STEPS = 6; // ≤ 8; quality/latency middle ground

export async function generateImage(env: AiWorkerEnv, input: GenerateImageInput): Promise<ImageGenResult | { error: string }> {
  let base64: string;
  try {
    const out = (await env.AI.run(
      // biome-ignore lint/suspicious/noExplicitAny: Workers AI model ids are a huge string union; the registry constant is the source of truth
      IMAGE_MODEL_WORKERS_AI as any,
      { prompt: input.prompt, steps: FLUX_STEPS },
    )) as { image?: string };
    if (!out.image) return { error: 'image generation returned no data' };
    base64 = out.image;
  } catch {
    return { error: 'image generation failed' };
  }

  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const assetId = await sha256Hex(bytes.buffer as ArrayBuffer);
  await env.IMAGES.put(assetId, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return { assetId, width: 1024, height: 1024, mimeType: 'image/jpeg' };
}
