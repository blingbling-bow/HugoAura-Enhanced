const uxAndAppearanceSettings = [
  {
    id: 0,
    categoryName: "管家助手",
    child: [
      {
        index: 0,
        id: "autoHideEasiAssistant",
        type: "switch",
        name: "自动最小化管家助手",
        description: "管家启动后, 自动将桌面右下角管家助手最小化至 Fab 形态",
        restart: true,
        reload: false,
        associateVal: ["ssa.ux.easiAssistant.notDisplay"],
        auraIf: () => true,
        defaultValue: false,
        auraDisable: () => {
          if (global.__HUGO_AURA_CONFIG__.ssa.ux.easiAssistant.notDisplay) {
            return { value: true, tooltip: '禁用 "隐藏管家助手" 以继续' };
          } else {
            return { value: false };
          }
        },
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.ssa.ux.easiAssistant.autoHide;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.ssa.ux.easiAssistant.autoHide = newVal;
        },
      },
      {
        index: 1,
        id: "notDisplayEasiAssistant",
        type: "switch",
        name: "隐藏管家助手",
        description: "管家启动后, 管家助手窗口将不再显示",
        restart: true,
        reload: false,
        associateVal: ["ssa.ux.easiAssistant.autoHide"],
        auraIf: () => true,
        defaultValue: false,
        auraDisable: () => {
          if (global.__HUGO_AURA_CONFIG__.ssa.ux.easiAssistant.autoHide) {
            return { value: true, tooltip: '禁用 "自动最小化管家助手" 以继续' };
          } else {
            return { value: false };
          }
        },
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.ssa.ux.easiAssistant.notDisplay;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.ssa.ux.easiAssistant.notDisplay = newVal;
        },
      },
    ],
  },
  {
    id: 1,
    categoryName: "U 盘提示",
    child: [
      {
        index: 0,
        id: "switchUsbInsertPromptButton",
        type: "switch",
        name: '隐藏 U 盘插入提示悬浮窗的 "开始查杀" 按钮',
        description: '启用后, "打开 U 盘" 将成为悬浮窗中的 Primary 按钮',
        restart: true,
        reload: false,
        associateVal: [
          "networkRewrite.appearance/switchUsbInsertPromptBtn.enabled",
        ],
        auraIf: () => true,
        defaultValue: false,
        auraDisable: () => {
          if (
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/switchUsbInsertPromptBtn"
            ].mode === "hide" &&
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/switchUsbInsertPromptBtn"
            ].enabled
          ) {
            return { value: true, tooltip: '禁用 "隐藏 U 盘插入提示" 以继续' };
          } else {
            return { value: false };
          }
        },
        valueGetter: () => {
          return (
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/switchUsbInsertPromptBtn"
            ].mode === "switch" &&
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/switchUsbInsertPromptBtn"
            ].enabled
          );
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          if (newVal === true) {
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/switchUsbInsertPromptBtn"
            ].mode = "switch";
          }
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/switchUsbInsertPromptBtn"
          ].enabled = newVal;
        },
      },
      {
        index: 1,
        id: "hideUsbInsertPrompt",
        type: "switch",
        name: "隐藏 U 盘插入提示",
        description: "启用后, 插入 U 盘将不再显示悬浮窗",
        restart: true,
        reload: false,
        associateVal: [
          "networkRewrite.appearance/switchUsbInsertPromptBtn.enabled",
        ],
        auraIf: () => true,
        defaultValue: false,
        auraDisable: () => {
          if (
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/switchUsbInsertPromptBtn"
            ].mode === "switch" &&
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/switchUsbInsertPromptBtn"
            ].enabled
          ) {
            return {
              value: true,
              tooltip:
                '禁用 "隐藏 U 盘插入提示悬浮窗的 "开始查杀" 按钮" 以继续',
            };
          } else {
            return { value: false };
          }
        },
        valueGetter: () => {
          return (
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/switchUsbInsertPromptBtn"
            ].mode === "hide" &&
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/switchUsbInsertPromptBtn"
            ].enabled
          );
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          if (newVal === true) {
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/switchUsbInsertPromptBtn"
            ].mode = "hide";
          }
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/switchUsbInsertPromptBtn"
          ].enabled = newVal;
        },
      },
      {
        index: 2,
        id: "autoOpenUsb",
        type: "switch",
        name: "自动打开 U 盘",
        description:
          "启用后, 插入 U 盘时将自动使用资源管理器打开对应的驱动器",
        restart: true,
        reload: false,
        associateVal: [],
        auraIf: () => true,
        defaultValue: false,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/autoOpenUsb"
          ].enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/autoOpenUsb"
          ].enabled = newVal;
        },
      },
    ],
  },
  {
    id: 1,
    categoryName: "广告拦截",
    child: [
      {
        index: 0,
        id: "banAdBlockPrompt",
        type: "switch",
        name: "隐藏广告拦截悬浮窗",
        description: "启用后, 管家检测到未拦截广告弹窗时, 将不会再显示悬浮窗",
        restart: true,
        reload: false,
        warning: true,
        warningContent:
          '此功能不会完全禁用 "广告拦截" 功能, 已被拦截的广告弹窗依然会被拦截。如果您希望彻底禁用广告拦截, 请参阅 Aikari 的相关设置项 (WIP)',
        associateVal: [],
        auraIf: () => true,
        defaultValue: false,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/banAdBlockPrompt"
          ].enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/banAdBlockPrompt"
          ].enabled = newVal;
        },
      },
    ],
  },
  {
    id: 2,
    categoryName: "外观与体验",
    child: [
      {
        index: 0,
        id: "customScreenLockBg",
        type: "switch",
        name: "自定义锁屏背景",
        description: "启用后, 使用自定义图片作为屏幕锁背景",
        restart: true,
        reload: false,
        associateVal: [
          "networkRewrite.appearance/customScreenLockBg.enabled",
        ],
        auraIf: () => true,
        defaultValue: false,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/customScreenLockBg"
          ].enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/customScreenLockBg"
          ].enabled = newVal;
        },
      },
      {
        index: 1,
        id: "customScreenLockBgPath",
        type: "input",
        name: "背景图片路径或链接",
        description: "支持 http(s) 链接或本地图片文件路径",
        restart: true,
        reload: false,
        associateVal: [
          "networkRewrite.appearance/customScreenLockBg.enabled",
          "networkRewrite.appearance/customScreenLockBg.backgroundPath",
        ],
        auraIf: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/customScreenLockBg"
          ].enabled;
        },
        defaultValue: "",
        placeHolder: "输入图片路径或 http(s) 链接",
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/customScreenLockBg"
          ].backgroundPath;
        },
        callbackFn: (newVal) => {
          if (newVal === "" || !newVal) return { valid: true };
          if (typeof newVal !== "string") {
            return { valid: false, hint: "请输入图片路径或 http(s) 链接" };
          }
          if (/^https?:\/\//i.test(newVal)) {
            global.__HUGO_AURA_CONFIG__.networkRewrite[
              "appearance/customScreenLockBg"
            ].backgroundPath = newVal;
            return { valid: true };
          }
          const fs = require("fs");
          if (!fs.existsSync(newVal)) {
            return { valid: false, hint: "图片文件不存在" };
          }
          if (!fs.statSync(newVal).isFile()) {
            return { valid: false, hint: "路径不是图片文件" };
          }
          if (!/\.(png|jpe?g|bmp|webp|gif)$/i.test(newVal)) {
            return {
              valid: false,
              hint: "仅支持 png/jpg/jpeg/bmp/webp/gif 图片",
            };
          }
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/customScreenLockBg"
          ].backgroundPath = newVal;
          return { valid: true };
        },
      },
      {
        index: 2,
        id: "hideCountdown",
        type: "switch",
        name: "隐藏倒计日组件",
        description:
          '启用后, 集控下发的倒计日卡片 ("距离XX仅有N天") 不在屏上显示 (指令照常处理, 关闭开关后卡片即可恢复显示)',
        restart: false,
        reload: false,
        associateVal: [],
        auraIf: () => true,
        defaultValue: false,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/hideCountdown"
          ].enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/hideCountdown"
          ].enabled = newVal;
        },
      },
      {
        index: 3,
        id: "hideFastToolbar",
        type: "switch",
        name: "隐藏下课锁屏卡片",
        description:
          "启用后, 悬浮的下课锁屏卡片将不再显示 (锁屏页面本身不受影响)",
        restart: false,
        reload: false,
        associateVal: [],
        auraIf: () => true,
        defaultValue: false,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/hideFastToolbar"
          ].enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/hideFastToolbar"
          ].enabled = newVal;
        },
      },
      {
        index: 4,
        id: "hideDesktopNotification",
        type: "switch",
        name: "隐藏常驻消息通知",
        description:
          "启用后, 悬浮于管家助手上方的桌面常驻消息通知卡片将不再显示",
        restart: false,
        reload: false,
        associateVal: [],
        auraIf: () => true,
        defaultValue: false,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/hideDesktopNotification"
          ].enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/hideDesktopNotification"
          ].enabled = newVal;
        },
      },
      {
        index: 5,
        id: "hideDeviceLinkNotify",
        type: "switch",
        name: "隐藏周边设备连接提示",
        description:
          "启用后, 物联设备接入 / 断开时右下角的提示卡片不再弹出 (智能笔配对失败、麦克风电量不足等告警不受影响)",
        restart: false,
        reload: false,
        associateVal: [],
        auraIf: () => true,
        defaultValue: false,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/hideDeviceLinkNotify"
          ].enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/hideDeviceLinkNotify"
          ].enabled = newVal;
        },
      },
      {
        index: 6,
        id: "keepPasswordUnlock",
        type: "switch",
        name: "联网时保留密码解锁",
        description:
          "启用后, 集控下发「联网时禁用密码解锁」策略 (messageType 1214) 时, 锁屏仍保留「密码」解锁页签 (扫码 / 激活码方式不受影响)",
        restart: false,
        reload: false,
        associateVal: [],
        auraIf: () => true,
        defaultValue: false,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/keepPasswordUnlock"
          ].enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite[
            "appearance/keepPasswordUnlock"
          ].enabled = newVal;
        },
      },
    ],
  },
];

module.exports = { uxAndAppearanceSettings };
