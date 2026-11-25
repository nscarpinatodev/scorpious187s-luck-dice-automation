// Persistent damage: the effect, the prompt, and the damage at the start of the creature's turn.
import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PERSISTENT, cleanFormula, persistentEffect, persistentName, persistentOf, onPersistentCreated, onTurnStartPersistent, persistentDamage } from "../scripts/native/persistent.mjs";

const { settings, makeToken, dialogs, notes, scene } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

// This window has text inputs, which the shared fake dialog doesn't read: a stub that hands the config to the test.
foundry.applications.api.DialogV2 = { wait: async (config) => { const handler = dialogs.shift(); if (!handler) throw new Error("unexpected dialog"); return handler({ config }); } };

beforeEach(() => {
  env.reset();
  settings.persistentDamage = true;
  CONFIG.DND5E.damageTypes = { fire: { label: "Fire" }, acid: { label: "Acid" } };
  canvas.tokens.controlled = [];
});

let seq = 0;
function creature(name, { statuses = [] } = {}) {
  const token = makeToken(`${name}${++seq}`, name);
  const d = token.document;
  const actor = d.actor;
  Object.assign(actor, { name, isOwner: true, statuses: new Set(statuses), effects: [],
    async createEmbeddedDocuments(_t, data) { actor.effects.push(...data.map(live)); return data; } });
  return { token, doc: d, actor };
}
/** Effect data as a live effect: its flags read through getFlag. */
const live = (data) => ({ ...data, disabled: !!data.disabled, statuses: new Set(data.statuses ?? []), getFlag: (m, k) => data.flags?.[m]?.[k] });
/** Answers the Persistent Damage window. */
const answer = (formula, type = "fire", label = "") => async ({ config }) => config.buttons.find(b => b.action === "ok").callback(null, {
  form: { querySelector: (q) => ({ value: q.includes("formula") ? formula : q.includes("type") ? type : label }) } });

test("the amount: a flat number or a dice formula; nothing else", () => {
  assert.equal(cleanFormula(" 5 "), "5");
  assert.equal(cleanFormula("1d6+2"), "1d6+2");
  assert.equal(cleanFormula("0"), null);
  assert.equal(cleanFormula(""), null);
  assert.equal(cleanFormula("lots"), null);
});

test("the effect carries the status, the amount and the type; its name says what it deals", () => {
  const data = persistentEffect({ formula: "1d6", type: "fire", label: "Burning" });
  assert.equal(data.name, "Burning (1d6 Fire)");
  assert.deepEqual(data.statuses, [PERSISTENT]);
  assert.deepEqual(persistentOf(live(data)), { formula: "1d6", type: "fire", label: "Burning" });
  assert.equal(persistentName({ formula: "5", type: "acid", label: "" }), "Persistent Damage (5 Acid)");
  assert.equal(persistentOf(live({ ...data, disabled: true })), null);
  assert.equal(persistentOf(live({ statuses: [PERSISTENT] })), null);         // turned on, not set up yet
});

test("the status turned on from the token HUD asks what it deals; cancelled, it comes off", async () => {
  const orc = creature("Orc");
  const made = (extra = {}) => ({ parent: orc.actor, statuses: new Set([PERSISTENT]), getFlag: () => undefined, updated: null, deleted: false,
    async update(u) { this.updated = u; }, async delete() { this.deleted = true; }, ...extra });
  const effect = made();
  dialogs.push(answer("2d4", "acid", "Acid Burn"));
  await onPersistentCreated(effect, {}, game.user.id);
  assert.equal(effect.updated.name, "Acid Burn (2d4 Acid)");
  assert.deepEqual(effect.updated[`flags.${MODULE_ID}.${PERSISTENT}`], { formula: "2d4", type: "acid", label: "Acid Burn" });

  const cancelled = made();
  dialogs.push(async ({ config }) => config.buttons.find(b => b.action === "cancel").callback());
  await onPersistentCreated(cancelled, {}, game.user.id);
  assert.equal(cancelled.deleted, true);

  const others = made();                                                      // someone else's client made it: they're asked
  await onPersistentCreated(others, {}, "another-user");
  assert.equal(others.updated, null);
  const ready = made({ getFlag: () => ({ formula: "5", type: "fire" }) });    // made with its damage: nothing to ask
  await onPersistentCreated(ready, {}, game.user.id);
  assert.equal(ready.updated, null);
});

test("a bad amount is asked for again", async () => {
  const orc = creature("Orc");
  const effect = { parent: orc.actor, statuses: new Set([PERSISTENT]), getFlag: () => undefined, async update(u) { this.updated = u; }, async delete() {} };
  dialogs.push(answer("lots"), answer("3"));
  await onPersistentCreated(effect, {}, game.user.id);
  assert.equal(effect.updated.name, "Persistent Damage (3 Fire)");
  assert.ok(notes.some(n => /needs a number or a dice formula/.test(n)));
});

test("LDA.persistentDamage: asked once, on every selected token; each call adds another", async () => {
  const a = creature("A"), b = creature("B");
  canvas.tokens.controlled = [a.token, b.token];
  dialogs.push(answer("1d6"));
  assert.deepEqual(await persistentDamage(), [a.doc.name, b.doc.name]);
  dialogs.push(answer("2", "acid"));
  await persistentDamage();
  assert.deepEqual(a.actor.effects.map(e => e.name), ["Persistent Damage (1d6 Fire)", "Persistent Damage (2 Acid)"]);
  canvas.tokens.controlled = [];
  assert.deepEqual(await persistentDamage(), []);
  assert.ok(notes.some(n => /select or target/.test(n)));
});

test("at the start of the creature's turn each effect deals its damage — in combat, on the GM's client, with the setting", async () => {
  const orc = creature("Orc");
  orc.actor.effects.push(live(persistentEffect({ formula: "1d6", type: "fire" })), live(persistentEffect({ formula: "2", type: "acid", label: "Acid" })),
    live({ name: "Blessed", flags: {} }));
  const dealt = [];
  const deal = async (tokenDoc, data) => dealt.push(`${tokenDoc.name}:${data.formula}:${data.type}`);
  const combat = { started: true, scene };
  const turn = (opts = {}) => onTurnStartPersistent(combat, { tokenId: orc.doc.id }, { deal, ...opts });
  await turn();
  assert.deepEqual(dealt, [`${orc.doc.name}:1d6:fire`, `${orc.doc.name}:2:acid`]);
  dealt.length = 0;
  await turn({ isTrigger: () => false });
  await onTurnStartPersistent({ started: false, scene }, { tokenId: orc.doc.id }, { deal });
  settings.persistentDamage = false;
  await turn();
  settings.persistentDamage = true;
  orc.actor.statuses.add("dead");
  await turn();
  assert.deepEqual(dealt, []);
});
