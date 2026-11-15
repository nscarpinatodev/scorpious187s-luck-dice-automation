// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// The 2024 smite spells, under the "onHitRiders" setting: Searing, Thunderous, Wrathful and Shining Smite.
//
// Each is a bonus action spell cast right after a hit with a melee weapon or an Unarmed Strike, so it's
// offered with the hit's damage like Divine Smite (riders.mjs): cast through dnd5e (its window picks the
// slot), its dice join the hit. Then (smiteAfter), at the creature hit:
//   Searing Smite    — "Seared" (its effect) goes on; at the start of each of its turns it takes the spell's
//                      fire damage and makes a Constitution save, the spell ending on a success
//                      (onTurnStartSearing, with the save automation in Full);
//   Thunderous Smite — a Strength save, or pushed 10 ft away and Prone;
//   Wrathful Smite   — a Wisdom save, or Frightened (its effect; repeat saves end it as usual);
//   Shining Smite    — "Shining" (its effect): it can't be Invisible, and attack rolls against it have
//                      Advantage (advantage.mjs reads it).
// The saves go through the save automation (Luck Dice, Legendary Resistance). 2014 Branding Smite, cast before
// the attack, is left to dnd5e (its "Bonus Damage On Hit" button).

import { automateSaves } from "./saves.mjs";
import { requestApplyEffects } from "./effects.mjs";
import { applyMasteryChange, pushDestination } from "./mastery.mjs";
import { effectsFrom, sourceItem } from "./advantage.mjs";
import { useClaimed } from "./riders.mjs";
import { MODULE_ID, debug, getSaveAutomation, isOnHitRidersEnabled, isLike } from "./shared.mjs";

export const SMITES = ["searing-smite", "thunderous-smite", "wrathful-smite", "shining-smite"];
const activitiesOf = (item) => [...(item?.system?.activities?.values?.() ?? [])];
const doc = (token) => token?.document ?? token ?? null;

/** The smite's save on a hit (Thunderous, Wrathful) — not Searing's start-of-turn save. */
const hitSave = (item) => activitiesOf(item).find(a => isLike(a, "save") && !/start of turn/i.test(a.name ?? ""));

/**
 * A rider's after step (riders.mjs), once the smite's dice are on the hit: its effect on the creatures hit
 * (Seared, Shining), then its save (Thunderous: pushed and Prone; Wrathful: Frightened). Resolves with notes.
 */
export async function smiteAfter(choice, { activity, hits }) {
  const notes = [];
  const usage = choice.usage ?? null;
  const targets = hits.map(h => ({ actor: h.actor, token: h.token, name: h.name }));
  if (!targets.length) return notes;
  // The damage activity's own effect (Seared, Shining), applied as dnd5e's effects tray would (each target, every effect).
  const effectIds = usage ? ((await usage.system?.getEffects?.()) ?? []).map(e => e.id) : [];
  if (usage && effectIds.length) {
    await requestApplyEffects(usage, targets.map(t => ({ ...t, effectIds })));
    notes.push(`${choice.item.name.replace(/ Smite$/, "")} on ${targets.map(t => t.name).join(", ")}`);
  }
  const save = hitSave(choice.item);
  const mode = getSaveAutomation();
  if (!save || mode === "off") return notes;
  // The save's own card (nothing spent, no follow-ups of its own: the slot went with the damage), so its effect
  // (Prone, Frightened) is the one applied on a failure.
  const saveUsage = (await useClaimed(save, { consume: false, [MODULE_ID]: { noCounter: true } }, { configure: false })
    .catch(() => null))?.message ?? usage;
  const outcome = await automateSaves(save, targets, saveUsage, mode);
  if (choice.identifier === "thunderous-smite" && outcome) {
    const attackerDoc = doc(activity?.getUsageToken?.() ?? activity?.actor?.getActiveTokens?.()?.[0]);
    for (const t of targets) {
      const result = outcome.get?.(t.token);
      if (!result || result.passed) continue;
      const targetDoc = t.token ? await fromUuid(t.token) : null;
      const dest = attackerDoc && targetDoc ? pushDestination(attackerDoc, targetDoc, 10) : null;
      if (dest) await applyMasteryChange({ kind: "push", token: t.token, actor: t.actor, x: dest.x, y: dest.y });
      notes.push(`${t.name} pushed 10 ft`);
    }
  }
  return notes;
}

// ── Searing Smite, at the start of the creature's turn ────────────────────────

/** The Seared effect on a creature, and the Searing Smite it came from. */
function searedBy(actor) {
  const effect = effectsFrom(actor, "searing-smite")[0];
  const item = effect ? sourceItem(effect) : null;
  return effect && item ? { effect, item } : null;
}

/**
 * combatTurnChange (the primary GM): a Seared creature whose turn starts takes the spell's fire damage and makes
 * a Constitution save (the save automation in Full); a success ends it.
 */
export async function onTurnStartSearing(combat, current, { isTrigger = () => true } = {}) {
  if (!isOnHitRidersEnabled() || !isTrigger() || getSaveAutomation() !== "full") return;
  const tokenDoc = (combat?.scene ?? canvas?.scene)?.tokens?.get?.(current?.tokenId);
  const actor = tokenDoc?.actor;
  const seared = searedBy(actor);
  if (!seared) return;
  const save = activitiesOf(seared.item).find(a => isLike(a, "save"));
  if (!save) return;
  const outcome = await automateSaves(save, [{ actor: actor.uuid, token: tokenDoc.uuid, name: tokenDoc.name }], null, "full");
  if (outcome?.get?.(tokenDoc.uuid)?.passed) {
    await seared.effect.delete().catch(() => null);
    debug(`searing smite: ${tokenDoc.name} put out the flames`);
  }
}
