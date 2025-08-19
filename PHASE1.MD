# Phase 1: Project Foundation & Infrastructure Setup - Clean Implementation

## Overview
This phase establishes the minimal foundation needed to begin development. We focus ONLY on structure, tooling, and configuration - no features, no database, no advanced capabilities.

## Current State (Phase 0 Complete)
✅ **Already Exists:**
- Root package.json with workspace configuration
- ESLint with critical `no-restricted-imports` rule
- Prettier configuration (but not installed)
- Husky setup (needs completion)
- .gitignore and .nvmrc
- Project specifications in NEW_OVERVIEW.MD

❌ **Missing:**
- Client and server directories
- TypeScript configuration
- Dependencies installation
- Build pipeline
- Test framework
- Development scripts

## Phase 1 Steps

### Step 1: Install Root Dependencies
```bash
# Install existing configured tools
npm install

# This will install:
# - prettier (already configured but not installed)
# - eslint and plugins
# - husky and lint-staged
# - Other dev dependencies

# Install React hooks ESLint plugin for proper hooks validation
npm install --save-dev eslint-plugin-react-hooks@5.1.0
```

### Step 2: Create Workspace Structure
```bash
# Create workspace directories
mkdir -p client/src/components
mkdir -p client/src/hooks  
mkdir -p client/src/lib
mkdir -p client/public
mkdir -p server/src
mkdir -p server/scripts
mkdir -p shared/types
mkdir -p e2e

# Create placeholder entry files
touch client/src/main.tsx
touch client/src/App.tsx
touch client/index.html
touch server/src/index.ts
touch shared/types/index.ts
```

### Step 3: Set Up TypeScript

#### 3.1 Root tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "references": [
    { "path": "./client" },
    { "path": "./server" }
  ]
}
```

#### 3.2 Client tsconfig.json
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "composite": true,
    "rootDir": "./src",
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@shared/*": ["../shared/*"]
    },
    "types": ["vite/client"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

#### 3.3 Server tsconfig.json
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "composite": true,
    "rootDir": "./src",
    "outDir": "./dist",
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@shared/*": ["../shared/*"]
    },
    "noEmit": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "public"]
}
```

### Step 4: Create Minimal Package.json Files

#### 4.1 Client package.json
```json
{
  "name": "@avlo/client",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  }
}
```

#### 4.2 Server package.json
```json
{
  "name": "@avlo/server",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  }
}
```

### Step 5: Install Core Dependencies

**Note:** We're installing critical dependencies (Yjs, Monaco, Prisma) now even though they won't be used until later phases. This ensures version consistency across the project as specified in NEW_OVERVIEW.MD.

```bash
# Install TypeScript and build tools at root
npm install --save-dev \
  typescript@5.9.2 \
  @types/node@22.13.4 \
  concurrently@8.2.2 \
  tsx@4.19.2

# Install client dependencies
npm install --workspace=client \
  react@18.3.1 \
  react-dom@18.3.1 \
  yjs@13.6.27 \
  y-websocket@3.0.0 \
  y-indexeddb@9.0.0 \
  y-webrtc@10.3.0 \
  monaco-editor@0.52.2

npm install --save-dev --workspace=client \
  @types/react@18.3.18 \
  @types/react-dom@18.3.5 \
  @vitejs/plugin-react@4.3.4 \
  vite@5.4.11 \
  tailwindcss@3.4.17 \
  autoprefixer@10.4.20 \
  postcss@8.4.49

# Install server dependencies  
npm install --workspace=server \
  express@4.21.2 \
  cors@2.8.5 \
  dotenv@16.4.7 \
  @y/websocket-server@0.1.0 \
  prisma@5.22.0

npm install --save-dev --workspace=server \
  @types/express@5.0.0 \
  @types/cors@2.8.17
```

### Step 6: Create Minimal Vite Configuration

#### client/vite.config.ts
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared')
    }
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV !== 'production',
    // Chunk splitting for lazy-loaded modules
    rollupOptions: {
      output: {
        manualChunks: {
          'monaco': ['monaco-editor'],
          'yjs': ['yjs', 'y-websocket', 'y-indexeddb', 'y-webrtc'],
        }
      }
    }
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
});
```

### Step 7: Create Basic Entry Files

#### client/index.html
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Avlo</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

#### client/src/main.tsx
```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

#### client/src/App.tsx
```typescript
export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <h1 className="text-4xl font-bold text-gray-900">
        Avlo Foundation Ready
      </h1>
    </div>
  );
}
```

#### client/src/index.css
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

#### server/src/index.ts
```typescript
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../public')));
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', phase: 1 });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

### Step 8: Configure Tailwind CSS

#### client/tailwind.config.js
```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

#### client/postcss.config.js
```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

### Step 9: Set Up Testing Framework

#### 9.1 Install test dependencies
```bash
npm install --save-dev \
  vitest@2.1.8 \
  @vitest/ui@2.1.8 \
  @playwright/test@1.49.0 \
  jsdom@26.0.0 \
  @testing-library/react@16.1.0 \
  @testing-library/user-event@14.5.2
```

#### 9.2 Create vitest.config.ts (root)
```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['**/src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      exclude: [
        'node_modules/',
        'dist/',
        '*.config.*',
        '**/index.ts',
        '**/*.d.ts',
        '**/types/**',
      ],
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared')
    }
  }
});
```

#### 9.3 Create playwright.config.ts
```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  }
});
```

#### 9.4 Create Test Data Generators
Create helper utilities for generating test data:

##### shared/test-utils/generators.ts
```typescript
import { randomBytes } from 'crypto';

// Generate test room data
export function generateTestRoom() {
  const id = `room-${randomBytes(8).toString('hex')}`;
  return {
    id,
    title: `Test Room ${id}`,
    createdAt: new Date(),
    lastWriteAt: new Date(),
    size_bytes: 0,
  };
}

// Generate test stroke data
export function generateTestStroke() {
  const strokeId = `stroke-${randomBytes(8).toString('hex')}`;
  return {
    id: strokeId,
    tool: 'pen' as const,
    color: '#000000',
    size: 2,
    opacity: 1,
    points: [100, 100, 150, 150, 200, 100], // Simple test path
    bbox: [100, 100, 200, 150] as [number, number, number, number],
    scene: 0,
    createdAt: Date.now(),
    userId: 'test-user',
  };
}

// Generate test user/awareness data
export function generateTestUser() {
  const userId = `user-${randomBytes(8).toString('hex')}`;
  return {
    userId,
    name: `User ${userId.slice(0, 6)}`,
    color: `#${Math.floor(Math.random()*16777215).toString(16)}`,
    cursor: { x: Math.random() * 1000, y: Math.random() * 600 },
    activity: 'idle' as const,
    seq: 0,
    ts: Date.now(),
  };
}
```

### Step 10: Update Root Package.json Scripts
```json
{
  "scripts": {
    "dev": "concurrently -n client,server -c cyan,magenta \"npm run dev -w client\" \"npm run dev -w server\"",
    "build": "npm run build -w client && npm run build -w server",
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "prepare": "husky"
  }
}
```

### Step 11: Environment Template

#### .env.example
```bash
# Basic configuration only - no advanced features yet
NODE_ENV=development
PORT=3001
```

### Step 12: Complete Husky Setup
```bash
# Initialize husky (if not done)
npx husky init

# Update pre-commit hook
echo "npx lint-staged" > .husky/pre-commit

# Create pre-push hook
echo "npm run typecheck" > .husky/pre-push
chmod +x .husky/pre-push
```

### Step 13: Configure ESLint with React Hooks

#### Update eslint.config.js
Add React hooks plugin and y-webrtc to restricted imports:

```javascript
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// In the React-specific rules section:
{
  files: ['client/**/*.{ts,tsx,js,jsx}'],
  plugins: {
    'react-hooks': reactHooks,
  },
  rules: {
    // React Hooks Rules
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    
    // Architecture Guards - Prevent direct Yjs imports in UI components
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'yjs',
            message: 'Direct Yjs imports forbidden in UI. Use collaboration hooks instead.',
          },
          {
            name: 'y-websocket',
            message: 'Direct provider imports forbidden. Use RoomDocManager instead.',
          },
          {
            name: 'y-indexeddb',
            message: 'Direct provider imports forbidden. Use RoomDocManager instead.',
          },
          {
            name: 'y-webrtc',
            message: 'Direct WebRTC provider imports forbidden. Use RoomDocManager instead.',
          },
        ],
        patterns: [
          {
            group: ['**/providers/yjsClient'],
            message: 'Use collaboration hooks instead of direct provider access.',
          },
        ],
      },
    ],
  },
}
```

### Step 14: VS Code Configuration

#### .vscode/settings.json
```json
{
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  },
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true
```

#### .vscode/extensions.json
```json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "bradlc.vscode-tailwindcss"
  ]
}
```

## Validation Checklist

Run these commands to verify Phase 1 is complete:

```bash
# 1. Install all dependencies
npm install

# 2. Type checking should pass
npm run typecheck

# 3. Linting should pass
npm run lint

# 4. Dev server should start
npm run dev
# Visit http://localhost:3000 - should see "Avlo Foundation Ready"
# Visit http://localhost:3001/api/health - should return {"status":"ok","phase":1}

# 5. Build should complete
npm run build
# Check that server/public directory contains built client files

# 6. Tests should run (even if no tests exist yet)
npm test
```

## What We DON'T Do in Phase 1
❌ **No feature implementation:**
- No Yjs or CRDT setup
- No canvas or drawing
- No WebSocket connections
- No real-time collaboration
❌ **No persistence:**
- No database setup (PostgreSQL/Prisma)
- No Redis configuration
- No data models or schemas
❌ **No advanced tooling:**
- No PWA configuration
- No Service Worker
- No WebRTC setup
- No Monaco editor
❌ **No deployment:**
- No Docker configuration
- No Railway setup
- No production optimizations

## Success Criteria

Phase 1 is complete when:
- ✅ Monorepo structure exists with client/server workspaces
- ✅ TypeScript compiles without errors
- ✅ Basic React app loads at localhost:3000
- ✅ Express server responds at localhost:3001
- ✅ Development workflow is smooth (hot reload, linting, formatting)
- ✅ Test frameworks are configured (even without tests)
- ✅ All team members can clone and run the project

## Next Steps

After Phase 1 validation:
1. Commit with message: `feat: complete Phase 1 - foundation and infrastructure`
2. Create a new branch for Phase 2: `git checkout -b phase2-data-layer`
3. Begin Phase 2: Core Data Layer & Models (RoomDocManager, Yjs setup)

## Common Issues

### Dependencies not installing
```bash
# Clear npm cache and reinstall
npm cache clean --force
rm -rf node_modules package-lock.json
rm -rf client/node_modules server/node_modules
npm install
```

### TypeScript errors on path aliases
Ensure all tsconfig files have matching path configurations and baseUrl is set.

### Vite not proxying to server
Make sure server is running on port 3001 and proxy config matches.

### ESLint not working in VS Code
Restart VS Code after installing dependencies to pick up workspace configuration.

## Notes

- This is a MINIMAL foundation - we add complexity incrementally
- Each phase builds on the previous - don't skip ahead
- The ESLint `no-restricted-imports` rule is CRITICAL for architecture
- Keep versions EXACT as specified in NEW_OVERVIEW.MD
- Test the setup thoroughly before moving to Phase 2