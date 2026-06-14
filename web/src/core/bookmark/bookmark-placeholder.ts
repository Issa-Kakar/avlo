/**
 * Bookmark Loading Placeholder — local-only HTML elements shown while unfurl is in-flight.
 * Appended to editorHost, positioned via camera transforms each frame.
 */

import { getEditorHost } from '@/runtime/SurfaceManager';
import { useCameraStore } from '@/stores/camera-store';
import { BOOKMARK_WIDTH } from './bookmark-render';

interface PlaceholderEntry {
  el: HTMLDivElement;
  wx: number;
  wy: number;
}

const placeholders = new Map<string, PlaceholderEntry>();

const PLACEHOLDER_H = 48;

export function createPlaceholder(objectId: string, domain: string, wx: number, wy: number): void {
  const host = getEditorHost();
  if (!host) return;

  // Prevent duplicates
  const existing = placeholders.get(objectId);
  if (existing) {
    existing.el.remove();
    placeholders.delete(objectId);
  }

  const el = document.createElement('div');
  el.style.cssText = `
    pointer-events: none;
    position: absolute;
    left: 0; top: 0;
    transform-origin: 0 0;
    width: ${BOOKMARK_WIDTH}px;
    height: ${PLACEHOLDER_H}px;
  `;

  const body = document.createElement('div');
  body.style.cssText = `
    width: 100%; height: 100%;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.06);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    box-sizing: border-box;
  `;

  // Spinner
  const spinner = document.createElement('div');
  spinner.style.cssText = `
    width: 16px; height: 16px;
    border: 2px solid #e5e7eb;
    border-top-color: #9ca3af;
    border-radius: 50%;
    animation: bk-spin 0.8s linear infinite;
    flex-shrink: 0;
  `;

  // Domain label
  const label = document.createElement('span');
  label.style.cssText = `
    font: 12px Inter, sans-serif;
    color: #9ca3af;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 280px;
  `;
  label.textContent = domain;

  body.appendChild(spinner);
  body.appendChild(label);
  el.appendChild(body);

  // Inject keyframes if not already present
  if (!document.getElementById('bk-spin-style')) {
    const style = document.createElement('style');
    style.id = 'bk-spin-style';
    style.textContent = '@keyframes bk-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }

  host.appendChild(el);
  placeholders.set(objectId, { el, wx, wy });

  // Position immediately
  repositionOne(el, wx, wy);
}

export function removePlaceholder(objectId: string): void {
  const entry = placeholders.get(objectId);
  if (!entry) return;
  entry.el.remove();
  placeholders.delete(objectId);
}

export function removeAllPlaceholders(): void {
  for (const entry of placeholders.values()) {
    entry.el.remove();
  }
  placeholders.clear();
}

export function repositionAllPlaceholders(): void {
  if (placeholders.size === 0) return;
  for (const { el, wx, wy } of placeholders.values()) {
    repositionOne(el, wx, wy);
  }
}

function repositionOne(el: HTMLDivElement, wx: number, wy: number): void {
  const { scale, pan } = useCameraStore.getState();
  const cx = (wx - pan.x) * scale;
  const cy = (wy - pan.y) * scale;
  el.style.transform = `translate(${cx}px, ${cy}px) scale(${scale})`;
}
