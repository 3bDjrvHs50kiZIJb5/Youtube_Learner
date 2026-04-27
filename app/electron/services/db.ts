import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

export interface WordEntry {
  id?: number;
  /** 生词来自哪个存储桶(内部定位字段,前端不展示) */
  bucketKey?: string;
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

export const WORD_ALREADY_EXISTS = 'WORD_ALREADY_EXISTS';
const LEGACY_DB_FILE = 'video-learner.json';

function userDataDir(): string {
  const dir = app.getPath('userData');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function legacyDbFilePath(): string {
  return path.join(userDataDir(), LEGACY_DB_FILE);
}

function wordBookFilePathForVideo(videoPath: string): string {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath);
  return path.join(dir, `.${base}.wordbook.json`);
}

function ensureParentDir(file: string) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanWordEntry<T extends { bucketKey?: string }>(entry: T): T {
  const next = { ...entry };
  delete next.bucketKey;
  return next;
}

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

function readDbFile(file: string): DbData {
  if (fs.existsSync(file)) {
    try {
      const cache = JSON.parse(fs.readFileSync(file, 'utf-8')) as DbData;
      if (!cache.words) cache.words = [];
      if (!cache.nextId) cache.nextId = 1;
      const deduped = dedupeWords(cache.words);
      if (deduped.changed) {
        cache.words = deduped.words.map(cleanWordEntry);
        writeDbFile(file, cache);
      }
      return cache;
    } catch {
      return { words: [], nextId: 1 };
    }
  }
  return { words: [], nextId: 1 };
}

function writeDbFile(file: string, data: DbData) {
  ensureParentDir(file);
  const payload: DbData = {
    nextId: data.nextId || 1,
    words: (data.words || []).map(cleanWordEntry),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
}

function resolveBucketFile(videoPath?: string): string {
  if (videoPath) return wordBookFilePathForVideo(videoPath);
  return legacyDbFilePath();
}

function attachBucketKey(words: WordEntry[], file: string): WordEntry[] {
  return words.map((word) => ({ ...word, bucketKey: file }));
}

function findBucketFileById(id: number): string | null {
  for (const file of [path.resolve(legacyDbFilePath())]) {
    const data = readDbFile(file);
    if (data.words.some((w) => w.id === id)) return file;
  }
  return null;
}

export function addWord(entry: WordEntry): WordEntry {
  const file = path.resolve(resolveBucketFile(entry.videoPath));
  const d = readDbFile(file);
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
  d.words.unshift(cleanWordEntry(newEntry));
  writeDbFile(file, d);
  return { ...newEntry, bucketKey: file };
}

export function listWords(videoPath?: string): WordEntry[] {
  if (!videoPath) return [];

  const scopedFile = path.resolve(wordBookFilePathForVideo(videoPath));
  const currentVideoWords = attachBucketKey(readDbFile(scopedFile).words, scopedFile);

  const legacyFile = path.resolve(legacyDbFilePath());
  const legacyWords = attachBucketKey(readDbFile(legacyFile).words, legacyFile).filter(
    (word) => word.videoPath === videoPath
  );

  const deduped = dedupeWords([...currentVideoWords, ...legacyWords]);
  return deduped.words.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function deleteWord(id: number, bucketKey?: string): void {
  const file = bucketKey ? path.resolve(bucketKey) : findBucketFileById(id);
  if (!file) return;
  const d = readDbFile(file);
  d.words = d.words.filter((w) => w.id !== id);
  writeDbFile(file, d);
}

export function updateWord(id: number, patch: Partial<WordEntry>, bucketKey?: string): WordEntry | null {
  const file = bucketKey ? path.resolve(bucketKey) : findBucketFileById(id);
  if (!file) return null;
  const d = readDbFile(file);
  const idx = d.words.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  // id/createdAt 不允许被覆盖,其它字段浅合并
  const merged: WordEntry = {
    ...d.words[idx],
    ...cleanWordEntry(patch),
    id: d.words[idx].id,
    createdAt: d.words[idx].createdAt,
  };
  d.words[idx] = cleanWordEntry(merged);
  writeDbFile(file, d);
  return { ...merged, bucketKey: file };
}
