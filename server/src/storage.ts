import fs from "node:fs/promises";
import path from "node:path";

export type ClipState = {
  text: string;
  image: string | null;
  updatedAt: string;
};

export type ClipEntry = {
  current: ClipState;
  history: ClipState[];
};

type StoreData = Record<string, ClipEntry | ClipState>;

const MAX_HISTORY = 20;

function normalizeState(state: Partial<ClipState> & { updatedAt: string }): ClipState {
  return {
    text: typeof state.text === "string" ? state.text : "",
    image: typeof state.image === "string" ? state.image : null,
    updatedAt: state.updatedAt
  };
}

function normalizeEntry(entry: ClipEntry): ClipEntry {
  return {
    current: normalizeState(entry.current),
    history: entry.history.map((item) => normalizeState(item))
  };
}

export class ClipStore {
  private data = new Map<string, ClipEntry>();
  private filePath?: string;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath;
  }

  async init() {
    if (!this.filePath) {
      return;
    }
    try {
      await fs.access(this.filePath);
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as StoreData;
      for (const [key, value] of Object.entries(parsed)) {
        if ("current" in value && "history" in value) {
          this.data.set(key, normalizeEntry(value as ClipEntry));
        } else {
          const legacy = normalizeState(value as ClipState);
          this.data.set(key, { current: legacy, history: legacy.text || legacy.image ? [legacy] : [] });
        }
      }
    } catch {
      // ignore missing or invalid store
    }
  }

  getEntry(secret: string): ClipEntry {
    const entry = this.data.get(secret);
    if (entry) {
      return entry;
    }
    return {
      current: { text: "", image: null, updatedAt: new Date(0).toISOString() },
      history: []
    };
  }

  set(secret: string, content: { text: string; image?: string | null }): ClipState {
    const next: ClipState = {
      text: content.text,
      image: content.image ?? null,
      updatedAt: new Date().toISOString()
    };
    const existing = this.getEntry(secret);
    const history = [next, ...existing.history].slice(0, MAX_HISTORY);
    this.data.set(secret, { current: next, history });
    this.scheduleWrite();
    return next;
  }

  getHistory(secret: string, limit: number): ClipState[] {
    const entry = this.getEntry(secret);
    return entry.history.slice(0, limit);
  }

  deleteHistoryEntry(secret: string, updatedAt: string): ClipEntry {
    const entry = this.getEntry(secret);
    const history = entry.history.filter((item) => item.updatedAt !== updatedAt);
    const nextCurrent = history[0] ?? { text: "", image: null, updatedAt: new Date(0).toISOString() };
    const nextEntry = { current: nextCurrent, history };
    this.data.set(secret, nextEntry);
    this.scheduleWrite();
    return nextEntry;
  }

  private scheduleWrite() {
    if (!this.filePath) {
      return;
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.flush().catch(() => undefined);
    }, 300);
  }

  private async flush() {
    if (!this.filePath) {
      return;
    }
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const obj: StoreData = {};
    for (const [key, value] of this.data.entries()) {
      obj[key] = value;
    }
    await fs.writeFile(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
  }
}
