// @ts-check

/**
 * 构建插件系统测试包 (一次性工具, 产物不入库)。
 *
 * 产出 (Artifacts/test-plugins/):
 *   - aura-test-main.zip  主进程测试插件: 验证配置读取 / 存储目录 / 事件总线 /
 *                         心跳存活 / onUnload 清理
 *   - aura-test-ui.zip    界面测试插件: 验证渲染层加载 / DOM 注入 / IPC 调用
 *
 * 用法: node scripts/build-test-plugins.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const { unzipToDir } = require("../src/aura/utils/zip.js");

const OUT_DIR = path.join(__dirname, "..", "Artifacts", "test-plugins");
const SRC_DIR = path.join(OUT_DIR, "src");

/** 与 test/zip.test.js 相同的构造逻辑 (deflate 压缩 + 中央目录 + EOCD) */
const buildZip = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const payload = zlib.deflateRawSync(raw);
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const cdStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
};

// >>> 测试插件 1: 主进程 <<<

const MAIN_MANIFEST = {
  id: "com.aura.test.main",
  name: "Aura 测试插件 (主进程)",
  version: "1.1.0",
  author: "HugoAura",
  description:
    "验证主进程插件运行时: 配置读取 / 存储目录写入 / 事件总线订阅 / 设置项读写 / 心跳存活 / 卸载清理。启用后每 60 秒输出一条心跳日志。",
  type: "main",
  main: "main.js",
  apiLevel: 1,
  configUI: [
    {
      key: "heartbeatSeconds",
      label: "心跳间隔 (秒)",
      type: "input",
      placeholder: "60",
      description: "修改并保存后, 下次启用时生效",
    },
    {
      key: "logLevel",
      label: "日志级别",
      type: "select",
      options: ["debug", "info", "warn"],
    },
    {
      key: "verbose",
      label: "详细输出",
      type: "switch",
    },
  ],
  permissions: [
    {
      key: "network",
      label: "联网",
      description: "插件可发起网络请求",
    },
  ],
  capabilities: { events: ["configRefresh", "settingsChanged"] },
};

const MAIN_CODE = `// 测试插件: 验证主进程运行时的各项能力
let heartbeatTimer = null;
let tickCount = 0;

module.exports = {
  onLoad(ctx) {
    ctx.logger.log("onLoad: 测试主进程插件已加载, Aura 版本", ctx.auraVersion);

    // 1) 配置热读
    const config = ctx.config.get();
    ctx.logger.log("config 可读:", Boolean(config && config.auraSettings));

    // 2) storageDir 私有可写目录 + 持久化设置
    const fs = require("fs");
    const path = require("path");
    const bootFile = path.join(ctx.storageDir, "boot.json");
    fs.writeFileSync(
      bootFile,
      JSON.stringify({ loadedAt: new Date().toISOString(), auraVersion: ctx.auraVersion }, null, 2)
    );
    ctx.logger.log("storageDir 写入成功:", bootFile);
    ctx.logger.log("已保存的插件设置:", JSON.stringify(ctx.settings.get()));

    // 3) 事件总线订阅 (配置刷新 / 设置保存都会打点)
    if (ctx.eventBus && ctx.eventBus.on) {
      ctx.eventBus.on("$aura.config.refreshConfig", () => {
        ctx.logger.log("eventBus: 收到配置刷新事件");
      });
      ctx.eventBus.on("$aura.plugin." + ctx.manifest.id + ".settingsChanged", (values) => {
        ctx.logger.log("eventBus: 设置已更新", JSON.stringify(values));
      });
      ctx.logger.log("eventBus 订阅成功");
    }

    // 4) central 可用性探测 (不实际调用管家模块)
    ctx.logger.log("central 类型:", typeof ctx.central);

    // 5) 心跳: 证明插件持续存活; onUnload 时清理
    const settings = ctx.settings.get();
    const intervalMs = (Number(settings.heartbeatSeconds) > 0 ? Number(settings.heartbeatSeconds) : 60) * 1000;
    heartbeatTimer = setInterval(() => {
      tickCount += 1;
      ctx.logger.log("heartbeat #" + tickCount);
    }, intervalMs);
    ctx.logger.log("心跳已启动 (" + intervalMs + "ms 间隔)");
  },

  onUnload() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    console.log("[HugoAura / Plugin:com.aura.test.main] onUnload: 心跳定时器已清理");
  },
};`;

// onUnload 里用不到 ctx -> 把前缀直接写死, 修正上面的引用问题
const MAIN_CODE_FIXED = MAIN_CODE.replace(
  'ctx.logger.log("onUnload: 心跳定时器已清理");',
  'console.log("[HugoAura / Plugin:com.aura.test.main] onUnload: 心跳定时器已清理");'
);

// >>> 测试插件 2: 渲染层 <<<

const UI_MANIFEST = {
  id: "com.aura.test.ui",
  name: "Aura 测试插件 (界面)",
  version: "1.0.0",
  author: "HugoAura",
  description:
    "验证渲染层插件运行时: 在注入页面左下角显示加载徽章, 点击徽章测试 IPC 调用 (列出已装插件数量)。停用后下次页面注入时消失。",
  type: "ui",
  main: "main.js",
};

const UI_CODE = `// 测试插件: 验证渲染层运行时 (DOM 注入 + IPC)
module.exports = {
  onLoad(ctx) {
    const mount = () => {
      if (document.getElementById("auraTestUiPluginBadge")) return;
      const badge = document.createElement("div");
      badge.id = "auraTestUiPluginBadge";
      badge.style.cssText =
        "position:fixed;left:12px;bottom:12px;z-index:2147483646;" +
        "background:rgba(33,143,255,0.92);color:#fff;padding:6px 12px;" +
        "border-radius:999px;font:12px 'Microsoft YaHei',sans-serif;" +
        "box-shadow:0 4px 14px rgba(0,0,0,0.25);cursor:pointer;user-select:none;";
      badge.textContent = "Aura UI \\u63d2\\u4ef6\\u5df2\\u52a0\\u8f7d \\u2713 v" + ctx.manifest.version;
      badge.title = "com.aura.test.ui \\u2014 \\u70b9\\u51fb\\u6d4b\\u8bd5 IPC";
      badge.onclick = async () => {
        try {
          const res = await ctx.ipcRenderer.invoke("$aura.plugin.list");
          badge.textContent =
            "插件列表: " + (res && res.success ? (res.data || []).length : "?") + " 个";
        } catch (err) {
          badge.textContent = "IPC 调用失败";
        }
      };
      (document.body || document.documentElement).appendChild(badge);
      console.log("[HugoAura / UIPlugin:com.aura.test.ui] 徽章已挂载");
    };

    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
  },
};
`;

const buildPluginZip = (manifest, code, zipName) => {
  const pluginDir = path.join(SRC_DIR, manifest.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), code);

  const zipPath = path.join(OUT_DIR, zipName);
  fs.writeFileSync(
    zipPath,
    buildZip([
      { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
      { name: "main.js", data: code },
    ])
  );

  // 回读校验: 用 Aura 自己的解压器验证产物可用
  const verifyDir = path.join(OUT_DIR, `_verify_${manifest.id}`);
  fs.rmSync(verifyDir, { recursive: true, force: true });
  const res = unzipToDir(zipPath, verifyDir);
  const roundTrip = JSON.parse(fs.readFileSync(path.join(verifyDir, "manifest.json"), "utf8"));
  fs.rmSync(verifyDir, { recursive: true, force: true });

  if (roundTrip.id !== manifest.id) throw new Error("zip 回读校验失败");
  return { zipPath, files: res.files };
};

const main = () => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const mainZip = buildPluginZip(MAIN_MANIFEST, MAIN_CODE_FIXED, "aura-test-main.zip");
  const uiZip = buildPluginZip(UI_MANIFEST, UI_CODE, "aura-test-ui.zip");

  console.log("测试插件构建完成 (已用 Aura 解压器回读校验):");
  console.log(`  [主进程] ${mainZip.zipPath}`);
  mainZip.files.forEach((f) => console.log(`      - ${f.name} (${f.size} bytes)`));
  console.log(`  [界  面] ${uiZip.zipPath}`);
  uiZip.files.forEach((f) => console.log(`      - ${f.name} (${f.size} bytes)`));
  console.log("");
  console.log("安装验证: 配置页 -> 插件管理 -> 本地导入 -> 选择 zip -> 确认安装 -> 启用");
  console.log("  主进程插件: 日志出现 onLoad/心跳, 停用后心跳停止");
  console.log("  界面插件  : 注入页面左下角出现蓝色徽章, 点击测试 IPC");
};

main();
