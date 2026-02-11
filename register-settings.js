export function registerBridgeSettings({
  moduleId,
  onTargetHelperActionRowsFixChange,
  onForceBarrageTargetDialogBridgeChange
}) {
  game.settings.register(moduleId, "proxyToGM", {
    name: "Proxy To Active GM",
    hint: "If enabled, non-GM clients send roll events to the active GM for automation.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(moduleId, "autoScrollTargets", {
    name: "Auto-Scroll Target Helper",
    hint: "When chat is already at the bottom, keep it pinned when Target Helper expands a message.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(moduleId, "debugBridge", {
    name: "Bridge Debug Logging",
    hint: "Client-side debug logging for bridge patches (scope inheritance, suppression, and linked-cast bypass decisions).",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(moduleId, "itemActivationsRuFix", {
    name: "PF2e Item Activations RU Fix",
    hint: "Optional compatibility patch: fix generated action type and frequency for Russian activation text.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(moduleId, "itemActivationsAutoSelfEffect", {
    name: "PF2e Item Activations Auto-Link Self Effect",
    hint: "Optional compatibility patch: link selfEffect from description only when one safe effect UUID is found.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(moduleId, "targetHelperActionRowsFix", {
    name: "Applied Label Layout Fix",
    hint: "Optional compatibility patch: keep Applied/effect-applied labels readable instead of vertical text.",
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
    name: "Force Barrage Target Dialog Enhancer",
    hint: "Optional UI patch: in Force Barrage target distribution dialogs, show token portrait, duplicate-name numbering, and hover-highlight/click-focus helpers.",
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
    name: "Force Barrage Dialog Match Mode",
    hint: "Safe mode uses strict target-label checks; aggressive mode applies enhancement to any matching number-distribution target dialog.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      safe: "Safe (Strict)",
      aggressive: "Aggressive (Broader)"
    },
    default: "safe"
  });
  game.settings.register(moduleId, "toolbeltMacroScopeBridge", {
    name: "Toolbelt Nested Macro Scope Bridge",
    hint: "Optional compatibility patch: nested script macros inherit Toolbelt spell scope (cast/options), including async compendium-link wrappers, so linked casts keep slot/charge behavior.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(moduleId, "toolbeltSpellCastLinkedBypass", {
    name: "Toolbelt Spell Cast Linked-Macro Bypass",
    hint: "Optional compatibility patch: when a linked spell macro internally casts, bypass one recursive linked-macro pass and suppress one actionable linked lookup to prevent duplicate dialogs and preserve slot/charge consumption.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
}
