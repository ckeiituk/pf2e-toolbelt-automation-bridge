const MODULE_ID = "pf2e-toolbelt-automation-bridge";
const TOOLBELT_ID = "pf2e-toolbelt";
const AUTOMATION_ID = "patreon-v3";
const ITEM_ACTIVATIONS_ID = "pf2e-item-activations";
const SOCKET = `module.${MODULE_ID}`;
const CHAT_BOTTOM_EPSILON = 8;

let chatScrollElement = null;
let chatAtBottom = false;

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

async function applyItemActivationsRussianFix(item, userId) {
  if (!game.settings.get(MODULE_ID, "itemActivationsRuFix")) return;
  if (!game.modules.get(ITEM_ACTIVATIONS_ID)?.active) return;
  if (!isItemActivationsGeneratedAction(item)) return;
  if (userId !== game.user.id) return;

  const description = item.system?.description?.value ?? "";
  const updates = {};

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
  game.settings.register(MODULE_ID, "itemActivationsRuFix", {
    name: "PF2e Item Activations RU Fix",
    hint: "Optional compatibility patch: fix generated action type and frequency for Russian activation text.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
});

Hooks.once("ready", () => {
  if (!game.modules.get(TOOLBELT_ID)?.active) return;
  if (!game.modules.get(AUTOMATION_ID)?.active) return;

  attachChatScrollListener();

  Hooks.on("renderChatMessageHTML", (message, html) => {
    attachChatScrollListener();
    if (!game.settings.get(MODULE_ID, "autoScrollTargets")) return;
    if (!chatAtBottom) return;
    if (!hasTargetHelperUI(html)) return;
    requestAnimationFrame(() => {
      scrollChatToBottom();
      updateChatBottomState();
    });
  });

  Hooks.on("createItem", async (item, _options, userId) => {
    try {
      await applyItemActivationsRussianFix(item, userId);
    } catch (error) {
      console.warn(`[${MODULE_ID}] Failed to apply Item Activations RU fix`, error);
    }
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
