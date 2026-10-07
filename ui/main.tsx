import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { RuntimeEvent } from '../src/events/types.js';
import type { Fact } from '../src/memory/store.js';
import type { RuntimePacket } from '../src/runtime/runtime.js';
import './style.css';

const examples = [
  'What can this runtime do?',
  'Remember that the project codename is Orion.',
  'What is 843 * 27?',
];
interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

function App() {
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  );
  const [session, setSession] = useState('—');
  const [provider, setProvider] = useState('—');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    );
    socket.current = ws;
    ws.onopen = () => setConnection('connected');
    ws.onclose = () => {
      setConnection('disconnected');
      setBusy(false);
      setResetting(false);
      setError('Connection closed. Reload to start a fresh session; saved facts remain.');
    };
    ws.onerror = () => setError('Cannot reach the runtime. Check that the server is running.');
    ws.onmessage = (event) => {
      const packet = JSON.parse(event.data as string) as RuntimePacket;
      if (packet.type === 'event') {
        const item = packet.event;
        if (item.type === 'session.started') {
          setSession(item.sessionId);
          setProvider(item.payload.provider);
          setMessages([]);
          setEvents([item]);
          setResetting(false);
          setError('');
        } else setEvents((previous) => [...previous.slice(-199), item]);
      } else if (packet.type === 'response') {
        setMessages((previous) => [
          ...previous.slice(-99),
          { role: 'assistant', text: packet.text },
        ]);
        setBusy(false);
      } else if (packet.type === 'memory') setFacts(packet.facts);
      else if (packet.type === 'error') {
        setError(
          packet.code === 'REQUEST_FAILED'
            ? 'The request failed. Check provider configuration or retry.'
            : `Request rejected: ${packet.code}`,
        );
        if (packet.code !== 'BUSY') setBusy(false);
        setResetting(false);
      }
    };
    return () => {
      ws.onclose = null;
      ws.close();
    };
  }, []);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, busy]);

  const enabled = connection === 'connected' && !busy && !resetting;
  const send = (content = text) => {
    if (!enabled || !content.trim() || socket.current?.readyState !== WebSocket.OPEN) return;
    socket.current.send(JSON.stringify({ type: 'chat', text: content.trim() }));
    setMessages((previous) => [...previous.slice(-99), { role: 'user', text: content.trim() }]);
    setBusy(true);
    setText('');
    setError('');
  };
  const reset = () => {
    if (!enabled || socket.current?.readyState !== WebSocket.OPEN) return;
    setResetting(true);
    socket.current.send(JSON.stringify({ type: 'session.reset' }));
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          <span className="mark">
            <svg viewBox="0 0 20 20" width="19" height="19" aria-hidden="true">
              <path
                d="M4 16 16 4M5 4h11v11"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>{' '}
          Runtime <span className="badge">REFERENCE</span>
        </div>
        <div className={`connection ${connection}`}>
          <span className="dot" />
          {connection}
        </div>
      </header>
      <main>
        <div className="intro">
          <div>
            <p className="eyebrow">APPLIED AI / EVENT-DRIVEN SYSTEMS</p>
            <h1>See the runtime work.</h1>
            <p className="subtitle">A small assistant. An observable system. State that lasts.</p>
          </div>
          <button className="secondary" onClick={reset} disabled={!enabled}>
            {resetting ? 'Starting…' : '↻ New session'}
          </button>
        </div>
        <div className="statusbar">
          <div>
            <span className="statuslabel">PROVIDER</span>
            <strong>{provider}</strong>
            <span className="statushint">
              {provider === 'fake' ? 'Deterministic · offline' : 'Configured API'}
            </span>
          </div>
          <div>
            <span className="statuslabel">SESSION</span>
            <code title={session}>{session === '—' ? session : session.slice(0, 8)}</code>
            <span className="statushint">Transient context</span>
          </div>
          <div>
            <span className="statuslabel">MEMORY</span>
            <strong>SQLite</strong>
            <span className="statushint">Durable facts</span>
          </div>
          <div>
            <span className="statuslabel">CAPABILITIES</span>
            <strong>1 tool</strong>
            <span className="statushint">Calculator only</span>
          </div>
        </div>
        <div className="workspace">
          <section className="panel conversation">
            <div className="panelhead">
              <h2>Conversation</h2>
              <span className="tinylabel">NOVA</span>
            </div>
            <div
              className="messages"
              aria-live="polite"
              role="log"
              aria-label="Conversation messages"
            >
              {messages.length === 0 && (
                <div className="welcome">
                  <div className="nova-icon">N</div>
                  <h3>Start with a simple question.</h3>
                  <p>
                    Watch each request move through cognition,
                    <br className="desktop" /> memory, and a bounded tool.
                  </p>
                  <div className="examples">
                    {examples.map((example, i) => (
                      <button key={example} disabled={!enabled} onClick={() => send(example)}>
                        <span>0{i + 1}</span>
                        {example}
                        <b>↗</b>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((message, i) => (
                <div className={`message ${message.role}`} key={i}>
                  <div className="messagelabel">{message.role === 'user' ? 'YOU' : 'NOVA'}</div>
                  <p>{message.text}</p>
                </div>
              ))}
              {busy && (
                <div className="thinking">
                  <span className="dot" /> Processing request…
                </div>
              )}
              <div ref={messageEnd} />
            </div>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <label className="sr-only" htmlFor="message">
                Message Nova
              </label>
              <input
                id="message"
                value={text}
                maxLength={2000}
                onChange={(event) => setText(event.target.value)}
                placeholder="Message Nova…"
                disabled={!enabled}
                autoComplete="off"
              />
              <button type="submit" disabled={!enabled || !text.trim()} aria-label="Send message">
                ↑
              </button>
            </form>
            <div className="panelnote">
              New session clears conversation context. Saved facts remain.
            </div>
          </section>
          <aside className="sidepanels">
            <section className="panel eventpanel">
              <div className="panelhead">
                <h2>Event stream</h2>
                <span className="live">
                  <span className="dot" />
                  {events.length} events
                </span>
              </div>
              <p className="paneldescription">Correlated lifecycle events. No raw prompts.</p>
              <div className="events" role="log" aria-label="Runtime events">
                {events.length === 0 && <p className="empty">Waiting for the runtime…</p>}
                {[...events].reverse().map((event) => (
                  <details className={`event ${event.type.split('.')[0]}`} key={event.id}>
                    <summary>
                      <time>{event.timestamp.slice(11, 19)}</time>
                      <span>{event.type}</span>
                      <b>+</b>
                    </summary>
                    <div className="eventdetail">
                      <code>correlation: {event.correlationId.slice(0, 8)}</code>
                      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                    </div>
                  </details>
                ))}
              </div>
              <div className="panelnote">Newest first · expand to inspect metadata</div>
            </section>
            <section className="panel memorypanel">
              <div className="panelhead">
                <h2>Persistent memory</h2>
                <span className="count">{facts.length} / 32</span>
              </div>
              {facts.length === 0 ? (
                <div className="memoryempty">
                  <span>◇</span>
                  <p>No saved facts yet.</p>
                  <small>Try “Remember that the project codename is Orion.”</small>
                </div>
              ) : (
                <dl className="facts">
                  {facts.map((fact) => (
                    <div key={fact.id}>
                      <dt>{fact.key}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="panelnote">
                <span className="dot" /> Persists across sessions & restarts
              </div>
            </section>
          </aside>
        </div>
        <footer>
          <span>Realtime AI Runtime Reference</span>
          <span>WebSocket → cognition → state & capabilities → response</span>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
