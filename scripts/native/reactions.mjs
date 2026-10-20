// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Reaction prompts when hit: Shield and Uncanny Dodge.
//
// The "reactionPrompts" setting (off / player characters / everyone). After an
// attack hits — and after the attacker's own Luck Dice — the attacker's client
// checks each creature it hit for a reaction it could use:
//   Shield         — a spell slot left, not a critical hit, and +5 AC would turn
//                    this hit into a miss;
//   Uncanny Dodge  — any hit.
// The creature's active player owner is asked (the primary GM for NPCs, or for
// characters whose player is offline). Shield is cast through dnd5e (spending
// the slot); its +5 AC effect goes on the caster for later attacks, and this
// attack is judged again against the higher AC (the card redraws hit / miss).
// Uncanny Dodge halves that creature's damage when the attack automation applies
// it; the card notes it either way. A creature has one reaction until its next
// turn starts. Unanswered prompts time out as "no reaction".

import { requestApplyEffects } from "./effects.mjs";
import { MODULE_ID, debug, escapeHTML, promptChoice, getReactionPrompts, socket, getPrimaryGM, activePlayerOwner, resolveTarget } from "./shared.mjs";

export const REACTIONS_FLAG = "reactions";
const RESPONSE_TIMEOUT = 60_000;

/** By item identifier. */
export const REACTIONS = {
  "shield": {
    label: "Shield (+5 AC)", acBonus: 5,
    useful: ({ total, ac, critical }) => !critical && Number.isFinite(ac) && total < ac + 5
  },
  "uncanny-dodge": { label: "Uncanny Dodge (half damage)", multiplier: 0.5, useful: () => true }
};

/** Whether the actor has a spell slot (any level, or pact) left. */
function hasSpellSlot(actor) {
  return Object.entries(actor?.system?.spells ?? {}).some(([key, slot]) =>
    (Number(slot?.value) || 0) > 0 && (key === "pact" || Number(key.replace("spell", "")) >= 1));
}

/** The reactions this creature could use against this hit, by identifier. */
export function reactionOptions(actor, hit) {
  const options = [];
  for (const [identifier, reaction] of Object.entries(REACTIONS)) {
    const item = actor?.items?.find?.(i => i.system?.identifier === identifier);
    if (!item || !reaction.useful(hit)) continue;
    if (item.type === "spell" && (item.system?.level ?? 0) > 0 && !hasSpellSlot(actor)) continue;
    options.push(identifier);
  }
  return options;
}

// ── Responder side: who has used their reaction ───────────────────────────────

// Creatures whose reaction is spent, by actor uuid; cleared when their turn starts.
const reactionUsed = new Set();
/** combatTurnChange: the creature whose turn starts has its reaction back. */
export function onTurnStartReaction(combat, current) {
  const actor = (combat?.scene ?? canvas.scene)?.tokens?.get?.(current?.tokenId)?.actor;
  if (actor) reactionUsed.delete(actor.uuid);
}

/**
 * On the creature's player's (or the GM's) client: offer the reactions, use the
 * chosen one. Resolves with { identifier } or null.
 */
export async function answerReaction({ token, actor: actorUuid, options, attackerName, itemName, total, ac }) {
  const { tokenDoc, actor } = await resolveTarget({ token, actor: actorUuid });
  if (!actor?.isOwner || reactionUsed.has(actor.uuid)) return null;
  const available = (options ?? []).filter(id => REACTIONS[id] && actor.items.some(i => i.system?.identifier === id));
  if (!available.length) return null;

  const name = tokenDoc?.name ?? actor.name;
  const choice = await promptChoice(
    "Reaction",
    `<p><strong>${escapeHTML(attackerName ?? "An attacker")}</strong> hit <strong>${escapeHTML(name)}</strong>
     ${itemName ? `with ${escapeHTML(itemName)} ` : ""}(${total}${Number.isFinite(ac) ? ` vs AC ${ac}` : ""}). Use a reaction?</p>`,
    [...available.map(id => ({ action: id, label: REACTIONS[id].label })), { action: "none", label: "No Reaction" }]
  );
  if (!REACTIONS[choice]) return null;

  const item = actor.items.find(i => i.system?.identifier === choice);
  const activity = [...(item?.system?.activities?.values?.() ?? [])][0];
  if (item?.type === "spell") {
    // Cast it through dnd5e: spends the slot, posts its card; then put its effect on the caster.
    const results = await activity?.use?.({}, {}, {});
    if (!results) return null;
    const usage = results.message;
    if (usage?.system?.getEffects?.()?.length || activity?.effects?.length) {
      await requestApplyEffects(usage, [{ actor: actor.uuid, token: tokenDoc?.uuid ?? null, name }]);
    }
  } else if (activity?.use) {
    await activity.use({ consume: true, subsequentActions: false }, { configure: false }, {});
  }
  reactionUsed.add(actor.uuid);
  return { identifier: choice };
}

// ── Asker side: the attacker's client ─────────────────────────────────────────

// Reaction prompts this client is waiting on, by request id.
export const pendingReactions = new Map();

/** Ask whoever answers for this creature; resolves with their answer or null (timeout, nobody). */
function askReaction(actor, payload) {
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

/**
 * After an attack (and the attacker's Luck Dice): offer reactions to each
 * creature it hit, then write what they did onto the card.
 */
export async function offerReactions(message, activity) {
  const mode = getReactionPrompts();
  if (mode === "off" || !message?.system || message.getFlag?.(MODULE_ID, REACTIONS_FLAG)) return;
  const roll = message.rolls?.[0];
  const total = Number(roll?.total ?? 0), critical = !!roll?.isCritical;
  const hits = (message.system.evaluatedTargets ?? []).filter(t => !t.isMiss);
  if (!hits.length) return;

  const answers = await Promise.all(hits.map(async (hit) => {
    const { actor } = await resolveTarget(hit);
    if (!actor || (mode === "players" && actor.type !== "character")) return null;
    const options = reactionOptions(actor, { total, ac: hit.ac, critical });
    if (!options.length) return null;
    const answer = await askReaction(actor, {
      token: hit.token, actor: hit.actor, options, attackerName: activity?.actor?.name, itemName: activity?.item?.name,
      total, ac: hit.ac
    });
    return answer?.identifier && REACTIONS[answer.identifier] ? { hit, identifier: answer.identifier } : null;
  }));
  const used = answers.filter(Boolean);
  if (!used.length) return;

  const targets = foundry.utils.deepClone(message.system.targets ?? []);
  const record = used.map(({ hit, identifier }) => {
    const reaction = REACTIONS[identifier];
    if (reaction.acBonus) {
      const target = targets.find(t => t.token === hit.token);
      if (target && Number.isFinite(target.ac)) target.ac += reaction.acBonus;
    }
    return { token: hit.token, name: hit.name, reaction: reaction.label, ...(reaction.multiplier ? { multiplier: reaction.multiplier } : {}) };
  });
  await message.update({ "system.targets": targets, [`flags.${MODULE_ID}.${REACTIONS_FLAG}`]: record });
  debug(`reactions: ${record.map(r => `${r.name}: ${r.reaction}`).join(", ")}`);
  console.log(`[${MODULE_ID}] reactions: ${record.map(r => `${r.name} — ${r.reaction}`).join(", ")}`);
}

/** The damage multiplier a reaction gave this target on an attack card (Uncanny Dodge), if any. */
export function reactionMultiplier(attackMessage, tokenUuid) {
  return (attackMessage?.getFlag?.(MODULE_ID, REACTIONS_FLAG) ?? []).find(r => r.token === tokenUuid && r.multiplier)?.multiplier;
}
