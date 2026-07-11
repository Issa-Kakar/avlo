// Minimal ambient shape of the dev-only window.__avlo bridge
// (web/src/dev/test-bridge.ts) — just what e2e specs touch. Extend as specs need more.
interface AvloBridge {
  hasRoom(): boolean;
  count(): number;
  createShape(opts?: { x?: number; y?: number }): string;
  settle(ms?: number): Promise<void>;
}

interface Window {
  __avlo?: AvloBridge;
}
