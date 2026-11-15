// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Mirror Image, under the "attackAdvantage" setting (Blur, the other illusion, is in advantage.mjs).
//
// Each duplicate is one of the spell's effects on the caster (three to start, in both rulesets). After an
// attack roll is settled (its Luck Dice; before reactions), for each creature it targeted that has
// duplicates left — unless the attacker is Blinded or has blindsight or truesight:
//   2024 — on a hit, a d6 per duplicate: any 3 or higher, a duplicate is hit instead and destroyed;
//   2014 — any attack, a d20: 6+ with three duplicates, 8+ with two, 11+ with one, and the attack is at a
//          duplicate instead (AC 10 + the caster's Dexterity modifier): destroyed if it hits.
// When a duplicate takes it, the creature itself isn't hit (its target entry on the card counts as a miss),
// so no damage, riders or reactions follow for it. What happened is noted on the attack card.

import { effectsFrom, sourceItem, rulesOf, seesThroughIllusions, removeMark } from "./advantage.mjs";
import { MODULE_ID, debug, isAttackAdvantageEnabled } from "./shared.mjs";

export const MIRROR_FLAG = "mirrorImage"; // on the attack card: [note]
const THRESHOLDS = { 3: 6, 2: 8, 1: 11 };

/** The creature's remaining duplicates (Mirror Image's effects on it). */
export const duplicatesOf = (actor) => effectsFrom(actor, "mirror-image");

async function rollDice(formula) {
  const roll = await new Roll(formula).evaluate();
  if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true, null, false);
  return roll;
}

/** After the attack roll (the attacker's client): duplicates take hits meant for the creature. */
export async function applyMirrorImage(message, activity) {
  if (!isAttackAdvantageEnabled() || !message?.system || message.getFlag?.(MODULE_ID, MIRROR_FLAG)) return;
  const attacker = activity?.actor;
  if (!attacker || attacker.statuses?.has?.("blinded") || seesThroughIllusions(attacker)) return;
  const roll = message.rolls?.[0];
  const total = Number(roll?.total ?? 0), critical = !!roll?.isCritical, fumble = !!roll?.isFumble;
  const hits = (ac) => critical || (!fumble && total >= ac);
  const targets = foundry.utils.deepClone(message.system.targets ?? []);
  const notes = [];
  let changed = false;
  for (const t of targets) {
    if (!Number.isFinite(t.ac)) continue;
    const actor = (t.token ? (await fromUuid(t.token))?.actor : null) ?? (t.actor ? await fromUuid(t.actor) : null);
    const duplicates = duplicatesOf(actor);
    if (!duplicates.length) continue;
    const count = duplicates.length;
    if (rulesOf(sourceItem(duplicates[0])) !== "2014") {
      if (!hits(t.ac)) continue;
      const d6 = await rollDice(`${count}d6`);
      const faces = d6.dice?.[0]?.results?.length ? d6.dice[0].results.map(r => r.result) : [Number(d6.total)];
      if (faces.some(f => f >= 3)) {
        await removeMark(duplicates[0].uuid);
        t.ac = null; changed = true;
        notes.push(`${t.name}: a duplicate was hit instead (d6: ${faces.join(", ")}) — ${count - 1} left`);
      } else notes.push(`${t.name}: no duplicate took it (d6: ${faces.join(", ")})`);
    } else {
      const need = THRESHOLDS[Math.min(3, count)];
      const d20 = await rollDice("1d20");
      if (d20.total < need) { notes.push(`${t.name}: not a duplicate (d20 ${d20.total}, ${need}+ needed)`); continue; }
      const dupAC = 10 + (Number(actor.system?.abilities?.dex?.mod ?? 0) || 0);
      t.ac = null; changed = true;
      if (hits(dupAC)) {
        await removeMark(duplicates[0].uuid);
        notes.push(`${t.name}: the attack hit a duplicate (d20 ${d20.total}; AC ${dupAC}), destroying it — ${count - 1} left`);
      } else notes.push(`${t.name}: the attack went at a duplicate (d20 ${d20.total}) and missed it (AC ${dupAC})`);
    }
  }
  if (!notes.length) return;
  const update = { [`flags.${MODULE_ID}.${MIRROR_FLAG}`]: notes };
  if (changed) update["system.targets"] = targets;
  await message.update(update);
  debug(`mirror image: ${notes.join("; ")}`);
}
