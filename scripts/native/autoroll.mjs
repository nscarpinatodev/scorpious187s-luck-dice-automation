// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Activities dnd5e rolls right after use (healing, damage-only): targeting and applying them.

import { requestApplyDamage } from "./apply.mjs";
import { clearAreasForUse } from "./areas.mjs";
import { projectileCount, assignProjectiles } from "./projectiles.mjs";
import { MODULE_ID, debug, isHealingAutomationEnabled, isDamageOnlyAutomationEnabled, pendingLuckDamage } from "./shared.mjs";
import { tokensInActivityArea, regionsOf, confirmTargets } from "./targeting.mjs";

// ── Healing automation ────────────────────────────────────────────────────────
// The "healingAutomation" setting. dnd5e rolls a healing activity's healing
// itself, right after use, and records the user's targets on the healing card at
// that moment — so the module only applies it (through the same GM damage path:
// healing types count as negative damage, temp HP is dnd5e's). For a placed area,
// the creatures inside are targeted during the use hook, synchronously, before
// dnd5e's roll reads the targets.

/** Whether this auto-rolled activity type is set to be applied. */
export function autoRolledEnabled(activity) {
  if (activity?.type === "heal")   return isHealingAutomationEnabled();
  if (activity?.type === "damage") return isDamageOnlyAutomationEnabled();
  return false;
}

/**
 * dnd5e.postUseActivity for heal and damage-only activities. Must stay synchronous: dnd5e rolls
 * the healing as soon as the hook returns. Areas where the caster chooses who's
 * affected are left to manual targeting (no checklist can be shown in time).
 */
export function targetAutoRolledArea(activity, results) {
  if (!autoRolledEnabled(activity)) return;
  const regions = (results?.templates ?? []).filter(r => r?.documentName === "Region");
  if (!regions.length || activity.target?.affects?.choice) return;
  const tokens = tokensInActivityArea(activity, regions);
  if (canvas.scene === regions[0].parent) canvas.tokens?.setTargets(tokens.map(t => t.id), { mode: "replace" });
  debug(`${activity.type} automation: ${tokens.length} creature(s) in the area: ${tokens.map(t => t.name).join(", ")}`);
}

/**
 * dnd5e.rollDamageV2 for heal activities: apply the healing card to its targets,
 * or to the user when the activity affects only them (e.g. Second Wind).
 */
export async function applyAutoRolledCard(message, activity) {
  if (!autoRolledEnabled(activity) || !message) return;
  // Damage-only activities get the Luck Dice damage prompt (no attack card to
  // gate it); apply only once any dice are on the card.
  if (activity.type === "damage") await pendingLuckDamage.get(message.id);
  let targets = (message.system?.targets ?? []).map(({ actor, token, name }) => ({ actor, token, name }));
  if (!targets.length && activity?.target?.affects?.type === "self") {
    const user = activity.getUsageToken?.();
    if (user?.actor) targets = [{ actor: user.actor.uuid, token: user.uuid, name: user.name }];
  }
  if (!targets.length) {
    ui.notifications?.info(`Luck Dice Automation: no targets for ${activity?.item?.name ?? activity?.name ?? "that roll"} — use the card's tray.`);
    return;
  }
  const projectiles = projectileCount(activity, message.getOriginatingMessage?.());
  if (projectiles) {
    const rolls  = message.rolls.filter(r => r instanceof CONFIG.Dice.DamageRoll);
    const sum    = (list) => Math.max(0, list.reduce((total, r) => total + r.total, 0));
    const luck   = rolls.some(r => r.options?.ldaLuckDice) ? sum(rolls.filter(r => r.options?.ldaLuckDice)) : null;
    const perHit = sum(rolls.filter(r => !r.options?.ldaLuckDice));
    targets = await assignProjectiles(activity, targets, projectiles,
      `<strong>${perHit}</strong> damage each${luck !== null ? `, and the Luck Dice add <strong>+${luck}</strong> to one of them` : ""}.`,
      { luck: luck !== null });
    if (!targets?.length) return;
  }
  await requestApplyDamage(message, targets);
  await clearAreasForUse(message.getOriginatingMessage?.()?.id);
}

/** What dnd5e does to the item before its own follow-up roll: note the resources this use consumed. */
export function applyConsumedFlag(activity, results) {
  try {
    const deltas   = results?.message?.system?.deltas ?? results?.message?.data?.system?.deltas;
    const consumed = activity.createConsumedFlag?.(activity.actor, deltas);
    if (consumed) activity.item.updateSource({ "flags.dnd5e.consumed": consumed });
  } catch (err) { console.warn(`[${MODULE_ID}] consumed flag:`, err); }
}

/**
 * A heal / damage-only use with confirmation: target the area's creatures, have
 * the caster confirm, then roll it the way dnd5e would have. The card records
 * the confirmed targets, and the usual automation applies it.
 */
export async function confirmAndRoll(activity, usageConfig, results) {
  if (activity?.type === "attack") return confirmAndAttack(activity, usageConfig, results);
  const regions = regionsOf(results);
  if (regions.length && canvas.scene === regions[0].parent) {
    canvas.tokens?.setTargets(tokensInActivityArea(activity, regions).map(t => t.id), { mode: "replace" });
  }
  if (!await confirmTargets(activity)) return;
  applyConsumedFlag(activity, results);
  await activity.rollDamage({ event: usageConfig?.event }, {}, { data: { system: { origin: results?.message?.id } } });
}

/** An ordinary attack with confirmation: confirm, then roll the attack the way dnd5e would have. */
async function confirmAndAttack(activity, usageConfig, results) {
  if (!await confirmTargets(activity)) return;
  applyConsumedFlag(activity, results);
  await activity.rollAttack({ event: usageConfig?.event }, {}, { data: { system: { origin: results?.message?.id } } });
}

/**
 * dnd5e.preRollDamageV2 — healing and damage-only activities the module applies
 * roll without dnd5e's damage window (the critical key still works). Never cancels.
 */
export function skipAutoRolledDamageDialog(config, dialog) {
  const activity = config?.subject;
  if (!dialog || !(activity?.type === "heal" || activity?.type === "damage") || !autoRolledEnabled(activity)) return;
  dialog.configure ??= false;
}
