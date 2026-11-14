// Counterspell, and Silvery Barbs on critical hits and on successful saves and checks.
import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { reactionOptions, grantSilveryAdvantage } from "../scripts/native/reactions.mjs";
import { attackReasons, consumeRollMarks, silveryMark } from "../scripts/native/advantage.mjs";
import { onPreRollSave, onPreRollCheck } from "../scripts/native/save-rules.mjs";
import { MASTERY_FLAG } from "../scripts/native/mastery.mjs";
import { onD20TestRolled, D20_TESTS } from "../scripts/native/checks.mjs";
import { counterable, canCastCounterspell, counterspellers, checkCounterspell, installCounterspell } from "../scripts/native/counterspell.mjs";

const { settings, makeToken, prompts, uuids, rollResults, dialogs } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

canvas.grid = {
  isGridless: false, distance: 5, size: 100, units: "ft",
  getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
  measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5 })
};
CONFIG.Canvas = { polygonBackends: { sight: { testCollision: () => false }, move: { testCollision: () => false } } };

beforeEach(() => {
  env.reset();
  game.users = [game.user];
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => game.user } } });
  game.combat = null;
  settings.reactionPrompts = "all";
});

let seq = 0;
/** A creature at (col, row) with these items and spell slots. */
function creature(name, col, row = 0, { disposition = -1, items = [], spells = {}, type = "npc" } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const d = token.document;
  Object.assign(d, { x: col * 100, y: row * 100, elevation: 0, width: 1, height: 1, isOwner: true,
    getOccupiedGridSpaceOffsets: () => [{ i: row, j: col }] });
  const actor = d.actor;
  Object.assign(actor, { name, type, isOwner: true, statuses: new Set(), items, effects: [], flags: {},
    system: { attributes: { prof: 2, spellcasting: "int" }, spells }, getActiveTokens: () => [d], testUserPermission: () => false,
    async toggleStatusEffect() {} });
  uuids.set(actor.uuid, actor);
  return { token, doc: d, actor };
}
/** A spell item: its identifier, rules, level and components; its first activity records its uses. */
function spell(identifier, { rules = "2024", level = 1, components = ["vocal", "somatic"], activity = "utility", onUse } = {}) {
  const used = [];
  const item = { id: `${identifier}${++seq}`, name: identifier, type: "spell", used,
    system: { identifier, level, source: { rules }, properties: new Set(components), activities: null } };
  const act = { type: activity, item, activation: { type: "reaction" }, effects: [],
    async use(...args) { used.push(args); return onUse ? onUse() : { message: { id: `use${++seq}`, system: {} } }; } };
  item.system.activities = new Map([["a", act]]);
  return item;
}

// ── Silvery Barbs ──
test("Silvery Barbs is offered against a critical hit (the reroll decides); Cutting Words still isn't", () => {
  const bard = { items: [spell("silvery-barbs"), { type: "feat", system: { identifier: "cutting-words" } }], system: { spells: { spell1: { value: 1 } } } };
  const options = reactionOptions(bard, { total: 25, ac: 15, critical: true }, "hit", { ally: true });
  assert.ok(options.includes("silvery-barbs"));
  assert.ok(!options.includes("cutting-words"));
});

test("Silvery Barbs on a successful save: the roller's enemies within 60 ft are asked; the lower roll can make it fail", async () => {
  const calls = [];
  const real = LDA.promptLuckOnCheckFail;
  LDA.promptLuckOnCheckFail = async (...args) => { calls.push(args); return { passed: false }; };
  try {
    settings.rollBoosts = true;   // Bardic Inspiration on the roller: something to offer after a failure
    const pip = creature("Pip", 0, 0, { disposition: 1, type: "character" });
    pip.actor.effects = [{ getFlag: (s, k) => s === MODULE_ID && k === "boost" ? { kind: "bardic", die: "d6" } : undefined, disabled: false }];
    const barbs = spell("silvery-barbs");
    const witch = creature("Witch", 3, 0, { items: [barbs], spells: { spell1: { value: 1 } } });   // 15 ft away, an enemy
    const friend = spell("silvery-barbs");
    creature("Friend", 1, 0, { disposition: 1, items: [friend], spells: { spell1: { value: 1 } } });  // Pip's ally: not asked
    let asked = null;
    prompts.choice = async (title, content, buttons) => { asked = content; return buttons.find(b => b.action === "silvery-barbs") ? "silvery-barbs" : "none"; };
    const roll = { total: 16, d20: 14, options: { target: 15 }, parent: { id: `m${++seq}`, speaker: { token: pip.doc.id }, getFlag: () => null } };
    const nobody = () => "none";                   // Silvery Barbs' advantage: given to no one here (its own test below)
    dialogs.push(nobody, nobody);
    rollResults.push(9);
    await onD20TestRolled([roll], { subject: pip.actor }, D20_TESTS["dnd5e.rollSavingThrow"]);
    assert.match(asked, /Pip.*succeeded on a saving throw \(16 vs DC 15\)/);
    assert.equal(barbs.used.length, 1);
    assert.equal(friend.used.length, 0);
    assert.equal(calls.length, 1);                 // now a failure: the roller's own prompts follow
    assert.equal(calls[0][1], 9);

    // A higher reroll: the original success stands, nothing else is offered.
    rollResults.push(19);
    await onD20TestRolled([{ ...roll, parent: { ...roll.parent, id: `m${++seq}` } }], { subject: pip.actor }, D20_TESTS["dnd5e.rollSavingThrow"]);
    assert.equal(calls.length, 1);

    // Out of range (65 ft): not asked.
    witch.doc.x = 13 * 100; witch.doc.getOccupiedGridSpaceOffsets = () => [{ i: 0, j: 13 }];
    asked = null;
    await onD20TestRolled([{ ...roll, parent: { ...roll.parent, id: `m${++seq}` } }], { subject: pip.actor }, D20_TESTS["dnd5e.rollSavingThrow"]);
    assert.equal(asked, null);
  } finally { LDA.promptLuckOnCheckFail = real; settings.rollBoosts = false; }
});

// ── Counterspell ──
test("what can be counterspelled: a spell with components, not one cast with Subtle Spell or from a reaction prompt", () => {
  const fireball = { item: spell("fireball", { level: 3, components: ["vocal", "somatic", "material"] }) };
  assert.equal(counterable(fireball, {}), true);
  assert.equal(counterable(fireball, { ldaMetamagic: { choice: "subtle" } }), false);
  assert.equal(counterable(fireball, { [MODULE_ID]: { noCounter: true } }), false);
  assert.equal(counterable({ item: spell("silent", { components: [] }) }, {}), false);
  assert.equal(counterable({ item: { type: "weapon", system: {} } }, {}), false);
});

test("who can cast it: a 3rd-level slot or higher (or pact), or innate with uses", () => {
  const cs = spell("counterspell", { level: 3 });
  assert.equal(canCastCounterspell({ items: [cs], system: { spells: { spell2: { value: 3 }, spell3: { value: 0 } } } }, cs), false);
  assert.equal(canCastCounterspell({ items: [cs], system: { spells: { spell4: { value: 1 } } } }, cs), true);
  assert.equal(canCastCounterspell({ items: [cs], system: { spells: { pact: { value: 1, level: 3 } } } }, cs), true);
  const innate = spell("counterspell", { level: 3 }); innate.system.method = "innate"; innate.system.uses = { max: 1, value: 1 };
  assert.equal(canCastCounterspell({ items: [innate], system: { spells: {} } }, innate), true);
});

test("asked of the caster's enemies within 60 ft who can see it and have a reaction", () => {
  const caster = creature("Mage", 0, 0, { disposition: 1 });
  const near = creature("Near", 4, 0, { items: [spell("counterspell", { level: 3 })], spells: { spell3: { value: 1 } } });
  creature("Far", 14, 0, { items: [spell("counterspell", { level: 3 })], spells: { spell3: { value: 1 } } });     // 70 ft
  creature("Ally", 1, 0, { disposition: 1, items: [spell("counterspell", { level: 3 })], spells: { spell3: { value: 1 } } });
  creature("NoSlot", 2, 0, { items: [spell("counterspell", { level: 3 })], spells: { spell3: { value: 0 } } });
  assert.deepEqual(counterspellers(caster.doc).map(t => t.name), ["Near"]);
  assert.deepEqual(counterspellers(caster.doc, "players"), []);               // an NPC isn't asked under "player characters"
  near.actor.statuses.add("reacted");                                          // its reaction already used
  assert.deepEqual(counterspellers(caster.doc), []);
});

test("2014: a spell of its slot's level or lower is countered, its slot still spent; nobody asked: the cast goes on", async () => {
  const caster = creature("Mage", 0, 0, { disposition: 1 });
  const cs = spell("counterspell", { rules: "2014", level: 3, activity: "check" });
  creature("Foe", 4, 0, { items: [cs], spells: { spell3: { value: 1 } } });
  let content = null;
  prompts.choice = async (_t, c) => { content = c; return "counter"; };
  const fireball = spell("fireball", { level: 3 });
  const activity = [...fireball.system.activities.values()][0];
  Object.assign(activity, { actor: caster.actor, getUsageToken: () => caster.doc });

  const verdict = await checkCounterspell(activity, { scaling: 0 });
  assert.match(content, /Mage.*is casting.*fireball.*\(level 3\)/s);
  assert.equal(cs.used.length, 1);
  assert.equal(cs.used[0][0][MODULE_ID], undefined);                  // a Counterspell can itself be countered
  assert.equal(verdict.countered, true);
  assert.equal(verdict.rules, "2014");

  // The wrapped consume: countered (2014) — the original still runs (the slot), the use stops.
  class Activity { async consume() { this.consumed = (this.consumed ?? 0) + 1; return { spent: true }; } }
  installCounterspell({ spell: { documentClass: Activity } });
  installCounterspell({ spell: { documentClass: Activity } });            // once only
  const cast = Object.assign(new Activity(), activity);
  cs.used.length = 0;
  assert.equal(await cast.consume({ scaling: 0 }, {}), false);
  assert.equal(cast.consumed, 1);

  // No one able to: the original consume, untouched.
  const quiet = Object.assign(new Activity(), activity, { getUsageToken: () => creature("Alone", 30, 30, { disposition: 1 }).doc });
  assert.deepEqual(await quiet.consume({}, {}), { spent: true });
});

// ── Silvery Barbs' advantage ──
test("Silvery Barbs' second half: its caster picks a creature it can see within 60 ft (itself ticked) for Advantage", async () => {
  const witch = creature("Witch", 0, 0);
  const orc = creature("Orc", 2, 0), far = creature("Far", 20, 0);
  const created = [];
  orc.actor.createEmbeddedDocuments = async (_t, data) => { created.push(...data); return data; };
  let offered = null;
  dialogs.push((ui) => { offered = ui.checkboxes.map(c => [c.value, c.checked]); ui.check(witch.token.id, false); ui.check(orc.token.id); return "ok"; });
  assert.equal(await grantSilveryAdvantage(witch.actor, witch.doc), "Orc");
  assert.deepEqual(offered, [[witch.token.id, true], [orc.token.id, false]]);         // not the one 100 ft away
  assert.equal(created[0].flags[MODULE_ID][MASTERY_FLAG].kind, "silvery-barbs");
  assert.deepEqual(created[0].duration, { value: 1, units: "minutes" });
  assert.equal(far.actor.effects.length, 0);
});

test("the advantage: the creature's next attack, save or check — whichever comes first — and then it's used up", async () => {
  const mark = { uuid: "E.barbs", disabled: false, isOwner: true, deleted: 0, async delete() { this.deleted++; },
    getFlag: (m, k) => m === MODULE_ID && k === MASTERY_FLAG ? { kind: "silvery-barbs" } : undefined };
  uuids.set("E.barbs", mark);
  const pip = creature("Pip", 0, 0, { disposition: 1 });
  pip.actor.effects = [mark];
  pip.actor.system.abilities = { dex: { mod: 2 } };
  assert.equal(silveryMark(pip.actor), mark);

  // An attack (the attack rules on).
  settings.attackAdvantage = true;
  const orc = creature("Orc", 1, 0);
  canvas.tokens.setTargets([orc.token.id]);
  const reasons = attackReasons({ type: "attack", actor: pip.actor, item: { type: "weapon", system: { range: {}, properties: new Set(), type: {} } },
    attack: { type: { value: "melee", classification: "weapon" } }, getUsageToken: () => pip.doc });
  assert.ok(reasons.advantage.includes("Silvery Barbs"));
  assert.ok(reasons.consume.includes("E.barbs"));

  // A save, with Saving Throw Rules off: only Silvery Barbs is read.
  settings.saveRules = false;
  const message = { data: { flags: {} } };
  const config = { subject: pip.actor, ability: "dex", rolls: [{ options: {} }] };
  onPreRollSave(config, { options: {} }, message);
  assert.equal(config.advantage, true);
  assert.deepEqual(message.data.flags[MODULE_ID].saveReasons.advantage, ["Silvery Barbs"]);

  // A check (not initiative).
  const checkMsg = { data: { flags: {} } };
  const check = { subject: pip.actor, rolls: [{ options: {} }] };
  onPreRollCheck(check, null, checkMsg);
  assert.equal(check.advantage, true);
  const init = { subject: pip.actor, hookNames: ["initiativeDialog", "abilityCheck"], rolls: [{ options: {} }] };
  onPreRollCheck(init, null, { data: { flags: {} } });
  assert.equal(init.advantage, undefined);

  // Rolled: used up (once, however many hooks fire).
  const rolled = { getFlag: (m, k) => m === MODULE_ID && k === "saveReasons" ? checkMsg.data.flags[MODULE_ID].saveReasons : undefined };
  await Promise.all([consumeRollMarks(rolled), consumeRollMarks(rolled)]);
  assert.equal(mark.deleted, 1);
});

test("a Counterspell can be countered, but nobody already countering is asked again: the chain ends", async () => {
  // Activities whose use goes through consume, as dnd5e's do (wrapped by installCounterspell).
  class Act {
    constructor(item, props = {}) { Object.assign(this, { item, activation: { type: "reaction" }, effects: [], ...props }); }
    async consume() { return {}; }
    async use(usage = {}) { this.item.used.push([usage]); return (await this.consume(usage, {})) === false ? null : { message: { id: `use${++seq}`, system: {} } }; }
  }
  installCounterspell({ chainTest: { documentClass: Act } });
  const csItem = () => {
    const item = { id: `cs${++seq}`, name: "counterspell", type: "spell", used: [], system: { identifier: "counterspell", level: 3, source: { rules: "2014" },
      properties: new Set(["somatic"]), activities: null } };
    item.system.activities = new Map([["a", new Act(item, { type: "check" })]]);
    return item;
  };
  const caster = creature("Mage", 0, 0, { disposition: 1, items: [] });
  const foeCS = csItem(), allyCS = csItem();
  const foe = creature("Foe", 4, 0, { items: [foeCS], spells: { spell3: { value: 1 } } });
  const ally = creature("Ally", 1, 0, { disposition: 1, items: [allyCS], spells: { spell3: { value: 1 } } });
  for (const [it, who] of [[foeCS, foe], [allyCS, ally]]) for (const a of it.system.activities.values()) { a.actor = who.actor; a.getUsageToken = () => who.doc; }
  const asked = [];
  prompts.choice = async (_t, content) => { asked.push(/Use (\w+)'s reaction/.exec(content)?.[1]); return "counter"; };
  const fireBolt = spell("fire-bolt", { level: 0 });
  const bolt = Object.assign(new Act(fireBolt), { actor: caster.actor, getUsageToken: () => caster.doc });

  const result = await bolt.consume({}, {});
  assert.deepEqual(asked, ["Foe", "Ally"]);            // the foe counters; the ally counters the foe's Counterspell; then it's over
  assert.notEqual(result, false);                        // the foe's Counterspell was countered: Fire Bolt goes ahead
  assert.equal(foeCS.used.length, 1);
  assert.equal(allyCS.used.length, 1);
});
