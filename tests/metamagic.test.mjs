import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  castOptions, metamagicCost, onPreUseMetamagic, onRenderUsageDialog, onMetamagicUsed, onPreRollDamageMetamagic,
  chooseSaveMetamagic, rerollDice, doubledDuration, offerEmpowered, metamagicForUsage, METAMAGIC_FLAG
} from "../scripts/native/metamagic.mjs";
import { applySaveDamage } from "../scripts/native/saves.mjs";
import { rollExtras } from "../scripts/native/boosts.mjs";

const { settings, uuids, makeToken, rollResults, dialogs, messages, damageRoll } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

beforeEach(() => {
  env.reset();
  settings.metamagic = true;
  game.users = [game.user];
});

let seq = 0;
const item = (identifier, { rules = "2024", uses = null, type = "feat" } = {}) => {
  const it = { name: identifier, type, system: { identifier, source: { rules }, ...(uses ? { uses: { max: uses, spent: 0 } } : {}) },
    async update(u) { if ("system.uses.spent" in u) it.system.uses.spent = u["system.uses.spent"]; } };
  return it;
};
function sorcerer({ points = 5, options = [], rules = "2024", cha = 3 } = {}) {
  const font = item("font-of-magic", { uses: points });
  const items = [font, ...options.map(o => item(o, { rules }))];
  const actor = { uuid: `Actor.s${++seq}`, name: "Sorcerer", isOwner: true, items, effects: [],
    system: { abilities: { cha: { mod: cha } } } };
  return { actor, font };
}
/** A spell and its activity: `damage` types, a save, its range, duration and casting time. */
function cast(actor, { level = 1, save = false, damage = ["fire"], range = { value: 60, units: "ft" }, duration = { value: 1, units: "minute" },
  activation = "action", count = "1" } = {}) {
  const activities = new Map();
  const spell = { type: "spell", name: "Spell", uuid: `${actor.uuid}.Item.sp${++seq}`, system: { level, range, duration, activities } };
  const activity = { type: save ? "save" : "attack", item: spell, actor, uuid: `${spell.uuid}.Activity.a`,
    activation: { type: activation }, range: { ...range }, target: { affects: { count } },
    damage: { parts: damage.map(t => ({ types: new Set([t]) })) } };
  activities.set("a", activity);
  return activity;
}
const keys = (options) => options?.map(o => `${o.key}:${o.cost}${o.affordable ? "" : "!"}`) ?? null;

test("the options that fit the spell, at their 2014 / 2024 costs, unaffordable ones marked; none without points or the setting", () => {
  const all = ["careful-spell", "distant-spell", "extended-spell", "heightened-spell", "quickened-spell", "subtle-spell", "transmuted-spell", "twinned-spell", "empowered-spell"];
  const s24 = sorcerer({ points: 1, options: all });
  assert.deepEqual(keys(castOptions(cast(s24.actor, { save: true }))),
    ["careful:1", "distant:1", "extended:1", "heightened:2!", "quickened:2!", "subtle:1", "transmuted:1", "twinned:1"]);
  // An attack cantrip, touch range, instantaneous, bonus action, cold: fewer fit (2014 Twinned costs 1 for a cantrip).
  const s14 = sorcerer({ points: 5, options: all, rules: "2014" });
  assert.deepEqual(keys(castOptions(cast(s14.actor, { level: 0, range: { units: "touch" }, duration: { units: "inst" }, activation: "bonus", damage: ["necrotic"] }))),
    ["distant:1", "subtle:1", "twinned:1"]);
  assert.equal(metamagicCost("heightened", item("heightened-spell", { rules: "2014" })), 3);
  assert.equal(metamagicCost("twinned", item("twinned-spell", { rules: "2014" }), 3), 3);
  assert.equal(castOptions(cast(sorcerer({ points: 0, options: all }).actor)), null);
  settings.metamagic = false;
  assert.equal(castOptions(cast(s24.actor)), null);
});

test("the casting window opens for a sorcerer's spell (cantrips too), unless it's being skipped; the section offers the options", () => {
  const { actor } = sorcerer({ options: ["subtle-spell", "transmuted-spell", "heightened-spell"] });
  const activity = cast(actor, { level: 0 });
  const usage = {};
  onPreUseMetamagic(activity, usage, {});
  assert.equal(activity._requiresConfigurationDialog(), true);
  assert.deepEqual(usage.ldaMetamagic, { choice: "", damageType: "" });
  const skipped = cast(actor);
  onPreUseMetamagic(skipped, {}, { configure: false });
  assert.equal(skipped._requiresConfigurationDialog, undefined);

  // The section in the window.
  let fieldset = null;
  const realCreate = document.createElement;
  document.createElement = () => ({ set innerHTML(h) { this.html = h; }, get innerHTML() { return this.html; } });
  const form = { querySelectorAll: () => [], querySelector: () => null, append: (el) => { fieldset = el; } };
  try { onRenderUsageDialog({ activity, config: { ldaMetamagic: { choice: "transmuted" } } }, { querySelector: () => form }); }
  finally { document.createElement = realCreate; }
  assert.match(fieldset.html, /Subtle Spell <span[^>]*>\(1\)/);
  assert.match(fieldset.html, /value="transmuted" checked/);
  assert.match(fieldset.html, /<select name="ldaMetamagic.damageType">/);
  assert.match(fieldset.html, /5 Sorcery Points/);
});

test("after the cast: the points are spent, the choice noted; Distant doubles the range until the next casting", async () => {
  const { actor, font } = sorcerer({ options: ["distant-spell"] });
  const activity = cast(actor);
  const real = { range: { value: 60, units: "ft" } };
  uuids.set(activity.uuid, real);
  const usage = { id: "use1", flags: {}, async setFlag(_m, k, v) { usage.flags[k] = v; } };
  onMetamagicUsed(activity, { ldaMetamagic: { choice: "distant" } }, { message: usage });
  assert.equal(activity.range.value, 120);
  assert.equal(real.range.value, 120);
  await env.flush();
  assert.equal(font.system.uses.spent, 1);
  assert.deepEqual(usage.flags[METAMAGIC_FLAG], { name: "Distant Spell", cost: 1, notes: [] });
  assert.equal(metamagicForUsage("use1").key, "distant");
  onPreUseMetamagic(activity, {}, {});
  assert.equal(real.range.value, 60);

  // Not enough points: nothing happens.
  const broke = sorcerer({ points: 1, options: ["quickened-spell"] });
  onMetamagicUsed(cast(broke.actor), { ldaMetamagic: { choice: "quickened" } }, { message: null });
  await env.flush();
  assert.equal(broke.font.system.uses.spent, 0);
});

test("Transmuted: the listed damage types become the one chosen", async () => {
  const { actor } = sorcerer({ options: ["transmuted-spell"] });
  const activity = cast(actor);
  onMetamagicUsed(activity, { ldaMetamagic: { choice: "transmuted", damageType: "cold" } }, { message: null });
  await env.flush();
  const config = { subject: activity, rolls: [{ options: { type: "fire", types: ["fire"] } }, { options: { type: "radiant" } }] };
  onPreRollDamageMetamagic(config);
  assert.deepEqual(config.rolls.map(r => r.options.type), ["cold", "radiant"]);
});

test("Careful and Heightened: picked before the saves; Careful's 2024 creatures take no damage on a half-damage spell", async () => {
  const { actor } = sorcerer({ options: ["careful-spell"], cha: 1 });
  const activity = cast(actor, { save: true });
  const ally = makeToken("ally", "Ally", { disposition: 1 });
  const foe = makeToken("foe", "Foe", { disposition: -1 });
  activity.getUsageToken = () => ({ document: { disposition: 1 } });
  const usage = { id: "use2", flags: {}, async setFlag(_m, k, v) { usage.flags[k] = v; } };
  onMetamagicUsed(activity, { ldaMetamagic: { choice: "careful" } }, { message: usage });
  await env.flush();
  dialogs.push((ui) => { assert.equal(ui.checkboxes.find(c => c.value === "ally").checked, true); return "ok"; });
  const targets = [{ token: ally.document.uuid, name: "Ally" }, { token: foe.document.uuid, name: "Foe" }];
  const picked = await chooseSaveMetamagic(activity, targets, usage);
  assert.deepEqual([...picked.careful], [ally.document.uuid]);
  assert.match(usage.flags[METAMAGIC_FLAG].notes[0], /protected Ally/);

  // The damage: the protected creature takes none (2024), the other half on a success.
  const seen = {};
  for (const [id, t] of [["ally", ally], ["foe", foe]]) {
    t.document.actor = { uuid: `Actor.${id}`, name: id, items: [], statuses: new Set(),
      system: { _source: { attributes: { hp: { value: 30, temp: 0, tempmax: 0 } } } },
      calculateDamage: (d, { multiplier }) => ({ amount: d.reduce((s, x) => s + x.value * multiplier, 0) }),
      async applyDamage(d, { multiplier }) { seen[id] = d.reduce((s, x) => s + x.value * multiplier, 0); } };
  }
  const message = { id: "dmg", rolls: [damageRoll(20)], flags: {}, setFlag: async (_m, k, v) => { message.flags[k] = v; } };
  messages.set("dmg", message);
  const fireball = { save: { ability: new Set(["dex"]), dc: { value: 15 } }, damage: { parts: [{}], onSave: "half" }, rollDamage: async () => [{ parent: message }] };
  const outcome = new Map([[ally.document.uuid, { passed: true, careful: true, carefulRules: "2024" }], [foe.document.uuid, { passed: true }]]);
  await applySaveDamage(fireball, targets, outcome);
  assert.deepEqual(seen, { ally: 0, foe: 10 });

  // Heightened: one creature.
  const h = sorcerer({ options: ["heightened-spell"] });
  const hActivity = cast(h.actor, { save: true });
  hActivity.getUsageToken = () => ({ document: { disposition: 1 } });
  const hUsage = { id: "use3", flags: {}, async setFlag(_m, k, v) { hUsage.flags[k] = v; } };
  onMetamagicUsed(hActivity, { ldaMetamagic: { choice: "heightened" } }, { message: hUsage });
  await env.flush();
  dialogs.push(() => "ok");                                          // the foe is ticked to start with
  const hPicked = await chooseSaveMetamagic(hActivity, targets, hUsage);
  assert.equal(hPicked.heightened, foe.document.uuid);
});

test("Empowered: the dice picked are rerolled, the old ones kept as rerolled; a point is spent", async () => {
  const { actor, font } = sorcerer({ options: ["empowered-spell"], cha: 2 });
  class Dmg extends CONFIG.Dice.DamageRoll {
    constructor(results) { super("3d6", {}, { type: "fire" }); this.dice = [{ faces: 6, results: results.map(r => ({ result: r, active: true })) }]; }
    _evaluateTotal() { return this.dice[0].results.filter(r => r.active).reduce((s, r) => s + r.result, 0); }
    toJSON() { return this.dice[0].results.map(r => r.result); }
    static fromData(data) { return new Dmg(data); }
  }
  const message = { rolls: [new Dmg([1, 2, 6])], flags: {}, getFlag: (_m, k) => message.flags[k],
    async update(u) { message.rolls = u.rolls; for (const [k, v] of Object.entries(u)) if (k.startsWith("flags.")) message.flags[k.split(".").pop()] = v; } };
  dialogs.push((ui) => { ui.check(0); ui.check(1); return "ok"; });
  rollResults.push(5, 4);
  await offerEmpowered(message, { item: { type: "spell" }, actor });
  const results = message.rolls[0].dice[0].results;
  assert.deepEqual(results.map(r => [r.result, r.active]), [[1, false], [2, false], [6, true], [5, true], [4, true]]);
  assert.equal(message.rolls[0]._total, 15);
  assert.equal(font.system.uses.spent, 1);
  assert.match(message.flags[METAMAGIC_FLAG].notes[0], /rerolled 1→5, 2→4/);
  // Once per card.
  await offerEmpowered(message, { item: { type: "spell" }, actor });
  assert.equal(font.system.uses.spent, 1);
});

test("Seeking on a missed spell attack; Extended's doubled durations, up to 24 hours", async () => {
  const { actor, font } = sorcerer({ options: ["seeking-spell"] });
  assert.equal(rollExtras(actor, "attack", { spell: false }), null);
  const extras = rollExtras(actor, "attack", { spell: true });
  assert.deepEqual(extras.options().map(o => o.action), ["boost:seeking"]);
  rollResults.push(17);
  const out = await extras.run("boost:seeking", { formula: "1d20 + 7", data: {}, options: {} });
  assert.equal(out.label, "Rerolled with Seeking Spell");
  assert.equal(font.system.uses.spent, 1);

  assert.deepEqual(doubledDuration({ value: 1, units: "minutes" }), { value: 120, units: "seconds" });
  assert.deepEqual(doubledDuration({ value: 8, units: "hours" }), { value: 57600, units: "seconds" });
  assert.deepEqual(doubledDuration({ value: 24, units: "hours" }), { value: 86400, units: "seconds" });
  assert.equal(doubledDuration({ value: null, units: "seconds" }), null);
});

test("dice rerolled on a copy: the original roll isn't changed", async () => {
  const roll = { dice: [{ faces: 8, results: [{ result: 2, active: true }] }], toJSON() { return structuredClone(this.dice); },
    constructor: { fromData: (d) => ({ dice: d, _evaluateTotal() { return 99; } }) } };
  rollResults.push(7);
  const { rolls, newValues } = await rerollDice([roll], [{ rollIndex: 0, termIndex: 0, resultIndex: 0, faces: 8 }]);
  assert.deepEqual(newValues, [7]);
  assert.equal(roll.dice[0].results.length, 1);
  assert.equal(rolls[0].dice[0].results[1].result, 7);
});

// ── Ranges through a spell conduit (Kilian's Eldritch Rifle), Eldritch Spear, Spell Sniper ──
import { castRange, ac5eSpellSniperRange, adjustCastRange } from "../scripts/native/metamagic.mjs";
import { eldritchSpearRange } from "../scripts/native/invocations.mjs";

const conduit = (mult) => ({ "scorpious187s-custom-items": { conduitCast: { rangeMultiplier: mult } } });
function rangedSpell(actor, { value, identifier = "fire-bolt", mult = 1 }) {
  const spellItem = { type: "spell", name: identifier, uuid: `${actor.uuid}.Item.${identifier}${++seq}`, flags: mult > 1 ? conduit(mult) : {},
    system: { identifier, level: 0 }, effects: [] };
  return { type: "attack", item: spellItem, actor, uuid: `${spellItem.uuid}.Activity.a`, range: { value, units: "ft" } };
}
function withAC5E(rulesVersion, fn) {
  game.modules.set("automated-conditions-5e", { active: true });
  settings.dnd5e.rulesVersion = rulesVersion;
  const get = game.settings.get;
  game.settings.get = (scope, key) => scope === "automated-conditions-5e" ? (key === "autoRangeChecks" ? new Set(["rangedOoR", "rangedLongDisadvantage"]) : false) : get(scope, key);
  try { return fn(); } finally { game.settings.get = get; game.modules.delete("automated-conditions-5e"); delete settings.dnd5e.rulesVersion; }
}
const caster = (items, warlockLevels = 5) => ({ uuid: `Actor.c${++seq}`, name: "Caster", items, effects: [],
  classes: { warlock: { system: { levels: warlockLevels } } }, system: { abilities: {} } });

test("Eldritch Spear through the rifle: its distance is multiplied with the rest", () => {
  settings.invocations = true;
  const w24 = caster([item("eldritch-spear")]);
  assert.deepEqual(eldritchSpearRange(rangedSpell(w24, { value: 240, identifier: "eldritch-blast", mult: 2 })), { value: 540, units: "ft" });
  assert.deepEqual(eldritchSpearRange(rangedSpell(w24, { value: 120, identifier: "eldritch-blast" })), { value: 270, units: "ft" });
  const w14 = caster([item("eldritch-spear", { rules: "2014" })]);
  assert.deepEqual(eldritchSpearRange(rangedSpell(w14, { value: 240, identifier: "eldritch-blast", mult: 2 })), { value: 600, units: "ft" });
});

test("AC5E's Spell Sniper follows the world's rules version: the range given to it comes out at the feat's own, times the rifle", () => {
  const s24 = caster([item("spell-sniper")]), s14 = caster([item("spell-sniper", { rules: "2014" })]);
  // 2024 world, 2024 feat: (120 + 60) × 2 = 360; AC5E adds 60 to what it's given.
  withAC5E("modern", () => assert.equal(ac5eSpellSniperRange(rangedSpell(s24, { value: 240, mult: 2 }), 240), 300));
  // Without the rifle and with matching rules there's nothing to correct.
  withAC5E("modern", () => assert.equal(ac5eSpellSniperRange(rangedSpell(s24, { value: 120 }), 120), null));
  withAC5E("legacy", () => assert.equal(ac5eSpellSniperRange(rangedSpell(s14, { value: 240, mult: 2 }), 240), null));
  // A 2014 feat in a 2024 world: doubled (480 through the rifle), though AC5E would add 60.
  withAC5E("modern", () => assert.equal(ac5eSpellSniperRange(rangedSpell(s14, { value: 240, mult: 2 }), 240), 420));
  withAC5E("modern", () => assert.equal(ac5eSpellSniperRange(rangedSpell(s14, { value: 120 }), 120), 180));
  // A 2024 feat in a 2014 world: +60, though AC5E would double.
  withAC5E("legacy", () => assert.equal(ac5eSpellSniperRange(rangedSpell(s24, { value: 120 }), 120), 90));
  // Without AC5E checking range, the module's own check handles Spell Sniper.
  assert.equal(ac5eSpellSniperRange(rangedSpell(s24, { value: 240, mult: 2 }), 240), null);
});

test("Distant Spell through the rifle: doubled on the rifle's range; the spell on the sheet keeps its own", () => {
  settings.metamagic = true;
  const s = caster([item("distant-spell")]);
  const channeled = rangedSpell(s, { value: 240, mult: 2 });
  assert.deepEqual(castRange(channeled, "distant"), { value: 480, units: "ft" });
  // The spell on the sheet (no conduit) gets its own range worked out, not the channeled one.
  const real = { type: "attack", item: { type: "spell", flags: {}, system: { identifier: "fire-bolt" } }, actor: s, range: { value: 120, units: "ft" } };
  uuids.set(channeled.uuid, real);
  adjustCastRange(channeled, "distant");
  assert.equal(channeled.range.value, 480);
  assert.equal(real.range.value, 240);
});
