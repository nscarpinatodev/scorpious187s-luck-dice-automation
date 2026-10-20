// A minimal fake Foundry / dnd5e environment for testing the native-mode modules in
// Node. Import it before any module under scripts/native/ — those read window.LDA
// (core.js's API) when they load. Only what the modules touch is faked, and tests
// reshape it per case through the exported `env`.

const MODULE_ID = "scorpious187s-luck-dice-automation";

/** Settings the LDA getters read; tests change them freely. */
export const settings = {
  attackAutomation: "off", saveAutomation: "off", privateRollOutcome: "private",
  effectAutomation: false, healingAutomation: false, damageOnlyAutomation: false,
  concentrationBreak: false, concentrationAutoRoll: false, onHitRiders: false, lingeringAreas: false, repeatSaves: false, reactionPrompts: "off", skipAttackDialog: false, attackAdvantage: false, rayAutomation: false, targetConfirmation: "off",
  luckDice: true, inspiration: false,
  dnd5e: { disableConcentration: false, allowPlayerDamageTray: false }
};

// ── Hooks ────────────────────────────────────────────────────────────────────
const hookTable = new Map();
let hookSeq = 0;
export const hooks = {
  on(name, fn) { const id = ++hookSeq; if (!hookTable.has(name)) hookTable.set(name, new Map()); hookTable.get(name).set(id, fn); return id; },
  once(name, fn) { const id = hooks.on(name, (...a) => { hooks.off(name, id); return fn(...a); }); return id; },
  off(name, id) { hookTable.get(name)?.delete(typeof id === "number" ? id : [...hookTable.get(name).entries()].find(([, f]) => f === id)?.[0]); },
  call(name, ...args) { for (const fn of [...(hookTable.get(name)?.values() ?? [])]) if (fn(...args) === false) return false; return true; },
  callAll(name, ...args) { for (const fn of [...(hookTable.get(name)?.values() ?? [])]) fn(...args); return true; },
  count: (name) => hookTable.get(name)?.size ?? 0,
  handlers: (name) => [...(hookTable.get(name)?.values() ?? [])],
  reset: () => hookTable.clear()
};

// ── Documents by uuid ────────────────────────────────────────────────────────
export const uuids = new Map();

// ── Canvas targeting ─────────────────────────────────────────────────────────
export const scene = { id: "scene1", tokens: Object.assign([], { get(id) { return this.find(t => t.id === id); } }) };
/** A token placeable with its document, on the fake scene. */
export function makeToken(id, name, { actor = null, disposition = -1, hidden = false } = {}) {
  const document = {
    id, name, uuid: `Scene.${scene.id}.Token.${id}`, parent: scene, disposition, hidden,
    texture: { src: `${id}.webp` },
    actor: actor ?? { uuid: `Actor.${id}`, name, statuses: new Set() },
    testInsideRegion: (region) => region.inside?.includes(id) ?? false
  };
  const token = { id, name, document };
  document.object = token;
  scene.tokens.push(document);
  uuids.set(document.uuid, document);
  return token;
}
const tokenById = (id) => scene.tokens.find(t => t.id === id)?.object;
export const targetLog = [];

// ── Dialogs: each DialogV2.wait runs the next scripted handler ───────────────
export const dialogs = [];
/** A fake select element: parses its option markup, keeps a value. */
function makeSelect(name) {
  const select = { name, value: "", options: [], matches: (q) => q.includes(name.replace(/-\d+$/, "")) };
  Object.defineProperty(select, "innerHTML", {
    set(html) {
      select.options = [...html.matchAll(/value="([^"]*)"( selected)?/g)].map(m => ({ value: m[1], selected: !!m[2] }));
      select.value = (select.options.find(o => o.selected) ?? select.options[0] ?? { value: "" }).value;
    }
  });
  return select;
}
class FakeDialogV2 {
  static async wait(config) {
    const handler = dialogs.shift();
    if (!handler) throw new Error(`unexpected dialog: ${config.window?.title}`);
    const selects = [...config.content.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)].map(([, name, inner]) => {
      const s = makeSelect(name); s.innerHTML = inner; return s;
    });
    const checkboxes = [...config.content.matchAll(/<input type="checkbox" name="([^"]+)" value="([^"]*)"( checked)?/g)]
      .map(([, name, value, checked]) => ({ name, value, checked: !!checked }));
    const named = (q) => selects.filter(s => q.includes(`name^="${s.name.replace(/-\d+$/, "-")}"`) || q.includes(`name="${s.name}"`));
    const buttons = Object.fromEntries((config.buttons ?? []).map(b => [b.action, { disabled: !!b.disabled }]));
    const nodes = { ".lda-hits-left": { textContent: "" }, ".lda-confirm-list": { innerHTML: "" } };
    const listeners = {};
    const root = {
      querySelectorAll: (q) => named(q),
      querySelector: (q) => {
        const action = q.match(/data-action="([^"]+)"/)?.[1];
        if (action) return buttons[action] ?? null;
        if (q.startsWith("select")) return named(q)[0] ?? null;
        return config.content.includes(q.slice(1)) ? nodes[q] ?? null : null;
      },
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); }
    };
    config.render?.({}, { element: root });
    const ui = {
      config, selects, buttons, nodes,
      select: (name) => selects.find(s => s.name === name),
      checkboxes,
      check(value, checked = true) { checkboxes.find(c => c.value === String(value)).checked = checked; },
      change(name, value) {
        const s = ui.select(name); s.value = String(value);
        (listeners.change ?? []).forEach(fn => fn({ target: s }));
      },
      click(target) { (listeners.click ?? []).forEach(fn => fn({ preventDefault() {}, target })); }
    };
    const outcome = await handler(ui);
    if (outcome === "close" || outcome === undefined) { config.close?.(); return null; }
    const button = (config.buttons ?? []).find(b => b.action === outcome);
    if (!button) throw new Error(`no button ${outcome}`);
    const form = {
      elements: Object.fromEntries(selects.map(s => [s.name, s])),
      querySelectorAll: (q) => {
        const name = q.match(/name="([^"]+)"/)?.[1];
        return checkboxes.filter(c => c.name === name && (!q.includes(":checked") || c.checked));
      }
    };
    return (await button.callback?.({}, { form }, null)) ?? button.action;
  }
}

// ── Rolls ────────────────────────────────────────────────────────────────────
class BasicRoll {
  constructor(formula = "", data = {}, options = {}) { this.formula = formula; this.data = data; this.options = options; this.total = options.total ?? 0; }
  async evaluate() { return this; }
}
class DamageRoll extends BasicRoll {}
class D20Roll extends BasicRoll {}
/** A damage roll with a fixed total. */
export const damageRoll = (total, options = {}) => new DamageRoll("", {}, { type: "force", total, ...options });

// ── Notifications, chat ──────────────────────────────────────────────────────
export const notes = [];
export const messages = new Map();

// ── The LDA API core.js publishes ────────────────────────────────────────────
/** core.js's prompts, replaceable per test (modules copy LDA's functions when they load). */
export const prompts = { choice: async () => null, slider: async () => 0 };
const noop = () => {};
const LDA = {
  MODULE_ID, LUCK_DICE_ITEM_NAME: "Luck Dice", IMPACT_DICE_ITEM_NAME: "Impact Dice", HISTORY_FLAG: "luckHistory",
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  debug: noop,
  // Dice pools as core.js keeps them: an item's uses, available = max - spent.
  getDiceItem: (actor, name) => actor?.items?.find(i => i.name === name),
  getDiceUses: (actor, name) => {
    const item = actor?.items?.find(i => i.name === name);
    return item ? Math.max(0, Number(item.system.uses.max) - Number(item.system.uses.spent)) : 0;
  },
  updateDiceUses: async (actor, name, delta) => {
    const item = actor?.items?.find(i => i.name === name);
    if (!item) return false;
    const max = Number(item.system.uses.max), available = Math.max(0, max - Number(item.system.uses.spent));
    const next = Math.min(max, Math.max(0, available + delta));
    if (next === available) return false;
    item.system.uses.spent = max - next;
    return true;
  },
  actorHasLuckDice: () => false, actorHasInspiration: () => false,
  promptChoice: (...args) => prompts.choice(...args), promptSlider: (...args) => prompts.slider(...args), getKeptD20Result: (r) => r?.d20 ?? null,
  spendDiceFromPools: async () => 0, buildDiceAvailableHTML: () => "", combineRolls: (a) => a, diceFaces: () => [],
  renderLuckSection: () => ({}), requestRollActors: new Set(),
  isLuckDiceEnabled: () => settings.luckDice, isInspirationEnabled: () => settings.inspiration,
  getAttackAutomation: () => settings.attackAutomation, getSaveAutomation: () => settings.saveAutomation,
  getPrivateRollOutcome: () => settings.privateRollOutcome,
  isEffectAutomationEnabled: () => settings.effectAutomation, isHealingAutomationEnabled: () => settings.healingAutomation,
  isDamageOnlyAutomationEnabled: () => settings.damageOnlyAutomation, isConcentrationBreakEnabled: () => settings.concentrationBreak, isConcentrationAutoRollEnabled: () => settings.concentrationAutoRoll, isOnHitRidersEnabled: () => settings.onHitRiders, isLingeringAreasEnabled: () => settings.lingeringAreas, isRepeatSavesEnabled: () => settings.repeatSaves, getReactionPrompts: () => settings.reactionPrompts, isSkipAttackDialogEnabled: () => settings.skipAttackDialog, isAttackAdvantageEnabled: () => settings.attackAdvantage,
  isRayAutomationEnabled: () => settings.rayAutomation, getTargetConfirmation: () => settings.targetConfirmation,
  readCardHistory: () => ({ entries: [] }), updateRollCard: async () => {}, recordCardStep: async () => {},
  finishCardHistory: async () => {}, cardReporter: () => noop,
  promptNatOne: async () => {}, promptLuckOnMiss: async () => {}, promptNatOneSave: async () => {}, promptLuckOnCheckFail: async () => {}
};

// ── Globals ──────────────────────────────────────────────────────────────────
const user = { id: "gm1", name: "GM", isGM: true, active: true, targets: new Set() };
Object.assign(globalThis, {
  window: globalThis,
  LDA,
  Hooks: hooks,
  fromUuid: async (uuid) => uuids.get(uuid) ?? null,
  fromUuidSync: (uuid) => uuids.get(uuid) ?? null,
  foundry: {
    utils: {
      deepClone: (o) => o === undefined ? o : structuredClone(o),
      setProperty: (object, key, value) => {
        const parts = key.split("."); let target = object;
        for (const p of parts.slice(0, -1)) target = (target[p] ??= {});
        target[parts.at(-1)] = value; return true;
      },
      escapeHTML: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      randomID: () => Math.random().toString(36).slice(2, 18)
    },
    applications: {
      api: {
        DialogV2: FakeDialogV2,
        ApplicationV2: class {
          constructor(options = {}) { this.options = { ...this.constructor.DEFAULT_OPTIONS, ...options }; this.rendered = false; }
          async render() { this.rendered = true; return this; }
          async close() { this.rendered = false; }
        }
      },
      instances: new Map()
    }
  },
  game: {
    user, users: [user], messages,
    actors: Object.assign([], { get(id) { return this.find(a => a.id === id); } }),
    modules: new Map(),
    settings: { get: (scope, key) => scope === "dnd5e" ? settings.dnd5e[key] : settings[key] },
    i18n: { localize: (k) => ({ "DND5E.AttackRoll": "Attack Roll" })[k] ?? k },
    dice3d: null
  },
  canvas: {
    ready: true, scene,
    tokens: {
      setTargets(ids, { mode = "replace" } = {}) {
        targetLog.push([mode, ids.join(",")]);
        if (mode === "replace") user.targets = new Set(ids.map(tokenById).filter(Boolean));
        else if (mode === "acquire") ids.forEach(i => user.targets.add(tokenById(i)));
        else if (mode === "release") ids.forEach(i => user.targets.delete(tokenById(i)));
        hooks.callAll("targetToken", user, null, mode !== "release");
      }
    }
  },
  CONFIG: {
    Dice: { BasicRoll, DamageRoll, D20Roll },
    DND5E: { healingTypes: { healing: {}, temphp: {} }, abilities: { dex: { label: "Dexterity" } } }
  },
  ui: { notifications: { info: (m) => notes.push(m), warn: (m) => notes.push(m), error: (m) => notes.push(m) } },
  ChatMessage: { getSpeaker: () => ({}), implementation: { create: async (d) => d } },
  dnd5e: { dice: { aggregateDamageRolls: (rolls) => rolls } },
  document: {
    createElement: () => {
      const wrapper = { set innerHTML(html) { wrapper.firstElementChild = { html, querySelectorAll: () => [], querySelector: () => null }; } };
      return wrapper;
    }
  }
});

/** Reset the per-test state (targets, dialogs, notices, uuids, scene tokens). */
export function reset() {
  user.isGM = true;
  user.targets = new Set();
  dialogs.length = 0;
  prompts.choice = async () => null;
  prompts.slider = async () => 0;
  notes.length = 0;
  targetLog.length = 0;
  uuids.clear();
  messages.clear();
  scene.tokens.length = 0;
  game.actors.length = 0;
  Object.assign(settings, {
    attackAutomation: "off", saveAutomation: "off", privateRollOutcome: "private",
    effectAutomation: false, healingAutomation: false, damageOnlyAutomation: false,
    concentrationBreak: false, concentrationAutoRoll: false, onHitRiders: false, lingeringAreas: false, repeatSaves: false, reactionPrompts: "off", skipAttackDialog: false, attackAdvantage: false, rayAutomation: false, targetConfirmation: "off"
  });
  settings.dnd5e.disableConcentration = false;
}

/** Let pending promise callbacks and timers run. */
export const flush = (ms = 0) => new Promise(r => setTimeout(r, ms));

export const env = { prompts, settings, hooks, uuids, scene, makeToken, targetLog, dialogs, notes, messages, damageRoll, reset, flush, user };
