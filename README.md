# Avlo

Link-based, account-less, offline-first collaborative whiteboard with integrated code execution.

## Core Features

- **Offline-first:** Full functionality without internet, seamless sync when connected
- **Real-time collaboration:** < 125ms p95 latency with 50+ concurrent users
- **No accounts required:** Link-based sharing for instant collaboration
- **Code execution:** JavaScript and Python (Pyodide) in isolated workers
- **Performance:** 60 FPS rendering, < 3s persistence lag
- **PWA:** Installable with full offline support

## 📊 Current Implementation Status

### ✅ Phase 1: Foundation & Infrastructure (COMPLETE)

| Component                   | Status      | Details                                                      |
| --------------------------- | ----------- | ------------------------------------------------------------ |
| **Monorepo Structure**      | ✅ Complete | Client, server, and shared packages properly configured      |
| **Build Pipeline**          | ✅ Complete | Vite 5.4.11 with proper chunking, asset hashing, source maps |
| **TypeScript**              | ✅ Complete | 5.9.2 with composite projects, strict mode, path aliases     |
| **Development Environment** | ✅ Complete | ESLint with architecture guards, Prettier, Husky hooks       |
| **Testing Framework**       | ✅ Complete | Vitest (10 tests passing), Playwright configured             |
| **Dependencies**            | ✅ Complete | All exact versions installed per specification               |
| **Configuration System**    | ✅ Complete | Comprehensive shared config with env overrides               |

### 🚧 Upcoming Phases

- **Phase 2:** Core Data Layer & Models (RoomDocManager, WriteQueue, CommandBus)
- **Phase 3:** Canvas Rendering & Drawing System
- **Phase 4:** Real-time Collaboration Infrastructure
- **Phase 5:** Persistence & Storage Layer
- **Phase 6:** UI Components & Tools
- **Phase 7:** Code Execution System
- **Phase 8:** PWA & Service Worker
- **Phase 9:** WebRTC & P2P Enhancement
- **Phase 10:** Production Polish & Optimization

## Architecture

### Key Principles

1. **No Direct Yjs Access**: UI components cannot import Yjs/providers directly (ESLint enforced)
2. **Immutable Snapshots**: All rendering uses frozen snapshot objects, never live Yjs data
3. **WriteQueue Pattern**: All mutations go through WriteQueue → CommandBus → single transaction
4. **Offline-First**: IndexedDB for local persistence, CRDT for conflict resolution
5. **WebSocket Authority**: WS remains authoritative path even when WebRTC is active

### Project Structure

```
avlo/
├── client/          # React frontend (components, hooks, lib)
├── server/          # Express backend (websocket, api)
├── packages/
│   └── shared/      # Shared types and configuration
└── e2e/             # Playwright tests
```

## 🚀 Getting Started

### Prerequisites

- Node.js 20+ (use `.nvmrc` for exact version)
- npm 10+
- Redis 7.x (for Phase 5+)
- PostgreSQL 15+ (for Phase 5+)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/avlo.git
cd avlo

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
```

### Development

```bash
# Start development servers (client on :3000, server on :3001)
npm run dev

# Run tests
npm test

# Type checking
npm run typecheck

# Linting
npm run lint

# Build for production
npm run build
```

### Testing

```bash
# Unit tests (Vitest)
npm test

# E2E tests (Playwright) - Phase 3+
npm run test:e2e

# Coverage report
npm run test:coverage
```

## 📦 Technology Stack

### Core Dependencies (Exact Versions)

- **Frontend**: React 18.3.1, TypeScript 5.9.2, Vite 5.4.11
- **State Management**: Yjs 13.6.27 (CRDT)
- **Real-time**: y-websocket 3.0.0, y-webrtc 10.3.0
- **Offline**: y-indexeddb 9.0.0
- **Code Editor**: Monaco Editor 0.52.2
- **Code Execution**: Pyodide 0.26.4 (Phase 7)
- **Canvas**: RBush 4.0.1 (spatial indexing)
- **Database**: Prisma 5.22.0, Redis 7.x, PostgreSQL 15+
- **Testing**: Vitest 2.1.8, Playwright 1.49.1

## 🔧 Configuration

All configuration is centralized in `packages/shared/src/config.ts` with environment variable overrides:

```typescript
// Example configuration usage
import { ROOM_CONFIG, PERFORMANCE_CONFIG, NETWORK_CONFIG } from '@avlo/shared';

// Room limits
const maxRoomSize = ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES; // 10MB
const roomTTL = ROOM_CONFIG.ROOM_TTL_DAYS; // 14 days

// Performance settings
const targetFPS = PERFORMANCE_CONFIG.MAX_FPS; // 60
const snapshotBatchMs = PERFORMANCE_CONFIG.MICRO_BATCH_DEFAULT_MS; // 8-16ms

// Network settings
const wsReconnectBase = BACKOFF_CONFIG.WS_BASE_MS; // 300ms
```

## 🛡️ Architecture Guards

The project enforces strict architectural boundaries:

```javascript
// ❌ This will fail ESLint checks in UI components
import * as Y from 'yjs'; // Error: Direct Yjs import not allowed

// ✅ Correct approach
import { useRoomSnapshot } from '@/hooks/useRoom';
const snapshot = useRoomSnapshot(roomId); // Immutable snapshot
```

## 📈 Performance Targets

- **Collaboration Latency**: p95 ≤ 125ms with 50 users
- **Rendering**: 60 FPS maintained
- **Persistence Lag**: p95 ≤ 3s, hard cap 5s
- **Room Size**: 8MB warning, 10MB read-only cap
- **Export**: 2s timeout before viewport fallback

## 📚 Documentation

- **[OVERVIEW.MD](OVERVIEW.MD)**: Complete technical specification
- **[IMPLEMENTATION.MD](IMPLEMENTATION.MD)**: Phase-by-phase implementation guide

## 📄 License

Copyright © 2025. All rights reserved. (License to be determined)

---

**Current Focus**: Beginning Phase 2 - Core Data Layer & Models

_Last Updated: January 2025_
