/**
 * Example demonstrating the CORRECT pattern for scene assignment.
 * 
 * CRITICAL RULE: Scene is assigned AT COMMIT TIME using currentScene,
 * NOT captured at pointer-down. This ensures causal consistency.
 */

import * as Y from 'yjs';
import { ulid, type Stroke, type TextBlock } from '@avlo/shared';
import type { RoomDocManager } from '../room-doc-manager';

/**
 * Example: Drawing tool with proper scene assignment at commit time
 */
export class DrawingToolExample {
  private currentStroke: {
    points: number[];
    startTime: number;
  } | null = null;
  
  constructor(private roomDocManager: RoomDocManager) {}
  
  /**
   * Start collecting stroke points
   * NOTE: We do NOT capture scene here!
   */
  handlePointerDown(event: PointerEvent): void {
    // Just start collecting points, no scene capture
    this.currentStroke = {
      points: [event.clientX, event.clientY],
      startTime: Date.now(),
    };
  }
  
  handlePointerMove(event: PointerEvent): void {
    if (!this.currentStroke) return;
    
    // Collect points - still no scene involvement
    this.currentStroke.points.push(event.clientX, event.clientY);
  }
  
  /**
   * Commit stroke with scene assigned AT COMMIT TIME
   */
  handlePointerUp(_event: PointerEvent): void {
    if (!this.currentStroke) return;
    
    // Use mutate to commit the stroke
    this.roomDocManager.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const strokes = root.get('strokes') as Y.Array<Stroke>;
      
      // Get CURRENT scene at commit time!
      const sceneTicks = (root.get('meta') as Y.Map<any>).get('scene_ticks') as Y.Array<number>;
      const currentScene = sceneTicks.length;
      
      // Create stroke with current scene
      const stroke: Stroke = {
        id: ulid(),
        tool: 'pen',
        color: '#000000',
        size: 2,
        opacity: 1,
        points: this.currentStroke!.points, // Flattened points (non-null asserted after check)
        bbox: this.calculateBBox(this.currentStroke!.points),
        scene: currentScene, // CRITICAL: Scene assigned at commit time!
        createdAt: Date.now(),
        userId: 'user-id', // Would come from manager's userId
      };
      
      strokes.push([stroke]);
    });
    
    // Clean up
    this.currentStroke = null;
  }
  
  private calculateBBox(points: number[]): [number, number, number, number] {
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
 * Example: Text tool with scene assignment at commit
 */
export class TextToolExample {
  private placementStart: { x: number; y: number } | null = null;
  
  constructor(private roomDocManager: RoomDocManager) {}
  
  /**
   * Start text placement - just track position
   */
  startTextPlacement(x: number, y: number): void {
    // Just track placement position, no scene capture
    this.placementStart = { x, y };
  }
  
  /**
   * Commit text with scene assigned at commit time
   */
  commitText(content: string): void {
    if (!this.placementStart) {
      throw new Error('[TextTool] No placement started');
    }
    
    const placement = this.placementStart;
    
    // Use mutate to commit the text
    this.roomDocManager.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const texts = root.get('texts') as Y.Array<TextBlock>;
      
      // Get CURRENT scene at commit time!
      const sceneTicks = (root.get('meta') as Y.Map<any>).get('scene_ticks') as Y.Array<number>;
      const currentScene = sceneTicks.length;
      
      const textBlock: TextBlock = {
        id: ulid(),
        x: placement.x,
        y: placement.y,
        w: 200, // Estimated width
        h: 50,  // Estimated height
        content,
        color: '#000000',
        size: 16,
        scene: currentScene, // Scene assigned at commit time!
        createdAt: Date.now(),
        userId: 'user-id',
      };
      
      texts.push([textBlock]);
    });
    
    // Clean up
    this.placementStart = null;
  }
}

/**
 * Example: Clear board operation
 */
export class ClearBoardExample {
  constructor(private roomDocManager: RoomDocManager) {}
  
  /**
   * Clear board by incrementing scene
   */
  clearBoard(): void {
    this.roomDocManager.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const meta = root.get('meta') as Y.Map<any>;
      const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
      
      // Append a new tick to increment the scene
      sceneTicks.push([Date.now()]);
      
      // After this, getCurrentScene() will return the new scene
      // and all new commits will use this new scene
    });
  }
}

/**
 * Why this pattern is correct:
 * 
 * 1. CAUSAL CONSISTENCY: If a ClearBoard happens while you're drawing,
 *    your stroke lands in the new scene where it's visible. This is
 *    the desired behavior.
 * 
 * 2. SIMPLICITY: No complex scene capture management, no per-pointer
 *    tracking, no expiry concerns.
 * 
 * 3. CRDT FRIENDLY: The scene is part of the committed data, not
 *    external state that needs synchronization.
 * 
 * 4. CONCURRENT SAFETY: Multiple users can draw simultaneously and
 *    their strokes will land in whatever scene is current when they
 *    commit, maintaining consistency.
 */