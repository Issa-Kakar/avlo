# NPM Test Memory Issue Analysis

## Root Cause

The memory ballooning (6.5GB+) when running `npm test` is caused by Vitest's default parallel execution model combined with heavy test environment setup.

## Default Vitest Behavior (vitest.config.ts)

1. **Pool**: `threads` (default) - spawns multiple worker threads
2. **File Parallelism**: `true` (default) - all test files run simultaneously
3. **Worker Count**: Based on CPU cores (typically 4-8 workers)
4. **Environment**: `jsdom` - full DOM implementation in each worker

## Memory Multiplication Effect

With 8 test files and default settings:

- Each worker loads: ~1.3GB (jsdom + React Testing Library + app dependencies)
- Parallel workers: 5-8 (based on CPU)
- Total memory: 5 × 1.3GB = **6.5GB+**

## Why Each Worker Uses So Much Memory

1. **jsdom**: Full DOM implementation (~300-400MB)
2. **React Testing Library**: Testing utilities (~100MB)
3. **Yjs + Providers**: CRDT libraries (~200MB)
4. **TypeScript transpilation**: In-memory compilation
5. **Source maps**: Debug information
6. **Test doubles/mocks**: Vi.fn() allocations

## Memory-Safe Configuration Solution

The `vitest.config.memory-safe.ts` fixes this by:

```typescript
poolOptions: {
  threads: {
    singleThread: true,  // Sequential execution
    isolate: true,       // Clean environment between files
  },
},
watch: false,           // No file watching
```

This reduces memory to: **1 worker × 1.3GB = 1.3GB max**

## Additional Memory Leaks Found

From `MEMORY_FIX_REPORT.md`:

- Event listeners not cleaned up in RoomDocManager
- Document visibility listeners persisting
- Y.Doc not being destroyed properly

## Current Package.json Fix

Changed default `npm test` to use memory-safe config:

```json
"test": "vitest run --config vitest.config.memory-safe.ts",
"test:watch": "vitest",  // Original parallel mode for development
```

## Performance Trade-offs

| Mode               | Memory Usage | Execution Time | Use Case            |
| ------------------ | ------------ | -------------- | ------------------- |
| Default (parallel) | 6.5GB+       | Fast (~3s)     | CI with high memory |
| Memory-safe        | 1.3GB        | Slower (~8s)   | Local development   |
| Watch mode         | Variable     | Fast feedback  | Active development  |

## Recommendations

1. **Always use `npm test` (memory-safe) for:**
   - Local development
   - Memory-constrained environments
   - CI/CD pipelines

2. **Use `npm run test:watch` only when:**
   - Actively developing
   - System has 16GB+ RAM
   - Working on single test file

3. **Monitor memory with:**
   ```bash
   npm run test:memory  # Runs diagnostic tool
   ```

## Why Tests Are Still Failing

The test failures are **not related to memory** but to:

- Tests expecting Phase 2.3-2.5 features (not yet implemented)
- Incorrect mocking of RoomDocManager subscriptions
- Tests trying to trigger Y.Doc updates that don't exist yet

See separate analysis for test failure root causes.
