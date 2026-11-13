// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Reaction prompts: when hit, when damaged, after being damaged — and the
// opportunity attacks (opportunity.mjs) — all sharing one reaction per creature.
//
// The "reactionPrompts" setting (off / player characters / everyone). Each
// reaction is found by item identifier and offered only when it would matter:
//   on a hit (the attacker's client, after its own Luck Dice):
//     Shield            — a slot left, not a crit, +5 AC turns the hit into a miss;
//     Defensive Duelist — a melee hit, a finesse weapon in hand, +proficiency AC
//                         turns it into a miss;
//     Uncanny Dodge     — any hit: half damage;
//     Cutting Words     — an ally of the target within 60 ft of the attacker, who
//                         can see it: subtract a Bardic Inspiration die when that
//                         could turn the hit into a miss;
//     Silvery Barbs     — the same allies: the attacker rerolls, keeping the lower;
//   before damage is applied (the GM's client, as it applies the damage):
//     Absorb Elements   — acid, cold, fire, lightning or thunder: resistance to it;
//     Parry             — a melee attack: reduce the damage by the Parry roll;
//   after damage (the GM's client):
//     Hellish Rebuke    — damaged by a creature within 60 ft it can see: cast it
//                         at the attacker (the save automation takes it from there).
// Each is used through dnd5e (spending its slot or uses; effects such as Shield's
// +5 AC go on the creature), on its owner's client — its active player, else the
// primary GM. A creature has one reaction until its next turn starts, tracked in
// combat by a "Reaction Used" status on it: every client sees it, it survives a
// reload, and the GM can toggle it on the token HUD. Unanswered prompts time out
// as "no reaction".
//
// Also offered to the creature hit, under the "rollBoosts" setting rather than this one
// (boosts.mjs), and without using its reaction: the Lucky feat — the attacker rolls another
// d20 and uses the lower.
// Invocations, with this setting and the "invocations" one: Rebuke of the Talisman (hit:
// psychic damage equal to the warlock's proficiency bonus to the attacker, pushed 10 ft
// away), Tomb of Levistus (damaged: 10 temporary HP per Warlock level first; then
// Incapacitated, speed 0 and vulnerable to fire until the end of its next turn).

import { requestApplyEffects } from "./effects.mjs";
import { tokenDistance, hasLineOfSight, cantTakeReactions } from "./advantage.mjs";
import { bardicDie, luckyFeat, usesLeft, useLuckyAgainst, withExtraD20, spendUses } from "./boosts.mjs";
import { answerGift, dealInvocationDamage } from "./invocations.mjs";
import { applyMasteryChange, pushDestination } from "./mastery.mjs";
import { isTriggerClient } from "./lingering.mjs";
import { answerOpportunity } from "./opportunity.mjs";
import { answerWallSide } from "./walls.mjs";
import {
  LDA, MODULE_ID, escapeHTML, promptChoice, getReactionPrompts, socket, getPrimaryGM, activePlayerOwner,
  resolveTarget, combineRolls, isRollBoostsEnabled, getKeptD20Result, isInvocationsEnabled, antimagicStops, hasStockEffect, isLike
} from "./shared.mjs";

export const REACTIONS_FLAG = "reactions";
const RESPONSE_TIMEOUT = 60_000;
const ELEMENTS = ["acid", "cold", "fire", "lightning", "thunder"];
const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];
const finite = (n) => Number.isFinite(n);
const prof = (actor) => Number(actor?.system?.attributes?.prof ?? 0) || 0;
const wieldsFinesse = (actor) => [...(actor?.items ?? [])].some(i => i.type === "weapon" && i.system?.equipped !== false
  && i.system?.properties?.has?.("fin"));

const dieMax = (die) => Number(String(die).replace(/^\d*d/, "")) || 6;

/**
 * By item identifier. `when`: hit / damage / afterDamage; `ally`: asked of the target's allies, not the
 * target; `free`: not a reaction (Lucky) — offered under the "rollBoosts" setting, and `item` finds it.
 */
export const REACTIONS = {
  "lucky": {
    when: "hit", free: true, item: (actor) => luckyFeat(actor),
    label: (actor) => `Lucky: the attacker rolls another d20 and uses the lower (${usesLeft(luckyFeat(actor))} left)`,
    // Worth it when a lower d20 could make it miss: a critical hit, or the bonus alone not reaching the AC.
    useful: ({ total, ac, critical, d20 }) => critical || (finite(ac) && finite(d20) && total - d20 + 1 < ac)
  },
  "shield": {
    when: "hit", label: () => "Shield (+5 AC)", acBonus: () => 5,
    useful: ({ total, ac, critical }) => !critical && finite(ac) && total < ac + 5
  },
  "defensive-duelist": {
    when: "hit", label: (actor) => `Defensive Duelist (+${prof(actor)} AC)`, acBonus: (actor) => prof(actor),
    useful: ({ total, ac, critical, melee, actor }) => melee && !critical && finite(ac) && total < ac + prof(actor) && wieldsFinesse(actor)
  },
  "uncanny-dodge": { when: "hit", label: () => "Uncanny Dodge (half damage)", multiplier: 0.5, useful: () => true },
  "cutting-words": {
    when: "hit", ally: true, label: (actor) => `Cutting Words (−${bardicDie(actor)} from the attack)`,
    useful: ({ total, ac, critical, actor }) => !critical && finite(ac) && total - dieMax(bardicDie(actor)) < ac
  },
  "silvery-barbs": {
    when: "hit", ally: true, label: () => "Silvery Barbs (reroll the attack, keep the lower)",
    useful: ({ critical }) => !critical
  },
  "absorb-elements": {
    when: "damage", label: (_actor, { types }) => `Absorb Elements (resist ${types.filter(t => ELEMENTS.includes(t)).join(", ")})`,
    useful: ({ types }) => types.some(t => ELEMENTS.includes(t))
  },
  "parry": { when: "damage", label: () => "Parry (reduce the damage)", useful: ({ melee }) => melee },
  "hellish-rebuke": { when: "afterDamage", label: (_actor, { attackerName }) => `Hellish Rebuke at ${attackerName}`, useful: ({ attacker }) => !!attacker },
  // Invocations: used here (no dnd5e activity needed), spending the invocation's uses where it has them.
  "rebuke-of-the-talisman": {
    when: "hit", manual: true, setting: isInvocationsEnabled,
    label: (actor) => `Rebuke of the Talisman (${prof(actor)} psychic to the attacker, push it 10 ft)`,
    useful: ({ attackerWithin30 }) => attackerWithin30 !== false
  },
  "tomb-of-levistus": {
    when: "damage", manual: true, setting: isInvocationsEnabled,
    label: (actor) => `Tomb of Levistus (${tombHP(actor)} temporary HP; then Incapacitated until the end of your next turn)`,
    useful: () => true
  }
};

const tombHP = (actor) => 10 * (Number(actor?.classes?.warlock?.system?.levels ?? 0) || 0);

/** Whether the actor has a spell slot (any level, or pact) left. */
function hasSpellSlot(actor) {
  return Object.entries(actor?.system?.spells ?? {}).some(([key, slot]) =>
    (Number(slot?.value) || 0) > 0 && (key === "pact" || Number(key.replace("spell", "")) >= 1));
}

/** The reaction's item on this creature. */
const reactionItem = (actor, identifier) => REACTIONS[identifier]?.item
  ? REACTIONS[identifier].item(actor)
  : actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;

/**
 * The reactions this creature could use at this moment (`when`), by identifier. `free` ones (Lucky) only
 * under the "rollBoosts" setting; the rest only with `reactions` (the creature is asked under the setting).
 */
export function reactionOptions(actor, context, when = "hit", { ally = false, reactions = true } = {}) {
  const options = [];
  for (const [identifier, reaction] of Object.entries(REACTIONS)) {
    if (reaction.when !== when || !!reaction.ally !== ally) continue;
    if (reaction.free ? !isRollBoostsEnabled() : !reactions) continue;
    if (reaction.setting && !reaction.setting()) continue;
    const item = reactionItem(actor, identifier);
    if (!item || !reaction.useful({ ...context, actor })) continue;
    if (antimagicStops(actor, item)) continue; // dnd5e 6.1+: no spell or Magical feature in antimagic
    if (reaction.manual && item.system?.uses?.max && usesLeft(item) <= 0) continue;
    if (item.type === "spell" && (item.system?.level ?? 0) > 0 && !hasSpellSlot(actor)) continue;
    options.push(identifier);
  }
  return options;
}

// ── Responder side: who has used their reaction ───────────────────────────────

export const REACTION_USED = "reacted";

// The status, added to dnd5e's own list before dnd5e builds CONFIG.statusEffects (i18nInit).
Hooks.once("init", () => {
  if (!globalThis.CONFIG?.DND5E?.statusEffects) return;
  CONFIG.DND5E.statusEffects[REACTION_USED] ??= { name: "Reaction Used", img: "icons/svg/lightning.svg", order: 51 };
});

// Creatures whose reaction is being spent on this client, until the status lands (by actor uuid).
const spending = new Set();
// dnd5e 6.1's stock No Reactions effect (shared.mjs) takes it away too, as does a 2014 Shocking Grasp (advantage.mjs).
export const hasReaction = (actor) => !!actor && !actor.statuses?.has?.(REACTION_USED) && !spending.has(actor.uuid)
  && !hasStockEffect(actor, "noReactions") && !cantTakeReactions(actor);

/** A creature uses its reaction: the status, on its owner's client. Outside combat there are no turns to track it by. */
export async function spendReaction(actor) {
  if (!actor || !game.combat?.started) return;
  spending.add(actor.uuid);
  try { await actor.toggleStatusEffect?.(REACTION_USED, { active: true }); }
  finally { spending.delete(actor.uuid); }
}

const reactionBack = async (actor) => {
  if (actor?.statuses?.has?.(REACTION_USED)) await actor.toggleStatusEffect?.(REACTION_USED, { active: false });
};

/** combatTurnChange (primary GM): the creature whose turn starts has its reaction back. */
export async function onTurnStartReaction(combat, current) {
  if (!isTriggerClient()) return;
  await reactionBack((combat?.scene ?? canvas.scene)?.tokens?.get?.(current?.tokenId)?.actor);
}

/** deleteCombat (primary GM): everyone in it has their reaction back. */
export async function onCombatEndedReactions(combat) {
  if (!isTriggerClient()) return;
  for (const combatant of combat?.combatants ?? []) await reactionBack(combatant.actor);
}

/** Use a reaction's item through dnd5e; put the usage's effects (Shield, Defensive Duelist) on the creature. */
async function useReaction(item, actor, tokenDoc, { aim } = {}) {
  const activity = [...(item?.system?.activities?.values?.() ?? [])].find(a => a.activation?.type === "reaction")
    ?? [...(item?.system?.activities?.values?.() ?? [])][0];
  if (!activity?.use) return null;
  if (aim && canvas?.scene === aim.parent) canvas.tokens?.setTargets([aim.id], { mode: "replace" });
  const spell = item.type === "spell";
  const results = spell
    ? await activity.use({}, {}, {})
    : await activity.use({ consume: true, subsequentActions: false }, { configure: false }, {});
  if (!results) return null;
  const usage = results.message;
  if (REACTIONS[item.system.identifier]?.when === "hit" && (usage?.system?.getEffects?.()?.length || activity.effects?.length)) {
    await requestApplyEffects(usage, [{ actor: actor.uuid, token: tokenDoc?.uuid ?? null, name: tokenDoc?.name ?? actor.name }]);
  }
  return { activity, usage };
}

/**
 * On the creature's player's (or the GM's) client: offer the reactions, use the
 * chosen one. Resolves with { identifier, … } or null. Opportunity attacks are
 * answered here too (opportunity.mjs), so they share the one reaction.
 */
export async function answerReaction(payload) {
  if (payload?.kind === "opportunity") return answerOpportunity(payload);
  if (payload?.kind === "wallSide") return answerWallSide(payload);
  if (payload?.kind === "gift") return answerGift(payload);
  const { token, actor: actorUuid, options, attackerName, itemName, total, ac, when = "hit", targetName, types = [], attackerToken } = payload;
  const { tokenDoc, actor } = await resolveTarget({ token, actor: actorUuid });
  if (!actor?.isOwner) return null;
  // Free ones (Lucky) don't need the reaction.
  const available = (options ?? []).filter(id => REACTIONS[id] && (REACTIONS[id].free || hasReaction(actor)) && reactionItem(actor, id));
  if (!available.length) return null;

  const name = tokenDoc?.name ?? actor.name;
  const context = { attackerName: attackerName ?? "the attacker", types };
  const what = when === "hit"
    ? `<strong>${escapeHTML(attackerName ?? "An attacker")}</strong> hit <strong>${escapeHTML(targetName ?? name)}</strong>
       ${itemName ? `with ${escapeHTML(itemName)} ` : ""}(${total}${finite(ac) ? ` vs AC ${ac}` : ""})`
    : when === "damage"
      ? `<strong>${escapeHTML(name)}</strong> is about to take ${escapeHTML(types.join(", ") || "")} damage from ${escapeHTML(attackerName ?? "an attack")}`
      : `<strong>${escapeHTML(attackerName ?? "A creature")}</strong> damaged <strong>${escapeHTML(name)}</strong>`;
  const onlyFree = available.every(id => REACTIONS[id].free);
  const choice = await promptChoice(onlyFree ? "Lucky" : "Reaction",
    `<p>${what}. ${onlyFree ? `Spend one of ${escapeHTML(name)}'s Luck Points?` : `Use ${escapeHTML(name)}'s reaction?`}</p>`,
    [...available.map(id => ({ action: id, label: REACTIONS[id].label(actor, context) })), { action: "none", label: onlyFree ? "No" : "No Reaction" }]);
  if (!REACTIONS[choice]) return null;
  // Spent while this prompt was open (another prompt for the same creature)?
  if (!REACTIONS[choice].free && !hasReaction(actor)) return null;

  if (choice === "lucky") {
    const d20 = await useLuckyAgainst(actor);
    return d20 === null ? null : { identifier: choice, label: "Lucky", by: name, luckyD20: d20 };
  }

  const item = reactionItem(actor, choice);
  const reaction = REACTIONS[choice];
  if (reaction.manual) {
    // An invocation used here: its uses (if it has any) and the reaction.
    if (item.system?.uses?.max) await spendUses(item, 1);
    await spendReaction(actor);
    const result = { identifier: choice, label: reaction.label(actor, context), by: name };
    if (choice === "rebuke-of-the-talisman") result.rebuke = prof(actor);
    if (choice === "tomb-of-levistus") result.tempHP = tombHP(actor);
    return result;
  }
  const aim = attackerToken ? await fromUuid(attackerToken) : null;
  spending.add(actor.uuid); // while dnd5e's window for it is open
  const used = await useReaction(item, actor, tokenDoc, { aim: choice === "hellish-rebuke" ? aim : null })
    .finally(() => spending.delete(actor.uuid));
  if (!used) return null;
  await spendReaction(actor);

  const result = { identifier: choice, label: reaction.label(actor, context), by: name };
  if (reaction.acBonus) result.acBonus = reaction.acBonus(actor);
  if (reaction.multiplier) result.multiplier = reaction.multiplier;
  if (choice === "cutting-words") {
    const roll = await new Roll(`1${bardicDie(actor)}`).evaluate();
    if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true, null, false);
    result.penalty = roll.total;
  }
  if (choice === "absorb-elements") result.types = types.filter(t => ELEMENTS.includes(t));
  if (choice === "parry") {
    const rolls = await used.activity.rollDamage?.({}, { configure: false }, { create: false });
    result.reduce = Math.max(0, (rolls ?? []).reduce((sum, r) => sum + (r.total ?? 0), 0));
  }
  return result;
}

// ── Asker side ────────────────────────────────────────────────────────────────

// Reaction prompts this client is waiting on, by request id.
export const pendingReactions = new Map();

/** Ask whoever answers for this creature; resolves with their answer or null (timeout, nobody). */
export function askReaction(actor, payload, { timeout: wait = RESPONSE_TIMEOUT } = {}) {
  const player = activePlayerOwner(actor);
  const gm = getPrimaryGM() ?? (game.user.isGM ? game.user : null);
  const responder = player ?? gm;
  if (!responder) return Promise.resolve(null);
  if (responder.id === game.user.id) return answerReaction(payload);
  if (!socket) return Promise.resolve(null);
  const requestId = foundry.utils.randomID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { pendingReactions.delete(requestId); resolve(null); }, wait);
    pendingReactions.set(requestId, (result) => { clearTimeout(timeout); pendingReactions.delete(requestId); resolve(result ?? null); });
    const message = { ...payload, requestId, from: game.user.id };
    if (player) socket.emit("offerReaction", { ...message, to: player.id });
    else socket.emit("offerReactionGM", message);
  });
}

/** Whether this creature is asked under the setting (player characters only, or everyone). */
function asksFor(actor, mode) {
  return !!actor && mode !== "off" && (mode === "all" || actor.type === "character");
}

const tokenOf = (token) => token?.document ?? token ?? null;
const usableBy = (tokenDoc) => tokenDoc?.actor && !INCAPACITATING.some(s => tokenDoc.actor.statuses?.has?.(s));

/** The target's allies (and itself) within 60 ft of the attacker that can see it — for Cutting Words / Silvery Barbs. */
async function bystanders(targetDoc, attackerDoc) {
  if (!targetDoc?.parent || !attackerDoc) return [];
  return [...targetDoc.parent.tokens].filter(t => usableBy(t) && t.id !== attackerDoc.id && t.disposition === targetDoc.disposition
    && tokenDistance(t, attackerDoc) <= 60 && hasLineOfSight(t, attackerDoc));
}

/**
 * After an attack (and the attacker's Luck Dice): offer reactions to each
 * creature it hit, then to their allies with reactions that change the roll;
 * write what they did onto the card. The roll and targets are judged again
 * after each answer, so nobody is asked once the attack has missed.
 */
export async function offerReactions(message, activity) {
  const mode = getReactionPrompts();
  if ((mode === "off" && !isRollBoostsEnabled()) || !message?.system || message.getFlag?.(MODULE_ID, REACTIONS_FLAG)) return;
  const attackerDoc = tokenOf(activity?.getUsageToken?.() ?? activity?.actor?.getActiveTokens?.()?.[0]);
  const melee = activity?.attack?.type?.value === "melee" && !String(message.system?.mode ?? "").startsWith("thrown");
  const targets = foundry.utils.deepClone(message.system.targets ?? []);
  let roll = message.rolls?.[0];
  const record = [];
  const state = () => {
    const total = Number(roll?.total ?? 0), critical = !!roll?.isCritical;
    return targets.map(t => ({ ...t, isMiss: (t.ac === null) || (!critical && total < t.ac) || !!roll?.isFumble }))
      .filter(t => !t.isMiss);
  };
  const ask = async (who, hit, ally, exclude = []) => {
    const context = { total: Number(roll?.total ?? 0), ac: hit.ac, critical: !!roll?.isCritical, melee, d20: Number(getKeptD20Result(roll)),
      attackerWithin30: !!attackerDoc && tokenDistance(who, attackerDoc) <= 30 && hasLineOfSight(who, attackerDoc) };
    const options = reactionOptions(who.actor, context, "hit", { ally, reactions: asksFor(who.actor, mode) })
      .filter(id => !exclude.includes(id));
    if (!options.length) return null;
    return askReaction(who.actor, {
      token: who.uuid, actor: who.actor.uuid, options, attackerName: activity?.actor?.name, itemName: activity?.item?.name,
      total: Number(roll?.total ?? 0), ac: hit.ac, targetName: hit.name
    });
  };
  const stillHit = (hit) => state().find(h => h.token === hit.token) ?? null;

  for (const hit of state()) {
    const targetDoc = hit.token ? await fromUuid(hit.token) : null;
    // The creature hit. Lucky isn't a reaction: after it, while the attack still hits, it can still react.
    const answered = [];
    while (targetDoc?.actor && stillHit(hit)) {
      const answer = await ask(targetDoc, stillHit(hit), false, answered);
      if (!answer?.identifier) break;
      answered.push(answer.identifier);
      if (answer.luckyD20 !== undefined) {
        const before = Number(roll?.total ?? 0);
        const lowered = withExtraD20(roll, answer.luckyD20, "lower");
        if (lowered) roll = lowered;
        record.push({ token: hit.token, name: hit.name, by: answer.by,
          reaction: `Lucky (d20 ${answer.luckyD20}${Number(roll?.total) !== before ? `: ${before} → ${roll.total}` : " — no change"})` });
        continue;
      }
      if (answer.acBonus) { const t = targets.find(x => x.token === hit.token); if (t && finite(t.ac)) t.ac += answer.acBonus; }
      if (answer.rebuke && attackerDoc) await rebuke(targetDoc, attackerDoc, answer.rebuke);
      record.push({ token: hit.token, name: hit.name, reaction: answer.label, by: answer.by,
        ...(answer.multiplier ? { multiplier: answer.multiplier } : {}) });
      break;
    }
    // Its allies, while the attack still hits it.
    for (const ally of await bystanders(targetDoc, attackerDoc)) {
      if (!stillHit(hit)) break;
      if (!asksFor(ally.actor, mode)) continue;
      const answer = await ask(ally, state().find(h => h.token === hit.token), true);
      if (!answer?.identifier) continue;
      const before = Number(roll?.total ?? 0);
      if (answer.penalty) {
        const minus = await new Roll(`-${answer.penalty}`).evaluate();
        roll = combineRolls(roll, minus);
      } else if (answer.identifier === "silvery-barbs") {
        const again = await LDA.evaluateReroll(roll);
        if (again && Number(again.total) < before) roll = again;
      }
      record.push({ token: hit.token, name: hit.name, by: answer.by,
        reaction: `${answer.label}${Number(roll?.total) !== before ? ` (${before} → ${roll.total})` : ""}` });
    }
  }
  if (!record.length) return;
  const update = { "system.targets": targets, [`flags.${MODULE_ID}.${REACTIONS_FLAG}`]: record };
  if (roll !== message.rolls?.[0]) update.rolls = [roll, ...message.rolls.slice(1)];
  await message.update(update);
  console.log(`[${MODULE_ID}] reactions: ${record.map(r => `${r.by ?? r.name} — ${r.reaction}`).join(", ")}`);
}

/** Rebuke of the Talisman: psychic damage to the attacker, and a push of up to 10 ft away from the wearer. */
async function rebuke(wearerDoc, attackerDoc, amount) {
  await dealInvocationDamage(wearerDoc.actor, `Rebuke of the Talisman — ${wearerDoc.name}`, amount, "psychic", [attackerDoc]);
  const dest = pushDestination(wearerDoc, attackerDoc);
  if (dest) await applyMasteryChange({ kind: "push", token: attackerDoc.uuid, actor: attackerDoc.actor?.uuid, x: dest.x, y: dest.y });
}

/** Tomb of Levistus's ice: Incapacitated, speed 0 and vulnerable to fire until the end of the warlock's next turn. */
export const tombEffect = () => ({
  name: "Tomb of Levistus", img: "icons/svg/frozen.svg", type: "base", transfer: false, disabled: false,
  statuses: ["incapacitated"],
  duration: { value: 1, units: "rounds", expiry: "turnEnd" },
  // Magical: dnd5e 6.1+ suppresses it in antimagic (earlier versions ignore the field).
  system: { magical: true, changes: [
    { key: "system.traits.dv.value", type: "add", value: "fire" },
    { key: "system.attributes.movement.speeds.walk", type: "override", value: 0 }
  ] },
  flags: { [MODULE_ID]: { tomb: true } }
});

/** The damage multiplier a reaction gave this target on an attack card (Uncanny Dodge), if any. */
export function reactionMultiplier(attackMessage, tokenUuid) {
  return (attackMessage?.getFlag?.(MODULE_ID, REACTIONS_FLAG) ?? []).find(r => r.token === tokenUuid && r.multiplier)?.multiplier;
}

// ── Damage-time reactions (the GM, applying a damage card) ────────────────────

/** The attack behind a damage card: { activity, melee, attackerDoc } (melee: a melee, non-thrown attack). */
function damageSource(message) {
  const activity = message?.getAssociatedActivity?.() ?? null;
  const mode = String(message?.rolls?.[0]?.options?.attackMode ?? "");
  const melee = isLike(activity, "attack") && activity.attack?.type?.value === "melee" && !mode.startsWith("thrown");
  const attackerDoc = tokenOf(activity?.getUsageToken?.() ?? message?.speakerActor?.getActiveTokens?.()?.[0]);
  return { activity, melee, attackerDoc, attackerName: attackerDoc?.name ?? message?.speakerActor?.name ?? activity?.actor?.name };
}

/**
 * Before a target takes a damage card: Absorb Elements and Parry. Resolves with
 * the damages to apply (adjusted) and notes for the Applied row.
 */
export async function damageReactions(message, target, damages) {
  const mode = getReactionPrompts();
  const { actor, tokenDoc } = await resolveTarget(target);
  const harmful = damages.filter(d => d.value > 0 && !(d.type in CONFIG.DND5E.healingTypes));
  if (!asksFor(actor, mode) || !harmful.length) return { damages, notes: [] };
  const { melee, attackerName } = damageSource(message);
  const types = [...new Set(harmful.map(d => d.type).filter(Boolean))];
  const options = reactionOptions(actor, { types, melee }, "damage");
  if (!options.length) return { damages, notes: [] };
  const answer = await askReaction(actor, { token: tokenDoc?.uuid ?? target.token, actor: actor.uuid, options, when: "damage", types, attackerName });
  if (!answer?.identifier) return { damages, notes: [] };
  if (answer.tempHP) {
    // Tomb of Levistus: the temporary HP take the damage first (this is the GM, applying it); the ice comes after.
    const temp = Number(actor.system?.attributes?.hp?.temp ?? 0) || 0;
    if (answer.tempHP > temp) await actor.update({ "system.attributes.hp.temp": answer.tempHP });
    return { damages, notes: [answer.label], afterApply: () => actor.createEmbeddedDocuments("ActiveEffect", [tombEffect()]) };
  }
  let adjusted = damages.map(d => ({ ...d, properties: new Set(d.properties ?? []) }));
  if (answer.types?.length) {
    adjusted = adjusted.map(d => answer.types.includes(d.type) ? { ...d, value: Math.floor(d.value / 2) } : d);
  }
  if (answer.reduce) {
    let left = answer.reduce;
    for (const d of [...adjusted].sort((a, b) => b.value - a.value)) {
      const cut = Math.min(left, Math.max(0, d.value));
      d.value -= cut; left -= cut;
      if (left <= 0) break;
    }
  }
  return { damages: adjusted, notes: [answer.label] };
}

/** After damage is applied: Hellish Rebuke for those it hurt. Not awaited by the damage application. */
export async function afterDamageReactions(message, applied) {
  const mode = getReactionPrompts();
  if (mode === "off") return;
  const { attackerDoc, attackerName } = damageSource(message);
  if (!attackerDoc) return;
  for (const entry of applied) {
    if (!(entry.amount > 0) || !entry.token) continue;
    const victim = await fromUuid(entry.token);
    if (!usableBy(victim) || !asksFor(victim.actor, mode) || victim.id === attackerDoc.id) continue;
    if (tokenDistance(victim, attackerDoc) > 60 || !hasLineOfSight(victim, attackerDoc)) continue;
    const options = reactionOptions(victim.actor, { attacker: attackerDoc }, "afterDamage");
    if (!options.length) continue;
    askReaction(victim.actor, { token: victim.uuid, actor: victim.actor.uuid, options, when: "afterDamage",
      attackerName, attackerToken: attackerDoc.uuid }).catch(err => console.error(`[${MODULE_ID}] hellish rebuke:`, err));
  }
}

