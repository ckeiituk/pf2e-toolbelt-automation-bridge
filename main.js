import { registerBridgeSettings } from "./register-settings.js";
import { createToolbeltBridge } from "./toolbelt-bridge.js";

const MODULE_ID = "pf2e-toolbelt-automation-bridge";
const TOOLBELT_ID = "pf2e-toolbelt";
const AUTOMATION_ID = "patreon-v3";
const ITEM_ACTIVATIONS_ID = "pf2e-item-activations";
const AUTOANIMATIONS_ID = "autoanimations";
const PF2E_JB2A_MACROS_ID = "pf2e-jb2a-macros";
const SOCKET = `module.${MODULE_ID}`;
const CHAT_BOTTOM_EPSILON = 8;
const BANE_AURA_REFRESH_DEBOUNCE_MS = 200;
const TOOLBELT_ACTION_ROWS_FIX_STYLE_ID = `${MODULE_ID}-toolbelt-action-rows-fix`;
const FORCE_BARRAGE_TARGET_DIALOG_STYLE_ID = `${MODULE_ID}-force-barrage-target-dialog-style`;
const TARGET_HELPER_ATTACK_BATCH_BUTTON_CLASS = "bridge-target-helper-roll-attacks";
const TARGET_HELPER_ATTACK_BATCH_BUTTON_SELECTOR = `.${TARGET_HELPER_ATTACK_BATCH_BUTTON_CLASS}`;
const TARGET_HELPER_ATTACK_BATCH_BUTTON_BUSY_KEY = "bridgeAttackBatchBusy";
const TARGET_HELPER_ATTACK_BATCH_DELAY_MS = 90;
const TARGET_HELPER_TARGETING_SETTLE_MS = 25;
const TOOLBELT_LINKED_MACRO_FLAG_PATHS = [
  "flags.actionable.linked",
  `flags.${TOOLBELT_ID}.linked`
];
const TARGET_HELPER_SAVE_STATISTICS = new Set([
  "fortitude",
  "reflex",
  "will"
]);
const COMPAT_WARNING_PREFIX = `[${MODULE_ID}] Compatibility warning`;
const BANE_AURA_SOURCE_IDS = new Set([
  "Compendium.patreon-v3.effects.Item.FcUe8TT7bhqlURIf"
]);
const BANE_AURA_SLUGS = new Set([
  "aura-bane",
  "aura-effect-bane"
]);
const BANE_AURA_LABEL_PATTERNS = [
  /^Aura:\s*Bane$/i,
  /^Аура:\s*Проклятие$/i
];
const BANE_AURA_EXPERIMENTAL_GROW_FEET = 5;

let chatScrollElement = null;
let chatAtBottom = false;
let actorCreateEmbeddedDocumentsPatched = false;
const compatibilityWarningCodes = new Set();
const baneAuraRefreshTimers = new Map();

const SAFE_SELF_EFFECT_UUID_PATTERNS = [
  /^Compendium\.pf2e\.equipment-effects\.Item\.[A-Za-z0-9]+$/i,
  /^Compendium\.pf2e-item-activations\.item-activations-effects\.Item\.[A-Za-z0-9]+$/i
];

const RUSSIAN_NUMBER_MAP = {
  "один": 1,
  "одна": 1,
  "одно": 1,
  "раз": 1,
  "два": 2,
  "две": 2,
  "три": 3,
  "четыре": 4,
  "пять": 5,
  "шесть": 6,
  "семь": 7,
  "восемь": 8,
  "девять": 9,
  "десять": 10
};

const SPAN_GLYPH_CODE_MAP = {
  a: { type: "action", actions: 1 },
  1: { type: "action", actions: 1 },
  d: { type: "action", actions: 2 },
  2: { type: "action", actions: 2 },
  t: { type: "action", actions: 3 },
  3: { type: "action", actions: 3 },
  r: { type: "reaction", actions: null },
  f: { type: "free", actions: null }
};

function getHTMLElement(target) {
  if (!target) return null;
  if (target instanceof HTMLElement) return target;
  if (target?.[0] instanceof HTMLElement) return target[0];
  if (typeof target?.get === "function") {
    const el = target.get(0);
    if (el instanceof HTMLElement) return el;
  }
  return null;
}

function getChatRootElement() {
  return getHTMLElement(ui?.chat?.element ?? null);
}

function getChatScrollElement() {
  const root = getChatRootElement();
  if (!root) return null;
  return (
    root.querySelector(".chat-scroll") ||
    root.querySelector("#chat-log") ||
    root
  );
}

function isAtBottom(el) {
  if (!el) return false;
  return el.scrollHeight - el.clientHeight - el.scrollTop <= CHAT_BOTTOM_EPSILON;
}

function updateChatBottomState() {
  if (!chatScrollElement) return;
  chatAtBottom = isAtBottom(chatScrollElement);
}

function attachChatScrollListener() {
  const el = getChatScrollElement();
  if (!el) return;
  if (chatScrollElement === el) return;

  if (chatScrollElement) {
    chatScrollElement.removeEventListener("scroll", updateChatBottomState);
  }

  chatScrollElement = el;
  chatScrollElement.addEventListener("scroll", updateChatBottomState, { passive: true });
  updateChatBottomState();
}

function hasTargetHelperUI(html) {
  const el = getHTMLElement(html);
  if (!el) return false;
  return !!el.querySelector(".pf2e-toolbelt-target-targetRows");
}

function scrollChatToBottom() {
  if (ui?.chat?.scrollBottom) {
    ui.chat.scrollBottom();
    return;
  }
  const el = getChatScrollElement();
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function toTempMessage(raw) {
  if (!raw) return null;
  if (raw instanceof ChatMessage) return raw;
  if (raw.documentName === "ChatMessage") return raw;
  const Cls = CONFIG.ChatMessage?.documentClass ?? ChatMessage;
  try {
    return new Cls(raw, { temporary: true });
  } catch (err) {
    console.warn(`[${MODULE_ID}] Failed to build temp ChatMessage`, err);
    return null;
  }
}

function processAutomation(raw) {
  const msg = toTempMessage(raw);
  if (!msg) return;
  if (msg.id && game.messages.get(msg.id)) return;
  Hooks.callAll(`${AUTOMATION_ID}.processMessage`, msg);
}

function normalizeText(text) {
  return String(text ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseActionTypeFromDescription(description) {
  const value = String(description ?? "");
  const glyph = value.match(/@Glyph\[(Action)\s*([123])\]/i);
  if (glyph) {
    return { type: "action", actions: Number(glyph[2]) || 1 };
  }
  if (/@Glyph\[Reaction\]/i.test(value)) return { type: "reaction", actions: null };
  if (/@Glyph\[Free\]/i.test(value)) return { type: "free", actions: null };

  const spanGlyph = value.match(/<span class="action-glyph">\s*([123ARDF])\s*<\/span>/i);
  if (!spanGlyph) return null;
  return SPAN_GLYPH_CODE_MAP[spanGlyph[1].toLowerCase()] ?? null;
}

function parseFrequencyMax(rawAmount) {
  const amount = normalizeText(rawAmount);
  if (!amount) return 1;
  const number = Number.parseInt(amount, 10);
  if (!Number.isNaN(number)) return number;
  return RUSSIAN_NUMBER_MAP[amount] ?? 1;
}

function parseFrequencyPer(rawUnit) {
  const unit = normalizeText(rawUnit);
  if (!unit) return "day";
  if (unit.includes("ход")) return "turn";
  if (unit.includes("раунд")) return "round";
  if (unit.includes("10 минут")) return "PT10M";
  if (unit.includes("минут")) return "PT1M";
  if (unit.includes("24 час")) return "PT24H";
  if (unit.includes("час")) return "PT1H";
  if (unit.includes("недел")) return "P1W";
  if (unit.includes("месяц")) return "P1M";
  if (unit.includes("год")) return "P1Y";
  return "day";
}

function parseFrequencyFromDescription(description) {
  const value = String(description ?? "");
  const withPrefix = value.match(/<strong>\s*Частота\s*:?\s*<\/strong>\s*([^<]+)</i);
  if (!withPrefix) return null;

  const frequencyLine = normalizeText(withPrefix[1]);
  if (!frequencyLine) return null;

  let max = 1;
  let unitRaw = "";

  let match = frequencyLine.match(/^раз(?:а)?\s+(?:в|за)\s+(.+)$/i);
  if (match) {
    unitRaw = match[1];
  } else {
    match = frequencyLine.match(/^([\p{L}\d-]+)\s+раз(?:а)?\s+(?:в|за)\s+(.+)$/iu);
    if (match) {
      max = parseFrequencyMax(match[1]);
      unitRaw = match[2];
    }
  }

  if (!unitRaw) return null;

  return {
    max,
    per: parseFrequencyPer(unitRaw)
  };
}

function getValidActionTraits() {
  return new Set(Object.keys(CONFIG?.PF2E?.actionTraits ?? {}));
}

function normalizeTraitKey(raw) {
  const source = String(raw ?? "").trim();
  if (!source) return null;
  const fromLink = source.match(/@Trait\[([^\]|]+)(?:\|[^\]]+)?\]/i);
  const keyRaw = fromLink ? fromLink[1] : source;
  const key = keyRaw
    .toLowerCase()
    .replace(/[`"'{}()[\]]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || null;
}

function extractTraitsFromDescription(description, validTraits) {
  const traits = [];
  for (const match of String(description ?? "").matchAll(/@Trait\[([^\]|]+)(?:\|[^\]]+)?\]/gi)) {
    const key = normalizeTraitKey(match[1]);
    if (key && validTraits.has(key)) traits.push(key);
  }
  return traits;
}

function sanitizeActionTraits(currentTraits, description) {
  const validTraits = getValidActionTraits();
  if (validTraits.size === 0) {
    return Array.isArray(currentTraits) ? currentTraits : [];
  }

  const candidates = [];
  if (Array.isArray(currentTraits)) candidates.push(...currentTraits);
  candidates.push(...extractTraitsFromDescription(description, validTraits));

  const normalized = new Set();
  for (const trait of candidates) {
    const key = normalizeTraitKey(trait);
    if (key && validTraits.has(key)) normalized.add(key);
  }
  return [...normalized];
}

function getActionImage(actionType, actions) {
  if (actionType === "action") {
    if (actions === 1) return "systems/pf2e/icons/actions/OneAction.webp";
    if (actions === 2) return "systems/pf2e/icons/actions/TwoActions.webp";
    if (actions === 3) return "systems/pf2e/icons/actions/ThreeActions.webp";
  }
  if (actionType === "reaction") return "systems/pf2e/icons/actions/Reaction.webp";
  if (actionType === "free") return "systems/pf2e/icons/actions/FreeAction.webp";
  return null;
}

function isItemActivationsGeneratedAction(item) {
  return item?.type === "action" && !!item?.flags?.[ITEM_ACTIVATIONS_ID]?.grantedBy;
}

function shouldApplyItemActivationsRuFix() {
  return (
    game.settings.get(MODULE_ID, "itemActivationsRuFix") &&
    game.modules.get(ITEM_ACTIVATIONS_ID)?.active
  );
}

function shouldAutoLinkItemActivationSelfEffect() {
  return (
    game.settings.get(MODULE_ID, "itemActivationsAutoSelfEffect") &&
    game.modules.get(ITEM_ACTIVATIONS_ID)?.active
  );
}

function shouldApplyItemActivationsCreateSanitizer() {
  return shouldApplyItemActivationsRuFix() || shouldAutoLinkItemActivationSelfEffect();
}

function shouldApplyTargetHelperActionRowsFix() {
  return (
    game.settings.get(MODULE_ID, "targetHelperActionRowsFix") &&
    game.modules.get(TOOLBELT_ID)?.active
  );
}

function shouldApplyTargetHelperAttackBatchRoll() {
  return (
    game.settings.get(MODULE_ID, "targetHelperAttackBatchRoll") &&
    game.modules.get(TOOLBELT_ID)?.active
  );
}

function shouldApplyForceBarrageTargetDialogBridge() {
  return game.settings.get(MODULE_ID, "forceBarrageTargetDialogBridge");
}

function shouldApplyBaneAuraVisualRefresh() {
  return (
    game.settings.get(MODULE_ID, "baneAuraVisualRefresh") &&
    game.modules.get(AUTOANIMATIONS_ID)?.active &&
    game.modules.get(PF2E_JB2A_MACROS_ID)?.active &&
    game.modules.get("sequencer")?.active
  );
}

function shouldApplyBaneAuraVisualGrowBy5Experimental() {
  return (
    shouldApplyBaneAuraVisualRefresh() &&
    game.settings.get(MODULE_ID, "baneAuraVisualGrowBy5Experimental")
  );
}

function isBaneAuraEffect(item) {
  if (!item || item.type !== "effect") return false;

  const sourceId = String(item.sourceId ?? "").trim();
  if (sourceId && BANE_AURA_SOURCE_IDS.has(sourceId)) return true;

  const slug = String(item.slug ?? item.system?.slug ?? "").trim().toLowerCase();
  if (slug && BANE_AURA_SLUGS.has(slug)) return true;

  const name = String(item.name ?? "").trim();
  return BANE_AURA_LABEL_PATTERNS.some((pattern) => pattern.test(name));
}

function _getBadgeDotValue(change) {
  if (Object.prototype.hasOwnProperty.call(change, "system.badge.value")) {
    return change["system.badge.value"];
  }
  return foundry.utils.getProperty(change, "system.badge.value");
}

function hasBaneBadgeValueUpdate(change) {
  if (!change || typeof change !== "object") return false;
  return _getBadgeDotValue(change) !== undefined;
}

function getBaneBadgeValue(item, change) {
  let value = _getBadgeDotValue(change);
  if (value == null) value = item?.system?.badge?.value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getActorTokenForBaneAura(actor) {
  if (!actor) return null;

  const actorToken = actor?.token?.object;
  if (actorToken) return actorToken;

  const activeTokens = actor.getActiveTokens?.() ?? [];
  if (activeTokens[0]) return activeTokens[0];

  return canvas?.tokens?.placeables?.find((token) => token.actor?.id === actor.id) ?? null;
}

function getBaneAuraResizeDelta(sizeData) {
  const sceneDistance = Number(canvas?.scene?.grid?.distance ?? 5);
  if (!Number.isFinite(sceneDistance) || sceneDistance <= 0) return null;
  const deltaGridUnits = BANE_AURA_EXPERIMENTAL_GROW_FEET / sceneDistance;
  if (sizeData?.gridUnits) return { delta: deltaGridUnits, gridUnits: true };
  const gridSize = Number(canvas?.grid?.size ?? 0);
  if (!Number.isFinite(gridSize) || gridSize <= 0) return null;
  return { delta: deltaGridUnits * gridSize, gridUnits: false };
}

async function tryResizeExistingBaneAura(effectManager, effectItem, badgeValue) {
  if (!shouldApplyBaneAuraVisualGrowBy5Experimental()) return false;
  if (!effectManager || typeof effectManager.updateEffects !== "function") return false;

  const itemUuid = String(effectItem?.uuid ?? "").trim();
  if (!itemUuid) return false;

  let activeEffects = [];
  try {
    activeEffects = effectManager.getEffects({ origin: itemUuid }) ?? [];
  } catch (_error) {
    return false;
  }
  if (!activeEffects.length) return false;

  const primary = activeEffects[activeEffects.length - 1];
  const rawSize = primary?.data?.size;
  if (!rawSize || typeof rawSize !== "object") return false;
  if (rawSize.width === "auto" || rawSize.height === "auto") return false;

  const width = Number(rawSize.width);
  const height = Number(rawSize.height);
  if (!Number.isFinite(width) || width <= 0) return false;
  if (!Number.isFinite(height) || height <= 0) return false;

  const resizeDelta = getBaneAuraResizeDelta(rawSize);
  if (!resizeDelta) return false;

  const stale = activeEffects.slice(0, -1);
  if (stale.length) {
    await effectManager.endEffects({ effects: stale });
  }

  await effectManager.updateEffects(
    { effects: [primary] },
    {
      size: {
        width: width + resizeDelta.delta,
        height: height + resizeDelta.delta,
        ...(resizeDelta.gridUnits ? { gridUnits: true } : {})
      }
    }
  );

  bridgeDebug("Bane aura visual resized in place (+5ft experimental)", {
    actor: String(effectItem?.actor?.name ?? effectItem?.actor?.id ?? ""),
    item: String(effectItem?.name ?? effectItem?.id ?? ""),
    badge: badgeValue,
    staleCleared: stale.length,
    delta: resizeDelta.delta,
    gridUnits: resizeDelta.gridUnits
  });
  return true;
}

function scheduleBaneAuraVisualRefresh(effectItem, badgeValue) {
  const actorKey = String(effectItem?.actor?.uuid ?? effectItem?.actor?.id ?? "").trim();
  const itemUuid = String(effectItem?.uuid ?? "").trim();
  if (!actorKey || !itemUuid) return;

  const existingTimer = baneAuraRefreshTimers.get(actorKey);
  if (existingTimer) clearTimeout(existingTimer);

  const timerId = setTimeout(() => {
    baneAuraRefreshTimers.delete(actorKey);
    void refreshBaneAuraVisual(itemUuid, badgeValue);
  }, BANE_AURA_REFRESH_DEBOUNCE_MS);

  baneAuraRefreshTimers.set(actorKey, timerId);
}

async function refreshBaneAuraVisual(itemUuid, badgeValue) {
  if (!shouldApplyBaneAuraVisualRefresh()) return;

  let effectItem = null;
  try {
    effectItem = await fromUuid(itemUuid);
  } catch (_error) {
    effectItem = null;
  }
  if (!effectItem || !isBaneAuraEffect(effectItem)) return;

  const actor = effectItem.actor;
  const token = getActorTokenForBaneAura(actor);
  if (!token) {
    bridgeDebug("skip Bane aura visual refresh: no active token", {
      actor: String(actor?.name ?? actor?.id ?? ""),
      item: String(effectItem?.name ?? effectItem?.id ?? ""),
      badge: badgeValue
    });
    return;
  }

  const aaApi = globalThis.AutomatedAnimations;
  if (!aaApi || typeof aaApi.playAnimation !== "function") {
    bridgeDebug("skip Bane aura visual refresh: AutomatedAnimations API missing");
    return;
  }

  const effectManager = globalThis.Sequencer?.EffectManager;

  try {
    const resizedInPlace = await tryResizeExistingBaneAura(effectManager, effectItem, badgeValue);
    if (resizedInPlace) return;

    if (effectManager?.endEffects) {
      await effectManager.endEffects({ origin: effectItem.uuid });
    }

    await aaApi.playAnimation(token, effectItem, {
      activeEffect: true,
      tieToDocuments: true,
      targets: []
    });

    bridgeDebug("Bane aura visual refreshed", {
      actor: String(actor?.name ?? actor?.id ?? ""),
      token: String(token?.name ?? token?.id ?? ""),
      item: String(effectItem?.name ?? effectItem?.id ?? ""),
      badge: badgeValue
    });
  } catch (error) {
    console.warn(`[${MODULE_ID}] Failed to refresh Bane aura visual`, error);
  }
}

function getForceBarrageDialogMatchMode() {
  try {
    const mode = String(game.settings.get(MODULE_ID, "forceBarrageDialogMatchMode") ?? "safe").trim();
    return mode === "aggressive" ? "aggressive" : "safe";
  } catch (_error) {
    return "safe";
  }
}

function isBridgeDebugEnabled() {
  try {
    return !!game.settings.get(MODULE_ID, "debugBridge");
  } catch (_error) {
    return false;
  }
}

function bridgeDebug(message, payload) {
  if (!isBridgeDebugEnabled()) return;
  if (payload === undefined) {
    console.debug(`[${MODULE_ID}] ${message}`);
    return;
  }
  console.debug(`[${MODULE_ID}] ${message}`, payload);
}

function warnBridgeCompatibility(code, message, details) {
  if (compatibilityWarningCodes.has(code)) return;
  compatibilityWarningCodes.add(code);

  const text = `${COMPAT_WARNING_PREFIX}: ${message}`;
  console.warn(text, details ?? null);
  if (ui?.notifications?.warn) {
    ui.notifications.warn(text);
  }
}

let toolbeltBridge = null;
function getToolbeltBridge() {
  if (toolbeltBridge) return toolbeltBridge;
  toolbeltBridge = createToolbeltBridge({
    moduleId: MODULE_ID,
    toolbeltId: TOOLBELT_ID,
    linkedMacroFlagPaths: TOOLBELT_LINKED_MACRO_FLAG_PATHS,
    settingsKeyMacroScopeBridge: "toolbeltMacroScopeBridge",
    settingsKeySpellCastBypass: "toolbeltSpellCastLinkedBypass",
    asyncScopeFallbackTtlMs: 12000,
    linkedSuppressionTtlMs: 86400000,
    linkedSuppressionUses: 1,
    actionablePatchRetryMs: 250,
    actionablePatchMaxRetries: 40,
    actionableGetItemMacroPath: "game.toolbelt.dev.tools.actionable.getItemMacro",
    bridgeDebug,
    warnCompatibility: warnBridgeCompatibility
  });
  return toolbeltBridge;
}

function getTargetHelperActionRowsFixCss() {
  return `
    .chat-message .message-content .effect-applied,
    .chat-message .message-content .effect-applied * {
      writing-mode: horizontal-tb !important;
      text-orientation: mixed !important;
      white-space: normal !important;
      line-height: 1.2;
    }

    .chat-message .message-content .effect-applied {
      display: inline-block !important;
      max-width: 100%;
      overflow-wrap: anywhere;
    }

    .chat-message .message-content :is(button, a, span, div, li):has(> .effect-applied) {
      width: auto !important;
      min-width: 0 !important;
      height: auto !important;
      min-height: 0 !important;
      white-space: normal !important;
      writing-mode: horizontal-tb !important;
      text-orientation: mixed !important;
    }
  `;
}

function refreshStyleElement(id, shouldApply, getCss) {
  document.getElementById(id)?.remove();
  if (!shouldApply()) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = getCss();
  document.head.append(style);
}

function refreshTargetHelperActionRowsFixStyle() {
  refreshStyleElement(TOOLBELT_ACTION_ROWS_FIX_STYLE_ID, shouldApplyTargetHelperActionRowsFix, getTargetHelperActionRowsFixCss);
}

function getForceBarrageTargetDialogBridgeCss() {
  return `
    .dialog .window-content label.bridge-force-barrage-target-label-host {
      cursor: pointer;
    }

    .dialog .window-content .bridge-force-barrage-target-label {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      max-width: 100%;
      vertical-align: middle;
      white-space: nowrap;
    }

    .dialog .window-content .bridge-force-barrage-target-icon {
      width: 1.25rem;
      height: 1.25rem;
      object-fit: cover;
      border: 1px solid var(--color-border-light-2);
      border-radius: 3px;
      flex: 0 0 auto;
    }

    .dialog .window-content .bridge-force-barrage-target-name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
}

function refreshForceBarrageTargetDialogBridgeStyle() {
  refreshStyleElement(FORCE_BARRAGE_TARGET_DIALOG_STYLE_ID, shouldApplyForceBarrageTargetDialogBridge, getForceBarrageTargetDialogBridgeCss);
}

function getCanvasTokenById(tokenId) {
  const id = String(tokenId ?? "").trim();
  if (!id) return null;
  return canvas?.tokens?.get?.(id) ?? null;
}

function setDialogTokenHover(tokenId, hovered) {
  const token = getCanvasTokenById(tokenId);
  if (!token) return;

  try {
    if (hovered && typeof token._onHoverIn === "function") {
      token._onHoverIn({ type: "mouseenter", bridge: MODULE_ID });
      return;
    }

    if (!hovered && typeof token._onHoverOut === "function") {
      token._onHoverOut({ type: "mouseleave", bridge: MODULE_ID });
    }
  } catch (_error) {
    // best effort only
  }
}

function focusDialogToken(tokenId) {
  const token = getCanvasTokenById(tokenId);
  const center = token?.center;
  if (!center || typeof canvas?.animatePan !== "function") return;
  canvas.animatePan({ x: center.x, y: center.y, duration: 150 });
}

function formatTokenGridPositionLabel(token) {
  const tokenDoc = token?.document ?? token;
  const gridSize = Number(canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 0);
  const tokenX = Number(tokenDoc?.x);
  const tokenY = Number(tokenDoc?.y);
  if (!Number.isFinite(gridSize) || gridSize <= 0) return null;
  if (!Number.isFinite(tokenX) || !Number.isFinite(tokenY)) return null;

  const gridX = Math.floor(tokenX / gridSize) + 1;
  const gridY = Math.floor(tokenY / gridSize) + 1;
  return `x${gridX}, y${gridY}`;
}

function collectTargetDistributionRows(root) {
  if (!(root instanceof HTMLElement)) return [];
  return Array.from(root.querySelectorAll("table tr"))
    .map((row) => ({
      row,
      input: row.querySelector("input[type='number']"),
      label: row.querySelector("th label")
    }))
    .filter((entry) => entry.input instanceof HTMLInputElement && entry.label instanceof HTMLElement);
}

function extractTargetOrdinalFromLabelText(labelText) {
  const match = String(labelText ?? "").match(/(?:target|цель)\s*#\s*(\d+)/i);
  if (!match) return null;
  const ordinal = Number.parseInt(match[1], 10);
  if (!Number.isFinite(ordinal) || ordinal < 1) return null;
  return ordinal - 1;
}

function buildDialogTargetLookup(userTargets) {
  const byId = new Map();
  const byNormalizedName = new Map();

  for (const target of userTargets) {
    const id = String(target?.id ?? "").trim();
    if (id) byId.set(id, target);

    const normalizedName = normalizeText(target?.name ?? target?.document?.name ?? "");
    if (!normalizedName) continue;

    const list = byNormalizedName.get(normalizedName) ?? [];
    list.push(target);
    byNormalizedName.set(normalizedName, list);
  }

  const sortedNames = Array.from(byNormalizedName.keys()).sort((left, right) => right.length - left.length);
  return { byId, byNormalizedName, sortedNames };
}

function resolveDialogRowTarget({
  label,
  rowIndex,
  userTargets,
  targetLookup,
  usedTokenIds
}) {
  const existingId = String(label.querySelector("img[id]")?.id ?? "").trim();
  if (existingId) {
    const targetById = targetLookup.byId.get(existingId) ?? getCanvasTokenById(existingId);
    if (targetById) return targetById;
  }

  const labelText = String(label.textContent ?? "");
  const labelOrdinal = extractTargetOrdinalFromLabelText(labelText);
  if (labelOrdinal !== null) {
    const ordinalTarget = userTargets[labelOrdinal] ?? null;
    if (ordinalTarget) {
      const ordinalTargetId = String(ordinalTarget?.id ?? "").trim();
      if (!ordinalTargetId || !usedTokenIds.has(ordinalTargetId)) {
        return ordinalTarget;
      }
    }
  }

  const normalizedLabelText = normalizeText(labelText);
  if (normalizedLabelText) {
    for (const normalizedName of targetLookup.sortedNames) {
      if (!normalizedName || normalizedName.length < 3) continue;
      if (!normalizedLabelText.includes(normalizedName)) continue;

      const candidates = targetLookup.byNormalizedName.get(normalizedName) ?? [];
      const available = candidates.find((target) => {
        const id = String(target?.id ?? "").trim();
        return id ? !usedTokenIds.has(id) : true;
      });
      if (available) return available;
      if (candidates[0]) return candidates[0];
    }
  }

  const rowTarget = userTargets[rowIndex] ?? null;
  if (rowTarget) {
    const rowTargetId = String(rowTarget?.id ?? "").trim();
    if (!rowTargetId || !usedTokenIds.has(rowTargetId)) {
      return rowTarget;
    }
  }

  return userTargets.find((target) => {
    const id = String(target?.id ?? "").trim();
    return id ? !usedTokenIds.has(id) : true;
  }) ?? null;
}

function describeDialogTarget(target, rowIndex, totalByName, seenByName) {
  const token = getCanvasTokenById(target?.id) ?? target;
  const tokenId = String(token?.id ?? target?.id ?? "").trim();
  if (!tokenId) return null;

  const baseName = String(token?.name ?? target?.name ?? target?.document?.name ?? "").trim();
  const fallbackName = baseName || `Target ${rowIndex + 1}`;
  const seen = (seenByName.get(fallbackName) ?? 0) + 1;
  seenByName.set(fallbackName, seen);
  const total = totalByName.get(fallbackName) ?? 1;
  const numberedName = total > 1 ? `${fallbackName} #${seen}` : fallbackName;
  const gridPosition = formatTokenGridPositionLabel(token);
  const displayName = gridPosition ? `${numberedName} (${gridPosition})` : numberedName;
  const tokenImage = String(token?.document?.texture?.src ?? token?.texture?.src ?? "").trim();

  return {
    token,
    tokenId,
    displayName,
    tokenImage
  };
}

function createTargetDialogLabelContent({ tokenId, tokenImage, displayName }) {
  const content = document.createElement("span");
  content.className = "bridge-force-barrage-target-label";
  content.dataset.tokenId = tokenId;

  if (tokenImage) {
    const icon = document.createElement("img");
    icon.className = "bridge-force-barrage-target-icon";
    icon.src = tokenImage;
    icon.alt = displayName;
    content.append(icon);
  }

  const text = document.createElement("span");
  text.className = "bridge-force-barrage-target-name";
  text.textContent = displayName;
  content.append(text);

  return content;
}

function createTargetDialogLabelHtml({ tokenId, tokenImage, displayName }) {
  const esc = (str) => String(str ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const iconHtml = tokenImage
    ? `<img class="bridge-force-barrage-target-icon" src="${esc(tokenImage)}" alt="${esc(displayName)}">`
    : "";
  return `<span class="bridge-force-barrage-target-label" data-token-id="${esc(tokenId)}">${iconHtml}<span class="bridge-force-barrage-target-name">${esc(displayName)}</span></span>`;
}

function detectForceBarrageTargetDialog(root, userTargets, dialogTitle = "") {
  if (!(root instanceof HTMLElement)) return { matched: false, reason: "no-root" };
  const mode = getForceBarrageDialogMatchMode();

  const targetRows = collectTargetDistributionRows(root);
  if (targetRows.length === 0) return { matched: false, reason: "no-target-rows" };
  if (!root.querySelector("table")) return { matched: false, reason: "no-table" };
  if (root.querySelector("select[id$='qd']")) return { matched: false, reason: "contains-select" };
  if (root.querySelector("input[type='checkbox'][id$='qd']")) return { matched: false, reason: "contains-checkbox" };
  if (targetRows.length !== userTargets.length) {
    return {
      matched: false,
      reason: "input-target-count-mismatch",
      distributionInputCount: targetRows.length,
      targetCount: userTargets.length
    };
  }

  if (mode === "aggressive") {
    return { matched: true, reason: "aggressive-structural-match" };
  }

  const targetNameSet = new Set(
    userTargets
      .map((target) => String(target?.name ?? target?.document?.name ?? "").trim().toLowerCase())
      .filter(Boolean)
  );

  const labels = targetRows.map((entry) => entry.label);
  const hasTargetFigcaption = labels.some((label) => /(target|цель)\s*#\d+/i.test(label.textContent ?? ""));
  const targetIdSet = new Set(userTargets.map((target) => String(target?.id ?? "").trim()).filter(Boolean));
  const hasTargetIdMatch = labels.some((label) => {
    const id = String(label.querySelector("img[id]")?.id ?? "").trim();
    return id ? targetIdSet.has(id) : false;
  });
  const hasTargetNameMatch = labels.some((label) => {
    const text = String(label.textContent ?? "").trim().toLowerCase();
    if (!text) return false;
    for (const targetName of targetNameSet) {
      if (targetName && text.includes(targetName)) return true;
    }
    return false;
  });
  const hasTitleHint = /(target|цель|distribution|распредел|barrage|missile|шквал)/i.test(String(dialogTitle ?? ""));

  if (hasTargetFigcaption) return { matched: true, reason: "target-figcaption" };
  if (hasTargetIdMatch) return { matched: true, reason: "target-id-match" };
  if (hasTargetNameMatch) return { matched: true, reason: "target-name-match" };
  if (hasTitleHint) return { matched: true, reason: "title-hint-match" };
  return { matched: false, reason: "no-target-label-match" };
}

function enhanceForceBarrageTargetDialog(app, html) {
  if (!shouldApplyForceBarrageTargetDialogBridge()) return;

  const root = getHTMLElement(html);
  if (!root) return;
  if (root.dataset.bridgeForceBarrageDialogPatched === "true") return;

  const userTargets = Array.from(game.user?.targets ?? []);
  if (userTargets.length === 0) return;
  const matchResult = detectForceBarrageTargetDialog(root, userTargets, app?.title ?? "");
  if (!matchResult.matched) {
    bridgeDebug("skip dialog enhancement", {
      title: String(app?.title ?? ""),
      reason: matchResult.reason
    });
    return;
  }
  bridgeDebug("enhance dialog", {
    title: String(app?.title ?? ""),
    reason: matchResult.reason,
    mode: getForceBarrageDialogMatchMode()
  });

  const targetRows = collectTargetDistributionRows(root);
  if (targetRows.length === 0) return;

  root.dataset.bridgeForceBarrageDialogPatched = "true";
  const targetLookup = buildDialogTargetLookup(userTargets);
  const usedTokenIds = new Set();

  const totalByName = new Map();
  for (const target of userTargets) {
    const name = String(target?.name ?? target?.document?.name ?? "").trim();
    if (!name) continue;
    totalByName.set(name, (totalByName.get(name) ?? 0) + 1);
  }
  const indexByName = new Map();

  for (let rowIndex = 0; rowIndex < targetRows.length; rowIndex += 1) {
    const { label } = targetRows[rowIndex];
    const target = resolveDialogRowTarget({
      label,
      rowIndex,
      userTargets,
      targetLookup,
      usedTokenIds
    });
    if (!target) continue;

    const targetData = describeDialogTarget(target, rowIndex, totalByName, indexByName);
    if (!targetData) continue;
    usedTokenIds.add(targetData.tokenId);
    const content = createTargetDialogLabelContent(targetData);

    label.replaceChildren(content);
    label.classList.add("bridge-force-barrage-target-label-host");
    label.title = targetData.displayName;

    label.addEventListener("mouseenter", () => {
      setDialogTokenHover(targetData.tokenId, true);
    });
    label.addEventListener("mouseleave", () => {
      setDialogTokenHover(targetData.tokenId, false);
    });
    label.addEventListener("click", (event) => {
      event.preventDefault();
      focusDialogToken(targetData.tokenId);
    });
  }
}

function buildTargetDistributionQuickDialogRows(targets, options = {}) {
  const targetList = Array.from(targets ?? []);
  const defaultValue = Number.isFinite(options.defaultValue) ? options.defaultValue : 1;
  const totalByName = new Map();
  const seenByName = new Map();

  for (const target of targetList) {
    const name = String(target?.name ?? target?.document?.name ?? "").trim();
    if (!name) continue;
    totalByName.set(name, (totalByName.get(name) ?? 0) + 1);
  }

  return targetList.map((target, rowIndex) => {
    const targetData = describeDialogTarget(target, rowIndex, totalByName, seenByName);
    const fallbackLabel = String(target?.name ?? target?.document?.name ?? `Target ${rowIndex + 1}`).trim();

    let label = fallbackLabel || `Target ${rowIndex + 1}`;
    if (targetData) {
      label = createTargetDialogLabelHtml(targetData);
    }

    return {
      label,
      type: "number",
      options: defaultValue
    };
  });
}

function installBridgeModuleApi() {
  const module = game.modules.get(MODULE_ID);
  if (!module) return;

  const currentApi = module.api && typeof module.api === "object" ? module.api : {};
  module.api = {
    ...currentApi,
    focusTokenById: focusDialogToken,
    hoverTokenById: setDialogTokenHover,
    buildTargetDistributionQuickDialogRows,
    enhanceTargetDistributionDialog: ({ app, html }) => enhanceForceBarrageTargetDialog(app ?? null, html)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getToolbeltMessageTargetUuids(message) {
  if (!message) return [];

  let targetUuids = [];
  if (typeof message.getFlag === "function") {
    const directValue = message.getFlag(TOOLBELT_ID, "targets");
    if (Array.isArray(directValue)) {
      targetUuids = directValue;
    }
  }

  if (targetUuids.length === 0) {
    const fallbackValue = foundry.utils.getProperty(message, `flags.${TOOLBELT_ID}.targets`);
    if (Array.isArray(fallbackValue)) {
      targetUuids = fallbackValue;
    }
  }

  return targetUuids.map((uuid) => String(uuid ?? "").trim()).filter(Boolean);
}

function getUserTargetIds() {
  return Array.from(game.user?.targets ?? [])
    .map((target) => String(target?.id ?? target?.document?.id ?? "").trim())
    .filter(Boolean);
}

function updateUserTargetIds(tokenIds) {
  const user = game.user;
  if (!user) return;

  const normalizedIds = Array.from(
    new Set((tokenIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))
  );

  if (typeof user.updateTokenTargets === "function") {
    user.updateTokenTargets(normalizedIds);
    return;
  }

  const idSet = new Set(normalizedIds);
  for (const token of canvas?.tokens?.placeables ?? []) {
    token.setTarget(idSet.has(token.id), {
      releaseOthers: false,
      groupSelection: true,
      user
    });
  }
}

async function resolveTokenDocumentFromUuid(uuid) {
  if (!uuid) return null;

  let resolved = null;
  if (typeof fromUuidSync === "function") {
    try {
      resolved = fromUuidSync(uuid);
    } catch (_error) {
      resolved = null;
    }
  }

  if (!resolved && typeof fromUuid === "function") {
    try {
      resolved = await fromUuid(uuid);
    } catch (_error) {
      resolved = null;
    }
  }

  if (resolved?.documentName === "Token") {
    return resolved;
  }

  if (resolved?.document?.documentName === "Token") {
    return resolved.document;
  }

  return null;
}

async function resolveTargetHelperAttackTargets(message) {
  const resolvedTargets = [];
  const usedTokenIds = new Set();
  const targetUuids = getToolbeltMessageTargetUuids(message);

  for (const uuid of targetUuids) {
    const token = await resolveTokenDocumentFromUuid(uuid);
    const tokenId = String(token?.id ?? "").trim();
    if (!token || !tokenId || usedTokenIds.has(tokenId)) continue;
    usedTokenIds.add(tokenId);
    resolvedTargets.push(token);
  }

  if (resolvedTargets.length > 0) return resolvedTargets;

  for (const activeTarget of game.user?.targets ?? []) {
    const token = activeTarget?.document ?? activeTarget;
    const tokenId = String(token?.id ?? "").trim();
    if (!token || !tokenId || usedTokenIds.has(tokenId)) continue;
    usedTokenIds.add(tokenId);
    resolvedTargets.push(token);
  }

  return resolvedTargets;
}

function getTargetHelperCheckLink(root) {
  if (!(root instanceof HTMLElement)) return null;

  const messageContent = root.querySelector(".message-content");
  if (!(messageContent instanceof HTMLElement)) return null;

  const link =
    messageContent.querySelector(":scope > a.inline-check.hidden") ||
    messageContent.querySelector(":scope > a.inline-check") ||
    messageContent.querySelector("a.inline-check.hidden");

  return link instanceof HTMLAnchorElement ? link : null;
}

function hasAttackRollContext(message) {
  if (!message) return false;

  const contextType = String(foundry.utils.getProperty(message, "flags.pf2e.context.type") ?? "")
    .trim()
    .toLowerCase();
  if (contextType.includes("attack")) return true;

  const domains = foundry.utils.getProperty(message, "flags.pf2e.context.domains");
  if (Array.isArray(domains)) {
    const hasAttackDomain = domains.some((domain) =>
      String(domain ?? "").toLowerCase().includes("attack")
    );
    if (hasAttackDomain) return true;
  }

  return false;
}

function isAttackRollCheckLink(checkLink) {
  if (!(checkLink instanceof HTMLAnchorElement)) return false;

  const checkType = String(checkLink.dataset.pf2Check ?? "").trim().toLowerCase();
  if (!checkType) return false;
  return !TARGET_HELPER_SAVE_STATISTICS.has(checkType);
}

function shouldAddTargetHelperAttackBatchButton(message, root, checkLink) {
  if (!(root instanceof HTMLElement) || !(checkLink instanceof HTMLAnchorElement)) return false;
  if (hasAttackRollContext(message)) return true;
  return isAttackRollCheckLink(checkLink);
}

function createTargetHelperAttackBatchButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = TARGET_HELPER_ATTACK_BATCH_BUTTON_CLASS;
  button.dataset.action = "bridge-roll-attacks";
  button.innerHTML = "<i class='fa-solid fa-crosshairs'></i>";

  const title = game.i18n.localize(`${MODULE_ID}.targetHelper.rollAttacks`);
  button.title = title;
  button.ariaLabel = title;
  return button;
}

function dispatchTargetHelperCheckRoll(checkLink, sourceEvent, forceFastMode = false) {
  if (!(checkLink instanceof HTMLAnchorElement)) return;

  const clickEvent = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    altKey: !!sourceEvent?.altKey,
    ctrlKey: !!sourceEvent?.ctrlKey,
    metaKey: !!sourceEvent?.metaKey,
    shiftKey: forceFastMode || !!sourceEvent?.shiftKey
  });

  checkLink.dispatchEvent(clickEvent);
}

async function runTargetHelperAttackBatchRoll(message, root, sourceEvent) {
  const checkLink = getTargetHelperCheckLink(root);
  if (!checkLink) return;

  const targets = await resolveTargetHelperAttackTargets(message);
  if (targets.length === 0) {
    ui.notifications?.warn?.(game.i18n.localize(`${MODULE_ID}.targetHelper.rollAttacksNoTargets`));
    return;
  }

  const previousTargetIds = getUserTargetIds();
  const forceFastMode = targets.length > 1;

  bridgeDebug("Target Helper attack batch roll start", {
    messageId: String(message?.id ?? ""),
    targetCount: targets.length
  });

  try {
    for (const target of targets) {
      const targetId = String(target?.id ?? "").trim();
      if (!targetId) continue;

      updateUserTargetIds([targetId]);
      await sleep(TARGET_HELPER_TARGETING_SETTLE_MS);
      dispatchTargetHelperCheckRoll(checkLink, sourceEvent, forceFastMode);
      await sleep(TARGET_HELPER_ATTACK_BATCH_DELAY_MS);
    }
  } finally {
    updateUserTargetIds(previousTargetIds);
  }
}

function enhanceTargetHelperAttackBatchRoll(message, html) {
  if (!shouldApplyTargetHelperAttackBatchRoll()) return;

  const root = getHTMLElement(html);
  if (!root) return;

  const checkCard = root.querySelector(".pf2e-toolbelt-target-check");
  if (!(checkCard instanceof HTMLElement)) return;

  const targetRows = root.querySelector(".pf2e-toolbelt-target-targetRows");
  if (!(targetRows instanceof HTMLElement)) return;

  const buttonsWrapper = checkCard.querySelector(".pf2e-toolbelt-target-buttons");
  if (!(buttonsWrapper instanceof HTMLElement)) return;
  if (buttonsWrapper.querySelector(TARGET_HELPER_ATTACK_BATCH_BUTTON_SELECTOR)) return;

  const checkLink = getTargetHelperCheckLink(root);
  if (!checkLink) return;
  if (!shouldAddTargetHelperAttackBatchButton(message, root, checkLink)) return;

  const messageTargets = getToolbeltMessageTargetUuids(message);
  if (messageTargets.length < 2 && (game.user?.targets?.size ?? 0) < 2) return;

  const button = createTargetHelperAttackBatchButton();
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (button.dataset[TARGET_HELPER_ATTACK_BATCH_BUTTON_BUSY_KEY] === "true") return;

    button.dataset[TARGET_HELPER_ATTACK_BATCH_BUTTON_BUSY_KEY] = "true";
    button.disabled = true;

    try {
      await runTargetHelperAttackBatchRoll(message, root, event);
    } catch (error) {
      console.warn(`[${MODULE_ID}] Failed Target Helper attack batch roll`, error);
    } finally {
      button.disabled = false;
      delete button.dataset[TARGET_HELPER_ATTACK_BATCH_BUTTON_BUSY_KEY];
    }
  });

  const rollSavesButton = buttonsWrapper.querySelector(".pf2e-toolbelt-target-rollSaves");
  if (rollSavesButton?.nextSibling) {
    buttonsWrapper.insertBefore(button, rollSavesButton.nextSibling);
  } else {
    buttonsWrapper.append(button);
  }
}

function formatEffectAppliedMessage(html) {
  const root = getHTMLElement(html);
  if (!root) return;

  const appliedNodes = root.querySelectorAll(".effect-applied");
  for (const node of appliedNodes) {
    const link = node.querySelector("a");
    if (!(link instanceof HTMLElement)) continue;

    let cursor = link.previousSibling;
    while (cursor instanceof HTMLBRElement && cursor.dataset.bridgeEffectAppliedBreak === "true") {
      const prev = cursor.previousSibling;
      cursor.remove();
      cursor = prev;
    }

    const previousNode = link.previousSibling;
    if (previousNode?.nodeType === Node.TEXT_NODE) {
      previousNode.textContent = String(previousNode.textContent ?? "").replace(/\s+$/u, "");
    }

    const lineBreak = document.createElement("br");
    lineBreak.dataset.bridgeEffectAppliedBreak = "true";
    node.insertBefore(lineBreak, link);
  }
}

function isSafeSelfEffectUuid(uuid) {
  return SAFE_SELF_EFFECT_UUID_PATTERNS.some((pattern) => pattern.test(uuid));
}

function findSafeSelfEffectCandidate(description) {
  const uniqueCandidates = new Map();
  for (const match of String(description ?? "").matchAll(/@\s*UUID\[(Compendium\.[^\]]+)\](?:\{([^}]*)\})?/gi)) {
    const uuid = String(match[1] ?? "").trim();
    const name = String(match[2] ?? "").trim();
    if (isSafeSelfEffectUuid(uuid) && !uniqueCandidates.has(uuid)) {
      uniqueCandidates.set(uuid, { uuid, name: name || null });
    }
  }
  if (uniqueCandidates.size !== 1) return null;
  return uniqueCandidates.values().next().value ?? null;
}

function sanitizeItemActivationItemData(rawItem) {
  if (!isItemActivationsGeneratedAction(rawItem)) return rawItem;

  const item = foundry.utils.deepClone(rawItem);
  item.system ??= {};
  item.system.traits ??= {};
  item.system.actionType ??= {};
  item.system.actions ??= {};

  const description = item.system?.description?.value ?? "";
  if (shouldApplyItemActivationsRuFix()) {
    item.system.traits.value = sanitizeActionTraits(item.system?.traits?.value, description);

    const parsedAction = parseActionTypeFromDescription(description);
    if (parsedAction) {
      item.system.actionType.value = parsedAction.type;
      if (parsedAction.actions !== null) {
        item.system.actions.value = parsedAction.actions;
      }
      const image = getActionImage(parsedAction.type, parsedAction.actions);
      if (image) item.img = image;
    }

    const hasFrequency = !!item.system?.frequency?.per && item.system?.frequency?.max != null;
    if (!hasFrequency) {
      const parsedFrequency = parseFrequencyFromDescription(description);
      if (parsedFrequency) {
        item.system.frequency = parsedFrequency;
      }
    }
  }

  if (shouldAutoLinkItemActivationSelfEffect()) {
    item.system.selfEffect ??= {};
    const currentUuid = String(item.system?.selfEffect?.uuid ?? "").trim();
    if (!currentUuid) {
      const candidate = findSafeSelfEffectCandidate(description);
      if (candidate) {
        item.system.selfEffect.uuid = candidate.uuid;
        item.system.selfEffect.name = candidate.name ?? "Activation Effect";
      }
    }
  }

  return item;
}

function sanitizeItemActivationCreateData(data) {
  if (!Array.isArray(data) || data.length === 0) return data;
  return data.map((itemData) => sanitizeItemActivationItemData(itemData));
}

function installItemActivationsCreatePatch() {
  if (actorCreateEmbeddedDocumentsPatched) return;
  const actorProto = CONFIG?.Actor?.documentClass?.prototype ?? Actor?.prototype;
  if (!actorProto || typeof actorProto.createEmbeddedDocuments !== "function") return;

  const originalCreateEmbeddedDocuments = actorProto.createEmbeddedDocuments;
  actorProto.createEmbeddedDocuments = async function createEmbeddedDocumentsPatched(embeddedName, data, operation) {
    let payload = data;
    if (embeddedName === "Item" && shouldApplyItemActivationsCreateSanitizer()) {
      payload = sanitizeItemActivationCreateData(data);
    }
    return originalCreateEmbeddedDocuments.call(this, embeddedName, payload, operation);
  };

  actorCreateEmbeddedDocumentsPatched = true;
}

async function applyItemActivationsRussianFix(item, userId) {
  if (!shouldApplyItemActivationsCreateSanitizer()) return;
  if (!isItemActivationsGeneratedAction(item)) return;
  if (userId !== game.user.id) return;

  const description = item.system?.description?.value ?? "";
  const updates = {};

  if (shouldApplyItemActivationsRuFix()) {
    const parsedAction = parseActionTypeFromDescription(description);
    if (parsedAction) {
      const currentType = item.system?.actionType?.value ?? "passive";
      const currentActions = item.system?.actions?.value ?? null;
      if (currentType !== parsedAction.type) {
        updates["system.actionType.value"] = parsedAction.type;
      }
      if (parsedAction.actions !== null && currentActions !== parsedAction.actions) {
        updates["system.actions.value"] = parsedAction.actions;
      }
      const image = getActionImage(parsedAction.type, parsedAction.actions);
      if (image && item.img !== image) {
        updates.img = image;
      }
    }

    const hasFrequency = !!item.system?.frequency?.per && item.system?.frequency?.max != null;
    if (!hasFrequency) {
      const parsedFrequency = parseFrequencyFromDescription(description);
      if (parsedFrequency) {
        updates["system.frequency"] = parsedFrequency;
      }
    }
  }

  if (shouldAutoLinkItemActivationSelfEffect()) {
    const currentSelfEffect = String(item.system?.selfEffect?.uuid ?? "").trim();
    if (!currentSelfEffect) {
      const candidate = findSafeSelfEffectCandidate(description);
      if (candidate) {
        updates["system.selfEffect.uuid"] = candidate.uuid;
        updates["system.selfEffect.name"] = candidate.name ?? "Activation Effect";
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    await item.update(updates);
  }
}

Hooks.once("init", () => {
  registerBridgeSettings({
    moduleId: MODULE_ID,
    onTargetHelperActionRowsFixChange: () => {
      refreshTargetHelperActionRowsFixStyle();
    },
    onForceBarrageTargetDialogBridgeChange: () => {
      refreshForceBarrageTargetDialogBridgeStyle();
    }
  });
});

Hooks.once("ready", () => {
  const toolbeltBridgeInstance = getToolbeltBridge();
  toolbeltBridgeInstance.checkToolbeltCompatibility();
  installBridgeModuleApi();
  installItemActivationsCreatePatch();
  refreshTargetHelperActionRowsFixStyle();
  refreshForceBarrageTargetDialogBridgeStyle();
  toolbeltBridgeInstance.installMacroExecuteScopeBridge();
  toolbeltBridgeInstance.installToolbeltSpellCastLinkedBypass();
  toolbeltBridgeInstance.scheduleToolbeltActionableGetItemMacroSuppressionPatch();

  Hooks.on("renderDialog", (app, html) => {
    try {
      enhanceForceBarrageTargetDialog(app, html);
    } catch (error) {
      console.warn(`[${MODULE_ID}] Failed to enhance target distribution dialog`, error);
    }
  });

  Hooks.on("createItem", async (item, _options, userId) => {
    try {
      await applyItemActivationsRussianFix(item, userId);
    } catch (error) {
      console.warn(`[${MODULE_ID}] Failed to apply Item Activations RU fix`, error);
    }
  });

  Hooks.on("updateItem", (item, change, _options, userId) => {
    try {
      if (!shouldApplyBaneAuraVisualRefresh()) return;
      if (game.user.id !== userId) return;
      if (!isBaneAuraEffect(item)) return;
      if (!hasBaneBadgeValueUpdate(change)) return;

      const badgeValue = getBaneBadgeValue(item, change);
      bridgeDebug("queue Bane aura visual refresh", {
        actor: String(item?.actor?.name ?? item?.actor?.id ?? ""),
        item: String(item?.name ?? item?.id ?? ""),
        badge: badgeValue
      });
      scheduleBaneAuraVisualRefresh(item, badgeValue);
    } catch (error) {
      console.warn(`[${MODULE_ID}] Failed to queue Bane aura visual refresh`, error);
    }
  });

  if (!game.modules.get(TOOLBELT_ID)?.active) return;
  if (!game.modules.get(AUTOMATION_ID)?.active) return;

  attachChatScrollListener();

  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (shouldApplyTargetHelperActionRowsFix()) {
      formatEffectAppliedMessage(html);
    }
    if (shouldApplyTargetHelperAttackBatchRoll()) {
      enhanceTargetHelperAttackBatchRoll(message, html);
    }

    attachChatScrollListener();
    if (!game.settings.get(MODULE_ID, "autoScrollTargets")) return;
    if (!chatAtBottom) return;
    if (!hasTargetHelperUI(html)) return;
    requestAnimationFrame(() => {
      scrollChatToBottom();
      updateChatBottomState();
    });
  });

  game.socket.on(SOCKET, (payload) => {
    if (!game.user.isActiveGM) return;
    processAutomation(payload?.rollMessage);
  });

  Hooks.on("pf2e-toolbelt.rollSave", ({ rollMessage }) => {
    if (!rollMessage) return;

    const proxy = game.settings.get(MODULE_ID, "proxyToGM");
    const activeGM = game.users.activeGM;

    if (proxy && !game.user.isActiveGM && activeGM) {
      const data = rollMessage?.toObject ? rollMessage.toObject() : rollMessage;
      game.socket.emit(SOCKET, { rollMessage: data });
      return;
    }

    processAutomation(rollMessage);
  });
});
