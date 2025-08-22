# Changelog

## [Unreleased]

### Added
- Phase 2.4: Snapshot Publishing System implementation
  - RAF-based publish loop with adaptive batching (8-32ms windows)
  - Y.Doc observer setup for state change detection  
  - IndexedDB cache for render snapshots
  - Visibility handling (60 FPS active, 8 FPS hidden)
  - Memory-safe state vector encoding to prevent stack overflow