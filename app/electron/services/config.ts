import Store from 'electron-store';

export interface AppConfig {
  dashscopeApiKey: string;      // 阿里云百炼 / DashScope API Key，用于千问 ASR + 翻译
  oss: {
    region: string;             // 如 oss-cn-hangzhou
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    /** OSS 文件存储目录前缀，默认 video-learner/ */
    prefix?: string;
  };
  /** 字幕默认翻译目标语言 */
  translateTarget?: string;
}

const defaults: AppConfig = {
  dashscopeApiKey: '',
  oss: {
    region: 'oss-cn-hangzhou',
    bucket: '',
    accessKeyId: '',
    accessKeySecret: '',
    prefix: 'video-learner/',
  },
  translateTarget: '中文',
};

const store = new Store<AppConfig>({
  name: 'video-learner-config',
  defaults,
});

export function getConfig(): AppConfig {
  return {
    dashscopeApiKey: store.get('dashscopeApiKey') || '',
    oss: store.get('oss') || defaults.oss,
    translateTarget: store.get('translateTarget') || '中文',
  };
}

export function setConfig(cfg: Partial<AppConfig>) {
  if (cfg.dashscopeApiKey !== undefined) store.set('dashscopeApiKey', cfg.dashscopeApiKey);
  if (cfg.oss) store.set('oss', { ...getConfig().oss, ...cfg.oss });
  if (cfg.translateTarget) store.set('translateTarget', cfg.translateTarget);
}
