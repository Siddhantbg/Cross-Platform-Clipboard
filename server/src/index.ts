import "dotenv/config";
import cors from "cors";
import express from "express";
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ClipStore, type ClipState } from "./storage.js";

const PORT = Number(process.env.PORT ?? 8787);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const STORE_PATH = process.env.CLIPBOARD_STORE_PATH;
const MAX_LEN = 50000;
const MAX_IMAGE_LEN = 4_000_000;
const HISTORY_DEFAULT = 8;
const PASSWORD = process.env.CLIPBOARD_PASSWORD;
if (!PASSWORD) {
  throw new Error("CLIPBOARD_PASSWORD is required");
}

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: CORS_ORIGIN !== "*"
  })
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/clip-ws" });

const store = new ClipStore(STORE_PATH);
await store.init();

const rooms = new Map<string, Set<WebSocket>>();

function getRoom(secret: string) {
  const existing = rooms.get(secret);
  if (existing) {
    return existing;
  }
  const next = new Set<WebSocket>();
  rooms.set(secret, next);
  return next;
}

function broadcast(secret: string, state: ClipState, history?: ClipState[]) {
  const room = rooms.get(secret);
  if (!room) {
    return;
  }
  const payload = JSON.stringify({
    type: "update",
    payload: state,
    history: (history ?? store.getHistory(secret, HISTORY_DEFAULT)).slice(0, HISTORY_DEFAULT)
  });
  for (const ws of room) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/api/clip/:secret", (req, res) => {
  const provided = req.header("x-clipboard-password") ?? "";
  if (provided !== PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const secret = req.params.secret;
  const state = store.getEntry(secret).current;
  const limit = Number(req.query.limit ?? HISTORY_DEFAULT);
  const history = store.getHistory(secret, Number.isFinite(limit) ? limit : HISTORY_DEFAULT);
  res.json({
    text: state.text,
    image: state.image,
    updatedAt: state.updatedAt === new Date(0).toISOString() ? null : state.updatedAt,
    history
  });
});

function isValidImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);base64,/i.test(value);
}

app.post("/api/clip/:secret", (req, res) => {
  const provided = req.header("x-clipboard-password") ?? "";
  if (provided !== PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const secret = req.params.secret;
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const image = typeof req.body?.image === "string" && req.body.image ? req.body.image : null;
  if (!text && !image) {
    return res.status(400).json({ error: "Text or image required" });
  }
  if (text.length > MAX_LEN) {
    return res.status(413).json({ error: "Text too long" });
  }
  if (image) {
    if (image.length > MAX_IMAGE_LEN) {
      return res.status(413).json({ error: "Image too large" });
    }
    if (!isValidImageDataUrl(image)) {
      return res.status(400).json({ error: "Invalid image format" });
    }
  }
  const state = store.set(secret, { text, image });
  const history = store.getHistory(secret, HISTORY_DEFAULT);
  broadcast(secret, state, history);
  res.json({
    text: state.text,
    image: state.image,
    updatedAt: state.updatedAt,
    history
  });
});

app.delete("/api/clip/:secret/history", (req, res) => {
  const provided = req.header("x-clipboard-password") ?? "";
  if (provided !== PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const secret = req.params.secret;
  const updatedAt = typeof req.body?.updatedAt === "string" ? req.body.updatedAt : "";
  if (!updatedAt) {
    return res.status(400).json({ error: "updatedAt required" });
  }
  const entry = store.deleteHistoryEntry(secret, updatedAt);
  const history = entry.history.slice(0, HISTORY_DEFAULT);
  broadcast(secret, entry.current, history);
  res.json({
    text: entry.current.text,
    image: entry.current.image,
    updatedAt: entry.current.updatedAt === new Date(0).toISOString() ? null : entry.current.updatedAt,
    history
  });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const secret = url.searchParams.get("secret");
  const provided = url.searchParams.get("password") ?? "";
  if (!secret) {
    ws.close();
    return;
  }
  if (provided !== PASSWORD) {
    ws.close();
    return;
  }

  const room = getRoom(secret);
  room.add(ws);

  const state = store.getEntry(secret).current;
  const history = store.getHistory(secret, HISTORY_DEFAULT);
  ws.send(JSON.stringify({ type: "state", payload: state, history }));

  ws.on("close", () => {
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(secret);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
