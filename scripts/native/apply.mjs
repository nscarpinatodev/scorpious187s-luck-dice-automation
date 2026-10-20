// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Applying a damage card to targets on the GM's client, recorded for the Applied row and Undo.

import { isPrivateGMCard, useKey, playerTargets, recordOutcome, outcomeTitle } from "./outcome.mjs";
import { MODULE_ID, getPrivateRollOutcome, APPLIED_FLAG, socket } from "./shared.mjs";

/** Apply a damage card to targets — directly as a GM, otherwise via the primary GM. */
export async function requestApplyDamage(damageMessage, targets, { outcomeKey } = {}) {
  const payload = {
    messageId: damageMessage.id,
    outcomeKey,
    targets:   targets.map(({ actor, token, name, multiplier, saved, hits, luck }) => ({ actor, token, name, multiplier, saved, hits, luck }))
  };
  if (game.user.isGM) return applyCardDamage(payload);

  const primaryGM = game.modules.get("scorpious187s-lib")?.api?.utils?.primaryGM?.();
  if (!socket || !primaryGM) {
    ui.notifications?.warn("Luck Dice Automation: no GM is connected, so the damage wasn't applied — use the damage card's tray.");
    return;
  }
  socket.emit("applyDamage", payload);
}

/**
 * GM side: apply every DamageRoll on the card to each target, aggregated the way
 * dnd5e's own chat damage application does it, and note what was applied on the
 * card. A target's optional multiplier scales its damage (a successful save:
 * ½ or 0 per the activity's on-save rule); `saved` marks it on the card. Its
 * optional `hits` applies the card that many times, each a separate instance of
 * damage (Magic Missile's darts: resistance per dart, a concentration check each);
 * the card's Luck Dice go on one of them only — the first, for the target marked
 * `luck` — and no other target gets them.
 */
export async function applyCardDamage({ messageId, targets, outcomeKey }) {
  const message   = game.messages.get(messageId);
  const aggregate = globalThis.dnd5e?.dice?.aggregateDamageRolls;
  if (!message || !aggregate) {
    console.error(`[${MODULE_ID}] applyCardDamage: ${message ? "dnd5e.dice.aggregateDamageRolls missing" : `no message ${messageId}`}`);
    return;
  }
  const damageRolls = message.rolls.filter(r => r instanceof CONFIG.Dice.DamageRoll);
  if (!damageRolls.length) return;

  const toDamages = (rolls) => aggregate(rolls, { respectProperties: true }).map(roll => ({
    value:      Math.max(0, roll.total) * (roll.options.type in CONFIG.DND5E.healingTypes ? -1 : 1),
    type:       roll.options.type,
    properties: new Set(roll.options.properties ?? [])
  }));
  const damages     = toDamages(damageRolls);
  const baseRolls   = damageRolls.filter(r => !r.options?.ldaLuckDice);
  const baseDamages = baseRolls.length < damageRolls.length ? toDamages(baseRolls) : damages;

  const applied = [];
  for (const target of targets ?? []) {
    const actor = (await fromUuid(target.token))?.actor ?? await fromUuid(target.actor);
    if (!actor?.applyDamage) continue;
    const multiplier = Number.isFinite(target.multiplier) ? target.multiplier : 1;
    // Each instance of damage this target takes: the whole card once, or per projectile.
    const instances = Number.isFinite(target.hits)
      ? Array.from({ length: Math.max(1, Math.floor(target.hits)) }, (_, i) => (target.luck && i === 0) ? damages : baseDamages)
      : [damages];
    let amount = 0;
    const before = sourceHP(actor);
    for (const instance of instances) {
      amount += Number(actor.calculateDamage?.(instance, { multiplier })?.amount ?? 0);
      await actor.applyDamage(instance, { multiplier, isDelta: true, originatingMessage: message });
    }
    const after  = sourceHP(actor);
    const hits   = instances.length;
    applied.push({
      token: target.token, actor: actor.uuid, name: target.name ?? actor.name, amount, saved: !!target.saved,
      ...(hits > 1 ? { hits } : {}), ...(target.luck && baseDamages !== damages ? { luck: true } : {}),
      // What this application changed (before − after), for Undo. applyDamage changes exactly these.
      hp: { value: before.value - after.value, temp: before.temp - after.temp, tempmax: before.tempmax - after.tempmax }
    });
  }
  if (applied.length) await message.setFlag(MODULE_ID, APPLIED_FLAG, applied);

  // The GM's private damage card: players learn what happened to their characters.
  if (isPrivateGMCard(message) && getPrivateRollOutcome() === "outcome") {
    const byToken = new Map((targets ?? []).map(t => [t.token, t]));
    const rows = playerTargets(targets).map(t => {
      const entry = applied.find(a => a.token === t.token);
      const saved = byToken.get(t.token)?.saved;
      return { token: t.token, name: t.name, damage: entry?.amount, ...(typeof saved === "boolean" ? { saved } : {}) };
    }).filter(r => Number.isFinite(r.damage));
    const activity = message.getAssociatedActivity?.();
    await recordOutcome(outcomeKey ?? useKey(message), { actor: activity?.actor ?? message.speakerActor, title: outcomeTitle(activity, message) }, rows);
  }
  console.log(`[${MODULE_ID}] applyCardDamage: ${applied.map(a => `${a.name} ${a.amount}`).join(", ") || "no targets"}`);
}

/** An actor's stored HP fields that applyDamage changes. */
export function sourceHP(actor) {
  const hp = actor?.system?._source?.attributes?.hp ?? {};
  return { value: Number(hp.value ?? 0), temp: Number(hp.temp ?? 0), tempmax: Number(hp.tempmax ?? 0) };
}
