import axios from 'axios';
import { getConfig } from './config';
import type { SubtitleCue, SubtitleWord } from './subtitle';

// 阿里云百炼（DashScope）Paraformer 录音文件识别：异步任务模式
// 文档：https://help.aliyun.com/zh/dashscope/developer-reference/paraformer

const SUBMIT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const TASK_URL = (taskId: string) => `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`;

interface SubmitResp {
  output: { task_id: string; task_status: string };
  request_id?: string;
}
interface TaskResp {
  output: {
    task_id: string;
    task_status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    results?: Array<{
      file_url: string;
      transcription_url?: string;
      subtask_status?: string;
      message?: string;
    }>;
    message?: string;
    code?: string;
  };
}

/** 千问 ASR 返回的原始 JSON 结构（我们用到的关键字段）
 *  Paraformer-v2 默认开启字级时间戳,在 sentence.words[] 下:
 *  { begin_time, end_time, text, punctuation }
 */
interface ParaformerWord {
  begin_time?: number;
  end_time?: number;
  text?: string;
  word?: string; // 兼容可能的字段别名
  punctuation?: string;
}
interface ParaformerResult {
  transcripts?: Array<{
    text?: string;
    sentences?: Array<{
      begin_time: number; // ms
      end_time: number;   // ms
      text: string;
      words?: ParaformerWord[];
    }>;
  }>;
}

function mapWords(ws: ParaformerWord[] | undefined): SubtitleWord[] | undefined {
  if (!ws || !ws.length) return undefined;
  const out: SubtitleWord[] = [];
  for (const w of ws) {
    const text = (w.text ?? w.word ?? '').toString();
    if (!text) continue;
    if (typeof w.begin_time !== 'number' || typeof w.end_time !== 'number') continue;
    out.push({
      text,
      startMs: w.begin_time,
      endMs: w.end_time,
      punctuation: w.punctuation || undefined,
    });
  }
  return out.length ? out : undefined;
}

function getApiKey(): string {
  const key = getConfig().dashscopeApiKey;
  if (!key) throw new Error('请先在「设置」里配置 DashScope API Key（千问）');
  return key;
}

async function submitTask(fileUrl: string, languageHints: string[]): Promise<string> {
  const resp = await axios.post<SubmitResp>(
    SUBMIT_URL,
    {
      model: 'paraformer-v2',
      input: { file_urls: [fileUrl] },
      parameters: { language_hints: languageHints },
    },
    {
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
    }
  );
  if (!resp.data?.output?.task_id) {
    throw new Error(`ASR 任务提交失败: ${JSON.stringify(resp.data)}`);
  }
  return resp.data.output.task_id;
}

async function pollTask(taskId: string, onTick?: (status: string) => void): Promise<TaskResp['output']> {
  // 最长等 30 分钟
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const resp = await axios.get<TaskResp>(TASK_URL(taskId), {
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    const out = resp.data.output;
    onTick?.(out.task_status);
    if (out.task_status === 'SUCCEEDED') return out;
    if (out.task_status === 'FAILED') {
      throw new Error(`ASR 失败: ${out.message || JSON.stringify(out)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('ASR 轮询超时');
}

export interface TranscribeOptions {
  /** 语言提示，如 ['en'] / ['zh'] / ['en','zh'] */
  languageHints?: string[];
  onStatus?: (status: string) => void;
}

/** 传入 OSS 可访问的 URL，返回字幕 cues */
export async function transcribe(
  fileUrl: string,
  opts: TranscribeOptions = {}
): Promise<SubtitleCue[]> {
  const languageHints = opts.languageHints && opts.languageHints.length ? opts.languageHints : ['en'];
  const taskId = await submitTask(fileUrl, languageHints);
  opts.onStatus?.(`任务已提交: ${taskId}`);
  const result = await pollTask(taskId, opts.onStatus);

  const transcriptionUrl = result.results?.[0]?.transcription_url;
  if (!transcriptionUrl) {
    throw new Error(`ASR 结果缺少 transcription_url: ${JSON.stringify(result)}`);
  }
  const { data } = await axios.get<ParaformerResult>(transcriptionUrl);
  const sentences = data.transcripts?.[0]?.sentences || [];
  return sentences.map((s, i) => ({
    id: i,
    startMs: s.begin_time,
    endMs: s.end_time,
    text: s.text.trim(),
    words: mapWords(s.words),
  }));
}
