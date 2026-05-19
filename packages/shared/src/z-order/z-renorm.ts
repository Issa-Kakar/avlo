import { generateNKeysBetween } from 'fractional-indexing';
import type * as Y from 'yjs';
import type { YObjects } from '../types/y-doc';
import { getZ } from './z-accessor';
import { isZKey, type ZKey } from './z-keys';

/** O(N) — used both client and server to decide whether to renorm. */
export function maxZLength(doc: Y.Doc): number {
  const objects = doc.getMap('objects') as YObjects;
  let max = 0;
  for (const yObj of objects.values()) {
    const z = getZ(yObj);
    if (z && z.length > max) max = z.length;
  }
  return max;
}

/**
 * Rewrite every object's z to a fresh sequence of evenly-spaced base-62 keys.
 *
 * Caller MUST wrap in `doc.transact(fn, Z_RENORM_ORIGIN)` so client UndoManagers
 * (configured with trackedOrigins = {userId, ySyncPluginKey}) ignore this update.
 */
export function renormalizeZ(doc: Y.Doc): number {
  const objects = doc.getMap('objects') as YObjects;
  const entries: { y: Y.Map<unknown>; z: ZKey }[] = [];
  for (const yObj of objects.values()) {
    const z = getZ(yObj);
    if (!isZKey(z)) continue; // skip unmigrated entries; renorm only touches valid keys
    entries.push({ y: yObj, z });
  }
  entries.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));
  const keys = generateNKeysBetween(null, null, entries.length);
  for (let i = 0; i < entries.length; i++) entries[i].y.set('z', keys[i]);
  return entries.length;
}
