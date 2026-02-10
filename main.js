const MODULE_ID = "pf2e-toolbelt-automation-bridge";
const TOOLBELT_ID = "pf2e-toolbelt";
const AUTOMATION_ID = "patreon-v3";
const SOCKET = `module.${MODULE_ID}`;
const CHAT_BOTTOM_EPSILON = 8;

let chatScrollElement = null;
let chatAtBottom = false;

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
