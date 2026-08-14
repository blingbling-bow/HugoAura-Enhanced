(() => {
  const pathBase = "../../aura/ui/pages/configSubPages/preferences/settings";

  const {
    settingsRenderer,
  } = require("../../aura/ui/composables/settingsRenderer");
  const { auraSettings } = require(`${pathBase}/aura`);
  const { debugSettings } = require(`${pathBase}/debug`);
  const { initAboutSubPage } = require(`${pathBase}/about`);
  const { initAuditSubPage } = require(`${pathBase}/auditLog`);

  const initAuraSubPage = () => {
    const auraSettingsSubPageEl = document.getElementById("aura-subpage");
    settingsRenderer(auraSettingsSubPageEl, auraSettings);
  };

  const initDebugSubPage = () => {
    const debugSubPageEl = document.getElementById("debug-subpage");
    settingsRenderer(debugSubPageEl, debugSettings);
  };

  const onMounted = () => {
    initAuraSubPage();
    initDebugSubPage();
    initAboutSubPage();
    initAuditSubPage();

    const rootEl = document.getElementById("acs-preferences-root-el");
    setTimeout(() => {
      rootEl.classList.remove("acs-preferences-root-hidden");
    }, 500);
  };

  onMounted();
})();
