# Changelog

## [2025-08-20] Phase 2.2.2 - React Hooks & Testing

### Added
- React hooks for RoomDocManager integration (useRoomDoc, useSnapshot, usePresence, useRoomStats)
- Comprehensive unit tests for type validation functions
- Unit tests for RoomDocManager lifecycle and subscriptions
- Unit tests for all React hooks with proper cleanup and state management

## [2025-08-20] Phase 2.2.1 - RoomDocManager Foundation

### Added
- RoomDocManager class with singleton registry pattern for managing Y.Doc instances
- Subscription system for snapshot, presence, and room stats updates  
- Adaptive batch window publishing with RAF/setTimeout based on tab visibility
- Immutable snapshot building from Y.Doc structures with scene filtering

## [2025-08-20] Phase 2.1 to 2.1.8 - Core Type System

### Added
- TypeScript type definitions for all core data structures (strokes, text, commands, snapshots)
- Validation helpers and type guards for command processing
- Device UI state interfaces for local storage
- Immutable snapshot system with `createEmptySnapshot()` factory