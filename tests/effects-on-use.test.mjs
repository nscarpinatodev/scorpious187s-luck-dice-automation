// Effects of activities with no attack or save (Mage Armor, Bless, Shield, Rage): applied when the activity is used.
import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useEffectAudience, applyUseEffects, applyActivityEffects } from "../scripts/native/effects.mjs";

const { settings, makeToken, messages } = env;

let applied, seq = 0;
const realCreate = document.createElement;
beforeEach(() => {
  env.reset();
  settings.effectAutomation = true;
  applied = [];
  document.createElement = (tag) => tag === "effect-application"
    ? { _applyEffectToActor: async (effect, actor) => {
        await new Promise(r => setTimeout(r, 1));                       // as slow as a real database write
        const existing = actor.effects.find(e => e.source === effect.uuid);
        if (existing) { applied.push(`${actor.name}:${effect.name}:again`); return existing; }
        const made = { uuid: `${actor.uuid}.ActiveEffect.${effect.id}`, source: effect.uuid, _stats: { duplicateSource: effect.uuid } };
        actor.effects.push(made);
        applied.push(`${actor.name}:${effect.name}`);
        return made;
      } }
    : realCreate(tag);
});

function creature(name) {
  const token = makeToken(`${name}${++seq}`, name);
  Object.assign(token.document.actor, { name, isOwner: true, effects: [], system: { traits: { ci: { value: new Set() } } },
    getActiveTokens: () => [token] });
  return token;
}
const effect = (name) => ({ id: name.toLowerCase(), name, uuid: `Item.x.ActiveEffect.${name.toLowerCase()}`, statuses: new Set() });
function usageOf(...effects) {
  const usage = { id: `use${++seq}`, flags: {}, system: { getEffects: async () => effects },
    getFlag: (_m, k) => usage.flags[k], setFlag: async (_m, k, v) => { usage.flags[k] = v; } };
  messages.set(usage.id, usage);
  return usage;
}
const spell = (caster, { type = "utility", range = "touch", affects = "creature", template = "", identifier = "mage-armor", activation = "action" } = {}) => ({
  type, actor: caster.document.actor, item: { name: identifier, type: "spell", system: { identifier } },
  range: { units: range }, target: { affects: { type: affects }, template: { type: template } }, activation: { type: activation },
  getUsageToken: () => caster
});

test("who a no-roll effect goes to: its user, the targets, or the targets with its user as the fallback", () => {
  const wizard = creature("Wizard");
  assert.equal(useEffectAudience(spell(wizard)), "targets-or-self");                                   // Mage Armor
  assert.equal(useEffectAudience(spell(wizard, { range: "self", affects: "self" })), "self");            // Shield
  assert.equal(useEffectAudience(spell(wizard, { range: "self", affects: "" })), "self");                // Rage
  assert.equal(useEffectAudience(spell(wizard, { range: "ft" })), "targets");                            // Bless, Hex
  assert.equal(useEffectAudience(spell(wizard, { range: "self", affects: "creature", template: "radius" })), "targets");
  assert.equal(useEffectAudience(spell(wizard, { type: "heal" })), "targets-or-self");
  assert.equal(useEffectAudience(spell(wizard, { type: "attack" })), null);                              // on a hit
  assert.equal(useEffectAudience(spell(wizard, { type: "save" })), null);                                // on a failed save
  assert.equal(useEffectAudience(spell(wizard, { type: "enchant" })), null);
  assert.equal(useEffectAudience(spell(wizard, { identifier: "guidance" })), null);                      // the roll bonuses place it
  assert.equal(useEffectAudience(spell(wizard, { range: "ft", activation: "reaction" })), null);         // Silvery Barbs
  assert.equal(useEffectAudience(spell(wizard, { range: "self", affects: "self", activation: "reaction" })), "self");
});

test("Mage Armor: on the creature targeted; with nobody targeted, on the caster", async () => {
  const wizard = creature("Wizard"), ally = creature("Fighter");
  const usage = usageOf(effect("Mage Armor"));
  await applyUseEffects(spell(wizard), { message: usage });
  assert.deepEqual(applied, ["Wizard:Mage Armor"]);
  assert.deepEqual(usage.flags.appliedEffects.map(a => a.name), [wizard.document.name]);

  game.user.targets = new Set([ally]);
  await applyUseEffects(spell(wizard), { message: usageOf(effect("Mage Armor")) });
  assert.deepEqual(applied, ["Wizard:Mage Armor", "Fighter:Mage Armor"]);
});

test("a spell that only affects its caster ignores whoever is targeted; one with a reach needs a target", async () => {
  const wizard = creature("Wizard"), orc = creature("Orc");
  game.user.targets = new Set([orc]);
  await applyUseEffects(spell(wizard, { range: "self", affects: "self", identifier: "shield" }), { message: usageOf(effect("Shield")) });
  assert.deepEqual(applied, ["Wizard:Shield"]);

  game.user.targets = new Set();
  await applyUseEffects(spell(wizard, { range: "ft", identifier: "hex" }), { message: usageOf(effect("Hexed")) });
  assert.deepEqual(applied, ["Wizard:Shield"]);                                                        // an untargeted Hex curses no one
  game.user.targets = new Set([orc]);
  await applyUseEffects(spell(wizard, { range: "ft", identifier: "hex" }), { message: usageOf(effect("Hexed")) });
  assert.deepEqual(applied, ["Wizard:Shield", "Orc:Hexed"]);
});

test("left to dnd5e's tray: a choice of effects, enchantments, the setting off, someone else's activity", async () => {
  const wizard = creature("Wizard");
  await applyUseEffects(spell(wizard), { message: usageOf(effect("Bear's Endurance"), effect("Bull's Strength")) });
  await applyUseEffects(spell(wizard), { message: usageOf({ ...effect("Magic Weapon"), type: "enchantment" }) });
  await applyUseEffects(spell(wizard), { message: usageOf() });
  await applyUseEffects(spell(wizard), {});
  settings.effectAutomation = false;
  await applyUseEffects(spell(wizard), { message: usageOf(effect("Mage Armor")) });
  settings.effectAutomation = true;
  wizard.document.actor.isOwner = false;
  await applyUseEffects(spell(wizard), { message: usageOf(effect("Mage Armor")) });
  assert.deepEqual(applied, []);
});

test("two requests for the same effect on the same creature: applied once, the second finds the first's", async () => {
  const wizard = creature("Wizard");
  const usage = usageOf(effect("Shield"));
  const target = { actor: wizard.document.actor.uuid, token: wizard.document.uuid, name: "Wizard", effectIds: ["shield"] };
  await Promise.all([applyActivityEffects({ usageId: usage.id, targets: [target] }), applyActivityEffects({ usageId: usage.id, targets: [target] })]);
  assert.deepEqual(applied, ["Wizard:Shield", "Wizard:Shield:again"]);
  assert.equal(wizard.document.actor.effects.length, 1);
});
