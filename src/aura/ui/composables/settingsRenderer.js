const showReloadToast = () => {
  const prevToast = document.getElementById("relaunchNotifyToast");
  const prevToastBs = bootstrap.Toast.getOrCreateInstance(prevToast);
  if (prevToastBs.isShown()) return;

  const toast = document.getElementById("reloadNotifyToast");
  const toastBs = bootstrap.Toast.getOrCreateInstance(toast);
  if (!toastBs.isShown()) toastBs.show();
};

const showRelaunchToast = () => {
  const prevToast = document.getElementById("reloadNotifyToast");
  const prevToastBs = bootstrap.Toast.getOrCreateInstance(prevToast);
  if (prevToastBs.isShown()) prevToastBs.hide();

  const toast = document.getElementById("relaunchNotifyToast");
  const toastBs = bootstrap.Toast.getOrCreateInstance(toast);
  if (!toastBs.isShown()) toastBs.show();
};

const showRelaunchAikariToast = () => {
  const toast = document.getElementById("relaunchAikariNotifyToast");
  const toastBs = bootstrap.Toast.getOrCreateInstance(toast);

  if (global.__HUGO_AURA__.aikariStats.detached) {
    const relaunchBtn = document.getElementById("aikariRelaunchBtn");
    relaunchBtn.disabled = true;
    relaunchBtn.textContent = "分离模式下无法执行";
  }

  if (!toastBs.isShown()) toastBs.show();
};

const showToast = (entry) => {
  if (entry.reload) {
    showReloadToast();
  } else if (entry.restart) {
    showRelaunchToast();
  }
};

const setDisableStatus = (el, isDisable, hint = null) => {
  if (isDisable) {
    el.classList.add("ase-operation-area-disabled");
    if (hint) {
      el.setAttribute("data-bs-toggle", "tooltip");
      el.setAttribute("data-bs-placement", "top");
      el.setAttribute("data-bs-title", hint);
      const tooltipIns = bootstrap.Tooltip.getOrCreateInstance(el);
      tooltipIns.enable();
    }
  } else {
    el.removeAttribute("data-bs-toggle");
    el.removeAttribute("data-bs-placement");
    el.removeAttribute("data-bs-title");
    el.classList.remove("ase-operation-area-disabled");
    const tooltipIns = bootstrap.Tooltip.getInstance(el);
    if (tooltipIns) {
      tooltipIns.dispose();
    }
  }
};

const insertOrRemoveEl = (parent, child, isInsert = true) => {
  if (Array.isArray(child)) {
    for (const perEl of child) {
      isInsert ? parent.appendChild(perEl) : parent.removeChild(perEl);
    }
  } else {
    isInsert ? parent.appendChild(child) : parent.removeChild(child);
  }
};

const createOnLeaveEvtListener =
  global.__HUGO_AURA_GLOBAL__.utils.createOnLeaveEvtListener;

const renderInputArea = (entry, operationArea, descriptionArea) => {
  switch (entry.type) {
    case "switch": {
      const switchEl = document.createElement("input");
      switchEl.classList.add("form-check-input");
      switchEl.type = "checkbox";
      switchEl.role = "switch";
      switchEl.id = entry.id;
      const elValue = entry.valueGetter();
      switchEl.value = elValue;
      switchEl.checked = elValue;
      switchEl.addEventListener("change", async (event) => {
        showToast(entry);
        try {
          await entry.callbackFn(
            event.target.checked,
            switchEl,
            operationArea,
            descriptionArea
          );
        } catch (err) {
          // 开关回调抛错同样不能"点了没反应": 回滚开关状态并把原因显示出来
          console.error(`[HugoAura] 设置项 ${entry.id} 切换失败:`, err);
          switchEl.checked = !event.target.checked;
          if (descriptionArea) {
            descriptionArea.textContent = `操作失败: ${(err && err.message) || err}`;
            descriptionArea.classList.add("ase-desc-error-hint");
            setTimeout(() => {
              descriptionArea.textContent = entry.description;
              descriptionArea.classList.remove("ase-desc-error-hint");
            }, 5000);
          }
        }
      });
      operationArea.classList.add("form-check", "form-switch");
      return switchEl;
    }
    case "radio": {
      const elValue = entry.valueGetter();
      const elArr = [];
      let targetTemplatesArr = [];
      let targetTemplateLablesArr = [];
      targetTemplatesArr =
        typeof entry.templates === "function"
          ? entry.templates()
          : entry.templates;
      targetTemplateLablesArr =
        typeof entry.templateLabels === "function"
          ? entry.templateLabels()
          : entry.templateLabels;

      for (const template of targetTemplatesArr) {
        const inlineContainerEl = document.createElement("div");
        inlineContainerEl.classList.add("form-check", "form-check-inline");
        const radioEl = document.createElement("input");
        radioEl.value = template;
        radioEl.classList.add("form-check-input");
        radioEl.type = "radio";
        radioEl.name = `${entry.id}Radios`;
        radioEl.id = `${entry.id}Radio${targetTemplatesArr.indexOf(template)}`;
        radioEl.checked = template === elValue ? true : false;
        radioEl.addEventListener("change", async (event) => {
          if (event.target.checked) {
            showToast(entry);
            await entry.callbackFn(
              event.target.value,
              radioEl,
              operationArea,
              descriptionArea
            );
          }
        });
        inlineContainerEl.appendChild(radioEl);
        const labelEl = document.createElement("label");
        labelEl.classList.add("form-check-label");
        labelEl.setAttribute("for", radioEl.id);
        labelEl.textContent =
          targetTemplateLablesArr[targetTemplatesArr.indexOf(template)];
        inlineContainerEl.appendChild(labelEl);
        elArr.push(inlineContainerEl);
      }
      return elArr;
    }
    case "checkbox": {
      const elValue = entry.valueGetter();
      const elArr = [];
      let targetTemplatesArr = [];
      let targetTemplateLablesArr = [];
      targetTemplatesArr =
        typeof entry.templates === "function"
          ? entry.templates()
          : entry.templates;
      targetTemplateLablesArr =
        typeof entry.templateLabels === "function"
          ? entry.templateLabels()
          : entry.templateLabels;

      for (const templateName of targetTemplatesArr) {
        const inlineContainerEl = document.createElement("div");
        inlineContainerEl.classList.add("form-check", "form-check-inline");
        const chkBoxEl = document.createElement("input");
        chkBoxEl.value = templateName;
        chkBoxEl.classList.add("form-check-input");
        chkBoxEl.type = "checkbox";
        chkBoxEl.name = `${entry.id}Checkbox`;
        chkBoxEl.id = `${entry.id}Checkbox${targetTemplatesArr.indexOf(
          templateName
        )}`;
        chkBoxEl.checked = elValue.includes(templateName) ? true : false;
        chkBoxEl.addEventListener("change", async (event) => {
          showToast(entry);
          await entry.callbackFn(
            event.target.value,
            chkBoxEl,
            operationArea,
            descriptionArea
          );
        });
        inlineContainerEl.appendChild(chkBoxEl);
        const labelEl = document.createElement("label");
        labelEl.classList.add("form-check-label");
        labelEl.setAttribute("for", chkBoxEl.id);
        labelEl.textContent =
          targetTemplateLablesArr[targetTemplatesArr.indexOf(templateName)];
        inlineContainerEl.appendChild(labelEl);
        elArr.push(inlineContainerEl);
      }
      return elArr;
    }
    case "input": {
      const inputEl = document.createElement("input");
      inputEl.classList.add("form-control");
      inputEl.type = entry.subType;
      inputEl.value = entry.valueGetter();
      inputEl.placeholder = entry.placeHolder;
      inputEl.id = entry.id;

      const handleSubmit = async (event = null) => {
        // callbackFn 抛错时不能静默吞掉: 旧实现既不给输入框标红, 也不显示任何
        // hint, 用户只会看到"填了格式正确的密码却毫无反应"。这里统一兜底, 把
        // 异常信息写到输入框下方的描述区, 便于定位 (Issue #12)。
        let result;
        try {
          result = await entry.callbackFn(
            event ? event.target.value : inputEl.value,
            inputEl,
            operationArea,
            descriptionArea
          );
        } catch (err) {
          console.error(`[HugoAura] 设置项 ${entry.id} 提交失败:`, err);
          result = {
            valid: false,
            hint: `操作失败: ${(err && err.message) || err}`,
          };
        }
        const success = !!(result && result.valid);
        if (success) {
          showToast(entry);

          if (inputEl.className.includes("is-invalid")) {
            inputEl.classList.remove("is-invalid");
            descriptionArea.textContent = entry.description;
            descriptionArea.classList.remove("ase-desc-error-hint");
          }
        } else {
          inputEl.classList.add("is-invalid");
          descriptionArea.textContent =
            (result && result.hint) || "操作失败, 请重试";
          descriptionArea.classList.add("ase-desc-error-hint");
        }
      };

      inputEl.addEventListener("change", async (event) => {
        await handleSubmit(event);
      });

      // Enter 在含文本输入框的 <form> 中会触发隐式表单提交: change 回调
      // 刚把二次确认弹窗排上队, 页面就随表单导航重载了 (Issue #12 的
      // "输入密码回车后崩溃 / 确认框打不开")。阻止默认提交并失焦,
      // 借 change 事件提交当前值 (值未改动时 change 不会重复触发)。
      inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          inputEl.blur();
        }
      });

      operationArea.classList.add("ase-operation-area-expanded");
      return inputEl;
    }
    case "button": {
      const btnEl = document.createElement("button");
      btnEl.type = "button";
      btnEl.classList.add("btn");
      switch (entry.style) {
        case "outline":
        default:
          btnEl.classList.add("btn-outline-primary");
          break;
      }
      btnEl.innerHTML = entry.buttonContent;
      btnEl.onclick = entry.callbackFn;
      (async () => {
        descriptionArea.innerHTML = await entry.valueGetter();
      })();
      return btnEl;
    }
    default:
      break;
  }
};

const renderNormalSettingsItem = (entry, formEl) => {
  const entryContainerEl = document.createElement("div");
  entryContainerEl.classList.add("aura-settings-entry");
  entryContainerEl.id = `${entry.id}Container`;

  const entryInfoContainerEl = document.createElement("div");
  entryInfoContainerEl.classList.add("aura-settings-entry-info-container");
  const entryTitle = document.createElement("p");
  entryTitle.classList.add("aura-settings-entry-title");
  entryTitle.textContent = entry.name;
  if (entry.restart) {
    const powerIcon = document.createElement("i");
    powerIcon.classList.add(
      "layui-icon",
      "layui-icon-logout",
      "aura-settings-entry-property-icon"
    );
    powerIcon.setAttribute("data-bs-toggle", "tooltip");
    powerIcon.setAttribute("data-bs-placement", "top");
    powerIcon.setAttribute("data-bs-title", "需要重启 Electron 进程");
    entryTitle.appendChild(powerIcon);
  }
  if (entry.aikariRequired) {
    const aikariIcon = document.createElement("i");
    aikariIcon.classList.add(
      "layui-icon",
      "layui-icon-component",
      "aura-settings-entry-property-icon"
    );
    aikariIcon.setAttribute("data-bs-toggle", "tooltip");
    aikariIcon.setAttribute("data-bs-placement", "top");
    aikariIcon.setAttribute("data-bs-title", "需要 Aikari 支持");
    entryTitle.appendChild(aikariIcon);
  }
  if (entry.restartAikari) {
    const aikariIcon = document.createElement("i");
    aikariIcon.classList.add(
      "layui-icon",
      "layui-icon-logout",
      "aura-settings-entry-property-icon"
    );
    aikariIcon.setAttribute("data-bs-toggle", "tooltip");
    aikariIcon.setAttribute("data-bs-placement", "top");
    aikariIcon.setAttribute("data-bs-title", "需要重启 Aikari 进程");
    entryTitle.appendChild(aikariIcon);
  }
  if (entry.reload) {
    const reloadIcon = document.createElement("i");
    reloadIcon.classList.add(
      "layui-icon",
      "layui-icon-refresh",
      "aura-settings-entry-property-icon"
    );
    reloadIcon.setAttribute("data-bs-toggle", "tooltip");
    reloadIcon.setAttribute("data-bs-placement", "top");
    reloadIcon.setAttribute("data-bs-title", "需要重载页面");
    entryTitle.appendChild(reloadIcon);
  }

  const createToolTipIcon = (type, content) => {
    const tipIcon = document.createElement("i");
    tipIcon.classList.add(
      "layui-icon",
      "layui-icon-tips",
      "aura-settings-entry-property-icon"
    );
    if (type === "warning") {
      tipIcon.classList.add("aura-settings-entry-warning-icon");
    }
    tipIcon.setAttribute("data-bs-toggle", "tooltip");
    tipIcon.setAttribute("data-bs-placement", "top");
    tipIcon.setAttribute("data-bs-title", content);
    entryTitle.appendChild(tipIcon);
  };

  if (entry.tip) {
    createToolTipIcon("tip", entry.tipTitle);
  }

  if (entry.warning) {
    createToolTipIcon("warning", entry.warningContent);
  }

  const entryDescription = document.createElement("p");
  entryDescription.classList.add("aura-settings-entry-desc");
  entryDescription.innerHTML = entry.description;
  entryInfoContainerEl.appendChild(entryTitle);
  entryInfoContainerEl.appendChild(entryDescription);

  entryContainerEl.appendChild(entryInfoContainerEl);

  const entryOperationArea = document.createElement("div");
  entryOperationArea.classList.add("aura-settings-entry-operation-area");

  let targetEl = renderInputArea(entry, entryOperationArea, entryDescription);
  insertOrRemoveEl(entryOperationArea, targetEl, true);

  if (entry.reactive) {
    const evtListener = (event) => {
      if (entry.reactiveVal.includes(event.detail.path.join("."))) {
        insertOrRemoveEl(entryOperationArea, targetEl, false);
        targetEl = renderInputArea(entry, entryOperationArea, entryDescription);
        insertOrRemoveEl(entryOperationArea, targetEl, true);
      }
    };
    const channel = entry.aikariRequired
      ? "onAikariConfigUpdate"
      : "onHugoAuraConfigUpdate";
    entryContainerEl.addEventListener(channel, evtListener);
    // createOnLeaveEvtListener(channel, evtListener);
  }

  const updateDisableStatus = (entry) => {
    const isDisabledRet = entry.auraDisable();
    setDisableStatus(
      entryOperationArea,
      isDisabledRet.value,
      isDisabledRet.tooltip
    );
  };

  if (entry.auraDisable) {
    updateDisableStatus(entry);
  }

  if (entry.aikariRequired) {
    if (!global.__HUGO_AURA__.aikariStats.connected && !entry.alwaysEnable) {
      setDisableStatus(entryOperationArea, true, "连接至 Aikari 以继续");
    }

    const evtListener = (event) => {
      if (event.detail.connected) {
        try {
          updateDisableStatus(entry);
        } catch {
          setDisableStatus(entryOperationArea, false);
        }
      } else {
        if (!entry.alwaysEnable) {
          setDisableStatus(entryOperationArea, true, "连接至 Aikari 以继续");
        }
      }
    };
    entryContainerEl.addEventListener("onAikariStatsUpdate", evtListener);
    // createOnLeaveEvtListener("onAikariStatsUpdate", evtListener);
  }
  entryContainerEl.appendChild(entryOperationArea);
  const isShow = entry.auraIf();
  if (!isShow) entryContainerEl.classList.add("aura-settings-entry-hidden");

  if (entry.associateVal) {
    const evtListener = (event) => {
      if (!entry.associateVal.includes(event.detail.path.join("."))) return;
      const cls = entryContainerEl.classList;
      const isShow = entry.auraIf();
      isShow
        ? cls.remove("aura-settings-entry-hidden")
        : cls.add("aura-settings-entry-hidden");

      if (entry.auraDisable && !entry.alwaysEnable) {
        updateDisableStatus(entry);
      }
    };
    const channel = entry.aikariRequired
      ? "onAikariConfigUpdate"
      : "onHugoAuraConfigUpdate";
    entryContainerEl.addEventListener(channel, evtListener);
    // createOnLeaveEvtListener(channel, evtListener);
  }

  formEl.appendChild(entryContainerEl);
};

const renderPreviewItem = (entry, formEl) => {
  const elementId = entry.customId ? entry.customId : `${entry.id}Container`;
  const eventChannel = entry.listenerType;

  const separateHrContainer = document.createElement("div");
  separateHrContainer.classList.add("aura-settings-preview-area-hr-container");

  const hrTitle = document.createElement("p");
  hrTitle.textContent = "预览";

  const hrElement = document.createElement("hr");
  hrElement.classList.add("aura-settings-preview-hr");

  separateHrContainer.appendChild(hrElement);
  separateHrContainer.appendChild(hrTitle);
  separateHrContainer.appendChild(hrElement.cloneNode());

  formEl.appendChild(separateHrContainer);

  const previewContainerEl = document.createElement("div");
  previewContainerEl.classList.add("aura-settings-preview-area-container");
  previewContainerEl.id = elementId;

  const eventListener = (event) => {
    const childs = previewContainerEl.querySelectorAll("*");
    Array.from(childs).forEach((el) => {
      el.dispatchEvent(
        new CustomEvent("onAssociateValueUpdated", { detail: event.detail })
      );
    });
  };

  document.addEventListener(
    eventChannel === "aikari"
      ? "onAikariConfigUpdate"
      : "onHugoAuraConfigUpdate",
    eventListener
  );
  createOnLeaveEvtListener(eventListener); // Clean up

  formEl.appendChild(previewContainerEl);

  setTimeout(() => {
    global.__HUGO_AURA_LOADER__[entry.loaderTarget].active = true;
  }, 50);
};

const renderChild = (entry, formEl) => {
  switch (entry.type) {
    case "preview":
      renderPreviewItem(entry, formEl);
      break;
    default:
      renderNormalSettingsItem(entry, formEl);
      break;
  }
};

const settingsRenderer = (pendingEl, settingsObj) => {
  const formEl = document.createElement("form");
  formEl.classList.add("aura-settings-form");
  // 兜底: 设置页不存在合法的表单提交场景, 任何隐式/显式提交一律阻止,
  // 防止页面被导航走 (明文密码会随 GET 拼进 URL 查询串)
  formEl.addEventListener("submit", (event) => event.preventDefault());
  for (const category of settingsObj) {
    const categoryTitleEl = document.createElement("p");
    categoryTitleEl.classList.add("aura-settings-category-header");
    categoryTitleEl.textContent = category.categoryName;
    formEl.appendChild(categoryTitleEl);
    for (const entry of category.child) {
      renderChild(entry, formEl);
    }

    const hrEl = document.createElement("hr");
    hrEl.classList.add("aura-settings-hr-horizontal");
    formEl.appendChild(hrEl);
  }
  pendingEl.appendChild(formEl);

  global.__HUGO_AURA_GLOBAL__.utils.refreshBsTooltip(
    ".aura-settings-entry-property-icon"
  );
};

module.exports = { settingsRenderer };
