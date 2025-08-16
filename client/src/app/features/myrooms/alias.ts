import { aliasStore } from './idb';

export async function resolveAlias(id: string): Promise<string> {
  // If it's a local provisional id, try to map to server id
  if (id.startsWith('local-')) {
    const mapped = await aliasStore.get(id);
    if (mapped) return mapped;
  }
  return id;
}

// Save mapping after publish
export async function setAlias(provisionalId: string, serverId: string) {
  if (provisionalId.startsWith('local-') && provisionalId !== serverId) {
    await aliasStore.set(provisionalId, serverId);
  }
}