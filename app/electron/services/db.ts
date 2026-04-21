import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

export interface WordEntry {
  id?: number;
  word: string;
  context?: string;
  translation?: string;
  videoPath?: string;
  sentenceStartMs?: number;
  sentenceEndMs?: number;
  note?: string;
  createdAt?: number;
}

interface DbData {
  words: WordEntry[];
  nextId: number;
}

let cache: DbData | null = null;
let dbFile = '';

function ensureLoaded(): DbData {
  if (cache) return cache;
  const dir = app.getPath('userData');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  dbFile = path.join(dir, 'video-learner.json');
  if (fs.existsSync(dbFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(dbFile, 'utf-8')) as DbData;
    } catch {
      cache = { words: [], nextId: 1 };
    }
  } else {
    cache = { words: [], nextId: 1 };
  }
  if (!cache.words) cache.words = [];
  if (!cache.nextId) cache.nextId = 1;
  return cache;
}

function flush() {
  if (!cache) return;
  fs.writeFileSync(dbFile, JSON.stringify(cache, null, 2), 'utf-8');
}

export function addWord(entry: WordEntry): WordEntry {
  const d = ensureLoaded();
  const now = Date.now();
  const newEntry: WordEntry = { ...entry, id: d.nextId++, createdAt: now };
  d.words.unshift(newEntry);
  flush();
  return newEntry;
}

export function listWords(): WordEntry[] {
  const d = ensureLoaded();
  return [...d.words].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function deleteWord(id: number): void {
  const d = ensureLoaded();
  d.words = d.words.filter((w) => w.id !== id);
  flush();
}
