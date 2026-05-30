import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

type ClipState = {
  text: string;
  image: string | null;
  updatedAt: string | null;
};

type HistoryEntry = {
  text: string;
  image: string | null;
  updatedAt: string;
};

type SocketMessage =
  | { type: "state"; payload: ClipState; history?: HistoryEntry[] }
  | { type: "update"; payload: ClipState; history?: HistoryEntry[] };

const MAX_LEN = 50000;
const MAX_IMAGE_LEN = 4_000_000;
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

function normalizeClipState(value: Partial<ClipState> | null | undefined): ClipState {
  return {
    text: typeof value?.text === "string" ? value.text : "",
    image: typeof value?.image === "string" ? value.image : null,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null
  };
}

function normalizeHistoryEntry(value: Partial<HistoryEntry>): HistoryEntry {
  return {
    text: typeof value.text === "string" ? value.text : "",
    image: typeof value.image === "string" ? value.image : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  };
}

function cachePayload(state: ClipState, history: HistoryEntry[]) {
  return {
    state: {
      text: state.text,
      image: null,
      updatedAt: state.updatedAt
    },
    history: history.map((entry) => ({
      text: entry.text,
      image: null,
      updatedAt: entry.updatedAt
    }))
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(blob);
  });
}

async function readImageFromDataTransfer(data: DataTransfer | null): Promise<string | null> {
  if (!data) {
    return null;
  }

  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        return blobToDataUrl(file);
      }
    }
  }

  for (const file of Array.from(data.files)) {
    if (file.type.startsWith("image/")) {
      return blobToDataUrl(file);
    }
  }

  return null;
}

async function readClipboardContent(): Promise<{ text?: string; image?: string }> {
  if (navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            return { image: await blobToDataUrl(blob) };
          }
        }
      }
      for (const item of items) {
        if (item.types.includes("text/plain")) {
          const blob = await item.getType("text/plain");
          return { text: await blob.text() };
        }
      }
    } catch {
      // fall through to readText
    }
  }

  try {
    return { text: await navigator.clipboard.readText() };
  } catch {
    return {};
  }
}

function hasPasteContent(content: { text?: string; image?: string }): boolean {
  return Boolean(content.image || content.text !== undefined);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64 = ""] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] ?? "image/png";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function blobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas unavailable");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!png) {
    throw new Error("PNG conversion failed");
  }
  return png;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to legacy copy
    }
  }

  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  if (!ok) {
    throw new Error("Copy failed");
  }
}

async function copyImageToClipboard(dataUrl: string): Promise<void> {
  const blob = dataUrlToBlob(dataUrl);
  const pngBlob = await blobToPng(blob);

  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
      return;
    } catch {
      // fall through
    }
  }

  throw new Error("Image copy not supported in this browser");
}

async function writeClipToClipboard(entry: Pick<ClipState, "text" | "image">): Promise<void> {
  if (entry.image) {
    await copyImageToClipboard(entry.image);
    return;
  }
  await copyTextToClipboard(entry.text || "");
}

function applyServerPayload(
  payload: ClipState,
  historyFromServer: HistoryEntry[] | undefined,
  prevHistory: HistoryEntry[]
): HistoryEntry[] {
  if (historyFromServer) {
    return historyFromServer.map(normalizeHistoryEntry).slice(0, HISTORY_LIMIT);
  }
  if (!payload.updatedAt) {
    return prevHistory;
  }
  const nextEntry = normalizeHistoryEntry({
    text: payload.text,
    image: payload.image,
    updatedAt: payload.updatedAt
  });
  const deduped = prevHistory.filter((entry) => entry.updatedAt !== nextEntry.updatedAt);
  return [nextEntry, ...deduped].slice(0, HISTORY_LIMIT);
}

export default function App() {
  const [secret] = useState<string>(getOrCreateSecret);
  const [state, setState] = useState<ClipState>({ text: "", image: null, updatedAt: null });
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [password, setPassword] = useState(() => sessionStorage.getItem(PASSWORD_KEY) ?? "");
  const [passwordInput, setPasswordInput] = useState(() => sessionStorage.getItem(PASSWORD_KEY) ?? "");
  const [status, setStatus] = useState("Idle");
  const [connected, setConnected] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const clipBufferRef = useRef<Pick<ClipState, "text" | "image"> | null>(null);

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
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { state: ClipState; history?: HistoryEntry[] };
        if (parsed.state) {
          setState(normalizeClipState(parsed.state));
        }
        if (parsed.history) {
          setHistory(parsed.history.map(normalizeHistoryEntry).slice(0, HISTORY_LIMIT));
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
        const nextState = normalizeClipState(data);
        const nextHistory = (data.history ?? []).map(normalizeHistoryEntry).slice(0, HISTORY_LIMIT);
        setState(nextState);
        setHistory(nextHistory);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cachePayload(nextState, nextHistory)));
        setStatus("Loaded");
      } catch {
        setStatus("Offline (showing cached clip)");
      }
    };
    load();
  }, [apiBase, secret, password]);

  useEffect(() => {
    if (!password) {
      return;
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let attempt = 0;

    const handleSocketPayload = (payload: ClipState, historyFromServer?: HistoryEntry[]) => {
      const normalized = normalizeClipState(payload);
      setState(normalized);
      setHistory((prev) => {
        const next = applyServerPayload(normalized, historyFromServer, prev);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cachePayload(normalized, next)));
        return next;
      });
    };

    const connect = () => {
      if (cancelled) {
        return;
      }

      const wsUrl = apiBase
        ? makeWsUrl(apiBase, secret, password)
        : makeWsUrl(window.location.origin, secret, password);
      socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        attempt = 0;
        setConnected(true);
        setStatus("Live");
      });

      socket.addEventListener("close", () => {
        setConnected(false);
        socketRef.current = null;
        if (cancelled) {
          return;
        }
        setStatus("Reconnecting...");
        const delay = Math.min(1000 * 2 ** attempt, 15000);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });

      socket.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data) as SocketMessage;
          if (msg.type === "state" || msg.type === "update") {
            handleSocketPayload(msg.payload, msg.history);
          }
        } catch {
          // ignore invalid message
        }
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      socket?.close();
      socketRef.current = null;
    };
  }, [apiBase, secret, password]);

  const applyClipToSend = (entry: Pick<ClipState, "text" | "image">) => {
    clipBufferRef.current = { text: entry.text, image: entry.image };
    if (entry.image) {
      setPendingImage(entry.image);
      setInput("");
      return;
    }
    setPendingImage(null);
    setInput(entry.text);
  };

  const handleCopy = async () => {
    clipBufferRef.current = { text: state.text, image: state.image };
    try {
      await writeClipToClipboard(state);
      setStatus(state.image ? "Image copied" : "Copied to clipboard");
    } catch (error) {
      clipBufferRef.current = { text: state.text, image: state.image };
      setStatus(error instanceof Error ? error.message : "Copy failed");
    }
  };

  const handlePaste = async () => {
    try {
      const content = await readClipboardContent();
      if (hasPasteContent(content)) {
        applyClipToSend({
          text: content.text ?? "",
          image: content.image ?? null
        });
        setStatus(content.image ? "Image pasted" : "Pasted from clipboard");
        return;
      }
      if (clipBufferRef.current) {
        applyClipToSend(clipBufferRef.current);
        setStatus("Pasted from last copy");
        return;
      }
      setStatus("Paste failed — copy something first");
    } catch {
      if (clipBufferRef.current) {
        applyClipToSend(clipBufferRef.current);
        setStatus("Pasted from last copy");
        return;
      }
      setStatus("Paste failed");
    }
  };

  const handleSendAreaPaste = async (event: React.ClipboardEvent) => {
    try {
      const image = await readImageFromDataTransfer(event.clipboardData);
      if (!image) {
        return;
      }
      event.preventDefault();
      applyClipToSend({ text: "", image });
      setStatus("Image pasted");
    } catch {
      setStatus("Image paste failed");
    }
  };

  const handleSendAreaDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    try {
      const image = await readImageFromDataTransfer(event.dataTransfer);
      if (!image) {
        return;
      }
      applyClipToSend({ text: "", image });
      setStatus("Image added");
    } catch {
      setStatus("Image drop failed");
    }
  };

  const handleFilePick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !file.type.startsWith("image/")) {
      setStatus("Pick an image file");
      return;
    }
    try {
      setPendingImage(await blobToDataUrl(file));
      setInput("");
      setStatus("Image selected");
    } catch {
      setStatus("Image read failed");
    }
  };

  const handleSend = async () => {
    const trimmed = input.trimEnd();
    if (!pendingImage && !trimmed) {
      setStatus("Nothing to send");
      return;
    }
    if (pendingImage) {
      if (pendingImage.length > MAX_IMAGE_LEN) {
        setStatus("Image too large");
        return;
      }
    } else if (trimmed.length > MAX_LEN) {
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
        body: JSON.stringify(
          pendingImage ? { text: "", image: pendingImage } : { text: trimmed, image: null }
        )
      });
      if (!res.ok) {
        throw new Error("Send failed");
      }
      const data = (await res.json()) as ClipState & { history?: HistoryEntry[] };
      const nextState = normalizeClipState(data);
      const nextHistory = (data.history ?? []).map(normalizeHistoryEntry).slice(0, HISTORY_LIMIT);
      setState(nextState);
      setHistory(nextHistory);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cachePayload(nextState, nextHistory)));
      setInput("");
      setPendingImage(null);
      setStatus("Sent");
    } catch {
      setStatus("Send failed");
    }
  };

  const handleShareCopy = async () => {
    try {
      await copyTextToClipboard(shareUrl);
      setStatus("Share link copied");
    } catch {
      setStatus("Share copy failed");
    }
  };

  const handleHistoryUse = (entry: HistoryEntry) => {
    applyClipToSend(entry);
    setStatus(entry.image ? "History image loaded" : "History loaded");
  };

  const handleHistoryCopy = async (entry: HistoryEntry) => {
    clipBufferRef.current = { text: entry.text, image: entry.image };
    try {
      await writeClipToClipboard(entry);
      setStatus(entry.image ? "History image copied" : "History copied");
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
      const nextState = normalizeClipState(data);
      const nextHistory = (data.history ?? []).map(normalizeHistoryEntry).slice(0, HISTORY_LIMIT);
      setState(nextState);
      setHistory(nextHistory);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cachePayload(nextState, nextHistory)));
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

  const hasLatestClip = Boolean(state.text || state.image);

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
    setPendingImage(null);
    setHistory([]);
    setState({ text: "", image: null, updatedAt: null });
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
            <h2>Latest clip</h2>
            <button className="btn ghost" onClick={handleCopy} disabled={!hasLatestClip}>
              Copy
            </button>
          </div>
          {state.image ? (
            <div className="image-box">
              <img className="clip-image" src={state.image} alt="Latest clipboard image" />
            </div>
          ) : (
            <div className="text-box">
              {state.text ? state.text : "Nothing yet. Paste text or an image on your laptop."}
            </div>
          )}
          <div className="meta">
            <span>Last update: {formattedTime}</span>
            <span className="dot">•</span>
            <span>Type: {state.image ? "Image" : "Text"}</span>
            <span className="dot">•</span>
            <span>Status: {status}</span>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Send new clip</h2>
            <div className="row">
              <button className="btn ghost" onClick={handlePaste}>
                Paste
              </button>
              <button className="btn ghost" onClick={() => fileInputRef.current?.click()}>
                Pick image
              </button>
              <button className="btn" onClick={handleSend}>
                Send
              </button>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={handleFilePick}
          />
          <div
            className="send-area"
            tabIndex={0}
            onPaste={handleSendAreaPaste}
            onDrop={handleSendAreaDrop}
            onDragOver={(event) => event.preventDefault()}
          >
            {pendingImage ? (
              <div className="image-preview">
                <img className="clip-image" src={pendingImage} alt="Image ready to send" />
                <button className="btn ghost image-clear" type="button" onClick={() => setPendingImage(null)}>
                  Remove image
                </button>
              </div>
            ) : (
              <textarea
                className="input"
                placeholder="Type or paste text or an image here (Ctrl+V)..."
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={5}
              />
            )}
          </div>
          <p className="muted send-hint">Tip: focus this box, pick an image from Win+V, then press Ctrl+V.</p>
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
                <div key={entry.updatedAt} className="history-item">
                  <button
                    className="history-body"
                    type="button"
                    onClick={() => handleHistoryUse(entry)}
                  >
                    <div className="history-row">
                      {entry.image ? (
                        <img className="history-thumb" src={entry.image} alt="History image" />
                      ) : (
                        <div className="history-text">{entry.text}</div>
                      )}
                    </div>
                    <div className="history-meta">
                      {new Date(entry.updatedAt).toLocaleTimeString()} • {entry.image ? "Image" : "Text"}
                    </div>
                  </button>
                  <div className="history-actions">
                    <button
                      className="history-action"
                      type="button"
                      onClick={() => handleHistoryCopy(entry)}
                    >
                      Copy
                    </button>
                    <button
                      className="history-delete"
                      onClick={() => handleHistoryDelete(entry.updatedAt)}
                      aria-label="Delete history item"
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
