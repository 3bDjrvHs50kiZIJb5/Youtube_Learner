/**
 * 全局 toast 派发工具。
 * 非 App.tsx 内的组件/工具模块(比如 utils/tts.ts)想弹 toast 时调用 showToast,
 * App.tsx 内监听 'app-toast' 事件并复用自己的 toast 状态渲染。
 *
 * 这样不用把 setToast 往下一层层传,也不用引入 Context。
 */
export const APP_TOAST_EVENT = 'app-toast';

export interface AppToastDetail {
  message: string;
}

export function showToast(message: string) {
  if (!message) return;
  try {
    window.dispatchEvent(
      new CustomEvent<AppToastDetail>(APP_TOAST_EVENT, { detail: { message } })
    );
  } catch {
    // 非浏览器环境忽略
  }
}
