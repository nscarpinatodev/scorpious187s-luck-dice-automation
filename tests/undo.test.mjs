import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { undoAppliedDamage, undoAppliedEffects } from "../scripts/native/undo.mjs";
import { renderAppliedSection, renderAppliedEffectsSection, undoneLabel, wireUndo } from "../scripts/native/cards.mjs";

const { uuids } = env;
beforeEach(() => env.reset());

function card() {
  const flags = {};
  return { flags, getFlag: (_m, k) => flags[k], setFlag: async (_m, k, v) => { flags[k] = structuredClone(v); } };
}
function actor(uuid, value, max = 50) {
  const a = {
    uuid, system: { _source: { attributes: { hp: { value, temp: 0, tempmax: 0 } } }, attributes: { hp: { max } } },
    async update(u) {
      const hp = a.system._source.attributes.hp;
      hp.value = u["system.attributes.hp.value"]; hp.temp = u["system.attributes.hp.temp"]; hp.tempmax = u["system.attributes.hp.tempmax"];
    }
  };
  uuids.set(uuid, a);
  return a;
}
const hpOf = (a) => a.system._source.attributes.hp.value;
const html = (block) => block.html;

test("undo adds the delta back: later damage stays, clamped to max", async () => {
  const a = actor("Actor.a", 20);                      // took 10 from us, then 5 more elsewhere
  const message = card();
  message.flags.appliedDamage = [{ name: "A", actor: "Actor.a", amount: 10, hp: { value: 10, temp: 0, tempmax: 0 } }];
  await undoAppliedDamage(message);
  assert.equal(hpOf(a), 30);
  const healed = actor("Actor.h", 48);
  message.flags.appliedDamage = [{ name: "H", actor: "Actor.h", amount: 10, hp: { value: 10, temp: 0, tempmax: 0 } }];
  await undoAppliedDamage(message);
  assert.equal(hpOf(healed), 50);
});

test("one target, then the rest; labels and buttons follow", async () => {
  const a = actor("Actor.a", 30), b = actor("Actor.b", 40);
  const message = card();
  message.flags.appliedDamage = [
    { name: "A", actor: "Actor.a", amount: 10, hp: { value: 10, temp: 0, tempmax: 0 } },
    { name: "B", actor: "Actor.b", amount: 5, saved: true, hp: { value: 5, temp: 0, tempmax: 0 } }
  ];
  let row = html(renderAppliedSection(message.flags.appliedDamage));
  assert.match(row, /data-lda-undo-index="0"/); assert.match(row, /data-lda-undo-index="1"/); assert.match(row, /Undo All/);

  await undoAppliedDamage(message, 1);
  assert.equal(hpOf(b), 45); assert.equal(hpOf(a), 30);
  assert.equal(undoneLabel(message.flags.appliedDamage), " (partly undone)");
  row = html(renderAppliedSection(message.flags.appliedDamage));
  assert.match(row, /Applied \(partly undone\)/);
  assert.doesNotMatch(row, /data-lda-undo-index="1"/);

  await undoAppliedDamage(message, 1);                  // again: nothing
  assert.equal(hpOf(b), 45);
  await undoAppliedDamage(message);                     // the rest
  assert.equal(hpOf(a), 40);
  assert.equal(undoneLabel(message.flags.appliedDamage), " (undone)");
  assert.doesNotMatch(html(renderAppliedSection(message.flags.appliedDamage)), /lda-undo/);
});

test("single target: plain Undo; players see no buttons", () => {
  const applied = [{ name: "A", actor: "Actor.a", amount: 3, hp: { value: 3, temp: 0, tempmax: 0 } }];
  const row = html(renderAppliedSection(applied));
  assert.doesNotMatch(row, /data-lda-undo-index/); assert.match(row, /> Undo<\/button>/);
  game.user.isGM = false;
  assert.doesNotMatch(html(renderAppliedSection(applied)), /lda-undo/);
});

test("effects: created ones deleted, re-enabled ones disabled, per target or all", async () => {
  const effect = (uuid, disabled = false) => {
    const e = { uuid, disabled, async delete() { uuids.delete(uuid); }, async update(u) { Object.assign(e, u); } };
    uuids.set(uuid, e);
    return e;
  };
  effect("E.a"); effect("E.b1"); const reenabled = effect("E.b2");
  const message = card();
  message.flags.appliedEffects = [
    { name: "A", effects: ["Paralyzed"], undo: [{ effect: "E.a", action: "create" }] },
    { name: "B", effects: ["Paralyzed", "Prone"], undo: [{ effect: "E.b1", action: "create" }, { effect: "E.b2", action: "enable" }] }
  ];
  assert.match(html(renderAppliedEffectsSection(message.flags.appliedEffects)), /Undo All/);
  await undoAppliedEffects(message, 0);
  assert.equal(uuids.has("E.a"), false); assert.equal(uuids.has("E.b1"), true);
  assert.match(html(renderAppliedEffectsSection(message.flags.appliedEffects)), /Effects \(partly undone\)/);
  await undoAppliedEffects(message);
  assert.equal(uuids.has("E.b1"), false); assert.equal(reenabled.disabled, true);
});

test("wireUndo passes the index (null for the row), disables all while running, re-enables on failure", async () => {
  const button = (index) => {
    const b = { dataset: index === undefined ? {} : { ldaUndoIndex: String(index) }, disabled: false, fns: [] };
    b.addEventListener = (_t, fn) => b.fns.push(fn);
    b.click = () => Promise.all(b.fns.map(fn => fn({ preventDefault() {} })));
    return b;
  };
  const buttons = [button(0), button(1), button()];
  const calls = [];
  wireUndo({ querySelectorAll: () => buttons }, async (i) => { calls.push(i); assert.ok(buttons.every(b => b.disabled)); });
  await buttons[1].click(); await buttons[2].click();
  assert.deepEqual(calls, [1, null]);

  const failing = [button(0)];
  const error = console.error; console.error = () => {};
  try {
    wireUndo({ querySelectorAll: () => failing }, async () => { throw new Error("boom"); });
    await failing[0].click();
  } finally { console.error = error; }
  assert.equal(failing[0].disabled, false);
});
