// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Feats on a hit's damage, Mage Slayer on concentration, and the Help action.
//
// Under the "onHitRiders" setting, once a hit's damage is rolled (attacks.mjs, the attacker's client), by the damage
// types on the card (2014 and 2024 alike):
//   Crusher  — Bludgeoning: once per turn, the attacker may move the creature 5 ft to an unoccupied space (no more
//              than one size larger than it; the farthest from the attacker, straight away when that's free); a critical hit: attack rolls against the creature have Advantage until the start of the attacker's
//              next turn ("Crushed", read by advantage.mjs);
//   Piercer  — Piercing: once per turn, one damage die is rolled again (the lowest, when it's below the die's average —
//              the new roll stands); a critical hit rolls one more damage die (onPreRollDamagePiercer: dnd5e's own
//              extra critical dice);
//   Slasher  — Slashing: once per turn, the creature's Speed −10 ft until the start of the attacker's next turn; a
//              critical hit: it has Disadvantage on attack rolls until then ("Slashed", read by advantage.mjs).
// What they did is noted on the damage card.
//
// Mage Slayer, under the "saveRules" setting: damage from the feat's owner to a concentrating creature gives that
// concentration save Disadvantage (a mark the save reads and uses up: save-rules.mjs). 2024 Guarded Mind (a failed
// Intelligence, Wisdom or Charisma save succeeds instead) is offered with the roll extras (boosts.mjs); 2014's
// advantage against spells from within 5 ft is a save rule (save-rules.mjs) and its reaction attack an opportunity
// one (opportunity.mjs).
//
// The Help action, under the "attackAdvantage" setting: using a feature or activity named "Help" (or the module's
// API, LDA.help()) asks what it helps with —
//   an attack  — an enemy within 5 ft of the helper: the next attack roll against it by one of the helper's allies
//                has Advantage, before the start of the helper's next turn (a mark advantage.mjs reads and uses up);
//   a check    — an ally: its next ability check (2024: with a skill or tool the helper is proficient in, which it
//                picks) has Advantage, before the start of the helper's next turn (save-rules.mjs reads it).

import { applyMasteryChange, masteryEffect, spaceTaken, MASTERY_FLAG } from "./mastery.mjs";
import { levelOf } from "./advantage.mjs";
import { tokenDistance } from "./advantage.mjs";
import { pickCreatures } from "./targeting.mjs";
import { MODULE_ID, debug, escapeHTML, promptChoice, isOnHitRidersEnabled, isSaveRulesEnabled, isAttackAdvantageEnabled, showRollToAdd } from "./shared.mjs";

export const FEATS_FLAG = "featNotes"; // on a damage card: what Crusher, Piercer and Slasher did
const SIZES = ["tiny", "sm", "med", "lg", "huge", "grg"];
const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];

const feat = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;
const doc = (token) => token?.document ?? token ?? null;
const markOf = (effect) => effect?.disabled ? null : effect?.getFlag?.(MODULE_ID, MASTERY_FLAG) ?? null;
const marks = (actor, kind) => [...(actor?.effects ?? [])].filter(e => markOf(e)?.kind === kind);

// Once-per-turn uses, by "actor uuid:feat": the turn they were last used.
const usedThisTurn = new Map();
const turnKey = () => game.combat?.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : null;
const usedNow = (actor, id) => { const turn = turnKey(); return !!turn && usedThisTurn.get(`${actor.uuid}:${id}`) === turn; };
const markUsed = (actor, id) => { const turn = turnKey(); if (turn) usedThisTurn.set(`${actor.uuid}:${id}`, turn); };

/** The damage types on a damage card (each roll's type). */
export function damageTypesOf(message) {
  const types = new Set();
  for (const roll of message?.rolls ?? []) {
    if (roll?.options?.type) types.add(roll.options.type);
    for (const t of roll?.options?.types ?? []) if (roll.options.types.length === 1) types.add(t);
  }
  return types;
}

/** Whether a creature is no more than one size larger than another (Crusher's push). */
export function crusherCanMove(attacker, target) {
  const a = SIZES.indexOf(attacker?.system?.traits?.size ?? "med"), t = SIZES.indexOf(target?.system?.traits?.size ?? "med");
  return a < 0 || t < 0 || t - a <= 1;
}

/**
 * Crusher: an unoccupied space 5 ft from the creature it can move to (no wall in the way), the farthest from the
 * attacker first — straight away when that's free. { x, y } or null.
 */
export function crusherDestination(attackerDoc, targetDoc) {
  const grid = canvas?.grid;
  if (!grid || !attackerDoc || !targetDoc) return null;
  const size = grid.size;
  const center = (t, x = t.x, y = t.y) => ({ x: x + ((t.width ?? 1) * size) / 2, y: y + ((t.height ?? 1) * size) / 2 });
  const from = center(attackerDoc), at = center(targetDoc);
  const backend = CONFIG.Canvas?.polygonBackends?.move;
  const level = levelOf(targetDoc), elevation = Number(targetDoc.elevation) || 0;
  const options = [];
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    const x = targetDoc.x + dx * size, y = targetDoc.y + dy * size;
    if (spaceTaken(targetDoc, x, y)) continue;
    const to = center(targetDoc, x, y);
    let blocked = false;
    try { blocked = !!backend?.testCollision?.({ ...at, elevation }, { ...to, elevation }, { type: "move", mode: "any", ...(level ? { level } : {}) }); } catch { blocked = false; }
    if (blocked) continue;
    // How far it goes away from the attacker, and how far off the straight line.
    const ux = at.x - from.x, uy = at.y - from.y, length = Math.hypot(ux, uy) || 1;
    const mx = to.x - at.x, my = to.y - at.y;
    options.push({ x, y, away: (mx * ux + my * uy) / length, aside: Math.abs(mx * uy - my * ux) / length });
  }
  options.sort((a, b) => (b.away - a.away) || (a.aside - b.aside));
  return options[0] ? { x: options[0].x, y: options[0].y } : null;
}

// ── Crusher, Piercer, Slasher on a hit's damage ───────────────────────────────

/**
 * After a hit's damage is rolled (and its riders added): Crusher, Piercer and Slasher, by the damage on the card.
 * `attackCard` is the attack the damage belongs to (its hits and whether it was critical).
 */
export async function applyDamageFeats(message, activity, attackCard) {
  const actor = activity?.actor;
  if (!isOnHitRidersEnabled() || !actor?.isOwner || !message || !attackCard || message.getFlag?.(MODULE_ID, FEATS_FLAG)) return;
  const crusher = feat(actor, "crusher"), piercer = feat(actor, "piercer"), slasher = feat(actor, "slasher");
  if (!crusher && !piercer && !slasher) return;
  const hits = (attackCard.system?.evaluatedTargets ?? []).filter(t => !t.isMiss);
  if (!hits.length) return;
  const types = damageTypesOf(message);
  const critical = !!attackCard.rolls?.[0]?.isCritical;
  const notes = [];
  const attackerDoc = doc(activity.getUsageToken?.() ?? actor.getActiveTokens?.()?.[0]);

  if (crusher && types.has("bludgeoning")) {
    if (!usedNow(actor, "crusher")) {
      for (const hit of hits) {
        const targetDoc = hit.token ? await fromUuid(hit.token) : null;
        if (!targetDoc?.actor || !attackerDoc || !crusherCanMove(actor, targetDoc.actor)) continue;
        const dest = crusherDestination(attackerDoc, targetDoc);
        if (!dest) continue;
        const answer = await promptChoice("Crusher", `<p>Move <strong>${escapeHTML(hit.name)}</strong> 5 ft away?</p>`,
          [{ action: "push", label: "Move It" }, { action: "no", label: "No" }]);
        if (answer !== "push") continue;
        await applyMasteryChange({ kind: "push", token: hit.token, actor: hit.actor, x: dest.x, y: dest.y });
        markUsed(actor, "crusher");
        notes.push(`Crusher: ${hit.name} moved 5 ft`);
        break;
      }
    }
    if (critical) {
      for (const hit of hits) {
        const effect = masteryEffect("crusher", actor, hit.token, { name: "Crushed", img: "icons/svg/downgrade.svg", expiry: "sourceStart" });
        await applyMasteryChange({ kind: "crusher", token: hit.token, actor: hit.actor, effect });
      }
      notes.push(`Crusher: attack rolls against ${hits.map(h => h.name).join(", ")} have Advantage until the start of ${actor.name}'s next turn`);
    }
  }

  if (piercer && types.has("piercing") && !usedNow(actor, "piercer")) {
    const note = await piercerReroll(message);
    if (note) { markUsed(actor, "piercer"); notes.push(`Piercer: ${note}`); }
  }

  if (slasher && types.has("slashing")) {
    if (!usedNow(actor, "slasher")) {
      markUsed(actor, "slasher");
      for (const hit of hits) {
        const effect = masteryEffect("slasher-slow", actor, hit.token, {
          name: "Slashed (Speed −10 ft)", img: "icons/svg/blood.svg", expiry: "sourceStart",
          changes: [{ key: "system.attributes.movement.speeds.walk", type: "add", value: -10 }]
        });
        await applyMasteryChange({ kind: "slasher-slow", token: hit.token, actor: hit.actor, effect });
      }
      notes.push(`Slasher: ${hits.map(h => h.name).join(", ")} −10 ft Speed`);
    }
    if (critical) {
      for (const hit of hits) {
        const effect = masteryEffect("slasher", actor, hit.token, { name: "Slashed (Disadvantage on attacks)", img: "icons/svg/blood.svg", expiry: "sourceStart" });
        await applyMasteryChange({ kind: "slasher", token: hit.token, actor: hit.actor, effect });
      }
      notes.push(`Slasher: ${hits.map(h => h.name).join(", ")} ${hits.length === 1 ? "has" : "have"} Disadvantage on attack rolls until the start of ${actor.name}'s next turn`);
    }
  }

  if (!notes.length) return;
  await message.setFlag(MODULE_ID, FEATS_FLAG, notes);
  console.log(`[${MODULE_ID}] feats: ${actor.name} — ${notes.join("; ")}`);
}

/**
 * Piercer: roll the lowest piercing damage die again when it's below the die's average (the new roll stands). The card's
 * roll is changed in place, as Savage Attacker does (riders.mjs). Resolves with a note, or null.
 */
export async function piercerReroll(message) {
  const rolls = message?.rolls ?? [];
  let pick = null;
  rolls.forEach((roll, rollIndex) => {
    const type = roll?.options?.type ?? (roll?.options?.types?.length === 1 ? roll.options.types[0] : null);
    if (type !== "piercing" || roll?.options?.ldaLuckDice) return;
    (roll.dice ?? []).forEach((term, termIndex) => (term.results ?? []).forEach((result, resultIndex) => {
      if (result.active === false || result.rerolled) return;
      const below = result.result < (term.faces + 1) / 2;
      if (below && (!pick || result.result < pick.value)) pick = { rollIndex, termIndex, resultIndex, faces: term.faces, value: result.result };
    }));
  });
  if (!pick) return null;
  const again = await new Roll(`1d${pick.faces}`).evaluate();
  await showRollToAdd(again);
  const value = Number(again.total);
  const copies = rolls.map(r => (typeof r?.toJSON === "function" && r.constructor?.fromData) ? r.constructor.fromData(r.toJSON()) : r);
  const term = copies[pick.rollIndex].dice[pick.termIndex];
  Object.assign(term.results[pick.resultIndex], { active: false, rerolled: true });
  term.results.push({ result: value, active: true });
  const copy = copies[pick.rollIndex];
  if (typeof copy._evaluateTotal === "function") copy._total = copy._evaluateTotal();
  await message.update({ rolls: copies });
  return `a d${pick.faces} rolled again (${pick.value} → ${value})`;
}

/**
 * dnd5e.preRollDamageV2 — Piercer: a critical hit's piercing damage rolls one more die (dnd5e's own extra critical dice,
 * which only count on a critical hit). Never cancels.
 */
export function onPreRollDamagePiercer(config) {
  if (!isOnHitRidersEnabled()) return;
  const activity = config?.subject, actor = activity?.actor;
  if (!feat(actor, "piercer") || activity?.type !== "attack") return;
  const base = config.rolls?.find(r => r?.base) ?? config.rolls?.[0];
  if (!base) return;
  const types = new Set([base.options?.type, ...(base.options?.types ?? [])].filter(Boolean));
  if (!types.size) for (const t of activity.damage?.parts?.[0]?.types ?? activity.item?.system?.damage?.base?.types ?? []) types.add(t);
  if (!types.has("piercing") || (types.size > 1 && base.options?.type && base.options.type !== "piercing")) return;
  base.options ??= {};
  base.options.critical ??= {};
  base.options.critical.bonusDice = (Number(base.options.critical.bonusDice) || 0) + 1;
  debug(`piercer: ${actor.name}'s critical piercing damage gets one more die`);
}

// ── Crushed, Slashed, Help: read by the attack rules ──────────────────────────

/**
 * The marks on this attack that come from these feats and Help (advantage.mjs): Crushed on the target, Slashed on the
 * attacker, Help on the target from one of the attacker's allies (used up). { advantage, disadvantage, consume }.
 */
export function featMarkReasons({ attackerActor, attackerDoc, targetActor }) {
  const advantage = [], disadvantage = [], consume = [];
  if (targetActor && marks(targetActor, "crusher").length) advantage.push("Crusher (critical hit)");
  if (marks(attackerActor, "slasher").length) disadvantage.push("Slasher (critical hit)");
  const help = targetActor ? marks(targetActor, "help").find(e => {
    const mark = markOf(e);
    return mark.attacker !== attackerActor?.uuid && Number(mark.disposition) && Number(mark.disposition) === Number(attackerDoc?.disposition);
  }) : null;
  if (help) { advantage.push(`Help (${markOf(help).helperName ?? "an ally"})`); consume.push(help.uuid); }
  return { advantage, disadvantage, consume };
}

/** Help with a check (save-rules.mjs): the mark on this creature that covers this check, if any. */
export function helpCheckMark(actor, { skill = null, tool = null } = {}) {
  return marks(actor, "help-check").find(e => {
    const mark = markOf(e);
    if (!mark.skill && !mark.tool) return true;
    return (mark.skill && mark.skill === skill) || (mark.tool && mark.tool === tool);
  }) ?? null;
}

// ── Mage Slayer: concentration ────────────────────────────────────────────────

/**
 * dnd5e.preApplyDamage (synchronous; the client applying it): damage from a creature with Mage Slayer to a concentrating
 * creature — the concentration save it's about to make has Disadvantage. A mark (save-rules.mjs reads and uses it up),
 * made before the damage lands so it's there for the save. Never cancels.
 */
export function onPreApplyDamageMageSlayer(actor, amount, _updates, options = {}) {
  if (!isSaveRulesEnabled() || !(amount > 0) || !actor?.isOwner || !(actor.concentration?.effects?.size > 0)) return;
  const message = options.originatingMessage ?? null;
  const source = message?.getAssociatedActivity?.()?.actor ?? message?.speakerActor ?? null;
  if (!source || source === actor || !feat(source, "mage-slayer")) return;
  if (marks(actor, "mage-slayer").length) return;
  const effect = masteryEffect("mage-slayer", source, actor.uuid, { name: "Mage Slayer: Disadvantage on concentration", img: "icons/svg/daze.svg", expiry: "turnEnd" });
  actor.createEmbeddedDocuments?.("ActiveEffect", [effect])?.catch?.(err => console.error(`[${MODULE_ID}] mage slayer:`, err));
  debug(`mage slayer: ${source.name} damaged ${actor.name} — Disadvantage on its concentration save`);
}

/** The Mage Slayer mark on a concentrating creature (save-rules.mjs), if any. */
export const mageSlayerMark = (actor) => marks(actor, "mage-slayer")[0] ?? null;

// ── Help ──────────────────────────────────────────────────────────────────────

const isHelp = (activity) => /^help$/i.test(String(activity?.name ?? "").trim()) || /^help$/i.test(String(activity?.item?.name ?? "").trim())
  || activity?.item?.system?.identifier === "help";

/** dnd5e.postUseActivity: a feature or activity named "Help". */
export async function onHelpUsed(activity) {
  if (!isAttackAdvantageEnabled() || !isHelp(activity) || !activity.actor?.isOwner) return;
  const tokenDoc = doc(activity.getUsageToken?.() ?? activity.actor.getActiveTokens?.()?.[0]);
  await help(tokenDoc ?? activity.actor);
}

/** The skills and tools a creature is proficient in: [{ kind, key, label }]. */
function proficiencies(actor) {
  const out = [];
  for (const [key, skill] of Object.entries(actor?.system?.skills ?? {})) {
    if (Number(skill?.value ?? skill?.proficient) >= 1) out.push({ kind: "skill", key, label: CONFIG.DND5E?.skills?.[key]?.label ?? key });
  }
  for (const [key, tool] of Object.entries(actor?.system?.tools ?? {})) {
    if (Number(tool?.value ?? tool?.proficient) >= 1) out.push({ kind: "tool", key, label: tool?.label ?? CONFIG.DND5E?.tools?.[key]?.label ?? key });
  }
  return out;
}

/**
 * The Help action, for a token (or an actor with one on the scene): asks what it helps with and marks the creature.
 * Resolves with a note, or null.
 */
export async function help(helper) {
  const helperDoc = doc(helper?.documentName === "Actor" ? helper.getActiveTokens?.()?.[0] : helper);
  const actor = helperDoc?.actor;
  if (!helperDoc?.parent || !actor) { ui.notifications?.warn("Luck Dice Automation: Help needs the helper's token on the scene."); return null; }
  const modern = game.settings?.get?.("dnd5e", "rulesVersion") !== "legacy";
  const usable = (t) => t.actor && t.id !== helperDoc.id && !INCAPACITATING.some(s => t.actor.statuses?.has?.(s)) && !(t.hidden && !game.user.isGM);
  const enemies = [...helperDoc.parent.tokens].filter(t => usable(t) && t.disposition && t.disposition === -helperDoc.disposition
    && tokenDistance(helperDoc, t) <= 5);
  const allies = [...helperDoc.parent.tokens].filter(t => usable(t) && t.disposition === helperDoc.disposition);
  const choice = await promptChoice("Help", `<p>What does <strong>${escapeHTML(helperDoc.name)}</strong> help with?</p>`, [
    ...(enemies.length ? [{ action: "attack", label: "An attack (an enemy within 5 ft)" }] : []),
    ...(allies.length ? [{ action: "check", label: "An ally's ability check" }] : []),
    { action: "no", label: "Cancel" }
  ]);
  if (choice === "attack") {
    const targeted = [...(game.user?.targets ?? [])].map(doc).filter(t => enemies.some(e => e.id === t.id));
    const picked = targeted.length === 1 ? targeted : await pickCreatures("Help", "Which enemy within 5 ft? The next attack roll against it by one of your allies has Advantage.",
      enemies, { max: 1, checked: () => false });
    const enemy = picked?.[0];
    if (!enemy?.actor) return null;
    const effect = masteryEffect("help", actor, enemy.uuid, { name: `Helped Against (${helperDoc.name})`, img: "icons/svg/upgrade.svg", expiry: "sourceStart" });
    Object.assign(effect.flags[MODULE_ID][MASTERY_FLAG], { disposition: helperDoc.disposition, helperName: helperDoc.name });
    await applyMasteryChange({ kind: "help", token: enemy.uuid, actor: enemy.actor.uuid, effect });
    return note(`${helperDoc.name} helps: the next attack roll against ${enemy.name} by an ally has Advantage`);
  }
  if (choice === "check") {
    const picked = await pickCreatures("Help", "Which ally? Its next ability check has Advantage.", allies, { max: 1, checked: () => false });
    const ally = picked?.[0];
    if (!ally?.actor) return null;
    let skill = null, tool = null, what = "ability check";
    if (modern) {
      const options = proficiencies(actor);
      if (!options.length) { ui.notifications?.warn(`Luck Dice Automation: ${helperDoc.name} has no skill or tool proficiency to help with.`); return null; }
      const pick = await promptChoice("Help", "<p>With which of your skills or tools?</p>",
        options.map(o => ({ action: `${o.kind}:${o.key}`, label: game.i18n.localize(o.label) })));
      const found = options.find(o => `${o.kind}:${o.key}` === pick);
      if (!found) return null;
      if (found.kind === "skill") skill = found.key; else tool = found.key;
      what = `${game.i18n.localize(found.label)} check`;
    }
    const effect = masteryEffect("help-check", actor, ally.uuid, { name: `Helped (${helperDoc.name})`, img: "icons/svg/upgrade.svg", expiry: "sourceStart" });
    Object.assign(effect.flags[MODULE_ID][MASTERY_FLAG], { skill, tool, helperName: helperDoc.name });
    await applyMasteryChange({ kind: "help-check", token: ally.uuid, actor: ally.actor.uuid, effect });
    return note(`${helperDoc.name} helps ${ally.name}: Advantage on its next ${what}`);
  }
  return null;
}

function note(text) {
  ui.notifications?.info(`Luck Dice Automation: ${text}.`);
  debug(`help: ${text}`);
  return text;
}
