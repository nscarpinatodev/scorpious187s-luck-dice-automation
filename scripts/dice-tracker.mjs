// ── Scorpious187's Luck Dice Automation — Luck Dice Tracker ──────────────────
// A GM window with every player character's Luck Dice and Impact Dice: adjust a
// pool by one, start a session (top Luck Dice up to 3, as the session-reset
// macro does — banked dice above 3 are kept), or give everyone a Luck Die. It
// follows changes made anywhere (a die spent on a roll, a sheet edit) while open.
// Works with or without Midi-QoL. Opened from the token controls, the module
// settings, or game.modules.get("scorpious187s-luck-dice-automation").api.openDiceTracker().
// Depends on: core.js (window.LDA), loaded first as a classic script.

const LDA = window.LDA;
const { MODULE_ID, LUCK_DICE_ITEM_NAME, IMPACT_DICE_ITEM_NAME, getDiceItem, getDiceUses, updateDiceUses } = LDA;

/** Luck Dice each character starts a session with (the session-reset macro's target). */
export const SESSION_LUCK_DICE = 3;
const POOLS = { luck: LUCK_DICE_ITEM_NAME, impact: IMPACT_DICE_ITEM_NAME };
const escapeHTML = (s) => (foundry.utils.escapeHTML ?? String)(String(s ?? ""));

/** Player-owned characters, by name. */
export function trackedActors() {
  return game.actors.filter(a => a.type === "character" && a.hasPlayerOwner)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One pool on one actor: { has, value, max }. */
export function poolState(actor, pool) {
  const item = getDiceItem(actor, POOLS[pool]);
  if (!item) return { has: false, value: 0, max: 0 };
  return { has: true, value: getDiceUses(actor, POOLS[pool]), max: Number(item.system?.uses?.max ?? 0) || 0 };
}

/**
 * Start a session: every tracked character with fewer than SESSION_LUCK_DICE Luck
 * Dice is topped up to it (never above its max); more than that is kept.
 * Resolves with [{ name, from, to }] for those changed.
 */
export async function startSession(actors = trackedActors()) {
  const changed = [];
  for (const actor of actors) {
    const { has, value, max } = poolState(actor, "luck");
    const target = Math.min(SESSION_LUCK_DICE, max);
    if (!has || value >= target) continue;
    if (await updateDiceUses(actor, LUCK_DICE_ITEM_NAME, target - value)) changed.push({ name: actor.name, from: value, to: target });
  }
  return changed;
}

/** Give every tracked character one Luck Die (up to its max). Resolves with the names given one. */
export async function awardLuckDie(actors = trackedActors()) {
  const given = [];
  for (const actor of actors) {
    if (await updateDiceUses(actor, LUCK_DICE_ITEM_NAME, 1)) given.push(actor.name);
  }
  return given;
}

const ApplicationV2 = foundry.applications.api.ApplicationV2;

export class DiceTracker extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "lda-dice-tracker",
    classes: ["lda-dice-tracker"],
    tag: "section",
    window: { title: "Luck Dice Tracker", icon: "fa-solid fa-dice-d6", resizable: true },
    position: { width: 440, height: "auto" },
    actions: {
      adjust:       DiceTracker.#onAdjust,
      startSession: DiceTracker.#onStartSession,
      award:        DiceTracker.#onAward
    }
  };

  /** Open the tracker, or bring it to the front. GM only. */
  static open() {
    if (!game.user.isGM) return null;
    const existing = foundry.applications.instances?.get(DiceTracker.DEFAULT_OPTIONS.id);
    if (existing) { existing.bringToFront?.(); return existing.render({ force: true }); }
    return new DiceTracker().render({ force: true });
  }

  /** @override */
  async _prepareContext() {
    return {
      rows: trackedActors().map(actor => ({
        actor,
        owners: game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")),
        luck:   poolState(actor, "luck"),
        impact: poolState(actor, "impact")
      }))
    };
  }

  /** @override */
  async _renderHTML(context) {
    const pool = (row, key) => {
      const p = row[key];
      if (!p.has) return `<td class="lda-pool" style="opacity:0.5;text-align:center" data-tooltip="No ${escapeHTML(POOLS[key])} item">—</td>`;
      const button = (delta, icon, disabled, label) => `<button type="button" data-action="adjust" data-actor="${row.actor.id}"
        data-pool="${key}" data-delta="${delta}" ${disabled ? "disabled" : ""} aria-label="${label}"
        style="flex:0 0 auto;width:22px;height:22px;padding:0;line-height:1"><i class="fa-solid ${icon}" inert></i></button>`;
      return `<td class="lda-pool"><div style="display:flex;align-items:center;justify-content:center;gap:6px">
        ${button(-1, "fa-minus", p.value <= 0, `Remove a ${escapeHTML(POOLS[key])} from ${escapeHTML(row.actor.name)}`)}
        <strong style="min-width:3.2em;text-align:center">${p.value} / ${p.max}</strong>
        ${button(1, "fa-plus", p.value >= p.max, `Give ${escapeHTML(row.actor.name)} a ${escapeHTML(POOLS[key])}`)}
      </div></td>`;
    };
    const owner = (u) => `<span style="white-space:nowrap" data-tooltip="${u.active ? "Online" : "Offline"}">
      <i class="fa-solid fa-circle" style="font-size:0.55em;vertical-align:middle;color:${u.active ? "#3c9a3c" : "#888"}" inert></i> ${escapeHTML(u.name)}</span>`;
    const rows = context.rows.map(row => `
      <tr>
        <td><div style="display:flex;align-items:center;gap:8px">
          <img src="${escapeHTML(row.actor.img)}" alt="" style="width:32px;height:32px;border:none;object-fit:cover;border-radius:4px">
          <div style="min-width:0"><div style="font-weight:bold">${escapeHTML(row.actor.name)}</div>
            <div style="font-size:0.85em;opacity:0.8">${row.owners.map(owner).join(", ") || "No player"}</div></div>
        </div></td>
        ${pool(row, "luck")}${pool(row, "impact")}
      </tr>`).join("");

    const element = document.createElement("div");
    element.innerHTML = context.rows.length ? `
      <table style="width:100%;border-collapse:collapse;margin:0">
        <thead><tr><th style="text-align:left">Character</th><th>${escapeHTML(LUCK_DICE_ITEM_NAME)}</th><th>${escapeHTML(IMPACT_DICE_ITEM_NAME)}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <footer style="display:flex;gap:6px;margin-top:8px">
        <button type="button" data-action="startSession" data-tooltip="Top every character up to ${SESSION_LUCK_DICE} ${escapeHTML(LUCK_DICE_ITEM_NAME)}; banked dice above that are kept.">
          <i class="fa-solid fa-sun" inert></i> Start Session</button>
        <button type="button" data-action="award" data-tooltip="Give every character one ${escapeHTML(LUCK_DICE_ITEM_NAME.replace(/s$/, ""))}, up to their max.">
          <i class="fa-solid fa-gift" inert></i> +1 ${escapeHTML(LUCK_DICE_ITEM_NAME.replace(/s$/, ""))} to All</button>
      </footer>`
      : `<p style="margin:8px 0">No player-owned characters yet.</p>`;
    return element;
  }

  /** @override */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  /** @override */
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    // Follow pool changes made anywhere, and players coming and going.
    const refresh = foundry.utils.debounce?.(() => { if (this.rendered) this.render(); }, 100) ?? (() => { if (this.rendered) this.render(); });
    const onItem = (item) => { if (Object.values(POOLS).includes(item?.name) && item.parent?.type === "character") refresh(); };
    this._ldaHooks = [
      ["updateItem", Hooks.on("updateItem", onItem)],
      ["createItem", Hooks.on("createItem", onItem)],
      ["deleteItem", Hooks.on("deleteItem", onItem)],
      ["updateActor", Hooks.on("updateActor", (actor) => { if (actor.type === "character") refresh(); })],
      ["userConnected", Hooks.on("userConnected", refresh)]
    ];
  }

  /** @override */
  _onClose(options) {
    super._onClose?.(options);
    for (const [name, id] of this._ldaHooks ?? []) Hooks.off(name, id);
    this._ldaHooks = null;
  }

  static async #onAdjust(_event, target) {
    const actor = game.actors.get(target.dataset.actor);
    const name  = POOLS[target.dataset.pool];
    if (!actor || !name) return;
    target.disabled = true;
    await updateDiceUses(actor, name, Number(target.dataset.delta) || 0);
    this.render();
  }

  static async #onStartSession(_event, target) {
    target.disabled = true;
    const changed = await startSession();
    ui.notifications?.info(changed.length
      ? `Luck Dice Automation: session started — ${changed.map(c => `${c.name} ${c.from} → ${c.to}`).join(", ")}.`
      : `Luck Dice Automation: session started — everyone already has ${SESSION_LUCK_DICE} or more ${LUCK_DICE_ITEM_NAME}.`);
    this.render();
  }

  static async #onAward(_event, target) {
    target.disabled = true;
    const given = await awardLuckDie();
    ui.notifications?.info(given.length
      ? `Luck Dice Automation: +1 ${LUCK_DICE_ITEM_NAME.replace(/s$/, "")} for ${given.join(", ")}.`
      : `Luck Dice Automation: everyone is already at their max ${LUCK_DICE_ITEM_NAME}.`);
    this.render();
  }
}

// ── Opening it ────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, "diceTracker", {
    name: "Luck Dice Tracker",
    label: "Open Tracker",
    hint: "Every player character's Luck Dice and Impact Dice, with buttons to adjust them, start a session, or give everyone a Luck Die. Also in the token controls.",
    icon: "fa-solid fa-dice-d6",
    type: DiceTracker,
    restricted: true
  });
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = Object.assign(module.api ?? {}, { openDiceTracker: () => DiceTracker.open() });

  // GM-only; no default key — assigned in Configure Controls, like the check launcher's.
  game.keybindings.register(MODULE_ID, "toggleDiceTracker", {
    name: "Open / Close Luck Dice Tracker",
    hint: "Opens the Luck Dice Tracker, or closes it if it's open (the same as its button in the token controls).",
    editable: [],
    restricted: true,
    onDown: () => { toggleDiceTracker(); return true; }
  });
});

/** Open the tracker, or close it if it's already open. */
function toggleDiceTracker() {
  const existing = foundry.applications.instances?.get(DiceTracker.DEFAULT_OPTIONS.id);
  if (existing) existing.close();
  else DiceTracker.open();
}

Hooks.on("getSceneControlButtons", (controls) => {
  const tools = controls?.tokens?.tools;
  if (!tools || !game.user?.isGM) return;
  tools.ldaDiceTracker = {
    name: "ldaDiceTracker",
    title: "Luck Dice Tracker",
    icon: "fa-solid fa-dice-d6",
    order: Object.keys(tools).length,
    button: true,
    visible: game.user.isGM,
    onChange: toggleDiceTracker
  };
});
