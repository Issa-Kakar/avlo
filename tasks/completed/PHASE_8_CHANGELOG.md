# Phase 8 Changelog - Limits UI and Gateway Error Mapping

## Overview

Implementation of limits UI and gateway error mapping for Avlo Phase 8, providing clear size/capacity limit visibility and safe behavior at caps.

## Key Features

- **Soft warning at 8 MB**: Subtle header pill showing "X.Y / 10 MB" (no toasts)
- **Hard cap at 10 MB**: Read-only mode with banner, writing disabled, awareness continues
- **Gateway error mapping**: Specific toasts for room capacity, oversize updates, rate limits
- **Feature flag**: `LIMITS_UI_ENABLED` (default on in dev)

## Implementation Status

### Completed

- [x] Created branch `feat/phase-8-limits-ui`
- [x] Examined existing client structure
- [x] Connection chip supports 'Read-only' mode
- [x] Toast system extended with canonical gateway messages
- [x] Room stats state management (`client/src/state/roomStats.ts`)
- [x] Limits UI components (`SizePill`, `ReadonlyBanner`)
- [x] Gateway error mapping (`useGatewayErrors`)
- [x] Feature flag module (`client/src/limits/index.ts`)
- [x] UI integration in `AppHeader`, `AppShell`, and `Room`
- [x] E2E tests for Phase 8 behaviors
- [x] Added runtime flag override for tests: `window.__LIMITS_UI_ENABLED_OVERRIDE`
- [x] Added Phase 8 smoke tests that run against the dev server to avoid SW/prod build constraints

### In Progress / Optional next

- [ ] Wire `writeOperations` gate into actual commit pipeline when Phase 3 lands (current UI disables writes; gateway still enforces)
- [ ] Hook up "Create room" CTA in `ReadonlyBanner` to standard create-room flow; route HTTP 429 via `handleHttpError` for backoff toast
- [ ] Ensure gateway error mapping covers initial join failures (WS/HTTP) before provider fully initializes
- [ ] Keep `window.__LIMITS_UI_ENABLED_OVERRIDE` documented as test-only; add prod-mode e2e path or SW-disabled server variant
- [ ] Unify room stats source by centralizing `useRoomStats` subscription to provider advisories (avoid duplication with `useRoom`)
- [ ] Broaden UI gating so any future write-adjacent actions (e.g., export mutations) respect read-only beyond `aria-disabled`

## Files Created/Modified (Phase 8)

### New Files

- `client/src/state/roomStats.ts` - Room statistics state management
- `client/src/ui/limits/SizePill.tsx` - Size warning pill component
- `client/src/ui/limits/ReadonlyBanner.tsx` - Read-only banner component
- `client/src/hooks/useGatewayErrors.ts` - Gateway error mapping hook
- `client/src/limits/index.ts` - Feature exports and flag management

### Modified Files

- `client/src/app/utils/toast.ts` - Extended with gateway error toast messages
- `client/src/app/components/AppHeader.tsx` - Adds `SizePill`
- `client/src/app/components/AppShell.tsx` - Passes `roomStats`
- `client/src/app/pages/Room.tsx` - Shows `ReadonlyBanner`; passes `roomStats` to shell
- `client/src/app/hooks/useRoom.ts` - Wires WS messages for room stats and gateway errors

### New E2E

- `e2e/phase8-limits-ui.spec.ts`
- `e2e/phase8-gateway-errors.spec.ts`

## Implementation Notes

- Client-only implementation as required
- No changes to routing/providers (Phase 2 in progress)
- No changes to PWA/SW (Phase 7 complete)
- No changes to My Rooms (Phase 9 complete)
- No changes to server headers/security (Phase 10 complete)

## Testing Checklist

- [x] Soft warning at 8 MB shows pill within ≤5s, no toasts
- [x] Hard cap at 10 MB enables read-only mode with banner; awareness continues
- [x] Gateway errors show correct toast messages
- [x] Connection indicator shows 'Read-only' state
- [x] Tools disabled in read-only via `aria-disabled`

## Acceptance Criteria Status

- [x] Header pill appears at ≥80% capacity (8 MB)
- [x] Read-only banner and state at 10 MB
- [x] Room full toast at capacity
- [x] Oversize frame toast for >2 MB updates
- [x] Rate limit toast for create room 429 errors (Landing create flow)
