import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { onEffectCreated, onTurnEndRepeatSaves, repeatEffects, REPEAT_FLAG } from "../scripts/native/repeat-saves.mjs";

const { settings, uuids, scene, makeToken } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

beforeEach(() => {
  env.reset();
  settings.repeatSaves = true;
  settings.saveAutomation = "full";
  game.users = [game.user];
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => game.user } } });
});

function holdPerson({ identifier = "hold-person", dc = 15 } = {}) {
  const activity = { uuid: `Actor.cleric.Item.${identifier}.Activity.save`, item: { name: "Hold Person", system: { identifier } },
    save: { ability: ["wis"], dc: { value: dc } } };
  uuids.set(activity.uuid, activity);
  return activity;
}
/** A creature with effects, whose saves pass or fail as told. */
function creature(id, { passes = [] } = {}) {
  const token = makeToken(id, id);
  const actor = token.document.actor;
  const effects = new Map();
  Object.assign(actor, {
    effects: Object.assign([...effects.values()], { get: (eid) => effects.get(eid) }),
    testUserPermission: () => false,
    saves: [],
    async rollSavingThrow(config) {
      const passed = passes.shift() ?? false;
      actor.saves.push(config);
      return [{ parent: { id: `save${actor.saves.length}`, rolls: [{ isSuccess: passed, total: passed ? 18 : 6 }] } }];
    }
  });
  actor.addEffect = (effect) => {
    effects.set(effect.id, effect);
    effect.parent = actor;
    effect.delete = async () => { effects.delete(effect.id); actor.effects = Object.assign([...effects.values()], { get: (eid) => effects.get(eid) }); };
    actor.effects = Object.assign([...effects.values()], { get: (eid) => effects.get(eid) });
    return effect;
  };
  return { token, actor };
}
function effect(id, originActivity, { flags = {}, concentration = false } = {}) {
  const e = { id, name: id, disabled: false, flags: structuredClone(flags), system: { origin: { activity: originActivity }, ...(concentration ? { type: "concentrating" } : {}) },
    getFlag: (m, k) => e.flags[m]?.[k], async setFlag(m, k, v) { (e.flags[m] ??= {})[k] = v; } };
  return e;
}
const fight = { id: "c", started: true, scene, round: 1, turn: 1 };
const ended = (tokenId) => ({ round: 1, turn: 0, tokenId });

test("an effect from a repeat-save spell is tagged with its save", async () => {
  const hp = holdPerson();
  const { actor } = creature("goblin");
  const paralyzed = actor.addEffect(effect("paralyzed", hp.uuid));
  paralyzed.parent.documentName = "Actor";
  await onEffectCreated(paralyzed);
  assert.deepEqual(paralyzed.getFlag(MODULE_ID, REPEAT_FLAG), { ability: "wis", dc: 15, activity: hp.uuid, name: "Hold Person" });
});

test("not tagged: other spells, the concentration effect, the setting off", async () => {
  const fireball = holdPerson({ identifier: "fireball" });
  const hp = holdPerson();
  const { actor } = creature("goblin");
  actor.documentName = "Actor";
  const other = actor.addEffect(effect("burn", fireball.uuid));
  const conc = actor.addEffect(effect("conc", hp.uuid, { concentration: true }));
  await onEffectCreated(other); await onEffectCreated(conc);
  assert.equal(other.getFlag(MODULE_ID, REPEAT_FLAG), undefined);
  assert.equal(conc.getFlag(MODULE_ID, REPEAT_FLAG), undefined);
  settings.repeatSaves = false;
  const later = actor.addEffect(effect("p2", hp.uuid));
  await onEffectCreated(later);
  assert.equal(later.getFlag(MODULE_ID, REPEAT_FLAG), undefined);
});

test("end of its turn: a pass removes the spell's effects; a fail keeps them", async () => {
  const hp = holdPerson();
  const flag = { [MODULE_ID]: { [REPEAT_FLAG]: { ability: "wis", dc: 15, activity: hp.uuid, name: "Hold Person" } } };
  const failing = creature("orc", { passes: [false] });
  failing.actor.addEffect(effect("paralyzed", hp.uuid, { flags: flag }));
  await onTurnEndRepeatSaves(fight, ended("orc"));
  assert.equal(failing.actor.saves.length, 1);
  assert.deepEqual(failing.actor.saves[0], { ability: "wis", target: 15, "scorpious187s-luck-dice-automation": { noDialog: true } });
  assert.equal(repeatEffects(failing.actor).length, 1);

  const passing = creature("goblin", { passes: [true] });
  passing.actor.addEffect(effect("paralyzed", hp.uuid, { flags: flag }));
  passing.actor.addEffect(effect("companion", hp.uuid, { flags: flag }));          // same spell: one save
  await onTurnEndRepeatSaves(fight, ended("goblin"));
  assert.equal(passing.actor.saves.length, 1);
  assert.equal(repeatEffects(passing.actor).length, 0);
  assert.match(env.notes.at(-1), /goblin shook off Hold Person/);
});

test("only out of combat no; only for the creature whose turn ended; not on other clients", async () => {
  const hp = holdPerson();
  const flag = { [MODULE_ID]: { [REPEAT_FLAG]: { ability: "wis", dc: 15, activity: hp.uuid, name: "Hold Person" } } };
  const { actor } = creature("goblin", { passes: [true] });
  actor.addEffect(effect("paralyzed", hp.uuid, { flags: flag }));
  await onTurnEndRepeatSaves({ ...fight, started: false }, ended("goblin"));
  await onTurnEndRepeatSaves(fight, ended("someone-else"));
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => ({ id: "otherGM" }) } } });
  await onTurnEndRepeatSaves(fight, ended("goblin"));
  assert.equal(actor.saves.length, 0);
});
