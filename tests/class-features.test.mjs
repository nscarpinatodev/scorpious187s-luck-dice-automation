// Grappler, Staggered's save, Countercharm, Potent Cantrip, Indomitable Might and Dark One's Own Luck.
import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { attackReasons, consumeRollMarks, STAGGER_USED } from "../scripts/native/advantage.mjs";
import { saveReasons, SAVE_AGAINST_FLAG } from "../scripts/native/save-rules.mjs";
import { countercharmFor, onCountercharmUsed, PERFORMANCE_FLAG } from "../scripts/native/bard.mjs";
import { onD20TestRolled, D20_TESTS } from "../scripts/native/checks.mjs";
import { applySaveDamage } from "../scripts/native/saves.mjs";
import { potentCantripSave, potentCantripMiss } from "../scripts/native/wizard.mjs";
import { indomitableMight } from "../scripts/native/barbarian.mjs";
import { boostsFor } from "../scripts/native/boosts.mjs";

const { settings, makeToken, prompts, uuids, rollResults, messages, damageRoll } = env;
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
  game.modules.delete("automated-conditions-5e");
  game.combat = null;
});

let seq = 0;
function creature(name, col, row = 0, { disposition = -1, items = [], statuses = [], type = "npc", str = 10 } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const d = token.document;
  Object.assign(d, { x: col * 100, y: row * 100, elevation: 0, width: 1, height: 1, isOwner: true,
    getOccupiedGridSpaceOffsets: () => [{ i: row, j: col }] });
  const actor = d.actor;
  const effects = [];
  Object.assign(actor, { name, type, documentName: "Actor", isOwner: true, statuses: new Set(statuses), items, flags: {},
    effects: Object.assign(effects, { get: (id) => effects.find(e => e.id === id) }),
    system: { attributes: { prof: 2 }, abilities: { str: { value: str, mod: Math.floor((str - 10) / 2) } } },
    getActiveTokens: () => [d], testUserPermission: () => false, created: [],
    async createEmbeddedDocuments(_t, data) { actor.created.push(...data); return data; },
    async deleteEmbeddedDocuments() {} });
  uuids.set(actor.uuid, actor);
  return { token, doc: d, actor };
}
const feat = (identifier, { rules = "2024", uses = null } = {}) => ({ name: identifier, type: "feat",
  system: { identifier, source: { rules }, ...(uses ? { uses: { max: uses, spent: 0 } } : {}) },
  async update(u) { if ("system.uses.spent" in u) this.system.uses.spent = u["system.uses.spent"]; } });
const swing = (attacker) => ({ type: "attack", actor: attacker.actor, item: { type: "weapon", system: { range: {}, properties: new Set(), type: {} } },
  attack: { type: { value: "melee", classification: "weapon" } }, getUsageToken: () => attacker.doc });

// ── Grappler ──
test("Grappler: advantage against a creature it's grappling (its effect's source; within 5 ft when none is recorded)", () => {
  settings.attackAdvantage = true;
  const wrestler = creature("Wrestler", 0, 0, { disposition: 1, items: [feat("grappler")] });
  const other = creature("Other", 0, 1, { disposition: 1 });
  const orc = creature("Orc", 1, 0, { statuses: ["grappled"] });
  canvas.tokens.setTargets([orc.token.id]);
  const held = (by) => ({ disabled: false, statuses: new Set(["grappled"]), origin: by?.actor.uuid ?? null });
  orc.actor.effects.push(held(wrestler));
  assert.ok(attackReasons(swing(wrestler)).advantage.includes("Grappler"));
  orc.actor.effects.splice(0, 1, held(other));                      // someone else holds it
  assert.ok(!attackReasons(swing(wrestler)).advantage.includes("Grappler"));
  orc.actor.effects.splice(0, 1, held(null));                       // no source: within 5 ft counts
  assert.ok(attackReasons(swing(wrestler)).advantage.includes("Grappler"));
  orc.doc.x = 300; orc.doc.getOccupiedGridSpaceOffsets = () => [{ i: 0, j: 3 }];
  assert.ok(!attackReasons(swing(wrestler)).advantage.includes("Grappler"));
});

// ── Staggered ──
test("Staggered: disadvantage on the next save, then spent — the effect stays (no opportunity attacks)", async () => {
  const brute = { name: "Brutal Strike", documentName: "Item", uuid: "Actor.b.Item.brutal", system: { identifier: "brutal-strike" } };
  uuids.set(brute.uuid, brute);
  const orc = creature("Orc", 1, 0);
  const flags = {};
  const staggered = { uuid: "E.stagger", name: "Staggered", disabled: false, isOwner: true, origin: brute.uuid, deleted: false,
    getFlag: (m, k) => flags[k], async setFlag(m, k, v) { flags[k] = v; }, async delete() { this.deleted = true; } };
  uuids.set("E.stagger", staggered);
  orc.actor.effects.push(staggered);
  const reasons = saveReasons(orc.actor, "con", {}, { tokenDoc: orc.doc });
  assert.deepEqual(reasons.disadvantage, ["Staggered"]);
  assert.deepEqual(reasons.consume, ["E.stagger"]);
  await consumeRollMarks({ getFlag: (m, k) => k === "saveReasons" ? reasons : undefined });
  assert.equal(flags[STAGGER_USED], true);
  assert.equal(staggered.deleted, false);
  assert.deepEqual(saveReasons(orc.actor, "con", {}, { tokenDoc: orc.doc }).disadvantage, []);
});

// ── Countercharm ──
test("2014 Countercharm: a performing bard's friends within 30 ft (that can hear it) have advantage against charm and fear", async () => {
  settings.saveRules = true;
  const cc = feat("countercharm", { rules: "2014" });
  const bard = creature("Bard", 0, 0, { disposition: 1, items: [cc] });
  await onCountercharmUsed({ item: cc, actor: bard.actor });
  const [mark] = bard.actor.created;
  assert.deepEqual(mark.duration, { value: 1, units: "rounds", expiry: "turnEnd" });
  bard.actor.effects.push({ disabled: false, getFlag: (m, k) => k === PERFORMANCE_FLAG ? true : undefined });
  const pip = creature("Pip", 4, 0, { disposition: 1 });                  // 20 ft
  const far = creature("Far", 8, 0, { disposition: 1 });                  // 40 ft
  const charm = new Set(["charmed"]);
  assert.equal(countercharmFor(pip.actor, pip.doc, charm), "Bard");
  assert.equal(countercharmFor(bard.actor, bard.doc, new Set(["frightened"])), "Bard");
  assert.equal(countercharmFor(pip.actor, pip.doc, new Set(["poisoned"])), null);
  assert.equal(countercharmFor(far.actor, far.doc, charm), null);
  pip.actor.statuses.add("deafened");
  assert.equal(countercharmFor(pip.actor, pip.doc, charm), null);
  assert.ok(saveReasons(bard.actor, "wis", { statuses: charm }, { tokenDoc: bard.doc }).advantage.includes("Countercharm (Bard)"));
});

test("2024 Countercharm: a save failed against charm or fear is rerolled with advantage; the roller's prompts only if still failed", async () => {
  settings.reactionPrompts = "all";
  const calls = [];
  const real = LDA.promptLuckOnCheckFail;
  LDA.promptLuckOnCheckFail = async (...args) => { calls.push(args); return { passed: false }; };
  try {
    settings.rollBoosts = true;
    const cc = feat("countercharm");
    const act = { activation: { type: "reaction" }, effects: [], async use() { return { message: { system: {} } }; } };
    cc.system.activities = new Map([["a", act]]);
    creature("Bard", 2, 0, { disposition: 1, items: [cc] });
    const pip = creature("Pip", 0, 0, { disposition: 1, type: "character" });
    pip.actor.effects.push({ getFlag: (s, k) => s === MODULE_ID && k === "boost" ? { kind: "bardic", die: "d6" } : undefined, disabled: false });
    let asked = null;
    prompts.choice = async (_t, content, buttons) => { asked = content; return buttons.find(b => b.action === "countercharm") ? "countercharm" : "none"; };
    const save = (against) => ({ total: 8, d20: 6, options: { target: 15 },
      parent: { id: `m${++seq}`, speaker: { token: pip.doc.id }, getFlag: (m, k) => k === SAVE_AGAINST_FLAG ? against : null } });
    rollResults.push(9, 17);                                               // the reroll's two d20s: 17 kept
    await onD20TestRolled([save(["charmed"])], { subject: pip.actor, ability: "wis" }, D20_TESTS["dnd5e.rollSavingThrow"]);
    assert.match(asked, /Pip.*failed a saving throw against being charmed \(8 vs DC 15\)/);
    assert.equal(calls.length, 0);                                         // passed now: no Luck Dice prompt

    asked = null;
    await onD20TestRolled([save(["poisoned"])], { subject: pip.actor, ability: "con" }, D20_TESTS["dnd5e.rollSavingThrow"]);
    assert.equal(asked, null);                                             // not charm or fear: not asked
    assert.equal(calls.length, 1);
  } finally { LDA.promptLuckOnCheckFail = real; settings.rollBoosts = false; }
});

// ── Potent Cantrip ──
test("Potent Cantrip: a cantrip's success takes half (no-damage-on-save cantrips too); 2024 misses as well", async () => {
  settings.saveRules = true; settings.attackAdvantage = true;
  const wizard = { uuid: "Actor.wiz", items: [feat("potent-cantrip")] };
  const cantrip = (actor, level = 0) => ({ item: { type: "spell", system: { level } }, actor });
  assert.equal(potentCantripSave(cantrip(wizard)), true);
  assert.equal(potentCantripSave(cantrip(wizard, 1)), false);            // not a cantrip
  assert.equal(potentCantripMiss(cantrip(wizard)), true);
  assert.equal(potentCantripMiss(cantrip({ items: [feat("potent-cantrip", { rules: "2014" })] })), false);   // 2014: saves only

  const seen = {};
  const a = makeToken("pa", "A"), b = makeToken("pb", "B");
  for (const [id, t] of [["a", a], ["b", b]]) {
    t.document.actor = { uuid: `Actor.${id}`, name: id, items: [], statuses: new Set(),
      system: { _source: { attributes: { hp: { value: 30, temp: 0, tempmax: 0 } } } },
      calculateDamage: (d, { multiplier }) => ({ amount: d.reduce((s, x) => s + x.value * multiplier, 0) }),
      async applyDamage(d, { multiplier }) { seen[id] = d.reduce((s, x) => s + x.value * multiplier, 0); } };
  }
  const message = { id: "pdmg", rolls: [damageRoll(10)], flags: {}, setFlag: async (_m, k, v) => { message.flags[k] = v; } };
  messages.set("pdmg", message);
  const sacredFlame = { ...cantrip(wizard), save: { ability: new Set(["dex"]), dc: { value: 13 } }, damage: { parts: [{}], onSave: "none" },
    rollDamage: async () => [{ parent: message }] };
  const targets = [{ token: a.document.uuid, name: "A" }, { token: b.document.uuid, name: "B" }];
  await applySaveDamage(sacredFlame, targets, new Map([[a.document.uuid, { passed: true }], [b.document.uuid, { passed: false }]]));
  assert.deepEqual(seen, { a: 5, b: 10 });
});

// ── Indomitable Might ──
test("Indomitable Might: a Strength check (2024: or save) below the Strength score uses the score", async () => {
  settings.rollBoosts = true;
  const barb = { items: [feat("indomitable-might")], system: { abilities: { str: { value: 20 } } } };
  assert.equal(indomitableMight(barb, "str", "check", 12), 20);
  assert.equal(indomitableMight(barb, "str", "save", 12), 20);
  assert.equal(indomitableMight(barb, "str", "check", 22), null);
  assert.equal(indomitableMight(barb, "dex", "check", 5), null);
  const old = { items: [feat("indomitable-might", { rules: "2014" })], system: { abilities: { str: { value: 20 } } } };
  assert.equal(indomitableMight(old, "str", "save", 12), null);          // 2014: checks only
  settings.rollBoosts = false;
  assert.equal(indomitableMight(barb, "str", "check", 12), null);

  // In the roll: an Athletics check of 12 against DC 18 becomes 20 and passes — nothing else is offered.
  settings.rollBoosts = true;
  const calls = [];
  const real = LDA.promptLuckOnCheckFail;
  LDA.promptLuckOnCheckFail = async (...args) => { calls.push(args); return { passed: false }; };
  try {
    const grog = creature("Grog", 0, 0, { disposition: 1, type: "character", items: [feat("indomitable-might")], str: 20 });
    // A Bardic Inspiration die to offer: a failure would prompt.
    grog.actor.effects.push({ getFlag: (s, k) => s === MODULE_ID && k === "boost" ? { kind: "bardic", die: "d6" } : undefined, disabled: false });
    const roll = { total: 12, d20: 7, options: { target: 18 }, parent: { id: `m${++seq}`, getFlag: () => null } };
    await onD20TestRolled([roll], { subject: grog.actor, ability: "str", skill: "ath" }, D20_TESTS["dnd5e.rollSkillV2"]);
    assert.equal(calls.length, 0);                                          // raised to 20: passed
    await onD20TestRolled([{ ...roll, parent: { ...roll.parent, id: `m${++seq}` } }], { subject: grog.actor, ability: "dex", skill: "acr" },
      D20_TESTS["dnd5e.rollSkillV2"]);
    assert.equal(calls.length, 1);                                          // a Dexterity check isn't raised: it fails, and is prompted
  } finally { LDA.promptLuckOnCheckFail = real; settings.rollBoosts = false; }
});

// ── Dark One's Own Luck ──
test("Dark One's Own Luck: +1d10 to a check or save, from its uses, with the roll bonuses", async () => {
  settings.rollBoosts = true;
  const luck = feat("dark-ones-own-luck", { uses: 3 });
  const warlock = { items: [luck], effects: [], statuses: new Set() };
  const [boost] = boostsFor(warlock, "save");
  assert.equal(boost.label, "Dark One's Own Luck (+1d10, 3 left)");
  assert.equal(boostsFor(warlock, "check").length, 1);
  assert.equal(boostsFor(warlock, "attack").length, 0);
  rollResults.push(7);
  const out = await boost.use();
  assert.equal(out.bonusRoll.total, 7);
  assert.equal(luck.system.uses.spent, 1);
  luck.system.uses.spent = 3;
  assert.equal(boostsFor(warlock, "save").length, 0);                     // none left
  settings.rollBoosts = false;
  luck.system.uses.spent = 0;
  assert.equal(boostsFor(warlock, "save").length, 0);
});
