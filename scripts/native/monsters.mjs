// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Monster traits that keep a creature going, under the "deathSaves" setting.
//
//   Undead Fortitude — damage that drops it to 0 HP: a Constitution save (DC 5 + the damage taken) and on a
//                      success it's at 1 HP instead — not against Radiant damage or a critical hit.
//   Regeneration     — at the start of its turn it regains its trait's Hit Points (its heal activity, rolled
//                      and applied like the module's other healing), unless since its last turn it took one of
//                      the damage types its description names ("If the troll takes Acid or Fire damage…"); when
//                      the description says "at least 1 Hit Point", not at 0.
// What the damage was (its types, a critical hit) is read from the damage card it came from — damage applied by
// hand, with no card, counts as neither.

import { requestSaves } from "./saves.mjs";
import { requestApplyDamage } from "./apply.mjs";
import { MODULE_ID, debug, isDeathSavesEnabled, isLike } from "./shared.mjs";

export const REGEN_BLOCKED = "regenerationBlocked"; // on a creature: the damage types that stop its next Regeneration
const feature = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;
const activitiesOf = (item) => [...(item?.system?.activities?.values?.() ?? [])];

/** The damage types and critical hit of a damage card (the damage being applied came from it). */
export function damageFacts(message) {
  const rolls = message?.rolls ?? [];
  const types = new Set(rolls.flatMap(r => [r.options?.type, ...(r.options?.types ?? [])]).filter(Boolean));
  return { types, critical: rolls.some(r => r.isCritical || r.options?.isCritical) };
}

/** The damage types that stop a creature's Regeneration, read from the trait's description. */
export function regenerationBlockers(item) {
  const text = String(item?.system?.description?.value ?? "").replace(/<[^>]+>/g, " ");
  const sentence = text.split(/(?<=\.)\s/).find(s => /\btakes?\b[^.]*\bdamage\b/i.test(s)) ?? "";
  return Object.entries(CONFIG.DND5E?.damageTypes ?? {})
    .filter(([key, cfg]) => new RegExp(`\\b(${key}|${String(cfg?.label ?? cfg ?? key)})\\b`, "i").test(sentence))
    .map(([key]) => key);
}

// Creatures with Undead Fortitude this damage drops to 0 HP: actor uuid → the save's DC.
const fortitude = new Map();

/**
 * dnd5e.preApplyDamage (synchronous; on the client applying the damage): note Undead Fortitude's save, and
 * the damage that stops a Regeneration.
 */
export function onPreApplyDamageMonsters(actor, amount, updates, options = {}) {
  if (!isDeathSavesEnabled() || !(amount > 0) || !actor?.isOwner) return;
  const { types, critical } = damageFacts(options.originatingMessage);
  const regen = feature(actor, "regeneration");
  if (regen) {
    const blocked = regenerationBlockers(regen).filter(t => types.has(t));
    if (blocked.length) actor.setFlag?.(MODULE_ID, REGEN_BLOCKED, blocked)?.catch?.(() => null);
  }
  const next = updates?.["system.attributes.hp.value"];
  if (next === undefined || Number(next) > 0 || !(Number(actor.system?.attributes?.hp?.value) > 0)) return;
  if (!feature(actor, "undead-fortitude") || types.has("radiant") || critical) return;
  fortitude.set(actor.uuid, 5 + Math.round(amount));
}

/** dnd5e.applyDamage: Undead Fortitude's save, and on a success, 1 HP. */
export async function onDamageAppliedMonsters(actor) {
  const dc = fortitude.get(actor?.uuid);
  if (dc === undefined) return;
  fortitude.delete(actor.uuid);
  if (Number(actor.system?.attributes?.hp?.value ?? 1) > 0) return;
  const item = feature(actor, "undead-fortitude");
  const tokenDoc = actor.getActiveTokens?.()?.[0]?.document ?? null;
  const target = { actor: actor.uuid, token: tokenDoc?.uuid ?? null, name: tokenDoc?.name ?? actor.name };
  const [result] = (await requestSaves(null, {
    activityUuid: null, activityName: item?.name ?? "Undead Fortitude", casterName: actor.name, usageId: null,
    ability: "con", dc, targets: [target], prompt: false
  })) ?? [];
  if (!result?.result?.passed) { debug(`undead fortitude: ${actor.name} failed the DC ${dc} save`); return; }
  await actor.update({ "system.attributes.hp.value": 1 });
  for (const status of ["dead", "unconscious"]) if (actor.statuses?.has?.(status)) await actor.toggleStatusEffect?.(status, { active: false });
  console.log(`[${MODULE_ID}] undead fortitude: ${actor.name} passed the DC ${dc} save — at 1 HP`);
  ui.notifications?.info(`Luck Dice Automation: ${actor.name}'s Undead Fortitude keeps it standing at 1 HP.`);
}

/** combatTurnChange (the primary GM): Regeneration at the start of the creature's turn. */
export async function onTurnStartRegeneration(combat, current, { isTrigger = () => true } = {}) {
  if (!isDeathSavesEnabled() || !isTrigger() || !combat?.started) return;
  const tokenDoc = (combat.scene ?? canvas?.scene)?.tokens?.get?.(current?.tokenId);
  const actor = tokenDoc?.actor;
  const regen = feature(actor, "regeneration");
  if (!regen) return;
  const blocked = actor.getFlag?.(MODULE_ID, REGEN_BLOCKED);
  if (blocked?.length) {
    await actor.unsetFlag?.(MODULE_ID, REGEN_BLOCKED);
    ui.notifications?.info(`Luck Dice Automation: ${tokenDoc.name} doesn't regenerate this turn (${blocked.join(", ")} damage).`);
    return;
  }
  const hp = Number(actor.system?.attributes?.hp?.value ?? 0);
  const max = Number(actor.system?.attributes?.hp?.effectiveMax ?? actor.system?.attributes?.hp?.max ?? Infinity);
  if (hp >= max) return;
  if (hp <= 0 && /at least 1 hit point/i.test(String(regen.system?.description?.value ?? ""))) return;
  const heal = activitiesOf(regen).find(a => isLike(a, "heal"));
  if (!heal?.rollDamage) return;
  const rolls = await heal.rollDamage({}, { configure: false }, { data: { speaker: { actor: actor.id, token: tokenDoc.id, scene: tokenDoc.parent?.id, alias: tokenDoc.name } } });
  const message = rolls?.[0]?.parent;
  if (!message) return;
  await requestApplyDamage(message, [{ actor: actor.uuid, token: tokenDoc.uuid, name: tokenDoc.name, img: tokenDoc.texture?.src }]);
  if (hp <= 0) for (const status of ["dead", "unconscious"]) if (actor.statuses?.has?.(status)) await actor.toggleStatusEffect?.(status, { active: false });
  debug(`regeneration: ${tokenDoc.name}`);
}
