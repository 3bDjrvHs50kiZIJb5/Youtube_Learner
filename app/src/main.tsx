import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './types';

// 阻止窗口默认的文件拖拽行为:不做的话把视频拖到空白区域
// Chromium 会尝试以 file:// 方式打开,直接把整个应用替换掉
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
