import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { registerIpcHandlers } from './ipc/register';
import { cleanupOldOssAudio } from './services/oss';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

// 注册自定义协议，用于在渲染进程安全地加载本地视频/音频文件
// 在渲染进程中 <video src="app-media:///绝对路径.webm">
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: '#111418',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  // 处理 app-media:// 协议，拿到后面的绝对路径直接读文件
  // URL 形如 app-media://local/Users/.../file.webm
  // 其中 "local" 是一个伪 host（因为 standard scheme 会把 URL 解析为 scheme://host/path，
  // 首段会被 lowercase 掉，所以必须单独占位，真正的路径放在 pathname 里）
  protocol.handle('app-media', async (request) => {
    try {
      const url = new URL(request.url);
      let filePath = decodeURIComponent(url.pathname);
      // Windows: /C:/Users/... 要去掉前导 /,变成 C:/Users/...
      if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
      if (!fs.existsSync(filePath)) {
        console.error('[app-media] not found:', filePath);
        return new Response('Not Found', { status: 404 });
      }

      const stat = fs.statSync(filePath);
      const total = stat.size;
      const ext = path.extname(filePath).toLowerCase();
      const contentType =
        ext === '.webm' ? 'video/webm' :
        ext === '.mp4' || ext === '.m4v' ? 'video/mp4' :
        ext === '.mkv' ? 'video/x-matroska' :
        ext === '.mov' ? 'video/quicktime' :
        ext === '.avi' ? 'video/x-msvideo' :
        ext === '.wav' ? 'audio/wav' :
        ext === '.mp3' ? 'audio/mpeg' :
        'application/octet-stream';

      // 解析 Range 请求头 —— <video> seek 必需
      // 没有 handler 处理 Range 时,Chromium 会把整个文件从头重放,导致 currentTime 卡 0
      const rangeHeader = request.headers.get('range') || request.headers.get('Range');
      if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
        if (isNaN(start) || isNaN(end) || start > end || end >= total) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${total}` },
          });
        }
        const chunkSize = end - start + 1;
        const nodeStream = fs.createReadStream(filePath, { start, end });
        const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
        return new Response(webStream, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }

      const nodeStream = fs.createReadStream(filePath);
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
        },
      });
    } catch (err) {
      console.error('[app-media] error:', err);
      return new Response(`app-media error: ${(err as Error).message}`, { status: 500 });
    }
  });

  registerIpcHandlers(ipcMain);
  createWindow();

  // 启动后异步清理 OSS 上 7 天前的旧音频, 失败不影响应用启动
  // 延迟 3 秒执行, 避免和窗口初始化抢网络资源
  setTimeout(() => {
    cleanupOldOssAudio(7).catch((err) => {
      console.warn('[main] OSS 清理任务异常:', err);
    });
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
