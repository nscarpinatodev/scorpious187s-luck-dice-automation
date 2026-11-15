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
// A destination that fails is turned down (nothing moves), and another can be picked: a click on one of the
// highlighted spaces teleports the token there (right-click or Escape gives it up).
// Other modules move the token themselves — Automated Animations' teleportation presets (Misty Step's among them)
// let you click a spot inside a range circle they don't enforce, then "displace" the token there. So once a creature
// uses a Teleport activity (onTeleportUsed), its token's next teleport-style movement (Foundry's blink or displace,
// whoever makes it) is checked the same way as it starts (preMoveToken), and turned down the same way. With an Automated
// Animations teleport preset for the activity, each click on the canvas is checked first (gateClicks): one on a spot it
// can't go to is kept from AA — no animation, and AA keeps waiting — and one it can go to is passed on, so AA's animation
// only ever plays for a teleport that's made.
// While a teleport waits to be made, the caster's client highlights where it can go: each grid space in range (the
// scene's own diagonal rule), unoccupied and in sight as its text asks — or, for a long range (Dimension Door) or a
// gridless scene, a circle of its range. It goes once the teleport is made or cancelled, or after a few minutes.

import { levelOf } from "./advantage.mjs";
import { MODULE_ID, debug, isTeleportRangeEnabled } from "./shared.mjs";

// The range dnd5e worked out for each teleport being planned (dnd5e.preTeleport), by activity.
const ranges = new WeakMap();
// A small allowance for rounding (a diagonal on a gridless scene, say).
const SLACK = 0.5;
// Teleports being planned, by token id: { activity, maxDistance, needs, until, turnedDown }.
const planning = new Map();
// How long a teleport stays planned for its token (the activity used, its movement not made yet).
const PLAN_WINDOW = 5 * 60_000;

/** A Teleport activity's range in the scene's units (dnd5e converts its distance the same way), or null. */
export function teleportRange(activity, scene = canvas?.scene) {
  const value = Number(activity?.teleport?.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const from = activity.teleport.units ?? "ft", to = scene?.grid?.units;
  if (!to || from === to || !(to in (CONFIG.DND5E?.movementUnits ?? {}))) return value;
  try { return globalThis.dnd5e?.utils?.convertLength?.(value, from, to) ?? value; } catch { return value; }
}

// ── Showing where it can go ───────────────────────────────────────────────────

// Beyond this many grid spaces of range, a circle instead of each space.
const MAX_SPACES = 25;
const COLOR = 0x4fb3e8, BORDER = 0x2a7fb0;
const layerName = (id) => `${MODULE_ID}.teleport.${id}`;

/** The grid spaces (top-left points) a teleport from where the token stands could land on. */
export function teleportSpots(tokenDoc, maxDistance, needs = {}) {
  const grid = canvas?.grid;
  if (!grid || grid.isGridless || !Number.isFinite(maxDistance) || !tokenDoc) return [];
  const size = grid.size, reach = Math.ceil(maxDistance / grid.distance);
  const origin = { x: tokenDoc.x, y: tokenDoc.y, elevation: tokenDoc.elevation ?? 0, width: tokenDoc.width ?? 1, height: tokenDoc.height ?? 1 };
  const spots = [];
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if (!dx && !dy) continue;
      const destination = { ...origin, x: origin.x + dx * size, y: origin.y + dy * size };
      if (!teleportProblem(tokenDoc, { origin, destination }, maxDistance, needs)) spots.push({ x: destination.x, y: destination.y });
    }
  }
  return spots;
}

/** Highlight where a token's teleport can go, on this client. */
function showRange(tokenDoc, entry) {
  const highlights = canvas?.interface?.grid, grid = canvas?.grid;
  if (!highlights?.addHighlightLayer || !grid || !tokenDoc || tokenDoc.parent !== canvas.scene) return;
  const name = layerName(tokenDoc.id);
  highlights.destroyHighlightLayer?.(name);
  const layer = highlights.addHighlightLayer(name);
  const spaces = Number.isFinite(entry.maxDistance) ? Math.ceil(entry.maxDistance / grid.distance) : Infinity;
  if (!grid.isGridless && spaces <= MAX_SPACES) {
    for (const spot of teleportSpots(tokenDoc, entry.maxDistance, entry.needs)) {
      highlights.highlightPosition(name, { x: spot.x, y: spot.y, color: COLOR, border: BORDER, alpha: 0.3 });
    }
  } else if (Number.isFinite(entry.maxDistance) && layer?.lineStyle) {
    const center = centerOf(tokenDoc, grid);
    const radius = (entry.maxDistance / grid.distance) * grid.size + ((tokenDoc.width ?? 1) * grid.size) / 2;
    layer.lineStyle(4, BORDER, 0.9).beginFill(COLOR, 0.1).drawCircle(center.x, center.y, radius).endFill();
  }
}

/** Take a token's teleport highlight away. */
function hideRange(id) {
  canvas?.interface?.grid?.destroyHighlightLayer?.(layerName(id));
}

/** canvasReady: the highlights of teleports still waiting, on the scene now shown. */
export function redrawTeleportRanges() {
  for (const [id, entry] of planning) {
    const tokenDoc = canvas?.scene?.tokens?.get?.(id);
    if (tokenDoc) showRange(tokenDoc, entry);
  }
}

/** Done with a token's teleport: made, cancelled or run out. */
function endPlanned(id) {
  planning.delete(id);
  hideRange(id);
  if (picking?.tokenId === id) cancelPick();
  if (gate?.tokenId === id) stopGate();
}

/** Note a teleport about to be made by these tokens, and show where each can go. */
function notePlanned(activity, tokens, maxDistance) {
  const entry = { activity, maxDistance: Number.isFinite(maxDistance) ? maxDistance : null, needs: teleportNeeds(activity), until: Date.now() + PLAN_WINDOW };
  for (const token of tokens ?? []) {
    const tokenDoc = token?.document ?? token;
    if (!tokenDoc?.id) continue;
    const mine = { ...entry };
    planning.set(tokenDoc.id, mine);
    try { showRange(tokenDoc, mine); } catch (err) { console.error(`[${MODULE_ID}] teleport range:`, err); }
    const timer = setTimeout(() => { if (planning.get(tokenDoc.id) === mine) endPlanned(tokenDoc.id); }, PLAN_WINDOW);
    timer?.unref?.(); // (Node, for the tests: don't keep the process waiting)
  }
}

/**
 * dnd5e.postUseActivity: a Teleport activity used (Misty Step…) — its user's token's next teleport-style movement is held
 * to it, whichever module makes it (Automated Animations' teleportation presets move the token themselves).
 */
export function onTeleportUsed(activity) {
  if (!isTeleportRangeEnabled() || activity?.type !== "teleport" || !activity.actor?.isOwner) return;
  const usage = activity.getUsageToken?.();
  const tokens = usage ? [usage] : (activity.actor.getActiveTokens?.() ?? []);
  notePlanned(activity, tokens, teleportRange(activity));
  // Automated Animations' teleport preset takes the next click: check it first, so its animation only plays for a spot
  // the token can go to.
  const tokenDoc = tokens[0]?.document ?? tokens[0];
  if (tokenDoc && aaTeleports(activity.item)) gateClicks(tokenDoc, planning.get(tokenDoc.id));
}

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
  // Off the map (the scene's own area, not its padding).
  const rect = canvas?.dimensions?.sceneRect;
  if (rect && tokenDoc?.parent === canvas?.scene && (destination.x < rect.x || destination.y < rect.y
    || destination.x + (destination.width ?? tokenDoc?.width ?? 1) * grid.size > rect.x + rect.width + 1
    || destination.y + (destination.height ?? tokenDoc?.height ?? 1) * grid.size > rect.y + rect.height + 1)) return "that's off the map";
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
  if (!activity) return;
  if (Number.isFinite(config?.maxDistance)) ranges.set(activity, config.maxDistance);
  notePlanned(activity, config?.tokens, config?.maxDistance);
}

/** dnd5e.postTeleport: the teleport is made; its tokens move freely again. */
export function onPostTeleport(_activity, results) {
  for (const r of results ?? []) endPlanned((r?.token?.document ?? r?.token)?.id);
}

// ── Automated Animations' teleport presets ────────────────────────────────────

/**
 * Whether Automated Animations will run a teleportation preset for this item: the item's own AA settings, or a global
 * preset whose label matches its name (AA's partial or exact match, less its excluded terms).
 */
export function aaTeleports(item) {
  if (!game.modules?.get?.("autoanimations")?.active || !item) return false;
  const own = item.flags?.autoanimations;
  if (own?.isEnabled === false) return false;
  if (own?.isCustomized && own?.menu === "preset") return own?.presetType === "teleportation";
  let presets = [];
  try { presets = game.settings.get("autoanimations", "aaAutorec-preset") ?? []; } catch { presets = []; }
  const name = String(item.name ?? "").toLowerCase();
  return presets.some(p => {
    const label = String(p?.label ?? "").toLowerCase();
    if (p?.presetType !== "teleportation" || !label) return false;
    if ((p.advanced?.excludedTerms ?? []).some(t => t && name.includes(String(t).toLowerCase()))) return false;
    return p.advanced?.exactMatch ? name === label : name.includes(label);
  });
}

// The click check waiting on this client for an AA teleport: { tokenId, stop }.
let gate = null;

/** Stop checking clicks for an AA teleport. */
export function stopGate() {
  const current = gate;
  gate = null;
  current?.stop();
}

/**
 * Check each click on the canvas before Automated Animations sees it: a spot the token can't teleport to is kept from
 * AA (said why); one it can is passed on. Ends with the teleport, Escape, or the teleport's window running out.
 */
function gateClicks(tokenDoc, entry) {
  const view = canvas?.app?.view;
  if (!view || !tokenDoc || typeof window?.addEventListener !== "function") return false;
  stopGate();
  let swallowUp = false;
  const onDown = (event) => {
    if (event.target !== view || event.button !== 0) return;
    if (planning.get(tokenDoc.id) !== entry) { stopGate(); return; }
    const spot = spotAt(tokenDoc, canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY }));
    const origin = { x: tokenDoc.x, y: tokenDoc.y, elevation: tokenDoc.elevation ?? 0, width: tokenDoc.width, height: tokenDoc.height };
    if (spot && spot.x === origin.x && spot.y === origin.y) return; // the token itself (picking it up to drag)
    const problem = spot ? teleportProblem(tokenDoc, { origin, destination: { ...origin, ...spot } }, entry.maxDistance, entry.needs) : null;
    if (!problem) return;                                           // on to AA
    event.preventDefault(); event.stopImmediatePropagation();
    swallowUp = true;
    ui.notifications?.warn(`Luck Dice Automation: ${entry.activity.item?.name ?? "Teleport"} can't go there — ${problem}. Click a highlighted space.`);
  };
  const onUp = (event) => { if (swallowUp && event.target === view) { event.preventDefault(); event.stopImmediatePropagation(); swallowUp = false; } };
  const onKey = (event) => { if (event.key === "Escape") stopGate(); };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKey, true);
  const timer = setTimeout(() => { if (gate?.tokenId === tokenDoc.id) stopGate(); }, Math.max(0, entry.until - Date.now()));
  timer?.unref?.();
  gate = {
    tokenId: tokenDoc.id,
    stop: () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
    }
  };
  return true;
}

// ── Picking again ─────────────────────────────────────────────────────────────

// The pick waiting for a click on this client: { tokenId, stop }.
let picking = null;

/** The spot a click on the canvas puts the token on: its grid space (centred on it, for a bigger token). */
export function spotAt(tokenDoc, point) {
  const grid = canvas?.grid;
  const w = tokenDoc?.width ?? 1, h = tokenDoc?.height ?? 1;
  if (!grid || !point) return null;
  if (grid.isGridless || !grid.getOffset || !grid.getTopLeftPoint) {
    return { x: Math.round(point.x - (w * grid.size) / 2), y: Math.round(point.y - (h * grid.size) / 2) };
  }
  const offset = grid.getOffset(point);
  const corner = grid.getTopLeftPoint({ i: offset.i - Math.floor((h - 1) / 2), j: offset.j - Math.floor((w - 1) / 2) });
  return { x: Math.round(corner.x), y: Math.round(corner.y) };
}

/** Stop waiting for a click; `abandon` also ends the teleport (its highlight goes). */
export function cancelPick(abandon = false) {
  const current = picking;
  picking = null;
  current?.stop();
  if (abandon && current) endPlanned(current.tokenId);
}

/**
 * Wait for a click on one of the highlighted spaces, and teleport the token there (Foundry's blink). A click elsewhere
 * says why and keeps waiting; right-click or Escape gives the teleport up. Clicks are taken before Foundry sees them,
 * so nothing else on the canvas is selected meanwhile. False when this client can't wait for a click.
 */
function pickSpot(tokenDoc, entry) {
  const view = canvas?.app?.view;
  if (!view || !tokenDoc || typeof window?.addEventListener !== "function") return false;
  cancelPick();
  let swallowUp = false;
  const onDown = (event) => {
    if (event.target !== view) return;
    event.preventDefault(); event.stopImmediatePropagation();
    swallowUp = true;
    if (event.button === 2) { cancelPick(true); ui.notifications?.info(`Luck Dice Automation: ${entry.activity.item?.name ?? "Teleport"} cancelled.`); return; }
    if (event.button !== 0) return;
    const spot = spotAt(tokenDoc, canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY }));
    const origin = { x: tokenDoc.x, y: tokenDoc.y, elevation: tokenDoc.elevation ?? 0, width: tokenDoc.width, height: tokenDoc.height };
    const problem = spot ? teleportProblem(tokenDoc, { origin, destination: { ...origin, ...spot } }, entry.maxDistance, entry.needs) : "nowhere to go";
    if (problem) { ui.notifications?.warn(`Luck Dice Automation: can't go there — ${problem}. Click a highlighted space.`); return; }
    cancelPick();
    tokenDoc.move([{ x: spot.x, y: spot.y, action: "blink" }], { method: "api" })
      .catch(err => console.error(`[${MODULE_ID}] teleport:`, err));
  };
  const onUp = (event) => { if (swallowUp && event.target === view) { event.preventDefault(); event.stopImmediatePropagation(); swallowUp = false; } };
  const onMenu = (event) => { if (event.target === view) event.preventDefault(); };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopImmediatePropagation();
    cancelPick(true);
    ui.notifications?.info(`Luck Dice Automation: ${entry.activity.item?.name ?? "Teleport"} cancelled.`);
  };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("contextmenu", onMenu, true);
  window.addEventListener("keydown", onKey, true);
  picking = {
    tokenId: tokenDoc.id,
    stop: () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("contextmenu", onMenu, true);
      window.removeEventListener("keydown", onKey, true);
    }
  };
  return true;
}

/**
 * Turn a destination down: say why, and let a new spot be picked — a click on a highlighted space, or (where this
 * client can't take clicks) dnd5e's own Teleport placement.
 */
function turnDown(activity, tokenDoc, problem, tokens) {
  debug(`teleport: ${tokenDoc?.name} turned down (${problem})`);
  for (const t of tokens) { const entry = planning.get((t.document ?? t).id); if (entry) entry.turnedDown = Date.now(); }
  const entry = planning.get(tokenDoc?.id);
  setTimeout(() => {
    if (entry && planning.get(tokenDoc.id) === entry && pickSpot(tokenDoc, entry)) {
      ui.notifications?.warn(`Luck Dice Automation: ${activity.item?.name ?? "Teleport"} can't go there — ${problem}. Click a highlighted space (right-click or Escape cancels).`);
      return;
    }
    ui.notifications?.warn(`Luck Dice Automation: ${activity.item?.name ?? "Teleport"} can't go there — ${problem}. Pick another spot.`);
    tokens.forEach((t, i) => t.control?.({ releaseOthers: i === 0 }));
    Promise.resolve(activity.planTeleport?.()).catch(err => console.error(`[${MODULE_ID}] teleport:`, err));
  }, 50);
}

/** Whether a movement action is a teleport (Foundry's blink and displace). */
const teleports = (action) => action === "blink" || action === "displace" || !!CONFIG.Token?.movement?.actions?.[action]?.teleport;

/**
 * preMoveToken (the moving user's client; synchronous): the teleport-style movement of a token whose teleport was just
 * used — dnd5e's planned blink, or another module's displace (Automated Animations) — checked as it starts. Returns
 * false only to stop it.
 */
export function onPreMoveTokenTeleport(tokenDoc, movement, operation) {
  if (!isTeleportRangeEnabled() || !tokenDoc?.id) return;
  const entry = planning.get(tokenDoc.id);
  if (!entry) return;
  if (entry.until < Date.now()) { endPlanned(tokenDoc.id); return; }
  const flags = operation?.[MODULE_ID];
  if (flags?.forced || flags?.opportunityLeg) return; // this module's own moves (a push, a leg of a move)
  const waypoints = [...(movement?.passed?.waypoints ?? []), ...(movement?.pending?.waypoints ?? [])];
  if (!waypoints.length || !waypoints.every(w => teleports(w?.action))) return;
  const plan = { origin: movement?.origin, destination: movement?.destination ?? waypoints.at(-1) };
  const problem = teleportProblem(tokenDoc, plan, entry.maxDistance, entry.needs);
  if (!problem) { endPlanned(tokenDoc.id); return; } // the teleport is made
  debug(`teleport: ${tokenDoc.name}'s ${waypoints.at(-1)?.action} by ${movement?.method ?? "?"} stopped`);
  // Already turned down as dnd5e planned it (and planned again): just stop the movement.
  if (entry.turnedDown && Date.now() - entry.turnedDown < 3000) return false;
  turnDown(entry.activity, tokenDoc, problem, [tokenDoc.object].filter(Boolean));
  return false;
}

/**
 * dnd5e.teleport (the moving user's client; synchronous): turn down a destination out of range, taken, or out of
 * sight, and plan again. Returns false only to stop the teleport.
 */
export function onTeleport(activity, plans) {
  if (!activity) return;
  if (!plans?.length) {
    // Cancelled: its tokens move freely again.
    for (const [id, entry] of [...planning]) if (entry.activity === activity) endPlanned(id);
    return;
  }
  if (!isTeleportRangeEnabled()) return;
  const maxDistance = ranges.get(activity) ?? null;
  const needs = teleportNeeds(activity);
  for (const { token, plan } of plans) {
    const tokenDoc = token?.document ?? token;
    const problem = teleportProblem(tokenDoc, plan, maxDistance, needs);
    if (!problem) continue;
    turnDown(activity, tokenDoc, problem, plans.map(p => p.token?.object ?? p.token).filter(Boolean));
    return false;
  }
}
