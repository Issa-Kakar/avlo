import { asRoomId, Permission, ROOM_ID_RE } from '@avlo/shared';
import { z } from 'zod/v4';

/** `PATCH /rooms/:id/permission` (§8) validators — `id` format-gated then branded. */
export const permissionParam = z.object({ id: z.string().regex(ROOM_ID_RE).transform(asRoomId) });
export const permissionBody = z.object({ permission: Permission });
