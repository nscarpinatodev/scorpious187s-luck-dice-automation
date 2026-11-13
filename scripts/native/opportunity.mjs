// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Opportunity attacks, and a Disengaged status.
//
// The "opportunityAttacks" setting, in a started combat, between combatants. When
// a creature's path would take it out of an enemy's reach (5 ft, or the reach of
// its longest melee weapon), and the enemy still has its reaction (shared with the
// reaction prompts) and isn't incapacitated, the creature stops at the last spot
// still in reach. The enemy is offered an opportunity attack there — its player, or
// the GM for NPCs — and the movement carries on once that's settled (not if the
// attack dropped or stopped the creature, or something else moved it). A yes targets
// the mover and rolls the melee attack through dnd5e, so Luck Dice, the advantage
// checks and attack automation apply as usual, against a target still in reach:
// range checks (Automated Conditions 5e's) see where it really is.
// Foundry can't change a movement's path, only refuse it, so on the moving user's
// client (preMoveToken) the movement is refused and made again in legs. Each leg is
// its own movement, so undoing takes one step per leg.
// No attack is provoked by a creature that is Disengaged, by teleporting
// (Foundry's "blink" movement), or by being moved (Push, "displace" moves, undo).
//
// Disengaged is a status (in dnd5e's token HUD, so it can be toggled) that this
// module applies when a creature uses a Disengage activity or feature (Cunning
// Action's Disengage, Step of the Wind…), and removes at the end of its turn.
// dnd5e 6.1's stock effects count too (shared.mjs): its Disengaged (2024 Monk's
// Focus applies it; also removed at the end of the turn), No Opportunity Attacks
// (the creature can't make them) and No Reactions. So do the SRD's own effects
// that say so (advantage.mjs): 2024 Shocking Grasp's Shocked, Brutal Strike's
// Staggered, and 2014 Shocking Grasp (no reactions at all).

import { askReaction, hasReaction, spendReaction } from "./reactions.mjs";
import { tokenDistance, cantMakeOpportunityAttacks } from "./advantage.mjs";
import { isTriggerClient } from "./lingering.mjs";
import { MODULE_ID, debug, escapeHTML, promptChoice, isOpportunityAttacksEnabled, resolveTarget, pendingAttacks, hasStockEffect, stockEffectsOf, STOCK_EFFECTS, isLike } from "./shared.mjs";

export const DISENGAGED = "disengaged";

/** Disengaged: this module's status, or dnd5e 6.1's stock effect. */
export const isDisengaged = (actor) => !!actor?.statuses?.has?.(DISENGAGED) || hasStockEffect(actor, "disengaged");
const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];
const NO_PROVOKE_ACTIONS = new Set(["blink", "displace"]);
const PROVOKING_METHODS = new Set(["dragging", "keyboard", "api"]);
const STOPS_MOVING = ["grappled", "restrained"];
// How long the mover waits for an answer before carrying on.
const OPPORTUNITY_TIMEOUT = 180_000;
// How long after refusing a movement its first leg starts: the refused update has to finish.
const LEG_DELAY = 50;

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
  // dnd5e 6.1: an activity that applies its stock Disengaged (2024 Monk's Patient Defense, Step of the Wind).
  const stock = [...(activity.effects ?? [])].some(e => String(e?.uuid ?? "").endsWith(`.ActiveEffect.${STOCK_EFFECTS.disengaged}`));
  if (!named(activity.name) && !named(activity.item?.name) && !stock) return;
  if (isDisengaged(activity.actor)) return;
  await activity.actor.toggleStatusEffect?.(DISENGAGED, { active: true });
  debug(`opportunity attacks: ${activity.actor.name} disengaged`);
}

/** combatTurnChange (primary GM): Disengaged ends with the creature's turn — the status, and dnd5e's stock effect. */
export async function onTurnEndDisengage(combat, prior) {
  if (!isTriggerClient() || !combat?.started || !prior?.tokenId) return;
  const actor = (combat.scene ?? canvas.scene)?.tokens?.get?.(prior.tokenId)?.actor;
  if (actor?.statuses?.has?.(DISENGAGED)) await actor.toggleStatusEffect?.(DISENGAGED, { active: false });
  const stock = stockEffectsOf(actor, "disengaged").map(e => e.id);
  if (stock.length) await actor.deleteEmbeddedDocuments?.("ActiveEffect", stock);
}

/** Whether a token has a combatant in the combat (Foundry 14's getCombatantsByToken; the older singular before it). */
const inCombat = (combat, tokenId) => typeof combat.getCombatantsByToken === "function"
  ? combat.getCombatantsByToken(tokenId).length > 0 : !!combat.getCombatantByToken?.(tokenId);

/** Whether a creature can make an opportunity attack now: its reaction, and nothing stopping it. */
const canMakeOpportunityAttack = (actor) => hasReaction(actor) && !INCAPACITATING.some(s => actor?.statuses?.has?.(s))
  && !hasStockEffect(actor, "noOpportunityAttacks") && !cantMakeOpportunityAttacks(actor);

// ── Reach and leaving it ──────────────────────────────────────────────────────

/** A creature's best melee weapon attack and its reach: { activity, item, reach } or null. */
export function meleeReach(actor) {
  let best = null;
  for (const item of actor?.items ?? []) {
    if (item.type !== "weapon" || item.system?.equipped === false) continue;
    for (const activity of item.system?.activities?.values?.() ?? []) {
      if (!isLike(activity, "attack") || activity.attack?.type?.value !== "melee") continue;
      const reach = Number(item.system?.range?.reach) || (item.system?.properties?.has?.("rch") ? 10 : 5);
      if (!best || reach > best.reach) best = { activity, item, reach };
    }
  }
  return best;
}

/**
 * Where a path (waypoints) takes the mover from within `reach` of the reactor to beyond it: the last
 * spot still in reach, as { segment, progress, point }, segment being the index of the waypoint it's
 * heading for. Null when the path doesn't leave reach.
 */
export function reachExit(reactorDoc, moverDoc, waypoints, reach) {
  const grid = canvas?.grid;
  if (!grid || waypoints.length < 2) return null;
  const step = Math.max(1, grid.size / 2);
  const at = (point) => tokenDistance(reactorDoc, {
    ...moverDoc, parent: moverDoc.parent, id: moverDoc.id, x: point.x, y: point.y, elevation: point.elevation ?? moverDoc.elevation ?? 0,
    width: moverDoc.width, height: moverDoc.height, object: null,
    getOccupiedGridSpaceOffsets: () => moverDoc.getOccupiedGridSpaceOffsets?.({ x: point.x, y: point.y }) ?? []
  });
  // A spot the token can stand on: snapped on a grid, kept only if that's still in reach.
  const standable = (point) => {
    if (grid.isGridless || !grid.getSnappedPoint) return { ...point, x: Math.round(point.x), y: Math.round(point.y) };
    const snapped = grid.getSnappedPoint(point, { mode: globalThis.CONST?.GRID_SNAPPING_MODES?.TOP_LEFT_CORNER ?? 16 });
    return at({ ...point, ...snapped }) <= reach ? { ...point, x: Math.round(snapped.x), y: Math.round(snapped.y) } : null;
  };
  let last = null;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const samples = Math.max(1, Math.ceil(length / step));
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, elevation: a.elevation };
      if (at(point) <= reach) last = { segment: i, progress: i - 1 + t, point: standable(point) ?? last?.point ?? { ...a } };
      else if (last) return last;
    }
  }
  return null;
}

/** Whether a path (waypoints) takes the mover from within `reach` of the reactor to beyond it. */
export function leavesReach(reactorDoc, moverDoc, waypoints, reach) {
  return !!reachExit(reactorDoc, moverDoc, waypoints, reach);
}

// ── Stopping at the edge of reach ─────────────────────────────────────────────

/** The enemies that could make an opportunity attack on this path: [{ doc, weapon }]. Both must be in the combat. */
export function opportunityReactors(moverDoc, path) {
  const combat = game.combat;
  if (!combat?.started || !inCombat(combat, moverDoc.id)) return [];
  const reactors = [];
  for (const doc of [...(moverDoc.parent?.tokens ?? [])]) {
    if (doc.id === moverDoc.id || !doc.actor || !doc.disposition || doc.disposition !== -moverDoc.disposition) continue;
    if (!inCombat(combat, doc.id) || !canMakeOpportunityAttack(doc.actor)) continue;
    const weapon = meleeReach(doc.actor);
    if (weapon && leavesReach(doc, moverDoc, path, weapon.reach)) reactors.push({ doc, weapon });
  }
  return reactors;
}

/** Only what makes a waypoint, without the undefined or measured parts. */
function cleanWaypoint(waypoint) {
  const out = {};
  for (const key of ["x", "y", "elevation", "width", "height", "depth", "shape", "level", "action", "snapped", "explicit", "checkpoint"]) {
    if (waypoint[key] !== undefined) out[key] = waypoint[key];
  }
  return out;
}

const samePlace = (a, b) => a.x === b.x && a.y === b.y;

/** A path cut at a stop on it: `walk`, the waypoints to reach it (none if already there), and `rest`, the path from it. */
export function splitPath(path, { segment, point }) {
  const action = path[segment]?.action;
  const stop = cleanWaypoint({ ...point, ...(action ? { action } : {}), snapped: true });
  const walk = path.slice(1, segment).map(cleanWaypoint);
  const from = walk.at(-1) ?? path[0];
  if (!samePlace(from, stop)) walk.push(stop);
  const rest = path.slice(segment);
  if (samePlace(rest[0], stop)) rest.shift();
  return { walk, stop, rest: [stop, ...rest.map(cleanWaypoint)] };
}

/** Why the mover can't carry on after an opportunity attack, or null. */
function stoppedBy(moverDoc, stop) {
  const actor = moverDoc.actor;
  if (Number(actor?.system?.attributes?.hp?.value ?? 1) <= 0 || INCAPACITATING.some(s => actor?.statuses?.has?.(s))) return "it can't move";
  if (STOPS_MOVING.some(s => actor?.statuses?.has?.(s))) return "it can't move";
  if (Math.round(moverDoc.x) !== stop.x || Math.round(moverDoc.y) !== stop.y) return "it was moved";
  return null;
}

// Tokens this client is moving in legs, by id: other movements of them wait until that's done.
const movingInLegs = new Set();

/**
 * Make a refused movement again in legs: to the next spot where it leaves an enemy's reach, the attack
 * from there, and on. Each enemy is asked once; those leaving reach further on, when the path gets there.
 */
export async function moveWithOpportunityAttacks(moverDoc, path, reactors, options = {}) {
  const legOptions = { ...options, [MODULE_ID]: { opportunityLeg: true } };
  const asked = new Set();
  let remaining = path;
  while (remaining.length > 1) {
    const exits = reactors.filter(r => !asked.has(r.doc.id))
      .map(reactor => ({ reactor, exit: reachExit(reactor.doc, moverDoc, remaining, reactor.weapon.reach) }))
      .filter(e => e.exit).sort((a, b) => a.exit.progress - b.exit.progress);
    if (!exits.length) {
      await moverDoc.move(remaining.slice(1).map(cleanWaypoint), legOptions);
      return;
    }
    const { walk, stop, rest } = splitPath(remaining, exits[0].exit);
    if (walk.length) {
      if (!await moverDoc.move(walk, legOptions)) return; // stopped or refused along the way
      await moverDoc.object?.movementAnimationPromise;
    }
    for (const { reactor, exit } of exits.filter(e => samePlace(e.exit.point, exits[0].exit.point))) {
      asked.add(reactor.doc.id);
      const actor = reactor.doc.actor;
      if (!canMakeOpportunityAttack(actor)) continue;
      debug(`opportunity attacks: ${moverDoc.name} stops at (${exit.point.x}, ${exit.point.y}) for ${reactor.doc.name}`);
      await askReaction(actor, {
        kind: "opportunity", token: reactor.doc.uuid, actor: actor.uuid, mover: moverDoc.uuid,
        moverName: moverDoc.name, activity: reactor.weapon.activity.uuid, reach: reactor.weapon.reach
      }, { timeout: OPPORTUNITY_TIMEOUT });
    }
    const reason = stoppedBy(moverDoc, stop);
    if (reason) {
      ui.notifications?.info(`Luck Dice Automation: ${moverDoc.name} stops moving: ${reason}.`);
      return;
    }
    remaining = rest;
  }
}

/** The latest movement being made in legs, for what needs to wait for it. */
export let legsDone = null;

/**
 * preMoveToken (the moving user's client; synchronous): a movement that would leave an enemy's reach is
 * refused, and made again in legs (moveWithOpportunityAttacks). Returns false only to refuse it.
 */
export function onPreMoveTokenOA(moverDoc, movement, operation) {
  if (!isOpportunityAttacksEnabled() || !moverDoc?.actor) return;
  const flags = operation?.[MODULE_ID];
  if (flags?.forced || flags?.opportunityLeg || movement?.chain?.length) return;
  if (movingInLegs.has(moverDoc.id)) {
    ui.notifications?.info(`Luck Dice Automation: ${moverDoc.name} is waiting on an opportunity attack.`);
    return false;
  }
  if (!PROVOKING_METHODS.has(movement?.method) || isDisengaged(moverDoc.actor)) return;
  const path = [movement?.origin, ...(movement?.passed?.waypoints ?? []), ...(movement?.pending?.waypoints ?? [])].filter(Boolean);
  if (path.length < 2 || path.slice(1).some(w => NO_PROVOKE_ACTIONS.has(w.action))) return;
  const reactors = opportunityReactors(moverDoc, path);
  if (!reactors.length) return;
  const { method, terrainOptions, constrainOptions, measureOptions, autoRotate, showRuler } = movement;
  movingInLegs.add(moverDoc.id);
  legsDone = new Promise(resolve => setTimeout(resolve, LEG_DELAY))
    .then(() => moveWithOpportunityAttacks(moverDoc, path, reactors, { method, terrainOptions, constrainOptions, measureOptions, autoRotate, showRuler }))
    .catch(err => console.error(`[${MODULE_ID}] opportunity attacks:`, err))
    .finally(() => movingInLegs.delete(moverDoc.id));
  return false;
}

/** On the reactor's player's (or the GM's) client: offer the attack, and make it. Resolves with { identifier } or null. */
export async function answerOpportunity({ token, actor: actorUuid, mover, moverName, activity: activityUuid, reach }) {
  const { tokenDoc, actor } = await resolveTarget({ token, actor: actorUuid });
  if (!actor?.isOwner || !canMakeOpportunityAttack(actor)) return null;
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
  // Settled while the prompt was open: its reaction used on something else, or the mover gone (the wait timed out).
  if (!hasReaction(actor)) return null;
  if (tokenDoc && Number.isFinite(reach) && tokenDistance(tokenDoc, moverDoc) > reach) {
    ui.notifications?.warn(`Luck Dice Automation: ${moverDoc.name} has already moved out of ${name}'s reach.`);
    return null;
  }
  await spendReaction(actor);
  canvas.tokens?.setTargets([moverDoc.id], { mode: "replace" });
  const rolls = await activity.rollAttack({}, {}, { data: { flavor: `${activity.item?.name ?? "Weapon"} - Opportunity Attack` } });
  // Its Luck Dice, reactions and damage too, before the mover carries on.
  await pendingAttacks.get(rolls?.[0]?.parent?.id);
  return { identifier: "opportunity" };
}
