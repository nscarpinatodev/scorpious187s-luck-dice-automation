import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { concentrationButton, concentrationRoller, onConcentrationPrompt, deleteConcentrationPrompt } from "../scripts/native/concentration.mjs";

const { settings, messages, user } = env;
const gm = user;
const player = { id: "p1", name: "Player", isGM: false, active: true };
const lib = { active: true, api: { utils: { primaryGM: () => gm } } };

beforeEach(() => {
  env.reset();
  settings.concentrationAutoRoll = true;
  game.users = [gm, player];
  game.modules.set("scorpious187s-lib", lib);
  game.user = gm;
  player.active = true;
});

function wizard({ owner = player, concentrating = true, rolls = [{ total: 14 }] } = {}) {
  return {
    name: "Wizard",
    concentration: { effects: new Set(concentrating ? [{}] : []) },
    testUserPermission: (u, level) => level === "OWNER" && (u.isGM || u === owner),
    calls: [],
    async rollConcentration(config, dialog) { this.calls.push({ config, dialog }); return rolls; }
  };
}
let seq = 0;
function prompt(actor, { dc = 12, ability, type = "prompt", author = gm, id = `msg${++seq}` } = {}) {
  const message = {
    id, type, speakerActor: actor, author, deleted: false,
    system: { buttons: [{ type: "concentration", dc, format: "short", ...(ability ? { ability } : {}) }] },
    canUserModify: (u) => u.isGM || u === author,
    async delete() { message.deleted = true; messages.delete(id); }
  };
  messages.set(id, message);
  return message;
}

test("reads dnd5e's concentration prompt button", () => {
  assert.deepEqual(concentrationButton(prompt(wizard(), { dc: 15, ability: "con" })), { dc: 15, ability: "con" });
  assert.equal(concentrationButton(prompt(wizard(), { type: "base" })), null);
  assert.equal(concentrationButton({ type: "prompt", system: { buttons: [{ type: "save", dc: 12 }] } }), null);
});

test("roller: the active player owner, else the primary GM", () => {
  assert.equal(concentrationRoller(wizard()).id, "p1");
  player.active = false;
  assert.equal(concentrationRoller(wizard()).id, "gm1");
  assert.equal(concentrationRoller(wizard({ owner: null })).id, "gm1");
});

test("the player's client rolls their character's check against the DC, without a dialog, then the card goes", async () => {
  const actor = wizard();
  game.user = player;
  const message = prompt(actor, { author: player });
  await onConcentrationPrompt(message);
  assert.deepEqual(actor.calls, [{ config: { target: 12, "scorpious187s-luck-dice-automation": { noDialog: true } }, dialog: { configure: false } }]);
  assert.equal(message.deleted, true);
});

test("the GM's client leaves an online player's character alone", async () => {
  const actor = wizard();
  await onConcentrationPrompt(prompt(actor));
  assert.equal(actor.calls.length, 0);
});

test("the GM rolls for NPCs and offline players, with the prompt's ability", async () => {
  const npc = wizard({ owner: null });
  const message = prompt(npc, { ability: "wis" });
  await onConcentrationPrompt(message);
  assert.deepEqual(npc.calls[0].config, { target: 12, ability: "wis", "scorpious187s-luck-dice-automation": { noDialog: true } });
  assert.equal(message.deleted, true);
});

test("each prompt is rolled once", async () => {
  const npc = wizard({ owner: null });
  const message = prompt(npc);
  await Promise.all([onConcentrationPrompt(message), onConcentrationPrompt(message)]);
  assert.equal(npc.calls.length, 1);
});

test("skipped: setting off, concentration disabled, no longer concentrating", async () => {
  for (const [setup, actor] of [
    [() => { settings.concentrationAutoRoll = false; }, wizard({ owner: null })],
    [() => { settings.dnd5e.disableConcentration = true; }, wizard({ owner: null })],
    [() => {}, wizard({ owner: null, concentrating: false })]
  ]) {
    env.reset(); settings.concentrationAutoRoll = true; setup();
    await onConcentrationPrompt(prompt(actor));
    assert.equal(actor.calls.length, 0);
  }
});

test("a cancelled roll keeps the prompt and its button", async () => {
  const npc = wizard({ owner: null, rolls: null });
  const message = prompt(npc);
  await onConcentrationPrompt(message);
  assert.equal(message.deleted, false);
});

test("a player who can't delete the GM's prompt asks the GM; the GM deletes only concentration prompts", async () => {
  const emitted = [];
  const shared = await import("../scripts/native/shared.mjs");
  shared.setSocket({ emit: (name, payload) => emitted.push([name, payload]) });
  try {
    game.user = player;
    const message = prompt(wizard());                        // authored by the GM
    await onConcentrationPrompt(message);
    assert.equal(message.deleted, false);
    assert.deepEqual(emitted, [["deleteConcentrationPrompt", { messageId: message.id }]]);

    game.user = gm;
    await deleteConcentrationPrompt({ messageId: message.id });
    assert.equal(message.deleted, true);
    const other = { id: "x", type: "base", system: {}, deleted: false, async delete() { this.deleted = true; } };
    messages.set("x", other);
    await deleteConcentrationPrompt({ messageId: "x" });
    assert.equal(other.deleted, false);
  } finally {
    shared.setSocket(null);
  }
});
