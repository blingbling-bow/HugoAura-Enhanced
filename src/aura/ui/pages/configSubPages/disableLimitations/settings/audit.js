const banAuditSettings = [
  {
    id: 0,
    categoryName: "数据收集与分析",
    child: [
      {
        index: 0,
        id: "disableFridayReport",
        type: "switch",
        name: "禁用 Friday 错误统计",
        description:
          "重置 CVTE 的 Friday 错误收集服务载入 URL, 避免意外的信息上传",
        restart: true,
        reload: false,
        associateVal: null,
        auraIf: () => true,
        defaultValue: true,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite.disableFriday
            .enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite.disableFriday.enabled =
            newVal;
        },
      },
      {
        index: 1,
        id: "disableBuglyReport",
        type: "switch",
        name: "禁用 Bugly 崩溃上报",
        description:
          "关闭 Electron crashReporter 的崩溃转储自动上传 (sunday.cvte.com), 避免崩溃信息 (含注入侧异常) 上传至希沃服务端",
        restart: true,
        reload: false,
        associateVal: null,
        auraIf: () => true,
        defaultValue: true,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite.disableBuglyReport
            .enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite.disableBuglyReport.enabled =
            newVal;
        },
      },
    ],
  },
  {
    id: 1,
    categoryName: "行为上报",
    child: [
      {
        index: 0,
        id: "disableBehaviorAudit",
        type: "switch",
        name: "禁用行为上报",
        description: "禁止希沃管家前端在进行敏感操作时, 向希沃基础服务上报行为",
        restart: true,
        reload: false,
        tip: true,
        tipTitle:
          "启用后, 可能造成部分操作出现较长延迟 (如冰点操作)。希沃管家会尝试五次上报, 均失败后才会进行下一步操作",
        associateVal: null,
        auraIf: () => true,
        defaultValue: false,
        valueGetter: () => {
          return global.__HUGO_AURA_CONFIG__.networkRewrite.disableBehaviorAudit
            .enabled;
        },
        callbackFn: (newVal) => {
          if (typeof newVal !== "boolean") return;
          global.__HUGO_AURA_CONFIG__.networkRewrite.disableBehaviorAudit.enabled =
            newVal;
        },
      },
    ],
  },
];

module.exports = { banAuditSettings };
