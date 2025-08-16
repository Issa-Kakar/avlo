// Test exports for E2E testing - exposes Phase 9 functionality to window object
import { roomsStore, aliasStore } from './idb';
import { resolveAlias, setAlias } from './alias';
import { upsertVisit, handlePublish, listRooms, removeFromList, deleteLocalCopy } from './store';

// Expose Phase 9 functionality for E2E testing
declare global {
  interface Window {
    avloPhase9: {
      roomsStore: typeof roomsStore;
      aliasStore: typeof aliasStore;
      resolveAlias: typeof resolveAlias;
      setAlias: typeof setAlias;
      upsertVisit: typeof upsertVisit;
      handlePublish: typeof handlePublish;
      listRooms: typeof listRooms;
      removeFromList: typeof removeFromList;
      deleteLocalCopy: typeof deleteLocalCopy;
    };
  }
}

if (typeof window !== 'undefined') {
  console.warn('Setting up Phase 9 test exports on window object');
  window.avloPhase9 = {
    roomsStore,
    aliasStore,
    resolveAlias,
    setAlias,
    upsertVisit,
    handlePublish,
    listRooms,
    removeFromList,
    deleteLocalCopy,
  };
  console.warn('Phase 9 test exports attached to window.avloPhase9:', window.avloPhase9);
}