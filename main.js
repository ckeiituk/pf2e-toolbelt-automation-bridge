const MODULE_ID = "pf2e-toolbelt-automation-bridge";
const TOOLBELT_ID = "pf2e-toolbelt";
const AUTOMATION_ID = "patreon-v3";
const ITEM_ACTIVATIONS_ID = "pf2e-item-activations";
const SOCKET = `module.${MODULE_ID}`;
const CHAT_BOTTOM_EPSILON = 8;
const TOOLBELT_ACTION_ROWS_FIX_STYLE_ID = `${MODULE_ID}-toolbelt-action-rows-fix`;
const FORCE_BARRAGE_TARGET_DIALOG_STYLE_ID = `${MODULE_ID}-force-barrage-target-dialog-style`;
const TOOLBELT_LINKED_MACRO_FLAG_PATHS = [
  "flags.actionable.linked",
  `flags.${TOOLBELT_ID}.linked`
];
const ASYNC_SCOPE_FALLBACK_TTL_MS = 12000;
const TOOLBELT_LINKED_SUPPRESSION_TTL_MS = 86400000;
const TOOLBELT_LINKED_SUPPRESSION_USES = 1;
const TOOLBELT_ACTIONABLE_PATCH_RETRY_MS = 250;
const TOOLBELT_ACTIONABLE_PATCH_MAX_RETRIES = 40;
const TOOLBELT_ACTIONABLE_GET_ITEM_MACRO_PATH = "game.toolbelt.dev.tools.actionable.getItemMacro";

let chatScrollElement = null;
let chatAtBottom = false;
let actorCreateEmbeddedDocumentsPatched = false;
let macroExecuteScopeBridgePatched = false;
let spellCastLinkedMacroBypassPatched = false;
let toolbeltGetItemMacroSuppressionPatched = false;
let toolbeltGetItemMacroSuppressionPatchIntervalId = null;
let toolbeltGetItemMacroSuppressionPatchRetries = 0;
const macroExecutionScopeStack = [];
let macroExecutionFallbackScope = null;
let macroExecutionFallbackScopeUntil = 0;
const toolbeltLinkedMacroSuppressions = new Map();

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

function getHTMLElement(target) {
  if (!target) return null;
  if (target instanceof HTMLElement) return target;
  if (Array.isArray(target) && target[0] instanceof HTMLElement) return target[0];
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
  const code = spanGlyph[1].toLowerCase();
  if (code === "a" || code === "1") return { type: "action", actions: 1 };
  if (code === "d" || code === "2") return { type: "action", actions: 2 };
  if (code === "t" || code === "3") return { type: "action", actions: 3 };
  if (code === "r") return { type: "reaction", actions: null };
  if (code === "f") return { type: "free", actions: null };
  return null;
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
  if (unit.includes("сут") || unit.includes("день") || unit.includes("дня") || unit.includes("дней")) return "day";
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
  const value = String(description ?? "");
  const regex = /@Trait\[([^\]|]+)(?:\|[^\]]+)?\]/gi;
  let match = regex.exec(value);
  while (match) {
    const key = normalizeTraitKey(match[1]);
    if (key && validTraits.has(key)) traits.push(key);
    match = regex.exec(value);
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

  const normalized = [];
  for (const trait of candidates) {
    const key = normalizeTraitKey(trait);
    if (key && validTraits.has(key) && !normalized.includes(key)) {
      normalized.push(key);
    }
  }
  return normalized;
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

function shouldApplyForceBarrageTargetDialogBridge() {
  return game.settings.get(MODULE_ID, "forceBarrageTargetDialogBridge");
}

function shouldApplyToolbeltMacroScopeBridge() {
  return (
    game.settings.get(MODULE_ID, "toolbeltMacroScopeBridge") &&
    game.modules.get(TOOLBELT_ID)?.active
  );
}

function shouldApplyToolbeltSpellCastLinkedBypass() {
  return (
    game.settings.get(MODULE_ID, "toolbeltSpellCastLinkedBypass") &&
    game.modules.get(TOOLBELT_ID)?.active
  );
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

function refreshTargetHelperActionRowsFixStyle() {
  const currentStyle = document.getElementById(TOOLBELT_ACTION_ROWS_FIX_STYLE_ID);
  if (currentStyle) {
    currentStyle.remove();
  }

  if (!shouldApplyTargetHelperActionRowsFix()) return;

  const style = document.createElement("style");
  style.id = TOOLBELT_ACTION_ROWS_FIX_STYLE_ID;
  style.textContent = getTargetHelperActionRowsFixCss();
  document.head.append(style);
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
  const currentStyle = document.getElementById(FORCE_BARRAGE_TARGET_DIALOG_STYLE_ID);
  if (currentStyle) {
    currentStyle.remove();
  }

  if (!shouldApplyForceBarrageTargetDialogBridge()) return;

  const style = document.createElement("style");
  style.id = FORCE_BARRAGE_TARGET_DIALOG_STYLE_ID;
  style.textContent = getForceBarrageTargetDialogBridgeCss();
  document.head.append(style);
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

function isLikelyForceBarrageTargetDialog(root, userTargets) {
  if (!(root instanceof HTMLElement)) return false;

  const distributionInputs = Array.from(root.querySelectorAll("input[id$='qd']"));
  if (distributionInputs.length === 0) return false;
  if (!root.querySelector("table")) return false;
  if (root.querySelector("select[id$='qd']")) return false;
  if (root.querySelector("input[type='checkbox'][id$='qd']")) return false;
  if (distributionInputs.some((input) => input.type !== "number")) return false;
  if (distributionInputs.length !== userTargets.length) return false;

  const targetNameSet = new Set(
    userTargets
      .map((target) => String(target?.name ?? target?.document?.name ?? "").trim().toLowerCase())
      .filter(Boolean)
  );

  const labels = Array.from(root.querySelectorAll("table tr th label"));
  const hasTargetFigcaption = labels.some((label) => /target\s*#\d+/i.test(label.textContent ?? ""));
  const hasTargetNameMatch = labels.some((label) => {
    const text = String(label.textContent ?? "").trim().toLowerCase();
    if (!text) return false;
    for (const targetName of targetNameSet) {
      if (targetName && text.includes(targetName)) return true;
    }
    return false;
  });

  return hasTargetFigcaption || hasTargetNameMatch;
}

function enhanceForceBarrageTargetDialog(app, html) {
  if (!shouldApplyForceBarrageTargetDialogBridge()) return;

  const root = getHTMLElement(html);
  if (!root) return;
  if (root.dataset.bridgeForceBarrageDialogPatched === "true") return;

  const userTargets = Array.from(game.user?.targets ?? []);
  if (userTargets.length === 0) return;
  if (!isLikelyForceBarrageTargetDialog(root, userTargets)) return;

  const targetRows = Array.from(root.querySelectorAll("table tr")).filter((row) =>
    row.querySelector("input[type='number'][id$='qd']")
  );
  if (targetRows.length === 0) return;

  root.dataset.bridgeForceBarrageDialogPatched = "true";

  const totalByName = new Map();
  for (const target of userTargets) {
    const name = String(target?.name ?? target?.document?.name ?? "").trim();
    if (!name) continue;
    totalByName.set(name, (totalByName.get(name) ?? 0) + 1);
  }
  const indexByName = new Map();

  for (let rowIndex = 0; rowIndex < targetRows.length; rowIndex += 1) {
    const row = targetRows[rowIndex];
    const label = row.querySelector("th label");
    if (!(label instanceof HTMLElement)) continue;

    const existingId = String(label.querySelector("img[id]")?.id ?? "").trim();
    const target = existingId
      ? getCanvasTokenById(existingId)
      : userTargets[rowIndex] ?? null;
    if (!target) continue;

    const token = getCanvasTokenById(target.id) ?? target;
    const tokenId = String(token?.id ?? target?.id ?? "").trim();
    if (!tokenId) continue;

    const baseName = String(token?.name ?? target?.name ?? target?.document?.name ?? `Target ${rowIndex + 1}`).trim();
    const fallbackName = baseName || `Target ${rowIndex + 1}`;
    const seen = (indexByName.get(fallbackName) ?? 0) + 1;
    indexByName.set(fallbackName, seen);
    const total = totalByName.get(fallbackName) ?? 1;
    const numbered = total > 1 ? `${fallbackName} #${seen}` : fallbackName;
    const gridPosition = formatTokenGridPositionLabel(token);
    const displayName = gridPosition ? `${numbered} (${gridPosition})` : numbered;
    const tokenImage = String(token?.document?.texture?.src ?? token?.texture?.src ?? "").trim();

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

    label.replaceChildren(content);
    label.classList.add("bridge-force-barrage-target-label-host");
    label.title = displayName;

    if (label.dataset.bridgeTokenHoverBound !== "true") {
      label.dataset.bridgeTokenHoverBound = "true";
      label.addEventListener("mouseenter", () => {
        setDialogTokenHover(tokenId, true);
      });
      label.addEventListener("mouseleave", () => {
        setDialogTokenHover(tokenId, false);
      });
      label.addEventListener("click", (event) => {
        event.preventDefault();
        focusDialogToken(tokenId);
      });
    }
  }
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
  macroExecutionFallbackScope = scope;
  macroExecutionFallbackScopeUntil = Date.now() + ASYNC_SCOPE_FALLBACK_TTL_MS;
}

function takeMacroExecutionFallbackScope() {
  if (!macroExecutionFallbackScope) return null;
  if (Date.now() > macroExecutionFallbackScopeUntil) {
    macroExecutionFallbackScope = null;
    macroExecutionFallbackScopeUntil = 0;
    return null;
  }
  const scope = macroExecutionFallbackScope;
  macroExecutionFallbackScope = null;
  macroExecutionFallbackScopeUntil = 0;
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
  for (const path of TOOLBELT_LINKED_MACRO_FLAG_PATHS) {
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

function registerLinkedMacroSuppressionForSpell(spell, uses = TOOLBELT_LINKED_SUPPRESSION_USES, scopeRef = null) {
  if (!spell || uses <= 0) return;
  cleanupLinkedMacroSuppressions();
  const expiresAt = Date.now() + TOOLBELT_LINKED_SUPPRESSION_TTL_MS;
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

  if (
    isToolbeltCastScope(macroExecutionFallbackScope) &&
    Date.now() <= macroExecutionFallbackScopeUntil &&
    isSameSpellReference(spell, macroExecutionFallbackScope.spell)
  ) {
    return macroExecutionFallbackScope;
  }

  return null;
}

function installToolbeltActionableGetItemMacroSuppressionPatch() {
  if (toolbeltGetItemMacroSuppressionPatched) return true;

  const actionableGetItemMacro = game?.toolbelt?.dev?.tools?.actionable?.getItemMacro;
  if (typeof actionableGetItemMacro !== "function") return false;

  const libWrapperRegistered = registerBridgeLibWrapper(
    TOOLBELT_ACTIONABLE_GET_ITEM_MACRO_PATH,
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
  bridgeDebug("installed getItemMacro suppression wrapper", { target: TOOLBELT_ACTIONABLE_GET_ITEM_MACRO_PATH });
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
    if (toolbeltGetItemMacroSuppressionPatchRetries >= TOOLBELT_ACTIONABLE_PATCH_MAX_RETRIES) {
      window.clearInterval(toolbeltGetItemMacroSuppressionPatchIntervalId);
      toolbeltGetItemMacroSuppressionPatchIntervalId = null;
      console.warn(`[${MODULE_ID}] Failed to patch Toolbelt actionable.getItemMacro after retries`);
    }
  }, TOOLBELT_ACTIONABLE_PATCH_RETRY_MS);
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
    globalThis.libWrapper.register(MODULE_ID, target, wrapper, type);
    return true;
  } catch (error) {
    console.warn(`[${MODULE_ID}] Failed to register libWrapper for ${target}`, error);
    return false;
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
      registerLinkedMacroSuppressionForSpell(trackedScope.spell, TOOLBELT_LINKED_SUPPRESSION_USES, trackedScope);
    }
  }

  macroExecutionScopeStack.push(trackedScope);
  try {
    if (!canBridgeFirstArg) {
      return await wrapped(...args);
    }

    if (hasIncomingScopeArg) {
      if (!trackedScope) return await wrapped(...args);
      return await wrapped(trackedScope, ...args.slice(1));
    }

    if (!trackedScope) return await wrapped(...args);
    return await wrapped(trackedScope);
  } finally {
    macroExecutionScopeStack.pop();
  }
}

async function runSpellCastLinkedBypass(entry, wrapped, spell, options = {}) {
  const spellDoc = resolveSpellDocumentForCast(entry, spell);
  const castSpell = spellDoc ?? spell;

  if (!shouldApplyToolbeltSpellCastLinkedBypass()) {
    return await wrapped(castSpell, options);
  }

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

  const libWrapperRegistered = registerBridgeLibWrapper(
    "Macro.prototype.execute",
    async function macroExecuteScopeBridgeWrapped(wrapped, ...args) {
      return runMacroExecuteScopeBridge(this, (...wrappedArgs) => wrapped(...wrappedArgs), args);
    },
    "MIXED"
  );

  if (!libWrapperRegistered) {
    bridgeDebug("macro scope bridge using fallback patch");
    const originalExecute = macroProto.execute;
    macroProto.execute = async function macroExecuteScopeBridgeFallback(...args) {
      return runMacroExecuteScopeBridge(this, (...wrappedArgs) => originalExecute.apply(this, wrappedArgs), args);
    };
  } else {
    bridgeDebug("macro scope bridge using libWrapper");
  }

  macroExecuteScopeBridgePatched = true;
}

function installToolbeltSpellCastLinkedBypass() {
  if (spellCastLinkedMacroBypassPatched) return;

  const spellcastingProto = CONFIG?.PF2E?.Item?.documentClasses?.spellcastingEntry?.prototype;
  if (!spellcastingProto || typeof spellcastingProto.cast !== "function") return;

  const libWrapperRegistered = registerBridgeLibWrapper(
    "CONFIG.PF2E.Item.documentClasses.spellcastingEntry.prototype.cast",
    async function spellCastLinkedBypassWrapped(wrapped, spell, options = {}) {
      return runSpellCastLinkedBypass(this, (wrappedSpell, wrappedOptions) => wrapped(wrappedSpell, wrappedOptions), spell, options);
    },
    "MIXED"
  );

  if (!libWrapperRegistered) {
    bridgeDebug("spell cast bypass using fallback patch");
    const originalCast = spellcastingProto.cast;
    spellcastingProto.cast = async function spellCastLinkedBypassFallback(spell, options = {}) {
      return runSpellCastLinkedBypass(this, (wrappedSpell, wrappedOptions) => originalCast.call(this, wrappedSpell, wrappedOptions), spell, options);
    };
  } else {
    bridgeDebug("spell cast bypass using libWrapper");
  }

  spellCastLinkedMacroBypassPatched = true;
}

function formatEffectAppliedMessage(html) {
  const root = getHTMLElement(html);
  if (!root) return;

  const appliedNodes = root.querySelectorAll(".effect-applied");
  for (const node of appliedNodes) {
    const link = node.querySelector("a");
    if (!(link instanceof HTMLElement)) continue;

    const existingBreaks = [];
    let cursor = link.previousSibling;
    while (cursor instanceof HTMLBRElement && cursor.dataset.bridgeEffectAppliedBreak === "true") {
      existingBreaks.push(cursor);
      cursor = cursor.previousSibling;
    }

    for (const br of existingBreaks) {
      br.remove();
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
  const source = String(description ?? "");
  const regex = /@\s*UUID\[(Compendium\.[^\]]+)\](?:\{([^}]*)\})?/gi;
  const uniqueCandidates = new Map();

  let match = regex.exec(source);
  while (match) {
    const uuid = String(match[1] ?? "").trim();
    const name = String(match[2] ?? "").trim();
    if (isSafeSelfEffectUuid(uuid) && !uniqueCandidates.has(uuid)) {
      uniqueCandidates.set(uuid, {
        uuid,
        name: name || null
      });
    }
    match = regex.exec(source);
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
  game.settings.register(MODULE_ID, "proxyToGM", {
    name: "Proxy To Active GM",
    hint: "If enabled, non-GM clients send roll events to the active GM for automation.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "autoScrollTargets", {
    name: "Auto-Scroll Target Helper",
    hint: "When chat is already at the bottom, keep it pinned when Target Helper expands a message.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "debugBridge", {
    name: "Bridge Debug Logging",
    hint: "Client-side debug logging for bridge patches (scope inheritance, suppression, and linked-cast bypass decisions).",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "itemActivationsRuFix", {
    name: "PF2e Item Activations RU Fix",
    hint: "Optional compatibility patch: fix generated action type and frequency for Russian activation text.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "itemActivationsAutoSelfEffect", {
    name: "PF2e Item Activations Auto-Link Self Effect",
    hint: "Optional compatibility patch: link selfEffect from description only when one safe effect UUID is found.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "targetHelperActionRowsFix", {
    name: "Applied Label Layout Fix",
    hint: "Optional compatibility patch: keep Applied/effect-applied labels readable instead of vertical text.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      refreshTargetHelperActionRowsFixStyle();
    }
  });
  game.settings.register(MODULE_ID, "forceBarrageTargetDialogBridge", {
    name: "Force Barrage Target Dialog Enhancer",
    hint: "Optional UI patch: in Force Barrage target distribution dialogs, show token portrait, duplicate-name numbering, and hover-highlight/click-focus helpers.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      refreshForceBarrageTargetDialogBridgeStyle();
    }
  });
  game.settings.register(MODULE_ID, "toolbeltMacroScopeBridge", {
    name: "Toolbelt Nested Macro Scope Bridge",
    hint: "Optional compatibility patch: nested script macros inherit Toolbelt spell scope (cast/options), including async compendium-link wrappers, so linked casts keep slot/charge behavior.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "toolbeltSpellCastLinkedBypass", {
    name: "Toolbelt Spell Cast Linked-Macro Bypass",
    hint: "Optional compatibility patch: when a linked spell macro internally casts, bypass one recursive linked-macro pass and suppress one actionable linked lookup to prevent duplicate dialogs and preserve slot/charge consumption.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.once("ready", () => {
  installItemActivationsCreatePatch();
  refreshTargetHelperActionRowsFixStyle();
  refreshForceBarrageTargetDialogBridgeStyle();
  installMacroExecuteScopeBridge();
  installToolbeltSpellCastLinkedBypass();
  scheduleToolbeltActionableGetItemMacroSuppressionPatch();

  Hooks.on("renderDialog", (app, html) => {
    try {
      enhanceForceBarrageTargetDialog(app, html);
    } catch (error) {
      console.warn(`[${MODULE_ID}] Failed to enhance Force Barrage target dialog`, error);
    }
  });

  Hooks.on("createItem", async (item, _options, userId) => {
    try {
      await applyItemActivationsRussianFix(item, userId);
    } catch (error) {
      console.warn(`[${MODULE_ID}] Failed to apply Item Activations RU fix`, error);
    }
  });

  if (!game.modules.get(TOOLBELT_ID)?.active) return;
  if (!game.modules.get(AUTOMATION_ID)?.active) return;

  attachChatScrollListener();

  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (shouldApplyTargetHelperActionRowsFix()) {
      formatEffectAppliedMessage(html);
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

    if (game.user.isActiveGM || !proxy || !activeGM) {
      processAutomation(rollMessage);
    }
  });
});
