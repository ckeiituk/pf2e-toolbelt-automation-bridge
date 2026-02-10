const MODULE_ID = "pf2e-toolbelt-automation-bridge";
const TOOLBELT_ID = "pf2e-toolbelt";
const AUTOMATION_ID = "patreon-v3";
const SOCKET = `module.${MODULE_ID}`;

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
});

Hooks.once("ready", () => {
  if (!game.modules.get(TOOLBELT_ID)?.active) return;
  if (!game.modules.get(AUTOMATION_ID)?.active) return;

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
