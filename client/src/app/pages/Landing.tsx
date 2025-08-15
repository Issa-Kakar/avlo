import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle.js';
import { getHttpBase } from '../utils/url.js';
import { toast } from '../utils/toast.js';
import './Landing.css';

export default function Landing() {
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);
  const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);
  const [roomId, setRoomId] = useState('');

  const handleCreateRoom = async () => {
    if (isCreating) return;
    setIsCreating(true);

    try {
      const response = await fetch(`${getHttpBase()}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (response.status === 429) {
        toast.error('Too many requests — try again shortly.');
        return;
      }

      if (!response.ok) {
        toast.error('Unable to create room. Try again.');
        return;
      }

      const data = await response.json();
      if (data.shareLink) {
        navigate(data.shareLink);
      } else if (data.roomId) {
        navigate(`/rooms/${data.roomId}`);
      }
    } catch {
      toast.error('Unable to create room. Try again.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinRoom = () => {
    setIsJoinModalOpen(true);
  };

  const handleJoinSubmit = () => {
    const trimmedId = roomId.trim();
    if (!trimmedId) {
      toast.error('Please enter a room ID');
      return;
    }

    if (!/^[A-Za-z0-9_-]+$/.test(trimmedId)) {
      toast.error('Invalid room ID format');
      return;
    }

    navigate(`/rooms/${trimmedId}`);
  };

  const handleModalClose = () => {
    setIsJoinModalOpen(false);
    setRoomId('');
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
                onClick={handleCreateRoom}
                disabled={isCreating}
              >
                Create Room
              </button>
              <button
                className="btn btn-secondary"
                data-testid="join-room"
                onClick={handleJoinRoom}
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
                <button
                  className="btn btn-primary"
                  onClick={handleCreateRoom}
                  disabled={isCreating}
                >
                  Create Room
                  <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                    />
                  </svg>
                </button>
                <button className="btn btn-secondary" onClick={handleJoinRoom}>
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
                  <canvas id="collab-canvas"></canvas>

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
            <p>No recent rooms yet. Create or join a room and it'll appear here.</p>
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

      {/* Join Room Modal */}
      {isJoinModalOpen && (
        <div
          className="modal-overlay"
          onClick={handleModalClose}
          onKeyDown={(e) => e.key === 'Escape' && handleModalClose()}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="join-modal-title"
          >
            <h2 id="join-modal-title">Join Room</h2>
            <input
              type="text"
              placeholder="Enter room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoinSubmit()}
              autoFocus
              className="modal-input"
            />
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={handleModalClose}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleJoinSubmit}>
                Join
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
