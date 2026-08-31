import { asRoomId, normalizeRoomTitle, PERMISSIONS, ROOM_ID_RE, ROOM_TITLE_MAX_LEN } from '@avlo/shared';
import { z } from 'zod/v4';

/** `/rooms/:id/*` PATCH validators (§8) — `id` format-gated then branded. */
export const roomIdParam = z.object({ id: z.string().regex(ROOM_ID_RE).transform(asRoomId) });

export const permissionBody = z.object({ permission: z.enum(PERMISSIONS) });

/** Raw length bounded BEFORE normalize (H1-adjacent belt), then the shared rule —
 *  whitespace-collapse + trim; empty or over-max rejects with a single custom issue. */
export const titleBody = z.object({
  title: z
    .string()
    .max(4 * ROOM_TITLE_MAX_LEN)
    .transform((v, ctx) => {
      const t = normalizeRoomTitle(v);
      if (t === null) {
        ctx.addIssue({ code: 'custom', message: 'invalid title' });
        return z.NEVER;
      }
      return t;
    }),
});
