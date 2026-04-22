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

function readEnv(name: string): string {
  return (process.env[name] || '').trim();
}

/**
 * OSS 的 bucket / region 可以内置, 但敏感的 AK/SK 必须走环境变量,
 * 避免把密钥提交进仓库。
 */
const HARDCODED_OSS = {
  region: 'oss-ap-northeast-1.aliyuncs.com',
  bucket: 'youtube-videos-1982',
  accessKeyId:
    readEnv('OSS_ACCESS_KEY_ID') || readEnv('ALIBABA_CLOUD_ACCESS_KEY_ID'),
  accessKeySecret:
    readEnv('OSS_ACCESS_KEY_SECRET') || readEnv('ALIBABA_CLOUD_ACCESS_KEY_SECRET'),
  prefix: 'video-learner/',
} as const;

export interface AppConfig {
  dashscopeApiKey: string;      // 阿里云百炼 / DashScope API Key，用于千问 ASR + 翻译
  /**
   * OSS 配置现在是只读的内置常量, 渲染进程仍可以读到(保持老接口形状),
   * 但无法通过 configSet 修改。
   */
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

type StoredConfig = Omit<AppConfig, 'oss'>;

const defaults: StoredConfig = {
  dashscopeApiKey: '',
  translateTarget: '中文',
  tts: {
    model: 'qwen3-tts-flash',
    // 英文单词朗读更适配美式女声;仍可在设置里改
    voice: 'Jennifer',
    language: 'en',
    speed: 1.5,
  },
};

const store = new Store<StoredConfig>({
  name: 'video-learner-config',
  defaults,
});

export function getConfig(): AppConfig {
  return {
    dashscopeApiKey: store.get('dashscopeApiKey') || '',
    oss: { ...HARDCODED_OSS },
    translateTarget: store.get('translateTarget') || '中文',
    tts: { ...defaults.tts, ...(store.get('tts') || {}) },
  };
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

export function setConfig(cfg: Partial<AppConfig>) {
  const current = getConfig();

  if (cfg.dashscopeApiKey !== undefined) {
    store.set('dashscopeApiKey', cfg.dashscopeApiKey);
  }
  // cfg.oss 一律忽略: OSS 参数已经写死在软件里, 不允许前端改。
  if (cfg.translateTarget !== undefined) {
    store.set('translateTarget', cfg.translateTarget);
  }
  if (cfg.tts) {
    store.set('tts', { ...current.tts, ...stripUndefined(cfg.tts) });
  }

  // 方便排查: 打一行日志, 看主进程是否真正写入
  console.log('[config] setConfig done, tts now =', store.get('tts'));
}
