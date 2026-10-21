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
// primary GM. A creature has one reaction until its next turn starts. Unanswered
// prompts time out as "no reaction".

import { requestApplyEffects } from "./effects.mjs";
import { tokenDistance, hasLineOfSight } from "./advantage.mjs";
import { answerOpportunity } from "./opportunity.mjs";
import { answerWallSide } from "./walls.mjs";
import {
  LDA, MODULE_ID, escapeHTML, promptChoice, getReactionPrompts, socket, getPrimaryGM, activePlayerOwner,
  resolveTarget, combineRolls
} from "./shared.mjs";

export const REACTIONS_FLAG = "reactions";
const RESPONSE_TIMEOUT = 60_000;
const ELEMENTS = ["acid", "cold", "fire", "lightning", "thunder"];
const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];
const finite = (n) => Number.isFinite(n);
const prof = (actor) => Number(actor?.system?.attributes?.prof ?? 0) || 0;
const wieldsFinesse = (actor) => [...(actor?.items ?? [])].some(i => i.type === "weapon" && i.system?.equipped !== false
  && i.system?.properties?.has?.("fin"));

/** A Bardic Inspiration die from the actor's scale values ("d8"), or d6. */
function bardicDie(actor) {
  const scale = actor?.system?.scale ?? {};
  for (const values of Object.values(scale)) {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!/inspiration/i.test(key)) continue;
      const die = value?.die ?? value?.formula ?? (typeof value === "string" ? value : null);
      if (typeof die === "string" && /^\d*d\d+$/.test(die)) return die.startsWith("d") ? die : die.replace(/^\d+/, "");
    }
  }
  return "d6";
}
const dieMax = (die) => Number(String(die).replace(/^\d*d/, "")) || 6;

/** By item identifier. `when`: hit / damage / afterDamage; `ally`: asked of the target's allies, not the target. */
export const REACTIONS = {
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
  "hellish-rebuke": { when: "afterDamage", label: (_actor, { attackerName }) => `Hellish Rebuke at ${attackerName}`, useful: ({ attacker }) => !!attacker }
};

/** Whether the actor has a spell slot (any level, or pact) left. */
function hasSpellSlot(actor) {
  return Object.entries(actor?.system?.spells ?? {}).some(([key, slot]) =>
    (Number(slot?.value) || 0) > 0 && (key === "pact" || Number(key.replace("spell", "")) >= 1));
}

/** The reactions this creature could use at this moment (`when`), by identifier. */
export function reactionOptions(actor, context, when = "hit", { ally = false } = {}) {
  const options = [];
  for (const [identifier, reaction] of Object.entries(REACTIONS)) {
    if (reaction.when !== when || !!reaction.ally !== ally) continue;
    const item = actor?.items?.find?.(i => i.system?.identifier === identifier);
    if (!item || !reaction.useful({ ...context, actor })) continue;
    if (item.type === "spell" && (item.system?.level ?? 0) > 0 && !hasSpellSlot(actor)) continue;
    options.push(identifier);
  }
  return options;
}

// ── Responder side: who has used their reaction ───────────────────────────────

// Creatures whose reaction is spent, by actor uuid; cleared when their turn starts.
const reactionUsed = new Set();
export const hasReaction = (actor) => !!actor && !reactionUsed.has(actor.uuid);
export const spendReaction = (actor) => { if (actor) reactionUsed.add(actor.uuid); };

/** combatTurnChange: the creature whose turn starts has its reaction back. */
export function onTurnStartReaction(combat, current) {
  const actor = (combat?.scene ?? canvas.scene)?.tokens?.get?.(current?.tokenId)?.actor;
  if (actor) reactionUsed.delete(actor.uuid);
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
  const { token, actor: actorUuid, options, attackerName, itemName, total, ac, when = "hit", targetName, types = [], attackerToken } = payload;
  const { tokenDoc, actor } = await resolveTarget({ token, actor: actorUuid });
  if (!actor?.isOwner || !hasReaction(actor)) return null;
  const available = (options ?? []).filter(id => REACTIONS[id] && actor.items.some(i => i.system?.identifier === id));
  if (!available.length) return null;

  const name = tokenDoc?.name ?? actor.name;
  const context = { attackerName: attackerName ?? "the attacker", types };
  const what = when === "hit"
    ? `<strong>${escapeHTML(attackerName ?? "An attacker")}</strong> hit <strong>${escapeHTML(targetName ?? name)}</strong>
       ${itemName ? `with ${escapeHTML(itemName)} ` : ""}(${total}${finite(ac) ? ` vs AC ${ac}` : ""})`
    : when === "damage"
      ? `<strong>${escapeHTML(name)}</strong> is about to take ${escapeHTML(types.join(", ") || "")} damage from ${escapeHTML(attackerName ?? "an attack")}`
      : `<strong>${escapeHTML(attackerName ?? "A creature")}</strong> damaged <strong>${escapeHTML(name)}</strong>`;
  const choice = await promptChoice("Reaction", `<p>${what}. Use ${escapeHTML(name)}'s reaction?</p>`,
    [...available.map(id => ({ action: id, label: REACTIONS[id].label(actor, context) })), { action: "none", label: "No Reaction" }]);
  if (!REACTIONS[choice]) return null;

  const item = actor.items.find(i => i.system?.identifier === choice);
  const aim = attackerToken ? await fromUuid(attackerToken) : null;
  const used = await useReaction(item, actor, tokenDoc, { aim: choice === "hellish-rebuke" ? aim : null });
  if (!used) return null;
  spendReaction(actor);

  const reaction = REACTIONS[choice];
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
export function askReaction(actor, payload) {
  const player = activePlayerOwner(actor);
  const gm = getPrimaryGM() ?? (game.user.isGM ? game.user : null);
  const responder = player ?? gm;
  if (!responder) return Promise.resolve(null);
  if (responder.id === game.user.id) return answerReaction(payload);
  if (!socket) return Promise.resolve(null);
  const requestId = foundry.utils.randomID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { pendingReactions.delete(requestId); resolve(null); }, RESPONSE_TIMEOUT);
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
  if (mode === "off" || !message?.system || message.getFlag?.(MODULE_ID, REACTIONS_FLAG)) return;
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
  const ask = async (who, hit, ally) => {
    const options = reactionOptions(who.actor, { total: Number(roll?.total ?? 0), ac: hit.ac, critical: !!roll?.isCritical, melee }, "hit", { ally });
    if (!options.length) return null;
    return askReaction(who.actor, {
      token: who.uuid, actor: who.actor.uuid, options, attackerName: activity?.actor?.name, itemName: activity?.item?.name,
      total: Number(roll?.total ?? 0), ac: hit.ac, targetName: hit.name
    });
  };

  for (const hit of state()) {
    const targetDoc = hit.token ? await fromUuid(hit.token) : null;
    // The creature hit.
    if (asksFor(targetDoc?.actor, mode)) {
      const answer = await ask(targetDoc, hit, false);
      if (answer?.identifier) {
        if (answer.acBonus) { const t = targets.find(x => x.token === hit.token); if (t && finite(t.ac)) t.ac += answer.acBonus; }
        record.push({ token: hit.token, name: hit.name, reaction: answer.label, by: answer.by,
          ...(answer.multiplier ? { multiplier: answer.multiplier } : {}) });
      }
    }
    // Its allies, while the attack still hits it.
    for (const ally of await bystanders(targetDoc, attackerDoc)) {
      if (!state().some(h => h.token === hit.token) || !asksFor(ally.actor, mode)) break;
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

/** The damage multiplier a reaction gave this target on an attack card (Uncanny Dodge), if any. */
export function reactionMultiplier(attackMessage, tokenUuid) {
  return (attackMessage?.getFlag?.(MODULE_ID, REACTIONS_FLAG) ?? []).find(r => r.token === tokenUuid && r.multiplier)?.multiplier;
}

// ── Damage-time reactions (the GM, applying a damage card) ────────────────────

/** The attack behind a damage card: { activity, melee, attackerDoc } (melee: a melee, non-thrown attack). */
function damageSource(message) {
  const activity = message?.getAssociatedActivity?.() ?? null;
  const mode = String(message?.rolls?.[0]?.options?.attackMode ?? "");
  const melee = activity?.type === "attack" && activity.attack?.type?.value === "melee" && !mode.startsWith("thrown");
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
  if (!asksFor(actor, mode) || damages.every(d => d.value <= 0)) return { damages, notes: [] };
  const { melee, attackerName } = damageSource(message);
  const types = [...new Set(damages.filter(d => d.value > 0).map(d => d.type).filter(Boolean))];
  const options = reactionOptions(actor, { types, melee }, "damage");
  if (!options.length) return { damages, notes: [] };
  const answer = await askReaction(actor, { token: tokenDoc?.uuid ?? target.token, actor: actor.uuid, options, when: "damage", types, attackerName });
  if (!answer?.identifier) return { damages, notes: [] };
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

