#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('='.repeat(70));
console.log('PHASE 2 VERIFICATION REPORT');
console.log('='.repeat(70));
console.log();

const results = {
  passed: [],
  failed: [],
  warnings: []
};

function check(name, condition, failMessage = '') {
  if (condition) {
    results.passed.push(`✓ ${name}`);
    console.log(`✓ ${name}`);
  } else {
    results.failed.push(`✗ ${name}: ${failMessage}`);
    console.error(`✗ ${name}: ${failMessage}`);
  }
}

function warn(message) {
  results.warnings.push(`⚠ ${message}`);
  console.warn(`⚠ ${message}`);
}

function fileExists(filePath) {
  return fs.existsSync(path.join(__dirname, filePath));
}

function fileContains(filePath, searchString) {
  const fullPath = path.join(__dirname, filePath);
  if (!fs.existsSync(fullPath)) return false;
  const content = fs.readFileSync(fullPath, 'utf-8');
  return content.includes(searchString);
}

console.log('1. TEMPORAL CONSISTENCY (DocManager Architecture)');
console.log('-'.repeat(50));

// Check DocManager implementation
check(
  'RoomDocManager exists',
  fileExists('client/src/collaboration/RoomDocManager.ts'),
  'Critical architecture file missing'
);

check(
  'RoomSnapshot interface exists',
  fileExists('client/src/collaboration/RoomSnapshot.ts'),
  'Snapshot interface missing'
);

check(
  'DocManager implements singleton pattern',
  fileContains('client/src/collaboration/RoomDocManager.ts', 'private static instances = new Map'),
  'Singleton pattern not implemented'
);

check(
  'DocManager publishes immutable snapshots',
  fileContains('client/src/collaboration/RoomDocManager.ts', 'Object.freeze'),
  'Snapshots may not be immutable'
);

check(
  'Snapshot batching via requestAnimationFrame',
  fileContains('client/src/collaboration/RoomDocManager.ts', 'requestAnimationFrame'),
  '60 FPS batching not implemented'
);

console.log();
console.log('2. CLEAN ARCHITECTURE BOUNDARIES');
console.log('-'.repeat(50));

// Check hooks
check(
  'useRoomSnapshot hook exists',
  fileExists('client/src/collaboration/hooks/useRoomSnapshot.ts'),
  'Snapshot hook missing'
);

check(
  'useRoomOperations hook exists',
  fileExists('client/src/collaboration/hooks/useRoomOperations.ts'),
  'Operations hook missing'
);

check(
  'useRoomCompat compatibility layer exists',
  fileExists('client/src/collaboration/hooks/useRoomCompat.ts'),
  'Compatibility layer missing'
);

// Check for contamination
const uiFiles = [
  'client/src/app/pages/Room.tsx',
  'client/src/app/components/RemoteCursors.tsx'
];

let hasContamination = false;
for (const file of uiFiles) {
  if (fileExists(file)) {
    const content = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    if (content.includes('import * as Y from') || content.includes('new Y.Doc')) {
      hasContamination = true;
      check(
        `${file} - No direct Yjs imports`,
        false,
        'UI component has direct Yjs access'
      );
    }
  }
}

if (!hasContamination) {
  check('UI components have no direct Yjs imports', true);
}

console.log();
console.log('3. ROUTING & NAVIGATION');
console.log('-'.repeat(50));

check(
  'Landing page route configured',
  fileContains('client/src/main.tsx', 'path: "/"') || 
  fileContains('client/src/App.tsx', 'path: "/"'),
  'Landing route not configured'
);

check(
  'Room route configured (/rooms/:id)',
  fileContains('client/src/main.tsx', 'path: "/rooms/:id"') ||
  fileContains('client/src/App.tsx', 'path: "/rooms/:id"'),
  'Room route not configured'
);

console.log();
console.log('4. OFFLINE-FIRST (y-indexeddb)');
console.log('-'.repeat(50));

check(
  'IndexedDB provider configured',
  fileContains('client/src/collaboration/RoomDocManager.ts', 'IndexeddbPersistence'),
  'y-indexeddb not configured'
);

check(
  'IndexedDB attached per room',
  fileContains('client/src/collaboration/RoomDocManager.ts', 'new IndexeddbPersistence(roomId'),
  'IndexedDB not room-scoped'
);

console.log();
console.log('5. CONNECTION STATES');
console.log('-'.repeat(50));

check(
  'Connection state types defined',
  fileContains('client/src/collaboration/RoomSnapshot.ts', "'connecting' | 'connected' | 'disconnected' | 'reconnecting'"),
  'Connection states not properly typed'
);

check(
  'Connection state hook exists',
  fileExists('client/src/app/state/connection.ts'),
  'Connection state management missing'
);

console.log();
console.log('6. PRESENCE SYSTEM');
console.log('-'.repeat(50));

check(
  'UserPresence interface defined',
  fileContains('client/src/collaboration/RoomSnapshot.ts', 'interface UserPresence'),
  'Presence interface missing'
);

check(
  'Presence includes cursor tracking',
  fileContains('client/src/collaboration/RoomSnapshot.ts', 'cursor: { x: number; y: number }'),
  'Cursor tracking not in presence'
);

check(
  'RemoteCursors component exists',
  fileExists('client/src/app/components/RemoteCursors.tsx'),
  'RemoteCursors component missing'
);

console.log();
console.log('7. MOBILE VIEW-ONLY GATING');
console.log('-'.repeat(50));

check(
  'Mobile detection utility exists',
  fileExists('client/src/app/utils/device.ts'),
  'Device detection missing'
);

check(
  'Capability-based detection (no UA sniffing)',
  fileContains('client/src/app/utils/device.ts', 'pointer: coarse') ||
  fileContains('client/src/app/utils/device.ts', 'matchMedia'),
  'Not using capability detection'
);

console.log();
console.log('8. UI COMPONENTS');
console.log('-'.repeat(50));

check(
  'Split pane component exists',
  fileExists('client/src/app/components/SplitPane.tsx'),
  'SplitPane component missing'
);

check(
  'ConnectionChip component exists',
  fileExists('client/src/app/components/ConnectionChip.tsx'),
  'ConnectionChip component missing'
);

check(
  'UsersList component exists',
  fileExists('client/src/app/components/UsersList.tsx'),
  'UsersList component missing'
);

check(
  'Toast component exists',
  fileExists('client/src/app/components/Toast.tsx'),
  'Toast component missing'
);

console.log();
console.log('9. WRITE OPERATIONS & GATING');
console.log('-'.repeat(50));

check(
  'Write operations gating exists',
  fileExists('client/src/state/writeOperations.ts') || 
  fileExists('client/src/app/state/writeOperations.ts'),
  'Write operations gating missing'
);

check(
  'ReadOnlyGate implemented',
  fileContains('client/src/state/writeOperations.ts', 'ReadOnlyGate') ||
  fileContains('client/src/app/state/writeOperations.ts', 'ReadOnlyGate'),
  'Read-only gating not implemented'
);

check(
  'MobileViewOnlyGate implemented',
  fileContains('client/src/state/writeOperations.ts', 'MobileViewOnlyGate') ||
  fileContains('client/src/app/state/writeOperations.ts', 'MobileViewOnlyGate'),
  'Mobile view-only gating not implemented'
);

console.log();
console.log('10. SERVER INTEGRATION');
console.log('-'.repeat(50));

check(
  'WebSocket server configured',
  fileExists('server/src/ws.ts'),
  'WebSocket server missing'
);

check(
  'Redis persistence hooks',
  fileExists('server/src/yjs-hooks.ts'),
  'Redis persistence hooks missing'
);

check(
  'Room API routes',
  fileExists('server/src/routes/rooms.ts'),
  'Room API routes missing'
);

console.log();
console.log('11. ACCESSIBILITY');
console.log('-'.repeat(50));

// Check for accessibility features in key components
const hasA11y = fileContains('client/src/app/components/Modal.tsx', 'aria-') ||
                fileContains('client/src/app/components/Modal.tsx', 'role=');

check(
  'Modal has ARIA attributes',
  hasA11y,
  'Modal lacks accessibility attributes'
);

console.log();
console.log('12. NORMATIVE UI STRINGS');
console.log('-'.repeat(50));

check(
  'Copy link toast text correct',
  fileContains('client/src/app/pages/Room.tsx', 'Link copied') ||
  fileContains('client/src/app/components/Toast.tsx', 'Link copied'),
  'Incorrect copy link message'
);

console.log();
console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log();
console.log(`✓ Passed: ${results.passed.length}`);
console.log(`✗ Failed: ${results.failed.length}`);
if (results.warnings.length > 0) {
  console.log(`⚠ Warnings: ${results.warnings.length}`);
}

console.log();
if (results.failed.length === 0) {
  console.log('✅ Phase 2 implementation VERIFIED - All checks passed!');
} else {
  console.log('❌ Phase 2 has issues that need attention:');
  console.log();
  results.failed.forEach(failure => console.log(`  ${failure}`));
}

if (results.warnings.length > 0) {
  console.log();
  console.log('Warnings:');
  results.warnings.forEach(warning => console.log(`  ${warning}`));
}

console.log();
console.log('='.repeat(70));

// Exit with appropriate code
process.exit(results.failed.length === 0 ? 0 : 1);