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
  /** 以下字段来自 AI 解释,允许事后补全 */
  phonetic?: string;
  pos?: string;
  meaning?: string;
  contextual?: string;
}

interface DbData {
  words: WordEntry[];
  nextId: number;
}

let cache: DbData | null = null;
let dbFile = '';
export const WORD_ALREADY_EXISTS = 'WORD_ALREADY_EXISTS';

function normalizeWord(word?: string): string {
  return (word || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function mergeWordEntries(preferred: WordEntry, fallback: WordEntry): WordEntry {
  return {
    ...fallback,
    ...preferred,
    word: preferred.word?.trim() || fallback.word?.trim() || '',
    context: preferred.context || fallback.context,
    translation: preferred.translation || fallback.translation,
    videoPath: preferred.videoPath || fallback.videoPath,
    sentenceStartMs: preferred.sentenceStartMs ?? fallback.sentenceStartMs,
    sentenceEndMs: preferred.sentenceEndMs ?? fallback.sentenceEndMs,
    note: preferred.note || fallback.note,
    createdAt: preferred.createdAt ?? fallback.createdAt,
    phonetic: preferred.phonetic || fallback.phonetic,
    pos: preferred.pos || fallback.pos,
    meaning: preferred.meaning || fallback.meaning,
    contextual: preferred.contextual || fallback.contextual,
  };
}

function dedupeWords(words: WordEntry[]): { words: WordEntry[]; changed: boolean } {
  const byWord = new Map<string, WordEntry>();
  let changed = false;

  for (const entry of words) {
    const normalizedWord = normalizeWord(entry.word);
    if (!normalizedWord) {
      changed = true;
      continue;
    }
    const trimmedEntry: WordEntry = { ...entry, word: entry.word.trim() };
    const existing = byWord.get(normalizedWord);
    if (!existing) {
      byWord.set(normalizedWord, trimmedEntry);
      if (trimmedEntry.word !== entry.word) changed = true;
      continue;
    }
    changed = true;
    const existingCreatedAt = existing.createdAt || 0;
    const currentCreatedAt = trimmedEntry.createdAt || 0;
    const preferred = currentCreatedAt >= existingCreatedAt ? trimmedEntry : existing;
    const fallback = preferred === trimmedEntry ? existing : trimmedEntry;
    byWord.set(normalizedWord, mergeWordEntries(preferred, fallback));
  }

  return {
    words: [...byWord.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    changed,
  };
}

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
  const deduped = dedupeWords(cache.words);
  if (deduped.changed) {
    cache.words = deduped.words;
    flush();
  }
  return cache;
}

function flush() {
  if (!cache) return;
  fs.writeFileSync(dbFile, JSON.stringify(cache, null, 2), 'utf-8');
}

export function addWord(entry: WordEntry): WordEntry {
  const d = ensureLoaded();
  const normalizedWord = normalizeWord(entry.word);
  const existing = d.words.find((w) => normalizeWord(w.word) === normalizedWord);
  if (existing) {
    const err = new Error(`单词已在生词本中: ${existing.word}`);
    err.name = WORD_ALREADY_EXISTS;
    throw err;
  }
  const now = Date.now();
  const newEntry: WordEntry = {
    ...entry,
    word: entry.word.trim(),
    id: d.nextId++,
    createdAt: now,
  };
  d.words.unshift(newEntry);
  flush();
  return newEntry;
}

export function listWords(): WordEntry[] {
  const d = ensureLoaded();
  const deduped = dedupeWords(d.words);
  if (deduped.changed) {
    d.words = deduped.words;
    flush();
  }
  return [...d.words];
}

export function deleteWord(id: number): void {
  const d = ensureLoaded();
  d.words = d.words.filter((w) => w.id !== id);
  flush();
}

export function updateWord(id: number, patch: Partial<WordEntry>): WordEntry | null {
  const d = ensureLoaded();
  const idx = d.words.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  // id/createdAt 不允许被覆盖,其它字段浅合并
  const merged: WordEntry = { ...d.words[idx], ...patch, id: d.words[idx].id, createdAt: d.words[idx].createdAt };
  d.words[idx] = merged;
  flush();
  return merged;
}
