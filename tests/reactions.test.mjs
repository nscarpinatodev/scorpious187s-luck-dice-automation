import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { reactionOptions, offerReactions, answerReaction, onTurnStartReaction, reactionMultiplier, REACTIONS_FLAG } from "../scripts/native/reactions.mjs";

const { settings, uuids, scene, makeToken } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";
let choices = [];

beforeEach(() => {
  env.reset();
  settings.reactionPrompts = "all";
  game.users = [game.user];
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => game.user } } });
  choices = [];
  env.prompts.choice = async (_title, content, buttons) => { const next = choices.shift(); choices.lastContent = content; choices.lastButtons = buttons.map(b => b.action); return next ?? "none"; };
});

let seq = 0;
/** A creature with reaction items; spell slots as given. */
function defender({ items = [], slots = { spell1: { value: 1 } }, type = "character" } = {}) {
  const token = makeToken(`d${++seq}`, `Defender${seq}`);
  const actor = token.document.actor;
  Object.assign(actor, { type, isOwner: true, system: { spells: slots }, testUserPermission: () => false, used: [] });
  actor.items = items.map(identifier => {
    const activity = { effects: identifier === "shield" ? [{}] : [], async use(config) { actor.used.push([identifier, config]); return { message: { id: `use-${identifier}`, system: { getEffects: () => [{}] } } }; } };
    return { name: identifier, type: identifier === "shield" ? "spell" : "feat", system: { identifier, level: identifier === "shield" ? 1 : 0, activities: new Map([["a", activity]]) } };
  });
  uuids.set(actor.uuid, actor);
  return { token, actor };
}
function attackCard(hits, { total = 16, critical = false } = {}) {
  const targets = hits.map(({ token, ac }) => ({ actor: token.document.actor.uuid, token: token.document.uuid, name: token.name, ac }));
  const message = {
    rolls: [{ total, isCritical: critical }], flags: {},
    system: {
      targets,
      get evaluatedTargets() { return message.system.targets.map(t => ({ ...t, isMiss: total < t.ac && !critical })); }
    },
    getFlag: (_m, k) => message.flags[k],
    async update(u) {
      if (u["system.targets"]) message.system.targets = u["system.targets"];
      for (const [k, v] of Object.entries(u)) if (k.startsWith("flags.")) message.flags[k.split(".").pop()] = v;
    }
  };
  return message;
}
const attacker = { actor: { name: "Orc" }, item: { name: "Greataxe" } };

test("Shield only when +5 AC turns the hit into a miss, not on a crit, with a slot", () => {
  const { actor } = defender({ items: ["shield"] });
  assert.deepEqual(reactionOptions(actor, { total: 16, ac: 15 }), ["shield"]);
  assert.deepEqual(reactionOptions(actor, { total: 21, ac: 15 }), []);
  assert.deepEqual(reactionOptions(actor, { total: 16, ac: 15, critical: true }), []);
  const { actor: noSlots } = defender({ items: ["shield"], slots: { spell1: { value: 0 } } });
  assert.deepEqual(reactionOptions(noSlots, { total: 16, ac: 15 }), []);
  const { actor: rogue } = defender({ items: ["uncanny-dodge"] });
  assert.deepEqual(reactionOptions(rogue, { total: 30, ac: 15, critical: true }), ["uncanny-dodge"]);
});

test("Shield: cast through dnd5e, its effect put on the caster, and the hit becomes a miss", async () => {
  const wizard = defender({ items: ["shield"] });
  choices = ["shield"];
  const message = attackCard([{ token: wizard.token, ac: 15 }]);
  await offerReactions(message, attacker);
  assert.deepEqual(wizard.actor.used.map(u => u[0]), ["shield"]);
  assert.equal(message.system.targets[0].ac, 20);
  assert.equal(message.system.evaluatedTargets[0].isMiss, true);
  assert.deepEqual(message.flags[REACTIONS_FLAG].map(r => r.reaction), ["Shield (+5 AC)"]);
  assert.match(choices.lastContent, /Orc[\s\S]*hit[\s\S]*Greataxe[\s\S]*16 vs AC 15/);
});

test("Uncanny Dodge: noted with a half-damage multiplier for that target", async () => {
  const rogue = defender({ items: ["uncanny-dodge"] });
  choices = ["uncanny-dodge"];
  const message = attackCard([{ token: rogue.token, ac: 14 }]);
  await offerReactions(message, attacker);
  assert.equal(reactionMultiplier(message, rogue.token.document.uuid), 0.5);
  assert.equal(message.system.targets[0].ac, 14);
  assert.deepEqual(rogue.actor.used[0][1], { consume: true, subsequentActions: false });
});

test("declining, players-only mode, and one reaction until the creature's turn", async () => {
  const rogue = defender({ items: ["uncanny-dodge"] });
  choices = ["none"];
  const declined = attackCard([{ token: rogue.token, ac: 14 }]);
  await offerReactions(declined, attacker);
  assert.equal(declined.flags[REACTIONS_FLAG], undefined);

  settings.reactionPrompts = "players";
  const npc = defender({ items: ["uncanny-dodge"], type: "npc" });
  choices = ["uncanny-dodge"];
  await offerReactions(attackCard([{ token: npc.token, ac: 14 }]), attacker);
  assert.equal(npc.actor.used.length, 0);
  assert.equal(choices.length, 1);                                  // never asked

  choices = ["uncanny-dodge"];
  const payload = { token: rogue.token.document.uuid, actor: rogue.actor.uuid, options: ["uncanny-dodge"], total: 20, ac: 14 };
  assert.deepEqual(await answerReaction(payload), { identifier: "uncanny-dodge" });
  choices = ["uncanny-dodge"];
  assert.equal(await answerReaction(payload), null);                 // spent
  onTurnStartReaction({ scene }, { tokenId: rogue.token.id });
  choices = ["uncanny-dodge"];
  assert.deepEqual(await answerReaction(payload), { identifier: "uncanny-dodge" });
});

test("the setting off: nobody is asked", async () => {
  settings.reactionPrompts = "off";
  const wizard = defender({ items: ["shield"] });
  choices = ["shield"];
  await offerReactions(attackCard([{ token: wizard.token, ac: 15 }]), attacker);
  assert.equal(wizard.actor.used.length, 0);
});
