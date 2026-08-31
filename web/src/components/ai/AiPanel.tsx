import { AI_DATA_PART_QUOTA, AI_MSGS_PER_DAY, type AiQuotaVerdict, normalizeRoomId } from '@avlo/shared';
import { getRouteApi } from '@tanstack/react-router';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { closeAiPanel, selectAiQuota, useAiPanelStore } from '@/stores/ai-panel-store';
import { useAuthStore } from '@/stores/auth-store';
import { SignInButton } from '../auth/SignInButton';
import { useAiChat } from './useAiChat';
import './AiPanel.css';

/**
 * The AI panel — a pure overlay over the canvas on the right edge, spanning
 * between the TopBarRight pill and the ZoomControls (fixed top/right/bottom,
 * z at the chrome tier). Chat input is a native <textarea>, so
 * keyboard-manager's Guard 1 keeps every canvas shortcut inert while typing;
 * Escape is handled locally (the global handler skips focused inputs).
 *
 * Anon users get the sign-in CTA — the account gate is enforced server-side
 * (edge 401); this is the matching UX. Mounted lazily (React.lazy in
 * TopBarRight) so agents/ai stay out of the main chunk.
 */

const route = getRouteApi('/room/$roomId');

export default function AiPanel() {
  const isAnon = useAuthStore((s) => s.isAnon);
  return (
    <div className="ai-panel" role="dialog" aria-label="AI assistant">
      <header className="ai-panel-header">
        <span className="ai-panel-title">Assistant</span>
        <button type="button" className="ai-panel-header-btn" onClick={closeAiPanel} title="Close" aria-label="Close AI panel">
          ✕
        </button>
      </header>
      {isAnon ? <SignedOutBody /> : <ChatBody />}
    </div>
  );
}

function SignedOutBody() {
  return (
    <div className="ai-panel-signin">
      <p>Sign in with Google to use the assistant.</p>
      <SignInButton variant="canvas" />
    </div>
  );
}

function ChatBody() {
  const { roomId: rawRoomId } = route.useParams();
  const roomId = normalizeRoomId(rawRoomId);
  if (!roomId) return null;
  return <Chat roomId={roomId} />;
}

function Chat({ roomId }: { roomId: NonNullable<ReturnType<typeof normalizeRoomId>> }) {
  const chat = useAiChat(roomId);
  const quota = useAiPanelStore(selectAiQuota);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the newest message visible while streaming.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll depends on message flow, not identity
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.isStreaming]);

  const submit = () => {
    if (chat.send(draft)) setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      (e.target as HTMLTextAreaElement).blur();
      closeAiPanel();
    }
  };

  return (
    <>
      <div className="ai-panel-messages" ref={listRef}>
        {chat.messages.length === 0 && (
          <p className="ai-panel-empty">
            Ask for anything on the board — “add three sticky notes with retro ideas”, “connect these”, “lay out a login flow”.
          </p>
        )}
        {chat.messages.map((m) => (
          <div key={m.id} className={`ai-msg ai-msg-${m.role}`}>
            {m.parts.map((part, i) => {
              if (part.type === 'text') {
                return part.text ? <p key={i}>{part.text}</p> : null;
              }
              if (part.type.startsWith('tool-')) {
                return <ToolRow key={i} part={part as { type: string; input?: unknown; state?: string }} />;
              }
              if (part.type === `data-${AI_DATA_PART_QUOTA}`) {
                const verdict = (part as { data?: AiQuotaVerdict }).data;
                if (verdict && !verdict.ok) {
                  return (
                    <p key={i} className="ai-msg-quota">
                      Rate limit — retry in {Math.ceil(verdict.retryAfterMs / 1000)}s
                    </p>
                  );
                }
              }
              return null;
            })}
          </div>
        ))}
        {chat.isRecovering && <p className="ai-panel-hint">Recovering the last response…</p>}
        {chat.connectionError && <p className="ai-panel-hint">Connection problem — retrying…</p>}
      </div>

      <div className="ai-panel-composer">
        <textarea
          className="ai-panel-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask the assistant…"
          rows={2}
          maxLength={4000}
        />
        <div className="ai-panel-actions">
          {chat.isStreaming ? (
            <button type="button" className="ai-panel-send" onClick={() => chat.stop()}>
              Stop
            </button>
          ) : (
            <button type="button" className="ai-panel-send" onClick={submit} disabled={!draft.trim() || chat.busy}>
              Send
            </button>
          )}
          <button type="button" className="ai-panel-clear" onClick={chat.clear} title="Clear conversation">
            Clear
          </button>
        </div>
      </div>

      <footer className="ai-panel-footer">{quota ? `${quota.dayMsgsUsed}/${AI_MSGS_PER_DAY} messages today` : ' '}</footer>
    </>
  );
}

/** One tool call row — shows the action intents while/after the model acts. */
function ToolRow({ part }: { part: { type: string; input?: unknown; state?: string } }) {
  const name = part.type.slice('tool-'.length);
  const input = part.input as { actions?: { intent?: string; _type?: string }[] } | undefined;
  const intents = input?.actions?.map((a) => a.intent ?? a._type).filter(Boolean) as string[] | undefined;
  return (
    <div className="ai-msg-tool">
      <span className="ai-msg-tool-name">{name === 'canvas' ? 'canvas actions' : name}</span>
      {intents?.slice(0, 8).map((intent, i) => (
        <span key={i} className="ai-msg-tool-intent">
          {intent}
        </span>
      ))}
      {intents && intents.length > 8 && <span className="ai-msg-tool-intent">+{intents.length - 8} more</span>}
    </div>
  );
}
