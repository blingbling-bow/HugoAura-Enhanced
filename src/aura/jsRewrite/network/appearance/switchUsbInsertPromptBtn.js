/// Rewrite rules basic config section begins ///

const type = "localResource";

const urlPattern = "usbInsertPrompt.js";

/// End of the rewrite rules basic config section ///

let ruleFn = (originalContent, ruleConfig) => {
  if (ruleConfig.mode === "switch") {
    const before = originalContent;
    originalContent = originalContent
      .replace(/查杀可预防设备感染，守护设备安全/g, "检测到新的设备插入")
      .replace(/开始查杀（推荐）/g, "打开 U 盘")
      .replace(/onClick\s*:\s*this\.handleStartVirusKilling/g, "onClick:this.handleOpen")
      // Remove the secondary, now duplicated open action by its stable text,
      // allowing minifier whitespace and component variable names to differ.
      .replace(/,\w+\.a\.createElement\("p",null,"打开U盘"\)/g, "");
    if (originalContent === before) {
      console.warn(
        "[HugoAura / USB Prompt] Switch mode found no known anchors; source may have changed."
      );
    }
  } else if (ruleConfig.mode === "hide") {
    const before = originalContent;
    originalContent = originalContent.replace(/15e3/g, "0");
    if (originalContent === before) {
      console.warn(
        "[HugoAura / USB Prompt] Hide mode found no auto-close timer anchor; source may have changed."
      );
    }
  }
  return originalContent;
};

module.exports = {
  type,
  urlPattern,
  ruleFn,
};
