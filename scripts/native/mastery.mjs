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
//            straight away (stopping at walls).
// Sap and Vex are read by the advantage checks (advantage.mjs) and used up by the
// next attack. Effects expire through dnd5e's own "source" turn timing. Not
// automated: Cleave and Nick (they change what the attacker does next).
// Changes to creatures the attacker doesn't own go through the primary GM.

import { requestApplyDamage } from "./apply.mjs";
import { requestSaves } from "./saves.mjs";
import { MODULE_ID, debug, escapeHTML, promptChoice, isWeaponMasteryEnabled, getAttackAutomation, socket, activePlayerOwner } from "./shared.mjs";

export const MASTERY_FLAG = "mastery";          // on a mastery effect: { kind, attacker, target }
export const MASTERY_RESULT_FLAG = "masteryResult"; // on the attack card: what the mastery did

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
function masteryEffect(kind, attackerActor, target, { name, img, changes = [], expiry }) {
  return {
    name, img, type: "base", origin: attackerActor.uuid, transfer: false, disabled: false,
    duration: { expiry },
    system: { changes },
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
 */
async function applyMasteryChange(change) {
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
  if (["sap", "slow", "vex"].includes(change.kind) && change.effect?.flags?.[MODULE_ID]?.[MASTERY_FLAG]?.kind === change.kind) {
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
  for (let step = feet; step > 0; step -= grid.distance) {
    const pixels = (step / grid.distance) * grid.size;
    const dest = { x: at.x + (dx / length) * pixels, y: at.y + (dy / length) * pixels };
    let blocked = false;
    try { blocked = !!backend?.testCollision?.(at, dest, { type: "move", mode: "any" }); } catch { blocked = false; }
    if (blocked) continue;
    const topLeft = { x: dest.x - (targetDoc.width * grid.size) / 2, y: dest.y - (targetDoc.height * grid.size) / 2 };
    const snapped = grid.getSnappedPoint?.(topLeft, { mode: globalThis.CONST?.GRID_SNAPPING_MODES?.TOP_LEFT_CORNER ?? 16 }) ?? topLeft;
    return { x: Math.round(snapped.x), y: Math.round(snapped.y), feet: step };
  }
  return null;
}

/** The attacker's token: dnd5e's usage token, else the attack card's speaker, else the actor's first token. */
function attackerToken(activity, message) {
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

/**
 * After the attack (and its damage): carry out the weapon's mastery, and note
 * what it did on the attack card. Runs on the attacker's client.
 */
export async function applyWeaponMastery(message, activity) {
  if (!isWeaponMasteryEnabled() || !message?.system || message.getFlag?.(MODULE_ID, MASTERY_RESULT_FLAG)) return;
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
  if (!text) return;
  await message.setFlag(MODULE_ID, MASTERY_RESULT_FLAG, { kind, label: LABELS[kind], text });
  debug(`weapon mastery: ${LABELS[kind]} — ${text}`);
}
