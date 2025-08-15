# CHANGELOG

## Phase 2: Client Foundation Complete - 2025-01-15

### Steps 19-24: Presentational Controls, Remote Cursors & Teardown

#### Step 19: Presentational Controls with Helpful Messages

- All drawing tools show toast messages when clicked:
  - View-only mode: "Drawing tools are view-only on mobile devices" or "Room is read-only due to size limit"
  - Normal mode: "{Tool} will be available in a later phase"
- Zoom controls, minimap, palette sliders all show appropriate "coming soon" messages
- Language toggle and AI Assistant show phase notification toasts
- Export and Run buttons maintain disabled state with helpful messages

#### Step 20: Minimal Implementations

- All required utility functions already implemented (device.ts, url.ts, etc.)
- Connection state store, toast system, and theme provider complete

#### Step 21: Remote Cursor Rendering

- `RemoteCursors` component renders up to 20 remote cursors
- Cursor position updates throttled to ~30Hz (33ms intervals)
- Desktop: Shows cursor trails (last 24 points per user) with semi-transparent polylines
- Mobile: Trails automatically hidden via CSS media queries (pointer: coarse)
- Cursor labels show user names with colored backgrounds
- Smooth transitions (75ms ease-out) for cursor movement

#### Step 22: Connection State Store

- Already implemented in previous steps
- Combines provider status, navigator.onLine, and reconnecting state
- Derives 4 states: Online, Reconnecting, Offline, Read-only

#### Step 23: Teardown Discipline

- `ReconnectingWebsocketProvider` properly cleans up timers on destroy
- Room hook cancels all event listeners on unmount
- Awareness state cleared with setLocalState(null)
- Providers destroyed via teardownProviders()
- IndexedDB persistence maintained (never deleted on leave)

#### Step 24: Telemetry Touchpoints

- Skipped - no telemetry infrastructure exists in codebase

#### Files Modified

- `client/src/app/components/RemoteCursors.tsx` - NEW: Remote cursor rendering with trails
- `client/src/app/components/RemoteCursors.css` - NEW: Cursor animations and responsive styles
- `client/src/app/pages/Room.tsx` - Enhanced with cursor overlay and tool click handlers

## Phase 2: Client Foundation Complete - 2025-01-15

### Steps 13-18: Connection, Error Handling & Accessibility

#### Step 13: Connection Indicator

- `ConnectionChip` component with 4 states: Online (green #10B981), Reconnecting (yellow #FCD34D), Offline (red #EF4444), Read-only (gray #94A3B8)
- `useConnectionState` hook combines: provider status events, navigator.onLine, reconnecting flag, readOnly advisory
- ARIA: role="status", aria-live="polite", data-testid="connection-chip"

#### Step 14: Reconnect Policy (Full Jitter)

- `ReconnectingWebsocketProvider` extends `WebsocketProvider` with exponential backoff
- Full jitter formula: `Math.floor(Math.random() * Math.min(30000, 500 * 2^attempt))`
- Monitors provider 'status' events, schedules reconnect on disconnect
- Cleanup: cancels timers on destroy, resets attempt counter on success

#### Step 15: Copy Link Button

- `CopyLinkButton` copies `window.location.href` to clipboard
- Normative toast text: "Link copied." (exact, do not change)
- Fallback: hidden input + document.execCommand('copy') if clipboard API fails
- data-testid="copy-link", aria-label="Copy link"

#### Step 16: Error Handling & UX Mapping

- HTTP 429 on /api/rooms → toast "Too many requests — try again shortly."
- WS message type:error code:ROOM_FULL → toast "Room is full — create a new room."
- WS message type:error code:DELTA_TOO_LARGE → toast "Change too large. Refresh to rejoin."
- WebSocket error event → toast "Network error. Check connection."
- IndexedDB failure → console.warn, continue without persistence (private mode support)

#### Step 17: Read-Only Advisory

- Monitors WS messages for `type: 'room_stats'`, sets readOnly when `bytes >= cap`
- Combined with mobile view-only: `viewOnly = mobileViewOnly || roomHandles?.readOnly`
- All write tools receive aria-disabled="true" when viewOnly is true
- ConnectionChip displays "Read-only" state when active

#### Step 18: Accessibility Guarantees

- **UsersModal**: Focus trap with previousFocus ref, Escape key handler, returns focus on close
- **SplitPane**: role="separator", aria-orientation="vertical", ArrowLeft/Right adjusts by 2%, Escape blurs
- **Toasts**: role="status", aria-live="polite", auto-dismiss at 1200ms (success), 2000ms (error)
- **Disabled controls**: aria-disabled="true", removed from tab order when inert

#### Files Modified

- `client/src/app/providers/yjsClient.ts` - Added ReconnectingWebsocketProvider class
- `client/src/app/hooks/useRoom.ts` - Enhanced message handling for errors and room_stats
- `client/src/app/pages/Room.tsx` - Separated mobileViewOnly from server readOnly
- `client/src/app/utils/toast.ts` - Added info() method at 1500ms duration

### Steps 8-12: Room UI, Yjs Providers & Presence

#### Step 8: Room Page Migration

- Converted `/Avlo-Whiteboard-with-cursors_highlightericon_update.html` to React
- AppShell with header (logo, ConnectionChip, UsersAvatarStack, CopyLinkButton, Export, ThemeToggle)
- Tool rail with 9 tools (pen, highlighter, eraser, stamps, pan, undo, redo, clear) - presentational only
- Palette controls (color slider 0-360 hue, size slider 1-20px) - presentational only
- Editor pane with Python demo code, run button (disabled), AI chat placeholder
- Console with 4 tabs (PROBLEMS, OUTPUT, DEBUG CONSOLE, TERMINAL)

#### Step 9: SplitPane Implementation

- Default 70/30 ratio, persisted to localStorage
- Draggable resizer with 4px hit area, visual feedback on drag
- Keyboard: ArrowLeft/Right adjusts by 2%, Escape blurs, min 20%, max 80%
- Grid-based layout: `gridTemplateColumns: ${ratio}fr ${1-ratio}fr`
- data-testid="split-resizer", role="separator", aria-orientation="vertical"

#### Step 10: Device Capability Gate

- `isCoarsePointer()`: matchMedia('(pointer: coarse)').matches
- `isNarrow(max = 820)`: window.innerWidth <= max
- `onResize(cb)`: resize event listener with cleanup
- Sets viewOnly when coarse pointer OR narrow viewport
- Write tools disabled with aria-disabled="true" when viewOnly

#### Step 11: Yjs Providers & Room Hook

- `createYDoc(roomId)`: new Y.Doc({ guid: roomId }) - NEVER mutate guid
- `createProviders(roomId)`: Returns ydoc, wsProvider, indexeddbProvider
- WebsocketProvider config: resyncInterval: 5000, connect: true
- IndexeddbPersistence per room, NEVER deleted on leave
- Room ID validation: /^[A-Za-z0-9_-]+$/
- useRoom exports: roomId, ydoc, provider, awareness, readOnly, destroy()

#### Step 12: Presence (Awareness)

- User generation: adjective+animal name, color from palette
- Presence model: name, color, cursor: {x,y} | null, activity: idle|drawing|typing
- Cursor tracking: mousemove throttled to ~30Hz (33ms), null on mouseleave
- UsersAvatarStack shows initials in colored circles, count badge
- UsersModal lists all users with activity status dots
- Awareness cleanup: setLocalState(null) on unmount

---

### Steps 1-7: Setup, Routing & Landing Page

#### Step 1: Repository Reality Check

- Verified client/ and server/ workspace structure
- Confirmed React 18.3.1, TypeScript 5.7.2, Vite 5.4.11
- Installed missing react-router-dom@7.8.0
- Verified /api/rooms POST endpoint, /ws WebSocket path

#### Step 2: UI Elements Extraction

- Mapped AVLO-LANDING-v3.html elements to React components
- Identified IDs to preserve: #themeToggle, #board, #code, #copyLink, etc.
- Planned data-testids: create-room, join-room, connection-chip, split-resizer

#### Step 3: File Structure

- Created client/src/app/{router,providers,hooks,state,utils,components,pages}
- Created client/src/styles/{tokens.css,app.css}

#### Step 4: Design Tokens Extraction

- Merged CSS variables from both HTML files
- :root and [data-theme="dark"] palettes preserved
- Variables: --bg, --surface, --panel, --ink, --accent, --radius-_, --space-_

#### Step 5: Router Setup

- createBrowserRouter with routes: / → Landing, /rooms/:id → Room
- Error boundary element for route errors
- RouterProvider in main.tsx

#### Step 6: Theme Provider

- useTheme hook: getTheme(), setTheme(), localStorage persistence
- ThemeToggle component with sun/moon SVG icons
- Sets data-theme attribute on <html> element
- System preference fallback via prefers-color-scheme

#### Step 7: Landing Page

- Hero section with gradient text, CTA buttons
- Create Room: POST /api/rooms, navigate to shareLink or /rooms/{roomId}
- Join Room modal: focus trap, regex validation /^[A-Za-z0-9_-]+$/
- Error handling: 429 → "Too many requests — try again shortly."
- Toast system: vanilla implementation, aria-live="polite"
