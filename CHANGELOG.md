# CHANGELOG

## Phase 2: Client Foundation (Steps 8-12) - 2025-01-15

### Completed

✅ **Step 8: Room Page Migration**

- Migrated Avlo-Whiteboard HTML to React component
- Integrated header, split view, tool rail, editor, console
- All advanced controls are presentational only (per Phase 2 scope)
- Added proper ARIA attributes and accessibility features

✅ **Step 9: SplitPane Implementation**

- Created draggable 70/30 split pane with resizer
- Keyboard accessible (Arrow keys + Escape)
- Persists ratio to localStorage
- Added data-testid="split-resizer"

✅ **Step 10: Device Capability Gate**

- Implemented mobile view-only detection
- Uses pointer: coarse and width <= 820px checks
- Disables write tools on mobile devices
- No UA sniffing (capability-based detection)

✅ **Step 11: Yjs Providers & Room Hook**

- Created yjsClient provider with Y.Doc({ guid: roomId })
- Integrated y-websocket and y-indexeddb providers
- Room validation with regex pattern
- Proper teardown on unmount (keeps IndexedDB)
- Connection state management

✅ **Step 12: Presence (Awareness) System**

- Random name/color generation (adjective+animal)
- Real-time cursor tracking (throttled to ~30Hz)
- User avatar stack with overflow handling
- Users modal with focus trap
- Activity states (idle, drawing, typing)

### Technical Implementation

- WebSocket URL built from window.location (no hardcoding)
- Full jitter exponential backoff for reconnection
- IndexedDB persistence per room (never deleted)
- Connection states: Online, Reconnecting, Offline, Read-only
- Normative toast: "Link copied." on copy link action

### Files Created

- client/src/app/utils/device.ts
- client/src/app/components/SplitPane.tsx
- client/src/app/components/ConnectionChip.tsx
- client/src/app/components/CopyLinkButton.tsx
- client/src/app/components/UsersAvatarStack.tsx
- client/src/app/components/UsersModal.tsx
- client/src/app/components/AppHeader.tsx
- client/src/app/components/AppShell.tsx
- client/src/app/pages/Room.css
- client/src/app/hooks/useReconnector.ts
- client/src/app/state/connection.ts
- client/src/app/state/presence.ts
- client/src/app/providers/yjsClient.ts
- client/src/app/hooks/useRoom.ts

### Files Modified

- client/src/app/pages/Room.tsx (full implementation)

### What's Next

Steps 8-12 of Phase 2 are now complete, continuing from the first 7 steps completed earlier. The room page now has:

- Full UI shell migrated from HTML mocks
- Yjs collaboration infrastructure with WebSocket and IndexedDB
- Presence and awareness system with cursor tracking
- Mobile view-only gating
- Connection status tracking
- All presentational elements ready for future phases

Remaining Phase 2 work includes connection indicator refinement, reconnection policy, and error handling.

---

## Phase 2: Client Foundation (First 7 Steps) - 2025-01-15

### Completed

✅ **Step 1: Repository Reality Check**

- Verified client/server workspace structure
- Confirmed React 18 + TypeScript + Vite stack
- Identified missing dependency: react-router-dom (installed)
- Validated server endpoints (/api/rooms, /ws) and environment setup

✅ **Step 2: UI Elements Extraction Analysis**

- Documented elements to migrate from AVLO-LANDING-v3.html
- Documented elements to migrate from Avlo-Whiteboard-with-cursors_highlightericon_update.html
- Identified data-testids to add for both routes

✅ **Step 3: File Structure Creation**

- Created client/src/app directory structure
- Organized into: router, providers, hooks, state, utils, components, pages
- Created styles directory for tokens and app CSS

✅ **Step 4: Design Tokens & Styles Extraction**

- Extracted CSS variables from both HTML files into unified tokens.css
- Preserved light/dark theme palettes
- Maintained design system consistency (colors, spacing, typography)

✅ **Step 5: Router Setup**

- Installed react-router-dom v7.8.0
- Configured routes: "/" (Landing) and "/rooms/:id" (Room)
- Added error boundary element
- Updated main.tsx to use RouterProvider

✅ **Step 6: Theme Provider Implementation**

- Created useTheme hook with localStorage persistence
- Implemented theme detection (system preference fallback)
- Built ThemeToggle component with sun/moon icons
- Applied data-theme attribute to HTML element

✅ **Step 7: Landing Page Migration**

- Converted AVLO-LANDING-v3.html to React component
- Implemented Create Room functionality (POST /api/rooms)
- Added Join Room modal with validation
- Preserved all visual design and layout
- Added proper error handling and toast notifications
- Included data-testids: create-room, join-room, theme-toggle

### Technical Notes

- Using ESM imports with .js extensions per TypeScript NodeNext requirements
- Toast system implemented as minimal vanilla solution (no external deps)
- Room page created as placeholder for remaining Phase 2 work
- All advanced controls remain presentational only (per Phase 2 scope)

### What's Next

The first 7 steps of Phase 2 are complete. The remaining Phase 2 work includes:

- Room page full implementation with Yjs providers
- WebSocket connection and presence system
- Split pane implementation
- Connection status indicator
- Mobile view-only gating
- User avatar stack and modal
- Copy link functionality

### Dependencies Added

- react-router-dom@7.8.0

### Files Created

- client/src/app/router.tsx
- client/src/app/hooks/useTheme.ts
- client/src/app/components/ThemeToggle.tsx
- client/src/app/pages/Landing.tsx
- client/src/app/pages/Landing.css
- client/src/app/pages/Room.tsx
- client/src/app/utils/url.ts
- client/src/app/utils/toast.ts
- client/src/styles/tokens.css
- client/src/styles/app.css

### Files Modified

- client/src/main.tsx (updated to use router and theme initialization)
- client/package.json (added react-router-dom dependency)
