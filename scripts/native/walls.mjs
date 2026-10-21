// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Wall spells: turn the areas they place into real walls.
//
// The "wallSpells" setting. dnd5e places a wall spell's panels or globe as a
// Region, which nothing stops a token walking through (Foundry's region behaviours
// can't block movement sideways). When one of these spells places its area, the
// primary GM's client traces Walls along it — each panel's centre line, or the
// outline of a globe or cube — restricting what the spell blocks:
//   Wall of Force   — movement (it's invisible: sight, light and sound pass);
//   Wall of Stone   — movement, sight, light and sound;
//   Wall of Ice     — movement;
//   Forcecage       — movement;
//   Prismatic Wall  — sight and light (creatures can pass through it, at a cost).
// The walls go with the area: when it's deleted (dnd5e removes it when the
// spell's concentration ends), so are they; and the area is protected like a
// lingering one while the spell lasts (areas.mjs). Foundry walls have no height,
// so they block at any elevation.
// A creature whose space a new Wall of Force, Stone or Ice cuts through is pushed
// to the side the caster chooses — the caster's player is asked, the GM otherwise.
// Solid barriers (Wall of Force, Stone, Ice; Forcecage's solid box) also give total
// cover: an attack or a spell at a creature on the other side is cancelled with a
// message (before anything is spent), and an area spell's effect stops at them —
// creatures cut off from the area's centre are left out of its targets.

import { askReaction } from "./reactions.mjs";
import { isTriggerClient } from "./lingering.mjs";
import { MODULE_ID, debug, escapeHTML, promptChoice, isWallSpellsEnabled, socket, resolveTarget } from "./shared.mjs";

export const WALL_SPELL_FLAG = "wallSpell";      // on the area: { identifier, walls, concentration, caster }
export const WALL_OF_FLAG = "wallOf";           // on each wall: the area's uuid
export const BLOCKS_EFFECT_FLAG = "blocksEffect"; // on each wall: whether it's a solid barrier (total cover)

/**
 * By item identifier: what the walls block, whether creatures in the way are pushed aside, and whether
 * they're a solid barrier nothing targets through (`effect`; by activity for Forcecage: the box, not the cage).
 */
export const WALL_SPELLS = {
  "wall-of-force":  { move: true,  sight: false, light: false, sound: false, push: true,  effect: true },
  "wall-of-stone":  { move: true,  sight: true,  light: true,  sound: true,  push: true,  effect: true },
  "wall-of-ice":    { move: true,  sight: false, light: false, sound: false, push: true,  effect: true },
  "forcecage":      { move: true,  sight: false, light: false, sound: false, push: false, effect: (activityName) => /box/i.test(activityName ?? "") },
  "prismatic-wall": { move: false, sight: true,  light: true,  sound: false, push: false, effect: false }
};
const blocksEffectFor = (identifier, activityName) => {
  const effect = WALL_SPELLS[identifier]?.effect;
  return typeof effect === "function" ? !!effect(activityName) : !!effect;
};

const MAX_OUTLINE_SEGMENTS = 36;

/** dnd5e.postUseActivity (the caster's client): ask the primary GM to raise the spell's walls. */
export async function recordWallSpell(activity, usageConfig, results) {
  const identifier = activity?.item?.system?.identifier;
  if (!isWallSpellsEnabled() || !WALL_SPELLS[identifier]) return;
  const regions = (results?.templates ?? []).filter(r => r?.documentName === "Region");
  if (!regions.length) return;
  const concentration = (results?.effects ?? []).find(e => e?.system?.type === "concentrating" || e?.statuses?.has?.("concentrating"));
  const payload = {
    identifier, regions: regions.map(r => r.uuid), concentration: concentration?.uuid ?? null,
    caster: activity.actor?.uuid ?? null, spell: activity.item.name, activityName: activity.name ?? ""
  };
  if (game.user.isGM) return buildWallsGM(payload);
  socket?.emit("buildWalls", payload);
}

/** The wall segments [x0, y0, x1, y1] for an area: panels' centre lines, else its outline. */
export function wallSegments(region) {
  const segments = [];
  const lines = [...(region?.shapes ?? [])].filter(s => s.type === "line");
  for (const s of lines) {
    const angle = (Number(s.rotation) || 0) * Math.PI / 180;
    segments.push([s.x, s.y, s.x + Math.cos(angle) * s.length, s.y + Math.sin(angle) * s.length]);
  }
  if (!lines.length) {
    for (const polygon of region?.polygons ?? []) {
      const points = polygon.points ?? [];
      const count = points.length / 2;
      const step = Math.max(1, Math.ceil(count / MAX_OUTLINE_SEGMENTS));
      const corners = [];
      for (let i = 0; i < count; i += step) corners.push([points[i * 2], points[i * 2 + 1]]);
      for (let i = 0; i < corners.length; i++) {
        const [a, b] = [corners[i], corners[(i + 1) % corners.length]];
        segments.push([a[0], a[1], b[0], b[1]]);
      }
    }
  }
  return segments.map(c => c.map(Math.round)).filter(([x0, y0, x1, y1]) => x0 !== x1 || y0 !== y1);
}

/** GM side: raise the walls for a wall spell's areas, then push aside anyone in the way. */
export async function buildWallsGM({ identifier, regions, concentration, caster, spell, activityName }) {
  const spec = WALL_SPELLS[identifier];
  if (!spec) return;
  const types = { move: globalThis.CONST?.WALL_MOVEMENT_TYPES ?? { NONE: 0, NORMAL: 20 }, sense: globalThis.CONST?.WALL_SENSE_TYPES ?? { NONE: 0, NORMAL: 20 } };
  for (const uuid of regions ?? []) {
    const region = await fromUuid(uuid);
    const scene = region?.parent;
    if (!scene) continue;
    const segments = wallSegments(region);
    if (!segments.length) continue;
    const data = segments.map(c => ({
      c,
      move: spec.move ? types.move.NORMAL : types.move.NONE,
      sight: spec.sight ? types.sense.NORMAL : types.sense.NONE,
      light: spec.light ? types.sense.NORMAL : types.sense.NONE,
      sound: spec.sound ? types.sense.NORMAL : types.sense.NONE,
      flags: { [MODULE_ID]: { [WALL_OF_FLAG]: uuid, [BLOCKS_EFFECT_FLAG]: blocksEffectFor(identifier, activityName) } }
    }));
    const walls = await scene.createEmbeddedDocuments("Wall", data);
    await region.setFlag(MODULE_ID, WALL_SPELL_FLAG, { identifier, walls: walls.map(w => w.id), concentration, caster, activityName: activityName ?? "" });
    console.log(`[${MODULE_ID}] wall spells: ${spell ?? identifier} — ${walls.length} wall(s)`);
    if (spec.push) await pushAside(scene, segments, { caster, spell: spell ?? identifier });
  }
}

/** deleteRegion (primary GM): a wall spell's walls go with its area. */
export async function onRegionDeletedWalls(region) {
  if (!isTriggerClient()) return;
  const data = region?.getFlag?.(MODULE_ID, WALL_SPELL_FLAG);
  const scene = region?.parent;
  if (!data || !scene) return;
  const ids = (data.walls ?? []).filter(id => scene.walls?.get?.(id));
  const stray = [...(scene.walls ?? [])].filter(w => w.getFlag?.(MODULE_ID, WALL_OF_FLAG) === region.uuid && !ids.includes(w.id)).map(w => w.id);
  if (ids.length || stray.length) await scene.deleteEmbeddedDocuments("Wall", [...ids, ...stray]);
  debug(`wall spells: removed ${ids.length + stray.length} wall(s) with their area`);
}

// ── Pushing creatures out of the way ──────────────────────────────────────────

/** A token's rectangle in pixels, shrunk a hair so touching an edge doesn't count. */
function tokenRect(tokenDoc, at = tokenDoc) {
  const size = canvas?.grid?.size ?? 100;
  return { x: at.x + 1, y: at.y + 1, w: tokenDoc.width * size - 2, h: tokenDoc.height * size - 2 };
}

/** Whether a segment crosses a rectangle (Liang–Barsky). */
export function segmentHitsRect([x0, y0, x1, y1], { x, y, w, h }) {
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x0 - x], [dx, x + w - x0], [-dy, y0 - y], [dy, y + h - y0]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

const COMPASS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
const compass = (nx, ny) => COMPASS[((Math.round(Math.atan2(ny, nx) / (Math.PI / 4)) % 8) + 8) % 8];

/** The two places a token can be pushed to, clear of every segment: [{ side, label, x, y }]. */
export function pushOptions(tokenDoc, segment, segments) {
  const grid = canvas?.grid;
  const size = grid?.size ?? 100;
  const [x0, y0, x1, y1] = segment;
  const length = Math.hypot(x1 - x0, y1 - y0) || 1;
  const normal = [-(y1 - y0) / length, (x1 - x0) / length];
  const options = [];
  for (const [side, sign] of [["a", 1], ["b", -1]]) {
    for (let k = 1; k <= 6; k++) {
      const shift = (k * size) / 2;
      let pos = { x: tokenDoc.x + normal[0] * sign * shift, y: tokenDoc.y + normal[1] * sign * shift };
      pos = grid?.getSnappedPoint?.(pos, { mode: globalThis.CONST?.GRID_SNAPPING_MODES?.TOP_LEFT_CORNER ?? 16 }) ?? pos;
      if (segments.some(s => segmentHitsRect(s, tokenRect(tokenDoc, pos)))) continue;
      options.push({ side, label: `Push to the ${compass(normal[0] * sign, normal[1] * sign)} side`, x: Math.round(pos.x), y: Math.round(pos.y) });
      break;
    }
  }
  return options;
}

/** Push each creature a new wall cuts through to the side the caster picks. */
async function pushAside(scene, segments, { caster, spell }) {
  const casterActor = caster ? await fromUuid(caster) : null;
  for (const tokenDoc of [...(scene.tokens ?? [])]) {
    if (!tokenDoc.actor) continue;
    const segment = segments.find(s => segmentHitsRect(s, tokenRect(tokenDoc)));
    if (!segment) continue;
    const options = pushOptions(tokenDoc, segment, segments);
    if (!options.length) continue;
    let answer = casterActor ? await askReaction(casterActor, {
      kind: "wallSide", actor: casterActor.uuid, targetName: tokenDoc.name, spell, options: options.map(({ side, label }) => ({ side, label }))
    }) : null;
    // The GM decides when the caster's player didn't (offline, closed, timed out).
    if (!answer?.side && game.user.isGM) answer = await answerWallSide({ targetName: tokenDoc.name, spell, options, gmFallback: true });
    const chosen = options.find(o => o.side === answer?.side) ?? options[0];
    await tokenDoc.update({ x: chosen.x, y: chosen.y }, { [MODULE_ID]: { forced: true } });
    debug(`wall spells: pushed ${tokenDoc.name} — ${chosen.label}`);
  }
}

// ── Total cover ───────────────────────────────────────────────────────────────

/** Whether two segments cross. */
function segmentsCross([ax, ay, bx, by], [cx, cy, dx, dy]) {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (d === 0) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t > 0 && t < 1 && u >= 0 && u <= 1;
}

/** The solid-barrier walls on a scene (older walls without the flag go by their area's spell). */
export function effectBarriers(scene) {
  const out = [];
  for (const wall of [...(scene?.walls ?? [])]) {
    const area = wall.getFlag?.(MODULE_ID, WALL_OF_FLAG);
    if (!area) continue;
    let blocks = wall.getFlag(MODULE_ID, BLOCKS_EFFECT_FLAG);
    if (blocks === undefined) {
      const region = scene.regions?.get?.(String(area).split(".").pop());
      const data = region?.getFlag?.(MODULE_ID, WALL_SPELL_FLAG);
      blocks = blocksEffectFor(data?.identifier, data?.activityName);
    }
    if (blocks && Array.isArray(wall.c)) out.push(wall.c);
  }
  return out;
}

const centerOf = (doc) => {
  const size = canvas?.grid?.size ?? 100;
  return doc?.object?.center ?? { x: doc.x + (doc.width * size) / 2, y: doc.y + (doc.height * size) / 2 };
};

/** Whether a solid barrier stands between two points (or tokens) on a scene. */
export function behindBarrier(scene, from, to, barriers = effectBarriers(scene)) {
  if (!barriers.length || !from || !to) return false;
  const a = "x" in from && !("width" in from) ? from : centerOf(from);
  const b = "x" in to && !("width" in to) ? to : centerOf(to);
  return barriers.some(c => segmentsCross([a.x, a.y, b.x, b.y], c));
}

/** The point an area spreads from: a circle's / cone's / line's origin, a rectangle's or polygon's centre. */
export function areaOrigin(region) {
  const shape = [...(region?.shapes ?? [])][0];
  if (!shape) return null;
  if (shape.type === "rectangle") return { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
  if (shape.type === "polygon" && shape.points?.length) {
    const p = shape.points, n = p.length / 2;
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { x += p[i * 2]; y += p[i * 2 + 1]; }
    return { x: x / n, y: y / n };
  }
  return Number.isFinite(shape.x) && Number.isFinite(shape.y) ? { x: shape.x, y: shape.y } : null;
}

/** The user's token for an activity: dnd5e's usage token, else the actor's first token. */
const userToken = (activity) => {
  const t = activity?.getUsageToken?.() ?? activity?.actor?.getActiveTokens?.()?.[0];
  return t?.document ?? t ?? null;
};

/** Targets on the far side of a solid barrier from the activity's user. */
export function blockedTargets(activity) {
  if (!isWallSpellsEnabled()) return [];
  const me = userToken(activity);
  if (!me?.parent) return [];
  const barriers = effectBarriers(me.parent);
  if (!barriers.length) return [];
  return [...(game.user?.targets ?? [])].map(t => t.document ?? t)
    .filter(t => t?.parent === me.parent && t.id !== me.id && behindBarrier(me.parent, me, t, barriers));
}

function warnBlocked(blocked) {
  const names = blocked.map(t => t.name).join(", ");
  ui.notifications?.warn(`Luck Dice Automation: ${names} ${blocked.length === 1 ? "is" : "are"} behind a solid wall (total cover) — untarget ${blocked.length === 1 ? "it" : "them"} to go on.`);
}

/**
 * dnd5e.preUseActivity: a targeted use (not a placed area) at a creature behind a solid
 * barrier is cancelled before anything is spent. Returns false only to cancel.
 */
export function onPreUseActivityWalls(activity) {
  if (activity?.target?.template?.type) return;                  // an area: its effect is checked as it lands
  if (activity?.target?.affects?.type === "self" || activity?.range?.units === "self") return;
  const blocked = blockedTargets(activity);
  if (!blocked.length) return;
  warnBlocked(blocked);
  return false;
}

/** dnd5e.preRollAttackV2: the same for an attack rolled on its own (each ray, an opportunity attack). Returns false only to cancel. */
export function onPreRollAttackWalls(config) {
  const blocked = blockedTargets(config?.subject);
  if (!blocked.length) return;
  warnBlocked(blocked);
  return false;
}

/** On the caster's player's (or the GM's) client: which side? Resolves with { side } or null. */
export async function answerWallSide({ actor: actorUuid, targetName, spell, options, gmFallback = false }) {
  if (!gmFallback) {
    const { actor } = await resolveTarget({ actor: actorUuid });
    if (!actor?.isOwner) return null;
  }
  const choice = await promptChoice(spell ?? "Wall",
    `<p>The ${escapeHTML(spell ?? "wall")} cuts through <strong>${escapeHTML(targetName)}</strong>'s space. Which side is it pushed to?</p>`,
    (options ?? []).map(o => ({ action: o.side, label: o.label })));
  return (options ?? []).some(o => o.side === choice) ? { side: choice } : null;
}
