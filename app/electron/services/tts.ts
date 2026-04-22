import axios from 'axios';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { app } from 'electron';
import { getConfig } from './config';

/**
 * 阿里云百炼 Qwen-TTS 客户端。
 * 参考:
 *   - /Users/Zhuanz/reps/TTS_Voice/swift-macos/Sources/TTSVoiceMac/Services/TTSClient.swift
 *   - https://help.aliyun.com/zh/model-studio/qwen-tts
 * Endpoint: POST dashscope.aliyuncs.com /api/v1/services/aigc/multimodal-generation/generation
 * Body:    { model, input: { text, voice, language_type } }
 * 返回:    output.audio.data (base64) 或 output.audio.url (需再下载)
 */

export const DEFAULT_TTS_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

export interface TTSOptions {
  text: string;
  /** 覆盖全局配置的音色(默认 Cherry) */
  voice?: string;
  /** 覆盖模型(默认 qwen3-tts-flash) */
  model?: string;
  /** language_type: Auto/Chinese/English/Japanese/Korean/German/French/Spanish/Italian/Portuguese/Indonesian */
  language?: string;
}

export interface TTSResult {
  /** 音频原始字节的 base64 */
  dataBase64: string;
  /** 猜测出的 MIME,供渲染进程构建 Blob */
  mime: string;
}

/**
 * 把前端传来的"auto/zh/en"归一化到阿里云接受的字段名。
 */
function normalizeLanguage(value: string | undefined): string {
  const v = (value || 'auto').trim().toLowerCase();
  switch (v) {
    case 'auto':
      return 'Auto';
    case 'zh':
    case 'chinese':
    case '中文':
      return 'Chinese';
    case 'en':
    case 'english':
    case '英文':
      return 'English';
    case 'ja':
    case 'japanese':
      return 'Japanese';
    case 'ko':
    case 'korean':
      return 'Korean';
    case 'de':
    case 'german':
      return 'German';
    case 'fr':
    case 'french':
      return 'French';
    case 'es':
    case 'spanish':
      return 'Spanish';
    case 'it':
    case 'italian':
      return 'Italian';
    case 'pt':
    case 'portuguese':
      return 'Portuguese';
    case 'id':
    case 'indonesian':
      return 'Indonesian';
    default:
      return 'Auto';
  }
}

/** 根据音频头字节猜 MIME(wav/mp3/m4a/ogg/flac 等),失败给通用 audio/mpeg */
function sniffAudioMime(buf: Buffer): string {
  if (buf.length < 4) return 'audio/mpeg';
  const b = buf;
  // RIFF....WAVE
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'audio/wav';
  // ID3 (MP3 带 ID3 tag)
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';
  // MP3 frame sync
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  // OggS
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
  // fLaC
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'audio/flac';
  // 偏移 4: ftyp -> MP4/M4A
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    return 'audio/mp4';
  }
  return 'audio/mpeg';
}

/**
 * TTS 音频缓存:相同文本/音色/模型/语种的请求不再重复打阿里云接口。
 * - 磁盘缓存: <userData>/tts-cache/<sha1>  (原始音频字节)
 * - 内存缓存: 会话期间命中直接返回,连磁盘都不读
 * mime 在读回时用 sniffAudioMime 再识别一次,省得单独存 meta 文件。
 */
const memCache = new Map<string, TTSResult>();
let cacheDir = '';

function getCacheDir(): string {
  if (cacheDir) return cacheDir;
  cacheDir = path.join(app.getPath('userData'), 'tts-cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function makeCacheKey(model: string, voice: string, language: string, text: string): string {
  const raw = `${model}|${voice}|${language}|${text}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function readFromDiskCache(key: string): TTSResult | null {
  try {
    const file = path.join(getCacheDir(), key);
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    if (!buf.length) return null;
    return { dataBase64: buf.toString('base64'), mime: sniffAudioMime(buf) };
  } catch (err) {
    console.warn('[tts-cache] 读取磁盘缓存失败:', err);
    return null;
  }
}

function writeToDiskCache(key: string, buf: Buffer) {
  try {
    const file = path.join(getCacheDir(), key);
    fs.writeFileSync(file, buf);
  } catch (err) {
    console.warn('[tts-cache] 写入磁盘缓存失败:', err);
  }
}

export async function synthesizeSpeech(opts: TTSOptions): Promise<TTSResult> {
  const text = (opts.text || '').trim();
  if (!text) throw new Error('朗读文本为空');

  const cfg = getConfig();
  const ttsCfg = cfg.tts || {};
  const model = opts.model || ttsCfg.model || 'qwen3-tts-flash';
  const voice = opts.voice || ttsCfg.voice || 'Cherry';
  const language = normalizeLanguage(opts.language || ttsCfg.language || 'auto');
  const endpoint = ttsCfg.endpoint || DEFAULT_TTS_ENDPOINT;

  const cacheKey = makeCacheKey(model, voice, language, text);

  // 1) 会话内存命中
  const hitMem = memCache.get(cacheKey);
  if (hitMem) return hitMem;

  // 2) 磁盘命中(跨启动)
  const hitDisk = readFromDiskCache(cacheKey);
  if (hitDisk) {
    memCache.set(cacheKey, hitDisk);
    return hitDisk;
  }

  const apiKey = cfg.dashscopeApiKey;
  if (!apiKey) throw new Error('未配置 DashScope API Key,无法调用 Qwen-TTS');

  let response;
  try {
    response = await axios.post(
      endpoint,
      {
        model,
        input: {
          text,
          voice,
          language_type: language,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60_000,
      }
    );
  } catch (err: any) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const msg =
      (body && (body.message || body.code)) || err?.message || '未知错误';
    throw new Error(`Qwen-TTS 请求失败(${status ?? 'n/a'}): ${msg}`);
  }

  const data = response.data || {};
  const audio = data?.output?.audio;

  const finalize = (buf: Buffer): TTSResult => {
    const result: TTSResult = { dataBase64: buf.toString('base64'), mime: sniffAudioMime(buf) };
    memCache.set(cacheKey, result);
    writeToDiskCache(cacheKey, buf);
    return result;
  };

  // 优先内联 base64
  const inlineB64 = typeof audio?.data === 'string' ? audio.data.trim() : '';
  if (inlineB64) {
    const buf = Buffer.from(inlineB64, 'base64');
    if (!buf.length) throw new Error('Qwen-TTS 返回的音频数据为空');
    return finalize(buf);
  }

  // 其次走 OSS 链接
  const url = typeof audio?.url === 'string' ? audio.url.trim() : '';
  if (url) {
    const { data: audioData } = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
    });
    const buf = Buffer.from(audioData);
    if (!buf.length) throw new Error('Qwen-TTS 返回的音频链接是空文件');
    return finalize(buf);
  }

  const fallback = data?.message || data?.code || '未返回任何音频';
  throw new Error(`Qwen-TTS 没有返回可播放音频: ${fallback}`);
}

/**
 * 清空 TTS 缓存(内存 + 磁盘),方便调试或换音色后清理老数据。
 * 目前没接 UI,主要给排查问题用。
 */
export function clearTTSCache(): { removed: number } {
  memCache.clear();
  let removed = 0;
  try {
    const dir = getCacheDir();
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.unlinkSync(path.join(dir, name));
        removed++;
      } catch {
        // 单个文件删不掉就跳过
      }
    }
  } catch (err) {
    console.warn('[tts-cache] 清空缓存失败:', err);
  }
  return { removed };
}
