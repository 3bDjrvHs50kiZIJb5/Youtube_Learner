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

/**
 * 清理 OSS 上指定前缀下"过期"的音频文件。
 *
 * 为什么要做这件事:
 *  - 每次跑 ASR 都会把切好的音频段上传到 OSS,体积累积很快。
 *  - DashScope 只需要在 ASR 任务期间能访问这些文件,任务结束后就可以删了。
 *  - 默认保留 7 天做兜底(防止用户中途中断,下次续跑时段还能直接复用),过期的就清掉。
 *
 * 实现要点:
 *  - 走分页 list 接口(单次最多 1000 个),用 nextMarker 翻页,直到 isTruncated=false。
 *  - 只清理 prefix 下的对象,不影响 bucket 里其他目录。
 *  - 批量删除用 deleteMulti,一次最多 1000 个,网络开销更小。
 *  - 任意一步失败都 try/catch 掉,不要让"清理任务"把整个 app 启动流程搞崩。
 */
export async function cleanupOldOssAudio(
  olderThanDays = 7
): Promise<{ scanned: number; removed: number; skipped: number }> {
  const result = { scanned: 0, removed: 0, skipped: 0 };

  const { oss } = getConfig();
  if (!oss.accessKeyId || !oss.accessKeySecret || !oss.bucket) {
    console.log('[oss-cleanup] OSS 未配置, 跳过清理');
    return result;
  }

  const prefix = oss.prefix || 'video-learner/';
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const client = getClient();

  const expiredKeys: string[] = [];

  let marker: string | undefined = undefined;
  // 翻页扫描, 收集所有过期 object key
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let resp: any;
    try {
      resp = await client.list(
        {
          prefix,
          marker,
          'max-keys': 1000,
        },
        {}
      );
    } catch (err) {
      console.warn('[oss-cleanup] 列表 OSS 失败:', err);
      return result;
    }

    const objects: Array<{ name: string; lastModified: string }> = resp?.objects || [];
    for (const obj of objects) {
      result.scanned++;
      const modified = new Date(obj.lastModified).getTime();
      if (Number.isFinite(modified) && modified < cutoff) {
        expiredKeys.push(obj.name);
      } else {
        result.skipped++;
      }
    }

    if (!resp?.isTruncated) break;
    marker = resp.nextMarker;
    if (!marker) break;
  }

  if (expiredKeys.length === 0) {
    console.log(`[oss-cleanup] 扫描 ${result.scanned} 个对象, 无过期音频`);
    return result;
  }

  // 批量删除, 一次最多 1000 个
  for (let i = 0; i < expiredKeys.length; i += 1000) {
    const batch = expiredKeys.slice(i, i + 1000);
    try {
      await client.deleteMulti(batch, { quiet: true });
      result.removed += batch.length;
    } catch (err) {
      console.warn('[oss-cleanup] 批量删除失败:', err);
    }
  }

  console.log(
    `[oss-cleanup] 完成: 扫描 ${result.scanned} / 过期 ${expiredKeys.length} / 实际删除 ${result.removed}`
  );
  return result;
}
