import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
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
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // React-specific rules for client
  {
    files: ['client/**/*.{ts,tsx,js,jsx}'],
    rules: {
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

  // Allow Yjs imports only in collaboration layer
  {
    files: ['client/src/collaboration/**/*.{ts,tsx}'],
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
];
