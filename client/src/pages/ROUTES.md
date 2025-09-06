# Avlo Routes

## Current Routes (Phase 6 to 7 Integration - Step 2 Complete)

| Path            | Component   | Description                                                   |
| --------------- | ----------- | ------------------------------------------------------------- |
| `/`             | TestHarness | Development test harness with fixed room ID ('test-room-001') |
| `/test`         | TestHarness | Alternative path to test harness                              |
| `/room/:roomId` | RoomPage    | Dynamic room page (shell ready for Phase 3 integration)       |

## Implementation Status

✅ **Step 2: Routing Setup (COMPLETE)**

- React Router DOM installed
- BrowserRouter wrapped in main.tsx
- Routes configured in App.tsx
- Test harness preserved at root path
- RoomPage shell created

## Next Steps

The routing infrastructure is ready for Phase 3: Room Page Creation, where:

- CanvasWithControls will be extracted to RoomPage
- Dynamic roomId from params will replace hardcoded 'test-room-001'
- ViewTransformProvider will wrap the room content
- Connection status and mobile banners will be integrated
