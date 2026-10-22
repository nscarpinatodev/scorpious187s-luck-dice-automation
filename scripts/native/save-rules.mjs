// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Saving throw rules: automatic failures, advantage from traits, Aura of Protection, Evasion.
//
// The "saveRules" setting. Before a save is rolled (dnd5e.preRollSavingThrowV2), the creature and
// what the save is against — the activity dnd5e's save button and the save automation record on
// the card (system.activity) — are checked for:
//   automatic failure — Strength and Dexterity saves while Paralyzed, Stunned, Unconscious or
//                       Petrified. The roll is still made and shown, and dnd5e counts it as a failure
//                       (the roll carries the reason; D20Roll's success test is extended to read it),
//                       so Legendary Resistance can still turn it, but Luck Dice aren't offered;
//   advantage         — Magic Resistance (spells, and magic items' activities); Gnome Cunning (2014:
//                       Intelligence, Wisdom and Charisma saves against magic); Duergar Resilience
//                       (poison, spells, illusions, being charmed or paralyzed); Dwarven Resilience
//                       (being poisoned; 2014 poison damage too); Fey Ancestry (charmed); Brave
//                       (frightened); 2014 Danger Sense (Dexterity, unless Blinded, Deafened or
//                       Incapacitated). What a save is "against" is read from the statuses its
//                       activity's effects apply, so saves to end the condition count too;
//   a bonus           — Aura of Protection: the best Charisma modifier (minimum +1) among paladins,
//                       not incapacitated, friendly to the creature and within 10 ft of it (30 ft
//                       with Aura Expansion or from 18th level). 2024's own effect already gives the
//                       paladin itself the bonus.
// dnd5e itself covers Restrained and Dodging on Dexterity saves, exhaustion, Rage, 2024 Danger Sense
// and Gnomish Cunning. The advantage / disadvantage combines with other sources the way the attack
// reasons do (advantage.mjs). With Automated Conditions 5e automating statuses, automatic failures
// are left to it (it sets the DC to 999) — the reason is still noted for the card. Evasion goes with
// the save automation's damage (saves.mjs). A save folded into its spell's card (dnd5e's summary)
// shows its reasons there (cards.mjs).

import { ac5eCovers, tokenDistance, rulesOf, mergeRollMode, ensureFinalModeHook, reasonsHTML, SAVE_REASONS_FLAG } from "./advantage.mjs";
import { MODULE_ID, debug, escapeHTML, isSaveRulesEnabled } from "./shared.mjs";

export { SAVE_REASONS_FLAG };
const AUTO_FAIL = [["paralyzed", "Paralyzed"], ["stunned", "Stunned"], ["unconscious", "Unconscious"], ["petrified", "Petrified"]];
const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];

const doc = (token) => token?.document ?? token ?? null;
const has = (actor, status) => !!actor?.statuses?.has?.(status);
const feature = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;
const changesOf = (effect) => effect?.system?.changes ?? effect?.changes ?? [];
const incapacitated = (actor) => INCAPACITATING.some(s => has(actor, s));

// ── What a save is against ────────────────────────────────────────────────────

/** The activity behind a save, from the card dnd5e is about to post (system.activity), if any. */
function sourceActivity(message) {
  const uuid = message?.data?.system?.activity?.uuid;
  if (typeof uuid !== "string") return null;
  try {
    const found = fromUuidSync(uuid, { strict: false });
    if (found) return found;
  } catch { /* not resolvable synchronously */ }
  try {
    const [itemUuid, id] = uuid.split(".Activity.");
    return fromUuidSync(itemUuid, { strict: false })?.system?.activities?.get?.(id) ?? null;
  } catch { return null; }
}

/** What a save is against: { activity, item, spell, magical, illusion, statuses, damageTypes }. */
export function saveSource(message) {
  const activity = sourceActivity(message);
  const item = activity?.item ?? null;
  const itemType = item?.type ?? message?.data?.system?.item?.type ?? null;
  const statuses = new Set();
  for (const profile of activity?.effects ?? []) {
    const effect = profile?.effect ?? item?.effects?.get?.(profile?._id);
    for (const status of effect?.statuses ?? []) statuses.add(status);
  }
  const damageTypes = new Set((activity?.damage?.parts ?? []).flatMap(part => [...(part?.types ?? [])]));
  return {
    activity, item,
    spell: itemType === "spell",
    magical: itemType === "spell" || !!item?.system?.properties?.has?.("mgc"),
    illusion: item?.system?.school === "ill",
    statuses, damageTypes
  };
}

// ── The rules ─────────────────────────────────────────────────────────────────

/** The paladin's own 2024 aura effect (a transferred save bonus) — it already covers the paladin. */
function ownAuraEffect(item) {
  return [...(item?.effects ?? [])].some(e => e.transfer && !e.disabled
    && changesOf(e).some(c => c.key === "system.bonuses.abilities.save"));
}

/** The best Aura of Protection over this creature: { label, value, key } or null. */
export function auraOfProtection(actor, tokenDoc) {
  const me = doc(tokenDoc ?? actor?.getActiveTokens?.()?.[0]);
  if (!me?.parent) return null;
  let best = null;
  for (const token of me.parent.tokens ?? []) {
    const paladin = token.actor;
    const aura = feature(paladin, "aura-of-protection");
    if (!aura || incapacitated(paladin)) continue;
    const self = token.id === me.id;
    if (self ? ownAuraEffect(aura) : (!token.disposition || token.disposition !== me.disposition)) continue;
    const range = feature(paladin, "aura-expansion") || Number(paladin.classes?.paladin?.system?.levels ?? 0) >= 18 ? 30 : 10;
    if (!self && tokenDistance(token, me) > range) continue;
    const value = Math.max(1, Number(paladin.system?.abilities?.cha?.mod ?? 0) || 0);
    if (!best || value > best.value) best = { label: self ? "Aura of Protection" : `Aura of Protection (${token.name})`, value, key: "auraOfProtection" };
  }
  return best;
}

/**
 * The rules for this save: { advantage: [], disadvantage: [], autoFail: label | null, bonuses: [{ label, value, key }] }.
 * `source` is what it's against (saveSource); `tokenDoc` the creature's token, for its aura.
 */
export function saveReasons(actor, ability, source = {}, { tokenDoc = null } = {}) {
  const advantage = [], disadvantage = [], bonuses = [];
  let autoFail = null, autoFailBy = null;
  if (ability === "str" || ability === "dex") {
    autoFail = AUTO_FAIL.find(([status]) => has(actor, status))?.[1] ?? null;
    // Automated Conditions 5e enforces it itself (a DC of 999): only the reason is noted, for the card.
    if (autoFail && ac5eCovers().statuses) autoFailBy = "Automated Conditions 5e";
  }
  const statuses = source.statuses ?? new Set(), damage = source.damageTypes ?? new Set();
  if (source.magical && feature(actor, "magic-resistance")) advantage.push("Magic Resistance");
  if (source.magical && ["int", "wis", "cha"].includes(ability) && feature(actor, "gnome-cunning")) advantage.push("Gnome Cunning");
  if (feature(actor, "duergar-resilience") && (statuses.has("poisoned") || damage.has("poison") || source.spell || source.illusion
    || statuses.has("charmed") || statuses.has("paralyzed"))) advantage.push("Duergar Resilience");
  const dwarf = feature(actor, "dwarven-resilience");
  if (dwarf && (statuses.has("poisoned") || (rulesOf(dwarf) === "2014" && damage.has("poison")))) advantage.push("Dwarven Resilience");
  if (statuses.has("charmed") && feature(actor, "fey-ancestry")) advantage.push("Fey Ancestry");
  if (statuses.has("frightened") && feature(actor, "brave")) advantage.push("Brave");
  const sense = feature(actor, "danger-sense");
  if (sense && ability === "dex" && rulesOf(sense) === "2014" && !has(actor, "blinded") && !has(actor, "deafened") && !incapacitated(actor)) {
    advantage.push("Danger Sense");
  }
  const aura = auraOfProtection(actor, tokenDoc);
  if (aura) bonuses.push(aura);
  return { advantage, disadvantage, autoFail, autoFailBy, bonuses };
}

/** Evasion: a Dexterity save against half damage, by a creature with it that isn't incapacitated. */
export function evasionApplies(actor, ability, onSave) {
  return isSaveRulesEnabled() && ability === "dex" && (onSave ?? "half") === "half" && !!feature(actor, "evasion") && !incapacitated(actor);
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/** The saving creature's token: the card's speaker, its synthetic token, or its first on the scene. */
function saverToken(actor, message) {
  const speaker = message?.data?.speaker;
  if (speaker?.token) {
    const scene = game.scenes?.get?.(speaker.scene) ?? canvas?.scene;
    const found = scene?.tokens?.get?.(speaker.token);
    if (found) return found;
  }
  return doc(actor?.token ?? actor?.getActiveTokens?.()?.[0]);
}

/**
 * dnd5e.preRollSavingThrowV2 (concentration saves too): apply the rules before dnd5e builds the
 * roll — advantage / disadvantage merged with its other sources, the aura's bonus as a part of the
 * formula, an automatic failure noted on the roll — and note them for the roll window and the card.
 * Never cancels.
 */
export function onPreRollSave(config, dialog, message) {
  if (!isSaveRulesEnabled()) return;
  const actor = config?.subject;
  if (!actor?.system?.abilities || !config.ability) return;
  let reasons;
  try { reasons = saveReasons(actor, config.ability, saveSource(message), { tokenDoc: saverToken(actor, message) }); }
  catch (err) { console.error(`[${MODULE_ID}] save rules:`, err); return; }
  const { advantage, disadvantage, autoFail, bonuses } = reasons;
  if (!advantage.length && !disadvantage.length && !autoFail && !bonuses.length) return;

  if (advantage.length || disadvantage.length) {
    reasons.finalMode = mergeRollMode(config, dialog, reasons);
    ensureFinalModeHook();
  }
  const first = config.rolls?.[0];
  if (first) {
    for (const bonus of bonuses) {
      first.parts ??= [];
      first.data ??= {};
      first.parts.push(`@${bonus.key}`);
      first.data[bonus.key] = bonus.value;
    }
  }
  if (autoFail && !reasons.autoFailBy) {
    for (const roll of config.rolls ?? []) {
      roll.options ??= {};
      roll.options[MODULE_ID] = { ...(roll.options[MODULE_ID] ?? {}), autoFail };
    }
  }
  if (message) foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.${SAVE_REASONS_FLAG}`, reasons);
  debug(`save rules: ${actor.name} ${config.ability} — ${autoFail ? `fails (${autoFail}) ` : ""}+[${advantage.join(", ")}] −[${disadvantage.join(", ")}]${
    bonuses.length ? ` ${bonuses.map(b => `${b.label} +${b.value}`).join(", ")}` : ""}`);
}

/** Whether a roll fails automatically (save-rules' note on it). */
export const autoFailOf = (roll) => roll?.options?.[MODULE_ID]?.autoFail ?? null;

const PATCHED = Symbol.for(`${MODULE_ID}.autoFail`);
/**
 * Make D20Roll's success test honour an automatic failure noted on the roll — on every client,
 * since the note travels with the roll. A roll without the note is judged exactly as before.
 */
export function installAutoFail(D20Roll = CONFIG.Dice?.D20Roll) {
  const proto = D20Roll?.prototype;
  if (!proto || proto[PATCHED]) return;
  const getter = (name) => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const get = Object.getOwnPropertyDescriptor(p, name)?.get;
      if (get) return get;
    }
    return null;
  };
  const isSuccess = getter("isSuccess"), isFailure = getter("isFailure");
  if (!isSuccess || !isFailure) return;
  const applies = (roll) => !!autoFailOf(roll) && Number.isFinite(Number(roll.options?.target));
  Object.defineProperty(proto, "isSuccess", { configurable: true, get() {
    const value = isSuccess.call(this);
    return value !== undefined && applies(this) ? false : value;
  } });
  Object.defineProperty(proto, "isFailure", { configurable: true, get() {
    const value = isFailure.call(this);
    return value !== undefined && applies(this) ? true : value;
  } });
  proto[PATCHED] = true;
}

/** "Automatic failure: Paralyzed  Advantage: Magic Resistance  Bonus: Aura of Protection +3" for the window and card. */
export function saveReasonsHTML(reasons) {
  const parts = [];
  if (reasons?.autoFail) parts.push(`<strong>Automatic failure:</strong> ${escapeHTML(reasons.autoFail)}`);
  const modes = reasonsHTML(reasons);
  if (modes) parts.push(modes);
  if (reasons?.bonuses?.length) parts.push(`<strong>Bonus:</strong> ${reasons.bonuses.map(b => `${escapeHTML(b.label)} +${b.value}`).join(" · ")}`);
  return parts.join(" &nbsp; ");
}

/** renderD20RollConfigurationDialog: the save's rules at the top of dnd5e's roll window. */
export function onRenderSaveDialog(app, element) {
  const reasons = app?.message?.data?.flags?.[MODULE_ID]?.[SAVE_REASONS_FLAG];
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!reasons || !root || root.querySelector(".lda-save-reasons")) return;
  const note = document.createElement("p");
  note.className = "lda-save-reasons";
  note.style.cssText = "margin:0 0 6px;font-size:0.9em";
  note.innerHTML = saveReasonsHTML(reasons);
  (root.querySelector("form") ?? root.querySelector(".window-content") ?? root).prepend(note);
}
