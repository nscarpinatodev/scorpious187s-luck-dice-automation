// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Advantage and disadvantage on attack rolls, from the obvious reasons.
//
// The "attackAdvantage" setting. Before an attack is rolled (dnd5e.preRollAttackV2,
// which runs before dnd5e reads its advantage keys), the attacker, its single
// target and the scene are checked for:
//   range      — a ranged attack with an active enemy within 5 ft (Crossbow Expert,
//                Sharpshooter, Gunner, Spell Sniper excepted, per their rules);
//                beyond normal range (Sharpshooter excepted); beyond long range
//                cancels the attack with a message;
//   conditions — the attacker Prone, Restrained, Blinded, Invisible, or Frightened
//                with the source of its fear in sight; the target Prone (melee
//                within 5 ft / otherwise), Restrained, Blinded, Paralyzed, Stunned,
//                Unconscious, Petrified, Invisible, or Dodging;
//   features   — Reckless Attack (the attacker's Strength attacks; attacks against
//                a reckless creature), Faerie Fire, Guiding Bolt (its mark is used
//                up by the attack), a Heavy weapon in small or weak hands.
// dnd5e itself already covers Poisoned, encumbrance and exhaustion. Any advantage
// plus any disadvantage is a normal roll, so these combine safely with other
// sources. When Automated Conditions 5e (AC5E) is active, each check it performs
// with its current settings is left to it. Reasons about the target count only
// with exactly one target (dnd5e rolls once for all of them). The reasons are
// shown in dnd5e's roll window and on the attack card.

import { MODULE_ID, debug, escapeHTML, isAttackAdvantageEnabled, isAutoCritsEnabled, isWeaponMasteryEnabled, socket } from "./shared.mjs";
import { MASTERY_FLAG } from "./mastery.mjs";

export const ATTACK_REASONS_FLAG = "attackReasons";
const AC5E_ID = "automated-conditions-5e";
const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];

// ── Automated Conditions 5e ───────────────────────────────────────────────────

function ac5eSetting(key) {
  try { return game.settings.get(AC5E_ID, key); } catch { return undefined; }
}

/** The checks AC5E performs with its current settings ({} when it isn't active). */
export function ac5eCovers() {
  if (!game.modules.get(AC5E_ID)?.active) return {};
  const statuses = !!ac5eSetting("automateStatuses");
  const rangeSetting = ac5eSetting("autoRangeChecks");
  const range = new Set(rangeSetting && typeof rangeSetting[Symbol.iterator] === "function" && typeof rangeSetting !== "string" ? rangeSetting : []);
  return {
    statuses,
    dodging: statuses && !!ac5eSetting("expandedConditions"),
    nearbyFoes: range.has("rangedNearbyFoes"),
    longRange: range.has("rangedLongDisadvantage"),
    outOfRange: range.has("rangedOoR"),
    heavy: !!ac5eSetting("automateHeavy")
  };
}

// ── Geometry ──────────────────────────────────────────────────────────────────

const doc = (token) => token?.document ?? token ?? null;

/** Distance between two tokens' nearest grid spaces (in scene units), elevation included. */
export function tokenDistance(a, b) {
  a = doc(a); b = doc(b);
  const grid = canvas?.grid;
  if (!a || !b || !grid || a.parent !== b.parent) return Infinity;
  const at = (token, point) => ({ ...point, elevation: token.elevation ?? 0 });
  if (!grid.isGridless && a.getOccupiedGridSpaceOffsets && b.getOccupiedGridSpaceOffsets) {
    let best = Infinity;
    for (const oa of a.getOccupiedGridSpaceOffsets()) {
      for (const ob of b.getOccupiedGridSpaceOffsets()) {
        const d = grid.measurePath([at(a, grid.getCenterPoint(oa)), at(b, grid.getCenterPoint(ob))]).distance;
        if (d < best) best = d;
      }
    }
    return best;
  }
  // Gridless: centre to centre, less each token's half-size.
  const center = (t) => t.object?.center ?? { x: t.x + (t.width * grid.size) / 2, y: t.y + (t.height * grid.size) / 2 };
  const d = grid.measurePath([at(a, center(a)), at(b, center(b))]).distance;
  return Math.max(0, d - ((a.width + b.width) / 2) * grid.distance + grid.distance);
}

/** Whether walls block sight between two tokens. */
export function hasLineOfSight(a, b) {
  a = doc(a); b = doc(b);
  const backend = CONFIG.Canvas?.polygonBackends?.sight;
  const center = (t) => t.object?.center ?? { x: t.x, y: t.y };
  if (!backend?.testCollision) return true;
  try { return !backend.testCollision(center(a), center(b), { type: "sight", mode: "any" }); } catch { return true; }
}

// ── Where effects came from ───────────────────────────────────────────────────

/** The item an applied effect came from, from what dnd5e records on it. */
function sourceItem(effect) {
  const candidates = [effect.system?.origin?.item, effect.system?.origin?.activity?.split(".Activity.")[0],
    effect._stats?.duplicateSource?.split(".ActiveEffect.")[0], effect._stats?.compendiumSource?.split(".ActiveEffect.")[0], effect.origin];
  for (const uuid of candidates) {
    if (typeof uuid !== "string" || !uuid.includes("Item.")) continue;
    try {
      const item = fromUuidSync(uuid, { strict: false });
      if (item?.documentName === "Item") return item;
    } catch { /* not resolvable synchronously */ }
  }
  return null;
}

/** The actor an effect came from (its origin's owner), resolved synchronously. */
function sourceActor(effect) {
  const item = sourceItem(effect);
  if (item?.actor) return item.actor;
  for (const uuid of [effect.system?.origin?.activity, effect.origin]) {
    if (typeof uuid !== "string") continue;
    const actorPart = uuid.split(".Item.")[0];
    try {
      const found = fromUuidSync(actorPart, { strict: false });
      if (found?.documentName === "Actor") return found;
      if (found?.actor) return found.actor;
    } catch { /* ignore */ }
  }
  return null;
}

/** Active effects on an actor that came from an item with this identifier. */
function effectsFrom(actor, identifier) {
  return [...(actor?.effects ?? [])].filter(e => !e.disabled && !e.isSuppressed && sourceItem(e)?.system?.identifier === identifier);
}

const hasFeat = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;
const rulesOf = (item) => {
  const rules = String(item?.system?.source?.rules ?? "");
  if (rules === "2014" || rules === "2024") return rules;
  try { return game.settings.get("dnd5e", "rulesVersion") === "legacy" ? "2014" : "2024"; } catch { return "2024"; }
};

// ── The checks ────────────────────────────────────────────────────────────────

/** What the attack is: who, with what, at whom. */
export function attackFacts(activity, config = {}) {
  const actor = activity?.actor ?? null;
  const item = activity?.item ?? null;
  const attacker = doc(activity?.getUsageToken?.() ?? actor?.getActiveTokens?.()?.[0]);
  const mode = String(config.attackMode ?? "");
  const thrown = mode.startsWith("thrown");
  const ranged = activity?.attack?.type?.value === "ranged" || thrown;
  const classification = activity?.attack?.type?.classification;
  const targets = [...(game.user?.targets ?? [])].map(doc).filter(t => t?.actor);
  return {
    actor, item, activity, attacker, ranged, thrown, melee: !ranged,
    weapon: item?.type === "weapon" || classification === "weapon" || classification === "unarmed",
    spell: classification === "spell" || item?.type === "spell",
    ability: config.ability ?? activity?.ability ?? null,
    targets, target: targets.length === 1 ? targets[0] : null
  };
}

/** The weapon's or activity's range in scene units: { normal, long } or null when it has none. */
function rangeOf(fx) {
  const range = fx.item?.type === "weapon" ? fx.item.system?.range : fx.activity?.range;
  const normal = Number(range?.value);
  if (!Number.isFinite(normal) || normal <= 0) return null;
  const units = String(range?.units ?? "ft").toLowerCase();
  const sceneUnits = String(canvas?.scene?.grid?.units ?? canvas?.grid?.units ?? "ft").toLowerCase();
  const norm = (u) => ({ feet: "ft", foot: "ft", meters: "m", meter: "m", metres: "m", metre: "m" })[u] ?? u;
  if (!["ft", "m"].includes(norm(units)) || norm(units) !== norm(sceneUnits)) return null;
  const long = Number(range?.long);
  return { normal, long: Number.isFinite(long) && long > normal ? long : null };
}

const adjacent = () => canvas?.grid?.distance ?? 5;
const isCrossbow = (item) => /crossbow/i.test(String(item?.system?.type?.baseItem ?? item?.name ?? ""));

/** Feats that let this ranged attack ignore an enemy within 5 ft. */
function ignoresNearbyFoes(fx) {
  const crossbowExpert = hasFeat(fx.actor, "crossbow-expert");
  if (crossbowExpert && (rulesOf(crossbowExpert) === "2014" || isCrossbow(fx.item))) return true;
  const sharpshooter = hasFeat(fx.actor, "sharpshooter");
  if (sharpshooter && rulesOf(sharpshooter) === "2024" && fx.weapon) return true;
  if (hasFeat(fx.actor, "gunner") && fx.weapon) return true;
  const spellSniper = hasFeat(fx.actor, "spell-sniper");
  return !!(spellSniper && rulesOf(spellSniper) === "2024" && fx.spell);
}

/** An active enemy within 5 ft of the attacker, if any. */
function nearbyFoe(fx) {
  const me = fx.attacker;
  if (!me || !me.parent || !me.disposition) return null;
  return [...(me.parent.tokens ?? [])].find(t => t.id !== me.id && t.actor && t.disposition === -me.disposition
    && !INCAPACITATING.some(s => t.actor.statuses?.has?.(s)) && tokenDistance(me, t) <= adjacent()) ?? null;
}

/** Frightened, with the source of its fear on the scene and in sight. Unknown sources don't count. */
function frightenedBySeenSource(fx) {
  const actor = fx.actor;
  if (!actor?.statuses?.has?.("frightened") || actor.statuses.has("blinded") || !fx.attacker) return null;
  for (const effect of actor.effects ?? []) {
    if (effect.disabled || !effect.statuses?.has?.("frightened")) continue;
    const source = sourceActor(effect);
    const token = source?.getActiveTokens?.()?.map(doc).find(t => t.parent === fx.attacker.parent);
    if (token && hasLineOfSight(fx.attacker, token)) return token;
  }
  return null;
}

/**
 * The reasons for advantage / disadvantage on this attack, and whether it
 * can't be made at all: { advantage: [], disadvantage: [], cancel, consume: [effect uuids] }.
 */
export function attackReasons(activity, config = {}) {
  const fx = attackFacts(activity, config);
  const covers = ac5eCovers();
  const advantage = [], disadvantage = [], consume = [];
  let cancel = null;
  const target = fx.target, targetActor = target?.actor;
  const has = (actor, status) => !!actor?.statuses?.has?.(status);
  const distance = target && fx.attacker ? tokenDistance(fx.attacker, target) : Infinity;

  // Range.
  if (fx.ranged && fx.attacker) {
    const range = rangeOf(fx);
    if (range && target && Number.isFinite(distance)) {
      const max = range.long ?? range.normal;
      if (distance > max && !covers.outOfRange) {
        cancel = `${target.name} is out of range for ${fx.item?.name ?? "that attack"} (${Math.round(distance)} of ${max}).`;
      } else if (range.long && distance > range.normal && distance <= range.long && !covers.longRange && !hasFeat(fx.actor, "sharpshooter")) {
        disadvantage.push("Long range");
      }
    }
    if (!covers.nearbyFoes && !ignoresNearbyFoes(fx)) {
      const foe = nearbyFoe(fx);
      if (foe) disadvantage.push(`Ranged attack with ${foe.name} within 5 ft`);
    }
  }

  // Conditions.
  if (!covers.statuses) {
    if (has(fx.actor, "prone")) disadvantage.push("Prone");
    if (has(fx.actor, "restrained")) disadvantage.push("Restrained");
    if (has(fx.actor, "blinded")) disadvantage.push("Blinded");
    if (has(fx.actor, "invisible")) advantage.push("Invisible");
    const fear = frightenedBySeenSource(fx);
    if (fear) disadvantage.push(`Frightened of ${fear.name}`);
    if (targetActor) {
      if (has(targetActor, "prone")) {
        if (fx.melee && distance <= adjacent()) advantage.push("Target prone");
        else disadvantage.push("Target prone (not within 5 ft)");
      }
      for (const [status, label] of [["restrained", "Restrained"], ["blinded", "Blinded"], ["paralyzed", "Paralyzed"],
        ["stunned", "Stunned"], ["unconscious", "Unconscious"], ["petrified", "Petrified"]]) {
        if (has(targetActor, status)) advantage.push(`Target ${label.toLowerCase()}`);
      }
      if (has(targetActor, "invisible")) disadvantage.push("Target invisible");
    }
  }
  if (!covers.dodging && targetActor && has(targetActor, "dodging") && !INCAPACITATING.some(s => has(targetActor, s))) {
    disadvantage.push("Target dodging");
  }

  // Features.
  const reckless = effectsFrom(fx.actor, "reckless-attack")[0];
  if (reckless && fx.ability === "str") {
    const modern = rulesOf(sourceItem(reckless)) === "2024";
    if (modern || (fx.melee && fx.weapon)) advantage.push("Reckless Attack");
  }
  if (targetActor && effectsFrom(targetActor, "reckless-attack").length) advantage.push("Target attacking recklessly");
  if (targetActor && effectsFrom(targetActor, "faerie-fire").length) advantage.push("Faerie Fire");
  const bolt = targetActor ? effectsFrom(targetActor, "guiding-bolt")[0] : null;
  if (bolt) { advantage.push("Guiding Bolt"); consume.push(bolt.uuid); }
  addMasteryReasons(fx, { advantage, disadvantage, consume });
  if (!covers.heavy && fx.item?.type === "weapon" && fx.item.system?.properties?.has?.("hvy")) {
    const reason = heavyWeaponReason(fx);
    if (reason) disadvantage.push(reason);
  }

  return { advantage, disadvantage, cancel, consume };
}

/** Weapon Mastery marks (mastery.mjs): Sap on the attacker, Vex against this target. Used up by the attack. */
function addMasteryReasons(fx, { advantage, disadvantage, consume }) {
  const masteryOf = (effect) => effect.disabled ? null : effect.getFlag?.(MODULE_ID, MASTERY_FLAG);
  const effects = [...(fx.actor?.effects ?? [])];
  const sapped = effects.find(e => masteryOf(e)?.kind === "sap");
  if (sapped) { disadvantage.push("Sapped"); consume.push(sapped.uuid); }
  const vexing = fx.target ? effects.find(e => masteryOf(e)?.kind === "vex" && masteryOf(e).target === fx.target.uuid) : null;
  if (vexing) { advantage.push("Vex"); consume.push(vexing.uuid); }
}

/** Only the Weapon Mastery reasons (when the advantage setting is off but Weapon Mastery is on). */
export function masteryReasons(activity, config = {}) {
  const fx = attackFacts(activity, config);
  const reasons = { advantage: [], disadvantage: [], cancel: null, consume: [] };
  addMasteryReasons(fx, reasons);
  return reasons;
}

/** 2014: Small or Tiny wielders. 2024: Strength (melee) / Dexterity (ranged) below 13. */
function heavyWeaponReason(fx) {
  const actor = fx.actor;
  if (rulesOf(fx.item) === "2014") {
    return ["sm", "tiny"].includes(actor?.system?.traits?.size) ? "Heavy weapon (small wielder)" : null;
  }
  const meleeWeapon = /M$/.test(String(fx.item.system?.type?.value ?? "")) || !/R$/.test(String(fx.item.system?.type?.value ?? ""));
  const ability = meleeWeapon ? "str" : "dex";
  const score = Number(actor?.system?.abilities?.[ability]?.value);
  return Number.isFinite(score) && score < 13 ? `Heavy weapon (${ability === "str" ? "Strength" : "Dexterity"} below 13)` : null;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/**
 * dnd5e.preRollAttackV2: apply the reasons (before dnd5e reads its keys), note
 * them for the roll window and the card, or cancel an attack out of range.
 * Returns false only to cancel.
 */
export function onPreRollAttack(config, dialog, message) {
  const full = isAttackAdvantageEnabled();
  if (!full && !isWeaponMasteryEnabled()) return;
  const activity = config?.subject;
  if (activity?.type !== "attack") return;
  let reasons;
  try { reasons = full ? attackReasons(activity, config) : masteryReasons(activity, config); }
  catch (err) { console.error(`[${MODULE_ID}] attack reasons:`, err); return; }
  if (reasons.cancel) {
    ui.notifications?.warn(`Luck Dice Automation: ${reasons.cancel}`);
    return false;
  }
  if (!reasons.advantage.length && !reasons.disadvantage.length) return;

  // Combine with what's already on the roll: Automated Conditions 5e's verdict (it decides in
  // dnd5e.preRollAttack, just before this, and writes a normal roll as advantage + disadvantage, so
  // its own record of its sources is read instead), or dnd5e's own sources (e.g. Poisoned).
  // Any advantage plus any disadvantage is a normal roll.
  const roll0 = config.rolls?.[0]?.options ?? {};
  const ac5e = game.modules.get(AC5E_ID)?.active ? roll0[AC5E_ID] : null;
  const priorAdvantage = ac5e ? !!ac5e.hasTransitAdvantage : !!(roll0.advantage || config.advantage);
  const priorDisadvantage = ac5e ? !!ac5e.hasTransitDisadvantage : !!(roll0.disadvantage || config.disadvantage);
  const hasAdvantage = priorAdvantage || reasons.advantage.length > 0;
  const hasDisadvantage = priorDisadvantage || reasons.disadvantage.length > 0;
  const modes = CONFIG.Dice.D20Roll?.ADV_MODE ?? { NORMAL: 0, ADVANTAGE: 1, DISADVANTAGE: -1 };
  const finalMode = hasAdvantage && !hasDisadvantage ? modes.ADVANTAGE : hasDisadvantage && !hasAdvantage ? modes.DISADVANTAGE : modes.NORMAL;
  config.advantage = hasAdvantage;
  config.disadvantage = hasDisadvantage;
  for (const roll of config.rolls ?? []) {
    roll.options ??= {};
    roll.options.advantage = hasAdvantage;
    roll.options.disadvantage = hasDisadvantage;
  }
  if (dialog) {
    dialog.options ??= {};
    dialog.options.defaultButton = finalMode === modes.ADVANTAGE ? "advantage" : finalMode === modes.DISADVANTAGE ? "disadvantage" : "normal";
  }
  reasons.finalMode = finalMode;
  ensureFinalModeHook();
  if (message) foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.${ATTACK_REASONS_FLAG}`, reasons);
  debug(`attack reasons: +[${reasons.advantage.join(", ")}] −[${reasons.disadvantage.join(", ")}] → mode ${finalMode}`);
}

let finalModeHookRegistered = false;
/**
 * Registered on the first attack — after every module's setup, so after Automated
 * Conditions 5e's own dnd5e.postRollConfiguration handler, which re-applies its verdict
 * to the built roll. This one runs last and keeps the combined verdict.
 */
function ensureFinalModeHook() {
  if (finalModeHookRegistered) return;
  finalModeHookRegistered = true;
  Hooks.on("dnd5e.postRollConfiguration", applyFinalAttackMode);
}

/**
 * dnd5e.postRollConfiguration: when the roll window was skipped, put the combined
 * advantage / disadvantage on the built d20 (a choice made in the window stands).
 */
export function applyFinalAttackMode(rolls, config, dialog, message) {
  const reasons = message?.data?.flags?.[MODULE_ID]?.[ATTACK_REASONS_FLAG];
  if (!reasons || typeof reasons.finalMode !== "number" || dialog?.configure !== false) return;
  const roll = rolls?.[0];
  const d20 = roll?.d20;
  if (!d20?.applyAdvantage || roll.options?.advantageMode === reasons.finalMode) return;
  d20.applyAdvantage(reasons.finalMode);
  roll.options.advantageMode = reasons.finalMode;
  roll.resetFormula?.();
  debug(`attack mode kept: ${reasons.finalMode} (${AC5E_ID} active: ${!!game.modules.get(AC5E_ID)?.active})`);
}

/** A short line for the roll window and the card: "Advantage: a · b. Disadvantage: c." */
export function reasonsHTML(reasons) {
  const part = (label, list) => list?.length ? `<strong>${label}:</strong> ${list.map(escapeHTML).join(" · ")}` : "";
  const both = reasons?.advantage?.length && reasons?.disadvantage?.length;
  return [part("Advantage", reasons?.advantage), part("Disadvantage", reasons?.disadvantage)].filter(Boolean).join(" &nbsp; ")
    + (both ? ` <span style="opacity:0.75">(they cancel)</span>` : "");
}

/** renderAttackRollConfigurationDialog: show the reasons at the top of dnd5e's roll window. */
export function onRenderAttackDialog(app, element) {
  const reasons = app?.message?.data?.flags?.[MODULE_ID]?.[ATTACK_REASONS_FLAG];
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!reasons || !root || root.querySelector(".lda-attack-reasons")) return;
  const note = document.createElement("p");
  note.className = "lda-attack-reasons";
  note.style.cssText = "margin:0 0 6px;font-size:0.9em";
  note.innerHTML = reasonsHTML(reasons);
  (root.querySelector("form") ?? root.querySelector(".window-content") ?? root).prepend(note);
}

/** After the attack: use up marks spent on it (Guiding Bolt). The GM removes what the attacker can't. */
export async function consumeAttackMarks(message) {
  const uuids = message?.getFlag?.(MODULE_ID, ATTACK_REASONS_FLAG)?.consume ?? [];
  for (const uuid of uuids) {
    const effect = await fromUuid(uuid);
    if (!effect) continue;
    if (effect.isOwner) await effect.delete();
    else socket?.emit("consumeAttackMark", { uuid });
  }
}

/** GM side: remove a mark an attack used up — only marks this module consumes (Guiding Bolt, Sap, Vex). */
export async function consumeAttackMarkGM({ uuid }) {
  const effect = await fromUuid(uuid);
  if (!effect) return;
  const mastery = effect.getFlag?.(MODULE_ID, MASTERY_FLAG)?.kind;
  if (sourceItem(effect)?.system?.identifier === "guiding-bolt" || mastery === "sap" || mastery === "vex") await effect.delete();
}

/**
 * dnd5e.preRollDamageV2 — the "autoCrits" setting: an attack's damage against
 * creatures that are all Paralyzed or Unconscious, from within 5 ft, is critical.
 * Left to AC5E when it automates statuses (it does the same). Never cancels.
 */
export function onPreRollDamage(config, dialog, message) {
  if (!isAutoCritsEnabled() || config?.isCritical || ac5eCovers().statuses) return;
  const activity = config?.subject;
  if (activity?.type !== "attack") return;
  const attacker = doc(activity.getUsageToken?.() ?? activity.actor?.getActiveTokens?.()?.[0]);
  const descriptors = message?.data?.system?.targets;
  const targets = Array.isArray(descriptors) && descriptors.length
    ? descriptors.map(t => { try { return fromUuidSync(t.token, { strict: false }); } catch { return null; } }).filter(t => t?.actor)
    : [...(game.user?.targets ?? [])].map(doc).filter(t => t?.actor);
  if (!attacker || !targets.length) return;
  const helpless = (t) => t.actor.statuses?.has?.("paralyzed") || t.actor.statuses?.has?.("unconscious");
  if (!targets.every(t => helpless(t) && tokenDistance(attacker, t) <= adjacent())) return;
  config.isCritical = true;
  debug(`auto-crit: ${targets.map(t => t.name).join(", ")} helpless within 5 ft`);
}
