import { env } from "./env.mjs";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "../scripts/native/index.mjs";

const { settings, hooks, dialogs, makeToken } = env;

before(() => {
  const warn = console.warn; console.warn = () => {};      // no socket router in tests
  try { hooks.callAll("ready"); } finally { console.warn = warn; }
});
beforeEach(() => env.reset());

const useHook = (...args) => hooks.handlers("dnd5e.postUseActivity")[0](...args);
const item = (identifier) => ({ name: identifier, system: { identifier }, scalingIncrease: 0, updateSource(u) { this.last = u; } });

test("ready registers native mode's hooks", () => {
  for (const name of ["renderChatMessageHTML", "dnd5e.renderChatMessage", "dnd5e.rollDamageV2",
    "dnd5e.rollSavingThrow", "dnd5e.rollConcentrationV2", "dnd5e.rollAbilityCheck", "dnd5e.rollSkillV2",
    "dnd5e.rollToolCheckV2", "dnd5e.postUseActivity", "createChatMessage", "moveToken", "updateRegion",
    "createActiveEffect"]) {
    assert.equal(hooks.count(name), 1, name);
  }
  assert.equal(hooks.count("combatTurnChange"), 2);
  assert.equal(hooks.count("dnd5e.rollAttackV2"), 2);                // marks used up; Luck Dice + automation
  assert.equal(hooks.count("dnd5e.preRollAttackV2"), 2);             // advantage reasons; skip the window
  assert.equal(hooks.count("renderAttackRollConfigurationDialog"), 1);                 // reactions back; lingering areas + repeat saves
});

test("heal / damage-only: dnd5e's follow-up kept unless confirmation takes over", async () => {
  settings.damageOnlyAutomation = true;
  let rolled = null;
  const activity = { type: "damage", item: item("magic-missile"), actor: {}, createConsumedFlag: () => ({ x: 1 }),
    rollDamage: async (...args) => { rolled = args; } };

  const config = {};
  useHook(activity, config, { templates: [] });
  assert.equal(config.subsequentActions, undefined);

  settings.targetConfirmation = "all";
  makeToken("a", "Goblin");
  canvas.tokens.setTargets(["a"]);
  dialogs.push(async () => "ok");
  const confirmed = { event: "evt" };
  useHook(activity, confirmed, { templates: [], message: { id: "use9", system: { deltas: {} } } });
  assert.equal(confirmed.subsequentActions, false);
  await env.flush(); await env.flush();
  assert.ok(rolled, "rolled after confirming");
  assert.equal(rolled[2].data.system.origin, "use9");
  assert.deepEqual(activity.item.last, { "flags.dnd5e.consumed": { x: 1 } });

  // A caller that already turned dnd5e's follow-up off is left alone.
  const off = { subsequentActions: false };
  useHook(activity, off, { templates: [] });
  assert.equal(off.subsequentActions, false);
  assert.equal(dialogs.length, 0);
});

test("ordinary attacks: confirmed first only with the 'every attack' choice", async () => {
  let attacked = null;
  const sword = { type: "attack", item: item("longsword"), actor: {}, createConsumedFlag: () => null,
    rollAttack: async (...args) => { attacked = args; } };
  settings.targetConfirmation = "all";
  const kept = {};
  useHook(sword, kept, { message: { id: "u1", system: {} } });
  assert.equal(kept.subsequentActions, undefined);

  settings.targetConfirmation = "every";
  makeToken("a", "Goblin");
  canvas.tokens.setTargets(["a"]);
  dialogs.push(async () => "ok");
  const confirmed = { event: "evt" };
  useHook(sword, confirmed, { message: { id: "u2", system: {} } });
  assert.equal(confirmed.subsequentActions, false);
  await env.flush(); await env.flush();
  assert.equal(attacked?.[2].data.system.origin, "u2");

  // Cancelled: no attack.
  attacked = null;
  dialogs.push(async () => "cancel");
  useHook(sword, {}, { message: { id: "u3", system: {} } });
  await env.flush(); await env.flush();
  assert.equal(attacked, null);
});

test("attacks: only multi-ray spells with the ray setting take over", () => {
  const ray = { type: "attack", item: item("scorching-ray") };
  const plain = {};
  useHook(ray, plain, { message: { id: "u", system: {} } });
  assert.equal(plain.subsequentActions, undefined);           // setting off

  settings.rayAutomation = true;
  const single = {};
  useHook({ type: "attack", item: item("eldritch-blast") }, single, { message: { id: "u", system: {} } });
  assert.equal(single.subsequentActions, undefined);          // one beam

  const multi = {};
  game.user.targets = new Set();                              // fireRays finds no targets and stops
  useHook(ray, multi, { message: { id: "u", system: {} } });
  assert.equal(multi.subsequentActions, false);
});

test("skip the attack roll window: only with the setting, never over an explicit choice, never cancels", () => {
  const handler = hooks.handlers("dnd5e.preRollAttackV2")[1];
  const off = {};
  assert.equal(handler({}, off, {}), undefined);
  assert.equal(off.configure, undefined);                           // setting off: dnd5e decides

  settings.skipAttackDialog = true;
  const skipped = {};
  assert.notEqual(handler({}, skipped, {}), false);
  assert.equal(skipped.configure, false);
  const forced = { configure: true };                               // e.g. another module's opt-in
  handler({}, forced, {});
  assert.equal(forced.configure, true);
});

test("skip the attack roll window: AC5E's opt-in choices keep it open; its plain verdict doesn't", () => {
  const handler = hooks.handlers("dnd5e.preRollAttackV2")[1];
  settings.skipAttackDialog = true;
  game.modules.set("automated-conditions-5e", { active: true });
  const withAc5e = (side) => ({ rolls: [{ options: { "automated-conditions-5e": { subject: {}, opponent: {}, ...side } } }] });
  try {
    const optin = {};
    handler(withAc5e({ subject: { bonus: [{ id: "bless", optin: true }] } }), optin, {});
    assert.equal(optin.configure, undefined);                        // window opens for the choice

    const forced = {};
    handler(withAc5e({ opponent: { advantage: [{ id: "x", forceOptin: true }] } }), forced, {});
    assert.equal(forced.configure, undefined);

    const verdict = {};
    handler(withAc5e({ subject: { disadvantage: ["Prone", { id: "y", optin: false }] } }), verdict, {});
    assert.equal(verdict.configure, false);                          // AC5E decided: roll straight away

    const otherHook = {};
    handler(withAc5e({ subject: { bonus: [{ id: "z", optin: true, hook: "damage" }] } }), otherHook, {});
    assert.equal(otherHook.configure, false);                        // a damage opt-in waits for the damage roll

    game.modules.delete("automated-conditions-5e");
    const inactive = {};
    handler(withAc5e({ subject: { bonus: [{ id: "bless", optin: true }] } }), inactive, {});
    assert.equal(inactive.configure, false);                         // AC5E not active: nothing to wait for
  } finally {
    game.modules.delete("automated-conditions-5e");
  }
});
