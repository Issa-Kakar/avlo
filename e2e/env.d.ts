// Minimal ambient shape of the dev-only window.__avlo bridge
// (web/src/dev/test-bridge.ts) — just what e2e specs touch. Extend as specs need more.
interface AvloBridge {
  hasRoom(): boolean;
  count(): number;
  createShape(opts?: { x?: number; y?: number }): string;
  createCode(opts?: { x?: number; y?: number; language?: string; text?: string }): string;
  runCode(id: string): void;
  get(id: string): Record<string, unknown> | null;
  handle(id: string): { y: { delete(key: string): void } } | null;
  transact<T>(fn: () => T): T | undefined;
  settle(ms?: number): Promise<void>;
}

interface Window {
  __avlo?: AvloBridge;
}
