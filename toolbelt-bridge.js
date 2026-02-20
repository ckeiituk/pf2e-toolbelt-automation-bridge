export function createToolbeltBridge({
  moduleId,
  toolbeltId,
  linkedMacroFlagPaths,
  settingsKeyMacroScopeBridge = "toolbeltMacroScopeBridge",
  settingsKeySpellCastBypass = "toolbeltSpellCastLinkedBypass",
  asyncScopeFallbackTtlMs = 12000,
  linkedSuppressionTtlMs = 86400000,
  linkedSuppressionUses = 1,
  actionablePatchRetryMs = 250,
  actionablePatchMaxRetries = 40,
  actionableGetItemMacroPath = "game.toolbelt.dev.tools.actionable.getItemMacro",
  bridgeDebug = () => {},
  warnCompatibility = () => {}
}) {
  let macroExecuteScopeBridgePatched = false;
  let spellCastLinkedMacroBypassPatched = false;
  let toolbeltGetItemMacroSuppressionPatched = false;
  let toolbeltGetItemMacroSuppressionPatchIntervalId = null;
  let toolbeltGetItemMacroSuppressionPatchRetries = 0;
  const macroExecutionScopeStack = [];
  const macroExecutionFallbackScopes = [];
  const toolbeltLinkedMacroSuppressions = new Map();

  function shouldApplyToolbeltMacroScopeBridge() {
    return (
      game.settings.get(moduleId, settingsKeyMacroScopeBridge) &&
      game.modules.get(toolbeltId)?.active
    );
  }

  function shouldApplyToolbeltSpellCastLinkedBypass() {
    return (
      game.settings.get(moduleId, settingsKeySpellCastBypass) &&
      game.modules.get(toolbeltId)?.active
    );
  }

  function isPlainObjectScope(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function hasScopeData(value) {
    return isPlainObjectScope(value) && Object.keys(value).length > 0;
  }

  function getLastScopeFromStack() {
    for (let index = macroExecutionScopeStack.length - 1; index >= 0; index -= 1) {
      const scope = macroExecutionScopeStack[index];
      if (isToolbeltCastScope(scope)) return scope;
    }
    return null;
  }

  function isInsideScriptMacroExecution() {
    return macroExecutionScopeStack.length > 0;
  }

  function isToolbeltCastScope(scope) {
    return hasScopeData(scope) && typeof scope?.cast === "function" && !!scope?.spell;
  }

  function isSameSpellReference(left, right) {
    if (!left || !right) return false;

    const leftUuid = String(left?.uuid ?? "").trim();
    const rightUuid = String(right?.uuid ?? "").trim();
    if (leftUuid && rightUuid && leftUuid === rightUuid) return true;

    const leftId = String(left?.id ?? left?._id ?? "").trim();
    const rightId = String(right?.id ?? right?._id ?? "").trim();
    return !!leftId && !!rightId && leftId === rightId;
  }

  function rememberMacroExecutionFallbackScope(scope) {
    if (!isToolbeltCastScope(scope)) return;
    cleanupMacroExecutionFallbackScopes();
    const expiresAt = Date.now() + asyncScopeFallbackTtlMs;
    const existingIndex = macroExecutionFallbackScopes.findIndex((entry) => entry.scope === scope);
    if (existingIndex >= 0) {
      macroExecutionFallbackScopes[existingIndex].expiresAt = Math.max(
        Number(macroExecutionFallbackScopes[existingIndex]?.expiresAt ?? 0),
        expiresAt
      );
      bridgeDebug("refresh fallback scope", {
        spell: String(scope?.spell?.name ?? scope?.spell?.id ?? ""),
        queueSize: macroExecutionFallbackScopes.length
      });
      return;
    }

    macroExecutionFallbackScopes.push({
      scope,
      expiresAt
    });
    bridgeDebug("enqueue fallback scope", {
      spell: String(scope?.spell?.name ?? scope?.spell?.id ?? ""),
      queueSize: macroExecutionFallbackScopes.length
    });
  }

  function cleanupMacroExecutionFallbackScopes() {
    if (macroExecutionFallbackScopes.length === 0) return;
    const now = Date.now();
    for (let index = macroExecutionFallbackScopes.length - 1; index >= 0; index -= 1) {
      const entry = macroExecutionFallbackScopes[index];
      if (!isToolbeltCastScope(entry?.scope) || Number(entry?.expiresAt ?? 0) <= now) {
        macroExecutionFallbackScopes.splice(index, 1);
      }
    }
  }

  function findMacroExecutionFallbackScope(spell = null) {
    cleanupMacroExecutionFallbackScopes();
    if (macroExecutionFallbackScopes.length === 0) return null;

    if (!spell) {
      return macroExecutionFallbackScopes[0]?.scope ?? null;
    }

    for (let index = macroExecutionFallbackScopes.length - 1; index >= 0; index -= 1) {
      const scope = macroExecutionFallbackScopes[index]?.scope;
      if (isToolbeltCastScope(scope) && isSameSpellReference(spell, scope.spell)) {
        return scope;
      }
    }

    return null;
  }

  function takeMacroExecutionFallbackScope() {
    cleanupMacroExecutionFallbackScopes();
    if (macroExecutionFallbackScopes.length === 0) return null;
    const entry = macroExecutionFallbackScopes.shift() ?? null;
    const scope = entry?.scope ?? null;
    if (scope) {
      bridgeDebug("dequeue fallback scope", {
        spell: String(scope?.spell?.name ?? scope?.spell?.id ?? ""),
        queueSize: macroExecutionFallbackScopes.length
      });
    }
    return scope;
  }

  function isLikelyAsyncLinkedWrapperMacro(macroDoc) {
    const name = String(macroDoc?.name ?? "");
    if (/XDY DO_NOT_IMPORT/i.test(name)) return true;
    const command = String(macroDoc?.command ?? "");
    return /_executeMacroByName\s*\(|pack\.getDocuments\s*\(/i.test(command);
  }

  function getLinkedMacroFlagData(spell) {
    if (!spell) return null;
    for (const path of linkedMacroFlagPaths) {
      const value = foundry.utils.getProperty(spell, path);
      if (value) {
        return { path, value };
      }
    }
    return null;
  }

  function setLinkedMacroFlagValue(spell, path, value) {
    if (!spell || !path) return;
    foundry.utils.setProperty(spell, path, value);
    if (spell?._source && typeof spell._source === "object") {
      foundry.utils.setProperty(spell._source, path, value);
    }
  }

  function getSpellSuppressionKeys(spell) {
    if (!spell) return [];
    const keys = [];
    const id = String(spell?.id ?? spell?._id ?? "").trim();
    const uuid = String(spell?.uuid ?? "").trim();
    const actorId = String(spell?.actor?.id ?? spell?.parent?.id ?? "").trim();
    if (uuid) keys.push(`uuid:${uuid}`);
    if (id) {
      keys.push(`id:${id}`);
      if (actorId) keys.push(`actor:${actorId}:id:${id}`);
    }
    return [...new Set(keys)];
  }

  function cleanupLinkedMacroSuppressions() {
    const now = Date.now();
    for (const [key, data] of toolbeltLinkedMacroSuppressions.entries()) {
      if (!data || data.expiresAt <= now || data.uses <= 0) {
        toolbeltLinkedMacroSuppressions.delete(key);
      }
    }
  }

  function registerLinkedMacroSuppressionForSpell(spell, uses = linkedSuppressionUses, scopeRef = null) {
    if (!spell || uses <= 0) return;
    cleanupLinkedMacroSuppressions();
    const expiresAt = Date.now() + linkedSuppressionTtlMs;
    const keys = getSpellSuppressionKeys(spell);
    bridgeDebug("register suppression", {
      spell: String(spell?.name ?? spell?.id ?? ""),
      keys,
      uses,
      scopeBound: !!scopeRef
    });
    for (const key of keys) {
      const existing = toolbeltLinkedMacroSuppressions.get(key);
      const mergedUses = Math.max(existing?.uses ?? 0, uses);
      const mergedExpiry = Math.max(existing?.expiresAt ?? 0, expiresAt);
      toolbeltLinkedMacroSuppressions.set(key, {
        uses: mergedUses,
        expiresAt: mergedExpiry,
        scopeRef: scopeRef ?? existing?.scopeRef ?? null
      });
    }
  }

  function consumeLinkedMacroSuppressionForSpell(spell, scopeRef = null) {
    cleanupLinkedMacroSuppressions();
    const keys = getSpellSuppressionKeys(spell);
    for (const key of keys) {
      const existing = toolbeltLinkedMacroSuppressions.get(key);
      if (!existing) continue;
      if (existing.scopeRef && scopeRef && existing.scopeRef !== scopeRef) continue;
      if (existing.scopeRef && !scopeRef) continue;

      const remaining = existing.uses - 1;
      if (remaining <= 0) {
        toolbeltLinkedMacroSuppressions.delete(key);
      } else {
        toolbeltLinkedMacroSuppressions.set(key, {
          uses: remaining,
          expiresAt: existing.expiresAt,
          scopeRef: existing.scopeRef ?? null
        });
      }
      bridgeDebug("consume suppression", {
        spell: String(spell?.name ?? spell?.id ?? ""),
        key,
        remaining,
        scopeBound: !!existing.scopeRef
      });
      return true;
    }
    bridgeDebug("consume suppression miss", {
      spell: String(spell?.name ?? spell?.id ?? ""),
      keys,
      scopeBound: !!scopeRef
    });
    return false;
  }

  function getToolbeltScopeForSuppression(spell) {
    const activeScope = getLastScopeFromStack();
    if (isToolbeltCastScope(activeScope) && isSameSpellReference(spell, activeScope.spell)) {
      return activeScope;
    }

    return findMacroExecutionFallbackScope(spell);
  }

  function installToolbeltActionableGetItemMacroSuppressionPatch() {
    if (toolbeltGetItemMacroSuppressionPatched) return true;

    const actionableGetItemMacro = game?.toolbelt?.dev?.tools?.actionable?.getItemMacro;
    if (typeof actionableGetItemMacro !== "function") {
      warnCompatibility(
        "toolbelt-actionable-missing",
        `Expected Toolbelt API path missing: ${actionableGetItemMacroPath}`,
        {
          toolbeltVersion: String(game.modules.get(toolbeltId)?.version ?? "unknown")
        }
      );
      return false;
    }

    const libWrapperRegistered = registerBridgeLibWrapper(
      actionableGetItemMacroPath,
      async function toolbeltGetItemMacroSuppressed(wrapped, action) {
        const suppressionScope = getToolbeltScopeForSuppression(action);
        if (
          shouldApplyToolbeltSpellCastLinkedBypass() &&
          suppressionScope &&
          consumeLinkedMacroSuppressionForSpell(action, suppressionScope)
        ) {
          bridgeDebug("suppress actionable linked macro lookup", {
            spell: String(action?.name ?? action?.id ?? ""),
            scopeSpell: String(suppressionScope?.spell?.name ?? suppressionScope?.spell?.id ?? "")
          });
          return null;
        }
        return await wrapped(action);
      },
      "MIXED"
    );

    if (!libWrapperRegistered) return false;
    bridgeDebug("installed getItemMacro suppression wrapper", { target: actionableGetItemMacroPath });
    toolbeltGetItemMacroSuppressionPatched = true;
    return true;
  }

  function scheduleToolbeltActionableGetItemMacroSuppressionPatch() {
    if (toolbeltGetItemMacroSuppressionPatched) return;

    if (installToolbeltActionableGetItemMacroSuppressionPatch()) {
      return;
    }

    if (toolbeltGetItemMacroSuppressionPatchIntervalId !== null) return;

    toolbeltGetItemMacroSuppressionPatchRetries = 0;
    toolbeltGetItemMacroSuppressionPatchIntervalId = window.setInterval(() => {
      if (toolbeltGetItemMacroSuppressionPatched || installToolbeltActionableGetItemMacroSuppressionPatch()) {
        window.clearInterval(toolbeltGetItemMacroSuppressionPatchIntervalId);
        toolbeltGetItemMacroSuppressionPatchIntervalId = null;
        return;
      }

      toolbeltGetItemMacroSuppressionPatchRetries += 1;
      if (toolbeltGetItemMacroSuppressionPatchRetries >= actionablePatchMaxRetries) {
        window.clearInterval(toolbeltGetItemMacroSuppressionPatchIntervalId);
        toolbeltGetItemMacroSuppressionPatchIntervalId = null;
        console.warn(`[${moduleId}] Failed to patch Toolbelt actionable.getItemMacro after retries`);
        warnCompatibility(
          "toolbelt-actionable-patch-retries",
          "Unable to install Toolbelt actionable.getItemMacro suppression patch after retries."
        );
      }
    }, actionablePatchRetryMs);
  }

  function resolveSpellDocumentForCast(entry, spell) {
    if (!spell) return null;
    if (spell?.documentName === "Item" && spell?.type === "spell") {
      return spell;
    }

    const actorItems = entry?.actor?.items;
    const spellId = String(spell?.id ?? spell?._id ?? "").trim();
    if (spellId && actorItems?.get) {
      const byId = actorItems.get(spellId);
      if (byId?.documentName === "Item" && byId?.type === "spell") {
        return byId;
      }
    }

    const spellUuid = String(spell?.uuid ?? "").trim();
    if (spellUuid && typeof fromUuidSync === "function") {
      try {
        const byUuid = fromUuidSync(spellUuid);
        if (byUuid?.documentName === "Item" && byUuid?.type === "spell") {
          return byUuid;
        }
      } catch (_error) {
        // ignore and keep best-effort resolution
      }
    }

    return null;
  }

  function canUseLibWrapper() {
    return typeof globalThis?.libWrapper?.register === "function";
  }

  function registerBridgeLibWrapper(target, wrapper, type = "MIXED") {
    if (!canUseLibWrapper()) return false;
    try {
      globalThis.libWrapper.register(moduleId, target, wrapper, type);
      return true;
    } catch (error) {
      console.warn(`[${moduleId}] Failed to register libWrapper for ${target}`, error);
      return false;
    }
  }

  function installBridgePatchWithFallback({
    debugLabel,
    target,
    wrapper,
    fallbackPatch
  }) {
    const libWrapperRegistered = registerBridgeLibWrapper(target, wrapper, "MIXED");
    if (libWrapperRegistered) {
      bridgeDebug(`${debugLabel} using libWrapper`);
      return;
    }

    bridgeDebug(`${debugLabel} using fallback patch`);
    fallbackPatch();
  }

  function checkToolbeltCompatibility() {
    if (!game.modules.get(toolbeltId)?.active) return;

    if (!canUseLibWrapper()) {
      warnCompatibility(
        "libwrapper-missing",
        "libWrapper is not available; bridge will use fallback prototype patches with higher conflict risk."
      );
    }

    const actionableGetItemMacro = game?.toolbelt?.dev?.tools?.actionable?.getItemMacro;
    if (typeof actionableGetItemMacro !== "function") {
      warnCompatibility(
        "toolbelt-actionable-shape",
        `Toolbelt API not in expected shape: ${actionableGetItemMacroPath}`,
        {
          toolbeltVersion: String(game.modules.get(toolbeltId)?.version ?? "unknown")
        }
      );
    }

    const spellcastingProto = CONFIG?.PF2E?.Item?.documentClasses?.spellcastingEntry?.prototype;
    if (!spellcastingProto || typeof spellcastingProto.cast !== "function") {
      warnCompatibility(
        "pf2e-spellcasting-cast-missing",
        "PF2E spellcastingEntry.cast was not found; linked-cast bypass cannot be installed."
      );
    }
  }

  async function runMacroExecuteScopeBridge(macroDoc, wrapped, args) {
    if (macroDoc?.type !== "script") {
      return await wrapped(...args);
    }

    const bridgeEnabled = shouldApplyToolbeltMacroScopeBridge();
    const hasIncomingScopeArg = args.length > 0;
    const incomingScope = hasIncomingScopeArg ? args[0] : undefined;
    const incomingScopeIsPlainObject = isPlainObjectScope(incomingScope);
    const incomingScopeHasData = hasScopeData(incomingScope);
    const incomingScopeIsToolbelt = isToolbeltCastScope(incomingScope);
    const canBridgeFirstArg = !hasIncomingScopeArg || incomingScopeIsPlainObject;

    const inheritedScopeFromStack = bridgeEnabled && canBridgeFirstArg ? getLastScopeFromStack() : null;
    const inheritedScopeFromFallback =
      bridgeEnabled &&
      canBridgeFirstArg &&
      !inheritedScopeFromStack &&
      !incomingScopeIsToolbelt &&
      !incomingScopeHasData &&
      isLikelyAsyncLinkedWrapperMacro(macroDoc)
        ? takeMacroExecutionFallbackScope()
        : null;
    const inheritedScope = inheritedScopeFromStack ?? inheritedScopeFromFallback;

    let effectiveScope = incomingScopeIsToolbelt ? incomingScope : null;
    if (!effectiveScope && bridgeEnabled && canBridgeFirstArg) {
      effectiveScope = inheritedScope;
    }

    if (bridgeEnabled && incomingScopeIsToolbelt) {
      rememberMacroExecutionFallbackScope(incomingScope);
    }

    const trackedScope = isToolbeltCastScope(effectiveScope) ? effectiveScope : null;
    bridgeDebug("macro scope bridge", {
      macro: String(macroDoc?.name ?? ""),
      hasIncomingScopeArg,
      incomingScopeIsToolbelt,
      inheritedFromStack: !!inheritedScopeFromStack,
      inheritedFromFallback: !!inheritedScopeFromFallback,
      trackedScope: !!trackedScope
    });

    if (bridgeEnabled && trackedScope) {
      rememberMacroExecutionFallbackScope(trackedScope);
      if (shouldApplyToolbeltSpellCastLinkedBypass()) {
        registerLinkedMacroSuppressionForSpell(trackedScope.spell, linkedSuppressionUses, trackedScope);
      }
    }

    macroExecutionScopeStack.push(trackedScope);
    try {
      if (!canBridgeFirstArg || !trackedScope) return await wrapped(...args);
      if (hasIncomingScopeArg) return await wrapped(trackedScope, ...args.slice(1));
      return await wrapped(trackedScope);
    } finally {
      macroExecutionScopeStack.pop();
    }
  }

  async function runSpellCastLinkedBypass(entry, wrapped, spell, options = {}) {
    if (!shouldApplyToolbeltSpellCastLinkedBypass()) {
      return await wrapped(spell, options);
    }

    const spellDoc = resolveSpellDocumentForCast(entry, spell);
    const castSpell = spellDoc ?? spell;

    const activeScope = getLastScopeFromStack();
    const linkedFlagData =
      getLinkedMacroFlagData(spell) ??
      getLinkedMacroFlagData(spellDoc) ??
      getLinkedMacroFlagData(activeScope?.spell);
    if (!linkedFlagData) {
      bridgeDebug("cast bypass skipped: no linked flag", {
        spell: String(castSpell?.name ?? castSpell?.id ?? ""),
        scopeSpell: String(activeScope?.spell?.name ?? activeScope?.spell?.id ?? "")
      });
      return await wrapped(castSpell, options);
    }

    const activeScopeSpellUuid = String(activeScope?.spell?.uuid ?? "");
    const currentSpellUuid = String(spellDoc?.uuid ?? spell?.uuid ?? "");
    const sameSpellScopeCast = !!activeScopeSpellUuid && activeScopeSpellUuid === currentSpellUuid;

    const isSilentCast = options?.message === false;
    const silentMacroCast = isSilentCast && (isInsideScriptMacroExecution() || isToolbeltCastScope(activeScope));
    if (!sameSpellScopeCast && !silentMacroCast) {
      bridgeDebug("cast bypass skipped: scope mismatch", {
        spell: String(castSpell?.name ?? castSpell?.id ?? ""),
        sameSpellScopeCast,
        silentMacroCast
      });
      return await wrapped(castSpell, options);
    }

    bridgeDebug("cast bypass active", {
      spell: String(castSpell?.name ?? castSpell?.id ?? ""),
      linkedPath: linkedFlagData.path,
      sameSpellScopeCast,
      silentMacroCast
    });
    const targetsToPatch = new Set([spell, spellDoc, activeScope?.spell].filter(Boolean));
    const previousValues = [];
    for (const target of targetsToPatch) {
      const previousValue = foundry.utils.getProperty(target, linkedFlagData.path);
      if (previousValue !== undefined && previousValue !== null) {
        previousValues.push({ target, previousValue });
        setLinkedMacroFlagValue(target, linkedFlagData.path, null);
      }
    }

    try {
      return await wrapped(castSpell, options);
    } finally {
      for (const { target, previousValue } of previousValues) {
        setLinkedMacroFlagValue(target, linkedFlagData.path, previousValue);
      }
    }
  }

  function installMacroExecuteScopeBridge() {
    if (macroExecuteScopeBridgePatched) return;

    const macroProto = CONFIG?.Macro?.documentClass?.prototype ?? Macro?.prototype;
    if (!macroProto || typeof macroProto.execute !== "function") return;

    installBridgePatchWithFallback({
      debugLabel: "macro scope bridge",
      target: "Macro.prototype.execute",
      wrapper: async function macroExecuteScopeBridgeWrapped(wrapped, ...args) {
        return runMacroExecuteScopeBridge(this, (...wrappedArgs) => wrapped(...wrappedArgs), args);
      },
      fallbackPatch: () => {
        const originalExecute = macroProto.execute;
        macroProto.execute = async function macroExecuteScopeBridgeFallback(...args) {
          return runMacroExecuteScopeBridge(this, (...wrappedArgs) => originalExecute.apply(this, wrappedArgs), args);
        };
      }
    });

    macroExecuteScopeBridgePatched = true;
  }

  function installToolbeltSpellCastLinkedBypass() {
    if (spellCastLinkedMacroBypassPatched) return;

    const spellcastingProto = CONFIG?.PF2E?.Item?.documentClasses?.spellcastingEntry?.prototype;
    if (!spellcastingProto || typeof spellcastingProto.cast !== "function") return;

    installBridgePatchWithFallback({
      debugLabel: "spell cast bypass",
      target: "CONFIG.PF2E.Item.documentClasses.spellcastingEntry.prototype.cast",
      wrapper: async function spellCastLinkedBypassWrapped(wrapped, spell, options = {}) {
        return runSpellCastLinkedBypass(this, (wrappedSpell, wrappedOptions) => wrapped(wrappedSpell, wrappedOptions), spell, options);
      },
      fallbackPatch: () => {
        const originalCast = spellcastingProto.cast;
        spellcastingProto.cast = async function spellCastLinkedBypassFallback(spell, options = {}) {
          return runSpellCastLinkedBypass(this, (wrappedSpell, wrappedOptions) => originalCast.call(this, wrappedSpell, wrappedOptions), spell, options);
        };
      }
    });

    spellCastLinkedMacroBypassPatched = true;
  }

  return {
    checkToolbeltCompatibility,
    installMacroExecuteScopeBridge,
    installToolbeltSpellCastLinkedBypass,
    scheduleToolbeltActionableGetItemMacroSuppressionPatch
  };
}
