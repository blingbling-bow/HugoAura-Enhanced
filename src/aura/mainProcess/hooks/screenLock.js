// @ts-check

/**
 * 锁屏窗口键盘钩子解除 (窗口级钩子, 目标窗口: screenLock)
 *
 * 背景: 锁屏窗口由锁屏任务控制器 (模块 33) 的 startLock() 创建, 管家自己会调用
 * 模块 29 的 dllForHookBoard.SetKeyboardHook() 挂钩键盘 (屏蔽 Win 键等)。本钩子
 * 在 rewrite["vendor/screenLock"].disableKeyboardHook 打开时, 调用同一个
 * dllForHookBoard.UnHookKeyBoard() 解除该挂钩。
 *
 * 为什么延迟 1 秒: 与本钩子的安装时机及管家自身的 SetKeyboardHook() 存在时序竞争,
 * 过早就地解除会被随后执行的 SetKeyboardHook() 覆盖。
 *
 * 版本容错 (与其余钩子的"优雅降级"约定一致, 失败一律不抛异常):
 *   - 配置读取失败按"未开启"处理;
 *   - 模块 29 或其 dllForHookBoard.UnHookKeyBoard 缺失时, 打印一次诊断日志后
 *     跳过, 键盘钩子保持原生状态;
 *   - 真正的调用发生在 setTimeout 回调里 —— 定时器中的异常不会被调用方捕获,
 *     会升级为主进程未捕获异常, 因此就地 try/catch。
 */

const hookFn = (central, appIns, browserWindowIns) => {
  const __config =
    (global.__HUGO_AURA_CONFIG__ &&
      global.__HUGO_AURA_CONFIG__.rewrite &&
      global.__HUGO_AURA_CONFIG__.rewrite["vendor/screenLock"]) ||
    {};

  const removeKeyboardHook = () => {
    // 运行时自检: 模块 29 需提供 dllForHookBoard.UnHookKeyBoard
    let dllForHookBoard = null;
    try {
      const boardModule = central(29);
      dllForHookBoard = boardModule && boardModule.dllForHookBoard;
    } catch (err) {
      console.warn("[HugoAura / ScreenLock] Failed to resolve module 29:", err);
      return;
    }

    if (
      !dllForHookBoard ||
      typeof dllForHookBoard.UnHookKeyBoard !== "function"
    ) {
      console.warn(
        "[HugoAura / ScreenLock] Self-check failed: module 29 has no dllForHookBoard.UnHookKeyBoard, keyboard hook left intact."
      );
      return;
    }

    setTimeout(() => {
      try {
        dllForHookBoard.UnHookKeyBoard();
      } catch (err) {
        console.warn("[HugoAura / ScreenLock] Failed to unhook keyboard:", err);
      }
    }, 1000);
  };

  if (__config.disableKeyboardHook) {
    removeKeyboardHook();
  }
};

module.exports = { hookFunc: hookFn };
