// 独立测试语音转文字 (阿里云百炼 Paraformer) 接口
// 流程: ffmpeg 切一小段音频 -> 上传 OSS -> 提交 ASR 异步任务 -> 轮询 -> 打印结果
//
// 运行: cd app && node scripts/test-asr.mjs [视频路径] [秒数]
//   默认视频: 仓库根目录下那个 godot 教程 webm
//   默认截取前 30 秒

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import axios from 'axios';
import OSS from 'ali-oss';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_VIDEO = path.join(
  REPO_ROOT,
  'How to make a Video Game - Godot Beginner Tutorial [LOhfqjmasi0].webm'
);

function loadConfig() {
  const cfgPath = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'video-learner',
    'video-learner-config.json'
  );
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`找不到配置文件: ${cfgPath}`);
  }
  return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
}

function extractClip(videoPath, seconds, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoPath,
      '-vn',
      '-t', String(seconds),
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      outPath,
    ];
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (c) => (stderr += c.toString()));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve(outPath);
      else reject(new Error(`ffmpeg 退出码 ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

function buildOssClient(cfg) {
  const raw = (cfg.oss.region || '').trim();
  const base = {
    accessKeyId: cfg.oss.accessKeyId,
    accessKeySecret: cfg.oss.accessKeySecret,
    bucket: cfg.oss.bucket,
    secure: true,
  };
  if (raw.includes('aliyuncs.com') || raw.startsWith('http')) {
    const endpoint = raw.startsWith('http') ? raw : `https://${raw}`;
    return new OSS({ ...base, endpoint });
  }
  const region = raw.startsWith('oss-') ? raw : `oss-${raw}`;
  return new OSS({ ...base, region });
}

async function uploadToOss(client, prefix, localPath) {
  const ext = path.extname(localPath);
  const randomId = crypto.randomBytes(8).toString('hex').slice(0, 8);
  const objectKey = `${prefix || 'video-learner/'}test-asr-${Date.now()}-${randomId}${ext}`;
  await client.multipartUpload(objectKey, localPath, {
    parallel: 4,
    partSize: 1024 * 1024,
  });
  const signedUrl = client.signatureUrl(objectKey, { expires: 2 * 60 * 60 });
  return { objectKey, signedUrl };
}

async function submitAsrTask(apiKey, fileUrl) {
  const resp = await axios.post(
    'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription',
    {
      model: 'paraformer-v2',
      input: { file_urls: [fileUrl] },
      parameters: { language_hints: ['en'] },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
    }
  );
  const taskId = resp.data?.output?.task_id;
  if (!taskId) throw new Error(`提交失败: ${JSON.stringify(resp.data)}`);
  return taskId;
}

async function pollAsrTask(apiKey, taskId) {
  const deadline = Date.now() + 10 * 60 * 1000; // 10 分钟
  let lastStatus = '';
  while (Date.now() < deadline) {
    const resp = await axios.get(
      `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    const out = resp.data.output;
    if (out.task_status !== lastStatus) {
      console.log(`  [状态] ${out.task_status}`);
      lastStatus = out.task_status;
    }
    if (out.task_status === 'SUCCEEDED') return out;
    if (out.task_status === 'FAILED') {
      throw new Error(`ASR 失败: ${out.message || JSON.stringify(out)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('轮询超时');
}

async function main() {
  const videoPath = process.argv[2] || DEFAULT_VIDEO;
  const seconds = Number(process.argv[3] || 30);

  console.log('=== ASR 接口测试 ===');
  console.log(`视频: ${videoPath}`);
  console.log(`截取前 ${seconds} 秒音频`);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`视频不存在: ${videoPath}`);
  }

  const cfg = loadConfig();
  if (!cfg.dashscopeApiKey) throw new Error('配置里缺 dashscopeApiKey');
  console.log(`DashScope Key: ${cfg.dashscopeApiKey.slice(0, 8)}***`);
  console.log(`OSS bucket: ${cfg.oss.bucket} @ ${cfg.oss.region}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-test-'));
  const clipPath = path.join(tmpDir, 'clip.wav');

  console.log('\n[1/4] ffmpeg 切音频…');
  const t0 = Date.now();
  await extractClip(videoPath, seconds, clipPath);
  const size = fs.statSync(clipPath).size;
  console.log(`  -> ${clipPath} (${(size / 1024).toFixed(1)} KB, ${Date.now() - t0}ms)`);

  console.log('\n[2/4] 上传 OSS…');
  const t1 = Date.now();
  const ossClient = buildOssClient(cfg);
  const { objectKey, signedUrl } = await uploadToOss(
    ossClient,
    cfg.oss.prefix,
    clipPath
  );
  console.log(`  -> objectKey: ${objectKey}`);
  console.log(`  -> signedUrl: ${signedUrl.slice(0, 120)}...`);
  console.log(`  耗时: ${Date.now() - t1}ms`);

  console.log('\n[3/4] 提交 ASR 异步任务…');
  const t2 = Date.now();
  const taskId = await submitAsrTask(cfg.dashscopeApiKey, signedUrl);
  console.log(`  -> taskId: ${taskId}`);

  console.log('\n[4/4] 轮询任务结果…');
  const out = await pollAsrTask(cfg.dashscopeApiKey, taskId);
  console.log(`  耗时: ${Date.now() - t2}ms`);

  const transcriptionUrl = out.results?.[0]?.transcription_url;
  if (!transcriptionUrl) {
    throw new Error(`缺少 transcription_url: ${JSON.stringify(out)}`);
  }
  console.log(`  transcription_url: ${transcriptionUrl.slice(0, 120)}...`);

  const { data } = await axios.get(transcriptionUrl);
  const sentences = data.transcripts?.[0]?.sentences || [];
  console.log(`\n=== 识别成功,共 ${sentences.length} 句 ===`);
  for (const s of sentences.slice(0, 15)) {
    const start = (s.begin_time / 1000).toFixed(2);
    const end = (s.end_time / 1000).toFixed(2);
    console.log(`  [${start}s - ${end}s] ${s.text}`);
  }
  if (sentences.length > 15) {
    console.log(`  ... 还有 ${sentences.length - 15} 句未展示`);
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  console.log('\n✅ 接口正常');
}

main().catch((err) => {
  console.error('\n❌ 测试失败:');
  if (err.response) {
    console.error('  HTTP', err.response.status, err.response.statusText);
    console.error('  body:', JSON.stringify(err.response.data, null, 2));
  } else {
    console.error(' ', err?.stack || err);
  }
  process.exit(1);
});
