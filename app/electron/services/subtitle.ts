import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { getConfig } from './config';
import { pMap } from './pMap';

export interface SubtitleWord {
  text: string;
  startMs: number;
  endMs: number;
  punctuation?: string;
}

export interface SubtitleCue {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  /** 翻译后的文本（可选） */
  translation?: string;
  /** 字级时间戳(karaoke 逐词高亮用) */
  words?: SubtitleWord[];
}

function msToSrtTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mss = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mss).padStart(3, '0')}`;
}

function srtTimeToMs(t: string): number {
  const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600000 + +m[2] * 60000 + +m[3] * 1000 + +m[4];
}

export function cuesToSrt(cues: SubtitleCue[], withTranslation = false): string {
  return cues
    .map((c, i) => {
      const text = withTranslation && c.translation ? `${c.text}\n${c.translation}` : c.text;
      return `${i + 1}\n${msToSrtTime(c.startMs)} --> ${msToSrtTime(c.endMs)}\n${text}\n`;
    })
    .join('\n');
}

export function parseSrt(srt: string): SubtitleCue[] {
  const blocks = srt.replace(/\r\n/g, '\n').split(/\n{2,}/).filter(Boolean);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    // 跳过序号行（纯数字）
    const timeLineIdx = /-->/.test(lines[0]) ? 0 : 1;
    const timeMatch = lines[timeLineIdx].match(/(\S+)\s*-->\s*(\S+)/);
    if (!timeMatch) continue;
    const textLines = lines.slice(timeLineIdx + 1);
    cues.push({
      id: cues.length,
      startMs: srtTimeToMs(timeMatch[1]),
      endMs: srtTimeToMs(timeMatch[2]),
      text: textLines[0] || '',
      translation: textLines[1] || undefined,
    });
  }
  return cues;
}

/**
 * 字级时间戳旁路 JSON 的路径。
 * SRT 本身不支持字级时间戳,我们把 words 存在 `<视频名>.words.json`,
 * 加载字幕时自动合并,避免动 SRT 格式。
 */
function wordsJsonPathFor(videoPath: string, suffix = ''): string {
  const dir = path.dirname(videoPath);
  const name = path.parse(videoPath).name;
  return path.join(dir, `${name}${suffix}.words.json`);
}

export function saveWordsBesideVideo(videoPath: string, cues: SubtitleCue[], suffix = ''): string | null {
  const withWords = cues.filter((c) => c.words && c.words.length);
  if (!withWords.length) return null;
  const file = wordsJsonPathFor(videoPath, suffix);
  const payload = withWords.map((c) => ({
    id: c.id,
    startMs: c.startMs,
    endMs: c.endMs,
    text: c.text,
    words: c.words,
  }));
  fs.writeFileSync(file, JSON.stringify(payload), 'utf-8');
  return file;
}

export function saveSubtitleBesideVideo(videoPath: string, cues: SubtitleCue[], suffix = ''): string {
  const dir = path.dirname(videoPath);
  const name = path.parse(videoPath).name;
  const file = path.join(dir, `${name}${suffix}.srt`);
  const withTrans = cues.some((c) => c.translation);
  fs.writeFileSync(file, cuesToSrt(cues, withTrans), 'utf-8');
  // 顺便写 words 旁路文件(不存在 words 则跳过)
  saveWordsBesideVideo(videoPath, cues, suffix);
  return file;
}

/**
 * 把 SRT 同目录下的 `.words.json` 合并到 cues 上。
 * 对齐策略:优先按 cue id 匹配,id 不匹配时按 startMs 最近(±150ms)匹配。
 */
function mergeWordsFromJson(srtPath: string, cues: SubtitleCue[]): SubtitleCue[] {
  // 把 `xxx.srt` / `xxx.bilingual.srt` 还原出对应的 words.json 路径
  const dir = path.dirname(srtPath);
  const base = path.parse(srtPath).name; // 含 `.bilingual` 这类后缀
  const candidate = path.join(dir, `${base}.words.json`);
  // 双语 srt 如果没单独的 words,退化到用原始(不带 .bilingual 的)words.json
  let jsonPath = candidate;
  if (!fs.existsSync(jsonPath) && base.endsWith('.bilingual')) {
    jsonPath = path.join(dir, `${base.slice(0, -'.bilingual'.length)}.words.json`);
  }
  if (!fs.existsSync(jsonPath)) return cues;
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Array<{
      id: number;
      startMs: number;
      endMs: number;
      text: string;
      words: SubtitleWord[];
    }>;
    const byId = new Map(raw.map((r) => [r.id, r]));
    return cues.map((c) => {
      const hit =
        byId.get(c.id) ??
        raw.find((r) => Math.abs(r.startMs - c.startMs) <= 150 && r.text === c.text);
      return hit ? { ...c, words: hit.words } : c;
    });
  } catch (e) {
    console.warn('加载 words.json 失败,忽略:', jsonPath, e);
    return cues;
  }
}

export function loadSubtitle(srtPath: string): SubtitleCue[] {
  if (!fs.existsSync(srtPath)) return [];
  const cues = parseSrt(fs.readFileSync(srtPath, 'utf-8'));
  return mergeWordsFromJson(srtPath, cues);
}

export interface TranslateBatchInfo {
  batchIndex: number;
  batchTotal: number;
  batchStart: number;
  batchSize: number;
  workerId: number;
  workerTotal: number;
}

export interface TranslateOptions {
  target?: string;
  /** 并发批次数,默认 3 */
  concurrency?: number;
  /** 批次开始调用 */
  onStart?: (info: TranslateBatchInfo) => void;
  /** 批次完成调用 */
  onBatch?: (info: TranslateBatchInfo & { translated: SubtitleCue[] }) => void;
}

/**
 * 用 qwen-turbo 批量并发翻译字幕。
 * 把 cues 切成 40 句一批,用 pMap 并发处理多批。
 * 单批失败不中断其他批,失败的批保留原文(无 translation)。
 */
export async function translateCues(
  cues: SubtitleCue[],
  optsOrTarget: string | TranslateOptions = {}
): Promise<SubtitleCue[]> {
  const opts: TranslateOptions =
    typeof optsOrTarget === 'string' ? { target: optsOrTarget } : optsOrTarget;
  const target = opts.target || '中文';
  const concurrency = opts.concurrency ?? 3;
  const apiKey = getConfig().dashscopeApiKey;
  if (!apiKey) throw new Error('未配置 DashScope API Key,无法翻译');

  const BATCH = 40;
  const result: SubtitleCue[] = cues.map((c) => ({ ...c }));
  const batches: Array<{ batchIndex: number; start: number; items: SubtitleCue[] }> = [];
  for (let i = 0; i < cues.length; i += BATCH) {
    batches.push({
      batchIndex: Math.floor(i / BATCH),
      start: i,
      items: cues.slice(i, i + BATCH),
    });
  }
  const batchTotal = batches.length;
  const workerTotal = Math.min(concurrency, batchTotal);

  await pMap(
    batches,
    async (batch, _idx, workerId) => {
      const info: TranslateBatchInfo = {
        batchIndex: batch.batchIndex,
        batchTotal,
        batchStart: batch.start,
        batchSize: batch.items.length,
        workerId,
        workerTotal,
      };
      opts.onStart?.(info);

      const prompt =
        `请把下列英文字幕翻译成${target},保持句子编号对应,语气口语化,只输出"编号: 译文"每行一条,不要多余说明。\n\n` +
        batch.items.map((c, i) => `${i + 1}: ${c.text}`).join('\n');

      try {
        const { data } = await axios.post(
          'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
          {
            model: 'qwen-turbo',
            messages: [
              { role: 'system', content: '你是一个专业的字幕翻译助手。' },
              { role: 'user', content: prompt },
            ],
            temperature: 0.3,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
          }
        );
        const content: string = data?.choices?.[0]?.message?.content || '';
        const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          const m = line.match(/^(\d+)[：:.\s]+(.*)$/);
          if (!m) continue;
          const idx = +m[1] - 1;
          if (batch.items[idx]) {
            result[batch.start + idx].translation = m[2].trim();
          }
        }
      } catch (err) {
        console.error('翻译批次失败:', batch.batchIndex, err);
      }
      opts.onBatch?.({
        ...info,
        translated: result.slice(batch.start, batch.start + batch.items.length),
      });
    },
    concurrency
  );

  return result;
}

export interface WordExplanation {
  word: string;
  phonetic?: string;
  pos?: string;
  meaning?: string;
  contextual?: string;
}

/**
 * 用 qwen-turbo 给一个单词做"词典式"解释。
 * 传入原始单词 + 所在句子,返回音标 / 词性 / 中文释义 / 结合上下文的中文含义。
 * 失败时 throw,调用方自行处理。
 */
export async function explainWord(
  word: string,
  context: string
): Promise<WordExplanation> {
  const apiKey = getConfig().dashscopeApiKey;
  if (!apiKey) throw new Error('未配置 DashScope API Key,无法解释单词');
  const cleanWord = word.trim();
  if (!cleanWord) throw new Error('单词为空');

  const prompt =
    `你是一个英语词典助手。给出下面英文单词的解释,严格只返回 JSON,不要任何多余文字、不要代码块。\n` +
    `字段要求:\n` +
    `- phonetic: 国际音标(例如 /ˈæp.əl/),若不确定可留空字符串\n` +
    `- pos: 词性缩写(n./v./adj./adv./prep. 等)\n` +
    `- meaning: 该单词最常用的中文释义,尽量简短,多个义项用;分隔\n` +
    `- contextual: 在给定上下文中该单词的中文含义,一句话\n\n` +
    `单词: ${cleanWord}\n` +
    `上下文: ${context || '(无)'}\n\n` +
    `输出示例: {"phonetic":"/ˈæp.əl/","pos":"n.","meaning":"苹果","contextual":"这里指一种水果"}`;

  const { data } = await axios.post(
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    {
      model: 'qwen-turbo',
      messages: [
        { role: 'system', content: '你是一个专业的英语词典助手,只返回 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const content: string = data?.choices?.[0]?.message?.content || '';
  // 兼容模型偶尔包了代码块 / 前后缀的情况,抓出第一个 { ... } 再解析
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { word: cleanWord, meaning: content.trim() };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<WordExplanation>;
    return {
      word: cleanWord,
      phonetic: parsed.phonetic?.trim() || undefined,
      pos: parsed.pos?.trim() || undefined,
      meaning: parsed.meaning?.trim() || undefined,
      contextual: parsed.contextual?.trim() || undefined,
    };
  } catch {
    return { word: cleanWord, meaning: content.trim() };
  }
}
