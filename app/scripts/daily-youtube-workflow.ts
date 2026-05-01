import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { transcribe } from '../electron/services/asr';
import { getConfig } from '../electron/services/config';
import { exportStudyVideos, splitAudioSegments } from '../electron/services/ffmpeg';
import { uploadToOss } from '../electron/services/oss';
import { pMap } from '../electron/services/pMap';
import {
  retimeCuesFromWords,
  saveSubtitleBesideVideo,
  translateCues,
  type SubtitleCue,
  type SubtitleWord,
} from '../electron/services/subtitle';

type Browser = 'chrome' | 'safari' | 'edge' | 'firefox' | 'brave' | 'chromium' | 'vivaldi' | 'opera';

interface DailyOptions {
  url?: string;
  browser: Browser;
  workRoot: string;
  uploadConcurrency: number;
  asrConcurrency: number;
  translateConcurrency: number;
  segmentSec: number;
}

interface VideoCandidate {
  channel: string;
  channelUrl: string;
  url: string;
  title: string;
  uploadDate: string;
  durationSec: number;
}

interface VideoMetadata {
  id: string;
  title: string;
  channel: string;
  uploadDate: string;
  durationSec: number;
  description?: string;
  webpageUrl: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_WORK_ROOT = path.join(REPO_ROOT, 'tmp', 'daily');

const SOURCE_CHANNELS = [
  {
    channel: 'BBC Learning English',
    url: 'https://www.youtube.com/@bbclearningenglish/videos',
  },
  {
    channel: 'VOA Learning English',
    url: 'https://www.youtube.com/@voalearningenglish/videos',
  },
  {
    channel: 'English with Lucy',
    url: 'https://www.youtube.com/@EnglishwithLucy/videos',
  },
] as const;

function parseArgs(argv: string[]): DailyOptions {
  const opts: DailyOptions = {
    browser: 'chrome',
    workRoot: DEFAULT_WORK_ROOT,
    uploadConcurrency: 3,
    asrConcurrency: 3,
    translateConcurrency: 3,
    segmentSec: 120,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--url' && next) {
      opts.url = next.trim();
      i++;
      continue;
    }
    if (arg.startsWith('--url=')) {
      opts.url = arg.slice('--url='.length).trim();
      continue;
    }
    if (arg === '--browser' && next) {
      opts.browser = next.trim() as Browser;
      i++;
      continue;
    }
    if (arg.startsWith('--browser=')) {
      opts.browser = arg.slice('--browser='.length).trim() as Browser;
      continue;
    }
    if (arg === '--work-root' && next) {
      opts.workRoot = path.resolve(next.trim());
      i++;
      continue;
    }
    if (arg.startsWith('--work-root=')) {
      opts.workRoot = path.resolve(arg.slice('--work-root='.length).trim());
      continue;
    }
    if (arg === '--upload-concurrency' && next) {
      opts.uploadConcurrency = Number(next);
      i++;
      continue;
    }
    if (arg.startsWith('--upload-concurrency=')) {
      opts.uploadConcurrency = Number(arg.slice('--upload-concurrency='.length));
      continue;
    }
    if (arg === '--asr-concurrency' && next) {
      opts.asrConcurrency = Number(next);
      i++;
      continue;
    }
    if (arg.startsWith('--asr-concurrency=')) {
      opts.asrConcurrency = Number(arg.slice('--asr-concurrency='.length));
      continue;
    }
    if (arg === '--translate-concurrency' && next) {
      opts.translateConcurrency = Number(next);
      i++;
      continue;
    }
    if (arg.startsWith('--translate-concurrency=')) {
      opts.translateConcurrency = Number(arg.slice('--translate-concurrency='.length));
      continue;
    }
    if (arg === '--segment-sec' && next) {
      opts.segmentSec = Number(next);
      i++;
      continue;
    }
    if (arg.startsWith('--segment-sec=')) {
      opts.segmentSec = Number(arg.slice('--segment-sec='.length));
      continue;
    }
  }

  if (!Number.isFinite(opts.uploadConcurrency) || opts.uploadConcurrency < 1) {
    opts.uploadConcurrency = 3;
  }
  if (!Number.isFinite(opts.asrConcurrency) || opts.asrConcurrency < 1) {
    opts.asrConcurrency = 3;
  }
  if (!Number.isFinite(opts.translateConcurrency) || opts.translateConcurrency < 1) {
    opts.translateConcurrency = 3;
  }
  if (!Number.isFinite(opts.segmentSec) || opts.segmentSec < 30) {
    opts.segmentSec = 120;
  }

  return opts;
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function extractVideoId(value: string): string {
  const trimmed = value.trim();
  const direct = trimmed.match(/^[a-zA-Z0-9_-]{11}$/)?.[0];
  if (direct) return direct;

  try {
    const url = new URL(trimmed);
    const v = url.searchParams.get('v')?.trim();
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    if ((url.hostname === 'youtu.be' || url.hostname.endsWith('.youtu.be')) && url.pathname !== '/') {
      const shortId = url.pathname.replace(/^\/+/, '').trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(shortId)) return shortId;
    }
    const pathMatch = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
    if (pathMatch?.[1] && /^[a-zA-Z0-9_-]{11}$/.test(pathMatch[1])) {
      return pathMatch[1];
    }
  } catch {
    // ignore
  }

  const queryMatch = trimmed.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (queryMatch?.[1]) return queryMatch[1];
  throw new Error(`没有识别到有效的 YouTube 视频 ID: ${value}`);
}

function sanitizeYoutubeUrl(rawUrl: string): string {
  return `https://www.youtube.com/watch?v=${extractVideoId(rawUrl)}`;
}

function formatDate(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd || '未知';
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function isRecentEnough(yyyymmdd: string, maxAgeDays = 14): boolean {
  if (!/^\d{8}$/.test(yyyymmdd)) return false;
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6)) - 1;
  const day = Number(yyyymmdd.slice(6, 8));
  const publishedAt = new Date(year, month, day).getTime();
  if (!Number.isFinite(publishedAt)) return false;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  return Date.now() - publishedAt <= maxAgeMs;
}

function looksLikeGoodLearningVideo(title: string, durationSec: number): boolean {
  const cleaned = title.trim().toLowerCase();
  if (!cleaned) return false;
  if (durationSec < 240 || durationSec > 20 * 60) return false;
  if (
    /box set|mega-class|playlist|livestream|live stream|24\/7|podcast/i.test(cleaned)
  ) {
    return false;
  }
  return true;
}

function runCommand(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    printStdout?: boolean;
    printStderr?: boolean;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (opts.printStdout) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (opts.printStderr !== false) process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} 退出码 ${code}\n${stderr || stdout}`));
      }
    });
  });
}

async function listLatestChannelUrls(channelUrl: string): Promise<string[]> {
  const { stdout } = await runCommand(
    'yt-dlp',
    [
      '--flat-playlist',
      '--playlist-end',
      '6',
      '--print',
      'https://www.youtube.com/watch?v=%(id)s',
      channelUrl,
    ],
    { printStderr: false }
  );

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function probeVideo(browser: Browser, url: string): Promise<VideoCandidate | null> {
  const { stdout } = await runCommand(
    'yt-dlp',
    [
      '--cookies-from-browser',
      browser,
      '--print',
      '%(upload_date)s\t%(duration)s\t%(channel)s\t%(title)s',
      url,
    ],
    { printStderr: false }
  );

  const line = stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (!line) return null;

  const [uploadDate = '', duration = '0', channel = '', title = ''] = line.split('\t');
  const durationSec = Number(duration) || 0;

  return {
    channel,
    channelUrl: '',
    url,
    title,
    uploadDate,
    durationSec,
  };
}

async function pickDailyVideo(browser: Browser): Promise<VideoCandidate> {
  section('挑选今日视频');

  for (const source of SOURCE_CHANNELS) {
    console.log(`扫描频道: ${source.channel}`);
    const urls = await listLatestChannelUrls(source.url);

    for (const url of urls) {
      const meta = await probeVideo(browser, url);
      if (!meta) continue;

      console.log(
        `- ${formatDate(meta.uploadDate)} | ${Math.round(meta.durationSec / 60)} 分钟 | ${meta.title}`
      );

      if (!isRecentEnough(meta.uploadDate)) continue;
      if (!looksLikeGoodLearningVideo(meta.title, meta.durationSec)) continue;

      return {
        ...meta,
        channel: meta.channel || source.channel,
        channelUrl: source.url,
      };
    }
  }

  throw new Error('没有找到最近两周内、时长合适的英语学习视频');
}

async function downloadVideo(
  browser: Browser,
  url: string,
  targetDir: string
): Promise<{ videoPath: string; infoPath: string }> {
  fs.mkdirSync(targetDir, { recursive: true });

  const existingVideo = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(targetDir, entry.name))
    .find((file) => /\.(mp4|mkv|webm|mov|m4v)$/i.test(file));
  const existingInfo = path.join(targetDir, 'source.info.json');
  if (existingVideo && fs.existsSync(existingInfo)) {
    console.log(`复用已下载视频: ${existingVideo}`);
    return { videoPath: existingVideo, infoPath: existingInfo };
  }

  section('下载源视频');
  const args = [
    '--cookies-from-browser',
    browser,
    '-f',
    'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b',
    '--merge-output-format',
    'mp4',
    '--write-info-json',
    '--output',
    path.join(targetDir, 'source.%(ext)s'),
    '--print',
    'after_move:%(filepath)s',
    url,
  ];

  const { stdout } = await runCommand('yt-dlp', args, {
    cwd: targetDir,
    printStdout: true,
    printStderr: true,
  });

  const finalPath = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => /\.(mp4|mkv|webm|mov|m4v)$/i.test(line));
  if (!finalPath || !fs.existsSync(finalPath)) {
    throw new Error('下载完成后没有找到视频文件');
  }

  const infoPath = path.join(targetDir, 'source.info.json');
  if (!fs.existsSync(infoPath)) {
    throw new Error(`缺少 info.json: ${infoPath}`);
  }

  return { videoPath: finalPath, infoPath };
}

function readVideoMetadata(infoPath: string, fallbackUrl: string): VideoMetadata {
  const raw = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as Record<string, any>;
  return {
    id: String(raw.id || extractVideoId(fallbackUrl)),
    title: String(raw.title || 'Unknown title'),
    channel: String(raw.channel || raw.uploader || 'Unknown channel'),
    uploadDate: String(raw.upload_date || ''),
    durationSec: Number(raw.duration || 0),
    description: typeof raw.description === 'string' ? raw.description : '',
    webpageUrl: String(raw.webpage_url || fallbackUrl),
  };
}

async function buildBilingualAssets(
  videoPath: string,
  opts: Pick<DailyOptions, 'uploadConcurrency' | 'asrConcurrency' | 'translateConcurrency' | 'segmentSec'>
): Promise<{
  cues: SubtitleCue[];
  srtPath: string;
  bilingualSrtPath: string;
  bilingualVideoPath: string;
}> {
  section('切分音频');
  const segments = await splitAudioSegments({
    videoPath,
    segmentSec: opts.segmentSec,
    onProgress: (percent) => {
      process.stdout.write(`\r音频切分进度: ${String(percent).padStart(3, ' ')}%`);
      if (percent >= 100) process.stdout.write('\n');
    },
  });
  console.log(`切出 ${segments.length} 段`);

  section('上传音频到 OSS');
  const uploaded = await pMap(
    segments,
    async (seg, idx, workerId) => {
      console.log(`worker ${workerId + 1} 上传 ${idx + 1}/${segments.length}`);
      const result = await uploadToOss(seg.path);
      return { ...seg, ...result };
    },
    opts.uploadConcurrency
  );

  section('ASR 识别字幕');
  const perSegCues = await pMap(
    uploaded,
    async (seg, idx, workerId) => {
      console.log(`worker ${workerId + 1} 识别 ${idx + 1}/${uploaded.length}`);
      const cues = await transcribe(seg.signedUrl, {
        languageHints: ['en'],
        onStatus: (status) => {
          if (status === 'RUNNING' || status === 'SUCCEEDED' || status.startsWith('任务已提交')) {
            console.log(`  段 ${idx + 1}: ${status}`);
          }
        },
      });
      return cues.map((cue) => ({
        ...cue,
        startMs: cue.startMs + seg.offsetMs,
        endMs: cue.endMs + seg.offsetMs,
        words: cue.words?.map((word: SubtitleWord) => ({
          ...word,
          startMs: word.startMs + seg.offsetMs,
          endMs: word.endMs + seg.offsetMs,
        })),
      }));
    },
    opts.asrConcurrency
  );

  const englishCues = retimeCuesFromWords(
    perSegCues
      .flat()
      .sort((a, b) => a.startMs - b.startMs)
      .map((cue, idx) => ({ ...cue, id: idx }))
  );
  const srtPath = saveSubtitleBesideVideo(videoPath, englishCues, '');
  console.log(`英文字幕已生成: ${srtPath}`);

  section('翻译中文字幕');
  const target = getConfig().translateTarget || '中文';
  const bilingualCues = await translateCues(englishCues, {
    target,
    concurrency: opts.translateConcurrency,
    onStart: (info) => {
      console.log(
        `worker ${info.workerId + 1} 翻译第 ${info.batchIndex + 1}/${info.batchTotal} 批`
      );
    },
    onBatch: (info) => {
      console.log(`完成第 ${info.batchIndex + 1}/${info.batchTotal} 批`);
    },
  });
  const bilingualSrtPath = saveSubtitleBesideVideo(videoPath, bilingualCues, '.bilingual');
  console.log(`双语字幕已生成: ${bilingualSrtPath}`);

  section('导出 B 站成片');
  const exported = await exportStudyVideos({
    videoPath,
    cues: bilingualCues,
    selection: {
      plain: false,
      english: false,
      bilingual: true,
      dubbed: false,
    },
    onProgress: (_percent, message) => {
      console.log(message);
    },
  });

  if (!exported.bilingualSubtitleVideoPath) {
    throw new Error('没有导出出双语字幕视频');
  }

  return {
    cues: bilingualCues,
    srtPath,
    bilingualSrtPath,
    bilingualVideoPath: exported.bilingualSubtitleVideoPath,
  };
}

function buildBilibiliCopy(metadata: VideoMetadata): { title: string; description: string } {
  const cleanTitle = metadata.title.replace(/\s+/g, ' ').trim();
  const publishDate = formatDate(metadata.uploadDate);
  const title = `【英语学习】${cleanTitle}｜双语字幕`;
  const description = [
    '这个视频是从 YouTube 搬运过来的📺',
    `原视频标题：${cleanTitle}`,
    `原频道：${metadata.channel}`,
    `发布时间：${publishDate}`,
    `原视频链接：${metadata.webpageUrl}`,
    '',
    '使用了开源工具 👉 https://github.com/3bDjrvHs50kiZIJb5/Youtube_Learner',
    '对视频进行了整理和转发到 B 站，方便大家观看和学习。',
    '',
    '如果觉得内容不错，欢迎点赞、收藏支持一下 👍',
    '如有侵权会第一时间删除。',
  ].join('\n');
  return { title, description };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.workRoot, { recursive: true });

  const cfg = getConfig();
  if (!cfg.dashscopeApiKey || !cfg.oss.accessKeyId || !cfg.oss.accessKeySecret) {
    throw new Error('缺少 DashScope 或 OSS 配置，先在 GUI 设置页保存一次配置');
  }

  const selected =
    opts.url
      ? {
          url: sanitizeYoutubeUrl(opts.url),
          title: '',
          channel: '',
          channelUrl: '',
          uploadDate: '',
          durationSec: 0,
        }
      : await pickDailyVideo(opts.browser);

  const videoUrl = sanitizeYoutubeUrl(selected.url);
  const videoId = extractVideoId(videoUrl);
  const workDir = path.join(opts.workRoot, videoId);
  const sourceDir = path.join(workDir, 'source');
  fs.mkdirSync(workDir, { recursive: true });

  const { videoPath, infoPath } = await downloadVideo(opts.browser, videoUrl, sourceDir);
  const metadata = readVideoMetadata(infoPath, videoUrl);

  section('今日选题');
  console.log(`标题: ${metadata.title}`);
  console.log(`频道: ${metadata.channel}`);
  console.log(`发布日期: ${formatDate(metadata.uploadDate)}`);
  console.log(`链接: ${metadata.webpageUrl}`);

  const built = await buildBilingualAssets(videoPath, opts);
  const copy = buildBilibiliCopy(metadata);

  section('生成投稿文案');
  const titlePath = path.join(workDir, 'bilibili.title.txt');
  const descriptionPath = path.join(workDir, 'bilibili.description.txt');
  fs.writeFileSync(titlePath, `${copy.title}\n`, 'utf-8');
  fs.writeFileSync(descriptionPath, `${copy.description}\n`, 'utf-8');

  const manifestPath = path.join(workDir, 'publish-summary.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        selectedAt: new Date().toISOString(),
        metadata,
        outputs: {
          videoPath,
          srtPath: built.srtPath,
          bilingualSrtPath: built.bilingualSrtPath,
          bilingualVideoPath: built.bilingualVideoPath,
          titlePath,
          descriptionPath,
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  section('完成');
  console.log(`成片: ${built.bilingualVideoPath}`);
  console.log(`标题文案: ${titlePath}`);
  console.log(`简介文案: ${descriptionPath}`);
  console.log(`汇总清单: ${manifestPath}`);
}

main().catch((err) => {
  console.error('\n流程失败:');
  console.error(err?.stack || err);
  process.exit(1);
});
