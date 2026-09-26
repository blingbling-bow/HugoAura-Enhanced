// @ts-check

/**
 * 解锁事件审计 (Unlock Event Audit) 主进程钩子
 *
 * 背景: 锁屏的三条解锁路径最终都汇聚到锁屏任务控制器 (模块 33, 单例) 的
 * stopLockTask(), 并以 actionOperator 区分解锁方式:
 *   1 = 远程解锁指令   模块 399 → 模块 33.onMessage (messageType 1211 且
 *                      data.screenLockStatus === 0)
 *   2 = 激活码解锁成功 渲染侧 send("stopScreenLock", true) → 模块 380 →
 *                      unlockAction(2)
 *   3 = 密码解锁成功   渲染侧 send("stopScreenLock", false) → 模块 380 →
 *                      unlockAction(3)
 *
 * 本钩子包装该原型方法, 在解锁真正完成后追加一条审计记录, 补齐"谁在何时以何种
 * 方式解锁"这一半 —— 锁屏指令的下发与拦截已由 lockScreenInterceptor 记录。
 *
 * 为什么包装模块 33 的 stopLockTask:
 *   它是三条路径的唯一漏斗, 一处包装即全覆盖; 且 actionOperator 本身就编码了
 *   解锁方式, 无需在每个入口各记一次。该方法是原型方法 (模块 33 为匿名类单例),
 *   因此用 getPrototypeMethod 取原方法后在原型上替换。
 *
 * 记录时机与 fail-soft:
 *   - 先取 hadLock 快照 (原方法内部会清空 message / windows), 再以
 *     original.call(this, arg) 调用原方法 (原方法依赖 this);
 *   - 只有原方法正常返回后才写记录 —— 解锁失败不留"已解锁"的假记录;
 *     原方法抛错时不写日志, 异常原样抛出, 不改变原生行为;
 *   - 审计写入失败只打日志, 绝不影响解锁本身。
 *
 * 为什么复用 cloudCommandAudit.log:
 *   与 lockScreenInterceptor / powerOffInterceptor / cloudUpdateInterceptor 的
 *   既有约定一致 (同一共享写入器 + 统一轮转, 不引入第二个文件句柄), 且锁屏指令
 *   与解锁事件落在同一条时间线上便于对照; 两者以 _logType 区分
 *   ("lockScreen" / "unlock")。
 *
 * 热生效: 包装在自检通过后立即就位, 不受开关当前取值影响; 每条记录写入前读取
 *   一次配置, 因此开关可随时变更, 无需监听 $aura.config.refreshConfig。
 *
 * 版本容错: 模块未就绪或特征串不匹配时延迟重试, 最终优雅降级 —— 不挂钩子,
 *   行为与原生完全一致, 仅打印一次诊断日志。
 */

const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");
const auditWriter = require("./auditWriter");

// 锁屏任务控制器 (模块 33, 单例): 接收锁屏/解锁指令并创建 screenLock 窗口
const SCREEN_LOCK_CONTROLLER_ID = 33;
// 审计日志: 复用云端指令审计通道 (写入与轮转统一交给共享写入器)
const AUDIT_FILE = "cloudCommandAudit.log";
// stopLockTask 内的 tslKey 字面量, 用于确认方法身份
const UNLOCK_METHOD_MARKER = "unlockStreamControl";

/**
 * actionOperator → 解锁方式
 * @param {any} operator
 * @returns {"remote" | "activationCode" | "password" | "unknown"}
 */
const methodOf = (operator) => {
  switch (operator) {
    case 1:
      return "remote";
    case 2:
      return "activationCode";
    case 3:
      return "password";
    default:
      return "unknown";
  }
};

const hookFn = (central) => {
  let diagLogged = false;

  /**
   * 每个解锁事件读取一次配置, 使开关可随时热更新。
   * 配置读取失败按"未启用"处理 (fail-soft)。
   */
  const isEnabled = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return false;
      const config = mgr.loadConfig();
      const cfg =
        config && config.auraSettings && config.auraSettings.unlockAudit;
      return Boolean(cfg && cfg.enabled);
    } catch (err) {
      console.error(
        "[HugoAura / UnlockAudit / Error] Failed to read config:",
        err
      );
      return false;
    }
  };

  // 单次安装尝试: 成功返回 true, 模块未就绪返回 false (触发重试)
  const tryInstall = () => {
    const handler = resolveModule(central, SCREEN_LOCK_CONTROLLER_ID);
    const original = getPrototypeMethod(handler, "stopLockTask");

    // 运行时自检: 源码特征匹配, 失败即认为模块编号假设失效, 优雅降级不挂钩子
    const sourceMatched = !!(
      original && String(original).includes(UNLOCK_METHOD_MARKER)
    );
    const isController =
      handler && typeof handler.stopLockTask === "function" && sourceMatched;

    if (!isController) {
      if (!diagLogged) {
        diagLogged = true;
        console.warn(
          `[HugoAura / UnlockAudit] Self-check failed. ` +
            `module ${SCREEN_LOCK_CONTROLLER_ID}: stopLockTask=${handler && typeof handler.stopLockTask}, ` +
            `sourceMatched=${sourceMatched}`
        );
      }
      console.debug("[HugoAura / UnlockAudit] Modules not ready, retrying...");
      return false;
    }

    const proto = Object.getPrototypeOf(handler);
    const stopLockTask = proto.stopLockTask;

    proto.stopLockTask = function (arg) {
      // 快照必须在原方法执行前取: 原方法内部会清空 message / windows
      const hadLock =
        !!this.message ||
        (Array.isArray(this.windows) && this.windows.length > 0);

      const result = stopLockTask.call(this, arg);

      if (isEnabled()) {
        const actionOperator =
          arg && typeof arg.actionOperator === "number"
            ? arg.actionOperator
            : null;
        auditWriter.writeAudit(AUDIT_FILE, {
          ts: new Date().toISOString(),
          channel: "screenLockController",
          action: "unlock",
          method: methodOf(actionOperator),
          actionOperator,
          operationLogId:
            arg && arg.operationLogId !== undefined ? arg.operationLogId : "0",
          hadLock,
          _logType: "unlock",
        });
      }

      return result;
    };

    console.log(
      `[HugoAura / UnlockAudit] Unlock event audit installed (module ${SCREEN_LOCK_CONTROLLER_ID}).`
    );
    return true;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "UnlockAudit" })();
};

module.exports = { hookFunc: hookFn };
