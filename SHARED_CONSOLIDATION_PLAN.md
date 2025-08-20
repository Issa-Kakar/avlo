# Shared Code Consolidation Plan

## Executive Summary

The Avlo project currently has **two separate locations for shared code**, creating confusion and maintenance overhead. This document outlines a plan to consolidate everything into `/packages/shared/` following monorepo best practices.

## Current Problem

### Duplicate Shared Locations

```
avlo/
├── shared/                    # Location 1: Config only
│   ├── config.ts             # Configuration constants
│   ├── CONFIG_USAGE.md       # Config documentation
│   └── types/index.ts        # Placeholder (mostly empty)
│
└── packages/shared/           # Location 2: Types implementation
    └── src/
        ├── index.ts          # Type exports
        └── types/            # All Phase 2 type definitions
            ├── awareness.ts
            ├── commands.ts
            ├── room.ts
            ├── snapshot.ts
            └── ...
```

### Two Import Patterns

```typescript
// Current: Confusing dual imports
import { RoomId, Snapshot } from '@avlo/shared'; // For types
import { ROOM_CONFIG } from '@shared/config'; // For config

// After consolidation: Single, clear import
import { RoomId, Snapshot, ROOM_CONFIG } from '@avlo/shared';
```

## Why This Matters

1. **Developer Confusion**: "Which shared folder do I use?"
2. **Documentation Mismatch**: Docs say `/shared/`, code uses `/packages/shared/`
3. **Import Inconsistency**: Two different import patterns for related code
4. **Maintenance Burden**: Updates might miss one location
5. **Violates DRY**: Two places for conceptually similar code

## Migration Plan

### Step 1: Move Config to packages/shared

```bash
# Move config files
mv shared/config.ts packages/shared/src/config.ts
mv shared/config.js packages/shared/src/config.js
mv shared/CONFIG_USAGE.md packages/shared/CONFIG_USAGE.md

# Move test utilities if any
mv shared/test-utils packages/shared/src/test-utils

# Move the config test
mv shared/src/config.test.ts packages/shared/src/config.test.ts
```

### Step 2: Update packages/shared/src/index.ts

```typescript
// packages/shared/src/index.ts
// Re-export all types
export * from './types/identifiers';
export * from './types/room';
export * from './types/awareness';
export * from './types/commands';
export * from './types/snapshot';
export * from './types/device-state';
export * from './types/validation';

// NEW: Export config
export * from './config';
export {
  ROOM_CONFIG,
  STROKE_CONFIG,
  CANVAS_CONFIG,
  CODE_CONFIG,
  isRoomReadOnly,
  isRoomWarning,
  calculateAwarenessInterval,
  getDebugMode,
} from './config';
```

### Step 3: Update TypeScript Configurations

#### client/tsconfig.json

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@avlo/shared": ["../packages/shared/src/index.ts"],
      "@avlo/shared/*": ["../packages/shared/src/*"]
      // Remove: "@shared/*": ["../shared/*"]
    }
  }
}
```

#### server/tsconfig.json

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "paths": {
      "@avlo/shared": ["../packages/shared/src/index.ts"],
      "@avlo/shared/*": ["../packages/shared/src/*"]
      // Remove: "@shared/*": ["../shared/*"]
    }
  }
}
```

### Step 4: Update All Imports

#### Find all @shared imports:

```bash
# Find all files using @shared
grep -r "@shared" --include="*.ts" --include="*.tsx" --include="*.js" client/src server/src
```

#### Update each file:

```typescript
// Before
import { ROOM_CONFIG, STROKE_CONFIG } from '@shared/config';

// After
import { ROOM_CONFIG, STROKE_CONFIG } from '@avlo/shared';
```

### Step 5: Update Vite Configuration

If Vite has any alias for @shared, update it:

```typescript
// vite.config.ts
export default {
  resolve: {
    alias: {
      '@': '/src',
      '@avlo/shared': '/packages/shared/src',
      // Remove: '@shared': '/shared'
    },
  },
};
```

### Step 6: Clean Up

```bash
# Remove the old shared folder
rm -rf shared/

# Update .gitignore if needed
# Remove any shared-specific ignores
```

### Step 7: Update Documentation

#### CLAUDE.md Updates:

- Change all `/shared/config.ts` references to `/packages/shared/src/config.ts`
- Update import examples
- Update project structure diagram

#### OVERVIEW.MD Updates:

- Change shared folder references

#### CONFIG_USAGE.md Updates:

- Update all import statements in examples
- Update file path references

## Impact on Phase 2 Implementation

### What DOESN'T Change

✅ **All TypeScript types remain identical** - Already in packages/shared  
✅ **RoomDocManager works unchanged** - Just import adjustment  
✅ **All tests continue passing** - Only import paths change  
✅ **Functionality remains identical** - This is purely organizational  
✅ **All type definitions stay the same** - No logic changes

### What Changes (Minimal)

⚠️ **Import statements** - About 10-15 files need import updates  
⚠️ **Documentation** - Path references need updating  
⚠️ **TypeScript config** - Remove old path mapping

### Risk Assessment

**Risk Level: LOW**

- No functional changes
- No algorithm changes
- No data structure changes
- Only import paths change
- Easy to revert if issues

## Benefits After Migration

### Immediate Benefits

1. **Single source of truth** - One location for all shared code
2. **Cleaner imports** - Use `@avlo/shared` for everything
3. **Follows monorepo best practices** - Proper workspace package
4. **Eliminates confusion** - No more "which shared?"

### Long-term Benefits

1. **Easier onboarding** - New developers see one clear pattern
2. **Better tooling support** - IDEs understand workspace packages better
3. **Potential for versioning** - Could version the shared package if needed
4. **Cleaner dependency graph** - Clear package boundaries

## Migration Checklist

- [ ] Back up current state (git commit)
- [ ] Move config files to packages/shared/src/
- [ ] Update packages/shared/src/index.ts exports
- [ ] Update client/tsconfig.json paths
- [ ] Update server/tsconfig.json paths
- [ ] Find and update all @shared imports (~10-15 files)
- [ ] Update Vite config if needed
- [ ] Remove old /shared/ folder
- [ ] Update CLAUDE.md documentation
- [ ] Update OVERVIEW.MD documentation
- [ ] Update IMPLEMENTATION.MD references
- [ ] Run `npm run typecheck` - Verify no errors
- [ ] Run `npm run test` - Verify all tests pass
- [ ] Run `npm run lint` - Fix any linting issues
- [ ] Commit with message: "refactor: consolidate shared code into packages/shared"

## Example Import Changes

### Before Migration

```typescript
// client/src/lib/example-config-usage.ts
import {
  ROOM_CONFIG,
  STROKE_CONFIG,
  isRoomReadOnly,
  calculateAwarenessInterval,
} from '@shared/config';

import { RoomId, Snapshot } from '@avlo/shared';
```

### After Migration

```typescript
// client/src/lib/example-config-usage.ts
import {
  ROOM_CONFIG,
  STROKE_CONFIG,
  isRoomReadOnly,
  calculateAwarenessInterval,
  RoomId,
  Snapshot,
} from '@avlo/shared';
```

## Estimated Time

**Total: 30-45 minutes**

- File moves: 5 minutes
- Import updates: 15-20 minutes
- Testing: 10 minutes
- Documentation updates: 10 minutes

## Rollback Plan

If issues arise:

```bash
git checkout -- .
git clean -fd
```

Since this is purely organizational with no logic changes, rollback is simple.

## Conclusion

This consolidation is a **low-risk, high-value refactor** that:

- Aligns implementation with monorepo best practices
- Reduces confusion and cognitive load
- Makes the codebase more maintainable
- Has zero functional impact

The Phase 2 implementation remains completely valid - we're just organizing the code better. All the hard work on types, RoomDocManager, and test infrastructure continues to work perfectly.

## When to Execute

**Recommended timing**: Before starting Phase 3

Since Phase 2.1-2.2 are complete and validated, and before Phase 3 adds canvas rendering, this is the perfect time for this cleanup. It ensures Phase 3 starts with a clean, well-organized codebase.
