// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Studied Attacks (2024 Fighter 13), under the "attackAdvantage" setting.
//
// When the fighter's attack misses a creature (after Luck Dice, boosts and reactions
// have settled the result), the fighter gets a mark: Advantage on its next attack roll
// against that creature before the end of its next turn. It's the same kind of mark
// as Vex (an effect on the attacker, timed by dnd5e's "sourceEnd" expiry), read by
// the advantage checks (advantage.mjs) and used up by that attack. Marks against
// different creatures stand side by side; a new miss against the same creature
// replaces its old mark. What it did is noted on the attack card.

import { applyMasteryChange, masteryEffect, MASTERY_FLAG } from "./mastery.mjs";
import { MODULE_ID, debug, isAttackAdvantageEnabled } from "./shared.mjs";

export const STUDIED_FLAG = "studiedAttacks"; // on the attack card: { text }
export const STUDIED = "studied-attacks";     // the mark's kind

const feature = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;

/** After the attack (on the attacker's client): a Studied Attacks mark for each creature it missed. */
export async function applyStudiedAttacks(message, activity) {
  const actor = activity?.actor;
  if (!isAttackAdvantageEnabled() || !actor || !message?.system || message.getFlag?.(MODULE_ID, STUDIED_FLAG)) return;
  if (!feature(actor, STUDIED)) return;
  const misses = (message.system.evaluatedTargets ?? []).filter(t => t.isMiss && Number.isFinite(t.ac) && t.token);
  if (!misses.length) return;
  for (const miss of misses) {
    // A newer miss against the same creature replaces the old mark (a fresh duration).
    for (const old of [...(actor.effects ?? [])].filter(e => {
      const mark = e.getFlag?.(MODULE_ID, MASTERY_FLAG);
      return mark?.kind === STUDIED && mark.target === miss.token;
    })) {
      try { if (old.isOwner) await old.delete(); } catch { /* already used up */ }
    }
    const effect = masteryEffect(STUDIED, actor, miss.token, {
      name: `Studied Attacks: ${miss.name}`, img: "icons/svg/eye.svg", expiry: "sourceEnd"
    });
    await applyMasteryChange({ kind: STUDIED, actor: actor.uuid, effect });
  }
  const text = `Advantage on the next attack against ${misses.map(m => m.name).join(", ")}, before the end of ${actor.name}'s next turn`;
  await message.setFlag(MODULE_ID, STUDIED_FLAG, { text });
  debug(`studied attacks: ${actor.name} — ${text}`);
}
