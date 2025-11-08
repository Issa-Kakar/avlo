import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  // Ignore patterns
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      'server/public/**',
      '.husky/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },

  // Base config for all JS/TS files
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,

      // Keep these light for fast pre-commit
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // React-specific rules for client
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
  },

  // Allow Yjs imports only in collaboration layer and lib (infrastructure)
  {
    files: ['client/src/collaboration/**/*.{ts,tsx}', 'client/src/lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // Server-specific rules
  {
    files: ['server/**/*.{ts,js}'],
    rules: {
      // Server-specific rules if needed
    },
  },

  // Cloudflare Worker-specific rules
  {
    files: ['worker/**/*.{ts,js}'],
    languageOptions: {
      globals: {
        // Remove Node.js globals for worker environment
        ...Object.fromEntries(Object.keys(globals.node).map(key => [key, 'off'])),
        // Add Cloudflare Workers globals
        DurableObjectNamespace: 'readonly',
        ExecutionContext: 'readonly',
        ExportedHandler: 'readonly',
        DurableObjectState: 'readonly',
        DurableObjectStorage: 'readonly',
        WebSocket: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      // Allow triple-slash references for type loading
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },

  // Test-specific rules
  {
    files: [
      '**/__tests__/**/*.{ts,tsx,js,jsx}',
      '**/*.test.{ts,tsx,js,jsx}',
      '**/*.spec.{ts,tsx,js,jsx}',
      '**/test-*.{ts,tsx,js,jsx}',
    ],
    rules: {
      // Allow 'any' types in tests for accessing private implementation details
      // CRITICAL: These are intentional for testing the RoomDocManager's internal state
      // without exposing implementation details to production code
      '@typescript-eslint/no-explicit-any': 'off',

      // Allow unused variables in test helpers - they're for future phases
      // IMPORTANT: Functions like waitForSnapshot, collectSnapshots, collectPresenceUpdates
      // are documented test utilities that will be used in Phases 3-7
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          // Combine patterns: underscore prefix OR specific test helper names
          varsIgnorePattern:
            '^_|^(waitForSnapshot|collectSnapshots|collectPresenceUpdates|capturedOrigin|cleanup|unsubSnapshot|unsubPresence|unsubStats|vi|RoomStats|RoomDocManagerRegistry|Clock|FrameScheduler|afterEach|clock|frames|id2|data)$',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Allow console.log in tests for debugging
      'no-console': 'off',

      // Allow direct Yjs imports in tests (needed for test assertions)
      'no-restricted-imports': 'off',
    },
  },
];
