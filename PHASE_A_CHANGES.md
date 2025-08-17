# Changelog

All notable changes to the Avlo project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Phase 2 - Phase A: Delete Contamination** (2025-08-17)
  - Removed all files with direct Yjs exposure to prevent temporal fragmentation
  - Deleted contaminated files: yjsClient.ts, original useRoom.ts, original RemoteCursors.tsx, vanillaY.ts, test-vanilla-client.tsx
  - Gutted Room.tsx to remove all awareness/ydoc references
  - Gutted connection.ts to remove provider coupling
  - Gutted extend-ttl.ts to remove direct Y.Doc access
  - Created temporary stubs for useRoom and RemoteCursors to maintain compilation
  - Preparation for clean DocManager architecture implementation in Phase B
