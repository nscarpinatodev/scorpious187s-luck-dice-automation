// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Weapon Mastery (2024 rules). dnd5e 6 records which mastery an attack used
// (the attack card's system.mastery, offered only to creatures with mastery of
// the weapon) but does nothing with it. The "weaponMastery" setting, after the
// attack and its damage:
//   Graze  — on a miss: damage equal to the attack's ability modifier, of the
//            weapon's damage type (applied when attack automation applies damage);
//   Topple — on a hit: a Constitution save (DC 8 + ability modifier + proficiency)
//            or the target falls Prone;
//   Sap    — on a hit: the target has disadvantage on its next attack roll before
//            the start of the attacker's next turn;
//   Vex    — on a hit: the attacker has advantage on its next attack roll against
//            that target before the end of its next turn;
//   Slow   — on a hit: the target's walking speed drops by 10 ft until the start
//            of the attacker's next turn (doesn't stack);
//   Push   — on a hit: the attacker may push a Large or smaller target 10 ft
//            straight away (stopping at walls);
//   Cleave — on a melee hit, once per turn: the attacker may attack a second
//            creature within 5 ft of one it hit and within the weapon's reach (its
//            allies aren't offered). That attack is rolled through dnd5e like any
//            other; its damage, when attack automation rolls it, leaves out the
//            ability modifier unless it's negative. It doesn't Cleave again.
// Sap and Vex are read by the advantage checks (advantage.mjs) and used up by the
// next attack. Effects expire through dnd5e's own "source" turn timing. Not
// automated: Nick (it changes the attacker's action economy, nothing to roll).
// Changes to creatures the attacker doesn't own go through the primary GM.

import { requestApplyDamage } from "./apply.mjs";
import { requestSaves } from "./saves.mjs";
import { tokenDistance, levelOf } from "./advantage.mjs";
import { MODULE_ID, debug, escapeHTML, promptChoice, isWeaponMasteryEnabled, getAttackAutomation, socket, activePlayerOwner, pendingAttacks, isLike } from "./shared.mjs";

export const MASTERY_FLAG = "mastery";          // on a mastery effect: { kind, attacker, target }
export const MASTERY_RESULT_FLAG = "masteryResult"; // on the attack card: what the mastery did
export const CLEAVE_FLAG = "cleave";            // on a Cleave attack's card: true

const LABELS = { graze: "Graze", topple: "Topple", sap: "Sap", vex: "Vex", slow: "Slow", push: "Push", cleave: "Cleave", nick: "Nick" };
const PUSHABLE = new Set(["tiny", "sm", "med", "lg"]);

/** The attack's ability modifier and the attacker's proficiency bonus. */
function attackNumbers(message, activity) {
  const actor = activity?.actor;
  const ability = message?.system?.ability ?? message?.rolls?.[0]?.options?.ability ?? activity?.ability;
  return {
    ability,
    mod: Number(actor?.system?.abilities?.[ability]?.mod ?? 0) || 0,
    prof: Number(actor?.system?.attributes?.prof ?? 0) || 0
  };
}

/** The weapon's damage type (its first damage part, or the item's base damage). */
function damageType(activity) {
  const part = activity?.damage?.parts?.[0];
  const types = part?.types?.size ? part.types : activity?.item?.system?.damage?.base?.types;
  return types?.first?.() ?? [...(types ?? [])][0] ?? "bludgeoning";
}

/** The effect data for a mastery effect, timed by dnd5e's "source" turn expiries. */
export function masteryEffect(kind, attackerActor, target, { name, img, changes = [], expiry, magical = false }) {
  return {
    name, img, type: "base", origin: attackerActor.uuid, transfer: false, disabled: false,
    duration: { expiry },
    // `magical`: dnd5e 6.1+ suppresses it in antimagic (earlier versions ignore the field).
    system: { changes, ...(magical ? { magical: true } : {}) },
    flags: { [MODULE_ID]: { [MASTERY_FLAG]: { kind, attacker: attackerActor.uuid, target } } }
  };
}

/** Whether a creature already has a mastery effect of this kind from this attacker. */
function hasMastery(actor, kind, attackerUuid) {
  return [...(actor?.effects ?? [])].some(e => e.getFlag?.(MODULE_ID, MASTERY_FLAG)?.kind === kind
    && e.getFlag(MODULE_ID, MASTERY_FLAG).attacker === attackerUuid);
}

// ── Applying (owner or GM) ────────────────────────────────────────────────────

/**
 * Make a mastery's change to a creature: an effect, the Prone status, or a push.
 * Runs where the creature can be changed; otherwise asks the primary GM.
 * Also used by the invocations (invocations.mjs): pushes, pulls, Lance of Lethargy.
 */
export async function applyMasteryChange(change) {
  const tokenDoc = change.token ? await fromUuid(change.token) : null;
  const actor = tokenDoc?.actor ?? (change.actor ? await fromUuid(change.actor) : null);
  if (!actor) return;
  const canChange = change.kind === "push" ? tokenDoc?.isOwner : actor.isOwner;
  if (!canChange) { socket?.emit("applyMastery", change); return; }
  return applyMasteryGM(change);
}

/** GM side (or owner): the change itself. Only the changes this module makes. */
export async function applyMasteryGM(change) {
  const tokenDoc = change.token ? await fromUuid(change.token) : null;
  const actor = tokenDoc?.actor ?? (change.actor ? await fromUuid(change.actor) : null);
  if (!actor) return;
  if (change.kind === "prone") return actor.toggleStatusEffect?.("prone", { active: true });
  if (change.kind === "push") {
    if (tokenDoc && Number.isFinite(change.x) && Number.isFinite(change.y)) await tokenDoc.update({ x: change.x, y: change.y }, { [MODULE_ID]: { forced: true } });
    return;
  }
  if (["sap", "slow", "vex", "lethargy", "stunning-strike", "studied-attacks"].includes(change.kind) && change.effect?.flags?.[MODULE_ID]?.[MASTERY_FLAG]?.kind === change.kind) {
    await actor.createEmbeddedDocuments("ActiveEffect", [change.effect]);
  }
}

// ── The masteries ─────────────────────────────────────────────────────────────

/** Graze: the ability modifier as damage to each creature the attack missed. */
async function graze(message, activity, misses) {
  const { mod } = attackNumbers(message, activity);
  if (mod <= 0 || !misses.length) return null;
  const type = damageType(activity);
  const roll = new CONFIG.Dice.DamageRoll(String(mod), {}, { type, types: [type], properties: [...(activity.item?.system?.properties ?? [])] });
  await roll.evaluate();
  const targets = misses.map(({ actor, token, name, img, ac }) => ({ actor, token, name, img, ac }));
  const card = await CONFIG.Dice.DamageRoll.toMessage([roll], {
    type: "damage",
    flavor: `${activity.item?.name ?? "Weapon"} - Graze`,
    speaker: ChatMessage.getSpeaker({ actor: activity.actor }),
    system: { targets }
  });
  if (card && getAttackAutomation() === "apply") await requestApplyDamage(card, targets);
  return `${misses.map(t => t.name).join(", ")} grazed for ${mod}`;
}

/** Topple: a Constitution save or Prone, for each creature hit. */
async function topple(message, activity, hits) {
  const { mod, prof } = attackNumbers(message, activity);
  const dc = 8 + mod + prof;
  const results = [];
  for (const hit of hits) {
    const targetActor = (await fromUuid(hit.token))?.actor ?? await fromUuid(hit.actor);
    if (!targetActor || targetActor.statuses?.has?.("prone")) continue;
    const target = { actor: hit.actor, token: hit.token, name: hit.name };
    const [result] = (await requestSaves(activePlayerOwner(targetActor)?.id ?? null, {
      activityUuid: activity.uuid, activityName: `Weapon Mastery: Topple (${activity.item?.name ?? "Weapon"})`, casterName: activity.actor?.name,
      usageId: null, ability: "con", dc, targets: [target], prompt: false
    })) ?? [];
    if (!result?.result) { results.push(`${hit.name}: no save`); continue; }
    if (result.result.passed) { results.push(`${hit.name} kept its footing`); continue; }
    await applyMasteryChange({ kind: "prone", token: hit.token, actor: hit.actor });
    results.push(`${hit.name} knocked Prone`);
  }
  return results.length ? `DC ${dc} — ${results.join("; ")}` : null;
}

/** Sap / Slow / Vex: a short-lived effect, on the target or (Vex) the attacker. */
async function markEffect(kind, activity, hits) {
  const attacker = activity.actor;
  const done = [];
  for (const hit of hits) {
    const targetActor = (await fromUuid(hit.token))?.actor ?? await fromUuid(hit.actor);
    if (!targetActor) continue;
    if (kind === "vex") {
      if (hasMastery(attacker, "vex", attacker.uuid)) {
        // Replace an older Vex: it's for the next attack against the latest target.
        for (const e of attacker.effects.filter(e => e.getFlag?.(MODULE_ID, MASTERY_FLAG)?.kind === "vex")) await e.delete();
      }
      const effect = masteryEffect("vex", attacker, hit.token, {
        name: `Vex: ${hit.name}`, img: "icons/svg/target.svg", expiry: "sourceEnd"
      });
      await applyMasteryChange({ kind: "vex", actor: attacker.uuid, effect });
      done.push(`advantage on the next attack against ${hit.name}`);
    } else if (kind === "sap") {
      if (hasMastery(targetActor, "sap", attacker.uuid)) continue;
      const effect = masteryEffect("sap", attacker, hit.token, { name: "Sapped", img: "icons/svg/downgrade.svg", expiry: "sourceStart" });
      await applyMasteryChange({ kind: "sap", token: hit.token, actor: hit.actor, effect });
      done.push(`${hit.name} has disadvantage on its next attack`);
    } else if (kind === "slow") {
      if ([...(targetActor.effects ?? [])].some(e => e.getFlag?.(MODULE_ID, MASTERY_FLAG)?.kind === "slow")) continue;
      const effect = masteryEffect("slow", attacker, hit.token, {
        name: "Slowed (Weapon Mastery)", img: "icons/svg/clockwork.svg", expiry: "sourceStart",
        changes: [{ key: "system.attributes.movement.speeds.walk", type: "add", value: -10 }]
      });
      await applyMasteryChange({ kind: "slow", token: hit.token, actor: hit.actor, effect });
      done.push(`${hit.name}'s speed −10 ft`);
    }
  }
  return done.length ? done.join("; ") : null;
}

/** Where a 10 ft push straight away from the attacker lands, stopping short of walls. */
export function pushDestination(attackerDoc, targetDoc, feet = 10) {
  const grid = canvas?.grid;
  if (!grid || !attackerDoc || !targetDoc) return null;
  const center = (t) => t.object?.center ?? { x: t.x + (t.width * grid.size) / 2, y: t.y + (t.height * grid.size) / 2 };
  const from = center(attackerDoc), at = center(targetDoc);
  const dx = at.x - from.x, dy = at.y - from.y, length = Math.hypot(dx, dy);
  if (!length) return null;
  const backend = CONFIG.Canvas?.polygonBackends?.move;
  // On the target's own level and at its elevation (Foundry 14 Scene Levels: advantage.mjs).
  const level = levelOf(targetDoc), elevation = Number(targetDoc.elevation) || 0;
  const moveTest = { type: "move", mode: "any", ...(level ? { level } : {}) };
  for (let step = feet; step > 0; step -= grid.distance) {
    const pixels = (step / grid.distance) * grid.size;
    const dest = { x: at.x + (dx / length) * pixels, y: at.y + (dy / length) * pixels };
    let blocked = false;
    try { blocked = !!backend?.testCollision?.({ ...at, elevation }, { ...dest, elevation }, moveTest); } catch { blocked = false; }
    if (blocked) continue;
    const topLeft = { x: dest.x - (targetDoc.width * grid.size) / 2, y: dest.y - (targetDoc.height * grid.size) / 2 };
    const snapped = grid.getSnappedPoint?.(topLeft, { mode: globalThis.CONST?.GRID_SNAPPING_MODES?.TOP_LEFT_CORNER ?? 16 }) ?? topLeft;
    return { x: Math.round(snapped.x), y: Math.round(snapped.y), feet: step };
  }
  return null;
}

/**
 * Where a pull of up to `feet` straight toward the puller lands: it stops short of walls, and next to
 * the puller rather than in its space. Null when there's no room.
 */
export function pullDestination(pullerDoc, targetDoc, feet = 10) {
  const grid = canvas?.grid;
  if (!grid || !pullerDoc || !targetDoc) return null;
  const center = (t) => t.object?.center ?? { x: t.x + (t.width * grid.size) / 2, y: t.y + (t.height * grid.size) / 2 };
  const at = center(targetDoc), to = center(pullerDoc);
  const dx = to.x - at.x, dy = to.y - at.y, length = Math.hypot(dx, dy);
  const room = length - ((pullerDoc.width + targetDoc.width) / 2) * grid.size;
  if (!length || room <= 0) return null;
  const backend = CONFIG.Canvas?.polygonBackends?.move;
  // On the target's own level and at its elevation (Foundry 14 Scene Levels: advantage.mjs).
  const level = levelOf(targetDoc), elevation = Number(targetDoc.elevation) || 0;
  const moveTest = { type: "move", mode: "any", ...(level ? { level } : {}) };
  for (let step = feet; step > 0; step -= grid.distance) {
    const pixels = Math.min((step / grid.distance) * grid.size, room);
    const dest = { x: at.x + (dx / length) * pixels, y: at.y + (dy / length) * pixels };
    let blocked = false;
    try { blocked = !!backend?.testCollision?.({ ...at, elevation }, { ...dest, elevation }, moveTest); } catch { blocked = false; }
    if (blocked) continue;
    const topLeft = { x: dest.x - (targetDoc.width * grid.size) / 2, y: dest.y - (targetDoc.height * grid.size) / 2 };
    const snapped = grid.getSnappedPoint?.(topLeft, { mode: globalThis.CONST?.GRID_SNAPPING_MODES?.TOP_LEFT_CORNER ?? 16 }) ?? topLeft;
    const moved = Math.round((pixels / grid.size) * grid.distance);
    if (moved <= 0) return null;
    return { x: Math.round(snapped.x), y: Math.round(snapped.y), feet: moved };
  }
  return null;
}

/** The attacker's token: dnd5e's usage token, else the attack card's speaker, else the actor's first token. */
export function attackerToken(activity, message) {
  const usage = activity.getUsageToken?.() ?? null;
  const fromUsage = usage?.document ?? usage;
  if (fromUsage) return fromUsage;
  const speaker = message?.speaker;
  const fromSpeaker = speaker?.token ? game.scenes?.get(speaker.scene)?.tokens?.get(speaker.token) : null;
  return fromSpeaker ?? activity.actor?.getActiveTokens?.()?.[0]?.document ?? null;
}

/** Push: offer to push each Large or smaller creature hit 10 ft away. */
async function push(activity, hits, message) {
  const attackerDoc = attackerToken(activity, message);
  const done = [];
  for (const hit of hits) {
    const targetDoc = await fromUuid(hit.token);
    const size = targetDoc?.actor?.system?.traits?.size ?? "med";
    if (!targetDoc?.actor) { console.log(`[${MODULE_ID}] push: no token for ${hit.name}`); continue; }
    if (!PUSHABLE.has(size)) { console.log(`[${MODULE_ID}] push: ${hit.name} is too large (${size})`); continue; }
    if (!attackerDoc) { console.log(`[${MODULE_ID}] push: no token for the attacker`); continue; }
    let dest = null;
    try { dest = pushDestination(attackerDoc, targetDoc); }
    catch (err) { console.warn(`[${MODULE_ID}] push: couldn't work out where ${hit.name} lands:`, err); }
    if (!dest) { console.log(`[${MODULE_ID}] push: no room to push ${hit.name}`); continue; }
    const choice = await promptChoice("Push",
      `<p>Push <strong>${escapeHTML(hit.name)}</strong> ${dest.feet} ft away?</p>`,
      [{ action: "push", label: "Push" }, { action: "no", label: "Don't Push" }]);
    if (choice !== "push") continue;
    await applyMasteryChange({ kind: "push", token: hit.token, actor: hit.actor, x: dest.x, y: dest.y });
    done.push(`${hit.name} pushed ${dest.feet} ft`);
  }
  return done.length ? done.join("; ") : null;
}

// Cleave, once per turn in combat: the turn each attacker last used it, by actor uuid.
const cleavedThisTurn = new Map();
const turnKey = () => game.combat?.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : null;

/** A melee weapon's reach in feet: what dnd5e prepares, else 5 ft (10 ft with the Reach property). */
const weaponReach = (item) => Number(item?.system?.range?.reach) || (item?.system?.properties?.has?.("rch") ? 10 : 5);

/**
 * The creatures a Cleave could go on to: within 5 ft of a creature hit and within the attacker's reach,
 * not the attacker, one it hit, or its allies; living, and (for players) not hidden.
 */
export function cleaveCandidates(attackerDoc, hitDocs, reach) {
  if (!attackerDoc?.parent || !hitDocs.length) return [];
  const hit = new Set(hitDocs.map(d => d.id));
  return [...(attackerDoc.parent.tokens ?? [])].filter(doc => doc.actor && doc.id !== attackerDoc.id && !hit.has(doc.id)
    && !(doc.disposition && doc.disposition === attackerDoc.disposition) && !doc.actor.statuses?.has?.("dead")
    && !(doc.hidden && !game.user.isGM)
    && hitDocs.some(h => tokenDistance(h, doc) <= 5) && tokenDistance(attackerDoc, doc) <= reach);
}

/** Cleave: offer an attack at a second creature, and make it (its Luck Dice and damage settle first). */
async function cleave(message, activity, hits) {
  if (!isLike(activity, "attack") || activity.attack?.type?.value !== "melee" || String(message.system?.mode ?? "").startsWith("thrown")) return null;
  const actor = activity.actor, turn = turnKey();
  if (turn && cleavedThisTurn.get(actor.uuid) === turn) return null;
  const attackerDoc = attackerToken(activity, message);
  const hitDocs = (await Promise.all(hits.map(h => h.token ? fromUuid(h.token) : null))).filter(d => d?.actor);
  const candidates = cleaveCandidates(attackerDoc, hitDocs, weaponReach(activity.item));
  if (!candidates.length) { debug(`cleave: no second creature in reach for ${actor.name}`); return null; }
  const weapon = activity.item?.name ?? "the weapon";
  const choice = await promptChoice("Cleave",
    `<p>Cleave: attack a second creature with <strong>${escapeHTML(weapon)}</strong>? Its damage leaves out your ability modifier.</p>`,
    [...candidates.map(c => ({ action: c.id, label: c.name })), { action: "no", label: "No" }]);
  const second = candidates.find(c => c.id === choice);
  if (!second) return null;
  if (turn) cleavedThisTurn.set(actor.uuid, turn);
  const previous = [...(game.user.targets ?? [])].map(t => t.id);
  canvas.tokens?.setTargets([second.id], { mode: "replace" });
  try {
    const rolls = await activity.rollAttack({ attackMode: message.system?.mode }, {}, {
      data: { flavor: `${weapon} - Cleave`, flags: { [MODULE_ID]: { [CLEAVE_FLAG]: true } } }
    });
    await pendingAttacks.get(rolls?.[0]?.parent?.id);
  } finally {
    canvas.tokens?.setTargets(previous, { mode: "replace" });
  }
  return `Cleave attack at ${second.name}`;
}

/** dnd5e.preRollDamageV2 — a Cleave attack's damage: no ability modifier, unless it's negative. Never cancels. */
export function onPreRollDamageCleave(config) {
  if (!config?.[MODULE_ID]?.[CLEAVE_FLAG]) return;
  const base = config.rolls?.find(r => r?.base) ?? config.rolls?.[0];
  if (!base?.parts || (Number(base.data?.mod) || 0) < 0) return;
  base.parts = base.parts.filter(p => String(p).trim() !== "@mod");
  debug(`cleave: ${config.subject?.actor?.name ?? "the attacker"}'s damage leaves out the ability modifier`);
}

/**
 * After the attack (and its damage): carry out the weapon's mastery, and note
 * what it did on the attack card. Runs on the attacker's client. A Cleave attack's
 * own card has no mastery: it doesn't Cleave again.
 */
export async function applyWeaponMastery(message, activity) {
  if (!isWeaponMasteryEnabled() || !message?.system || message.getFlag?.(MODULE_ID, MASTERY_RESULT_FLAG)) return;
  if (message.getFlag?.(MODULE_ID, CLEAVE_FLAG)) return;
  const kind = message.system.mastery;
  if (!kind || !LABELS[kind] || !activity?.actor) {
    if (!kind) debug(`weapon mastery: ${activity?.item?.name ?? "this attack"} used no mastery (dnd5e only records one the attacker has mastered)`);
    return;
  }
  const evaluated = message.system.evaluatedTargets ?? [];
  const hits = evaluated.filter(t => !t.isMiss), misses = evaluated.filter(t => t.isMiss);
  let text = null;
  if (kind === "graze") text = await graze(message, activity, misses);
  else if (!hits.length) return;
  else if (kind === "topple") text = await topple(message, activity, hits);
  else if (kind === "sap" || kind === "vex" || kind === "slow") text = await markEffect(kind, activity, hits);
  else if (kind === "push") text = await push(activity, hits, message);
  else if (kind === "cleave") text = await cleave(message, activity, hits);
  if (!text) return;
  await message.setFlag(MODULE_ID, MASTERY_RESULT_FLAG, { kind, label: LABELS[kind], text });
  debug(`weapon mastery: ${LABELS[kind]} — ${text}`);
}
