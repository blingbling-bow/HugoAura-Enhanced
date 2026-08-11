(() => {
  const pathBase = "../../aura/ui/pages/configSubPages/preferences/settings";

  const {
    settingsRenderer,
  } = require("../../aura/ui/composables/settingsRenderer");
  const { auraSettings } = require(`${pathBase}/aura`);
  const { debugSettings } = require(`${pathBase}/debug`);
  const { aboutContent } = require(`${pathBase}/about`);

  const initAuraSubPage = () => {
    const auraSettingsSubPageEl = document.getElementById("aura-subpage");
    settingsRenderer(auraSettingsSubPageEl, auraSettings);
  };

  const initDebugSubPage = () => {
    const debugSubPageEl = document.getElementById("debug-subpage");
    settingsRenderer(debugSubPageEl, debugSettings);
  };

  const initAboutSubPage = () => {
    const aboutSubPageEl = document.getElementById("about-subpage");
    aboutSubPageEl.innerHTML = aboutContent;
  };

  const onMounted = () => {
    initAuraSubPage();
    initDebugSubPage();
    initAboutSubPage();

    const rootEl = document.getElementById("acs-preferences-root-el");
    setTimeout(() => {
      rootEl.classList.remove("acs-preferences-root-hidden");
    }, 500);
  };

  onMounted();
})();
