// @ts-check

/**
 * 设置项关联路径检查器 (只读)
 *
 * 用法:
 *   node scripts/check-settings-associations.js            检查真实设置文件
 *   node scripts/check-settings-associations.js --selftest  内置样例自检
 *
 * 背景 (Issue #8): 设置项的显隐由 auraIf() 判定, 但渲染器
 * (settingsRenderer.js) 只在 associateVal 里**精确登记**的配置路径
 * 发生变化时才重新执行 auraIf。如果 auraIf 读取了某条配置路径却没有
 * 把它登记进 associateVal, 该路径变化时显隐就不会刷新 —— 表现为
 * "开关/菜单消失了, 重新打开别的开关也找不回来"。
 *
 * 按本仓库 settings 文件的固定结构逐条检查:
 *   associateVal: [...]  ->  auraIf: () => {...}  ->  valueGetter/callbackFn
 */

const fs = require("fs");
const path = require("path");

const settingsDir = path.join(
  __dirname,
  "..",
  "src",
  "aura",
  "ui",
  "pages",
  "configSubPages"
);

/** 递归收集 settings 目录下的 .js 文件 */
const collectFiles = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
};

/** 把 __HUGO_AURA_CONFIG__.rewrite["vendor/x"].y 归一化为 rewrite.vendor/x.y */
const normalizePath = (raw) =>
  raw
    .replace(/^global\.__HUGO_AURA_CONFIG__\./, "")
    .replace(/\["([^"]+)"\]/g, ".$1")
    .replace(/\['([^']+)'\]/g, ".$1");

/**
 * 从 auraIf 函数体里提取它读取的所有配置路径。
 * 注意三点:
 *   1. vendor/screenLock 这类键自带 "/", 字符类里必须包含 "/",
 *      否则提取会在斜杠处断掉 (初次实现就栽在这);
 *   2. 源码里的链路常常跨行 (rewrite["vendor/x"] 换行后 .enabled),
 *      要先把点号周围的空白压掉, 否则路径会被截断成父路径;
 *   3. 截断成的"父路径"又会被子路径放行规则掩盖 —— 双重漏检。
 */
const extractPaths = (body) => {
  const paths = new Set();
  const compact = body
    .replace(/\]\s*\.\s*/g, "].")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\[\s+/g, "[")
    .replace(/"\s+/g, '"');
  const re = /global\.__HUGO_AURA_CONFIG__\.([A-Za-z_$][\w$/.\["'\]-]*)/g;
  let m;
  while ((m = re.exec(compact)) !== null) {
    const normalized = normalizePath(`global.__HUGO_AURA_CONFIG__.${m[1]}`)
      .replace(/\.$/, "");
    if (normalized.includes(".")) paths.add(normalized);
  }
  return paths;
};

/** 提取 associateVal 数组字面量里的路径 */
const extractAssociate = (arrayBody) => {
  const paths = new Set();
  const re = /"([^"]+)"|'([^']+)'/g;
  let m;
  while ((m = re.exec(arrayBody)) !== null) {
    paths.add(m[1] || m[2]);
  }
  return paths;
};

/**
 * 判定 auraIf 读取的路径是否已被 associateVal 覆盖。
 * 渲染器做的是**精确匹配** (event.detail.path 必须出现在 associateVal 里),
 * 所以只有"完全一致"才算覆盖; 唯一放行的是父对象读取
 * (auraIf 里读 cfg 父对象再取 .enabled, 而 associateVal 登记 .enabled),
 * 即 registered 恰好是 referenced 的下级路径。
 *
 * @param {string} referenced auraIf 读取的路径
 * @param {Set<string>} registered associateVal 登记的路径
 */
const isCovered = (referenced, registered) => {
  if (registered.has(referenced)) return true;
  for (const r of registered) {
    if (r.startsWith(referenced + ".")) return true;
  }
  return false;
};

/**
 * 检查一段 settings 源码, 返回缺失列表。
 * @param {string} src 源码
 * @returns {{ path: string, referenced: string, registered: string[] }[]}
 */
const checkSource = (src, label) => {
  const problems = [];
  const assocRe = /associateVal\s*:\s*(\[[^\]]*\]|null)/g;
  let m;
  while ((m = assocRe.exec(src)) !== null) {
    const after = src.slice(m.index + m[0].length);
    const endMatch = /\n\s+(valueGetter|callbackFn|defaultValue|listenerType)\b/.exec(
      after
    );
    if (!endMatch) continue;
    const auraIfBody = after.slice(0, endMatch.index);
    if (!/auraIf/.test(auraIfBody)) continue;

    const registered = extractAssociate(m[1]);
    for (const p of extractPaths(auraIfBody)) {
      if (!isCovered(p, registered)) {
        problems.push({
          path: `${label}`,
          referenced: p,
          registered: [...registered],
        });
      }
    }
  }
  return problems;
};

/** 内置样例自检: 验证检查器确实能抓到 Issue #8 的模式 */
const selfTest = () => {
  const bad = `
      {
        id: "fastfailScreenLock",
        associateVal: ["rewrite.vendor/screenLock.fastfail"],
        auraIf: () => {
          return global.__HUGO_AURA_CONFIG__.rewrite["vendor/screenLock"]
            .enabled;
        },
        valueGetter: () => true,
        callbackFn: (newVal) => {},
      },
  `;
  const good = `
      {
        id: "fastfailScreenLock",
        associateVal: [
          "rewrite.vendor/screenLock.enabled",
          "rewrite.vendor/screenLock.fastfail",
        ],
        auraIf: () => {
          return global.__HUGO_AURA_CONFIG__.rewrite["vendor/screenLock"]
            .enabled;
        },
        valueGetter: () => true,
        callbackFn: (newVal) => {},
      },
  `;
  // 父对象读取应当被放行
  const parentRead = `
      {
        associateVal: ["auraSettings.lockScreenIntercept.enabled"],
        auraIf: () => {
          const cfg = global.__HUGO_AURA_CONFIG__.auraSettings.lockScreenIntercept;
          return !cfg || !cfg.enabled;
        },
        valueGetter: () => true,
        callbackFn: (newVal) => {},
      },
  `;

  assert(checkSource(bad, "bad").length === 1, "自检失败: 应抓到缺失的 enabled");
  assert(checkSource(good, "good").length === 0, "自检失败: 不应误报");
  assert(
    checkSource(parentRead, "parent").length === 0,
    "自检失败: 父对象读取不应误报"
  );
  console.log("自检通过: 能抓到 Issue #8 的模式, 且不误报父对象读取");
};

const assert = (cond, msg) => {
  if (!cond) {
    console.error("✗ " + msg);
    process.exit(2);
  }
};

const main = () => {
  if (process.argv.includes("--selftest")) {
    selfTest();
    return;
  }

  let problems = [];
  for (const file of collectFiles(settingsDir)) {
    const rel = path.relative(process.cwd(), file);
    problems = problems.concat(checkSource(fs.readFileSync(file, "utf8"), rel));
  }

  for (const p of problems) {
    console.log(
      `✗ ${p.path}\n    auraIf 读取了 "${p.referenced}" 但 associateVal 只登记了 [${p.registered.join(", ")}]`
    );
  }

  console.log(
    problems.length === 0
      ? "\n全部设置项的关联路径登记完整"
      : `\n发现 ${problems.length} 处缺失`
  );
  process.exit(problems.length === 0 ? 0 : 1);
};

if (require.main === module) {
  main();
}

module.exports = { checkSource, extractPaths, extractAssociate, normalizePath, isCovered };
