import { generateKeyBetween as gkbJittered, generateNKeysBetween as gnkbJittered } from 'jittered-fractional-indexing';
import { Z_KEY_JITTER_BITS } from './constants';

declare const ZKeyBrand: unique symbol;
/** Opaque fractional-indexing z-key. Lex-compare for ordering. Never construct by hand. */
export type ZKey = string & { readonly [ZKeyBrand]: undefined };

const opts = { jitterBits: Z_KEY_JITTER_BITS } as const;

const asZKey = (s: string): ZKey => s as ZKey;

export const isZKey = (v: unknown): v is ZKey => typeof v === 'string' && v.length > 0 && v.length < 256;

/** Generate a z greater than every existing z (`maxZ === null` for empty doc). */
export const generateZAtTop = (maxZ: ZKey | null): ZKey => asZKey(gkbJittered(maxZ, null, opts));

/** Generate a z less than every existing z. */
export const generateZAtBottom = (minZ: ZKey | null): ZKey => asZKey(gkbJittered(null, minZ, opts));

/** Generate a z strictly between two existing zs (a < b). Throws on a >= b. */
export const generateZBetween = (a: ZKey | null, b: ZKey | null): ZKey => asZKey(gkbJittered(a, b, opts));

/** Generate n ascending zs above maxZ. */
export const generateNZAtTop = (maxZ: ZKey | null, n: number): ZKey[] => gnkbJittered(maxZ, null, n, opts).map(asZKey);

/** Generate n ascending zs below minZ. */
export const generateNZAtBottom = (minZ: ZKey | null, n: number): ZKey[] => gnkbJittered(null, minZ, n, opts).map(asZKey);

/** Generate n ascending zs strictly between a and b. */
export const generateNZBetween = (a: ZKey | null, b: ZKey | null, n: number): ZKey[] => gnkbJittered(a, b, n, opts).map(asZKey);
