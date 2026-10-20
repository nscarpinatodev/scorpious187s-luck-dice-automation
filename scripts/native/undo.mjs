// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Undo: giving back what the automation applied — HP / temp HP and effects — per target or all.

import { sourceHP } from "./apply.mjs";
import { MODULE_ID, clamp, APPLIED_FLAG, APPLIED_EFFECTS_FLAG } from "./shared.mjs";

// ── Undo ──────────────────────────────────────────────────────────────────────
// A GM button on the Applied and Effects rows reverses what the automation
// applied on that card. HP comes back by the recorded delta — added to the
// current values rather than restoring the old ones — so damage or healing that
// happened since isn't erased. Not reversed: dnd5e's own follow-ups (the
// concentration check it prompts on damage, Downed / Unconscious, death saves,
// effects ended by a broken concentration).

/** Resolve an applied entry's actor: its token's actor first, then the actor uuid. */
export async function appliedActor(entry) {
  return (entry.token ? (await fromUuid(entry.token))?.actor : null) ?? (entry.actor ? await fromUuid(entry.actor) : null);
}

/** GM: give back the HP / temp HP the automation changed on this card — every target's, or the one at `index`. */
export async function undoAppliedDamage(message, index = null) {
  const applied = foundry.utils.deepClone(message.getFlag(MODULE_ID, APPLIED_FLAG) ?? []);
  const undone  = [];
  for (const [i, entry] of applied.entries()) {
    if ((index !== null && i !== index) || entry.undone || !entry.hp) continue;
    const actor = await appliedActor(entry);
    if (actor) {
      const now = sourceHP(actor);
      const max = Number(actor.system.attributes?.hp?.effectiveMax ?? actor.system.attributes?.hp?.max ?? Infinity);
      await actor.update({
        "system.attributes.hp.value":   clamp(now.value + entry.hp.value, 0, max),
        "system.attributes.hp.temp":    Math.max(0, now.temp + entry.hp.temp),
        "system.attributes.hp.tempmax": now.tempmax + entry.hp.tempmax
      });
    }
    entry.undone = true;
    undone.push(entry.name);
  }
  await message.setFlag(MODULE_ID, APPLIED_FLAG, applied);
  console.log(`[${MODULE_ID}] undoAppliedDamage: ${undone.join(", ") || "nothing to undo"}`);
}

/**
 * GM: remove effects the automation created on this card, re-disable ones it
 * re-enabled — for every target, or the one at `index`.
 */
export async function undoAppliedEffects(message, index = null) {
  const record = foundry.utils.deepClone(message.getFlag(MODULE_ID, APPLIED_EFFECTS_FLAG) ?? []);
  const undone = [];
  for (const [i, entry] of record.entries()) {
    if ((index !== null && i !== index) || entry.undone) continue;
    for (const step of entry.undo ?? []) {
      const effect = await fromUuid(step.effect);
      if (!effect) continue; // already gone (e.g. ended with concentration)
      if (step.action === "create") await effect.delete();
      else await effect.update({ disabled: true });
    }
    entry.undone = true;
    undone.push(entry.name);
  }
  await message.setFlag(MODULE_ID, APPLIED_EFFECTS_FLAG, record);
  console.log(`[${MODULE_ID}] undoAppliedEffects: ${undone.join(", ") || "nothing to undo"}`);
}
