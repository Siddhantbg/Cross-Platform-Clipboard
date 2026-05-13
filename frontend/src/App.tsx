import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

type ClipState = {
  text: string;
  updatedAt: string | null;
};

type HistoryEntry = {
  text: string;
  updatedAt: string;
};

type SocketMessage =
  | { type: "state"; payload: ClipState }
  | { type: "update"; payload: ClipState };

const MAX_LEN = 50000;
const STORAGE_KEY = "cross-clipboard:last";
const HISTORY_LIMIT = 8;
const PASSWORD_KEY = "cross-clipboard:password";

function getOrCreateSecret(): string {
  const url = new URL(window.location.href);
  const existing = url.searchParams.get("s");
  if (existing) {
    return existing;
  }
  const secret = Math.random().toString(36).slice(2, 10);
  url.searchParams.set("s", secret);
  window.history.replaceState({}, "", url.toString());
  return secret;
}

function makeWsUrl(base: string, secret: string, password: string): string {
  try {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/clip-ws";
    url.searchParams.set("secret", secret);
    url.searchParams.set("password", password);
    return url.toString();
  } catch {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/clip-ws?secret=${encodeURIComponent(secret)}&password=${encodeURIComponent(password)}`;
  }
}

export default function App() {
  const [secret] = useState<string>(getOrCreateSecret);
  const [state, setState] = useState<ClipState>({ text: "", updatedAt: null });
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [input, setInput] = useState("");
  const [password, setPassword] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [status, setStatus] = useState("Idle");
  const [connected, setConnected] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const apiBase = import.meta.env.VITE_API_BASE
    ? import.meta.env.VITE_API_BASE.replace(/\/$/, "")
    : "";

  const shareUrl = useMemo(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("s", secret);
    return url.toString();
  }, [secret]);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const storedPassword = sessionStorage.getItem(PASSWORD_KEY);
    if (storedPassword) {
      setPassword(storedPassword);
      setPasswordInput(storedPassword);
    }
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { state: ClipState; history?: HistoryEntry[] };
        if (parsed.state) {
          setState(parsed.state);
        }
        if (parsed.history) {
          setHistory(parsed.history);
        }
      } catch {
        // ignore invalid cache
      }
    }
  }, []);

  useEffect(() => {
    if (!password) {
      return;
    }
    const load = async () => {
      try {
        const res = await fetch(`${apiBase}/api/clip/${secret}?limit=${HISTORY_LIMIT}`, {
          headers: { "X-Clipboard-Password": password }
        });
        if (!res.ok) {
          throw new Error("Failed to load");
        }
        const data = (await res.json()) as ClipState & { history?: HistoryEntry[] };
        setState({ text: data.text, updatedAt: data.updatedAt });
        if (data.history) {
          setHistory(data.history.slice(0, HISTORY_LIMIT));
        }
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ state: { text: data.text, updatedAt: data.updatedAt }, history: data.history })
        );
        setStatus("Loaded");
      } catch {
        setStatus("Offline (showing cached text)");
      }
    };
    load();
  }, [apiBase, secret, password]);

  useEffect(() => {
    if (!password) {
      return;
    }
    const wsUrl = apiBase
      ? makeWsUrl(apiBase, secret, password)
      : makeWsUrl(window.location.origin, secret, password);
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnected(true);
      setStatus("Live");
    });

    socket.addEventListener("close", () => {
      setConnected(false);
      setStatus("Disconnected");
    });

    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data) as SocketMessage;
        if (msg.type === "state" || msg.type === "update") {
          setState(msg.payload);
          setHistory((prev) => {
            if (!msg.payload.updatedAt) {
              return prev;
            }
            const nextEntry: HistoryEntry = {
              text: msg.payload.text,
              updatedAt: msg.payload.updatedAt
            };
            const deduped = prev.filter((entry) => entry.updatedAt !== nextEntry.updatedAt);
            const next = [nextEntry, ...deduped].slice(0, HISTORY_LIMIT);
            localStorage.setItem(
              STORAGE_KEY,
              JSON.stringify({ state: msg.payload, history: next })
            );
            return next;
          });
        }
      } catch {
        // ignore invalid message
      }
    });

    return () => {
      socket.close();
    };
  }, [apiBase, secret, password]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(state.text || "");
      setStatus("Copied to clipboard");
    } catch {
      setStatus("Copy failed");
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setInput(text);
      setStatus("Pasted from clipboard");
    } catch {
      setStatus("Paste failed");
    }
  };

  const handleSend = async () => {
    const trimmed = input.trimEnd();
    if (!trimmed) {
      setStatus("Nothing to send");
      return;
    }
    if (trimmed.length > MAX_LEN) {
      setStatus("Text too long");
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/clip/${secret}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Clipboard-Password": password
        },
        body: JSON.stringify({ text: trimmed })
      });
      if (!res.ok) {
        throw new Error("Send failed");
      }
      setInput("");
      setStatus("Sent");
    } catch {
      setStatus("Send failed");
    }
  };

  const handleShareCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setStatus("Share link copied");
    } catch {
      setStatus("Share copy failed");
    }
  };

  const handleHistoryCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("History copied");
    } catch {
      setStatus("History copy failed");
    }
  };

  const handleHistoryDelete = async (updatedAt: string) => {
    try {
      const res = await fetch(`${apiBase}/api/clip/${secret}/history`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Clipboard-Password": password
        },
        body: JSON.stringify({ updatedAt })
      });
      if (!res.ok) {
        throw new Error("Delete failed");
      }
      const data = (await res.json()) as ClipState & { history?: HistoryEntry[] };
      setState({ text: data.text, updatedAt: data.updatedAt });
      setHistory((data.history ?? []).slice(0, HISTORY_LIMIT));
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ state: { text: data.text, updatedAt: data.updatedAt }, history: data.history })
      );
      setStatus("History deleted");
    } catch {
      setStatus("Delete failed");
    }
  };

  useEffect(() => {
    QRCode.toDataURL(shareUrl, {
      width: 180,
      margin: 1,
      color: {
        dark: "#2f6bff",
        light: "#ffffff"
      }
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [shareUrl]);

  const formattedTime = state.updatedAt
    ? new Date(state.updatedAt).toLocaleTimeString()
    : "Never";

  const handleUnlock = () => {
    if (!passwordInput.trim()) {
      setStatus("Enter the password");
      return;
    }
    setPassword(passwordInput.trim());
    sessionStorage.setItem(PASSWORD_KEY, passwordInput.trim());
    setStatus("Unlocked");
  };

  const handleLogout = () => {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    sessionStorage.removeItem(PASSWORD_KEY);
    setPassword("");
    setPasswordInput("");
    setConnected(false);
    setInput("");
    setHistory([]);
    setState({ text: "", updatedAt: null });
    setStatus("Locked");
  };

  if (!password) {
    return (
      <div className="page">
        <div className="glow" />
        <main className="card">
          <header className="header">
            <div>
              <p className="eyebrow">Cross Clipboard</p>
              <h1>Enter password to continue</h1>
            </div>
          </header>
          <section className="panel">
            <div className="panel-header">
              <h2>Unlock</h2>
            </div>
            <div className="row">
              <input
                className="share-input"
                type="password"
                placeholder="Password"
                value={passwordInput}
                onChange={(event) => setPasswordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleUnlock();
                  }
                }}
              />
              <button className="btn" onClick={handleUnlock}>
                Unlock
              </button>
            </div>
            <p className="muted">Password is required to access this clipboard.</p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="glow" />
      <main className="card">
        <header className="header">
          <div>
            <p className="eyebrow">Cross Clipboard</p>
            <h1>Copy once. Paste anywhere.</h1>
          </div>
          <div className="header-actions">
            <span className={connected ? "pill live" : "pill"}>{connected ? "Live" : "Offline"}</span>
            <button className="btn ghost" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </header>

        <section className="panel">
          <div className="panel-header">
            <h2>Latest text</h2>
            <button className="btn ghost" onClick={handleCopy}>
              Copy
            </button>
          </div>
          <div className="text-box">
            {state.text ? state.text : "Nothing yet. Paste something on your laptop."}
          </div>
          <div className="meta">
            <span>Last update: {formattedTime}</span>
            <span className="dot">•</span>
            <span>Status: {status}</span>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Send new text</h2>
            <div className="row">
              <button className="btn ghost" onClick={handlePaste}>
                Paste
              </button>
              <button className="btn" onClick={handleSend}>
                Send
              </button>
            </div>
          </div>
          <textarea
            className="input"
            placeholder="Type or paste text to send..."
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={5}
          />
        </section>

        <section className="panel share">
          <div>
            <h2>Share link</h2>
            <p className="muted">Open this link on your phone to read and copy.</p>
          </div>
          <div className="share-row">
            <input className="share-input" value={shareUrl} readOnly />
            <button className="btn" onClick={handleShareCopy}>
              Copy link
            </button>
          </div>
          <div className="qr-row">
            <button className="qr-button" onClick={handleShareCopy} aria-label="Copy share link">
              {qrDataUrl ? <img className="qr-image" src={qrDataUrl} alt="Share link QR" /> : "QR"}
              <span>Tap QR to copy</span>
            </button>
          </div>
        </section>

        <section className="panel history">
          <div className="panel-header">
            <h2>Recent history</h2>
            <span className="muted">Last {HISTORY_LIMIT}</span>
          </div>
          <div className="history-list">
            {history.length === 0 ? (
              <div className="history-empty">No history yet.</div>
            ) : (
              history.map((entry) => (
                <button
                  key={entry.updatedAt}
                  className="history-item"
                  onClick={() => handleHistoryCopy(entry.text)}
                >
                  <div className="history-row">
                    <div className="history-text">{entry.text}</div>
                    <button
                      className="history-delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleHistoryDelete(entry.updatedAt);
                      }}
                      aria-label="Delete history item"
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                  <div className="history-meta">{new Date(entry.updatedAt).toLocaleTimeString()}</div>
                </button>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
