import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  wallSegments, segmentHitsRect, pushOptions, buildWallsGM, recordWallSpell, onRegionDeletedWalls, WALL_SPELL_FLAG, WALL_OF_FLAG
} from "../scripts/native/walls.mjs";
import { onPreDeleteRegion } from "../scripts/native/areas.mjs";
import { triggerActivity } from "../scripts/native/lingering.mjs";

const { settings, makeToken, prompts, uuids, scene } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

canvas.grid = { isGridless: false, distance: 5, size: 100, getSnappedPoint: (p) => ({ x: Math.round(p.x / 100) * 100, y: Math.round(p.y / 100) * 100 }) };

let created = [];
beforeEach(() => {
  env.reset();
  settings.wallSpells = true;
  game.users = [game.user];
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => game.user } } });
  created = [];
  scene.walls = Object.assign([], { get(id) { return this.find(w => w.id === id); } });
  scene.createEmbeddedDocuments = async (type, data) => {
    const docs = data.map((d, i) => ({ id: `w${created.length + i}`, ...d, getFlag: (m, k) => d.flags?.[m]?.[k] }));
    created.push(...docs); scene.walls.push(...docs);
    return docs;
  };
  scene.deleteEmbeddedDocuments = async (type, ids) => { scene.deleted = ids; };
});

let seq = 0;
function region(shapes, polygons = []) {
  const r = { uuid: `Scene.s.Region.r${++seq}`, documentName: "Region", parent: scene, shapes, polygons, flags: {},
    getFlag: (m, k) => r.flags[m]?.[k], async setFlag(m, k, v) { (r.flags[m] ??= {})[k] = v; } };
  uuids.set(r.uuid, r);
  return r;
}
function creature(name, col, row) {
  const token = makeToken(`${name}${++seq}`, name);
  Object.assign(token.document, { x: col * 100, y: row * 100, width: 1, height: 1, moved: null,
    async update(u, options) { token.document.moved = { ...u, options }; } });
  return token.document;
}

test("panels become their centre lines; a globe its outline (thinned to at most 36 sides)", () => {
  const panels = region([
    { type: "line", x: 0, y: 200, length: 200, width: 2, rotation: 0 },
    { type: "line", x: 200, y: 200, length: 200, width: 2, rotation: 90 }
  ]);
  assert.deepEqual(wallSegments(panels), [[0, 200, 200, 200], [200, 200, 200, 400]]);
  const points = [];
  for (let i = 0; i < 72; i++) points.push(Math.round(500 + 200 * Math.cos(i * Math.PI / 36)), Math.round(500 + 200 * Math.sin(i * Math.PI / 36)));
  const globe = region([{ type: "circle", x: 500, y: 500, radius: 200 }], [{ points }]);
  const outline = wallSegments(globe);
  assert.equal(outline.length, 36);
  assert.deepEqual(outline.at(-1).slice(2), outline[0].slice(0, 2));   // closed
});

test("the walls block what the spell blocks, and the area remembers them", async () => {
  const stone = region([{ type: "line", x: 0, y: 0, length: 200, width: 2, rotation: 0 }]);
  await buildWallsGM({ identifier: "wall-of-stone", regions: [stone.uuid], concentration: "C", caster: null, spell: "Wall of Stone" });
  assert.deepEqual(created.map(w => [w.move, w.sight, w.light, w.sound]), [[20, 20, 20, 20]]);
  assert.equal(created[0].flags[MODULE_ID][WALL_OF_FLAG], stone.uuid);
  assert.equal(created[0].flags[MODULE_ID].blocksEffect, true);
  assert.deepEqual(stone.flags[MODULE_ID][WALL_SPELL_FLAG], { identifier: "wall-of-stone", walls: ["w0"], concentration: "C", caster: null, activityName: "" });

  const force = region([{ type: "line", x: 0, y: 500, length: 200, width: 2, rotation: 0 }]);
  await buildWallsGM({ identifier: "wall-of-force", regions: [force.uuid] });
  assert.deepEqual([created[1].move, created[1].sight, created[1].light, created[1].sound], [20, 0, 0, 0]);
  const prismatic = region([{ type: "line", x: 0, y: 900, length: 200, width: 2, rotation: 0 }]);
  await buildWallsGM({ identifier: "prismatic-wall", regions: [prismatic.uuid] });
  assert.deepEqual([created[2].move, created[2].sight], [0, 20]);
});

test("a creature the wall cuts through: the caster's player picks the side; the GM if they don't", async () => {
  const caster = makeToken("caster", "Wizard").document.actor;
  const player = { id: "p1", isGM: false, active: true };
  game.users = [game.user, player];
  caster.testUserPermission = (u) => u === player;
  caster.isOwner = true;
  uuids.set(caster.uuid, caster);
  const goblin = creature("Goblin", 1, 1);                   // occupies 100..200 × 100..200
  const wall = region([{ type: "line", x: 0, y: 150, length: 400, width: 2, rotation: 0 }]);
  // The player's client isn't reachable here (no socket), so the GM is asked.
  let asked = null;
  prompts.choice = async (title, content, buttons) => { asked = { title, content, buttons }; return buttons[1].action; };
  await buildWallsGM({ identifier: "wall-of-force", regions: [wall.uuid], caster: caster.uuid, spell: "Wall of Force" });
  assert.match(asked.content, /cuts through <strong>Goblin\d*<\/strong>/);
  assert.deepEqual(asked.buttons.map(b => b.label), ["Push to the south side", "Push to the north side"]);
  assert.deepEqual([goblin.moved.x, goblin.moved.y], [100, 0]);
  assert.deepEqual(goblin.moved.options, { [MODULE_ID]: { forced: true } });   // no opportunity attacks
});

test("segment / rectangle crossing, and push options clear of every wall", () => {
  assert.equal(segmentHitsRect([0, 150, 400, 150], { x: 100, y: 100, w: 100, h: 100 }), true);
  assert.equal(segmentHitsRect([0, 50, 400, 50], { x: 100, y: 100, w: 100, h: 100 }), false);
  const goblin = creature("Goblin", 1, 1);
  const segments = [[0, 150, 400, 150]];
  const options = pushOptions(goblin, segments[0], segments);
  assert.deepEqual(options.map(o => [o.side, o.x, o.y]), [["a", 100, 200], ["b", 100, 0]]);
});

test("the walls go with their area; the area is kept while the spell lasts", async () => {
  const area = region([]);
  area.flags[MODULE_ID] = { [WALL_SPELL_FLAG]: { walls: ["w9"], concentration: "Actor.c.ActiveEffect.conc" } };
  scene.walls.push({ id: "w9", getFlag: () => area.uuid }, { id: "stray", getFlag: () => area.uuid });
  await onRegionDeletedWalls(area);
  assert.deepEqual(scene.deleted, ["w9", "stray"]);
  uuids.set("Actor.c.ActiveEffect.conc", {});
  assert.equal(onPreDeleteRegion(area, {}), false);
});

test("only wall spells, only with the setting; the caster's client asks the GM", async () => {
  const fireball = region([]);
  game.user.isGM = false;
  const emitted = [];
  const shared = await import("../scripts/native/shared.mjs");
  shared.setSocket({ emit: (name, payload) => emitted.push([name, payload]) });
  try {
    await recordWallSpell({ item: { name: "Fireball", system: { identifier: "fireball" } } }, {}, { templates: [fireball] });
    await recordWallSpell({ item: { name: "Wall of Force", system: { identifier: "wall-of-force" } }, actor: { uuid: "Actor.w" } }, {},
      { templates: [fireball], effects: [{ uuid: "Actor.w.ActiveEffect.c", system: { type: "concentrating" } }] });
    assert.deepEqual(emitted.map(e => e[0]), ["buildWalls"]);
    assert.equal(emitted[0][1].concentration, "Actor.w.ActiveEffect.c");
    settings.wallSpells = false;
    await recordWallSpell({ item: { name: "Wall of Force", system: { identifier: "wall-of-force" } } }, {}, { templates: [fireball] });
    assert.equal(emitted.length, 1);
  } finally { shared.setSocket(null); }
});

test("lingering triggers: 2024 Wall of Thorns runs its Traversal Save, not the casting save", () => {
  const activities = new Map([
    ["c", { type: "save", name: "Create Wall", activation: { type: "action" } }],
    ["t", { type: "save", name: "Traversal Save", activation: { type: "" } }]
  ]);
  assert.equal(triggerActivity({ system: { activities } }).name, "Traversal Save");
  const single = new Map([["s", { type: "save", name: "Cast and Save", activation: { type: "" } }]]);
  assert.equal(triggerActivity({ system: { activities: single } }).name, "Cast and Save");
});

// ── Total cover, and areas going with their concentration ──
import { blockedTargets, onPreUseActivityWalls, onPreRollAttackWalls, effectBarriers, behindBarrier, areaOrigin, BLOCKS_EFFECT_FLAG } from "../scripts/native/walls.mjs";
import { tokensInActivityArea } from "../scripts/native/targeting.mjs";
import { onConcentrationEnded, rememberAreas, CONCENTRATION_AREA_FLAG } from "../scripts/native/areas.mjs";
import { LINGERING_FLAG } from "../scripts/native/lingering.mjs";

function barrierWall(c, blocks = true, area = "Scene.s.Region.wf") {
  const flags = { [MODULE_ID]: { [WALL_OF_FLAG]: area, ...(blocks === "unflagged" ? {} : { [BLOCKS_EFFECT_FLAG]: blocks }) } };
  const wall = { id: `bw${++seq}`, c, flags, getFlag: (m, k) => flags[m]?.[k] };
  scene.walls.push(wall);
  return wall;
}
function placed(name, col, row, disposition = -1) {
  const doc = creature(name, col, row);
  doc.disposition = disposition;
  doc.testInsideRegion = (r) => r.inside?.includes(doc.id);
  return doc;
}

test("total cover: no attacking or casting at a creature behind a solid wall; the cage and Prismatic Wall don't count", () => {
  const me = placed("Me", 0, 0, 1);
  const them = placed("Them", 4, 0);
  barrierWall([250, -500, 250, 500]);                         // between columns 2 and 3
  canvas.tokens.setTargets([them.id]);
  const activity = { type: "attack", getUsageToken: () => me, target: {}, range: { units: "ft" } };
  assert.deepEqual(blockedTargets(activity).map(t => t.name), ["Them"]);
  assert.equal(onPreUseActivityWalls(activity), false);
  assert.match(env.notes.at(-1), /Them is behind a solid wall \(total cover\)/);
  assert.equal(onPreRollAttackWalls({ subject: activity }), false);
  // An area spell isn't stopped at use (its effect is checked where it lands), nor a self spell.
  assert.equal(onPreUseActivityWalls({ ...activity, target: { template: { type: "sphere" } } }), undefined);
  assert.equal(onPreUseActivityWalls({ ...activity, range: { units: "self" } }), undefined);
  // Not a solid barrier.
  scene.walls.length = 0;
  barrierWall([250, -500, 250, 500], false);
  assert.deepEqual(blockedTargets(activity), []);
  // The setting off.
  scene.walls.length = 0;
  barrierWall([250, -500, 250, 500]);
  settings.wallSpells = false;
  assert.deepEqual(blockedTargets(activity), []);
});

test("older walls without the flag go by their area's spell", () => {
  const area = { id: "wf", getFlag: (m, k) => k === WALL_SPELL_FLAG ? { identifier: "wall-of-force" } : undefined };
  const cage = { id: "fc", getFlag: (m, k) => k === WALL_SPELL_FLAG ? { identifier: "forcecage", activityName: "Create Cage" } : undefined };
  scene.regions = Object.assign([area, cage], { get(id) { return this.find(r => r.id === id); } });
  barrierWall([0, 0, 0, 100], "unflagged", "Scene.s.Region.wf");
  barrierWall([5, 0, 5, 100], "unflagged", "Scene.s.Region.fc");
  assert.deepEqual(effectBarriers(scene), [[0, 0, 0, 100]]);
});

test("an area's effect stops at a solid wall: creatures cut off from its origin are left out", () => {
  const caster = placed("Caster", 0, 5, 1);
  const near = placed("Near", 1, 1), far = placed("Far", 5, 1);
  const fireball = { uuid: "Scene.s.Region.fb", parent: scene, shapes: [{ type: "circle", x: 150, y: 150, radius: 600 }], inside: [near.id, far.id] };
  assert.deepEqual(areaOrigin(fireball), { x: 150, y: 150 });
  barrierWall([350, -500, 350, 900]);                          // between Near and Far
  const hit = tokensInActivityArea({ target: { affects: { type: "" } }, range: { units: "ft" }, getUsageToken: () => caster }, [fireball]);
  assert.deepEqual(hit.map(t => t.name), ["Near"]);
  assert.equal(behindBarrier(scene, { x: 150, y: 150 }, far), true);
});

test("ending concentration removes its areas: always lingering and wall spells', others with the setting", async () => {
  const deleted = [];
  const mk = (id, flags) => ({ id, name: id, flags: { [MODULE_ID]: flags }, getFlag: (m, k) => m === MODULE_ID ? flags[k] : undefined,
    async delete(options) { deleted.push([id, options]); } });
  const conc = { uuid: "Actor.c.ActiveEffect.conc", system: { type: "concentrating" } };
  const wall = mk("wall", { [WALL_SPELL_FLAG]: { concentration: conc.uuid } });
  const ling = mk("ling", { [LINGERING_FLAG]: { concentration: conc.uuid } });
  const fog = mk("fog", { [CONCENTRATION_AREA_FLAG]: conc.uuid });
  const other = mk("other", { [CONCENTRATION_AREA_FLAG]: "Actor.c.ActiveEffect.other" });
  game.scenes = [{ regions: [wall, ling, fog, other] }];
  try {
    settings.clearInstantAreas = false;
    await onConcentrationEnded(conc);
    assert.deepEqual(deleted.map(d => d[0]), ["wall", "ling"]);
    assert.deepEqual(deleted[0][1], { [MODULE_ID]: { allow: true } });
    deleted.length = 0;
    settings.clearInstantAreas = true;
    await onConcentrationEnded(conc);
    assert.deepEqual(deleted.map(d => d[0]), ["wall", "ling", "fog"]);
    deleted.length = 0;
    await onConcentrationEnded({ uuid: conc.uuid, system: { type: "base" }, statuses: new Set() });   // not concentration
    assert.deepEqual(deleted, []);
  } finally { delete game.scenes; }

  // Casting ties each area to the concentration.
  const flags = {};
  const area = { documentName: "Region", isOwner: true, uuid: "R.1", async setFlag(m, k, v) { flags[k] = v; } };
  rememberAreas({ item: {} }, { templates: [area], message: { id: "u" }, effects: [conc] });
  await env.flush();
  assert.equal(flags[CONCENTRATION_AREA_FLAG], conc.uuid);
});
