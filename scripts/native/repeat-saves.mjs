// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Repeat saves: effects a creature can shake off with a save at the end of each
// of its turns (Hold Person, Tasha's Hideous Laughter, Blindness / Deafness…).
//
// The "repeatSaves" setting. When an effect from one of these spells lands on a
// creature — through the effect automation or dnd5e's effects tray (anything
// that records the casting activity as its origin) — the primary GM's client
// notes its save on the effect. At the end of that creature's turn in combat, the
// save is requested — from its player when they're online (with their Luck
// Dice), otherwise rolled by the GM — and on a success the effect is removed from
// that creature (the caster keeps concentrating for anyone else). Effects tied to
// concentration still end with it, through dnd5e. Not covered: extra saves some
// spells give when the creature takes damage.

import { requestSaves, saveOf } from "./saves.mjs";
import { MODULE_ID, debug, getSaveAutomation, isRepeatSavesEnabled, activePlayerOwner } from "./shared.mjs";
import { isTriggerClient } from "./lingering.mjs";

export const REPEAT_FLAG = "repeatSave";

/** By item identifier: spells whose target repeats the save at the end of each of its turns. */
export const REPEAT_SAVE_SPELLS = new Set([
  "hold-person", "hold-monster", "tashas-hideous-laughter", "hideous-laughter", "blindness-deafness",
  "crown-of-madness", "dominate-person", "dominate-beast", "dominate-monster", "slow", "confusion",
  "phantasmal-killer", "ray-of-enfeeblement", "fear", "flesh-to-stone", "otto-s-irresistible-dance",
  "ottos-irresistible-dance", "mind-spike", "bane"
]);

/** The activity an applied effect came from (dnd5e's effects tray records it). */
async function originActivity(effect) {
  const uuid = effect?.system?.origin?.activity;
  if (!uuid) return null;
  try { return await fromUuid(uuid); } catch { return null; }
}

/**
 * createActiveEffect (primary GM): note the repeat save on an effect one of
 * these spells applied to a creature. Not the caster's own concentration effect.
 */
export async function onEffectCreated(effect) {
  if (!isRepeatSavesEnabled() || !isTriggerClient()) return;
  if (effect?.parent?.documentName !== "Actor" || effect.getFlag?.(MODULE_ID, REPEAT_FLAG)) return;
  if (effect.system?.type === "concentrating" || effect.statuses?.has?.("concentrating")) return;
  const activity = await originActivity(effect);
  if (!REPEAT_SAVE_SPELLS.has(activity?.item?.system?.identifier)) return;
  const save = saveOf(activity);
  if (!save) return;
  await effect.setFlag(MODULE_ID, REPEAT_FLAG, { ...save, activity: activity.uuid, name: activity.item.name });
  debug(`repeat saves: ${effect.parent.name}'s ${effect.name} — ${save.ability.toUpperCase()} DC ${save.dc} at the end of each turn`);
}

/** The creature's effects with a repeat save, active ones only. */
export function repeatEffects(actor) {
  return [...(actor?.effects ?? [])].filter(e => !e.disabled && e.getFlag?.(MODULE_ID, REPEAT_FLAG));
}

/**
 * combatTurnChange (primary GM): the creature whose turn just ended repeats each
 * such save; a success removes that effect. Effects from the same spell share one save.
 */
export async function onTurnEndRepeatSaves(combat, prior) {
  if (!isRepeatSavesEnabled() || !isTriggerClient() || !combat?.started || !prior?.tokenId) return;
  const mode = getSaveAutomation();
  const tokenDoc = (combat.scene ?? canvas.scene)?.tokens?.get?.(prior.tokenId);
  const actor = tokenDoc?.actor;
  const effects = repeatEffects(actor);
  if (!effects.length) return;

  // One save per spell (Hold Person's Paralyzed and any companion effects end together).
  const bySpell = new Map();
  for (const effect of effects) {
    const data = effect.getFlag(MODULE_ID, REPEAT_FLAG);
    const key = `${data.activity}|${data.ability}|${data.dc}`;
    if (!bySpell.has(key)) bySpell.set(key, { data, effects: [] });
    bySpell.get(key).effects.push(effect);
  }

  const target = { actor: actor.uuid, token: tokenDoc.uuid, name: tokenDoc.name };
  const rollerId = activePlayerOwner(actor)?.id ?? null;
  for (const { data, effects: group } of bySpell.values()) {
    const request = {
      activityUuid: data.activity, activityName: `${data.name} (repeat save)`, casterName: null, usageId: null,
      ability: data.ability, dc: data.dc, targets: [target], prompt: rollerId === null && mode === "request"
    };
    const [result] = (await requestSaves(rollerId, request)) ?? [];
    const outcome = result?.result;
    if (!outcome) { debug(`repeat saves: no save from ${tokenDoc.name} for ${data.name}`); continue; }
    if (!outcome.passed) continue;
    for (const effect of group) if (actor.effects.get(effect.id)) await effect.delete();
    console.log(`[${MODULE_ID}] repeat saves: ${tokenDoc.name} passed (${outcome.total} vs DC ${data.dc}) — ${data.name} ends on it`);
    ui.notifications?.info(`Luck Dice Automation: ${tokenDoc.name} shook off ${data.name}.`);
  }
}

