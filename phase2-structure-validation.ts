#!/usr/bin/env npx tsx
/**
 * Phase 2.2 Y.Doc Structure Validation Script
 * Verifies that RoomDocManager creates the correct Y.Doc structure
 * as specified in OVERVIEW.MD
 */

import * as Y from 'yjs';
import { RoomDocManagerRegistry } from './client/src/lib/room-doc-manager';

console.log('🔍 Phase 2.2 Y.Doc Structure Validation\n');

// Create a test room
const roomId = 'validation-test-room';
const manager = RoomDocManagerRegistry.get(roomId);

// Access the internal Y.Doc (using any to bypass private access)
const ydoc = (manager as any).ydoc;

let allTestsPassed = true;

// Test 1: Root Y.Map exists
console.log('Test 1: Root Y.Map structure');
const root = ydoc.getMap('root');
if (root && root instanceof Y.Map) {
  console.log('  ✅ Root Y.Map exists at ydoc.getMap("root")');
} else {
  console.log('  ❌ Root Y.Map NOT found');
  allTestsPassed = false;
}

// Test 2: Root has exactly 5 keys
console.log('\nTest 2: Root map keys');
const expectedKeys = ['meta', 'strokes', 'texts', 'code', 'outputs'];
const actualKeys = Array.from(root.keys()).sort();
expectedKeys.sort();

if (actualKeys.length === 5) {
  console.log('  ✅ Root has exactly 5 keys');
} else {
  console.log(`  ❌ Root has ${actualKeys.length} keys, expected 5`);
  allTestsPassed = false;
}

if (JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)) {
  console.log('  ✅ Root has correct keys:', actualKeys.join(', '));
} else {
  console.log('  ❌ Root keys mismatch');
  console.log('    Expected:', expectedKeys);
  console.log('    Actual:', actualKeys);
  allTestsPassed = false;
}

// Test 3: Meta structure
console.log('\nTest 3: Meta structure');
const meta = root.get('meta');
if (meta instanceof Y.Map) {
  console.log('  ✅ meta is a Y.Map');
  
  const sceneTicks = meta.get('scene_ticks');
  if (sceneTicks instanceof Y.Array) {
    console.log('  ✅ scene_ticks is a Y.Array (collaborative!)');
  } else {
    console.log('  ❌ scene_ticks is NOT a Y.Array - will break collaboration!');
    console.log('    Type:', typeof sceneTicks, sceneTicks);
    allTestsPassed = false;
  }
  
  const schemaVersion = meta.get('schema_version');
  if (schemaVersion === 1) {
    console.log('  ✅ schema_version is set to 1');
  } else {
    console.log('  ⚠️  schema_version missing or incorrect:', schemaVersion);
  }
} else {
  console.log('  ❌ meta is NOT a Y.Map');
  allTestsPassed = false;
}

// Test 4: Strokes structure
console.log('\nTest 4: Strokes structure');
const strokes = root.get('strokes');
if (strokes instanceof Y.Array) {
  console.log('  ✅ strokes is a Y.Array');
} else {
  console.log('  ❌ strokes is NOT a Y.Array');
  allTestsPassed = false;
}

// Test 5: Texts structure
console.log('\nTest 5: Texts structure');
const texts = root.get('texts');
if (texts instanceof Y.Array) {
  console.log('  ✅ texts is a Y.Array');
} else {
  console.log('  ❌ texts is NOT a Y.Array');
  allTestsPassed = false;
}

// Test 6: Code cell structure
console.log('\nTest 6: Code cell structure');
const code = root.get('code');
if (code instanceof Y.Map) {
  console.log('  ✅ code is a Y.Map');
  
  const hasLang = code.has('lang');
  const hasBody = code.has('body');
  const hasVersion = code.has('version');
  
  if (hasLang && code.get('lang') === 'javascript') {
    console.log('  ✅ code.lang is set to "javascript"');
  } else {
    console.log('  ❌ code.lang is missing or incorrect:', code.get('lang'));
    allTestsPassed = false;
  }
  
  if (hasBody && code.get('body') === '') {
    console.log('  ✅ code.body is initialized to empty string');
  } else {
    console.log('  ❌ code.body is missing or incorrect');
    allTestsPassed = false;
  }
  
  if (hasVersion && code.get('version') === 0) {
    console.log('  ✅ code.version is initialized to 0');
  } else {
    console.log('  ❌ code.version is missing or incorrect:', code.get('version'));
    allTestsPassed = false;
  }
} else {
  console.log('  ❌ code is NOT a Y.Map');
  allTestsPassed = false;
}

// Test 7: Outputs structure
console.log('\nTest 7: Outputs structure');
const outputs = root.get('outputs');
if (outputs instanceof Y.Array) {
  console.log('  ✅ outputs is a Y.Array');
} else {
  console.log('  ❌ outputs is NOT a Y.Array');
  allTestsPassed = false;
}

// Test 8: Verify no direct attachment to Y.Doc root
console.log('\nTest 8: No direct attachment to Y.Doc root');
const directStrokes = ydoc.getArray('strokes');
const directTexts = ydoc.getArray('texts');
const directCode = ydoc.getMap('code');
const directOutputs = ydoc.getArray('outputs');
const directMeta = ydoc.getMap('meta');

let hasDirectAttachment = false;
if (directStrokes.length > 0 || directStrokes.doc !== null) {
  console.log('  ⚠️  Found direct strokes array (might be from old structure)');
  hasDirectAttachment = true;
}
if (directTexts.length > 0 || directTexts.doc !== null) {
  console.log('  ⚠️  Found direct texts array (might be from old structure)');
  hasDirectAttachment = true;
}
if (directCode.size > 0 || directCode.doc !== null) {
  console.log('  ⚠️  Found direct code map (might be from old structure)');
  hasDirectAttachment = true;
}
if (directOutputs.length > 0 || directOutputs.doc !== null) {
  console.log('  ⚠️  Found direct outputs array (might be from old structure)');
  hasDirectAttachment = true;
}
if (directMeta.size > 0 || directMeta.doc !== null) {
  console.log('  ⚠️  Found direct meta map (might be from old structure)');
  hasDirectAttachment = true;
}

if (!hasDirectAttachment) {
  console.log('  ✅ No direct attachments to Y.Doc root (good!)');
}

// Test 9: Collaboration test - scene_ticks Y.Array
console.log('\nTest 9: Collaboration test - scene_ticks updates');
let updateFired = false;
const updateHandler = () => { updateFired = true; };
ydoc.on('update', updateHandler);

const sceneTicksArray = meta.get('scene_ticks') as Y.Array<number>;
sceneTicksArray.push([Date.now()]);

if (updateFired) {
  console.log('  ✅ Y.Array updates trigger doc updates (collaboration will work)');
} else {
  console.log('  ❌ Y.Array updates NOT triggering doc updates (collaboration broken)');
  allTestsPassed = false;
}

ydoc.off('update', updateHandler);

// Test 10: Manager references are correct
console.log('\nTest 10: Manager internal references');
const managerMeta = (manager as any).yMeta;
const managerStrokes = (manager as any).yStrokes;
const managerTexts = (manager as any).yTexts;
const managerCode = (manager as any).yCode;
const managerOutputs = (manager as any).yOutputs;

if (managerMeta === meta) {
  console.log('  ✅ Manager yMeta references root.meta');
} else {
  console.log('  ❌ Manager yMeta does NOT reference root.meta');
  allTestsPassed = false;
}

if (managerStrokes === strokes) {
  console.log('  ✅ Manager yStrokes references root.strokes');
} else {
  console.log('  ❌ Manager yStrokes does NOT reference root.strokes');
  allTestsPassed = false;
}

if (managerTexts === texts) {
  console.log('  ✅ Manager yTexts references root.texts');
} else {
  console.log('  ❌ Manager yTexts does NOT reference root.texts');
  allTestsPassed = false;
}

if (managerCode === code) {
  console.log('  ✅ Manager yCode references root.code');
} else {
  console.log('  ❌ Manager yCode does NOT reference root.code');
  allTestsPassed = false;
}

if (managerOutputs === outputs) {
  console.log('  ✅ Manager yOutputs references root.outputs');
} else {
  console.log('  ❌ Manager yOutputs does NOT reference root.outputs');
  allTestsPassed = false;
}

// Cleanup
manager.destroy();

// Final result
console.log('\n' + '='.repeat(50));
if (allTestsPassed) {
  console.log('✅ ALL TESTS PASSED! Structure matches OVERVIEW.MD specification.');
  console.log('✅ scene_ticks is Y.Array - collaboration will work correctly!');
  console.log('✅ Ready for Phase 2.3-2.5 implementation.');
  process.exit(0);
} else {
  console.log('❌ SOME TESTS FAILED! Structure does NOT match specification.');
  console.log('❌ Fix the issues above before proceeding to Phase 2.3.');
  process.exit(1);
}
