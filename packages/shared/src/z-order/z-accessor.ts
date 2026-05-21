import type * as Y from 'yjs';
import type { ZKey } from './z-keys';

export const getZ = (y: Y.Map<unknown>): ZKey | undefined => y.get('z') as ZKey | undefined;
