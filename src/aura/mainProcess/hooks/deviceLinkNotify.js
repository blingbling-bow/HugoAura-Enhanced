// @ts-check

/**
 * 隐藏周边设备连接提示 (Hide Device Link Notify) 主进程钩子
 *
 * 目标: 右下角的设备连接提示卡片 (渲染层 public/deviceLink.js),
 * 文案为「连接成功 / 设备已接入一体机」与「断开连接 / 设备已断开」。
 *
 * 触发链路: 云端 WS /SeewoProxy -> 模块 391 处理 url "/iotDeviceChange",
 * 遍历 data.deviceList, 对每台物联设备调用设备提示管理器 (模块 58):
 *   checkWindowExist(id) ? addWaitWindow(id, cfg) : createWindow(cfg, id)
 * 其中 cfg = { type: product, state: state ? 1 : 0, model, sid },
 * 窗口名 id = product + model + id。
 *
 * 因为窗口名是动态拼出来的, 无法用 windowName 匹配, 钩子改为包裹模块 58 的
 * createWindow, 按 state 分辨卡片类型 (与渲染层枚举一一对应):
 *   state 1 = LINKED  (连接成功)   -> 开关开启时直接不建窗
 *   state 0 = BROKEN  (断开连接)   -> 开关开启时直接不建窗
 *   state 2 = CUSTOM  (智能笔配对失败 / 麦克风电量不足) -> 一律放行, 属可操作告警
 *
 * 只拦"新建", 不关闭已弹出的卡片 —— 该卡片渲染层自带 6.8 秒定时器, 到时自动
 * 收起并回调 deviceLinkWindowClose 销毁窗口, 无需额外清理。
 *
 * 官方有同款开关 CUSTOM_CONFIG.hideLightIotNotify (取自注册表
 * HKEY_LOCAL_MACHINE\SOFTWARE\SeewoServiceCustom\hideLightIotNotify),
 * 但它一刀切地屏蔽整个 createWindow, 连配对失败与低电量告警也不弹;
 * 本钩子粒度更保守, 只挡上下线提示。
 *
 * 版本容错: 模块自检失败时优雅降级, 仅打印诊断日志。
 */

const { withRetry, resolveModule } = require("./retryHook");

const DEVICE_LINK_MANAGER_ID = 58; // 设备提示管理器 (createWindow/closeWindow/windowList)
const STATE_LINKED = 1; // 渲染层 LINKED: 「连接成功」
const STATE_BROKEN = 0; // 渲染层 BROKEN: 「断开连接」

/** 实时读取开关状态 (每次建窗都重读磁盘, 保证开关改动即时生效) */
const isEnabled = () => {
  try {
    const mgr = global.__HUGO_AURA_CONFIG_MGR__;
    if (!mgr) return false;
    const config = mgr.loadConfig();
    return Boolean(
      config &&
        config.networkRewrite &&
        config.networkRewrite["appearance/hideDeviceLinkNotify"] &&
        config.networkRewrite["appearance/hideDeviceLinkNotify"].enabled
    );
  } catch (err) {
    console.error(
      "[HugoAura / DeviceLinkNotify / Error] Failed to read config:",
      err
    );
    return false;
  }
};

/** 是否属于「已连接 / 已断开」上下线提示 (而非 CUSTOM 类告警) */
const isLinkStatePopup = (config) => {
  const state = config && config.state;
  return state === STATE_LINKED || state === STATE_BROKEN;
};

const hookFn = (central) => {
  let diagLogged = false;

  // 单次安装尝试: 成功返回 true, 模块未就绪返回 false (触发重试)
  const tryInstall = () => {
    const manager = resolveModule(central, DEVICE_LINK_MANAGER_ID);

    // 运行时自检: 确认模块 58 是设备提示管理器 (版本容错)
    const isDeviceLinkManager =
      manager &&
      typeof manager.createWindow === "function" &&
      typeof manager.closeWindow === "function" &&
      typeof manager.checkWindowExist === "function" &&
      manager.windowList &&
      typeof manager.windowList === "object";

    if (!isDeviceLinkManager) {
      if (!diagLogged) {
        diagLogged = true;
        console.warn(
          `[HugoAura / DeviceLinkNotify] Module ${DEVICE_LINK_MANAGER_ID} self-check failed. ` +
            `typeof(manager)=${typeof manager}, ` +
            `createWindow=${manager && typeof manager.createWindow}`
        );
      }
      console.debug(
        "[HugoAura / DeviceLinkNotify] Device link manager not ready, retrying..."
      );
      return false;
    }

    const originalCreateWindow = manager.createWindow.bind(manager);

    // 调用方 (模块 391 / smartPen / audio) 都是"取到实例再点方法",
    // 所以在实例上替换 createWindow 即可全部命中。
    manager.createWindow = (config, windowId) => {
      if (isLinkStatePopup(config) && isEnabled()) {
        console.log(
          `[HugoAura / DeviceLinkNotify] Suppressed device link popup (${windowId}).`
        );
        return;
      }
      return originalCreateWindow(config, windowId);
    };

    console.log(
      `[HugoAura / DeviceLinkNotify] Source interception installed (module ${DEVICE_LINK_MANAGER_ID}).`
    );
    return true;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "DeviceLinkNotify" })();
};

module.exports = { hookFunc: hookFn };
