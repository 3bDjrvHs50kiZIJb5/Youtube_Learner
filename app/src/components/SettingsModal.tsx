import { useEffect, useState } from 'react';
import type { AppConfig } from '../types';

// 阿里云百炼 Qwen-TTS 完整预置音色, 和
// /Users/Zhuanz/reps/TTS_Voice/swift-macos/Sources/TTSVoiceMac/Models/TTSSettings.swift 对齐,
// 官方文档: https://help.aliyun.com/zh/model-studio/qwen-tts
type Gender = 'M' | 'F';
interface TTSVoice {
  value: string;
  zh: string;
  gender: Gender;
  detail: string;
}

const TTS_VOICES: TTSVoice[] = [
  { value: 'Cherry', zh: '芊悦', gender: 'F', detail: '阳光积极、亲切自然小姐姐' },
  { value: 'Serena', zh: '苏瑶', gender: 'F', detail: '温柔小姐姐' },
  { value: 'Ethan', zh: '晨煦', gender: 'M', detail: '标准普通话，带部分北方口音；阳光、温暖、活力、朝气' },
  { value: 'Chelsie', zh: '千雪', gender: 'F', detail: '二次元虚拟女友' },
  { value: 'Momo', zh: '茉兔', gender: 'F', detail: '撒娇搞怪，逗你开心' },
  { value: 'Vivian', zh: '十三', gender: 'F', detail: '拽拽的、可爱的小暴躁' },
  { value: 'Moon', zh: '月白', gender: 'M', detail: '率性帅气' },
  { value: 'Maia', zh: '四月', gender: 'F', detail: '知性与温柔的碰撞' },
  { value: 'Kai', zh: '凯', gender: 'M', detail: '耳朵的一场 SPA' },
  { value: 'Nofish', zh: '不吃鱼', gender: 'M', detail: '不会翘舌音的设计师' },
  { value: 'Bella', zh: '萌宝', gender: 'F', detail: '喝酒不打醉拳的小萝莉' },
  { value: 'Jennifer', zh: '詹妮弗', gender: 'F', detail: '品牌级、电影质感般美语女声' },
  { value: 'Ryan', zh: '甜茶', gender: 'M', detail: '节奏拉满，戏感炸裂，真实与张力共舞' },
  { value: 'Katerina', zh: '卡捷琳娜', gender: 'F', detail: '御姐音色，韵律回味十足' },
  { value: 'Aiden', zh: '艾登', gender: 'M', detail: '精通厨艺的美语大男孩' },
  { value: 'Eldric Sage', zh: '沧明子', gender: 'M', detail: '沉稳睿智的老者，沧桑如松却心明如镜' },
  { value: 'Mia', zh: '乖小妹', gender: 'F', detail: '温顺如春水，乖巧如初雪' },
  { value: 'Mochi', zh: '沙小弥', gender: 'M', detail: '聪明伶俐的小大人，童真未泯却早慧如禅' },
  { value: 'Bellona', zh: '燕铮莺', gender: 'F', detail: '声音洪亮，吐字清晰，人物鲜活，听得人热血沸腾' },
  { value: 'Vincent', zh: '田叔', gender: 'M', detail: '一口独特的沙哑烟嗓，一开口便道尽了千军万马与江湖豪情' },
  { value: 'Bunny', zh: '萌小姬', gender: 'F', detail: '「萌属性」爆棚的小萝莉' },
  { value: 'Neil', zh: '阿闻', gender: 'M', detail: '平直的基线语调，字正腔圆的咬字发音，专业新闻主持人' },
  { value: 'Elias', zh: '墨讲师', gender: 'F', detail: '既保持学科严谨性，又通过叙事技巧将复杂知识转化为可消化的认知模块' },
  { value: 'Arthur', zh: '徐大爷', gender: 'M', detail: '被岁月和旱烟浸泡过的质朴嗓音，不疾不徐地摇开了满村的奇闻异事' },
  { value: 'Nini', zh: '邻家妹妹', gender: 'F', detail: '糯米糍一样又软又黏的嗓音，那一声声拉长了的「哥哥」，甜得能把人的骨头都叫酥了' },
  { value: 'Seren', zh: '小婉', gender: 'F', detail: '温和舒缓的声线，助你更快地进入睡眠，晚安，好梦' },
  { value: 'Pip', zh: '顽屁小孩', gender: 'M', detail: '调皮捣蛋却充满童真的他来了，这是你记忆中的小新吗' },
  { value: 'Stella', zh: '少女阿月', gender: 'F', detail: '平时是甜到发腻的迷糊少女音，喊出「代表月亮消灭你」时瞬间充满爱与正义' },
  { value: 'Bodega', zh: '博德加', gender: 'M', detail: '热情的西班牙大叔' },
  { value: 'Sonrisa', zh: '索尼莎', gender: 'F', detail: '热情开朗的拉美大姐' },
  { value: 'Alek', zh: '阿列克', gender: 'M', detail: '一开口，是战斗民族的冷，也是毛呢大衣下的暖' },
  { value: 'Dolce', zh: '多尔切', gender: 'M', detail: '慵懒的意大利大叔' },
  { value: 'Sohee', zh: '素熙', gender: 'F', detail: '温柔开朗，情绪丰富的韩国欧尼' },
  { value: 'Ono Anna', zh: '小野杏', gender: 'F', detail: '鬼灵精怪的青梅竹马' },
  { value: 'Lenn', zh: '莱恩', gender: 'M', detail: '理性是底色，叛逆藏在细节里——穿西装也听后朋克的德国青年' },
  { value: 'Emilien', zh: '埃米尔安', gender: 'M', detail: '浪漫的法国大哥哥' },
  { value: 'Andre', zh: '安德雷', gender: 'M', detail: '声音磁性，自然舒服、沉稳男生' },
  { value: 'Radio Gol', zh: '拉迪奥·戈尔', gender: 'M', detail: '足球诗人 Rádio Gol，用名字为你们解说足球' },
  { value: 'Jada', zh: '上海-阿珍', gender: 'F', detail: '风风火火的沪上阿姐' },
  { value: 'Dylan', zh: '北京-晓东', gender: 'M', detail: '北京胡同里长大的少年' },
  { value: 'Li', zh: '南京-老李', gender: 'M', detail: '耐心的瑜伽老师' },
  { value: 'Marcus', zh: '陕西-秦川', gender: 'M', detail: '面宽话短，心实声沉——老陕的味道' },
  { value: 'Roy', zh: '闽南-阿杰', gender: 'M', detail: '诙谐直爽、市井活泼的台湾哥仔形象' },
  { value: 'Peter', zh: '天津-李彼得', gender: 'M', detail: '天津相声，专业捧哏' },
  { value: 'Sunny', zh: '四川-晴儿', gender: 'F', detail: '甜到你心里的川妹子' },
  { value: 'Eric', zh: '四川-程川', gender: 'M', detail: '一个跳脱市井的四川成都男子' },
  { value: 'Rocky', zh: '粤语-阿强', gender: 'M', detail: '幽默风趣的阿强，在线陪聊' },
  { value: 'Kiki', zh: '粤语-阿清', gender: 'F', detail: '甜美的港妹闺蜜' },
];

const formatVoiceLabel = (v: TTSVoice) =>
  `${v.zh}（${v.value}）· ${v.gender === 'M' ? '男' : '女'}`;

const TTS_MODELS: Array<{ value: string; label: string }> = [
  { value: 'qwen3-tts-flash', label: '标准版 (qwen3-tts-flash)' },
  { value: 'qwen3-tts-instruct-flash', label: '可控版 (qwen3-tts-instruct-flash)' },
];

const TTS_LANGS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'en', label: '英文' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'de', label: '德语' },
  { value: 'fr', label: '法语' },
  { value: 'es', label: '西班牙语' },
];

type TabKey = 'general' | 'oss' | 'tts';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'general', label: '基础' },
  { key: 'oss', label: 'OSS 存储' },
  { key: 'tts', label: '朗读 TTS' },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [tab, setTab] = useState<TabKey>('general');

  useEffect(() => {
    window.api.configGet().then(setCfg);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!cfg) return null;

  const save = async () => {
    await window.api.configSet(cfg);
    onClose();
  };

  // 每个分页一段 JSX,保证切换时 input 焦点不会乱跳
  const renderGeneral = () => (
    <>
      <div className="field">
        <label>DashScope API Key（千问 / 阿里云百炼）</label>
        <input
          type="password"
          value={cfg.dashscopeApiKey}
          onChange={(e) => setCfg({ ...cfg, dashscopeApiKey: e.target.value })}
          placeholder="sk-xxxxxxxx"
        />
        <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          用于 ASR、字幕翻译、单词解释、朗读 (Qwen-TTS) 等所有千问相关接口。
        </span>
      </div>
      <div className="field">
        <label>翻译目标语言</label>
        <input
          value={cfg.translateTarget || ''}
          onChange={(e) => setCfg({ ...cfg, translateTarget: e.target.value })}
          placeholder="中文"
        />
      </div>
    </>
  );

  const renderOss = () => (
    <>
      <div className="field">
        <label>
          Region（如 <code>oss-cn-hangzhou</code>、<code>cn-hangzhou</code>，或完整 endpoint）
        </label>
        <input
          value={cfg.oss.region}
          onChange={(e) => setCfg({ ...cfg, oss: { ...cfg.oss, region: e.target.value } })}
          placeholder="oss-cn-hangzhou"
        />
        <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          阿里云控制台「概览 → Region」显示的是 <code>cn-hangzhou</code>，会自动补 <code>oss-</code> 前缀。
        </span>
      </div>
      <div className="field">
        <label>Bucket</label>
        <input
          value={cfg.oss.bucket}
          onChange={(e) => setCfg({ ...cfg, oss: { ...cfg.oss, bucket: e.target.value } })}
        />
      </div>
      <div className="field">
        <label>AccessKey ID</label>
        <input
          value={cfg.oss.accessKeyId}
          onChange={(e) => setCfg({ ...cfg, oss: { ...cfg.oss, accessKeyId: e.target.value } })}
        />
      </div>
      <div className="field">
        <label>AccessKey Secret</label>
        <input
          type="password"
          value={cfg.oss.accessKeySecret}
          onChange={(e) => setCfg({ ...cfg, oss: { ...cfg.oss, accessKeySecret: e.target.value } })}
        />
      </div>
      <div className="field">
        <label>对象前缀</label>
        <input
          value={cfg.oss.prefix || ''}
          onChange={(e) => setCfg({ ...cfg, oss: { ...cfg.oss, prefix: e.target.value } })}
          placeholder="video-learner/"
        />
      </div>
    </>
  );

  const renderTts = () => (
    <>
      <div className="field">
        <label>模型</label>
        <select
          value={cfg.tts?.model || 'qwen3-tts-flash'}
          onChange={(e) => setCfg({ ...cfg, tts: { ...cfg.tts, model: e.target.value } })}
        >
          {TTS_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>音色（共 {TTS_VOICES.length} 个，阿里云百炼 Qwen-TTS 官方预置）</label>
        <select
          value={cfg.tts?.voice || 'Cherry'}
          onChange={(e) => setCfg({ ...cfg, tts: { ...cfg.tts, voice: e.target.value } })}
        >
          {TTS_VOICES.map((v) => (
            <option key={v.value} value={v.value} title={v.detail}>
              {formatVoiceLabel(v)}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          {(() => {
            const cur = TTS_VOICES.find((v) => v.value === (cfg.tts?.voice || 'Cherry'));
            return cur ? `风格：${cur.detail}` : '风格：—';
          })()}
        </span>
      </div>
      <div className="field">
        <label>语种提示</label>
        <select
          value={cfg.tts?.language || 'en'}
          onChange={(e) => setCfg({ ...cfg, tts: { ...cfg.tts, language: e.target.value } })}
        >
          {TTS_LANGS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>
          朗读倍速:{' '}
          <span style={{ color: 'var(--fg)' }}>
            {(cfg.tts?.speed ?? 1.5).toFixed(1)} 倍
          </span>
          <span style={{ color: 'var(--muted)', marginLeft: 6, fontWeight: 400 }}>
            (1.0 为正常, 默认 1.5)
          </span>
        </label>
        <input
          type="range"
          min={0.5}
          max={2.0}
          step={0.1}
          value={cfg.tts?.speed ?? 1.5}
          onChange={(e) =>
            setCfg({ ...cfg, tts: { ...cfg.tts, speed: Number(e.target.value) } })
          }
          style={{ width: '100%' }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--muted)',
            marginTop: 2,
          }}
        >
          <span>0.5×</span>
          <span>1.0×</span>
          <span>1.5×</span>
          <span>2.0×</span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          客户端倍速播放(不改音高),仅对「朗读原句」生效;单词朗读固定 1.0 倍,方便听清音节。
        </span>
      </div>
    </>
  );

  return (
    <div className="modal-mask">
      <div className="modal settings-modal">
        <div className="header">
          <h3>设置</h3>
          <button className="close-x" onClick={onClose} title="关闭 (Esc)">
            ×
          </button>
        </div>

        <div className="settings-tabs">
          {TABS.map((t) => (
            <div
              key={t.key}
              className={`settings-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </div>
          ))}
        </div>

        <div className="settings-body">
          {tab === 'general' && renderGeneral()}
          {tab === 'oss' && renderOss()}
          {tab === 'tts' && renderTts()}
        </div>

        <div className="footer">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
