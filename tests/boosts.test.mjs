import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rollExtras, bardicInspiration, withExtraD20, markBoostTargets, BOOST_FLAG } from "../scripts/native/boosts.mjs";
import { offerReactions, REACTIONS_FLAG } from "../scripts/native/reactions.mjs";

const { settings, uuids, makeToken, rollResults } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

// The shared prompts (classic scripts) — loaded for real on top of the fake LDA.
Object.assign(LDA, {
  updateLuckUses: async () => true, whisperLuckRegain: async () => {}, consumeInspiration: async () => {},
  evaluateInspirationReroll: async (r) => r
});
await import("../scripts/attack.js");
await import("../scripts/skill-check.js");
await import("../scripts/saving-throw.js");

let choices = [];
beforeEach(() => {
  env.reset();
  settings.rollBoosts = true;
  game.users = [game.user];
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => game.user } } });
  choices = [];
  env.prompts.choice = async (_title, content, buttons) => {
    choices.lastButtons = buttons.map(b => b.action); choices.lastContent = content;
    return choices.shift() ?? buttons.at(-1).action;
  };
});

/** A d20 roll: its d20 results (one kept), a flat bonus, a DC — round-trips like a dnd5e roll. */
class TestRoll {
  constructor({ results, bonus = 0, options = {} }) {
    this.die = { faces: 20, results: results.map(r => (typeof r === "number" ? { result: r, active: true } : { ...r })) };
    this.dice = [this.die]; this.bonus = bonus; this.options = options; this.formula = `1d20 + ${bonus}`; this.data = {};
    this._total = this._evaluateTotal();
  }
  get total() { return this._total; }
  get d20() { return this.die.results.find(r => r.active !== false)?.result; }  // the fake LDA's getKeptD20Result reads this
  get isCritical() { return this.d20 === 20; }
  get isFumble() { return this.d20 === 1; }
  _evaluateTotal() { return this.die.results.filter(r => r.active !== false).reduce((s, r) => s + r.result, 0) + this.bonus; }
  toJSON() { return { results: this.die.results, bonus: this.bonus, options: this.options }; }
  static fromData(data) { return new TestRoll(structuredClone(data)); }
}

let seq = 0;
/** A creature with items; `effects` its active effects (deletable). */
function creature(name, { items = [], effects = [], disposition = 1, scale = {}, classes = {} } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const actor = token.document.actor;
  Object.assign(actor, {
    name, type: "character", isOwner: true, hasPlayerOwner: true, items, classes, testUserPermission: () => false,
    system: { scale, spells: {} },
    effects: Object.assign([], { get(id) { return this.find(e => e.id === id); } }),
    created: [],
    async createEmbeddedDocuments(_type, data) { for (const d of data) actor.effects.push(effect(actor, d)); actor.created.push(...data); },
    async deleteEmbeddedDocuments(_type, ids) { for (const id of ids) actor.effects.splice(actor.effects.findIndex(e => e.id === id), 1); }
  });
  for (const e of effects) actor.effects.push(effect(actor, e));
  uuids.set(actor.uuid, actor);
  return { token, actor };
}
function effect(actor, data) {
  const e = {
    id: `e${++seq}`, disabled: false, ...data, parent: actor, isOwner: true,
    getFlag: (scope, key) => scope === MODULE_ID ? data.flags?.[MODULE_ID]?.[key] : undefined,
    async delete() { actor.effects.splice(actor.effects.indexOf(e), 1); }
  };
  e.uuid = `${actor.uuid}.ActiveEffect.${e.id}`;
  return e;
}
/** An item (registered) with an identifier; `uses` gives it limited uses. */
function item(identifier, { owner = null, uses = null, rules = "2024", type = "feat" } = {}) {
  const it = {
    uuid: `${owner?.uuid ?? "Actor.x"}.Item.${identifier}${++seq}`, documentName: "Item", name: identifier, type, actor: owner,
    system: { identifier, source: { rules }, ...(uses ? { uses: { max: uses, spent: 0 } } : {}) },
    async update(u) { if ("system.uses.spent" in u) it.system.uses.spent = u["system.uses.spent"]; }
  };
  uuids.set(it.uuid, it);
  return it;
}
const mark = (die, from = "Bard") => ({ name: `Bardic Inspiration (${die})`, flags: { [MODULE_ID]: { [BOOST_FLAG]: { kind: "bardic", die, from } } } });

test("Bardic Inspiration: the module's mark, or dnd5e 2024's Inspired effect with the bard's die", () => {
  const { actor: pip } = creature("Pip", { effects: [mark("d8", "Lyra")] });
  assert.deepEqual({ ...bardicInspiration(pip), effects: undefined }, { effects: undefined, die: "d8", from: "Lyra" });

  const bard = creature("Lyra", { scale: { bard: { inspiration: { die: "d10" } } } }).actor;
  const feature = item("bardic-inspiration", { owner: bard });
  const { actor: tam } = creature("Tam", { effects: [{ name: "Inspired", system: { origin: { item: feature.uuid } }, flags: {} }] });
  assert.equal(bardicInspiration(tam).die, "d10");
  assert.equal(bardicInspiration(creature("None").actor), null);
});

test("the extras: off with the setting, once each, and the ones that replace the roll only before anything's added", async () => {
  const lucky = item("lucky", { uses: 3 });
  const { actor } = creature("Pip", { items: [lucky], effects: [mark("d6")] });
  settings.rollBoosts = false;
  assert.equal(rollExtras(actor, "check"), null);
  settings.rollBoosts = true;
  const extras = rollExtras(actor, "attack");
  assert.deepEqual(extras.options().map(o => o.action), ["boost:bardic", "boost:lucky"]);
  assert.deepEqual(extras.options({ added: true }).map(o => o.action), ["boost:bardic"]);
  assert.deepEqual(extras.options({ autoMiss: true }).map(o => o.action), ["boost:lucky"]);

  rollResults.push(4);
  const out = await extras.run("boost:bardic", null);
  assert.equal(out.bonusRoll.total, 4);
  assert.equal(out.label, "Added 1d6 Bardic Inspiration");
  assert.equal(actor.effects.length, 0);                           // the die is gone
  assert.deepEqual(extras.options().map(o => o.action), ["boost:lucky"]);
  assert.equal(rollExtras(creature("Plain").actor, "save"), null);
});

test("Lucky: another d20, the higher used (a copy — the card's roll is replaced, not changed); a Luck Point spent", async () => {
  const lucky = item("lucky", { uses: 3 });
  const { actor } = creature("Pip", { items: [lucky] });
  const roll = new TestRoll({ results: [4], bonus: 5, options: { target: 15 } });
  rollResults.push(13);
  const out = await rollExtras(actor, "save").run("boost:lucky", roll);
  assert.equal(out.roll.total, 18);
  assert.match(out.detail, /d20: 13 \(used\)/);
  assert.equal(roll.total, 9);
  assert.equal(lucky.system.uses.spent, 1);

  // Lower wins for the attacker's roll; a worse die is shown as discarded.
  assert.equal(withExtraD20(roll, 2, "lower").total, 7);
  const kept = withExtraD20(roll, 3, "higher");
  assert.equal(kept.total, 9);
  assert.deepEqual(kept.die.results.map(r => [r.result, r.active]), [[4, true], [3, false]]);
  // With advantage already rolled: the new die is measured against the one used.
  const adv = new TestRoll({ results: [{ result: 6, active: false, discarded: true }, 11] });
  assert.equal(withExtraD20(adv, 15, "higher").total, 15);
});

test("Indomitable: saves only, a reroll plus the 2024 Fighter level", async () => {
  const indomitable = item("indomitable", { uses: 1 });
  const { actor } = creature("Fighter", { items: [indomitable], classes: { fighter: { system: { levels: 9 } } } });
  assert.equal(rollExtras(actor, "check"), null);
  rollResults.push(4);
  const out = await rollExtras(actor, "save").run("boost:indomitable", new TestRoll({ results: [2], bonus: 1 }));
  assert.equal(out.roll.total, 13);                                 // 4 + 9
  assert.equal(out.label, "Rerolled with Indomitable (+9)");
  assert.equal(indomitable.system.uses.spent, 1);
  assert.equal(rollExtras(actor, "save"), null);                    // used up
});

test("2014 Guidance on checks, Resistance on saves: +1d4, then the caster's concentration on it ends", async () => {
  const cleric = creature("Cleric").actor;
  const guidance = item("guidance", { owner: cleric, type: "spell", rules: "2014" });
  const ended = [];
  cleric.endConcentration = async (it) => { ended.push(it.system.identifier); };
  const { actor } = creature("Pip", { effects: [{ name: "Guidance", system: { origin: { item: guidance.uuid }, changes: [] }, flags: {} }] });
  assert.equal(rollExtras(actor, "save"), null);                    // Guidance is for checks
  const extras = rollExtras(actor, "check");
  assert.deepEqual(extras.options().map(o => o.label), ["Guidance (+1d4)"]);
  rollResults.push(3);
  const out = await extras.run("boost:guidance", null);
  assert.equal(out.bonusRoll.total, 3);
  assert.deepEqual(ended, ["guidance"]);
  assert.equal(actor.effects.length, 0);

  // 2024's Guidance (it changes the skill itself) isn't offered.
  const g24 = item("guidance", { owner: cleric, type: "spell" });
  const { actor: modern } = creature("Tam", { effects: [{ name: "Stealth Guidance", system: { origin: { item: g24.uuid }, changes: [{ key: "system.skills.ste.bonuses.check" }] }, flags: {} }] });
  assert.equal(rollExtras(modern, "check"), null);
});

test("using Bardic Inspiration marks the creature targeted: the module's mark for 2014, dnd5e's effect for 2024", async () => {
  const bard = creature("Lyra", { scale: { bard: { "bardic-inspiration": { die: "d8" } } } });
  const pip = creature("Pip");
  canvas.tokens.setTargets([pip.token.id, bard.token.id]);
  const feature = item("bardic-inspiration", { owner: bard.actor, rules: "2014" });
  const use = { item: feature, actor: bard.actor };
  await markBoostTargets(use, { message: { system: { getEffects: async () => [] } } });
  assert.equal(bard.actor.created.length, 0);                        // not the bard itself
  assert.equal(pip.actor.created[0].name, "Bardic Inspiration (d8)");
  assert.deepEqual(pip.actor.created[0].flags[MODULE_ID][BOOST_FLAG], { kind: "bardic", die: "d8", from: "Lyra" });
  // Given again: still one die.
  await markBoostTargets(use, { message: { system: { getEffects: async () => [] } } });
  assert.equal(pip.actor.effects.length, 1);

  // 2024: the activity's Inspired effect, applied the way the effects tray does.
  const applied = [];
  const realCreate = document.createElement;
  const usage = { id: "use1", flags: {}, system: { getEffects: async () => [{ id: "insp", name: "Inspired", statuses: new Set() }] },
    getFlag: (_m, k) => usage.flags[k], setFlag: async (_m, k, v) => { usage.flags[k] = v; } };
  env.messages.set("use1", usage);
  document.createElement = (tag) => tag === "effect-application"
    ? { _applyEffectToActor: async (e, a) => { applied.push(`${a.name}:${e.name}`); return { uuid: "x" }; } } : realCreate(tag);
  try { await markBoostTargets(use, { message: usage }); }
  finally { document.createElement = realCreate; }
  assert.deepEqual(applied, ["Pip:Inspired"]);

  settings.rollBoosts = false;
  pip.actor.created.length = 0;
  await markBoostTargets(use, { message: { system: { getEffects: async () => [] } } });
  assert.equal(pip.actor.created.length, 0);
});

test("the check prompt: a creature without Luck Dice is offered its Bardic Inspiration, which turns the failure", async () => {
  const { actor } = creature("Pip", { effects: [mark("d8")] });
  const roll = new TestRoll({ results: [7], bonus: 5, options: { target: 15 } });
  const steps = [];
  const reporter = async (entry, rolls) => { steps.push([entry.label, entry.total, !!rolls.bonusRoll]); };
  choices = ["boost:bardic"];
  rollResults.push(5);
  const result = await LDA.promptLuckOnCheckFail(actor, 12, 15, null, "", roll, "Failed Skill Check", "skill check", true, reporter, rollExtras(actor, "check"));
  assert.deepEqual(choices.lastButtons, ["boost:bardic", "keep"]);
  assert.deepEqual(result, { finalTotal: 17, passed: true });
  assert.deepEqual(steps, [["Added 1d8 Bardic Inspiration", 17, true]]);

  // Without extras, nothing to offer such a creature: no prompt.
  choices = [];
  assert.equal(await LDA.promptLuckOnCheckFail(actor, 12, 15, null, "", roll, "Failed Skill Check", "skill check", true, reporter, null), undefined);
});

test("a natural 1 on a save: Indomitable rerolls it, then the full prompt; once a die is added, no reroll throws it away", async () => {
  const indomitable = item("indomitable", { uses: 1, rules: "2014" });
  const { actor } = creature("Fighter", { items: [indomitable], effects: [mark("d6")] });
  const roll = new TestRoll({ results: [1], bonus: 4, options: { target: 15 } });
  const steps = [];
  const reporter = async (entry) => { steps.push([entry.label, entry.total]); };
  choices = ["boost:indomitable", "boost:bardic"];
  rollResults.push(12, 6);                                          // the reroll, then the d6
  const result = await LDA.promptNatOneSave(actor, 5, 15, roll, null, "", true, reporter, rollExtras(actor, "save"));
  assert.deepEqual(steps, [["Rerolled with Indomitable", 12], ["Added 1d6 Bardic Inspiration", 18]]);
  assert.deepEqual(result, { finalTotal: 18, passed: true });

  // The other way round: after the Bardic die, Indomitable's reroll isn't offered.
  const second = item("indomitable", { uses: 1, rules: "2014" });
  const { actor: other } = creature("Other", { items: [second], effects: [mark("d6")] });
  choices = ["boost:bardic"];
  rollResults.push(2);
  const kept = await LDA.promptNatOneSave(other, 5, 15, roll, null, "", true, reporter, rollExtras(other, "save"));
  assert.deepEqual(kept, { finalTotal: 7, passed: false });
  assert.equal(second.system.uses.spent, 0);
});

test("the attack prompt: Lucky on a natural 1, then the miss prompt with what's left", async () => {
  const lucky = item("lucky", { uses: 2 });
  const { actor } = creature("Pip", { items: [lucky], effects: [mark("d4")] });
  let current = new TestRoll({ results: [1], bonus: 6 });
  const attack = {
    actor, state: { attackPrompted: false, luckSpentOnAttack: 0 },
    total: () => current.total, hitState: () => !current.isFumble && current.total >= 18,
    extras: rollExtras(actor, "attack"), roll: () => current,
    async applyExtra(out) { current = out.roll ?? new TestRoll({ results: current.die.results, bonus: current.bonus + out.bonusRoll.total }); },
    finish: async () => {}
  };
  choices = ["boost:lucky", "boost:bardic"];
  rollResults.push(10, 3);                                          // Lucky's d20, then the d4
  await LDA.promptNatOne(attack);
  assert.equal(current.total, 19);                                  // 10 + 6, then + 3
  assert.equal(lucky.system.uses.spent, 1);
});

test("Lucky when hit: the attacker rolls another d20 and uses the lower — not a reaction, and with reaction prompts off", async () => {
  settings.reactionPrompts = "off";
  const lucky = item("lucky", { uses: 3 });
  const { token, actor } = creature("Pip", { items: [lucky] });
  let roll = new TestRoll({ results: [15], bonus: 4 });               // 19 vs AC 16
  const message = {
    get rolls() { return [roll]; }, flags: {},
    system: { targets: [{ actor: actor.uuid, token: token.document.uuid, name: "Pip", ac: 16 }] },
    getFlag: (_m, k) => message.flags[k],
    async update(u) {
      if (u.rolls) roll = u.rolls[0];
      for (const [k, v] of Object.entries(u)) if (k.startsWith("flags.")) message.flags[k.split(".").pop()] = v;
    }
  };
  choices = ["lucky"];
  rollResults.push(6);
  await offerReactions(message, { actor: { name: "Orc" }, item: { name: "Axe" } });
  assert.equal(roll.total, 10);
  assert.equal(lucky.system.uses.spent, 1);
  assert.deepEqual(message.flags[REACTIONS_FLAG].map(r => r.reaction), ["Lucky (d20 6: 19 → 10)"]);

  // Not offered when no d20 could make it miss (the bonus alone reaches the AC).
  const sure = new TestRoll({ results: [15], bonus: 20 });
  roll = sure; message.flags = {};
  choices = ["lucky"];
  await offerReactions(message, { actor: { name: "Orc" }, item: { name: "Axe" } });
  assert.equal(message.flags[REACTIONS_FLAG], undefined);
  assert.equal(choices.length, 1);
});
