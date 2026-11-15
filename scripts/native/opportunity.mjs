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
// Feats (each in combat, sharing the reaction): Sentinel — an opportunity attack that hits stops the creature for
// the rest of the turn (Speed 0); 2014: Disengage doesn't stop its opportunity attacks; 2024: an enemy within 5 ft that
// takes the Disengage action, or hits someone else, provokes one; 2014: one that attacks someone else (without the
// feat) can be attacked with its reaction. Polearm Master — a creature coming into the reach of its weapon can be
// attacked with its reaction (2014: an opportunity attack, so not while Disengaged). Mage Slayer (2014) — a creature
// within 5 ft that casts a spell can be attacked with its reaction. Cunning Strike's Withdraw (cunning.mjs): the
// rogue's next movement provokes none.
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
import { tokenDistance, cantMakeOpportunityAttacks, rulesOf } from "./advantage.mjs";
import { isTriggerClient } from "./lingering.mjs";
import { applyMasteryChange, masteryEffect, MASTERY_FLAG } from "./mastery.mjs";
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
  if (!isDisengaged(activity.actor)) {
    await activity.actor.toggleStatusEffect?.(DISENGAGED, { active: true });
    debug(`opportunity attacks: ${activity.actor.name} disengaged`);
  }
  // Sentinel (2024): an enemy within 5 ft may make an opportunity attack against it right away.
  const usage = activity.getUsageToken?.() ?? activity.actor.getActiveTokens?.()?.[0];
  const moverDoc = usage?.document ?? usage;
  if (moverDoc) await sentinelOnDisengage(moverDoc);
}

/** combatTurnChange (primary GM): Disengaged ends with the creature's turn — the status, and dnd5e's stock effect. */
export async function onTurnEndDisengage(combat, prior) {
  if (!isTriggerClient() || !combat?.started || !prior?.tokenId) return;
  const actor = (combat.scene ?? canvas.scene)?.tokens?.get?.(prior.tokenId)?.actor;
  clearWithdraw(actor);
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
 * Where a path (waypoints) crosses the edge of the reactor's reach: leaving it ("exit": the last spot still in
 * reach) or coming into it ("enter": the first spot in reach after being outside), as { segment, progress, point },
 * segment being the index of the waypoint it's heading for. Null when it doesn't.
 */
export function reachCrossing(reactorDoc, moverDoc, waypoints, reach, mode = "exit") {
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
  let last = null, outside = false, entering = false;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const samples = Math.max(1, Math.ceil(length / step));
    for (let s = i === 1 ? 0 : 1; s <= samples; s++) {
      const t = s / samples;
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, elevation: a.elevation };
      const inReach = at(point) <= reach;
      if (mode === "exit") {
        if (inReach) last = { segment: i, progress: i - 1 + t, point: standable(point) ?? last?.point ?? { ...a } };
        else if (last) return last;
        continue;
      }
      if (!inReach) { outside = true; entering = false; continue; }
      if (!outside && !entering) continue;      // started in reach: not coming into it (yet)
      entering = true;
      const spot = standable(point);
      if (spot) return { segment: i, progress: i - 1 + t, point: spot };
    }
  }
  return null;
}

/** Where a path leaves the reactor's reach: the last spot still in reach (reachCrossing's "exit"), or null. */
export function reachExit(reactorDoc, moverDoc, waypoints, reach) {
  return reachCrossing(reactorDoc, moverDoc, waypoints, reach, "exit");
}

/** Whether a path (waypoints) takes the mover from within `reach` of the reactor to beyond it. */
export function leavesReach(reactorDoc, moverDoc, waypoints, reach) {
  return !!reachExit(reactorDoc, moverDoc, waypoints, reach);
}

// ── Stopping at the edge of reach ─────────────────────────────────────────────

const featOf = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;

/**
 * Polearm Master's weapon in hand, for its reaction when a creature enters its reach: { activity, item, reach, modern }
 * or null. 2024 — a Quarterstaff, a Spear, or a weapon with the Heavy and Reach properties; 2014 — a glaive, halberd,
 * pike or quarterstaff.
 */
export function polearmWeapon(actor) {
  const feat = featOf(actor, "polearm-master");
  if (!feat) return null;
  const modern = rulesOf(feat) !== "2014";
  let best = null;
  for (const item of actor?.items ?? []) {
    if (item.type !== "weapon" || item.system?.equipped === false) continue;
    const base = String(item.system?.type?.baseItem ?? "").toLowerCase();
    const props = item.system?.properties;
    const fits = modern ? (["quarterstaff", "spear"].includes(base) || (props?.has?.("hvy") && props?.has?.("rch")))
      : ["glaive", "halberd", "pike", "quarterstaff"].includes(base);
    if (!fits) continue;
    for (const activity of item.system?.activities?.values?.() ?? []) {
      if (!isLike(activity, "attack") || activity.attack?.type?.value !== "melee") continue;
      const reach = Number(item.system?.range?.reach) || (props?.has?.("rch") ? 10 : 5);
      if (!best || reach > best.reach) best = { activity, item, reach };
    }
  }
  return best ? { ...best, modern } : null;
}

/**
 * The enemies that could attack the mover on this path: [{ doc, weapon, mode }] — "exit": an opportunity attack as it
 * leaves their reach; "enter": Polearm Master's reaction as it comes into it. Both must be in the combat. A Disengaged
 * mover provokes no opportunity attacks — except from a 2014 Sentinel — nor a 2014 Polearm Master's (2024's isn't an
 * opportunity attack).
 */
export function opportunityReactors(moverDoc, path, { disengaged = false } = {}) {
  const combat = game.combat;
  if (!combat?.started || !inCombat(combat, moverDoc.id)) return [];
  const reactors = [];
  for (const doc of [...(moverDoc.parent?.tokens ?? [])]) {
    if (doc.id === moverDoc.id || !doc.actor || !doc.disposition || doc.disposition !== -moverDoc.disposition) continue;
    if (!inCombat(combat, doc.id) || !canMakeOpportunityAttack(doc.actor)) continue;
    const sentinel = featOf(doc.actor, "sentinel");
    const weapon = meleeReach(doc.actor);
    if (weapon && (!disengaged || (sentinel && rulesOf(sentinel) === "2014")) && leavesReach(doc, moverDoc, path, weapon.reach)) {
      reactors.push({ doc, weapon, mode: "exit" });
    }
    const polearm = polearmWeapon(doc.actor);
    if (polearm && (polearm.modern || !disengaged) && reachCrossing(doc, moverDoc, path, polearm.reach, "enter")) {
      reactors.push({ doc, weapon: polearm, mode: "enter" });
    }
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

export const HALTED = "sentinel-halt"; // Sentinel's Halt: a mastery-style effect, Speed 0 for the rest of the turn

/** Whether Sentinel has halted this creature this turn. */
export const isHalted = (actor) => [...(actor?.effects ?? [])].some(e => !e.disabled && e.getFlag?.(MODULE_ID, MASTERY_FLAG)?.kind === HALTED);

/** Why the mover can't carry on after an opportunity attack, or null. */
function stoppedBy(moverDoc, stop) {
  const actor = moverDoc.actor;
  if (Number(actor?.system?.attributes?.hp?.value ?? 1) <= 0 || INCAPACITATING.some(s => actor?.statuses?.has?.(s))) return "it can't move";
  if (STOPS_MOVING.some(s => actor?.statuses?.has?.(s))) return "it can't move";
  if (isHalted(actor)) return "Sentinel halted it";
  if (Math.round(moverDoc.x) !== stop.x || Math.round(moverDoc.y) !== stop.y) return "it was moved";
  return null;
}

// Tokens this client is moving in legs, by id: other movements of them wait until that's done.
const movingInLegs = new Set();

/**
 * Make a refused movement again in legs: to the next spot where it leaves an enemy's reach (or comes into a Polearm
 * Master's), the attack from there, and on. Each enemy is asked once for each; those further on, when the path gets there.
 */
export async function moveWithOpportunityAttacks(moverDoc, path, reactors, options = {}) {
  const legOptions = { ...options, [MODULE_ID]: { opportunityLeg: true } };
  const asked = new Set();
  const key = (r) => `${r.doc.id}:${r.mode ?? "exit"}`;
  let remaining = path;
  while (remaining.length > 1) {
    const crossings = reactors.filter(r => !asked.has(key(r)))
      .map(reactor => ({ reactor, at: reachCrossing(reactor.doc, moverDoc, remaining, reactor.weapon.reach, reactor.mode ?? "exit") }))
      .filter(e => e.at).sort((a, b) => a.at.progress - b.at.progress);
    if (!crossings.length) {
      await moverDoc.move(remaining.slice(1).map(cleanWaypoint), legOptions);
      return;
    }
    const { walk, stop, rest } = splitPath(remaining, crossings[0].at);
    if (walk.length) {
      if (!await moverDoc.move(walk, legOptions)) return; // stopped or refused along the way
      await moverDoc.object?.movementAnimationPromise;
    }
    let halted = false;
    for (const { reactor, at } of crossings.filter(e => samePlace(e.at.point, crossings[0].at.point))) {
      asked.add(key(reactor));
      const actor = reactor.doc.actor;
      if (!canMakeOpportunityAttack(actor)) continue;
      const entering = reactor.mode === "enter";
      debug(`opportunity attacks: ${moverDoc.name} stops at (${at.point.x}, ${at.point.y}) for ${reactor.doc.name}${entering ? " (Polearm Master)" : ""}`);
      const answer = await askReaction(actor, {
        kind: "opportunity", token: reactor.doc.uuid, actor: actor.uuid, mover: moverDoc.uuid,
        moverName: moverDoc.name, activity: reactor.weapon.activity.uuid, reach: reactor.weapon.reach,
        // 2024 Polearm Master's attack is a reaction, not an opportunity attack (2014's is one).
        ...(entering ? { reason: "enter", opportunity: !reactor.weapon.modern } : {})
      }, { timeout: OPPORTUNITY_TIMEOUT });
      if (answer?.halted) halted = true;
    }
    const reason = halted ? "Sentinel halted it" : stoppedBy(moverDoc, stop);
    if (reason) {
      ui.notifications?.info(`Luck Dice Automation: ${moverDoc.name} stops moving: ${reason}.`);
      return;
    }
    remaining = rest;
  }
}

// Creatures whose next movement provokes no opportunity attacks (Cunning Strike's Withdraw), by actor uuid.
const withdrawing = new Set();

/** Cunning Strike's Withdraw: the creature's next movement (up to half its Speed) provokes no opportunity attacks. */
export function grantWithdraw(actor) {
  if (actor?.uuid) withdrawing.add(actor.uuid);
}

/** combatTurnChange: a Withdraw not used by the end of the creature's turn is gone. */
export function clearWithdraw(actor) {
  if (actor?.uuid) withdrawing.delete(actor.uuid);
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
  if (!PROVOKING_METHODS.has(movement?.method)) return;
  // Cunning Strike's Withdraw (cunning.mjs): this movement provokes none.
  if (withdrawing.delete(moverDoc.actor.uuid)) return;
  const path = [movement?.origin, ...(movement?.passed?.waypoints ?? []), ...(movement?.pending?.waypoints ?? [])].filter(Boolean);
  if (path.length < 2 || path.slice(1).some(w => NO_PROVOKE_ACTIONS.has(w.action))) return;
  const reactors = opportunityReactors(moverDoc, path, { disengaged: isDisengaged(moverDoc.actor) });
  if (!reactors.length) return;
  const { method, terrainOptions, constrainOptions, measureOptions, autoRotate, showRuler } = movement;
  movingInLegs.add(moverDoc.id);
  legsDone = new Promise(resolve => setTimeout(resolve, LEG_DELAY))
    .then(() => moveWithOpportunityAttacks(moverDoc, path, reactors, { method, terrainOptions, constrainOptions, measureOptions, autoRotate, showRuler }))
    .catch(err => console.error(`[${MODULE_ID}] opportunity attacks:`, err))
    .finally(() => movingInLegs.delete(moverDoc.id));
  return false;
}

// Why the attack is offered (the payload's `reason`): the prompt's title, its text and the card's flavor.
const REASONS = {
  exit:      { title: "Opportunity Attack", what: (m, n) => `<strong>${m}</strong> is leaving <strong>${n}</strong>'s reach.`, flavor: "Opportunity Attack" },
  enter:     { title: "Polearm Master", what: (m, n) => `<strong>${m}</strong> came into <strong>${n}</strong>'s reach (Polearm Master).`, flavor: "Polearm Master" },
  disengage: { title: "Sentinel", what: (m, n) => `<strong>${m}</strong> took the Disengage action within 5 ft of <strong>${n}</strong> (Sentinel).`, flavor: "Sentinel" },
  attack:    { title: "Sentinel", what: (m, n, d) => `<strong>${m}</strong> attacked ${d ? `<strong>${d}</strong>` : "someone else"} within 5 ft of <strong>${n}</strong> (Sentinel).`, flavor: "Sentinel" },
  spell:     { title: "Mage Slayer", what: (m, n) => `<strong>${m}</strong> cast a spell within 5 ft of <strong>${n}</strong> (Mage Slayer).`, flavor: "Mage Slayer" }
};

/** Sentinel's Halt: Speed 0 for the rest of the current turn. */
export function haltEffect(sentinelActor, moverDoc) {
  const zero = ["walk", "fly", "swim", "climb", "burrow"].map(m => ({ key: `system.attributes.movement.speeds.${m}`, type: "override", value: 0 }));
  return masteryEffect(HALTED, sentinelActor, moverDoc.uuid, { name: "Halted (Sentinel)", img: "icons/svg/net.svg", expiry: "turnEnd", changes: zero });
}

/**
 * On the reactor's player's (or the GM's) client: offer the attack, and make it. Resolves with { identifier, halted }
 * or null. `reason` says what set it off (REASONS); `opportunity: false` when it isn't an opportunity attack (2024
 * Polearm Master, 2014 Sentinel's and Mage Slayer's reactions), which Sentinel's Halt doesn't follow.
 */
export async function answerOpportunity({ token, actor: actorUuid, mover, moverName, activity: activityUuid, reach, reason = "exit", detail = null, opportunity = true }) {
  const { tokenDoc, actor } = await resolveTarget({ token, actor: actorUuid });
  if (!actor?.isOwner || !canMakeOpportunityAttack(actor)) return null;
  const moverDoc = await fromUuid(mover);
  const activity = activityUuid ? await fromUuid(activityUuid) : meleeReach(actor)?.activity;
  if (!moverDoc || !activity?.rollAttack) return null;
  const name = tokenDoc?.name ?? actor.name;
  const why = REASONS[reason] ?? REASONS.exit;
  const choice = await promptChoice(why.title,
    `<p>${why.what(escapeHTML(moverName ?? moverDoc.name), escapeHTML(name), detail ? escapeHTML(detail) : null)}
     ${opportunity ? "Make an opportunity attack" : "Use your reaction to attack it"} with ${escapeHTML(activity.item?.name ?? "a melee weapon")}?</p>`,
    [{ action: "attack", label: opportunity ? "Opportunity Attack" : "Attack" }, { action: "no", label: "Let It Go" }]);
  if (choice !== "attack") return null;
  if (canvas?.scene !== moverDoc.parent) {
    ui.notifications?.warn(`Luck Dice Automation: view ${moverDoc.parent?.name ?? "that scene"} to make the attack.`);
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
  const rolls = await activity.rollAttack({}, {}, { data: { flavor: `${activity.item?.name ?? "Weapon"} - ${why.flavor}` } });
  // Its Luck Dice, reactions and damage too, before the mover carries on.
  const cardId = rolls?.[0]?.parent?.id;
  await pendingAttacks.get(cardId);
  // Sentinel's Halt: an opportunity attack that hits stops the creature for the rest of the turn.
  const card = cardId ? game.messages?.get?.(cardId) : null;
  const hit = (card?.system?.evaluatedTargets ?? []).some(t => t.token === moverDoc.uuid && !t.isMiss);
  let halted = false;
  if (opportunity && hit && featOf(actor, "sentinel") && moverDoc.actor) {
    await applyMasteryChange({ kind: HALTED, token: moverDoc.uuid, actor: moverDoc.actor.uuid, effect: haltEffect(actor, moverDoc) });
    halted = true;
    debug(`sentinel: ${name} halted ${moverDoc.name}`);
  }
  return { identifier: "opportunity", halted };
}

// ── Sentinel, Mage Slayer: attacks set off by something else ──────────────────

/** The creatures within 5 ft of a token that could attack it with a reaction for this feat: [{ doc, weapon }]. */
export function reactorsNear(sourceDoc, identifier, rules = null) {
  const combat = game.combat;
  if (!sourceDoc?.parent || !combat?.started) return [];
  return [...(sourceDoc.parent.tokens ?? [])].filter(doc => doc.id !== sourceDoc.id && doc.actor && doc.disposition
    && doc.disposition === -sourceDoc.disposition && inCombat(combat, doc.id))
    .map(doc => ({ doc, feat: featOf(doc.actor, identifier), weapon: meleeReach(doc.actor) }))
    .filter(r => r.feat && r.weapon && (!rules || rulesOf(r.feat) === rules) && canMakeOpportunityAttack(r.doc.actor)
      && tokenDistance(r.doc, sourceDoc) <= 5);
}

/** Ask each in turn (the first to attack ends it). */
async function askEach(reactors, sourceDoc, payload) {
  for (const { doc, weapon } of reactors) {
    if (!hasReaction(doc.actor)) continue;
    const answer = await askReaction(doc.actor, {
      kind: "opportunity", token: doc.uuid, actor: doc.actor.uuid, mover: sourceDoc.uuid, moverName: sourceDoc.name,
      activity: weapon.activity.uuid, reach: Math.max(5, weapon.reach), ...payload
    }, { timeout: OPPORTUNITY_TIMEOUT });
    if (answer?.identifier) return answer;
  }
  return null;
}

/**
 * Sentinel's Guardian (2024), after a creature takes the Disengage action (onDisengageUsed): each enemy within 5 ft with
 * the feat may make an opportunity attack against it.
 */
export async function sentinelOnDisengage(moverDoc) {
  const reactors = reactorsNear(moverDoc, "sentinel", "2024");
  if (reactors.length) await askEach(reactors, moverDoc, { reason: "disengage" });
}

/**
 * After an attack (attacks.mjs, on the attacker's client): Sentinel's reaction against the attacker, from a creature
 * within 5 ft of it — 2024: the attack hit a creature other than the Sentinel (an opportunity attack); 2014: it was made
 * against a creature other than the Sentinel without the feat itself (a melee weapon attack, with its reaction).
 */
export async function offerSentinel(message, activity) {
  if (!isOpportunityAttacksEnabled() || !message?.system || !isLike(activity, "attack")) return;
  const usage = activity?.getUsageToken?.() ?? activity?.actor?.getActiveTokens?.()?.[0];
  const attackerDoc = usage?.document ?? usage;
  if (!attackerDoc?.actor) return;
  const targets = message.system.evaluatedTargets ?? [];
  for (const reactor of reactorsNear(attackerDoc, "sentinel")) {
    const modern = rulesOf(reactor.feat) !== "2014";
    const others = targets.filter(t => t.token !== reactor.doc.uuid && (modern ? !t.isMiss : true));
    const victim = modern ? others[0] : await (async () => {
      for (const t of others) {
        const actor = (t.token ? await fromUuid(t.token) : null)?.actor ?? (t.actor ? await fromUuid(t.actor) : null);
        if (!featOf(actor, "sentinel")) return t;
      }
      return null;
    })();
    if (!victim) continue;
    const answer = await askEach([reactor], attackerDoc, { reason: "attack", detail: victim.name, opportunity: modern });
    if (answer?.identifier) debug(`sentinel: ${reactor.doc.name} attacked ${attackerDoc.name}`);
  }
}

/**
 * Mage Slayer (2014), after a spell is cast (the caster's client): each enemy within 5 ft with the feat may make a melee
 * weapon attack against the caster with its reaction.
 */
export async function mageSlayerOnCast(activity) {
  if (!isOpportunityAttacksEnabled() || activity?.item?.type !== "spell") return;
  const usage = activity.getUsageToken?.() ?? activity.actor?.getActiveTokens?.()?.[0];
  const casterDoc = usage?.document ?? usage;
  if (!casterDoc?.actor) return;
  const reactors = reactorsNear(casterDoc, "mage-slayer", "2014");
  if (reactors.length) await askEach(reactors, casterDoc, { reason: "spell", opportunity: false });
}
