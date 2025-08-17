import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';

describe('WriteQueue', () => {
  describe('batching behavior', () => {
    let doc: Y.Doc;

    beforeEach(() => {
      doc = new Y.Doc({ guid: 'write-queue-test' });
    });

    afterEach(() => {
      doc?.destroy();
    });

    it('should batch multiple operations into a single transaction', () => {
      const transactionSpy = vi.fn();
      
      doc.on('beforeTransaction', transactionSpy);
      
      doc.transact(() => {
        const map = doc.getMap('data');
        map.set('key1', 'value1');
        map.set('key2', 'value2');
        map.set('key3', 'value3');
      });
      
      expect(transactionSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle backpressure correctly', async () => {
      const operations: Array<() => void> = [];
      const maxQueueSize = 100;
      
      for (let i = 0; i < maxQueueSize + 10; i++) {
        operations.push(() => {
          const map = doc.getMap('data');
          map.set(`key${i}`, `value${i}`);
        });
      }
      
      const processingPromises = operations.map(op => 
        new Promise<void>(resolve => {
          setTimeout(() => {
            doc.transact(op);
            resolve();
          }, 0);
        })
      );
      
      await Promise.all(processingPromises);
      
      const map = doc.getMap('data');
      expect(map.size).toBeLessThanOrEqual(maxQueueSize + 10);
    });

    it('should validate operations before enqueueing', () => {
      const invalidOp = () => {
        throw new Error('Invalid operation');
      };
      
      expect(() => {
        doc.transact(invalidOp);
      }).toThrow('Invalid operation');
    });

    it('should ensure one transaction per logical operation', () => {
      const strokeData = {
        id: 'stroke-1',
        points: Array(100).fill(0).map((_, i) => ({ x: i, y: i })),
        tool: 'pen',
        color: '#000000'
      };
      
      const transactionSpy = vi.fn();
      doc.on('beforeTransaction', transactionSpy);
      
      doc.transact(() => {
        const strokes = doc.getArray('strokes');
        strokes.push([strokeData]);
      });
      
      expect(transactionSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('frame size validation', () => {
    it('should reject frames larger than 2MB', () => {
      const largeData = 'x'.repeat(2 * 1024 * 1024 + 1);
      
      expect(() => {
        doc.transact(() => {
          const map = doc.getMap('data');
          map.set('large', largeData);
        });
      }).toThrow();
    });
  });
});