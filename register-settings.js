export function registerBridgeSettings({
  moduleId,
  onTargetHelperActionRowsFixChange,
  onForceBarrageTargetDialogBridgeChange
}) {
  const localizeSetting = (key) => game.i18n.localize(`${moduleId}.settings.${key}`);
  const settings = [
    { key: "proxyToGM", scope: "world", type: Boolean, default: true },
    { key: "autoScrollTargets", scope: "client", type: Boolean, default: true },
    { key: "debugBridge", scope: "client", type: Boolean, default: false },
    { key: "itemActivationsRuFix", scope: "world", type: Boolean, default: false },
    { key: "itemActivationsAutoSelfEffect", scope: "world", type: Boolean, default: false },
    {
      key: "targetHelperActionRowsFix",
      scope: "world",
      type: Boolean,
      default: false,
      onChange: onTargetHelperActionRowsFixChange
    },
    { key: "targetHelperAttackBatchRoll", scope: "client", type: Boolean, default: true },
    {
      key: "forceBarrageTargetDialogBridge",
      scope: "client",
      type: Boolean,
      default: true,
      onChange: onForceBarrageTargetDialogBridgeChange
    },
    {
      key: "forceBarrageDialogMatchMode",
      scope: "client",
      type: String,
      choices: {
        safe: localizeSetting("forceBarrageDialogMatchMode.choices.safe"),
        aggressive: localizeSetting("forceBarrageDialogMatchMode.choices.aggressive")
      },
      default: "safe"
    },
    { key: "baneAuraVisualRefresh", scope: "world", type: Boolean, default: false },
    { key: "baneAuraVisualGrowBy5Experimental", scope: "world", type: Boolean, default: false },
    { key: "toolbeltMacroScopeBridge", scope: "world", type: Boolean, default: true },
    { key: "toolbeltSpellCastLinkedBypass", scope: "world", type: Boolean, default: true }
  ];

  for (const setting of settings) {
    const { key, onChange, ...definition } = setting;
    const config = {
      name: localizeSetting(`${key}.name`),
      hint: localizeSetting(`${key}.hint`),
      config: true,
      ...definition
    };

    if (typeof onChange === "function") {
      config.onChange = onChange;
    }

    game.settings.register(moduleId, key, config);
  }
}
