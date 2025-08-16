// Phase 2 shell: no drawing/editor execution; advanced controls are presentational only.
import { useParams } from 'react-router-dom';
import { useState, useEffect, useCallback, useRef } from 'react';
import { AppShell } from '../components/AppShell.js';
import { SplitPane } from '../components/SplitPane.js';
import { useConnectionState } from '../state/connection.js';
import { isCoarsePointer, isNarrow, onResize } from '../utils/device.js';
import { toast } from '../utils/toast.js';
import { useRoom } from '../hooks/useRoom.js';
import { getInitials } from '../state/presence.js';
import { RemoteCursors } from '../components/RemoteCursors.js';
import { recordRoomOpen } from '../features/myrooms/integrations.js';
import { getHttpBase } from '../utils/url.js';
import { ReadonlyBanner } from '../../ui/limits/ReadonlyBanner.js';
import { isLimitsUIEnabled } from '../../limits/index.js';
import './Room.css';

export default function Room() {
  console.log('🔴 UNIQUE_ROOM_COMPONENT_LOG_TEST_12345 🔴');
  const { id } = useParams<{ id: string }>();
  console.log('[Room] Component render - id from useParams:', id);
  const [mobileViewOnly, setMobileViewOnly] = useState(false);
  const [currentTool, setCurrentTool] = useState('pen');
  const [showPalette, setShowPalette] = useState(false);
  // const [isFirstToolSelection, setIsFirstToolSelection] = useState(true); // Removed - using individual tool selections
  const [isFirstPenSelection, setIsFirstPenSelection] = useState(true);
  const [isFirstHighlighterSelection, setIsFirstHighlighterSelection] = useState(true);
  const [paletteManuallyOpened, setPaletteManuallyOpened] = useState(false);
  const [penColor, setPenColor] = useState('hsl(230, 100%, 50%)');
  const [highlighterColor, setHighlighterColor] = useState('hsl(60, 100%, 50%)');
  const [penSize, setPenSize] = useState(4);
  const [highlighterSize, setHighlighterSize] = useState(8);

  // Cached values to avoid expensive calculations on every render
  const [penHue, setPenHue] = useState(230);
  const [highlighterHue, setHighlighterHue] = useState(60);

  // Get current tool's color and size
  const getCurrentColor = () => {
    if (currentTool === 'pen') return penColor;
    if (currentTool === 'highlighter') return highlighterColor;
    return penColor; // default
  };

  const getCurrentSize = () => {
    if (currentTool === 'pen') return penSize;
    if (currentTool === 'highlighter') return highlighterSize;
    return penSize; // default
  };

  const setCurrentColor = (color: string, hue?: number) => {
    if (currentTool === 'pen') {
      setPenColor(color);
      if (hue !== undefined) setPenHue(hue);
    } else if (currentTool === 'highlighter') {
      setHighlighterColor(color);
      if (hue !== undefined) setHighlighterHue(hue);
    }
  };

  const getCurrentHue = () => {
    if (currentTool === 'pen') return penHue;
    if (currentTool === 'highlighter') return highlighterHue;
    return penHue; // default
  };

  const setCurrentSize = (size: number) => {
    if (currentTool === 'pen') {
      setPenSize(size);
    } else if (currentTool === 'highlighter') {
      setHighlighterSize(size);
    }
  };
  const [isToolbarRightSide, setIsToolbarRightSide] = useState(false);
  const [isToolbarCollapsed, setIsToolbarCollapsed] = useState(false);
  const [isMinimapCollapsed, setIsMinimapCollapsed] = useState(false);
  const [users, setUsers] = useState<
    Array<{
      id: string;
      name: string;
      color: string;
      initials: string;
      activity?: 'idle' | 'drawing' | 'typing';
    }>
  >([]);

  // Validate room ID
  const isValidRoomId = id && /^[A-Za-z0-9_-]+$/.test(id);
  console.log('[Room] Validation - id:', id, 'isValidRoomId:', isValidRoomId);

  // Validate and setup room
  const roomHandles = useRoom(id);
  const connectionState = useConnectionState(roomHandles?.provider, roomHandles?.readOnly);

  // Record room visit for "My Rooms" list (Phase 9 integration)
  useEffect(() => {
    console.log('[Room] useEffect triggered - id:', id, 'isValidRoomId:', isValidRoomId);
    if (!id || !isValidRoomId) {
      console.log('[Room] Skipping record visit - invalid conditions');
      return;
    }

    const recordVisit = async () => {
      console.log('[Room] Recording visit for room:', id);
      try {
        // Fetch room metadata from server
        const response = await fetch(`${getHttpBase()}/api/rooms/${id}/metadata`);
        console.log('[Room] Metadata response status:', response.status);

        if (response.ok) {
          const metadata = await response.json();
          console.log('[Room] Got metadata:', metadata);
          await recordRoomOpen({
            roomId: id,
            title: metadata.title,
            expires_at: metadata.expires_at,
          });
          console.log('[Room] Recorded room visit with metadata');
        } else {
          // If metadata fetch fails, still record the visit with basic info
          console.log('[Room] Metadata fetch failed, using fallback');
          await recordRoomOpen({
            roomId: id,
            title: `Room ${id}`,
          });
          console.log('[Room] Recorded room visit with fallback');
        }
      } catch (error) {
        console.warn('[Room] Failed to record room visit:', error);
        // Still try to record basic visit info
        try {
          await recordRoomOpen({
            roomId: id,
            title: `Room ${id}`,
          });
          console.log('[Room] Recorded room visit with final fallback');
        } catch (fallbackError) {
          console.error('[Room] Failed to record room visit (fallback):', fallbackError);
        }
      }
    };

    recordVisit();
  }, [id, isValidRoomId]);

  // Combined view-only state (mobile OR read-only from server)
  const viewOnly = mobileViewOnly || roomHandles?.readOnly || false;

  // Update presence list from awareness
  useEffect(() => {
    if (!roomHandles?.awareness) return;

    const updateUsers = () => {
      const states = roomHandles.awareness.getStates();
      const userList: typeof users = [];

      states.forEach((state, clientId) => {
        const user = state.user;
        if (user) {
          userList.push({
            id: clientId.toString(),
            name: user.name || 'Anonymous',
            color: user.color || '#94A3B8',
            initials: getInitials(user.name || 'Anonymous'),
            activity: user.activity || 'idle',
          });
        }
      });

      setUsers(userList);
    };

    updateUsers();
    roomHandles.awareness.on('change', updateUsers);

    return () => {
      roomHandles.awareness.off('change', updateUsers);
    };
  }, [roomHandles?.awareness]);

  // Expose Y.Doc and awareness for testing in development
  useEffect(() => {
    if (roomHandles) {
      console.log('[Room] Exposing test handles to window');
      (window as any).__testYDoc = roomHandles.ydoc;
      (window as any).__testAwareness = roomHandles.awareness;
      (window as any).__testProvider = roomHandles.provider;
    } else {
      console.log('[Room] No roomHandles to expose');
    }
    return () => {
      console.log('[Room] Cleaning up test handles');
      (window as any).__testYDoc = undefined;
      (window as any).__testAwareness = undefined;
      (window as any).__testProvider = undefined;
    };
  }, [roomHandles]);

  // Update cursor position (throttled to ~30Hz)
  const updateCursor = useCallback(() => {
    if (!roomHandles?.awareness) return;

    let lastUpdate = 0;
    const throttleMs = 33; // ~30Hz

    const handleMouseMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastUpdate < throttleMs) return;
      lastUpdate = now;

      const board = document.getElementById('board');
      if (!board) return;

      const rect = board.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      roomHandles.awareness.setLocalStateField('user', {
        ...roomHandles.awareness.getLocalState()?.user,
        cursor: { x, y },
      });
    };

    const handleMouseLeave = () => {
      roomHandles.awareness.setLocalStateField('user', {
        ...roomHandles.awareness.getLocalState()?.user,
        cursor: null,
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [roomHandles?.awareness]);

  useEffect(() => {
    const cleanup = updateCursor();
    return cleanup;
  }, [updateCursor]);

  // Check device capabilities for mobile view-only
  useEffect(() => {
    const checkDevice = () => {
      setMobileViewOnly(isCoarsePointer() || isNarrow());
    };
    checkDevice();
    const cleanup = onResize(checkDevice);
    return cleanup;
  }, []);

  // Cursor styling based on current tool (debounced for performance)
  const cursorUpdateTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = document.getElementById('board');
    if (!canvas) return;

    const setCursorForTool = (tool: string) => {
      if (tool === 'pen') {
        const svgDot = encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
             <circle cx="10" cy="10" r="2.5" fill="black"/>
           </svg>`,
        );
        canvas.style.cursor = `url("data:image/svg+xml;utf8,${svgDot}") 10 10, crosshair`;
      } else if (tool === 'highlighter') {
        // Use cached hue value for better performance
        const hue = highlighterHue;
        const svgHighlighter = encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 24 16">
             <rect x="0" y="0" width="24" height="16" fill="hsl(${hue}, 70%, 60%)" fill-opacity="0.4" stroke="hsl(${hue}, 100%, 40%)" stroke-width="2"/>
           </svg>`,
        );
        canvas.style.cursor = `url("data:image/svg+xml;utf8,${svgHighlighter}") 12 8, crosshair`;
      } else if (tool === 'eraser') {
        const svgEraser = encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
             <circle cx="12" cy="12" r="9" fill="none" stroke="black" stroke-width="2"/>
           </svg>`,
        );
        canvas.style.cursor = `url("data:image/svg+xml;utf8,${svgEraser}") 12 12, auto`;
      } else {
        canvas.style.cursor = 'default';
      }
    };

    // Debounce cursor updates to prevent excessive DOM manipulation
    if (cursorUpdateTimeoutRef.current) {
      window.clearTimeout(cursorUpdateTimeoutRef.current);
    }

    cursorUpdateTimeoutRef.current = window.setTimeout(() => {
      setCursorForTool(currentTool);
    }, 16); // ~60fps

    return () => {
      if (cursorUpdateTimeoutRef.current) {
        window.clearTimeout(cursorUpdateTimeoutRef.current);
      }
    };
  }, [currentTool, highlighterHue]);

  // Keyboard handlers for palette and tool selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '1') {
        setCurrentTool('pen');
        if (isFirstPenSelection) {
          setShowPalette(true);
          setIsFirstPenSelection(false);
          // setIsFirstToolSelection(false);
        }
      } else if (e.key === '2') {
        setCurrentTool('highlighter');
        if (isFirstHighlighterSelection) {
          setShowPalette(true);
          setIsFirstHighlighterSelection(false);
          // setIsFirstToolSelection(false);
        }
      } else if (e.key === '3') {
        setCurrentTool('eraser');
        setShowPalette(false);
        // setIsFirstToolSelection(false);
      } else if (e.key.toLowerCase() === 'c' && currentTool === 'pen' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setPaletteManuallyOpened(true);
        setShowPalette(true);
      } else if (
        e.key.toLowerCase() === 'h' &&
        currentTool === 'highlighter' &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        setPaletteManuallyOpened(true);
        setShowPalette(true);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [currentTool, isFirstPenSelection, isFirstHighlighterSelection]);

  // Auto-hide palette after a delay (only if not manually opened)
  useEffect(() => {
    if (showPalette && !paletteManuallyOpened) {
      const timer = setTimeout(() => {
        setShowPalette(false);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [showPalette, paletteManuallyOpened]);

  // Hide palette when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const palette = document.getElementById('palette');
      if (palette && !palette.contains(event.target as Node) && showPalette) {
        setShowPalette(false);
        setPaletteManuallyOpened(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPalette]);

  // Load saved toolbar and minimap preferences
  useEffect(() => {
    const savedSide = localStorage.getItem('toolbarSide');
    const savedCollapsed = localStorage.getItem('toolbarCollapsed');
    const savedMinimapCollapsed = localStorage.getItem('minimapCollapsed');

    if (savedSide === 'right') {
      setIsToolbarRightSide(true);
    }

    if (savedCollapsed === 'true') {
      setIsToolbarCollapsed(true);
    }

    if (savedMinimapCollapsed === 'true') {
      setIsMinimapCollapsed(true);
    }
  }, []);

  if (!isValidRoomId) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          fontFamily: 'var(--font-ui)',
          color: 'var(--ink)',
          background: 'var(--bg)',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h1>Invalid Room ID</h1>
          <p>Room IDs can only contain letters, numbers, hyphens, and underscores.</p>
        </div>
      </div>
    );
  }

  const handleExport = () => {
    toast.info('Export will be available in a later phase.');
  };

  const handleRun = () => {
    toast.info('Code execution will be available in a later phase.');
  };

  const handleToolClick = (toolName: string, toolId: string) => {
    if (toolId === 'swap-side') {
      const newIsRightSide = !isToolbarRightSide;
      setIsToolbarRightSide(newIsRightSide);
      localStorage.setItem('toolbarSide', newIsRightSide ? 'right' : 'left');
      return;
    }

    if (viewOnly) {
      if (mobileViewOnly) {
        toast.info('Drawing tools are view-only on mobile devices.');
      } else {
        toast.info('Room is read-only due to size limit.');
      }
    } else {
      setCurrentTool(toolId);

      // Smart palette logic for first-time selections
      if (toolId === 'pen' && isFirstPenSelection) {
        setShowPalette(true);
        setIsFirstPenSelection(false);
        // setIsFirstToolSelection(false);
      } else if (toolId === 'highlighter' && isFirstHighlighterSelection) {
        setShowPalette(true);
        setIsFirstHighlighterSelection(false);
        // setIsFirstToolSelection(false);
      } else if (toolId === 'eraser') {
        setShowPalette(false);
        setPaletteManuallyOpened(false);
        // setIsFirstToolSelection(false);
      } else if (toolId !== 'pen' && toolId !== 'highlighter') {
        setShowPalette(false);
        setPaletteManuallyOpened(false);
      }

      toast.info(`${toolName} will be available in a later phase.`);
    }
  };

  const handleZoomClick = (_action: 'in' | 'out') => {
    toast.info('Zoom controls will be available in a later phase.');
  };

  const BoardContainer = () => (
    <section className="canvas-wrap" role="main" aria-label="Whiteboard canvas">
      <div className="grid" aria-hidden="true" />
      <canvas id="board" />

      {/* Remote cursors overlay */}
      <RemoteCursors
        awareness={roomHandles?.awareness}
        maxCursors={20}
        showTrails={!mobileViewOnly}
      />

      {/* Tool Rail - presentational only */}
      <div
        className={`tool-rail-container ${isToolbarRightSide ? 'right-side' : ''} ${isToolbarCollapsed ? 'collapsed' : ''}`}
        id="toolRailContainer"
      >
        <div className="tool-rail-wrapper">
          <div className="tool-rail" role="group" aria-label="Drawing tools">
            <button
              className={`tool ${currentTool === 'pen' ? 'active' : ''}`}
              data-tool="pen"
              aria-disabled={viewOnly}
              title="Pen (1)"
              onClick={() => handleToolClick('Pen tool', 'pen')}
              onMouseEnter={() => {
                // Keep palette open when hovering over palette
                if (showPalette) {
                  setPaletteManuallyOpened(true);
                }
              }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
              </svg>
              <div
                className="color-indicator"
                style={{ background: penColor }}
                onClick={(e) => {
                  e.stopPropagation();
                  setPaletteManuallyOpened(true);
                  setShowPalette(true);
                }}
              />
            </button>
            <button
              className={`tool ${currentTool === 'highlighter' ? 'active' : ''}`}
              data-tool="highlighter"
              aria-disabled={viewOnly}
              title="Highlighter (2)"
              onClick={() => handleToolClick('Highlighter tool', 'highlighter')}
              onMouseEnter={() => {
                // Keep palette open when hovering over palette
                if (showPalette) {
                  setPaletteManuallyOpened(true);
                }
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m9 11-6 6v3h9l3-3" />
                <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
              </svg>
              <div
                className="color-indicator"
                style={{ background: highlighterColor }}
                onClick={(e) => {
                  e.stopPropagation();
                  setPaletteManuallyOpened(true);
                  setShowPalette(true);
                }}
              />
            </button>
            <button
              className={`tool ${currentTool === 'eraser' ? 'active' : ''}`}
              data-tool="eraser"
              aria-disabled={viewOnly}
              title="Eraser (3)"
              onClick={() => handleToolClick('Eraser tool', 'eraser')}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                <path d="M22 21H7" />
                <path d="m5 11 9 9" />
              </svg>
            </button>
            <button
              className={`tool ${currentTool === 'stamps' ? 'active' : ''}`}
              data-tool="stamps"
              aria-disabled={viewOnly}
              title="Stamps"
              onClick={() => handleToolClick('Stamps tool', 'stamps')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <circle cx="17.5" cy="17.5" r="3.5" />
              </svg>
            </button>
            <div className="tool-sep" />
            <button
              className={`tool ${currentTool === 'pan' ? 'active' : ''}`}
              data-tool="pan"
              aria-disabled={viewOnly}
              title="Pan (Space)"
              onClick={() => handleToolClick('Pan tool', 'pan')}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
                <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
                <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
                <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
              </svg>
            </button>
            <button
              className="tool"
              data-tool="swap-side"
              title="Move toolbar"
              onClick={() => handleToolClick('Move toolbar', 'swap-side')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {isToolbarRightSide ? (
                  <>
                    <path d="m11 17-5-5 5-5" />
                    <path d="m18 17-5-5 5-5" />
                  </>
                ) : (
                  <>
                    <path d="m6 17 5-5-5-5" />
                    <path d="m13 17 5-5-5-5" />
                  </>
                )}
              </svg>
            </button>
            <div className="tool-sep" />
            <button
              className="tool"
              data-tool="undo"
              aria-disabled={viewOnly}
              title="Undo (Ctrl/Cmd+Z)"
              onClick={() => handleToolClick('Undo', 'undo')}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
            <button
              className="tool"
              data-tool="redo"
              aria-disabled={viewOnly}
              title="Redo (Ctrl/Cmd+Y)"
              onClick={() => handleToolClick('Redo', 'redo')}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </button>
            <button
              className="tool"
              data-tool="newpage"
              aria-disabled={viewOnly}
              title="Clear board (Ctrl/Cmd+K)"
              onClick={() => handleToolClick('Clear board', 'newpage')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z" />
                <path d="M15 3v4a2 2 0 0 0 2 2h4" />
              </svg>
            </button>
          </div>
          <button
            className="toolbar-collapse-btn"
            id="toolbarCollapseBtn"
            aria-label={isToolbarCollapsed ? 'Expand toolbar' : 'Collapse toolbar'}
            onClick={() => {
              const newIsCollapsed = !isToolbarCollapsed;
              setIsToolbarCollapsed(newIsCollapsed);
              localStorage.setItem('toolbarCollapsed', newIsCollapsed.toString());
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {isToolbarCollapsed ? <path d="m6 9 6 6 6-6" /> : <path d="m18 15-6-6-6 6" />}
            </svg>
          </button>
        </div>
      </div>

      {/* Dynamic color palette that appears when tool is selected */}
      <div
        className={`palette ${showPalette ? 'show' : ''}`}
        id="palette"
        aria-label="Stroke settings"
      >
        <div
          className="palette-help"
          id="paletteHelp"
          style={{ display: isFirstPenSelection || isFirstHighlighterSelection ? 'block' : 'none' }}
        >
          First time? Choose your color!
        </div>
        <div className="color-picker-wrap">
          <h6>Color</h6>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              type="range"
              className="color-slider"
              id="colorSlider"
              min="0"
              max="360"
              value={getCurrentHue()}
              aria-label="Color picker"
              onInput={(e) => {
                const hue = parseInt(e.currentTarget.value);
                const newColor = `hsl(${hue}, 100%, 50%)`;
                setCurrentColor(newColor, hue);
              }}
              onChange={(e) => {
                const hue = parseInt(e.target.value);
                const newColor = `hsl(${hue}, 100%, 50%)`;
                setCurrentColor(newColor, hue);
              }}
            />
            <div
              className="color-preview"
              id="colorPreview"
              style={{ background: getCurrentColor() }}
            ></div>
          </div>
        </div>
        <div className="size-wrap">
          <h6>Size</h6>
          <input
            type="range"
            className="size-slider"
            id="sizeSlider"
            min="1"
            max="20"
            step="1"
            value={getCurrentSize()}
            aria-label="Brush size"
            style={{
              background: `linear-gradient(90deg, var(--accent) ${((getCurrentSize() - 1) / 19) * 100}%, var(--border) ${((getCurrentSize() - 1) / 19) * 100}%)`,
            }}
            onInput={(e) => {
              const size = parseInt(e.currentTarget.value);
              setCurrentSize(size);
            }}
            onChange={(e) => {
              const size = parseInt(e.target.value);
              setCurrentSize(size);
            }}
          />
        </div>
      </div>

      <aside
        className={`minimap ${isMinimapCollapsed ? 'collapsed' : ''}`}
        aria-label="Minimap"
        aria-expanded={!isMinimapCollapsed}
        id="minimap"
      >
        <div
          className="minimap-header"
          id="minimapHeader"
          onClick={() => {
            const newCollapsed = !isMinimapCollapsed;
            setIsMinimapCollapsed(newCollapsed);
            localStorage.setItem('minimapCollapsed', newCollapsed.toString());
          }}
        >
          Minimap
          <button
            className="mini-toggle"
            id="minimapToggle"
            aria-label={isMinimapCollapsed ? 'Expand minimap' : 'Collapse minimap'}
            onClick={(e) => {
              e.stopPropagation();
              const newCollapsed = !isMinimapCollapsed;
              setIsMinimapCollapsed(newCollapsed);
              localStorage.setItem('minimapCollapsed', newCollapsed.toString());
            }}
          >
            <svg className="icon icon-stroke arrow" viewBox="0 0 20 20">
              <path d="M6 8l4 4 4-4" />
            </svg>
          </button>
        </div>
        <div
          className="minimap-body"
          style={{
            position: 'relative',
            width: '100%',
            height: 'calc(100% - 28px)',
            background: '#fff',
          }}
        >
          <div className="mini-viewport"></div>
        </div>
      </aside>

      {/* Zoom bar - presentational only */}
      <div className="zoombar" role="group" aria-label="Zoom controls">
        <div className="zoom-top">
          <button
            className="zoombtn"
            id="zoomOut"
            title="Zoom out (−)"
            aria-disabled={viewOnly}
            onClick={() => handleZoomClick('out')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14" />
            </svg>
          </button>
          <div className="zoom-divider-v" aria-hidden="true" />
          <button
            className="zoombtn"
            id="zoomIn"
            title="Zoom in (+)"
            aria-disabled={viewOnly}
            onClick={() => handleZoomClick('in')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          </button>
        </div>
        <div className="zoom-bottom">
          <span id="zoomLabel">100%</span>
        </div>
      </div>
    </section>
  );

  const EditorContainer = () => (
    <aside className="editor">
      <div className="editor-header">
        <div className="tabs">
          <div className="tab active">algorithm.py</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div className="lang">
            <button
              className="on"
              id="py"
              onClick={() => toast.info('Language switching will be available in a later phase.')}
            >
              Python
            </button>
            <button
              id="js"
              onClick={() => toast.info('Language switching will be available in a later phase.')}
            >
              JavaScript
            </button>
          </div>
          <button
            className="run"
            id="runBtn"
            data-testid="run"
            aria-disabled="true"
            onClick={handleRun}
          >
            <svg className="icon" width="16" height="16" viewBox="0 0 20 20">
              <path fill="currentColor" d="M6 4l10 6-10 6z" />
            </svg>
            Run
          </button>
        </div>
      </div>
      <pre className="code" id="code">{`# quicksort (demo)
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[0]
    left  = [x for x in arr[1:] if x < pivot]
    right = [x for x in arr[1:] if x >= pivot]
    return quicksort(left) + [pivot] + quicksort(right)

nums = [1,0,8,5,3]
print('sorted:', quicksort(nums))`}</pre>

      {/* AI Chat - presentational only */}
      <section
        className="ai-chat"
        id="aiChat"
        aria-label="AI Assistant"
        onClick={() => toast.info('AI Assistant will be available in a later phase.')}
      >
        <div className="ai-chat-header">
          <div className="ai-chat-title">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3l2 7h7l-5.5 4 2 7L12 17l-5.5 4 2-7L3 10h7l2-7z" />
            </svg>
            AI Assistant
          </div>
        </div>
        <div
          style={{
            flex: 1,
            padding: '12px',
            fontSize: '12px',
            color: '#94A3B8',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          AI features coming soon
        </div>
      </section>

      {/* Console - presentational only */}
      <section className="console" id="console" aria-label="Output panel">
        <div className="console-header">
          <div className="console-tabs" role="tablist" aria-label="Console tabs">
            <div className="console-tab" role="tab" aria-selected="false">
              PROBLEMS
            </div>
            <div className="console-tab active" role="tab" aria-selected="true">
              OUTPUT
            </div>
            <div className="console-tab" role="tab" aria-selected="false">
              DEBUG CONSOLE
            </div>
            <div className="console-tab" role="tab" aria-selected="false">
              TERMINAL
            </div>
          </div>
        </div>
        <div className="console-body">
          <div id="consoleOutput" role="log" aria-live="polite" />
        </div>
      </section>

      <div className="statusbar">
        <span>Ln 1, Col 1</span>
        <span>UTF-8</span>
        <span>Spaces: 2</span>
        <span>Python</span>
      </div>
    </aside>
  );

  // Handle export button click
  useEffect(() => {
    const exportBtn = document.getElementById('export');
    if (exportBtn) {
      exportBtn.addEventListener('click', handleExport);
      return () => exportBtn.removeEventListener('click', handleExport);
    }
  }, []);

  return (
    <AppShell
      connectionState={connectionState}
      users={users}
      roomTitle={`Room ${id}`}
      roomStats={roomHandles?.roomStats}
    >
      {/* Phase 8: Read-only banner */}
      {isLimitsUIEnabled() && viewOnly && roomHandles?.readOnly && (
        <ReadonlyBanner
          isVisible={true}
          onCreateRoom={() =>
            toast.info('Create room functionality will be available in a later phase.')
          }
        />
      )}

      <SplitPane
        left={<BoardContainer />}
        right={<EditorContainer />}
        initialRatio={0.7}
        storageKey="room-split"
      />
    </AppShell>
  );
}
