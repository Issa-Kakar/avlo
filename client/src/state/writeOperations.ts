import type { Doc } from 'yjs';

/**
 * Phase 8 Write Operations Gating System
 *
 * Provides centralized write operation gating at the commit pipeline level.
 * This ensures that when readOnly=true, all write operations are blocked
 * while presence/awareness continues to function.
 */

export interface WriteOperationContext {
  ydoc: Doc;
  readOnly: boolean;
  operation: string;
  data?: any;
}

export interface WriteGate {
  canWrite(context: WriteOperationContext): boolean;
  getBlockReason(context: WriteOperationContext): string | null;
}

/**
 * Read-only gate blocks all writes when room is at 10 MB cap
 */
export class ReadOnlyGate implements WriteGate {
  canWrite(context: WriteOperationContext): boolean {
    return !context.readOnly;
  }

  getBlockReason(context: WriteOperationContext): string | null {
    return context.readOnly ? 'Board is read-only — size limit reached.' : null;
  }
}

/**
 * Mobile view-only gate blocks writes on mobile devices
 */
export class MobileViewOnlyGate implements WriteGate {
  private isMobile: boolean;

  constructor() {
    // Check for mobile/touch device
    this.isMobile = this.detectMobile();
  }

  private detectMobile(): boolean {
    // Use same detection logic as existing device utils
    return (
      window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(max-width: 820px)').matches
    );
  }

  canWrite(_context: WriteOperationContext): boolean {
    return !this.isMobile;
  }

  getBlockReason(_context: WriteOperationContext): string | null {
    return this.isMobile ? 'Drawing tools are view-only on mobile devices.' : null;
  }
}

/**
 * Write operation dispatcher with gating
 */
export class WriteOperationDispatcher {
  private gates: WriteGate[] = [];

  constructor() {
    // Add default gates
    this.gates.push(new ReadOnlyGate());
    this.gates.push(new MobileViewOnlyGate());
  }

  addGate(gate: WriteGate): void {
    this.gates.push(gate);
  }

  removeGate(gate: WriteGate): void {
    const index = this.gates.indexOf(gate);
    if (index > -1) {
      this.gates.splice(index, 1);
    }
  }

  /**
   * Check if a write operation is allowed
   */
  canWrite(context: WriteOperationContext): boolean {
    return this.gates.every((gate) => gate.canWrite(context));
  }

  /**
   * Get the reason why a write operation is blocked
   */
  getBlockReason(context: WriteOperationContext): string | null {
    for (const gate of this.gates) {
      const reason = gate.getBlockReason(context);
      if (reason) {
        return reason;
      }
    }
    return null;
  }

  /**
   * Attempt to execute a write operation
   * Returns true if successful, false if blocked
   */
  executeWrite(
    context: WriteOperationContext,
    writeOperation: () => void,
    onBlocked?: (reason: string) => void,
  ): boolean {
    if (!this.canWrite(context)) {
      const reason = this.getBlockReason(context);
      if (reason && onBlocked) {
        onBlocked(reason);
      }
      return false;
    }

    // Execute the write operation
    try {
      writeOperation();
      return true;
    } catch (error) {
      console.error('[WriteOperations] Write operation failed:', error);
      return false;
    }
  }

  /**
   * Create a gated transact function for Yjs operations
   */
  createGatedTransact(ydoc: Doc, readOnly: boolean) {
    return (operation: string, fn: () => void, origin?: any) => {
      const context: WriteOperationContext = {
        ydoc,
        readOnly,
        operation,
        data: { origin },
      };

      return this.executeWrite(
        context,
        () => ydoc.transact(fn, origin),
        (reason) => {
          console.warn(`[WriteOperations] Write blocked: ${reason}`);
          // Could emit an event here for UI feedback
        },
      );
    };
  }
}

// Global write dispatcher instance
export const writeDispatcher = new WriteOperationDispatcher();

/**
 * Hook for using write operations with gating
 */
export function useWriteOperations(ydoc?: Doc, readOnly: boolean = false) {
  if (!ydoc) {
    return {
      canWrite: false,
      gatedTransact: null,
      checkWrite: () => false,
      getBlockReason: () => 'No document available',
    };
  }

  const gatedTransact = writeDispatcher.createGatedTransact(ydoc, readOnly);

  const checkWrite = (operation: string) => {
    const context: WriteOperationContext = {
      ydoc,
      readOnly,
      operation,
    };
    return writeDispatcher.canWrite(context);
  };

  const getBlockReason = (operation: string) => {
    const context: WriteOperationContext = {
      ydoc,
      readOnly,
      operation,
    };
    return writeDispatcher.getBlockReason(context);
  };

  return {
    canWrite: !readOnly,
    gatedTransact,
    checkWrite,
    getBlockReason,
  };
}
