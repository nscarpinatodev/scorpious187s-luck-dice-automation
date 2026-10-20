import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  rulesOf, triggerActivity, recordLingeringArea, triggerArea, onTurnChange, onTokenMoved, onRegionChanged,
  lingeringRunner, LINGERING_FLAG
} from "../scripts/native/lingering.mjs";

const { settings, uuids, scene, makeToken } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";
const runs = [];
lingeringRunner.run = async (activity, tokenDoc, usage) => { runs.push({ activity: activity.id, token: tokenDoc.id, usage: usage?.id ?? null }); };

let seq = 0;
beforeEach(() => {
  env.reset();
  runs.length = 0;
  settings.lingeringAreas = true;
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => game.user } } });
  game.combat = null;
  scene.regions = [];
});

/** A lingering spell on the caster, its trigger activity, and the caster's token. */
function spell({ identifier = "spirit-guardians", rules = "2024", range = "self", choice = false, special = false } = {}) {
  const caster = makeToken(`caster${++seq}`, "Cleric", { disposition: 1 });
  const activities = new Map();
  const item = {
    uuid: `Actor.${caster.id}.Item.sg`, name: identifier, flags: {},
    system: { identifier, source: { rules }, activities, target: { affects: { choice } } },
    clone(update) { return { ...item, flags: { dnd5e: { scaling: update["flags.dnd5e.scaling"] } }, system: item.system }; }
  };
  const make = (id, type, activation) => {
    const a = { id, type, item, activation: { type: activation }, range: { units: range }, target: { affects: { type: "creature" } },
      getUsageToken: () => caster.document };
    activities.set(id, a);
    return a;
  };
  make("cast", special ? "utility" : "save", "action");
  if (special) make("trigger", "save", "special");
  uuids.set(item.uuid, item);
  return { item, caster, activities };
}
function region(inside = [], flags = {}) {
  const r = { id: `region${++seq}`, uuid: `Scene.s.Region.${seq}`, parent: scene, inside, flags: { ...flags }, documentName: "Region",
    getFlag: (m, k) => r.flags[m]?.[k], async setFlag(m, k, v) { (r.flags[m] ??= {})[k] = v; } };
  scene.regions.push(r);
  return r;
}
function tagged(s, inside, extra = {}) {
  const trigger = triggerActivity(s.item);
  return region(inside, { [MODULE_ID]: { [LINGERING_FLAG]: { item: s.item.uuid, activity: trigger.id, rules: s.item.system.source.rules, scaling: 0, usage: null, concentration: null, ...extra } } });
}
const combat = (round, turn, tokenId) => ({ round, turn, tokenId });

test("rules from the item's source; the trigger activity is the 'special' save in 2014 data", () => {
  assert.equal(rulesOf({ system: { source: { rules: "2014" } } }), "2014");
  assert.equal(rulesOf({ system: { source: { rules: "2024" } } }), "2024");
  const legacy = spell({ special: true });
  assert.equal(triggerActivity(legacy.item).id, "trigger");
  assert.equal(triggerActivity(spell().item).id, "cast");
});

test("casting tags the placed area with the spell", async () => {
  const s = spell({ rules: "2014", special: true });
  const r = region();
  await recordLingeringArea(s.activities.get("cast"), { scaling: 2 }, { templates: [r], message: { id: "use1" }, effects: [{ uuid: "Actor.c.ActiveEffect.conc", system: { type: "concentrating" } }] });
  assert.deepEqual(r.getFlag(MODULE_ID, LINGERING_FLAG), {
    item: s.item.uuid, activity: "trigger", actor: null, scaling: 2, rules: "2014", usage: "use1", concentration: "Actor.c.ActiveEffect.conc"
  });
  const other = region();
  await recordLingeringArea({ item: { system: { identifier: "fireball" } } }, {}, { templates: [other] });
  assert.equal(other.getFlag(MODULE_ID, LINGERING_FLAG), undefined);
});

test("2014: start of turn and the first entry on a turn; not end of turn", async () => {
  const s = spell({ rules: "2014", special: true });
  const goblin = makeToken("g", "Goblin").document;
  const r = tagged(s, ["g"]);
  assert.equal(await triggerArea(r, goblin, "end", "c:1:0"), false);
  assert.equal(await triggerArea(r, goblin, "start", "c:1:0"), true);
  assert.equal(await triggerArea(r, goblin, "enter", "c:1:1"), true);
  assert.equal(await triggerArea(r, goblin, "enter", "c:1:1"), false);     // not twice on a turn
  assert.equal(await triggerArea(r, goblin, "enter", "c:1:2"), true);
  assert.deepEqual(runs.map(x => x.activity), ["trigger", "trigger", "trigger"]);
});

test("2024: entering or ending a turn there, once per turn; not start of turn", async () => {
  const s = spell({ rules: "2024" });
  const goblin = makeToken("g", "Goblin").document;
  const r = tagged(s, ["g"]);
  assert.equal(await triggerArea(r, goblin, "start", "c:1:0"), false);
  assert.equal(await triggerArea(r, goblin, "enter", "c:1:0"), true);
  assert.equal(await triggerArea(r, goblin, "end", "c:1:0"), false);       // already this turn
  assert.equal(await triggerArea(r, goblin, "end", "c:1:1"), true);
  assert.equal(await triggerArea(r, goblin, "enter"), true);               // out of combat: no limit
  assert.equal(await triggerArea(r, goblin, "enter"), true);
});

test("the caster isn't hit by their own emanation; allies aren't where the caster chooses", async () => {
  const s = spell({ choice: true });
  makeToken("foe", "Foe", { disposition: -1 });
  makeToken("pal", "Pal", { disposition: 1 });
  const r = tagged(s, [s.caster.id, "foe", "pal"]);
  assert.equal(await triggerArea(r, s.caster.document, "enter"), false);
  assert.equal(await triggerArea(r, scene.tokens.find(t => t.id === "pal"), "enter"), false);
  assert.equal(await triggerArea(r, scene.tokens.find(t => t.id === "foe"), "enter"), true);
});

test("an area whose concentration ended doesn't trigger", async () => {
  const s = spell();
  const goblin = makeToken("g", "Goblin").document;
  const r = tagged(s, ["g"], { concentration: "Actor.c.ActiveEffect.gone" });
  assert.equal(await triggerArea(r, goblin, "enter"), false);
  uuids.set("Actor.c.ActiveEffect.gone", {});
  assert.equal(await triggerArea(r, goblin, "enter"), true);
});

test("turn changes: the prior creature's end of turn, the next one's start", async () => {
  const modern = spell({ rules: "2024" }), legacy = spell({ rules: "2014", special: true });
  makeToken("a", "A"); makeToken("b", "B");
  tagged(modern, ["a", "b"]); tagged(legacy, ["a", "b"]);
  const fight = { id: "c", started: true, scene, round: 1, turn: 1 };
  await onTurnChange(fight, combat(1, 0, "a"), combat(1, 1, "b"));
  assert.deepEqual(runs.map(x => [x.activity, x.token]), [["cast", "a"], ["trigger", "b"]]);
  // Not the trigger client: nothing.
  runs.length = 0;
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => ({ id: "otherGM" }) } } });
  await onTurnChange(fight, combat(1, 1, "b"), combat(2, 0, "a"));
  assert.equal(runs.length, 0);
});

test("movement: entering along the path; 2024 areas moving onto others; tagging isn't entering", async () => {
  const modern = spell({ rules: "2024" }), legacy = spell({ rules: "2014", special: true });
  const mover = makeToken("m", "Mover").document;
  makeToken("o", "Other");
  const r24 = tagged(modern, []), r14 = tagged(legacy, []);
  await onRegionChanged(r24, { flags: { [MODULE_ID]: {} } });              // tagged: note who's inside
  await onRegionChanged(r14, { flags: { [MODULE_ID]: {} } });

  // The mover passes through both areas (ends outside).
  mover.segmentizeRegionMovementPath = () => [{ type: 1 }, { type: -1 }];
  await onTokenMoved(mover, { origin: { x: 0, y: 0 }, passed: { waypoints: [{ x: 1, y: 1 }] } });
  assert.deepEqual(runs.map(x => x.token).sort(), ["m", "m"]);

  // The 2024 area now covers "o" (moved with its caster); the 2014 one too, which doesn't count.
  runs.length = 0;
  r24.inside.push("o"); r14.inside.push("o");
  mover.segmentizeRegionMovementPath = () => [];
  await onTokenMoved(mover, { origin: { x: 1, y: 1 }, passed: { waypoints: [] } });
  assert.deepEqual(runs.map(x => [x.activity, x.token]), [["cast", "o"]]);
});

test("the setting off: nothing is tagged or triggered", async () => {
  settings.lingeringAreas = false;
  const s = spell();
  const r = region();
  await recordLingeringArea(s.activities.get("cast"), {}, { templates: [r] });
  assert.equal(r.getFlag(MODULE_ID, LINGERING_FLAG), undefined);
  makeToken("a", "A");
  tagged(s, ["a"]);
  await onTurnChange({ id: "c", started: true, scene }, combat(1, 0, "a"), combat(1, 1, "a"));
  assert.equal(runs.length, 0);
});
