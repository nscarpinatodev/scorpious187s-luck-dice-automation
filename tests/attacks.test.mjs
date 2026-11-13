import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rollAttackDamage } from "../scripts/native/attacks.mjs";
import { isLike } from "../scripts/native/shared.mjs";

beforeEach(() => env.reset());

/** An attack activity whose damage rolls record their arguments. */
function attackActivity() {
  const act = { type: "attack", calls: [],
    async rollDamage(config, dialog, message) { act.calls.push({ config, dialog, message }); return [{ parent: { id: "dmg" } }]; } };
  return act;
}

test("attack automation's damage roll is linked to the use card, as dnd5e's damage button does", async () => {
  const act = attackActivity();
  const attack = { rolls: [{ isCritical: true, options: { originatingMessage: "use1" } }], system: { ability: "dex", mode: "oneHanded" } };
  assert.deepEqual(await rollAttackDamage(attack, act, { fastForward: true }), { id: "dmg" });
  const [{ config, dialog, message }] = act.calls;
  assert.deepEqual(message, { data: { system: { origin: "use1" } } });   // findAttackCard pairs them by this
  assert.equal(config.isCritical, true); assert.equal(config.ability, "dex"); assert.equal(dialog.configure, false);

  // The card's own stored origin when the roll doesn't carry it; nothing to link otherwise.
  await rollAttackDamage({ rolls: [{ options: {} }], system: { _source: { origin: "use2" } } }, act, { fastForward: false });
  assert.deepEqual(act.calls[1].message, { data: { system: { origin: "use2" } } });
  await rollAttackDamage({ rolls: [{ options: {} }], system: {} }, act, { fastForward: false });
  assert.deepEqual(act.calls[2].message, {});
});

test("isLike: dnd5e 6.1's own answer where the activity has one, else its type", () => {
  const homebrew = { type: "spell-strike", isLike: (t) => t === "spell-strike" || t === "attack" };
  assert.equal(isLike(homebrew, "attack"), true);
  assert.equal(isLike(homebrew, "save"), false);
  assert.equal(isLike({ type: "attack" }, "attack"), true);   // dnd5e 6.0: no isLike
  assert.equal(isLike({ type: "save" }, "attack"), false);
  assert.equal(isLike(null, "attack"), false);
});
