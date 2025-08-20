import { describe, it, expect } from 'vitest';
import {
  isStrokeCommand,
  isEraseCommand,
  isTextCommand,
  validateStrokePoints,
  validateTextContent,
  validateCodeBody,
  estimateEncodedSize,
  MAX_FRAME_SIZE,
} from '../validation';
import { MAX_POINTS_PER_STROKE, MAX_TEXT_LENGTH, MAX_CODE_BODY_SIZE } from '../room';
import type { Command, DrawStrokeCommit, EraseObjects, AddText } from '../commands';

describe('Type Guards', () => {
  it('should identify DrawStrokeCommit commands', () => {
    const strokeCmd: DrawStrokeCommit = {
      type: 'DrawStrokeCommit',
      id: 'stroke-123',
      tool: 'pen',
      color: '#000000',
      size: 5,
      opacity: 1,
      points: [0, 0, 10, 10],
      bbox: [0, 0, 10, 10],
      startedAt: Date.now(),
      finishedAt: Date.now(),
      scene: 0,
    };

    expect(isStrokeCommand(strokeCmd)).toBe(true);
    expect(isEraseCommand(strokeCmd)).toBe(false);
    expect(isTextCommand(strokeCmd)).toBe(false);
  });

  it('should identify EraseObjects commands', () => {
    const eraseCmd: EraseObjects = {
      type: 'EraseObjects',
      ids: ['stroke-1', 'text-1'],
      idempotencyKey: 'erase-123',
    };

    expect(isEraseCommand(eraseCmd)).toBe(true);
    expect(isStrokeCommand(eraseCmd)).toBe(false);
    expect(isTextCommand(eraseCmd)).toBe(false);
  });

  it('should identify AddText commands', () => {
    const textCmd: AddText = {
      type: 'AddText',
      id: 'text-123',
      x: 100,
      y: 100,
      w: 200,
      h: 50,
      content: 'Hello World',
      color: '#000000',
      size: 16,
    };

    expect(isTextCommand(textCmd)).toBe(true);
    expect(isStrokeCommand(textCmd)).toBe(false);
    expect(isEraseCommand(textCmd)).toBe(false);
  });
});

describe('validateStrokePoints', () => {
  it('should accept valid stroke points', () => {
    expect(validateStrokePoints([0, 0, 10, 10])).toBe(true);
    expect(validateStrokePoints([0, 0, 10, 10, 20, 20])).toBe(true);
    expect(validateStrokePoints([0.5, 0.5])).toBe(true);
  });

  it('should reject invalid stroke points', () => {
    // Empty array
    expect(validateStrokePoints([])).toBe(false);

    // Not an array
    expect(validateStrokePoints(null as unknown as number[])).toBe(false);
    expect(validateStrokePoints(undefined as unknown as number[])).toBe(false);
    expect(validateStrokePoints({} as unknown as number[])).toBe(false);

    // Contains non-numbers
    expect(validateStrokePoints([0, 0, 'invalid' as unknown as number, 10])).toBe(false);
    expect(validateStrokePoints([0, 0, null as unknown as number, 10])).toBe(false);
    expect(validateStrokePoints([0, 0, undefined as unknown as number, 10])).toBe(false);

    // Contains non-finite numbers
    expect(validateStrokePoints([0, 0, Infinity, 10])).toBe(false);
    expect(validateStrokePoints([0, 0, -Infinity, 10])).toBe(false);
    expect(validateStrokePoints([0, 0, NaN, 10])).toBe(false);
  });

  it('should reject points exceeding maximum count', () => {
    const validPoints = new Array(MAX_POINTS_PER_STROKE * 2).fill(0);
    expect(validateStrokePoints(validPoints)).toBe(true);

    const tooManyPoints = new Array((MAX_POINTS_PER_STROKE + 1) * 2).fill(0);
    expect(validateStrokePoints(tooManyPoints)).toBe(false);
  });
});

describe('validateTextContent', () => {
  it('should accept valid text content', () => {
    expect(validateTextContent('Hello')).toBe(true);
    expect(validateTextContent('a')).toBe(true);
    expect(validateTextContent('A'.repeat(MAX_TEXT_LENGTH))).toBe(true);
  });

  it('should reject invalid text content', () => {
    // Not a string
    expect(validateTextContent(null as unknown as string)).toBe(false);
    expect(validateTextContent(undefined as unknown as string)).toBe(false);
    expect(validateTextContent(123 as unknown as string)).toBe(false);
    expect(validateTextContent({} as unknown as string)).toBe(false);

    // Empty string
    expect(validateTextContent('')).toBe(false);

    // Too long
    expect(validateTextContent('A'.repeat(MAX_TEXT_LENGTH + 1))).toBe(false);
  });
});

describe('validateCodeBody', () => {
  it('should accept valid code body', () => {
    expect(validateCodeBody('console.log("hello")')).toBe(true);
    expect(validateCodeBody('')).toBe(true); // Empty code is valid
    expect(validateCodeBody('a'.repeat(MAX_CODE_BODY_SIZE))).toBe(true);
  });

  it('should reject invalid code body', () => {
    // Not a string
    expect(validateCodeBody(null as unknown as string)).toBe(false);
    expect(validateCodeBody(undefined as unknown as string)).toBe(false);
    expect(validateCodeBody(123 as unknown as string)).toBe(false);

    // Too large
    expect(validateCodeBody('a'.repeat(MAX_CODE_BODY_SIZE + 1))).toBe(false);
  });
});

describe('estimateEncodedSize', () => {
  it('should estimate command size', () => {
    const smallCmd: Command = {
      type: 'ClearBoard',
      idempotencyKey: 'clear-123',
    };

    const size = estimateEncodedSize(smallCmd);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(100);
  });

  it('should estimate large command size', () => {
    const largeCmd: DrawStrokeCommit = {
      type: 'DrawStrokeCommit',
      id: 'stroke-123',
      tool: 'pen',
      color: '#000000',
      size: 5,
      opacity: 1,
      points: new Array(1000).fill(0),
      bbox: [0, 0, 100, 100],
      startedAt: Date.now(),
      finishedAt: Date.now(),
      scene: 0,
    };

    const size = estimateEncodedSize(largeCmd);
    expect(size).toBeGreaterThan(1000);
    expect(size).toBeLessThan(MAX_FRAME_SIZE);
  });

  it('should handle commands with Unicode characters', () => {
    const unicodeCmd: AddText = {
      type: 'AddText',
      id: 'text-123',
      x: 100,
      y: 100,
      w: 200,
      h: 50,
      content: '你好世界 🌍 مرحبا بالعالم',
      color: '#000000',
      size: 16,
    };

    const size = estimateEncodedSize(unicodeCmd);
    expect(size).toBeGreaterThan(100); // Unicode takes more bytes
  });
});
