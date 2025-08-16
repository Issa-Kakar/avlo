import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle.js';
import { toast } from '../utils/toast.js';
import { listRooms, removeFromList, deleteLocalCopy } from '../features/myrooms/store.js';
import { canExtendNow, markExtendedNow } from '../features/myrooms/extend-ttl.js';
import CreateBoardDialog from '../components/entry/CreateBoardDialog.js';
import JoinBoardDialog from '../components/entry/JoinBoardDialog.js';
import './Landing.css';

type RoomRow = Awaited<ReturnType<typeof listRooms>>[number];

export default function Landing() {
  const navigate = useNavigate();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isJoinDialogOpen, setIsJoinDialogOpen] = useState(false);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>(0);

  async function refreshRooms() {
    const roomList = await listRooms();
    setRooms(roomList);
  }

  useEffect(() => {
    void refreshRooms();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const canvasArea = canvas.parentElement;
    if (!canvasArea) return;

    if (getComputedStyle(canvasArea).position === 'static') {
      canvasArea.style.position = 'relative';
    }

    function resizeCanvas() {
      const r = canvas!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.max(1, Math.floor(r.width * dpr));
      canvas!.height = Math.max(1, Math.floor(r.height * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const participants = [
      {
        name: 'QuickQuail',
        color: '#3B82F6',
        el: null as HTMLDivElement | null,
        _active: false,
        _tip: { x: 0, y: 0 },
      },
      {
        name: 'SwiftSalmon',
        color: '#14B8A6',
        el: null as HTMLDivElement | null,
        _active: false,
        _tip: { x: 0, y: 0 },
      },
      {
        name: 'BraveBear',
        color: '#EC4899',
        el: null as HTMLDivElement | null,
        _active: false,
        _tip: { x: 0, y: 0 },
      },
      {
        name: 'ElegantEagle',
        color: '#8B5CF6',
        el: null as HTMLDivElement | null,
        _active: false,
        _tip: { x: 0, y: 0 },
      },
    ];

    participants.forEach((p) => {
      const tag = document.createElement('div');
      tag.className = 'drawer-tag';
      Object.assign(tag.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        pointerEvents: 'none',
        zIndex: '20',
        opacity: '0',
        transform: 'translate(-1000px,-1000px)',
        transition: 'opacity 120ms ease',
      });

      const dot = document.createElement('div');
      Object.assign(dot.style, {
        width: '8px',
        height: '8px',
        borderRadius: '999px',
        background: p.color,
        boxShadow: '0 0 0 3px rgba(0,0,0,.05)',
      });

      const pill = document.createElement('span');
      pill.textContent = p.name;
      Object.assign(pill.style, {
        font: '12px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        color: '#fff',
        background: p.color,
        padding: '2px 8px',
        borderRadius: '999px',
        boxShadow: '0 6px 16px rgba(0,0,0,.18)',
      });

      tag.appendChild(dot);
      tag.appendChild(pill);
      canvasArea.appendChild(tag);
      p.el = tag;
    });

    const R = (a: number, b: number) => Math.random() * (b - a) + a;
    const JP = (x: number, y: number, j: number): [number, number] => [x + R(-j, j), y + R(-j, j)];
    const TAG_OFFSET_X = -4;
    const TAG_OFFSET_Y = -10;

    function linePts(
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      steps = 20,
      j = 0.24,
    ): [number, number][] {
      const pts: [number, number][] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        pts.push(JP(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, j));
      }
      return pts;
    }

    function ellipsePts(
      cx: number,
      cy: number,
      rx: number,
      ry: number,
      steps = 56,
      j = 0.24,
      start = 0,
      end = Math.PI * 2,
    ): [number, number][] {
      const pts: [number, number][] = [];
      for (let i = 0; i <= steps; i++) {
        const t = start + (end - start) * (i / steps);
        pts.push(JP(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry, j));
      }
      return pts;
    }

    function cubicPts(
      p0: [number, number],
      p1: [number, number],
      p2: [number, number],
      p3: [number, number],
      steps = 28,
      j = 0.24,
    ): [number, number][] {
      const pts: [number, number][] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const x =
          mt * mt * mt * p0[0] +
          3 * mt * mt * t * p1[0] +
          3 * mt * t * t * p2[0] +
          t * t * t * p3[0];
        const y =
          mt * mt * mt * p0[1] +
          3 * mt * mt * t * p1[1] +
          3 * mt * t * t * p2[1] +
          t * t * t * p3[1];
        pts.push(JP(x, y, j));
      }
      return pts;
    }

    function pathLen(pts: [number, number][]): number {
      let d = 0;
      for (let i = 1; i < pts.length; i++) {
        d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      return d;
    }

    function drawPath(
      pts: [number, number][],
      color: string,
      width: number,
      progress = 1,
    ): { x: number; y: number } {
      if (!pts.length) return { x: 0, y: 0 };
      const total = pathLen(pts);
      let left = total * progress;
      ctx!.strokeStyle = color;
      ctx!.lineWidth = width;
      ctx!.lineCap = 'round';
      ctx!.lineJoin = 'round';
      ctx!.beginPath();
      ctx!.moveTo(pts[0][0], pts[0][1]);
      let last = pts[0];
      for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]);
        if (left <= 0) break;
        ctx!.lineTo(pts[i][0], pts[i][1]);
        left -= seg;
        last = pts[i];
      }
      ctx!.stroke();
      return { x: last[0], y: last[1] };
    }

    function joinPaths(a: [number, number][], b: [number, number][]): [number, number][] {
      return a.length ? a.concat(b.slice(1)) : b;
    }

    function gw(ch: string, size: number): number {
      if (ch === '[' || ch === ']') return size * 0.4;
      if (ch === ',') return size * 0.26;
      return size * 0.54;
    }

    function glyph(
      ch: string,
      x: number,
      y: number,
      size: number,
    ): { w: number; s: [number, number][][] } {
      const j = 0.24;
      const half = size / 2;
      const rx = size * 0.33;
      const ry = size * 0.36;
      const w = gw(ch, size);
      const cx = x + w / 2;
      const cy = y;

      switch (ch) {
        case '[':
          return {
            w,
            s: [
              linePts(x + w * 0.72, y - half, x + w * 0.18, y - half, 16, j),
              linePts(x + w * 0.18, y - half, x + w * 0.18, y + half, 16, j),
              linePts(x + w * 0.18, y + half, x + w * 0.72, y + half, 16, j),
            ],
          };
        case ']':
          return {
            w,
            s: [
              linePts(x + w * 0.28, y - half, x + w * 0.82, y - half, 16, j),
              linePts(x + w * 0.82, y - half, x + w * 0.82, y + half, 16, j),
              linePts(x + w * 0.82, y + half, x + w * 0.28, y + half, 16, j),
            ],
          };
        case ',': {
          const p0: [number, number] = [cx + w * 0.03, y - half * 0.02];
          const p1: [number, number] = [cx + w * 0.12, y + half * 0.1];
          const p2: [number, number] = [cx - w * 0.08, y + half * 0.36];
          const p3: [number, number] = [cx - w * 0.02, y + half * 0.58];
          return { w, s: [cubicPts(p0, p1, p2, p3, 24, j)] };
        }
        case '1':
          return { w, s: [linePts(cx, y - half, cx, y + half, 24, j)] };
        case '0':
          return { w, s: [ellipsePts(cx, cy, rx * 0.95, ry * 0.95 * 1.3, 60, j)] };
        case '8': {
          const a = ry * 0.72;
          const top = ellipsePts(
            cx,
            cy - a,
            rx * 0.82,
            a,
            42,
            j,
            Math.PI / 2,
            Math.PI / 2 + Math.PI * 2,
          );
          const bottom = ellipsePts(
            cx,
            cy + a,
            rx * 0.92,
            a,
            46,
            j,
            (3 * Math.PI) / 2,
            (3 * Math.PI) / 2 + Math.PI * 2,
          );
          top[0] = [cx, cy];
          top[top.length - 1] = [cx, cy];
          bottom[0] = [cx, cy];
          return { w, s: [joinPaths(top, bottom)] };
        }
        case '5': {
          const left = x + w * 0.12;
          const right = x + w * 0.88;
          const topY = y - half;
          const midY = y + half * 0.02;

          const bar = linePts(left, topY, right, topY, 18, j);
          const down = linePts(left, topY, left, midY, 16, j);

          const cxB = (left + right) / 2;
          const rxB = ((right - left) / 2) * 1.1;
          const ryB = half * 0.68;
          const cyB = y + half * 0.32;

          const a1 = Math.PI;
          const a1End = Math.PI * 2.1;
          let arc1 = ellipsePts(cxB, cyB, rxB, ryB, 56, j, a1, a1End);
          arc1[0] = [left, midY];

          const a2End = Math.PI * 2.7;
          const arc2 = ellipsePts(cxB, cyB, rxB * 0.98, ryB * 0.96, 32, j, a1End, a2End);

          const bowl = joinPaths(arc1, arc2);

          const ex = cxB + rxB * 0.98 * Math.cos(a2End);
          const ey = cyB + ryB * 0.96 * Math.sin(a2End);
          const tail = linePts(ex, ey, ex - w * 0.02, ey - half * 0.08, 10, j);

          return { w, s: [bar, down, bowl.concat(tail)] };
        }
        case '3':
          return {
            w,
            s: [
              cubicPts(
                [x + w * 0.1, y - half * 0.45 * 1.6],
                [x + w * 0.85, y - half * 0.75 * 1.6],
                [x + w * 0.86, y - half * 0.1 * 1.6],
                [x + w * 0.26, y - half * 0.02 * 1.6],
                30,
                j,
              ),
              cubicPts(
                [x + w * 0.26, y - half * 0.02 * 1.6],
                [x + w * 0.92, y + half * 0.06 * 1.6],
                [x + w * 0.9, y + half * 0.72 * 1.6],
                [x + w * 0.18, y + half * 0.5 * 1.6],
                30,
                j,
              ),
            ],
          };
        default:
          return { w, s: [] };
      }
    }

    const seq = ['[', '1', ',', '0', ',', '8', ',', '5', ',', '3', ']'];
    let timeline: Array<{
      who: number;
      color: string;
      width: number;
      start: number;
      dur: number;
      paths: [number, number][][];
    }> = [];
    let cycleMs = 12000;
    let layout: { startX: number; baseY: number; size: number; gap: number } | null = null;

    function buildTimeline() {
      const r = canvas!.getBoundingClientRect();
      const safeW = r.width * 0.86;
      let size = Math.min(58, Math.max(28, Math.floor(r.height * 0.28)));
      const gap = (s: number) => s * 0.1;
      const totalW = (s: number) => seq.reduce((acc, ch) => acc + gw(ch, s) + gap(s), 0) - gap(s);

      if (totalW(size) > safeW) {
        size = Math.max(26, Math.floor(size * (safeW / totalW(size))));
      }

      const baseY = r.height / 2 + 4;
      const startX = (r.width - totalW(size)) / 2;

      layout = { startX, baseY, size, gap: gap(size) };

      timeline = [];
      let t = 500;
      const perGlyph = 640;
      const hold = 2200;
      let x = startX;

      seq.forEach((ch, i) => {
        const g = glyph(ch, x, baseY, size);
        const who = i % participants.length;
        timeline.push({
          who,
          color: participants[who].color,
          width: 2.1,
          start: t,
          dur: perGlyph,
          paths: g.s,
        });
        x += g.w + layout!.gap;
        t += perGlyph + 120;
      });

      cycleMs = t + hold;
    }

    const codeLines = [
      { text: '<span class="kw">def</span> <span class="fn">quicksort</span>(arr):', delay: 100 },
      {
        text: '    <span class="kw">if</span> <span class="fn">len</span>(arr) <span class="op"><=</span> <span class="num">1</span>:',
        delay: 80,
      },
      { text: '        <span class="kw">return</span> arr', delay: 70 },
      { text: '    ', delay: 50 },
      { text: '    pivot <span class="op">=</span> arr[<span class="num">0</span>]', delay: 70 },
      { text: '    left <span class="op">=</span> []', delay: 60 },
      { text: '    right <span class="op">=</span> []', delay: 60 },
      { text: '    ', delay: 50 },
      {
        text: '    <span class="kw">for</span> i <span class="kw">in</span> <span class="fn">range</span>(<span class="num">1</span>, <span class="fn">len</span>(arr)):',
        delay: 90,
      },
      {
        text: '        <span class="kw">if</span> arr[i] <span class="op"><</span> pivot:',
        delay: 80,
      },
      { text: '            left.<span class="fn">append</span>(arr[i])', delay: 70 },
      { text: '        <span class="kw">else</span>:', delay: 60 },
      { text: '            right.<span class="fn">append</span>(arr[i])', delay: 70 },
      { text: '    ', delay: 50 },
      {
        text: '    <span class="kw">return</span> <span class="fn">quicksort</span>(left) <span class="op">+</span> [pivot] <span class="op">+</span> <span class="fn">quicksort</span>(right)',
        delay: 100,
      },
      { text: '', delay: 50 },
      { text: '<span class="comment"># Test with array</span>', delay: 80 },
      {
        text: 'arr <span class="op">=</span> [<span class="num">1</span>, <span class="num">0</span>, <span class="num">8</span>, <span class="num">5</span>, <span class="num">3</span>]',
        delay: 90,
      },
      {
        text: 'sorted_arr <span class="op">=</span> <span class="fn">quicksort</span>(arr)',
        delay: 100,
      },
      {
        text: '<span class="fn">print</span>(sorted_arr)  <span class="comment"># [0, 1, 3, 5, 8]</span>',
        delay: 120,
      },
    ];

    let currentLine = 0;
    let currentChar = 0;

    function typeCode() {
      const codeContent = document.getElementById('codeContent');
      if (!codeContent) return;

      if (currentLine >= codeLines.length) {
        currentLine = 0;
        currentChar = 0;
        codeContent.innerHTML =
          '<div class="code-line"><span class="line-number">1</span><span class="code-text"></span></div>';
        setTimeout(typeCode, 2000);
        return;
      }

      const line = codeLines[currentLine];
      const fullText = line.text.replace(/<[^>]*>/g, '');

      if (currentChar < fullText.length) {
        currentChar++;
        const displayText = line.text.substring(
          0,
          line.text.length * (currentChar / fullText.length),
        );

        const lineElements = codeContent.querySelectorAll('.code-line');
        const lastLine = lineElements[lineElements.length - 1];
        const codeText = lastLine.querySelector('.code-text');
        if (codeText) {
          codeText.innerHTML = displayText + '<span class="cursor"></span>';
        }

        setTimeout(typeCode, line.delay);
      } else {
        const lineElements = codeContent.querySelectorAll('.code-line');
        const lastLine = lineElements[lineElements.length - 1];
        const codeText = lastLine.querySelector('.code-text');
        if (codeText) {
          codeText.innerHTML = line.text;
        }

        currentLine++;
        currentChar = 0;

        if (currentLine < codeLines.length) {
          const newLine = document.createElement('div');
          newLine.className = 'code-line';
          newLine.innerHTML = `<span class="line-number">${currentLine + 1}</span><span class="code-text"></span>`;
          codeContent.appendChild(newLine);
        }

        setTimeout(typeCode, 200);
      }
    }

    resizeCanvas();
    buildTimeline();

    const t0 = performance.now();

    function animate(now = performance.now()) {
      const r = canvas!.getBoundingClientRect();
      ctx!.clearRect(0, 0, r.width, r.height);

      ctx!.fillStyle = 'rgba(102,126,234,0.05)';
      for (let x = 10; x < r.width; x += 20) {
        for (let y = 10; y < r.height; y += 20) {
          ctx!.beginPath();
          ctx!.arc(x, y, 1, 0, Math.PI * 2);
          ctx!.fill();
        }
      }

      const t = (now - t0) % cycleMs;
      participants.forEach((p) => {
        p._active = false;
        if (p.el) p.el.style.opacity = '0';
      });

      timeline.forEach((task) => {
        const local = t - task.start;
        if (local < -40) return;
        const drawing = local >= 0 && local <= task.dur;
        const prog = Math.max(0, Math.min(1, local / task.dur));

        let tip: { x: number; y: number } | null = null;
        const per = 1 / task.paths.length;
        task.paths.forEach((pts, idx) => {
          const segProg = Math.max(0, Math.min(1, (prog - idx * per) / per));
          if (segProg > 0) {
            tip = drawPath(pts, task.color, task.width, Math.min(segProg, 1));
          }
        });

        if (drawing && tip) {
          const p = participants[task.who];
          p._active = true;
          p._tip = tip;
        }
      });

      const active = participants.find((p) => p._active);
      if (active && active.el && active._tip) {
        active.el.style.opacity = '1';
        active.el.style.transform = `translate(${active._tip.x + TAG_OFFSET_X}px, ${active._tip.y + TAG_OFFSET_Y}px)`;
      }

      animationFrameRef.current = requestAnimationFrame(animate);
    }

    const handleResize = () => {
      resizeCanvas();
      buildTimeline();
    };

    window.addEventListener('resize', handleResize);

    setTimeout(() => {
      typeCode();
    }, 1000);

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      participants.forEach((p) => {
        if (p.el && p.el.parentNode) {
          p.el.parentNode.removeChild(p.el);
        }
      });
    };
  }, []);

  const daysUntil = (isoString: string | undefined) => {
    if (!isoString) return null;
    const ms = new Date(isoString).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  };

  const handleOpenRoom = (roomId: string) => {
    navigate(`/rooms/${roomId}`);
  };

  const handleCopyLink = async (roomId: string) => {
    try {
      const link = `${window.location.origin}/rooms/${roomId}`;
      await navigator.clipboard.writeText(link);
      toast.success('Link copied.');
    } catch {
      toast.error('Unable to copy link.');
    }
  };

  const handleExtendRoom = async (_roomId: string) => {
    if (!canExtendNow()) {
      toast.error('Can only extend once per day.');
      return;
    }

    try {
      markExtendedNow();
      const newExpiry = new Date();
      newExpiry.setDate(newExpiry.getDate() + 14);
      toast.success(`Room extended to ${newExpiry.toLocaleDateString()}.`);
      await refreshRooms();
    } catch {
      toast.error('Failed to extend room.');
    }
  };

  const handleRemoveFromList = async (roomId: string) => {
    await removeFromList(roomId);
    toast.success('Removed from list');
    await refreshRooms();
  };

  const handleDeleteLocalCopy = async (roomId: string) => {
    await deleteLocalCopy(roomId, async () => {
      console.warn(`Would destroy local Y.Doc for room: ${roomId}`);
    });
    toast.success('Local copy deleted');
  };

  const handleCreateSuccess = (roomId: string) => {
    navigate(`/rooms/${roomId}`);
  };

  const handleJoinSuccess = (roomId: string) => {
    navigate(`/rooms/${roomId}`);
  };

  const handleCreateFromJoin = () => {
    setIsJoinDialogOpen(false);
    setIsCreateDialogOpen(true);
    // Note: We could pass a name to CreateBoardDialog if we wanted to pre-fill it
  };

  return (
    <div className="landing-page">
      <header className="header">
        <div className="container">
          <div className="header-content">
            <a href="#" className="logo">
              <div className="logo-icon">A</div>
              <span className="logo-text">Avlo</span>
            </a>

            <nav className="nav">
              <ThemeToggle />
              <button
                className="btn btn-primary"
                data-testid="create-room"
                onClick={() => setIsCreateDialogOpen(true)}
              >
                Create Room
              </button>
              <button
                className="btn btn-secondary"
                data-testid="join-room"
                onClick={() => setIsJoinDialogOpen(true)}
              >
                Join Room
              </button>
            </nav>
          </div>
        </div>
      </header>

      <section className="hero">
        <div className="container">
          <div className="hero-grid">
            <div className="hero-content">
              <h1 className="hero-title">
                Sketch ideas and
                <br />
                run code together.
                <br />
                <span className="gradient-text">No signups. Works offline.</span>
              </h1>
              <p className="hero-subtitle">
                Real-time collaborative whiteboarding meets instant code execution. Perfect for
                demos, teaching, and brainstorming — works seamlessly even when your connection
                doesn't.
              </p>
              <div className="hero-actions">
                <button className="btn btn-primary" onClick={() => setIsCreateDialogOpen(true)}>
                  Create Room
                  <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                    />
                  </svg>
                </button>
                <button className="btn btn-secondary" onClick={() => setIsJoinDialogOpen(true)}>
                  Join Room
                </button>
              </div>
            </div>

            <div className="collab-demo">
              <div className="demo-header">
                <div className="window-controls">
                  <div className="window-dot red"></div>
                  <div className="window-dot yellow"></div>
                  <div className="window-dot green"></div>
                </div>
                <span className="demo-url">avlo.io/rooms/abc123</span>
              </div>

              <div className="demo-body">
                <div className="canvas-area">
                  <canvas ref={canvasRef} id="collab-canvas"></canvas>

                  <div className="toolbar">
                    <button className="tool active">
                      <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                      </svg>
                    </button>
                    <button className="tool">
                      <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M2 10a8 8 0 1116 0 8 8 0 01-16 0zm8 6a6 6 0 100-12 6 6 0 000 12z" />
                      </svg>
                    </button>
                    <button className="tool">
                      <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4z" />
                      </svg>
                    </button>
                    <button className="tool">
                      <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                        />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="code-editor">
                  <div className="editor-header">
                    <div className="editor-tabs">
                      <div className="editor-tab active">algorithm.py</div>
                    </div>
                  </div>

                  <div className="code-content" id="codeContent">
                    <div className="code-line">
                      <span className="line-number">1</span>
                      <span className="code-text"></span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="recent-section">
        <div className="container">
          <div className="recent-header">
            <h3 className="recent-title">Recent on this device</h3>
            <div className="recent-info">
              <div className="recent-dot"></div>
              <span>Stored locally — clearing site data removes this list</span>
            </div>
          </div>

          <div className="recent-content">
            {rooms.length === 0 ? (
              <p>No recent rooms yet. Create or join a room and it'll appear here.</p>
            ) : (
              <div className="recent-rooms-list">
                {rooms.map((room) => (
                  <div key={room.roomId} className="recent-room-item">
                    <div className="room-info">
                      <div className="room-title">{room.title}</div>
                      <div className="room-expiry">
                        {room.expires_at
                          ? `Expires in ${daysUntil(room.expires_at)} days.`
                          : 'No expiry info'}
                      </div>
                    </div>
                    <div className="room-actions">
                      <button
                        onClick={() => handleOpenRoom(room.roomId)}
                        className="btn btn-sm btn-primary"
                      >
                        Open
                      </button>
                      <button
                        onClick={() => handleCopyLink(room.roomId)}
                        className="btn btn-sm btn-secondary"
                      >
                        Copy link
                      </button>
                      <button
                        onClick={() => handleExtendRoom(room.roomId)}
                        className="btn btn-sm btn-secondary"
                      >
                        Extend
                      </button>
                      <div className="room-menu">
                        <details>
                          <summary className="btn btn-sm btn-secondary">•••</summary>
                          <div className="menu-dropdown">
                            <button
                              onClick={() => handleRemoveFromList(room.roomId)}
                              className="menu-item"
                            >
                              Remove from list
                            </button>
                            <button
                              onClick={() => handleDeleteLocalCopy(room.roomId)}
                              className="menu-item"
                            >
                              Delete local copy
                            </button>
                          </div>
                        </details>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="steps-section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Simple as 1–2–3</h2>
            <p className="section-subtitle">No installation. No accounts. Just collaboration.</p>
          </div>

          <div className="steps-grid">
            <div className="step-card">
              <div className="step-icon">
                <svg width="32" height="32" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5a2 2 0 012.828 0zM8.414 15.414a2 2 0 01-2.828 0l-3-3a4 4 0 015.656-5.656l1.5 1.5a1 1 0 11-1.414 1.414l-1.5-1.5a2 2 0 00-2.828 2.828l3 3a2 2 0 002.828 0 1 1 0 111.414 1.414z"
                  />
                </svg>
              </div>
              <h3 className="step-title">Create & Share</h3>
              <p className="step-description">
                One click creates a room. Share the link to invite collaborators.
              </p>
            </div>

            <div className="step-card">
              <div className="step-icon gradient">
                <svg width="32" height="32" fill="white" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              </div>
              <h3 className="step-title">Draw & Code</h3>
              <p className="step-description">Sketch ideas and run code together in real-time.</p>
            </div>

            <div className="step-card">
              <div className="step-icon">
                <svg width="32" height="32" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
                  />
                </svg>
              </div>
              <h3 className="step-title">Works Offline</h3>
              <p className="step-description">
                Everything syncs when you're back online. No data lost.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Create Board Dialog */}
      <CreateBoardDialog
        isOpen={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
        onSuccess={handleCreateSuccess}
      />

      {/* Join Board Dialog */}
      <JoinBoardDialog
        isOpen={isJoinDialogOpen}
        onClose={() => setIsJoinDialogOpen(false)}
        onJoin={handleJoinSuccess}
        onCreateNew={handleCreateFromJoin}
      />
    </div>
  );
}
