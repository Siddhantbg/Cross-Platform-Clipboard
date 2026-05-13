import fs from "node:fs/promises";
import path from "node:path";

export type ClipState = {
  text: string;
  updatedAt: string;
};

export type ClipEntry = {
  current: ClipState;
  history: ClipState[];
};

type StoreData = Record<string, ClipEntry | ClipState>;

const MAX_HISTORY = 20;

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
          this.data.set(key, value as ClipEntry);
        } else {
          const legacy = value as ClipState;
          this.data.set(key, { current: legacy, history: legacy.text ? [legacy] : [] });
        }
      }
    } catch {
      // ignore missing or invalid store
    }
  }

  getEntry(secret: string): ClipEntry {
    return (
      this.data.get(secret) ?? {
        current: { text: "", updatedAt: new Date(0).toISOString() },
        history: []
      }
    );
  }

  set(secret: string, text: string): ClipState {
    const next = { text, updatedAt: new Date().toISOString() };
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
    const nextCurrent = history[0] ?? { text: "", updatedAt: new Date(0).toISOString() };
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
