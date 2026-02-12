export function registerBridgeSettings({
  moduleId,
  onTargetHelperActionRowsFixChange,
  onForceBarrageTargetDialogBridgeChange
}) {
  const localizeSetting = (key) => game.i18n.localize(`${moduleId}.settings.${key}`);

  game.settings.register(moduleId, "proxyToGM", {
    name: localizeSetting("proxyToGM.name"),
    hint: localizeSetting("proxyToGM.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(moduleId, "autoScrollTargets", {
    name: localizeSetting("autoScrollTargets.name"),
    hint: localizeSetting("autoScrollTargets.hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(moduleId, "debugBridge", {
    name: localizeSetting("debugBridge.name"),
    hint: localizeSetting("debugBridge.hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(moduleId, "itemActivationsRuFix", {
    name: localizeSetting("itemActivationsRuFix.name"),
    hint: localizeSetting("itemActivationsRuFix.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(moduleId, "itemActivationsAutoSelfEffect", {
    name: localizeSetting("itemActivationsAutoSelfEffect.name"),
    hint: localizeSetting("itemActivationsAutoSelfEffect.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(moduleId, "targetHelperActionRowsFix", {
    name: localizeSetting("targetHelperActionRowsFix.name"),
    hint: localizeSetting("targetHelperActionRowsFix.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      if (typeof onTargetHelperActionRowsFixChange === "function") {
        onTargetHelperActionRowsFixChange();
      }
    }
  });
  game.settings.register(moduleId, "forceBarrageTargetDialogBridge", {
    name: localizeSetting("forceBarrageTargetDialogBridge.name"),
    hint: localizeSetting("forceBarrageTargetDialogBridge.hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      if (typeof onForceBarrageTargetDialogBridgeChange === "function") {
        onForceBarrageTargetDialogBridgeChange();
      }
    }
  });
  game.settings.register(moduleId, "forceBarrageDialogMatchMode", {
    name: localizeSetting("forceBarrageDialogMatchMode.name"),
    hint: localizeSetting("forceBarrageDialogMatchMode.hint"),
    scope: "client",
    config: true,
    type: String,
    choices: {
      safe: localizeSetting("forceBarrageDialogMatchMode.choices.safe"),
      aggressive: localizeSetting("forceBarrageDialogMatchMode.choices.aggressive")
    },
    default: "safe"
  });
  game.settings.register(moduleId, "baneAuraVisualRefresh", {
    name: localizeSetting("baneAuraVisualRefresh.name"),
    hint: localizeSetting("baneAuraVisualRefresh.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(moduleId, "toolbeltMacroScopeBridge", {
    name: localizeSetting("toolbeltMacroScopeBridge.name"),
    hint: localizeSetting("toolbeltMacroScopeBridge.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(moduleId, "toolbeltSpellCastLinkedBypass", {
    name: localizeSetting("toolbeltSpellCastLinkedBypass.name"),
    hint: localizeSetting("toolbeltSpellCastLinkedBypass.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
}
