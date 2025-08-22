#!/usr/bin/env tsx
import { RoomDocManagerRegistry } from './client/src/lib/room-doc-manager.js';

function formatMemory(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function logMemory(label: string) {
  const usage = process.memoryUsage();
  console.log(`${label}:
  - RSS: ${formatMemory(usage.rss)}
  - Heap Total: ${formatMemory(usage.heapTotal)}
  - Heap Used: ${formatMemory(usage.heapUsed)}
  - External: ${formatMemory(usage.external)}`);
}

async function testMemoryLeaks() {
  console.log('=== Memory Leak Test ===\n');

  // Initial memory
  logMemory('Initial memory');

  // Create managers
  console.log('\nCreating 100 RoomDocManagers...');
  const managers = [];
  for (let i = 0; i < 100; i++) {
    const manager = RoomDocManagerRegistry.get(`room-${i}`);
    managers.push(manager);
  }

  logMemory('After creating 100 managers');

  // Subscribe to all of them
  console.log('\nSubscribing to all managers...');
  const unsubscribes: Array<() => void> = [];
  managers.forEach((manager) => {
    const unsub1 = manager.subscribeSnapshot(() => {});
    const unsub2 = manager.subscribePresence(() => {});
    const unsub3 = manager.subscribeRoomStats(() => {});
    unsubscribes.push(unsub1, unsub2, unsub3);
  });

  logMemory('After subscribing');

  // Unsubscribe
  console.log('\nUnsubscribing...');
  unsubscribes.forEach((unsub) => unsub());

  logMemory('After unsubscribing');

  // Destroy all managers
  console.log('\nDestroying all managers...');
  RoomDocManagerRegistry.destroyAll();

  logMemory('After destroying');

  // Force garbage collection if available
  if (global.gc) {
    console.log('\nForcing garbage collection...');
    global.gc();
    await new Promise((resolve) => setTimeout(resolve, 100));
    logMemory('After GC');
  } else {
    console.log('\n(Run with --expose-gc flag to enable garbage collection)');
  }

  // Test rapid creation/destruction
  console.log('\n=== Rapid Creation/Destruction Test ===\n');
  logMemory('Before rapid test');

  for (let i = 0; i < 10; i++) {
    console.log(`Iteration ${i + 1}/10`);
    // Create 10 managers
    for (let j = 0; j < 10; j++) {
      const manager = RoomDocManagerRegistry.get(`rapid-${i}-${j}`);
      // Immediately subscribe and unsubscribe
      const unsub = manager.subscribeSnapshot(() => {});
      unsub();
    }
    // Destroy them all
    RoomDocManagerRegistry.destroyAll();
  }

  logMemory('After rapid test');

  // Final cleanup
  if (global.gc) {
    global.gc();
    await new Promise((resolve) => setTimeout(resolve, 100));
    logMemory('Final memory after GC');
  }

  console.log('\n=== Test Complete ===');
}

// Run the test
testMemoryLeaks().catch(console.error);
