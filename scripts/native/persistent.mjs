// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Persistent damage, under the "persistentDamage" setting.
//
// A general way to hurt a creature at the start of each of its turns: burning, bleeding, acid, a monster's
// lingering bite. It's an effect on the creature that carries a damage amount — a flat number or a dice formula —
// and a damage type:
//   • a "Persistent Damage" status in dnd5e's token HUD: turning it on asks for the amount and the type (cancel,
//     and it comes off again);
//   • LDA.persistentDamage(), for a macro: asks once and puts the effect on every selected token (targets, if
//     none is selected). Each call adds another effect, so several can run on one creature.
// At the start of the creature's turn in combat (the primary GM's client), each such effect rolls its damage onto
// a damage card and applies it through the module's damage application — resistances, immunities and temporary
// HP as usual, reactions and death saves included, with Undo on the card. It runs until the effect is removed
// (toggle the status off, or delete the effect); an effect with a duration ends with it, as any other.

import { requestApplyDamage } from "./apply.mjs";
import { MODULE_ID, debug, escapeHTML, isPersistentDamageEnabled } from "./shared.mjs";

export const PERSISTENT = "persistentDamage"; // the status id, and the effect's flag: { formula, type, label }
const IMG = "icons/svg/fire.svg";

// The status, added to dnd5e's own list before dnd5e builds CONFIG.statusEffects (i18nInit).
Hooks.once("init", () => {
  if (!globalThis.CONFIG?.DND5E?.statusEffects) return;
  CONFIG.DND5E.statusEffects[PERSISTENT] ??= { name: "Persistent Damage", img: IMG, order: 52 };
});

const doc = (token) => token?.document ?? token ?? null;
const typeLabel = (type) => game.i18n?.localize?.(CONFIG.DND5E?.damageTypes?.[type]?.label ?? type) ?? type;

/** A formula as typed, tidied; null when it isn't a number or dice formula Foundry can roll. */
export function cleanFormula(text) {
  const formula = String(text ?? "").trim();
  if (!formula) return null;
  if (/^\d+$/.test(formula)) return Number(formula) > 0 ? formula : null;
  try { return (globalThis.Roll?.validate?.(formula) ?? /\d*d\d+/i.test(formula)) ? formula : null; } catch { return null; }
}

/** What an effect deals each turn — { formula, type, label } — or null when it isn't persistent damage (or isn't set up). */
export function persistentOf(effect) {
  if (!effect || effect.disabled || effect.isSuppressed) return null;
  const data = effect.getFlag?.(MODULE_ID, PERSISTENT) ?? effect.flags?.[MODULE_ID]?.[PERSISTENT];
  return data?.formula && data?.type ? data : null;
}

/** The name a persistent damage effect shows: "Persistent Damage (1d6 Fire)", or its own label with the same detail. */
export const persistentName = ({ formula, type, label }) => `${label || "Persistent Damage"} (${formula} ${typeLabel(type)})`;

/** The effect's data: the status (so it shows on the token and in the HUD), and what it deals. */
export function persistentEffect({ formula, type, label = "" }) {
  return {
    name: persistentName({ formula, type, label }), img: IMG, type: "base", transfer: false, disabled: false,
    statuses: [PERSISTENT],
    flags: { [MODULE_ID]: { [PERSISTENT]: { formula, type, label } } }
  };
}

/** Ask for the amount and the type. Resolves with { formula, type, label }, or null when cancelled. */
export async function askPersistent(names = []) {
  const DialogV2 = foundry.applications.api?.DialogV2;
  if (!DialogV2) return null;
  const types = Object.keys(CONFIG.DND5E?.damageTypes ?? {});
  const who = names.length ? `<p>For <strong>${names.map(escapeHTML).join(", ")}</strong>, at the start of each of ${names.length > 1 ? "their" : "its"} turns:</p>` : "";
  // What was typed last time round stays in the window when a bad amount is asked for again.
  let last = { formula: "1d6", type: "fire", label: "" };
  for (;;) {
    const options = types.map(t => `<option value="${t}"${t === last.type ? " selected" : ""}>${escapeHTML(typeLabel(t))}</option>`).join("");
    const answer = await DialogV2.wait({
      window: { title: "Persistent Damage" },
      content: `${who}
        <div class="form-group"><label>Damage</label><div class="form-fields"><input type="text" name="lda-persistent-formula" value="${escapeHTML(last.formula)}" placeholder="5 or 1d6+2" autofocus></div>
          <p class="hint">A flat number or a dice formula, rolled each turn.</p></div>
        <div class="form-group"><label>Damage Type</label><div class="form-fields"><select name="lda-persistent-type">${options}</select></div></div>
        <div class="form-group"><label>Name</label><div class="form-fields"><input type="text" name="lda-persistent-label" value="${escapeHTML(last.label)}" placeholder="Burning, Bleeding… (optional)"></div></div>`,
      buttons: [
        { action: "ok", label: "Apply", icon: "fa-solid fa-check", default: true,
          callback: (_event, button) => ({
            formula: button.form.querySelector('[name="lda-persistent-formula"]')?.value,
            type: button.form.querySelector('[name="lda-persistent-type"]')?.value,
            label: button.form.querySelector('[name="lda-persistent-label"]')?.value?.trim() ?? ""
          }) },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => null }
      ],
      rejectClose: false
    });
    if (!answer || typeof answer !== "object") return null;
    const formula = cleanFormula(answer.formula);
    if (formula && answer.type) return { formula, type: answer.type, label: answer.label ?? "" };
    last = { formula: String(answer.formula ?? ""), type: answer.type || last.type, label: answer.label ?? "" };
    ui.notifications?.warn("Luck Dice Automation: persistent damage needs a number or a dice formula (5, 1d6, 2d4+1).");
  }
}

/**
 * createActiveEffect (the client that made it): the Persistent Damage status turned on from the token HUD has
 * nothing to deal yet — ask, and set it up; cancelled, it comes off again.
 */
export async function onPersistentCreated(effect, _options, userId) {
  if (!isPersistentDamageEnabled() || userId !== game.user?.id || !effect?.statuses?.has?.(PERSISTENT)) return;
  if (effect.getFlag?.(MODULE_ID, PERSISTENT)?.formula) return; // made with its damage (LDA.persistentDamage, a copy)
  const actor = effect.parent;
  const answer = await askPersistent([actor?.token?.name ?? actor?.name].filter(Boolean));
  if (!answer) { await effect.delete().catch(() => null); return; }
  await effect.update({ name: persistentName(answer), [`flags.${MODULE_ID}.${PERSISTENT}`]: answer });
  debug(`persistent damage: ${actor?.name} — ${answer.formula} ${answer.type}`);
}

/**
 * For a macro (LDA.persistentDamage): ask once, and put the effect on every selected token — the targets, when none
 * is selected. Resolves with the names it went on.
 */
export async function persistentDamage(tokens = null) {
  if (!isPersistentDamageEnabled()) { ui.notifications?.warn("Luck Dice Automation: turn on the Persistent Damage setting first."); return []; }
  const chosen = (tokens ? [tokens].flat() : canvas?.tokens?.controlled?.length ? canvas.tokens.controlled : [...(game.user?.targets ?? [])])
    .map(doc).filter(t => t?.actor);
  if (!chosen.length) { ui.notifications?.warn("Luck Dice Automation: select or target the creatures to put persistent damage on."); return []; }
  const answer = await askPersistent(chosen.map(t => t.name));
  if (!answer) return [];
  const done = [];
  for (const tokenDoc of chosen) {
    if (!tokenDoc.actor.isOwner) continue;
    await tokenDoc.actor.createEmbeddedDocuments("ActiveEffect", [persistentEffect(answer)]);
    done.push(tokenDoc.name);
  }
  if (done.length) ui.notifications?.info(`Luck Dice Automation: ${persistentName(answer)} on ${done.join(", ")}.`);
  return done;
}

/** Roll one effect's damage onto a card for the creature, and apply it. */
export async function dealPersistent(tokenDoc, data) {
  const roll = await new CONFIG.Dice.DamageRoll(String(data.formula), tokenDoc.actor?.getRollData?.() ?? {}, { type: data.type, types: [data.type] }).evaluate();
  const targets = [{ actor: tokenDoc.actor.uuid, token: tokenDoc.uuid, name: tokenDoc.name, img: tokenDoc.texture?.src,
    ac: tokenDoc.actor.system?.attributes?.ac?.value ?? null }];
  const label = data.label || "Persistent Damage";
  const card = await CONFIG.Dice.DamageRoll.toMessage([roll], {
    type: "damage", flavor: `${label} — ${tokenDoc.name}`, speaker: { alias: label }, system: { targets }
  });
  if (card) await requestApplyDamage(card, targets);
  return card;
}

/**
 * combatTurnChange (the primary GM): the creature whose turn starts takes each of its persistent damage effects.
 * Not a dead creature's.
 */
export async function onTurnStartPersistent(combat, current, { isTrigger = () => true, deal = dealPersistent } = {}) {
  if (!isPersistentDamageEnabled() || !isTrigger() || !combat?.started || !current?.tokenId) return;
  const tokenDoc = (combat.scene ?? canvas?.scene)?.tokens?.get?.(current.tokenId);
  const actor = tokenDoc?.actor;
  if (!actor || actor.statuses?.has?.("dead")) return;
  for (const effect of [...(actor.effects ?? [])]) {
    const data = persistentOf(effect);
    if (!data) continue;
    debug(`persistent damage: ${tokenDoc.name} takes ${data.formula} ${data.type}`);
    await deal(tokenDoc, data);
  }
}
