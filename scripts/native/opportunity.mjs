// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Opportunity attacks, and a Disengaged status.
//
// The "opportunityAttacks" setting. The primary GM's client watches movement:
// when a creature's path takes it out of an enemy's reach (5 ft, or the reach of
// its longest melee weapon), the enemy is offered an opportunity attack — its
// player, or the GM for NPCs — if it still has its reaction (shared with the
// reaction prompts) and isn't incapacitated. A yes targets the mover and rolls
// the melee attack through dnd5e, so Luck Dice, the advantage checks and attack
// automation apply as usual.
// No attack is provoked by a creature that is Disengaged, by teleporting
// (Foundry's "blink" movement), or by being moved (Push, "displace" moves).
//
// Disengaged is a status (in dnd5e's token HUD, so it can be toggled) that this
// module applies when a creature uses a Disengage activity or feature (Cunning
// Action's Disengage, Step of the Wind…), and removes at the end of its turn.

import { askReaction, hasReaction, spendReaction } from "./reactions.mjs";
import { tokenDistance } from "./advantage.mjs";
import { isTriggerClient } from "./lingering.mjs";
import { MODULE_ID, debug, escapeHTML, promptChoice, isOpportunityAttacksEnabled, resolveTarget } from "./shared.mjs";

export const DISENGAGED = "disengaged";
const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];
const NO_PROVOKE_ACTIONS = new Set(["blink", "displace"]);

// The status, added to dnd5e's own list before dnd5e builds CONFIG.statusEffects (i18nInit).
Hooks.once("init", () => {
  if (!globalThis.CONFIG?.DND5E?.statusEffects) return;
  CONFIG.DND5E.statusEffects[DISENGAGED] ??= { name: "Disengaged", img: "icons/svg/door-exit.svg", order: 50 };
});

// ── Disengage ─────────────────────────────────────────────────────────────────

/** dnd5e.postUseActivity: a Disengage activity or feature gives its user the Disengaged status. */
export async function onDisengageUsed(activity) {
  if (!isOpportunityAttacksEnabled() || !activity?.actor?.isOwner) return;
  const named = (s) => /\bdisengage\b/i.test(String(s ?? ""));
  if (!named(activity.name) && !named(activity.item?.name)) return;
  if (activity.actor.statuses?.has?.(DISENGAGED)) return;
  await activity.actor.toggleStatusEffect?.(DISENGAGED, { active: true });
  debug(`opportunity attacks: ${activity.actor.name} disengaged`);
}

/** combatTurnChange (primary GM): Disengaged ends with the creature's turn. */
export async function onTurnEndDisengage(combat, prior) {
  if (!isTriggerClient() || !combat?.started || !prior?.tokenId) return;
  const actor = (combat.scene ?? canvas.scene)?.tokens?.get?.(prior.tokenId)?.actor;
  if (actor?.statuses?.has?.(DISENGAGED)) await actor.toggleStatusEffect?.(DISENGAGED, { active: false });
}

// ── Reach and leaving it ──────────────────────────────────────────────────────

/** A creature's best melee weapon attack and its reach: { activity, item, reach } or null. */
export function meleeReach(actor) {
  let best = null;
  for (const item of actor?.items ?? []) {
    if (item.type !== "weapon" || item.system?.equipped === false) continue;
    for (const activity of item.system?.activities?.values?.() ?? []) {
      if (activity.type !== "attack" || activity.attack?.type?.value !== "melee") continue;
      const reach = Number(item.system?.range?.reach) || (item.system?.properties?.has?.("rch") ? 10 : 5);
      if (!best || reach > best.reach) best = { activity, item, reach };
    }
  }
  return best;
}

/** Whether a path (waypoints) takes the mover from within `reach` of the reactor to beyond it. */
export function leavesReach(reactorDoc, moverDoc, waypoints, reach) {
  const grid = canvas?.grid;
  if (!grid || waypoints.length < 2) return false;
  const step = Math.max(1, grid.size / 2);
  const at = (point) => tokenDistance(reactorDoc, {
    ...moverDoc, parent: moverDoc.parent, id: moverDoc.id, x: point.x, y: point.y, elevation: point.elevation ?? moverDoc.elevation ?? 0,
    width: moverDoc.width, height: moverDoc.height, object: null,
    getOccupiedGridSpaceOffsets: () => moverDoc.getOccupiedGridSpaceOffsets?.({ x: point.x, y: point.y }) ?? []
  });
  let wasInside = false;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const samples = Math.max(1, Math.ceil(length / step));
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const inside = at({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, elevation: a.elevation }) <= reach;
      if (inside) wasInside = true;
      else if (wasInside) return true;
    }
  }
  return false;
}

/**
 * moveToken (primary GM): offer an opportunity attack to each enemy the mover
 * left the reach of, one at a time.
 */
export async function onTokenMovedOA(moverDoc, movement, operation) {
  if (!isOpportunityAttacksEnabled() || !isTriggerClient() || !moverDoc?.actor) return;
  if (moverDoc.actor.statuses?.has?.(DISENGAGED) || operation?.[MODULE_ID]?.forced) return;
  const waypoints = [movement?.origin, ...(movement?.passed?.waypoints ?? [])].filter(Boolean);
  if (waypoints.length < 2 || waypoints.slice(1).some(w => NO_PROVOKE_ACTIONS.has(w.action))) return;
  for (const reactor of [...(moverDoc.parent?.tokens ?? [])]) {
    if (reactor.id === moverDoc.id || !reactor.actor || !reactor.disposition || reactor.disposition !== -moverDoc.disposition) continue;
    if (INCAPACITATING.some(s => reactor.actor.statuses?.has?.(s))) continue;
    const weapon = meleeReach(reactor.actor);
    if (!weapon || !leavesReach(reactor, moverDoc, waypoints, weapon.reach)) continue;
    await askReaction(reactor.actor, {
      kind: "opportunity", token: reactor.uuid, actor: reactor.actor.uuid, mover: moverDoc.uuid,
      moverName: moverDoc.name, activity: weapon.activity.uuid
    });
  }
}

/** On the reactor's player's (or the GM's) client: offer the attack, and make it. Resolves with { identifier } or null. */
export async function answerOpportunity({ token, actor: actorUuid, mover, moverName, activity: activityUuid }) {
  const { tokenDoc, actor } = await resolveTarget({ token, actor: actorUuid });
  if (!actor?.isOwner || !hasReaction(actor)) return null;
  const moverDoc = await fromUuid(mover);
  const activity = activityUuid ? await fromUuid(activityUuid) : meleeReach(actor)?.activity;
  if (!moverDoc || !activity?.rollAttack) return null;
  const name = tokenDoc?.name ?? actor.name;
  const choice = await promptChoice("Opportunity Attack",
    `<p><strong>${escapeHTML(moverName ?? moverDoc.name)}</strong> is leaving <strong>${escapeHTML(name)}</strong>'s reach.
     Make an opportunity attack with ${escapeHTML(activity.item?.name ?? "a melee weapon")}?</p>`,
    [{ action: "attack", label: "Opportunity Attack" }, { action: "no", label: "Let It Go" }]);
  if (choice !== "attack") return null;
  if (canvas?.scene !== moverDoc.parent) {
    ui.notifications?.warn(`Luck Dice Automation: view ${moverDoc.parent?.name ?? "that scene"} to make the opportunity attack.`);
    return null;
  }
  spendReaction(actor);
  canvas.tokens?.setTargets([moverDoc.id], { mode: "replace" });
  await activity.rollAttack({}, {}, { data: { flavor: `${activity.item?.name ?? "Weapon"} - Opportunity Attack` } });
  return { identifier: "opportunity" };
}
