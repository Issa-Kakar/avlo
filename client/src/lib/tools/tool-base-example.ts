/**
 * Example base class for tools showing proper scene capture usage.
 * This demonstrates the CORRECT pattern that all tools must follow
 * to ensure distributed systems causal consistency.
 * 
 * CRITICAL: Every tool that creates content MUST follow this pattern!
 */

import { SceneCapture, SceneCaptureManager } from '../scene-capture';
import { DrawStrokeCommit, AddText, SceneIdx, ulid } from '@avlo/shared';
import type { RoomDocManager } from '../room-doc-manager';

/**
 * Example: Drawing tool with proper scene capture
 */
export class DrawingToolExample {
  private sceneCapture = new SceneCapture();
  private currentStroke: {
    points: number[];
    startTime: number;
  } | null = null;
  
  constructor(private roomDocManager: RoomDocManager) {}
  
  /**
   * CRITICAL: Capture scene at pointer down!
   */
  handlePointerDown(event: PointerEvent): void {
    // STEP 1: Capture scene IMMEDIATELY at interaction start
    const capturedScene = this.sceneCapture.capture(
      this.roomDocManager.currentSnapshot
    );
    
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DrawingTool] Pointer down - captured scene=${capturedScene}`);
    }
    
    // STEP 2: Start collecting stroke points
    this.currentStroke = {
      points: [event.clientX, event.clientY],
      startTime: Date.now(),
    };
  }
  
  handlePointerMove(event: PointerEvent): void {
    if (!this.currentStroke) return;
    
    // Just collect points, NO scene capture here!
    this.currentStroke.points.push(event.clientX, event.clientY);
  }
  
  /**
   * CRITICAL: Use captured scene at commit, NOT current scene!
   */
  handlePointerUp(_event: PointerEvent): void {
    if (!this.currentStroke) return;
    
    // STEP 3: Get the CAPTURED scene (not current!)
    const capturedScene = this.sceneCapture.getRequired();
    
    // STEP 4: Create command with captured scene
    const command: DrawStrokeCommit = {
      type: 'DrawStrokeCommit',
      id: ulid(),
      tool: 'pen',
      color: '#000000',
      size: 2,
      opacity: 1,
      points: this.currentStroke.points,
      bbox: this.calculateBBox(this.currentStroke.points),
      startedAt: this.currentStroke.startTime,
      finishedAt: Date.now(),
      scene: capturedScene, // CRITICAL: Use captured scene!
    };
    
    if (process.env.NODE_ENV === 'development') {
      const currentScene = this.roomDocManager.currentSnapshot.scene;
      console.log(
        `[DrawingTool] Committing stroke: capturedScene=${capturedScene}, currentScene=${currentScene}`
      );
      
      if (capturedScene !== currentScene) {
        console.warn(
          `[DrawingTool] Scene changed during gesture! This is EXPECTED and HANDLED CORRECTLY.`
        );
      }
    }
    
    // STEP 5: Submit command
    this.roomDocManager.write(command);
    
    // STEP 6: Clean up
    this.currentStroke = null;
    this.sceneCapture.reset();
  }
  
  /**
   * Handle gesture cancellation
   */
  handlePointerCancel(): void {
    this.currentStroke = null;
    this.sceneCapture.reset();
  }
  
  private calculateBBox(points: number[]): [number, number, number, number] {
    // Simplified bbox calculation
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i];
      const y = points[i + 1];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    
    return [minX, minY, maxX, maxY];
  }
}

/**
 * Example: Text tool with proper scene capture
 */
export class TextToolExample {
  private sceneCapture = new SceneCapture();
  private placementStart: { x: number; y: number } | null = null;
  
  constructor(private roomDocManager: RoomDocManager) {}
  
  /**
   * CRITICAL: Capture scene when text placement starts
   */
  startTextPlacement(x: number, y: number): void {
    // Capture scene at placement start
    this.sceneCapture.capture(this.roomDocManager.currentSnapshot);
    this.placementStart = { x, y };
    
    if (process.env.NODE_ENV === 'development') {
      console.log(`[TextTool] Started placement at scene=${this.sceneCapture.get()}`);
    }
  }
  
  /**
   * CRITICAL: Use captured scene when committing text
   */
  commitText(content: string): void {
    if (!this.placementStart) {
      throw new Error('[TextTool] No placement started');
    }
    
    // Get captured scene
    const capturedScene = this.sceneCapture.getRequired();
    
    const command: AddText = {
      type: 'AddText',
      id: ulid(),
      x: this.placementStart.x,
      y: this.placementStart.y,
      w: 200, // Estimated width
      h: 50,  // Estimated height
      content,
      color: '#000000',
      size: 16,
      scene: capturedScene, // CRITICAL: Use captured scene!
    };
    
    this.roomDocManager.write(command);
    
    // Clean up
    this.placementStart = null;
    this.sceneCapture.reset();
  }
  
  cancelTextPlacement(): void {
    this.placementStart = null;
    this.sceneCapture.reset();
  }
}

/**
 * Example: Multi-touch drawing with independent scene captures
 */
export class MultiTouchDrawingExample {
  private sceneCaptureManager = new SceneCaptureManager();
  private activeStrokes = new Map<number, {
    points: number[];
    startTime: number;
  }>();
  
  constructor(private roomDocManager: RoomDocManager) {}
  
  handleTouchStart(event: TouchEvent): void {
    event.preventDefault();
    
    Array.from(event.changedTouches).forEach(touch => {
      const pointerId = `touch_${touch.identifier}`;
      
      // CRITICAL: Each touch gets its own scene capture
      const capture = this.sceneCaptureManager.getCapture(pointerId);
      const capturedScene = capture.capture(this.roomDocManager.currentSnapshot);
      
      this.activeStrokes.set(touch.identifier, {
        points: [touch.clientX, touch.clientY],
        startTime: Date.now(),
      });
      
      if (process.env.NODE_ENV === 'development') {
        console.log(
          `[MultiTouch] Touch ${touch.identifier} started at scene=${capturedScene}`
        );
      }
    });
  }
  
  handleTouchMove(event: TouchEvent): void {
    event.preventDefault();
    
    Array.from(event.changedTouches).forEach(touch => {
      const stroke = this.activeStrokes.get(touch.identifier);
      if (stroke) {
        stroke.points.push(touch.clientX, touch.clientY);
      }
    });
  }
  
  handleTouchEnd(event: TouchEvent): void {
    event.preventDefault();
    
    Array.from(event.changedTouches).forEach(touch => {
      const pointerId = `touch_${touch.identifier}`;
      const stroke = this.activeStrokes.get(touch.identifier);
      
      if (stroke) {
        // CRITICAL: Get the scene captured for THIS specific touch
        const capture = this.sceneCaptureManager.getCapture(pointerId);
        const capturedScene = capture.getRequired();
        
        const command: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: ulid(),
          tool: 'pen',
          color: '#000000',
          size: 2,
          opacity: 1,
          points: stroke.points,
          bbox: [0, 0, 100, 100], // Simplified
          startedAt: stroke.startTime,
          finishedAt: Date.now(),
          scene: capturedScene, // Scene specific to this touch!
        };
        
        if (process.env.NODE_ENV === 'development') {
          console.log(
            `[MultiTouch] Touch ${touch.identifier} committed with scene=${capturedScene}`
          );
        }
        
        this.roomDocManager.write(command);
        
        // Clean up this specific touch
        this.activeStrokes.delete(touch.identifier);
        this.sceneCaptureManager.removeCapture(pointerId);
      }
    });
  }
  
  handleTouchCancel(event: TouchEvent): void {
    // Clean up all cancelled touches
    Array.from(event.changedTouches).forEach(touch => {
      this.activeStrokes.delete(touch.identifier);
      this.sceneCaptureManager.removeCapture(`touch_${touch.identifier}`);
    });
  }
}

/**
 * Example: Chunked/streaming operations with scene preservation
 */
export class ChunkedDrawingExample {
  private sceneCapture = new SceneCapture();
  private chunkBuffer: number[] = [];
  private initialScene: SceneIdx | null = null;
  
  constructor(private roomDocManager: RoomDocManager) {}
  
  startChunkedOperation(): void {
    // Capture scene once at the start
    this.initialScene = this.sceneCapture.capture(
      this.roomDocManager.currentSnapshot
    );
    this.chunkBuffer = [];
  }
  
  addChunk(points: number[]): void {
    if (!this.sceneCapture.isValid(30000)) {
      throw new Error('[ChunkedDrawing] Scene capture expired');
    }
    
    this.chunkBuffer.push(...points);
    
    // If buffer is large enough, commit a chunk
    if (this.chunkBuffer.length > 1000) {
      this.commitChunk();
    }
  }
  
  commitChunk(): void {
    if (this.chunkBuffer.length === 0) return;
    
    // CRITICAL: All chunks use the SAME captured scene
    const capturedScene = this.sceneCapture.getRequired();
    
    const command: DrawStrokeCommit = {
      type: 'DrawStrokeCommit',
      id: ulid(),
      tool: 'pen',
      color: '#000000',
      size: 2,
      opacity: 1,
      points: [...this.chunkBuffer],
      bbox: [0, 0, 100, 100], // Simplified
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      scene: capturedScene, // Same scene for all chunks!
    };
    
    this.roomDocManager.write(command);
    this.chunkBuffer = [];
  }
  
  finishChunkedOperation(): void {
    // Commit any remaining points
    if (this.chunkBuffer.length > 0) {
      this.commitChunk();
    }
    
    // Reset capture
    this.sceneCapture.reset();
    this.initialScene = null;
  }
}