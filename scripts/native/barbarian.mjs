// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Relentless Rage (Barbarian 11), under the "deathSaves" setting.
//
// When a raging barbarian (an active effect from its Rage) drops to 0 HP and
// doesn't die outright (massive damage: deathsaves.mjs), it makes a Constitution
// save — rolled like the module's other requested saves: its player when they're
// online (Luck Dice on a failure), else the primary GM. DC 10, 5 more for each use
// before the next rest. On a success its HP become twice its Barbarian level
// (2024) or 1 (2014), and it's no longer Unconscious.
// 2024 counts the uses on the feature itself (its DC formula reads the uses spent,
// which dnd5e resets on a rest); 2014 data has nothing to count, so the module keeps
// the count on the item and clears it when the barbarian finishes a rest.
// It runs before Gift of the Protectors (invocations.mjs): a barbarian back on its
// feet doesn't need a warlock's help.

import { requestSaves } from "./saves.mjs";
import { effectsFrom, rulesOf } from "./advantage.mjs";
import { MODULE_ID, debug, isDeathSavesEnabled, activePlayerOwner, isLike, isRollBoostsEnabled } from "./shared.mjs";

export const RELENTLESS_FLAG = "relentlessRage"; // on a 2014 Relentless Rage item: uses since the last rest

const feature = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;

/**
 * Indomitable Might (Barbarian 18), under the "rollBoosts" setting: a Strength check (2024: or Strength save)
 * whose total is below the Strength score uses the score. Resolves with the score to use, or null.
 */
export function indomitableMight(actor, ability, kind, total) {
  if (!isRollBoostsEnabled() || ability !== "str") return null;
  const item = feature(actor, "indomitable-might");
  if (!item || (kind === "save" && rulesOf(item) === "2014")) return null;
  if (kind !== "check" && kind !== "save") return null;
  const score = Number(actor?.system?.abilities?.str?.value);
  return Number.isFinite(score) && Number(total) < score ? score : null;
}

/** Whether the creature is raging: an active effect from its Rage feature. */
export const isRaging = (actor) => effectsFrom(actor, "rage").length > 0;

/** Its uses since the last rest, which raise the DC. */
export function relentlessUses(item) {
  if (rulesOf(item) === "2014") return Number(item?.getFlag?.(MODULE_ID, RELENTLESS_FLAG) ?? 0) || 0;
  return Number(item?.system?.uses?.spent ?? 0) || 0;
}

// Raging barbarians this damage drops from above 0 HP to 0, without killing them, by actor uuid.
const dropping = new Set();

/**
 * dnd5e.preApplyDamage (synchronous; on the client applying the damage, after deathsaves.mjs has
 * recorded massive damage in the same update): note a raging barbarian this damage drops to 0 HP.
 */
export function onPreApplyDamageRelentless(actor, amount, updates) {
  if (!isDeathSavesEnabled() || !(amount > 0) || !actor?.isOwner || actor.statuses?.has?.("dead")) return;
  if (!(Number(actor.system?.attributes?.hp?.value) > 0)) return;
  const next = updates?.["system.attributes.hp.value"];
  if (next === undefined || Number(next) > 0) return;
  if (Number(updates["system.attributes.death.failure"]) >= 3) return; // died outright
  if (!feature(actor, "relentless-rage") || !isRaging(actor)) return;
  dropping.add(actor.uuid);
}

/** dnd5e.applyDamage: the Constitution save, and on a success, back on its feet. */
export async function onDamageAppliedRelentless(actor) {
  if (!actor || !dropping.delete(actor.uuid)) return;
  if (actor.statuses?.has?.("dead") || Number(actor.system?.attributes?.hp?.value ?? 1) > 0) return;
  const item = feature(actor, "relentless-rage");
  if (!item) return;
  const rules = rulesOf(item);
  const used = relentlessUses(item);
  const dc = 10 + 5 * used;
  const save = [...(item.system?.activities?.values?.() ?? [])].find(a => isLike(a, "save"));
  const tokenDoc = actor.getActiveTokens?.()?.[0]?.document ?? null;
  const target = { actor: actor.uuid, token: tokenDoc?.uuid ?? null, name: tokenDoc?.name ?? actor.name };
  debug(`relentless rage: ${actor.name} dropped to 0 HP while raging — DC ${dc} Constitution save`);
  const [result] = (await requestSaves(activePlayerOwner(actor)?.id ?? null, {
    activityUuid: save?.uuid ?? null, activityName: item.name, casterName: actor.name, usageId: null,
    ability: "con", dc, targets: [target], prompt: false
  })) ?? [];
  // Each use raises the DC by 5 until a rest.
  if (rules === "2014") await item.setFlag?.(MODULE_ID, RELENTLESS_FLAG, used + 1);
  else await item.update?.({ "system.uses.spent": used + 1 });
  if (!result?.result?.passed) {
    console.log(`[${MODULE_ID}] relentless rage: ${actor.name} failed the DC ${dc} save`);
    return;
  }
  const level = Number(actor.classes?.barbarian?.system?.levels ?? 0) || 0;
  const hp = rules === "2014" ? 1 : Math.max(1, 2 * level);
  await actor.update({ "system.attributes.hp.value": hp });
  if (actor.statuses?.has?.("unconscious")) await actor.toggleStatusEffect?.("unconscious", { active: false });
  console.log(`[${MODULE_ID}] relentless rage: ${actor.name} passed the DC ${dc} save — back to ${hp} HP`);
  ui.notifications?.info(`Luck Dice Automation: ${actor.name}'s Relentless Rage keeps them fighting at ${hp} HP.`);
}

/** dnd5e.restCompleted: a 2014 Relentless Rage's DC goes back to 10 (2024's uses reset with dnd5e's recovery). */
export async function onRestRelentless(actor) {
  const item = feature(actor, "relentless-rage");
  if (!item || !actor?.isOwner || rulesOf(item) !== "2014" || !item.getFlag?.(MODULE_ID, RELENTLESS_FLAG)) return;
  await item.unsetFlag?.(MODULE_ID, RELENTLESS_FLAG);
}
