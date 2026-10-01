// @ts-check

/**
 * dumpModuleIds —— 从 app.asar (或已解包的 main.js) 中提取 webpack 模块表,
 * 回答一个问题: "HugoAura 硬编码的那些模块号, 在这个 build 里到底是哪个模块?"
 *
 * 用法:
 *   node scripts/dumpModuleIds.js app.asar
 *   node scripts/dumpModuleIds.js app.asar.bak
 *   node scripts/dumpModuleIds.js app_unpacked/main.js
 *
 * 只读且安全:
 *   - 不修改任何文件;
 *   - 只在 vm 里执行 webpack bootstrap 本身, 入口调用 (n(n.s=<id>)) 已被置空,
 *     模块工厂一个都不会被执行 (只取 String(factory) 做特征匹配);
 *   - require 被替换为抛错桩, 避免意外加载依赖。
 *
 * 为什么需要它: 模块号 = 模块表里的下标/键, 压缩产物里**从不写出** id
 * (既没有 /* 128 *​/ 注释, 也没有 `128:(e,t,n)=>`), 所以 grep/read 无法定位,
 * 必须拿到运行时模块表才能判定。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// >>> asar 读取 (chromium-pickle: [u32 payloadSize][u32 value][value...]) <<< //

const readAsar = (asarPath) => {
  const fd = fs.openSync(asarPath, "r");
  try {
    const sizeBuf = Buffer.alloc(8);
    if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) throw new Error("无法读取 asar 头部长度");
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) {
      throw new Error("无法读取 asar 头部");
    }
    const jsonSize = headerBuf.readUInt32LE(4);
    const header = JSON.parse(headerBuf.toString("utf8", 8, 8 + jsonSize));

    const looksLikeJs = (buf) => {
      if (!buf || buf.length === 0) return false;
      const head = buf.toString("utf8", 0, Math.min(200, buf.length));
      return head.includes("function") && !head.includes("\u0000");
    };

    // 正常情况下正文起点 = 8 + headerSize; 个别打包器会对齐, 故留候选值。
    const candidates = [
      8 + headerSize,
      8 + headerSize + ((4 - (headerSize % 4)) % 4),
      headerSize,
    ];

    const entry = header.files && header.files["main.js"];
    if (!entry) throw new Error("asar 内找不到 main.js");

    let buf = null;
    let contentStart = -1;
    for (const start of candidates) {
      const candidate = Buffer.alloc(entry.size);
      const read = fs.readSync(fd, candidate, 0, entry.size, start + Number(entry.offset));
      if (read !== entry.size) continue;
      if (looksLikeJs(candidate)) {
        buf = candidate;
        contentStart = start;
        break;
      }
    }
    if (!buf) throw new Error("按候选偏移读出的 main.js 不像 JS, 请把本输出发回排查");

    let version = "unknown";
    const pkgEntry = header.files["package.json"];
    if (pkgEntry && !pkgEntry.unpacked && pkgEntry.offset !== undefined) {
      const pkgBuf = Buffer.alloc(pkgEntry.size);
      fs.readSync(fd, pkgBuf, 0, pkgEntry.size, contentStart + Number(pkgEntry.offset));
      try {
        version = JSON.parse(pkgBuf.toString("utf8")).version || "unknown";
      } catch (err) {
        version = "unknown (package.json 解析失败)";
      }
    }

    return { src: buf.toString("utf8"), version, note: `contentStart=${contentStart}` };
  } finally {
    fs.closeSync(fd);
  }
};

const loadBundle = (inputPath) => {
  if (path.extname(inputPath).toLowerCase() === ".asar") {
    const asar = readAsar(inputPath);
    return { src: asar.src, version: asar.version, note: asar.note };
  }
  const src = fs.readFileSync(inputPath, "utf8");
  let version = "unknown";
  const pkgPath = path.join(path.dirname(inputPath), "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "unknown";
    } catch (err) {
      version = "unknown";
    }
  }
  return { src, version, note: "直接读取的 main.js" };
};

// >>> 模块表提取 <<< //

const extractModuleTable = (src) => {
  const notes = [];
  const mAssign = /([A-Za-z_$][\w$]*)\.m\s*=\s*([A-Za-z_$][\w$]*)/.exec(src);
  if (!mAssign) throw new Error("找不到 webpack 的 `<runtime>.m = <modules>` 赋值");
  const runtime = mAssign[1];
  notes.push(`模块表赋值: ${mAssign[0]}`);

  let patched = src.replace(
    mAssign[0],
    `${mAssign[0]},globalThis.__wp=${runtime}`
  );

  const entryRe = new RegExp(`${runtime}\\(${runtime}\\.s=\\d+\\)`);
  const entryMatch = entryRe.exec(patched);
  if (entryMatch) {
    patched = patched.replace(entryMatch[0], "void 0");
    notes.push(`入口调用已置空: ${entryMatch[0]}`);
  } else {
    notes.push("未找到入口调用 (可能不是标准 webpack bootstrap)");
  }

  const sandbox = {
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    require: () => {
      throw new Error("require blocked by dumpModuleIds");
    },
  };
  vm.createContext(sandbox);
  let bootError = null;
  try {
    vm.runInContext(patched, sandbox, { filename: "main.js" });
  } catch (err) {
    bootError = err; // bootstrap 之后的副作用代码抛错不影响模块表
  }

  const wp = sandbox.__wp;
  if (!wp || !wp.m) {
    throw new Error(
      `未能捕获模块表 (boot error: ${bootError ? bootError.message : "none"})`
    );
  }
  return { modules: wp.m, notes, bootError, runtime };
};

// >>> 特征串与硬编码模块号 <<< //

const FEATURES = [
  "/powerOff/confirm",
  "自动关机",
  "shutdown",
  "pushMessageToWindow",
  "getMessage",
  "/serviceUpgrade/status",
  "UPGRADE_STATUS",
  "UPGRADE_FEEDBACK",
  "proxyWebsocketHost",
  "hugoServiceWebsocket",
  "relinkFun",
  "onLinkOk",
  "setHost",
  "sendMessage",
  "screensaverTransitionList",
  "closeScreenSaver",
  "screenLockStatus",
  "hasNetworkHidePasswordBlock",
  "USB_LIST",
  "GET_COUNTDOWN_MES",
  "checkWindowExist",
  "createWindow",
  "windowList",
  "shareData",
  "getData",
];

/** HugoAura 源码里硬编码的模块号 + 该模块"应当"含有的特征 (参考判据) */
const EXPECT = [
  { label: "PowerOff handler", id: 128, must: "/powerOff/confirm" },
  { label: "DisableUpdate handler", id: 394, must: "/serviceUpgrade/status" },
  { label: "WS client 390", id: 390, must: "proxyWebsocketHost" },
  { label: "WS client 399", id: 399, must: "hugoServiceWebsocket" },
  { label: "WS 基类", id: 18, must: "relinkFun" },
  { label: "ScreensaverSource", id: 121, must: "screensaverTransitionList" },
  { label: "LockScreen", id: 33, must: "screenLockStatus" },
  { label: "KeepPasswordUnlock", id: 137, must: "hasNetworkHidePasswordBlock" },
  { label: "HideCountdown", id: 132, must: "GET_COUNTDOWN_MES" },
  { label: "AutoOpenUsb", id: 141, must: "USB_LIST" },
  { label: "DeviceLinkNotify", id: 58, must: "checkWindowExist" },
  { label: "slotCardHider", id: 19, must: null },
  { label: "Screensaver windowMgr", id: 20, must: null },
  { label: "HideCountdown windowMgr", id: 3, must: null },
];

// >>> 关机路径普查 (判定"管家内部关机路径是否唯一") <<< //

/** 关机/重启相关的可疑字面量 (先具体后笼统) */
const SHUTDOWN_LITERALS = [
  "shutdown -s",
  "shutdown -r",
  "-f -t 0",
  "reboot.js",
  "excute_reboot",
  "shutdown",
  "taskkill",
  "logoff",
  "ExitWindowsEx",
  "InitiateSystemShutdown",
];

/** 取匹配位置附近的上下文 (压缩产物里这比整行有用得多) */
const contextAt = (src, index, length, radius = 60) => {
  const start = Math.max(0, index - radius);
  const end = Math.min(src.length, index + length + radius);
  return src.slice(start, end).replace(/\s+/g, " ");
};

/**
 * 普查所有模块里的关机调用点, 并回答:
 *   - 管家进程里一共有几处能关机/重启的代码?
 *   - 真正执行关机的那个模块, 被哪些模块引用 (即有几条入口)?
 *   - /powerOff/confirm 所在模块被谁引用 (即它挂在几条 WS 通道上)?
 *
 * 注意: 这只能证明**管家进程内部**的路径唯一性。SeewoCore 等独立服务
 * 不在这个 bundle 里, 本脚本无法证明它们没有自己的关机通道。
 */
const auditShutdownPaths = (sources, runtime) => {
  console.log("\n--- 关机/重启相关调用点普查 ---");

  for (const literal of SHUTDOWN_LITERALS) {
    const target = literal.toLowerCase();
    let total = 0;
    const lines = [];
    for (const [id, src] of sources) {
      const lower = src.toLowerCase();
      let from = 0;
      let shown = 0;
      while (true) {
        const i = lower.indexOf(target, from);
        if (i < 0) break;
        total++;
        if (shown < 2) {
          lines.push(`    [${id}] ...${contextAt(src, i, literal.length)}...`);
          shown++;
        }
        from = i + target.length;
      }
    }
    console.log(`\n  "${literal}" 共 ${total} 处`);
    lines.slice(0, 12).forEach((l) => console.log(l));
    if (lines.length > 12) console.log(`    ...另有 ${lines.length - 12} 处`);
  }

  // 自动定位"真正执行关机"的模块 (含 shutdown 参数串), 再看谁引用它
  const execIds = [];
  for (const [id, src] of sources) {
    if (/shutdown[^"'`]{0,12}-[a-z]/i.test(src)) execIds.push(id);
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const referrersOf = (targetId) => {
    const re = new RegExp(`${escapeRe(runtime)}\\(\\s*${targetId}\\s*[,)]`);
    const out = [];
    for (const [id, src] of sources) if (re.test(src)) out.push(id);
    return out;
  };

  console.log("\n--- 谁引用了谁 (定位入口数量) ---");
  for (const id of execIds) {
    const refs = referrersOf(id);
    console.log(
      `  执行关机的模块 ${id} <- 被引用 ${refs.length} 次: ${refs.join(", ") || "(无)"}`
    );
  }

  const handlerIds = [];
  for (const [id, src] of sources) {
    if (src.includes("/powerOff/confirm")) handlerIds.push(id);
  }
  for (const id of handlerIds) {
    const refs = referrersOf(id);
    console.log(
      `  /powerOff/confirm 处理器模块 ${id} <- 被引用 ${refs.length} 次: ${refs.join(", ") || "(无)"}`
    );
  }

  console.log(
    "\n  判读: 执行关机的模块若只有 1 个引用者, 说明管家内部到 shutdown 的路径唯一;\n" +
      "        处理器被多个模块引用 = 它挂在多条 WS 通道上 —— 正因如此, HugoAura 把\n" +
      "        钩子挂在**处理器**而不是某条通道上, 任何通道分发过来都会被拦。"
  );
};

const main = () => {
  const input = process.argv[2];
  if (!input) {
    console.error("用法: node scripts/dumpModuleIds.js <app.asar | main.js>");
    process.exit(2);
  }

  const bundle = loadBundle(input);
  console.log("=".repeat(72));
  console.log(`来源        : ${input}`);
  console.log(`管家版本    : ${bundle.version}`);
  console.log(`bundle 字符 : ${bundle.src.length} (${bundle.note})`);

  const { modules, notes, bootError, runtime } = extractModuleTable(bundle.src);
  const ids = Object.keys(modules);
  console.log(
    `模块表      : ${Array.isArray(modules) ? "数组 (webpack 3 风格, id = 下标)" : "对象 (webpack 5 风格)"}, ${ids.length} 个模块`
  );
  notes.forEach((n) => console.log(`              ${n}`));
  if (bootError) console.log(`bootstrap 报错 (可忽略): ${bootError.message}`);

  // 预先把每个模块的源码取出来, 避免重复 String()
  const sources = new Map();
  for (const id of ids) {
    const factory = modules[id];
    sources.set(id, typeof factory === "function" ? String(factory) : "");
  }

  console.log("\n--- 每个特征串命中的模块号 ---");
  for (const feature of FEATURES) {
    const hits = [];
    for (const [id, src] of sources) {
      if (src.includes(feature)) hits.push(id);
    }
    console.log(
      `${feature.padEnd(30)} -> ${
        hits.length === 0 ? "(无)" : `${hits.join(", ")}${hits.length === 1 ? "  [唯一]" : ""}`
      }`
    );
  }

  console.log("\n--- HugoAura 硬编码模块号核对 ---");
  let mismatched = 0;
  for (const item of EXPECT) {
    const src = sources.get(String(item.id)) || "";
    if (!src) {
      console.log(`${String(item.id).padStart(5)}  ${item.label.padEnd(24)} ❌ 该模块号不存在`);
      mismatched++;
      continue;
    }
    const hitFeatures = FEATURES.filter((f) => src.includes(f));
    const ok = item.must ? src.includes(item.must) : null;
    const mark = ok === null ? "·" : ok ? "✅" : "❌";
    if (ok === false) mismatched++;
    console.log(
      `${String(item.id).padStart(5)}  ${item.label.padEnd(24)} ${mark} ` +
        `命中特征: ${hitFeatures.length ? hitFeatures.join(" | ") : "(无)"}`
    );
  }

  auditShutdownPaths(sources, runtime);

  console.log("\n--- 结论 ---");
  console.log(
    mismatched === 0
      ? "所有带参考判据的硬编码模块号都命中了期望特征。"
      : `有 ${mismatched} 项不符合期望, 需要按上面的实际命中特征修正模块号或扫描 hint。`
  );
  console.log("=".repeat(72));
};

main();
