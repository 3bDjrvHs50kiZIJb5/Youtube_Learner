import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Store from 'electron-store';

export interface AppTTSConfig {
  /** qwen3-tts-flash / qwen3-tts-instruct-flash */
  model?: string;
  /** 音色,如 Cherry / Ethan / Jennifer / Ryan 等 */
  voice?: string;
  /** 语种提示: auto / en / zh / ja / ko / de / fr / es / it / pt / id */
  language?: string;
  /** 可覆盖的 endpoint(默认值在 tts.ts 里) */
  endpoint?: string;
  /**
   * 朗读倍速,合法区间 0.5 ~ 2.0, 默认 1.0。
   * Qwen-TTS 接口本身没有 speed 字段,所以是纯客户端播放倍速(audio.playbackRate),
   * 语调不变,速度变。参照 TTS_Voice/swift-macos 的 player.rate 实现。
   */
  speed?: number;
}

/**
 * OSS 的 bucket / region / prefix 可以给默认值，
 * AK/SK 默认留空，交给设置页写入本地配置。
 */
const DEFAULT_OSS = {
  region: 'oss-ap-northeast-1.aliyuncs.com',
  bucket: 'youtube-videos-1982',
  accessKeyId: '',
  accessKeySecret: '',
  prefix: 'video-learner/',
} as const;

export interface AppConfig {
  dashscopeApiKey: string;      // 阿里云百炼 / DashScope API Key，用于千问 ASR + 翻译
  oss: {
    region: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    prefix?: string;
  };
  /** 字幕默认翻译目标语言 */
  translateTarget?: string;
  /** Qwen-TTS 配置 */
  tts?: AppTTSConfig;
}

const defaults: AppConfig = {
  dashscopeApiKey: '',
  oss: {
    ...DEFAULT_OSS,
  },
  translateTarget: '中文',
  tts: {
    model: 'qwen3-tts-flash',
    // 英文单词朗读更适配美式女声;仍可在设置里改
    voice: 'Jennifer',
    language: 'en',
    speed: 1.5,
  },
};

const store = new Store<AppConfig>({
  name: 'video-learner-config',
  defaults,
});

/**
 * 命令行脚本直接跑服务层时, electron-store 可能拿不到 Electron 里的默认 userData。
 * 这里补一个“读现成 JSON 文件”的兜底,这样脚本和 GUI 共用同一份配置。
 */
function resolveExternalConfigCandidates(): string[] {
  const explicit = process.env.VIDEO_LEARNER_CONFIG_PATH?.trim();
  if (explicit) return [explicit];

  if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support', 'video-learner');
    return [
      path.join(base, 'video-learner-config.json'),
      path.join(base, 'config.json'),
    ];
  }

  if (process.platform === 'win32') {
    const appData =
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const base = path.join(appData, 'video-learner');
    return [
      path.join(base, 'video-learner-config.json'),
      path.join(base, 'config.json'),
    ];
  }

  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const base = path.join(configHome, 'video-learner');
  return [
    path.join(base, 'video-learner-config.json'),
    path.join(base, 'config.json'),
  ];
}

function pickExternalConfigPath(): string | null {
  const candidates = resolveExternalConfigCandidates();
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] || null;
}

function loadExternalConfig(): Partial<AppConfig> | null {
  const file = pickExternalConfigPath();
  if (!file || !fs.existsSync(file)) return null;

  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AppConfig>;
  } catch (err) {
    console.warn('[config] 外部配置读取失败:', file, err);
    return null;
  }
}

/**
 * 把 patch 里 undefined 的字段剔掉,避免把已保存的值意外清成 undefined。
 * (例如渲染进程只改 voice, 没传 model, spread 合并时 model=undefined 就会丢失)
 */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key in obj) {
    const v = obj[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function preferNonEmpty(current: string | undefined, fallback: string | undefined): string {
  if (current && current.trim()) return current;
  return fallback || '';
}

function mergeFallbackConfig(base: AppConfig, fallback: Partial<AppConfig> | null): AppConfig {
  if (!fallback) return base;
  const fallbackOss = fallback.oss || {};

  return {
    dashscopeApiKey: preferNonEmpty(base.dashscopeApiKey, fallback.dashscopeApiKey),
    oss: {
      region: preferNonEmpty(base.oss.region, fallbackOss.region || DEFAULT_OSS.region),
      bucket: preferNonEmpty(base.oss.bucket, fallbackOss.bucket || DEFAULT_OSS.bucket),
      accessKeyId: preferNonEmpty(base.oss.accessKeyId, fallbackOss.accessKeyId),
      accessKeySecret: preferNonEmpty(base.oss.accessKeySecret, fallbackOss.accessKeySecret),
      prefix: preferNonEmpty(base.oss.prefix, fallbackOss.prefix || DEFAULT_OSS.prefix),
    },
    translateTarget: preferNonEmpty(base.translateTarget, fallback.translateTarget || '中文'),
    tts: {
      ...defaults.tts,
      ...stripUndefined(fallback.tts || {}),
      ...stripUndefined(base.tts || {}),
    },
  };
}

export function getConfig(): AppConfig {
  const stored = store.store;
  const storedOss = stored.oss || defaults.oss;
  const configFromStore: AppConfig = {
    dashscopeApiKey: store.get('dashscopeApiKey') || '',
    oss: {
      region: storedOss.region || DEFAULT_OSS.region,
      bucket: storedOss.bucket || DEFAULT_OSS.bucket,
      accessKeyId: storedOss.accessKeyId || '',
      accessKeySecret: storedOss.accessKeySecret || '',
      prefix: storedOss.prefix || DEFAULT_OSS.prefix,
    },
    translateTarget: store.get('translateTarget') || '中文',
    tts: { ...defaults.tts, ...(store.get('tts') || {}) },
  };

  return mergeFallbackConfig(configFromStore, loadExternalConfig());
}

export function setConfig(cfg: Partial<AppConfig>) {
  const current = getConfig();

  if (cfg.dashscopeApiKey !== undefined) {
    store.set('dashscopeApiKey', cfg.dashscopeApiKey);
  }
  if (cfg.oss) {
    store.set('oss', { ...current.oss, ...stripUndefined(cfg.oss) });
  }
  if (cfg.translateTarget !== undefined) {
    store.set('translateTarget', cfg.translateTarget);
  }
  if (cfg.tts) {
    store.set('tts', { ...current.tts, ...stripUndefined(cfg.tts) });
  }

  console.log('[config] setConfig done');
  return getConfig();
}
