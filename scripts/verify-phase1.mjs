#!/usr/bin/env node

/**
 * Phase 1 Verification Script
 * Quick sanity checks for critical limits and configurations
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('🔍 Phase 1 Configuration Verification\n');

// Check 1: Verify hard cap is 10MB
console.log('✓ Checking 10MB hard cap...');
const yjsHooks = await readFile(join(__dirname, '../server/src/yjs-hooks.ts'), 'utf-8');
if (yjsHooks.includes('const HARD_CAP = 10 * 1024 * 1024')) {
  console.log('  ✅ 10MB hard cap correctly defined');
} else {
  console.error('  ❌ 10MB hard cap not found or incorrect');
}

// Check 2: Verify frame cap is 2MB
console.log('\n✓ Checking 2MB frame cap...');
const wsFile = await readFile(join(__dirname, '../server/src/ws.ts'), 'utf-8');
if (wsFile.includes('const MAX_FRAME = 2 * 1024 * 1024')) {
  console.log('  ✅ 2MB frame cap correctly configured');
} else {
  console.error('  ❌ 2MB frame cap not found');
}

// Check 3: Verify IP limit is 8
console.log('\n✓ Checking 8 WS per IP limit...');
if (wsFile.includes('const MAX_IP_CONNS = 8')) {
  console.log('  ✅ 8 connections per IP limit correctly configured');
} else {
  console.error('  ❌ 8 connections per IP limit not found');
}

// Check 4: Verify room capacity is 105
console.log('\n✓ Checking 105 clients per room limit...');
if (wsFile.includes('const MAX_ROOM_CONNS = 105')) {
  console.log('  ✅ 105 clients per room limit correctly configured');
} else {
  console.error('  ❌ 105 clients per room limit not found');
}

// Check 5: Verify stats cadence (5s or 100KB)
console.log('\n✓ Checking room stats cadence...');
if (
  yjsHooks.includes('const STATS_DELTA = 100 * 1024') &&
  yjsHooks.includes('now - prevAt >= 5000')
) {
  console.log('  ✅ Stats cadence correctly configured (5s or 100KB)');
} else {
  console.error('  ❌ Stats cadence configuration not found');
}

// Check 6: Verify Redis persistence with gzip level 4
console.log('\n✓ Checking Redis persistence with gzip(4)...');
if (yjsHooks.includes('gzipAsync(binary, { level: 4 })')) {
  console.log('  ✅ Redis persistence uses gzip level 4');
} else {
  console.error('  ❌ gzip level 4 not found');
}

// Check 7: Verify TTL configuration
console.log('\n✓ Checking TTL configuration...');
if (yjsHooks.includes('const TTL_SECONDS = parseInt(process.env.ROOM_TTL_DAYS')) {
  console.log('  ✅ TTL configuration correctly uses ROOM_TTL_DAYS env var');
} else {
  console.error('  ❌ TTL configuration not properly set');
}

// Check 8: Verify origin validation
console.log('\n✓ Checking origin validation...');
const originFile = await readFile(join(__dirname, '../server/src/util/origin.ts'), 'utf-8');
if (originFile.includes('export function isAllowedOrigin')) {
  console.log('  ✅ Origin validation function exists');
} else {
  console.error('  ❌ Origin validation function not found');
}

// Check 9: Verify rate limiting (10 rooms/hour/IP)
console.log('\n✓ Checking rate limiting...');
const roomsRouter = await readFile(join(__dirname, '../server/src/routes/rooms.ts'), 'utf-8');
if (roomsRouter.includes('max: 10') && roomsRouter.includes('windowMs: 60 * 60 * 1000')) {
  console.log('  ✅ Rate limiting correctly configured (10 rooms/hour/IP)');
} else {
  console.error('  ❌ Rate limiting not properly configured');
}

// Check 10: Verify @y/websocket-server import
console.log('\n✓ Checking @y/websocket-server import...');
if (wsFile.includes("from '@y/websocket-server/utils'")) {
  console.log('  ✅ Using correct @y/websocket-server/utils import');
} else {
  console.error('  ❌ Incorrect @y/websocket-server import');
}

// Check 11: Verify ambient typing exists
console.log('\n✓ Checking TypeScript ambient typing...');
try {
  const typingFile = await readFile(
    join(__dirname, '../server/src/types/y-websocket-server.d.ts'),
    'utf-8',
  );
  if (typingFile.includes("declare module '@y/websocket-server/utils'")) {
    console.log('  ✅ Ambient typing for @y/websocket-server exists');
  } else {
    console.error('  ❌ Ambient typing file exists but incorrect');
  }
} catch {
  console.error('  ❌ Ambient typing file not found');
}

// Check 12: Verify no @ts-expect-error on setPersistence
console.log('\n✓ Checking for removed @ts-expect-error...');
if (!wsFile.includes('@ts-expect-error')) {
  console.log('  ✅ No @ts-expect-error found (clean TypeScript)');
} else {
  console.error('  ❌ @ts-expect-error still present');
}

console.log('\n📋 Phase 1 Verification Complete!\n');
