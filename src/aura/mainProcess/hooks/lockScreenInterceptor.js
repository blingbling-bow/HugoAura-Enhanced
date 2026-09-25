// @ts-check

/**
 * 远程锁屏指令拦截 (Lock-Screen Interceptor)
 *
 * 原理: 希沃管家通过 hugoServiceWebsocket (模块 399) 接收云端集控下发的
 * 锁屏指令, 分发到锁屏任务控制器 (模块 33, 单例):
 *   模块 399.onMessage → JSON.parse → d.onMessage(t) [d = 模块 33]
 *   模块 33.onMessage 命中 messageType === 1211 且 data.screenLockStatus === 1
 *   后调用 startLockTask(), 创建全屏 screenLock_<display> 窗口并挂钩键盘。
 *
 * 本钩子包装模块 33 的 onMessage:
 *   1. block 模式: 吞掉锁屏指令, 设备不会被远程锁屏, 并伪造锁屏回执
 *      (模块 310 → POST /screenlock/lockfeedback), 使集控端仍显示"已锁屏",
 *      避免对端判定指令未生效而重发或留下异常记录。
 *   2. notify 模式: 延迟 10 秒放行指令, 弹窗提醒用户; 期间重复下发的
 *      指令被去抖吞掉 (只保留一次延迟放行)。
 *   3. 解锁指令的冗余兜底 (伪造锁屏回执后, 集控端随后必然回下解锁指令):
 *      - 只要管家侧存在任何真实锁屏迹象 (message 非空 或 已创建锁屏窗口),
 *        解锁指令一律原样交回管家, 任何情况下都不会出现"无法解锁";
 *      - 确认无锁时才就地接管: 直接调用管家自身的解锁例程 stopLockTask(),
 *        其内部的状态清理 (清缓存 / 广播 SCREEN_LOCK_FEEDBACK / 复位错误计数
 *        / 关闭锁屏窗口 / 退出任务队列) 与解锁回执 (模块 311 → unlockfeedback)
 *        与原生完全一致, 唯一差别是省掉原 onMessage 在"无锁"分支打出的
 *        "解锁指令异常，不存在锁屏" 异常日志 (该日志出现在被拦截过的设备上
 *        即为破绽)。接管失败时原样交回管家, 保证解锁链路零影响;
 *      - 若解锁指令落在 notify 模式的 10 秒延迟窗口内, 同时取消那次待放行的
 *        锁屏, 避免"已代答解锁、10 秒后却真的锁屏"的矛盾。
 *      - 回执通道不可用时一律放行真实锁屏 (fail-closed), 见下。
 *   4. 审计日志写入 cloudCommandAudit.log (复用云端指令审计通道)。
 *
 * fail-closed (隐蔽优先):
 *   管家更新后若回执上报模块 (310/311) 消失或不再是函数, 说明模块编号假设
 *   已失效。此时绝不"拦了却不回执" —— 安装阶段直接禁用本功能 (不挂钩子),
 *   运行阶段则放弃拦截、把锁屏指令交回管家执行, 让设备状态与集控端始终一致,
 *   不在对端留下任何异常。端口未就绪时管家自身 register 机制会挂起回调直到
 *   端口发现, 属于正常路径, 不算失败。
 *
 * 为什么包装模块 33 而不是 WS 客户端 (模块 399):
 *   模块 399 的分发器以 `d.onMessage(t)` 形式在调用时做属性查找, 因此替换
 *   模块 33 实例的 onMessage 即可生效, 不依赖 WS 基类 (模块 18) create()
 *   在连接建立时对 onMessage 的一次性解构, 无时序竞态。
 *
 * 注意:
 *   - 本地 "锁屏" 按钮走 IPC 通道 (windowMessage → startLockScreen,
 *     模块 375 → 模块 33.userLock()), 不经过 onMessage, 因此不受影响。
 *     本地锁屏会由管家自身再上报一条 operationLogId 为 "0" 的锁屏回执
 *     (startLockTask 内无条件调用模块 310), 与正常用户手动锁屏一致, 不干预。
 *   - messageType 1211 / screenLockStatus 0 为解锁指令, 在有锁时直接放行,
 *     以免设备被锁后无法解锁。
 *
 * 版本容错: 自检失败时优雅降级, 仅打印诊断日志。
 *
 * 回执语义 (重要): 模块 310/311 内部是 `register(["SeewoProxyHTTP"], ...)` +
 * 空回调, 因此"伪造成功"只能判定为"已注册且未抛错", 而非"HTTP 已送达":
 * 代理端口未就绪时回调会排队等待端口发现, 送达时刻不可知, 成败也无法观测。
 * 由此带来的残留情况是: 极端下端未出现时对端收不到回执, 可能重发锁屏指令
 * (我们仍会继续吞掉并再补一条回执), 不会造成设备与对端状态冲突。
 *
 * 原生固有噪声 (排查时别误判成本钩子引入):
 *   - 真实锁屏窗口被销毁/崩溃时, 原生会打 "screenLock_x窗口崩溃了" 并在
 *     startLock() 的 catch 里 console.log("error", ...);
 *   - WS 断开时 onDisconnectMessage → serverDisconnect() 只把 SCREENLOCK
 *     任务出队, 不清 message/windows, 之后远程锁屏只发回执不重建窗口。
 * 两者均为管家自身行为, 本钩子不介入 (我们从不创建锁屏窗口)。
 */

const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");
const auditWriter = require("./auditWriter");

// 锁屏指令特征: messageType 1211, data.screenLockStatus === 1 (1=锁屏, 0=解锁)
const LOCK_MESSAGE_TYPE = 1211;
const LOCK_STATUS_LOCKED = 1;
const LOCK_STATUS_UNLOCKED = 0;
const NOTIFY_DELAY_MS = 10000;

// 回执上报: 管家原逻辑在锁屏/解锁时分别调用模块 310 / 311
// (POST /forward/SeewoHugoHttp/api/v1/screenlock/{lock,unlock}feedback)
// 锁屏回执由本钩子伪造; 解锁回执不自己拼, 交给管家自身的 stopLockTask() 上报 —
// 这里只需要它的模块号 (安装期可用性校验) 与 actionOperator 取值。
const LOCK_FEEDBACK = {
  moduleId: 310,
  status: 1,
  tslKey: "lockStreamControl",
};
const UNLOCK_FEEDBACK = {
  moduleId: 311,
  actionOperator: 1,
};

const hookFn = (central) => {
  // 拿不到 electron 模块时不应中断安装 (后续仅在推送通知/审计事件时降级),
  // 更不能把异常抛回调用方 —— 钩子之间是隔离安装的。
  let electron = null;
  try {
    electron = central(1);
  } catch (err) {
    console.error(
      "[HugoAura / LockScreen] Failed to acquire electron module, notifications will be skipped:",
      err
    );
  }
  let diagLogged = false;
  /** @type {NodeJS.Timeout|null} notify 模式下待放行的锁屏指令 (用于去抖) */
  let pendingLockTimer = null;

  /**
   * 前置校验: 回执上报模块 (310/311) 必须可用, 否则整个功能禁用。
   * 310 用于伪造锁屏回执; 311 是管家 stopLockTask() 内部解锁回执的出口
   * (接管解锁时依赖它, 缺失则接管会抛错)。管家更新若使模块编号假设失效,
   * 宁可完全不介入, 也不出现"拦下锁屏却不回执"的状态不一致 (隐蔽优先)。
   */
  const isFeedbackChannelAvailable = () => {
    try {
      return (
        typeof resolveModule(central, LOCK_FEEDBACK.moduleId) === "function" &&
        typeof resolveModule(central, UNLOCK_FEEDBACK.moduleId) === "function"
      );
    } catch (err) {
      console.error(
        "[HugoAura / LockScreen] Feedback channel check failed:",
        err
      );
      return false;
    }
  };

  if (!isFeedbackChannelAvailable()) {
    console.warn(
      `[HugoAura / LockScreen] Feedback modules (${LOCK_FEEDBACK.moduleId}/${UNLOCK_FEEDBACK.moduleId}) unavailable, feature disabled to keep stealth (fail-closed).`
    );
    return;
  }

  // 复用云端指令审计通道: 推送到渲染层指令审计页面
  const pushAuditEvent = (record) => {
    try {
      if (
        electron &&
        electron.ipcMain &&
        typeof electron.ipcMain.send === "function"
      ) {
        electron.ipcMain.send("*", "$aura.audit.onLog", { record });
      }
    } catch (err) {
      console.error("[HugoAura / LockScreen / Audit / Push Error]", err);
    }
  };

  // 锁屏拦截弹窗通知: 推送到渲染层
  const pushLockNotify = (record) => {
    try {
      if (
        electron &&
        electron.ipcMain &&
        typeof electron.ipcMain.send === "function"
      ) {
        electron.ipcMain.send("*", "$aura.lockScreen.onBlocked", { record });
      }
    } catch (err) {
      console.error("[HugoAura / LockScreen / Notify Error]", err);
    }
  };

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error(
        "[HugoAura / LockScreen / Error] Failed to read config:",
        err
      );
      return null;
    }
  };

  const getInterceptConfig = () => {
    const config = readConfig();
    const cfg =
      config && config.auraSettings && config.auraSettings.lockScreenIntercept;
    if (!cfg || !cfg.enabled) return null;
    return {
      mode: cfg.mode === "notify" ? "notify" : "block",
    };
  };

  // 仅拦截锁屏指令 (screenLockStatus === 1); 解锁指令 (0) 放行
  const isRemoteLock = (parsed) =>
    !!parsed &&
    parsed.messageType === LOCK_MESSAGE_TYPE &&
    !!parsed.data &&
    parsed.data.screenLockStatus === LOCK_STATUS_LOCKED;

  const isUnlockCommand = (parsed) =>
    !!parsed &&
    parsed.messageType === LOCK_MESSAGE_TYPE &&
    !!parsed.data &&
    parsed.data.screenLockStatus === LOCK_STATUS_UNLOCKED;

  const getWsSource = () => {
    try {
      const cfg = central(0);
      const host = cfg && cfg.hugoServiceWebsocket;
      return host && host.ip ? `${host.ip}${host.url || ""}` : "unknown";
    } catch (err) {
      return "unknown";
    }
  };

  /**
   * 代为上报屏幕锁定/解锁回执 (与管家模块 33 使用同一上报通道)
   * @param {{moduleId: number, status: number, tslKey: string, actionOperator?: number}} spec
   * @param {any} operationLogId 原指令的 operationLogId
   * @param {string} reason 日志备注
   * @returns {boolean} 是否成功上报
   */
  const sendScreenLockFeedback = (spec, operationLogId, reason) => {
    try {
      const report = resolveModule(central, spec.moduleId);
      if (typeof report !== "function") {
        throw new Error(`module ${spec.moduleId} is not callable`);
      }
      /** @type {Record<string, any>} */
      const payload = {
        status: spec.status,
        operationLogId: operationLogId || "0",
        tslKey: spec.tslKey,
      };
      if (spec.actionOperator !== undefined) {
        payload.actionOperator = spec.actionOperator;
      }
      report(payload);
      console.log(
        `[HugoAura / LockScreen] Reported ${spec.tslKey} feedback (module ${spec.moduleId}) for ${reason}.`
      );
      return true;
    } catch (err) {
      // 不做异步重试: 失败即同步返回, 交由调用方 fail-closed 处理,
      // 避免"已放行真实锁屏"之后又补发一条重复回执。
      console.error(
        `[HugoAura / LockScreen] ${spec.tslKey} feedback failed:`,
        err
      );
      return false;
    }
  };

  // 审计日志: 复用 cloudCommandAudit.log (写入与轮转统一交给共享写入器,
  // 避免与 cloudUpdateInterceptor / powerOffInterceptor 的句柄互相打架)
  const AUDIT_FILE = "cloudCommandAudit.log";
  const writeAudit = (record) => {
    auditWriter.writeAudit(AUDIT_FILE, record);
  };

  /**
   * 冗余兜底: 只要管家侧存在任何真实锁屏迹象就认为"有锁"。
   * 取双条件 (锁屏指令记录 + 已创建的锁屏窗口), 任一为真都按"有锁"处理,
   * 宁可把解锁交回管家, 也不吞掉可能真实需要的解锁。
   * @param {any} handler 模块 33 实例
   */
  const hasActiveLock = (handler) =>
    !!handler.message ||
    (Array.isArray(handler.windows) && handler.windows.length > 0);

  /**
   * 解锁指令到达但当前无锁屏 (典型的"我们伪造了锁屏回执、集控端随后回下解锁"
   * 场景): 管家的 onMessage 会打 "解锁指令异常，不存在锁屏" 错误日志后走一串
   * 空操作。此处就地接管, 但**沿用管家自身的解锁例程** stopLockTask():
   *   - 状态清理 (p.delete("SCREEN_LOCK") / 广播 SCREEN_LOCK_FEEDBACK /
   *     setData(SCREEN_LOCK_ERROR_COUNT) / message=null / closeWindow() /
   *     outQueue(SCREENLOCK)) 与原生逐条一致;
   *   - 解锁回执由 stopLockTask 内部经模块 311 发出, 与原生同源, 协议零假设。
   * 与原生的唯一差别就是不写那条异常日志。若调用失败则返回 false 交回管家,
   * 让解锁链路与原生完全一致, 绝不因本钩子导致解锁失效。
   * @param {any} handler 模块 33 实例
   * @param {any} parsed 已解析的解锁指令
   * @param {string} mode 当前拦截模式 (仅用于审计记录)
   * @returns {boolean} true=已接管 / false=交回管家原逻辑
   */
  const handleIdleUnlock = (handler, parsed, mode) => {
    // 冗余兜底: notify 模式下若解锁指令在 10 秒延迟窗口内到达, 必须取消那次
    // 待放行的锁屏, 否则解锁被接管后延迟放行仍会真实锁屏, 与对端状态矛盾。
    if (pendingLockTimer) {
      clearTimeout(pendingLockTimer);
      pendingLockTimer = null;
      console.log(
        "[HugoAura / LockScreen] Cancelled the pending delayed lock-screen (unlock command received)."
      );
    }

    if (hasActiveLock(handler)) return false; // 存在真实锁屏, 交回管家原逻辑

    let takenOver = true;
    try {
      if (typeof handler.stopLockTask !== "function") {
        throw new Error("stopLockTask is not callable");
      }
      handler.stopLockTask({
        actionOperator: UNLOCK_FEEDBACK.actionOperator,
        operationLogId: parsed.data.operationLogId,
      });
    } catch (err) {
      takenOver = false;
      console.error(
        "[HugoAura / LockScreen] Idle unlock takeover failed, handing back to the manager:",
        err
      );
    }

    const record = {
      ts: new Date().toISOString(),
      source: getWsSource(),
      channel: "screenLockController",
      url: `messageType:${LOCK_MESSAGE_TYPE}`,
      action: takenOver ? "unlock" : "passthrough_unlock",
      mode,
      data: parsed.data !== undefined ? parsed.data : null,
      _logType: "lockScreen",
    };
    writeAudit(record);
    pushAuditEvent(record);

    if (takenOver) {
      console.log(
        "[HugoAura / LockScreen] Idle remote unlock handled by the manager's own unlock routine."
      );
    }
    return takenOver;
  };

  /**
   * 处理一条锁屏/解锁指令
   * @param {any} handler 模块 33 实例
   * @param {any} parsed 已解析的消息对象
   * @param {() => void} passThrough 放行原始消息
   * @returns {boolean} true 表示已接管 (不再透传)
   */
  const handleLockMessage = (handler, parsed, passThrough) => {
    const isLock = isRemoteLock(parsed);
    const isUnlock = !isLock && isUnlockCommand(parsed);
    if (!isLock && !isUnlock) return false;

    const cfg = getInterceptConfig();
    if (!cfg) {
      if (isLock) {
        // 指令确实到达, 但功能未启用 — 便于排查
        console.log(
          "[HugoAura / LockScreen] Remote lock-screen detected but interception is disabled."
        );
      }
      return false;
    }

    if (isUnlock) return handleIdleUnlock(handler, parsed, cfg.mode);

    const mode = cfg.mode;
    const source = getWsSource();

    if (mode === "notify" && pendingLockTimer) {
      // 去抖: 已有待放行的锁屏指令, 忽略重复下发 (不重复弹窗/计时)
      console.log(
        "[HugoAura / LockScreen] Duplicate remote lock-screen ignored (a delayed dispatch is already pending)."
      );
      return true;
    }

    // block 模式先伪造锁屏回执 (集控端仍认为设备已锁屏), 成功才吞掉指令;
    // 回执通道不可用则 fail-closed: 交回管家执行真实锁屏, 保持状态一致。
    let spoofed = false;
    if (mode === "block") {
      spoofed = sendScreenLockFeedback(
        LOCK_FEEDBACK,
        parsed.data.operationLogId,
        "blocked lock"
      );
    }
    const passedThrough = mode === "block" && !spoofed;

    const record = {
      ts: new Date().toISOString(),
      source,
      channel: "screenLockController",
      url: `messageType:${LOCK_MESSAGE_TYPE}`,
      action: passedThrough
        ? "passthrough"
        : mode === "block"
          ? "blocked"
          : "captured",
      mode,
      feedbackSpoofed: spoofed,
      data: parsed.data !== undefined ? parsed.data : null,
      _logType: "lockScreen",
    };
    writeAudit(record);
    pushAuditEvent(record);
    if (!passedThrough) pushLockNotify(record);

    if (passedThrough) {
      console.warn(
        "[HugoAura / LockScreen] Lock feedback unavailable, falling back to the real lock-screen command (fail-closed) to stay consistent with the control center."
      );
      return false; // 交回管家原逻辑: 真实锁屏 + 真实回执
    }

    if (mode === "block") {
      console.log(
        `[HugoAura / LockScreen] Blocked remote lock-screen from ${source}`
      );
      return true; // 吞掉指令, 设备不会被锁屏
    }

    // notify 模式: 延迟 10 秒后放行, 给用户保存工作的时间
    console.log(
      `[HugoAura / LockScreen] Remote lock-screen detected, delaying ${NOTIFY_DELAY_MS / 1000}s before dispatch (notify mode)`
    );
    pendingLockTimer = setTimeout(() => {
      pendingLockTimer = null;
      try {
        passThrough();
      } catch (err) {
        console.error("[HugoAura / LockScreen / Delayed dispatch error]", err);
      }
    }, NOTIFY_DELAY_MS);
    return true;
  };

  // 单次安装尝试: 成功返回 true, 模块未就绪返回 false (触发重试)
  const tryInstall = () => {
    const handler = resolveModule(central, 33);

    // 运行时自检: 确认模块 33 是锁屏任务控制器 (版本容错)。
    // 首选源码特征, 失败时退化为结构特征 (锁屏控制器独有的方法集)。
    const unboundOnMessage = getPrototypeMethod(handler, "onMessage");
    const isLockController =
      handler &&
      typeof handler.onMessage === "function" &&
      typeof unboundOnMessage === "function" &&
      (String(unboundOnMessage).includes("screenLockStatus") ||
        (typeof handler.startLockTask === "function" &&
          typeof handler.userLock === "function"));

    if (!isLockController) {
      if (!diagLogged) {
        diagLogged = true;
        console.warn(
          `[HugoAura / LockScreen] Module 33 self-check failed. ` +
            `typeof(handler)=${typeof handler}, ` +
            `onMessage=${handler && typeof handler.onMessage}`
        );
      }
      console.debug(
        "[HugoAura / LockScreen] Module 33 not ready, retrying..."
      );
      return false;
    }

    const originalOnMessage = handler.onMessage.bind(handler);
    handler.onMessage = (e) => {
      let parsed = e;
      try {
        if (typeof e === "string") parsed = JSON.parse(e);
      } catch (err) {
        parsed = null;
      }

      let handled = false;
      try {
        handled = handleLockMessage(handler, parsed, () => originalOnMessage(e));
      } catch (err) {
        console.error("[HugoAura / LockScreen] Handler error:", err);
      }
      if (handled) return;

      // 其他消息 / 解锁指令正常透传
      return originalOnMessage(e);
    };

    console.log(
      "[HugoAura / LockScreen] Source interception installed (module 33)."
    );
    return true;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "LockScreen" })();
};

module.exports = { hookFunc: hookFn };
