// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Teleport range, under the "teleportRange" setting.
//
// dnd5e 6's Teleport activity (Misty Step, Fey Step, Thunder Step, Dimension Door…) puts a Teleport button on
// its card, which plans the token's movement through Foundry (a "blink", in a straight line, up to the range).
// Dragging the token stops at the range; a click on the canvas lands wherever it was clicked. So before the
// token moves (dnd5e.teleport), each planned destination is checked:
//   range       — no farther than the activity's teleport distance (dnd5e works it out in scene units);
//   unoccupied  — for "an unoccupied space": no other creature's token there;
//   in sight    — for "a space you can see": nothing blocking sight on the way.
// A destination that fails is turned down (nothing moves), and the planning starts again so another can be picked
// (Escape, or right-click, cancels it as usual).

import { levelOf } from "./advantage.mjs";
import { MODULE_ID, debug, isTeleportRangeEnabled } from "./shared.mjs";

// The range dnd5e worked out for each teleport being planned (dnd5e.preTeleport), by activity.
const ranges = new WeakMap();
// A small allowance for rounding (a diagonal on a gridless scene, say).
const SLACK = 0.5;

const plain = (html) => String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

/** What the teleport's text asks of the destination: { unoccupied, sight }. */
export function teleportNeeds(activity) {
  const text = [activity?.description?.chatFlavor, activity?.item?.system?.description?.value].map(plain).join(" ");
  const sentences = text.split(/(?<=\.)\s/).filter(s => /teleport/i.test(s));
  return {
    unoccupied: sentences.some(s => /unoccupied/i.test(s)),
    sight: sentences.some(s => /\byou can see\b/i.test(s))
  };
}

/** A position's center, in pixels (a token's top-left and size in grid spaces). */
function centerOf(position, grid) {
  return { x: position.x + ((position.width ?? 1) * grid.size) / 2, y: position.y + ((position.height ?? 1) * grid.size) / 2 };
}

/** Whether two token rectangles (top-left and size in grid spaces) overlap. */
function overlaps(a, b, size) {
  const aw = (a.width ?? 1) * size, ah = (a.height ?? 1) * size, bw = (b.width ?? 1) * size, bh = (b.height ?? 1) * size;
  return a.x < b.x + bw - 1 && b.x < a.x + aw - 1 && a.y < b.y + bh - 1 && b.y < a.y + ah - 1;
}

/**
 * Why this planned teleport can't land where it was pointed, or null when it can. `plan` is Foundry's planned
 * movement ({ origin, destination }); `maxDistance` the range in scene units.
 */
export function teleportProblem(tokenDoc, plan, maxDistance, needs = {}) {
  const grid = canvas?.grid;
  const origin = plan?.origin, destination = plan?.destination;
  if (!grid || !origin || !destination) return null;
  if (Number.isFinite(maxDistance)) {
    const distance = Number(grid.measurePath?.([origin, destination])?.distance);
    if (Number.isFinite(distance) && distance > maxDistance + SLACK) {
      return `that's ${Math.round(distance)} ${grid.units || "ft"} away; it reaches ${maxDistance} ${grid.units || "ft"}`;
    }
  }
  const scene = tokenDoc?.parent;
  if (needs.unoccupied && scene) {
    const there = [...(scene.tokens ?? [])].find(t => t.id !== tokenDoc.id && t.actor && !(t.hidden && !game.user?.isGM)
      && overlaps({ x: destination.x, y: destination.y, width: destination.width ?? tokenDoc.width, height: destination.height ?? tokenDoc.height },
        { x: t.x, y: t.y, width: t.width, height: t.height }, grid.size));
    if (there) return `that space is taken (${there.name})`;
  }
  if (needs.sight) {
    if (tokenDoc?.actor?.statuses?.has?.("blinded")) return "it needs a space you can see, and you're Blinded";
    const backend = CONFIG.Canvas?.polygonBackends?.sight;
    const level = levelOf(tokenDoc), elevation = Number(origin.elevation ?? tokenDoc?.elevation) || 0;
    const from = { ...centerOf({ ...origin, width: origin.width ?? tokenDoc?.width, height: origin.height ?? tokenDoc?.height }, grid), elevation };
    const to = { ...centerOf({ ...destination, width: destination.width ?? tokenDoc?.width, height: destination.height ?? tokenDoc?.height }, grid),
      elevation: Number(destination.elevation ?? elevation) || 0 };
    let blocked = false;
    try { blocked = !!backend?.testCollision?.(from, to, { type: "sight", mode: "any", ...(level ? { level } : {}) }); } catch { blocked = false; }
    if (blocked) return "you can't see that space from here";
  }
  return null;
}

/** dnd5e.preTeleport: note the range dnd5e worked out for this teleport (scene units). Never cancels. */
export function onPreTeleport(activity, config) {
  if (activity && Number.isFinite(config?.maxDistance)) ranges.set(activity, config.maxDistance);
}

/**
 * dnd5e.teleport (the moving user's client; synchronous): turn down a destination out of range, taken, or out of
 * sight, and plan again. Returns false only to stop the teleport.
 */
export function onTeleport(activity, plans) {
  if (!isTeleportRangeEnabled() || !activity || !plans?.length) return;
  const maxDistance = ranges.get(activity) ?? null;
  const needs = teleportNeeds(activity);
  for (const { token, plan } of plans) {
    const tokenDoc = token?.document ?? token;
    const problem = teleportProblem(tokenDoc, plan, maxDistance, needs);
    if (!problem) continue;
    ui.notifications?.warn(`Luck Dice Automation: ${activity.item?.name ?? "Teleport"} can't go there — ${problem}. Pick another spot.`);
    debug(`teleport: ${tokenDoc?.name} turned down (${problem})`);
    // Plan again once this one is finished with (Escape cancels it) — for the same tokens, selected again (dnd5e
    // plans for the selected ones).
    const tokens = plans.map(p => p.token?.object ?? p.token).filter(t => t?.control);
    setTimeout(() => {
      tokens.forEach((t, i) => t.control({ releaseOthers: i === 0 }));
      Promise.resolve(activity.planTeleport?.()).catch(err => console.error(`[${MODULE_ID}] teleport:`, err));
    }, 50);
    return false;
  }
}
