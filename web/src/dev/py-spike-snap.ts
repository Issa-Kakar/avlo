/**
 * P0-B spike — snapshot container parsing shared by supervisor + executor.
 *
 * Container layout (fork src/js/snapshot.ts, upstream + patch 0007):
 *   u32[0] magic 0x706e7300 ("\x00snp")
 *   u32[1] payload offset (16-byte aligned; heap bytes start here)
 *   u32[2] JSON config length (UTF-8 bytes)
 *   u32[3] padding
 *   bytes [16, 48)  BUILD_ID (8 × u32)
 *   bytes [48, 48+jsonLen)  SnapshotConfig JSON — avlo meta v1 lives here
 *   bytes [payloadOffset, …)  raw heap image
 */

export interface AvloDsoInfo {
  loadOrder: string[];
  soMemoryBases: Record<string, number>;
  soTableBases: Record<string, number>;
}

export interface AvloSnapshotMeta {
  version: 1;
  snapshotType: 'baseline' | 'stacked';
  dso: AvloDsoInfo;
  dsoHandles: Record<string, { handles: number[] }>;
  heapSize: number;
}

export interface ParsedSnapshot {
  payloadOffset: number;
  jsonLength: number;
  buildId: string;
  avlo: AvloSnapshotMeta | undefined;
}

const SNAPSHOT_MAGIC = 0x706e7300;
const HEADER_SIZE = 48;

export function parseSnapshotHeader(bytes: Uint8Array): ParsedSnapshot {
  const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, HEADER_SIZE / 4);
  if (u32[0] !== SNAPSHOT_MAGIC) {
    throw new Error(`bad snapshot magic 0x${u32[0].toString(16)}`);
  }
  const payloadOffset = u32[1];
  const jsonLength = u32[2];
  const buildId = Array.from(u32.subarray(4, 12), (n) => n.toString(16).padStart(8, '0')).join('');
  const json = new TextDecoder().decode(bytes.subarray(HEADER_SIZE, HEADER_SIZE + jsonLength));
  const config = JSON.parse(json) as { avlo?: AvloSnapshotMeta };
  return { payloadOffset, jsonLength, buildId, avlo: config.avlo };
}

/** Serialized MEMFS site-packages tree — rebuilt byte-identically on restore. */
export interface FsTree {
  root: string;
  /** Parent-first (walk order), so plain sequential mkdir works. */
  dirs: string[];
  files: Array<{ path: string; mtimeMs: number; bytes: ArrayBuffer }>;
}

export function treeTransferables(tree: FsTree): ArrayBuffer[] {
  return tree.files.map((f) => f.bytes);
}

export function copyTree(tree: FsTree): FsTree {
  return {
    root: tree.root,
    dirs: [...tree.dirs],
    files: tree.files.map((f) => ({
      path: f.path,
      mtimeMs: f.mtimeMs,
      bytes: f.bytes.slice(0),
    })),
  };
}
