import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { saveReasons, saveSource, onPreRollSave, installAutoFail, auraOfProtection, evasionApplies, saveReasonsHTML, SAVE_REASONS_FLAG } from "../scripts/native/save-rules.mjs";
import { applySaveDamage } from "../scripts/native/saves.mjs";
import { applyActivityEffects } from "../scripts/native/effects.mjs";
import { onD20TestRolled, D20_TESTS } from "../scripts/native/checks.mjs";
import { injectSummaryNotes } from "../scripts/native/cards.mjs";

const { settings, uuids, makeToken, messages, damageRoll } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

// A square grid in feet: each space 5 ft, diagonals 5 ft too.
canvas.grid = {
  isGridless: false, distance: 5, size: 100, units: "ft",
  getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
  measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5 })
};

beforeEach(() => {
  env.reset();
  settings.saveRules = true;
  game.modules.delete("automated-conditions-5e");
});

let seq = 0;
const feat = (identifier, { rules = "2024", effects = [] } = {}) => ({ type: "feat", name: identifier, system: { identifier, source: { rules } }, effects });
/** A creature at grid space (col, row). */
function creature(name, col = 0, row = 0, { disposition = 1, statuses = [], items = [], cha = 0, paladinLevel = 0 } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const d = token.document;
  Object.assign(d, { x: col * 100, y: row * 100, elevation: 0, width: 1, height: 1, getOccupiedGridSpaceOffsets: () => [{ i: row, j: col }] });
  Object.assign(d.actor, {
    name, statuses: new Set(statuses), items, effects: [],
    system: { abilities: { str: {}, dex: {}, con: {}, int: {}, wis: {}, cha: { mod: cha } } },
    classes: paladinLevel ? { paladin: { system: { levels: paladinLevel } } } : {},
    getActiveTokens: () => [d]
  });
  return { token, doc: d, actor: d.actor };
}
/** An activity (registered by uuid) on an item of `type`, applying effects with these statuses / dealing these damage types. */
function source({ type = "spell", statuses = [], damage = [], magical = false, school = null } = {}) {
  const item = { type, system: { properties: new Set(magical ? ["mgc"] : []), school } };
  const activity = {
    uuid: `Item.i${++seq}.Activity.a`, item,
    effects: statuses.length ? [{ _id: "e", effect: { statuses: new Set(statuses) } }] : [],
    damage: { parts: damage.map(t => ({ types: new Set([t]) })) }
  };
  uuids.set(activity.uuid, activity);
  return { data: { system: { activity: { uuid: activity.uuid } } } };
}
const rollConfig = (actor, ability) => ({ subject: actor, ability, rolls: [{ parts: [], data: {}, options: {} }] });

test("Paralyzed, Stunned, Unconscious or Petrified: Strength and Dexterity saves fail automatically", () => {
  const { actor } = creature("Held", 0, 0, { statuses: ["paralyzed"] });
  assert.equal(saveReasons(actor, "dex").autoFail, "Paralyzed");
  assert.equal(saveReasons(actor, "str").autoFail, "Paralyzed");
  assert.equal(saveReasons(actor, "con").autoFail, null);

  const config = rollConfig(actor, "dex"), message = {};
  onPreRollSave(config, {}, message);
  assert.equal(config.rolls[0].options[MODULE_ID].autoFail, "Paralyzed");
  assert.equal(message.data.flags[MODULE_ID][SAVE_REASONS_FLAG].autoFail, "Paralyzed");
  assert.match(saveReasonsHTML(message.data.flags[MODULE_ID][SAVE_REASONS_FLAG]), /Automatic failure:<\/strong> Paralyzed/);

  // AC5E automating statuses enforces it itself (a DC of 999): the reason is still noted, the roll left alone.
  game.modules.set("automated-conditions-5e", { active: true });
  const get = game.settings.get;
  game.settings.get = (scope, key) => scope === "automated-conditions-5e" ? key === "automateStatuses" : get(scope, key);
  try {
    assert.equal(saveReasons(actor, "dex").autoFailBy, "Automated Conditions 5e");
    const byAC5E = rollConfig(actor, "dex"), noted = {};
    onPreRollSave(byAC5E, {}, noted);
    assert.equal(byAC5E.rolls[0].options[MODULE_ID], undefined);
    assert.equal(noted.data.flags[MODULE_ID][SAVE_REASONS_FLAG].autoFail, "Paralyzed");
  } finally { game.settings.get = get; game.modules.delete("automated-conditions-5e"); }

  // Off: nothing.
  settings.saveRules = false;
  const off = rollConfig(actor, "dex");
  onPreRollSave(off, {}, {});
  assert.equal(off.rolls[0].options[MODULE_ID], undefined);
});

test("an automatic failure is a failure on the roll itself — however high, and only with a DC", () => {
  class D20 {
    constructor(total, options) { this.total = total; this.options = options; this._evaluated = true; }
    get isSuccess() { return this._evaluated ? (Number.isFinite(this.options.target) ? this.total >= this.options.target : false) : undefined; }
    get isFailure() { return this._evaluated ? (Number.isFinite(this.options.target) ? this.total < this.options.target : false) : undefined; }
  }
  installAutoFail(D20);
  installAutoFail(D20); // once only
  const failed = new D20(25, { target: 15, [MODULE_ID]: { autoFail: "Stunned" } });
  assert.equal(failed.isSuccess, false);
  assert.equal(failed.isFailure, true);
  const plain = new D20(25, { target: 15 });
  assert.equal(plain.isSuccess, true);
  const noDC = new D20(25, { [MODULE_ID]: { autoFail: "Stunned" } });
  assert.equal(noDC.isFailure, false);
});

test("after the roll: no Luck Dice prompt on an automatic failure; a creature with only Bardic Inspiration is prompted", async () => {
  const calls = [];
  const real = LDA.promptLuckOnCheckFail;
  LDA.promptLuckOnCheckFail = async (...args) => { calls.push(args); return { passed: false }; };
  try {
    const bard = { getFlag: (scope, key) => scope === MODULE_ID && key === "boost" ? { kind: "bardic", die: "d6" } : undefined, disabled: false };
    const { actor } = creature("Pip", 0, 0, { statuses: ["paralyzed"] });
    actor.type = "character";
    actor.effects = [bard];
    const roll = (options) => ({ total: 8, options: { target: 15, ...options }, parent: { id: `m${++seq}`, getFlag: () => null } });
    const test = D20_TESTS["dnd5e.rollSavingThrow"];
    await onD20TestRolled([roll({ [MODULE_ID]: { autoFail: "Paralyzed" } })], { subject: actor }, test);
    assert.equal(calls.length, 0);
    settings.rollBoosts = true;
    await onD20TestRolled([roll({})], { subject: actor }, test);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][10].options().map(o => o.action), ["boost:bardic"]);   // the extras
    // AC5E's forced failure (DC 999): nothing could reach it, so nothing is offered.
    game.modules.set("automated-conditions-5e", { active: true });
    await onD20TestRolled([roll({ target: 999 })], { subject: actor }, test);
    assert.equal(calls.length, 1);
    game.modules.delete("automated-conditions-5e");
    settings.rollBoosts = false;
    await onD20TestRolled([roll({})], { subject: actor }, test);
    assert.equal(calls.length, 1);                                    // no Luck Dice, no extras: nothing to offer
  } finally { LDA.promptLuckOnCheckFail = real; }
});

test("a save folded into its spell's card: its rules as a line under its summary there", () => {
  const notes = [];
  const summary = (id) => ({ dataset: { messageId: id }, append: (el) => notes.push([id, el.innerHTML]) });
  const flagged = (reasons, visible = true) => ({ isContentVisible: visible, getFlag: (m, k) => m === MODULE_ID && k === SAVE_REASONS_FLAG ? reasons : undefined });
  messages.set("s1", flagged({ autoFail: "Paralyzed", advantage: [], disadvantage: [], bonuses: [] }));
  messages.set("s2", flagged({ advantage: [], disadvantage: [], bonuses: [] }));           // nothing to say
  messages.set("s3", flagged({ advantage: ["Magic Resistance"], disadvantage: [], bonuses: [] }, false)); // private
  const html = { querySelectorAll: (q) => q.startsWith(".card-summary") ? ["s1", "s2", "s3", "gone"].map(summary) : [] };
  const realCreate = document.createElement;
  document.createElement = () => ({ style: {} });
  try { injectSummaryNotes(html); }
  finally { document.createElement = realCreate; }
  assert.deepEqual(notes, [["s1", "<strong>Automatic failure:</strong> Paralyzed"]]);
});

test("Magic Resistance: spells and magic items, not mundane sources", () => {
  const { actor } = creature("Golem", 0, 0, { items: [feat("magic-resistance")] });
  assert.deepEqual(saveReasons(actor, "wis", saveSource(source({ type: "spell" }))).advantage, ["Magic Resistance"]);
  assert.deepEqual(saveReasons(actor, "con", saveSource(source({ type: "weapon", magical: true }))).advantage, ["Magic Resistance"]);
  assert.deepEqual(saveReasons(actor, "con", saveSource(source({ type: "feat" }))).advantage, []);
  assert.deepEqual(saveReasons(actor, "con", saveSource({})).advantage, []);  // no known source

  // The hook: advantage on the roll, reasons for the card.
  const config = rollConfig(actor, "wis"), message = source({ type: "spell" });
  onPreRollSave(config, {}, message);
  assert.equal(config.advantage, true);
  assert.equal(config.rolls[0].options.advantage, true);
  assert.deepEqual(message.data.flags[MODULE_ID][SAVE_REASONS_FLAG].advantage, ["Magic Resistance"]);
});

test("what the save is against: charmed, frightened, poison — including saves to end the condition", () => {
  const elf = creature("Elf", 0, 0, { items: [feat("fey-ancestry"), feat("brave")] }).actor;
  assert.deepEqual(saveReasons(elf, "wis", saveSource(source({ statuses: ["charmed"] }))).advantage, ["Fey Ancestry"]);
  assert.deepEqual(saveReasons(elf, "wis", saveSource(source({ statuses: ["frightened"] }))).advantage, ["Brave"]);
  assert.deepEqual(saveReasons(elf, "wis", saveSource(source({ statuses: ["paralyzed"] }))).advantage, []);

  const dwarf14 = creature("Old", 0, 0, { items: [feat("dwarven-resilience", { rules: "2014" })] }).actor;
  const dwarf24 = creature("New", 0, 0, { items: [feat("dwarven-resilience", { rules: "2024" })] }).actor;
  const poisonDamage = saveSource(source({ damage: ["poison"] }));
  assert.deepEqual(saveReasons(dwarf14, "con", poisonDamage).advantage, ["Dwarven Resilience"]);
  assert.deepEqual(saveReasons(dwarf24, "con", poisonDamage).advantage, []);
  assert.deepEqual(saveReasons(dwarf24, "con", saveSource(source({ statuses: ["poisoned"] }))).advantage, ["Dwarven Resilience"]);

  const duergar = creature("Duergar", 0, 0, { items: [feat("duergar-resilience")] }).actor;
  assert.deepEqual(saveReasons(duergar, "int", saveSource(source({ type: "feat", school: "ill" }))).advantage, ["Duergar Resilience"]);

  const gnome = creature("Gnome", 0, 0, { items: [feat("gnome-cunning", { rules: "2014" })] }).actor;
  assert.deepEqual(saveReasons(gnome, "int", saveSource(source())).advantage, ["Gnome Cunning"]);
  assert.deepEqual(saveReasons(gnome, "dex", saveSource(source())).advantage, []);
});

test("2014 Danger Sense: Dexterity saves unless blinded, deafened or incapacitated; 2024's is dnd5e's", () => {
  const rogue = creature("Barb", 0, 0, { items: [feat("danger-sense", { rules: "2014" })] }).actor;
  assert.deepEqual(saveReasons(rogue, "dex").advantage, ["Danger Sense"]);
  assert.deepEqual(saveReasons(rogue, "wis").advantage, []);
  rogue.statuses.add("deafened");
  assert.deepEqual(saveReasons(rogue, "dex").advantage, []);
  const modern = creature("Modern", 0, 0, { items: [feat("danger-sense", { rules: "2024" })] }).actor;
  assert.deepEqual(saveReasons(modern, "dex").advantage, []);
});

test("Aura of Protection: allies within 10 ft (30 ft at 18th level), the best one, not while incapacitated", () => {
  const aura = feat("aura-of-protection", { rules: "2014" });
  const paladin = creature("Paladin", 0, 0, { items: [aura], cha: 3 });
  const ally = creature("Ally", 2, 0);              // 10 ft
  const far = creature("Far", 4, 0);                // 20 ft
  const foe = creature("Foe", 1, 0, { disposition: -1 });
  assert.deepEqual(auraOfProtection(ally.actor, ally.doc), { label: "Aura of Protection (Paladin)", value: 3, key: "auraOfProtection" });
  assert.equal(auraOfProtection(far.actor, far.doc), null);
  assert.equal(auraOfProtection(foe.actor, foe.doc), null);
  // 2014: the paladin itself too.
  assert.equal(auraOfProtection(paladin.actor, paladin.doc).value, 3);

  // The hook adds it to the formula.
  const config = rollConfig(ally.actor, "wis");
  onPreRollSave(config, {}, {});
  assert.deepEqual(config.rolls[0].parts, ["@auraOfProtection"]);
  assert.equal(config.rolls[0].data.auraOfProtection, 3);

  // Minimum +1; nothing while incapacitated.
  paladin.actor.system.abilities.cha.mod = -1;
  assert.equal(auraOfProtection(ally.actor, ally.doc).value, 1);
  paladin.actor.statuses.add("unconscious");
  assert.equal(auraOfProtection(ally.actor, ally.doc), null);
  paladin.actor.statuses.clear();
  paladin.actor.system.abilities.cha.mod = 3;

  // From 18th level: 30 ft. A second paladin with a better modifier wins.
  paladin.actor.classes = { paladin: { system: { levels: 18 } } };
  assert.equal(auraOfProtection(far.actor, far.doc).value, 3);
  creature("Other", 3, 0, { items: [feat("aura-of-protection")], cha: 5 });
  assert.equal(auraOfProtection(far.actor, far.doc).value, 5);
});

test("2024 Aura of Protection: the paladin's own effect covers the paladin; allies still get it", () => {
  const ownEffect = { transfer: true, disabled: false, system: { changes: [{ key: "system.bonuses.abilities.save", value: "@abilities.cha.mod" }] } };
  const paladin = creature("Paladin", 0, 0, { items: [feat("aura-of-protection", { effects: [ownEffect] })], cha: 2 });
  const ally = creature("Ally", 1, 0);
  assert.equal(auraOfProtection(paladin.actor, paladin.doc), null);
  assert.equal(auraOfProtection(ally.actor, ally.doc).value, 2);
});

test("Evasion: Dexterity saves against half damage — none on a success, half on a failure", async () => {
  const items = [feat("evasion")];
  const hp = (name, evasion) => {
    const actor = {
      uuid: `Actor.${name}`, name, items: evasion ? items : [], statuses: new Set(), seen: [],
      system: { _source: { attributes: { hp: { value: 50, temp: 0, tempmax: 0 } } } },
      calculateDamage: (d, { multiplier }) => ({ amount: d.reduce((s, x) => s + Math.floor(x.value * multiplier), 0) }),
      async applyDamage(d, { multiplier }) { actor.seen.push(d.reduce((s, x) => s + Math.floor(x.value * multiplier), 0)); }
    };
    uuids.set(`Token.${name}`, { actor });
    return actor;
  };
  const rogue = hp("rogue", true), monk = hp("monk", true), fighter = hp("fighter", false);
  const message = { id: "dmg1", rolls: [damageRoll(20)], flags: {}, setFlag: async (_m, k, v) => { message.flags[k] = v; } };
  messages.set(message.id, message);
  const fireball = {
    save: { ability: new Set(["dex"]), dc: { value: 15 } }, damage: { parts: [{}], onSave: "half" },
    rollDamage: async () => [{ parent: message }]
  };
  const targets = [{ token: "Token.rogue", name: "Rogue" }, { token: "Token.monk", name: "Monk" }, { token: "Token.fighter", name: "Fighter" }];
  const outcome = new Map([["Token.rogue", { passed: true }], ["Token.monk", { passed: false }], ["Token.fighter", { passed: true }]]);
  await applySaveDamage(fireball, targets, outcome);
  assert.deepEqual([rogue.seen, monk.seen, fighter.seen], [[0], [10], [10]]);
  const applied = message.flags.appliedDamage;
  assert.deepEqual(applied.map(a => a.reactions ?? []), [["Evasion"], ["Evasion"], []]);

  // Not while incapacitated, not on other saves, not against all-or-nothing damage, not with the setting off.
  monk.statuses.add("stunned");
  assert.equal(evasionApplies(monk, "dex", "half"), false);
  assert.equal(evasionApplies(rogue, "con", "half"), false);
  assert.equal(evasionApplies(rogue, "dex", "none"), false);
  settings.saveRules = false;
  assert.equal(evasionApplies(rogue, "dex", "half"), false);
});

test("effects that only apply conditions the target is immune to are skipped", async () => {
  const applied = [];
  const paralyzed = { id: "p", name: "Paralyzed", uuid: "Item.x.ActiveEffect.p", statuses: new Set(["paralyzed"]) };
  const slowed = { id: "s", name: "Slowed", uuid: "Item.x.ActiveEffect.s", statuses: new Set() };
  const usage = {
    id: "use1", flags: {}, system: { getEffects: async () => [paralyzed, slowed] },
    getFlag: (_m, k) => usage.flags[k], setFlag: async (_m, k, v) => { usage.flags[k] = v; }
  };
  messages.set(usage.id, usage);
  const undead = { uuid: "Actor.u", name: "Zombie", effects: [], system: { traits: { ci: { value: new Set(["paralyzed"]) } } } };
  uuids.set("Token.u", { actor: undead });
  const realCreate = document.createElement;
  document.createElement = (tag) => tag === "effect-application"
    ? { _applyEffectToActor: async (effect, actor) => { applied.push(`${actor.name}:${effect.name}`); return { uuid: `${actor.uuid}.ActiveEffect.${effect.id}` }; } }
    : realCreate(tag);
  try {
    await applyActivityEffects({ usageId: "use1", targets: [{ token: "Token.u", name: "Zombie", effectIds: ["p", "s"] }] });
  } finally { document.createElement = realCreate; }
  assert.deepEqual(applied, ["Zombie:Slowed"]);
  assert.deepEqual(usage.flags.appliedEffects[0].effects, ["Paralyzed (immune)", "Slowed"]);
  assert.equal(usage.flags.appliedEffects[0].undo.length, 1);
});
