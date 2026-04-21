import OSS from 'ali-oss';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getConfig } from './config';

function randomId(n = 8): string {
  return crypto.randomBytes(n).toString('hex').slice(0, n);
}

/**
 * 规范化 region:
 * - ali-oss SDK 要求 region 必须以 "oss-" 开头 (例如 oss-cn-hangzhou)
 * - 但阿里云控制台里显示的常常是 "cn-hangzhou",自动给它补前缀
 * - 如果用户填的是完整 endpoint (包含 ".aliyuncs.com") 则用 endpoint 模式
 */
function buildClientOptions() {
  const { oss } = getConfig();
  if (!oss.accessKeyId || !oss.accessKeySecret || !oss.bucket) {
    throw new Error('请先在「设置」里配置阿里云 OSS(region / bucket / accessKey)');
  }
  const raw = (oss.region || '').trim();
  if (!raw) throw new Error('OSS region 未配置');

  const base = {
    accessKeyId: oss.accessKeyId,
    accessKeySecret: oss.accessKeySecret,
    bucket: oss.bucket,
    secure: true,
  } as const;

  // 如果用户直接填了完整 endpoint,用 endpoint 模式
  if (raw.includes('aliyuncs.com') || raw.startsWith('http')) {
    const endpoint = raw.startsWith('http') ? raw : `https://${raw}`;
    return { ...base, endpoint };
  }

  // 否则当 region 处理,自动补 "oss-" 前缀
  const region = raw.startsWith('oss-') ? raw : `oss-${raw}`;
  return { ...base, region };
}

function getClient(): OSS {
  return new OSS(buildClientOptions());
}

/** 给已经在 OSS 上的 objectKey 重新签一个 URL(用于状态恢复后 URL 已过期的场景) */
export function signOssUrl(objectKey: string, expiresSec = 2 * 60 * 60): string {
  const client = getClient();
  return client.signatureUrl(objectKey, { expires: expiresSec });
}

/**
 * 上传本地文件到 OSS，返回可访问 URL。
 * 为了让千问能拉到，这里签一个 2 小时有效的签名 URL。
 */
export async function uploadToOss(
  localPath: string,
  opts: { onProgress?: (percent: number) => void } = {}
): Promise<{ objectKey: string; signedUrl: string }> {
  if (!fs.existsSync(localPath)) throw new Error(`文件不存在: ${localPath}`);
  const client = getClient();
  const { oss } = getConfig();
  const prefix = oss.prefix || 'video-learner/';
  const ext = path.extname(localPath);
  const objectKey = `${prefix}${Date.now()}-${randomId(8)}${ext}`;

  await client.multipartUpload(objectKey, localPath, {
    progress: async (p) => opts.onProgress?.(Math.round(p * 100)),
    parallel: 4,
    partSize: 1024 * 1024,
  });

  const signedUrl = client.signatureUrl(objectKey, { expires: 2 * 60 * 60 });
  return { objectKey, signedUrl };
}
