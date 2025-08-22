# Changelog

## [Unreleased]

### Added
- Phase 2.4: Snapshot Publishing System implementation ✅
  - RAF-based publish loop with adaptive batching (8-32ms windows)
  - Y.Doc observer setup for state change detection  
  - IndexedDB cache for render snapshots
  - Visibility handling (60 FPS active, 8 FPS hidden)
  - Memory-safe state vector encoding to prevent stack overflow
  - Step D: Visibility handling with document.hidden detection
  - Step E: Snapshot building and publishing with svKey change detection
  - Step F: IndexedDB snapshot cache for fast initial paint
  - Fixed type mismatch in roomStats.expiresAt field

### Enhanced
- Phase 2.5 Preparation: Production ULID implementation
  - Installed official ulid package (v3.0.1) for production-quality unique ID generation
  - Critical for distributed systems causal consistency and scene capture
  - Ensures lexicographically sortable, collision-resistant identifiers
  - 128-bit UUID compatibility with 1.21e+24 unique IDs per millisecond