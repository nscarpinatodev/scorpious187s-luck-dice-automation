// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Death saves.
//
// The "deathSaves" setting:
//   at the start of a dying character's turn, its death save is rolled — on its
//     player's client when they're online, otherwise on the primary GM's;
//   damage while at 0 HP is a failed death save (two on a critical hit), and death
//     when that damage reaches the character's HP maximum;
//   massive damage: dropped to 0 HP with damage left over equal to the HP maximum
//     is death outright.
// dnd5e itself only resets the counts on healing. Luck Dice on a failed death save
// (offered with the other failed saves) are honoured: dnd5e records the result as
// soon as the roll is made, so a save Luck Dice turn around is recorded again from
// the new roll (nat 20: back on your feet; three successes: stable; a nat 1 is two
// failures).

import { MODULE_ID, debug, isDeathSavesEnabled, getPrimaryGM, activePlayerOwner, NO_DIALOG } from "./shared.mjs";

const hasDeathSaves = (actor) => actor?.type === "character" && !!actor.system?.attributes?.death;
const dying = (actor) => hasDeathSaves(actor) && Number(actor.system.attributes.hp?.value ?? 1) <= 0
  && !actor.statuses?.has?.("dead") && !actor.statuses?.has?.("stable")
  && (actor.system.attributes.death.failure ?? 0) < 3 && (actor.system.attributes.death.success ?? 0) < 3;

/** The user who rolls a character's death save: its active player owner, else the primary GM. */
const rollerFor = (actor) => activePlayerOwner(actor) ?? getPrimaryGM() ?? game.users?.activeGM ?? null;

/** combatTurnChange: roll the death save of a dying character whose turn starts. */
export async function onTurnStartDeathSave(combat, current) {
  if (!isDeathSavesEnabled() || !combat?.started || !current?.tokenId) return;
  const actor = (combat.scene ?? canvas.scene)?.tokens?.get?.(current.tokenId)?.actor;
  if (!dying(actor) || rollerFor(actor)?.id !== game.user.id) return;
  debug(`death saves: rolling ${actor.name}'s death save`);
  await actor.rollDeathSave({ ...NO_DIALOG }, { configure: false });
}

// Characters to mark dead once their damage is applied, by actor uuid.
const markDead = new Set();

/**
 * dnd5e.preApplyDamage (synchronous; on the client applying the damage): failed
 * death saves from damage at 0 HP, and death from massive damage. Adds to the
 * HP update dnd5e is about to make.
 */
export function onPreApplyDamage(actor, amount, updates, options) {
  if (!isDeathSavesEnabled() || !hasDeathSaves(actor) || !(amount > 0) || actor.statuses?.has?.("dead")) return;
  const hp = actor.system.attributes.hp;
  const max = Number(hp.effectiveMax ?? hp.max ?? 0) || 0;
  const death = actor.system.attributes.death;
  const critical = options?.isCritical ?? !!options?.originatingMessage?.rolls?.some?.(r => r.isCritical);
  const absorbed = Math.min(Number(hp.temp ?? 0) || 0, amount);
  const throughHP = amount - absorbed;
  let failures = null;
  if (Number(hp.value) <= 0) {
    // Already dying: each hit is a failed death save, a critical hit two; damage reaching the maximum kills.
    failures = throughHP >= max && max > 0 ? 3 : Math.min(3, (death.failure ?? 0) + (critical ? 2 : 1));
  } else if (throughHP - Number(hp.value) >= max && max > 0) {
    failures = 3; // massive damage
  }
  if (failures === null) return;
  updates["system.attributes.death.failure"] = failures;
  if (failures >= 3) markDead.add(actor.uuid);
  debug(`death saves: ${actor.name} — ${failures >= 3 ? "dies" : `${failures} failure(s)`}`);
}

/** dnd5e.applyDamage: mark a character killed by the damage dead. */
export async function onDamageAppliedDeath(actor) {
  if (!markDead.delete(actor?.uuid)) return;
  await actor.toggleStatusEffect?.("dead", { active: true, overlay: true });
  console.log(`[${MODULE_ID}] death saves: ${actor.name} died`);
}

// ── Luck Dice on a death save ─────────────────────────────────────────────────

// dnd5e has recorded a death save card's result, by card id.
const recorded = new Map();
/** dnd5e.postRollDeathSave: dnd5e has applied the result. */
export function onPostRollDeathSave(rolls, { message } = {}) {
  const id = message?.id ?? rolls?.[0]?.parent?.id;
  if (!id) return;
  recorded.get(id)?.resolve();
  recorded.set(id, { done: true });
}
function whenRecorded(id) {
  const entry = recorded.get(id);
  if (entry?.done) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    recorded.set(id, { resolve: () => { clearTimeout(timer); resolve(); } });
  });
}

/** dnd5e's rules for a death save result (AttributesFields.applyDeathSaveResult). */
export function deathSaveResult(death, { isSuccess, isCritical = false, isFumble = false }) {
  const updates = {};
  let outcome = null;
  if (isSuccess) {
    const successes = (death.success || 0) + 1;
    if (isCritical) {
      Object.assign(updates, { "system.attributes.death.success": 0, "system.attributes.death.failure": 0, "system.attributes.hp.value": 1 });
      outcome = "revive";
    } else if (successes >= 3) {
      Object.assign(updates, { "system.attributes.death.success": 0, "system.attributes.death.failure": 0 });
      outcome = "stable";
    } else updates["system.attributes.death.success"] = Math.min(3, successes);
  } else {
    const failures = Math.min(3, (death.failure || 0) + (isFumble ? 2 : 1));
    updates["system.attributes.death.failure"] = failures;
    if (failures >= 3) outcome = "death";
  }
  return { outcome, updates };
}

const outcomeOf = (roll) => ({
  isSuccess: Number(roll?.total ?? 0) >= Number(roll?.options?.target ?? 10),
  isCritical: !!roll?.isCritical, isFumble: !!roll?.isFumble
});
const sameOutcome = (a, b) => a.isSuccess === b.isSuccess && a.isCritical === b.isCritical && a.isFumble === b.isFumble;

/**
 * After the Luck Dice prompt on a death save: if the result changed, undo what
 * dnd5e recorded from the first roll (the card's deltas) and record the new one.
 */
export async function correctDeathSave(message, actor, original) {
  if (message?.system?.type !== "death" || !hasDeathSaves(actor)) return false;
  const final = outcomeOf(message.rolls?.[0]);
  if (sameOutcome(final, original)) return false;
  await whenRecorded(message.id);
  const deltas = message.system?.deltas?.actor ?? [];
  const delta = (key) => Number(deltas.find(d => d.keyPath === `system.attributes.death.${key}`)?.delta ?? 0) || 0;
  const now = actor.system.attributes.death;
  const before = { success: (now.success ?? 0) - delta("success"), failure: (now.failure ?? 0) - delta("failure") };
  const { outcome, updates } = deathSaveResult(before, final);
  updates["system.attributes.death.success"] ??= before.success;
  updates["system.attributes.death.failure"] ??= before.failure;
  await actor.update(updates);
  if (outcome !== "death" && actor.statuses?.has?.("dead")) await actor.toggleStatusEffect?.("dead", { active: false });
  await message.update({ "system.outcome": outcome });
  console.log(`[${MODULE_ID}] death saves: ${actor.name}'s Luck Dice changed the death save — ${outcome ?? (final.isSuccess ? "success" : "failure")}`);
  return true;
}
