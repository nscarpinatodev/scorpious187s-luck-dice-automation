import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { trackedActors, poolState, startSession, awardLuckDie, DiceTracker, SESSION_LUCK_DICE } from "../scripts/dice-tracker.mjs";

beforeEach(() => env.reset());

/** A character with optional Luck / Impact Dice items: [available, max]. */
function character(name, { luck, impact, type = "character", player = true } = {}) {
  const items = [];
  const pool = (itemName, [available, max]) => items.push({ name: itemName, system: { uses: { max, spent: max - available } } });
  if (luck) pool("Luck Dice", luck);
  if (impact) pool("Impact Dice", impact);
  const actor = { id: name.toLowerCase(), name, img: `${name}.webp`, type, hasPlayerOwner: player, items,
    testUserPermission: () => false };
  game.actors.push(actor);
  return actor;
}
const luckOf = (actor) => poolState(actor, "luck").value;

test("tracks player-owned characters only, by name", () => {
  character("Zed", { luck: [1, 6] });
  character("Ann", { luck: [2, 6] });
  character("Goblin", { type: "npc" });
  character("Sidekick", { player: false });
  assert.deepEqual(trackedActors().map(a => a.name), ["Ann", "Zed"]);
});

test("pool state: remaining / max, or missing", () => {
  const a = character("Ann", { luck: [2, 6], impact: [0, 2] });
  assert.deepEqual(poolState(a, "luck"), { has: true, value: 2, max: 6 });
  assert.deepEqual(poolState(a, "impact"), { has: true, value: 0, max: 2 });
  assert.deepEqual(poolState(character("Bo"), "luck"), { has: false, value: 0, max: 0 });
});

test(`starting a session tops Luck Dice up to ${SESSION_LUCK_DICE}, keeps banked dice, leaves Impact Dice`, async () => {
  const low = character("Low", { luck: [1, 6], impact: [1, 2] });
  const banked = character("Banked", { luck: [5, 6] });
  const small = character("Small", { luck: [0, 2] });          // max below 3: up to its max
  character("None");
  const changed = await startSession();
  assert.deepEqual(changed, [{ name: "Low", from: 1, to: 3 }, { name: "Small", from: 0, to: 2 }]);
  assert.equal(luckOf(low), 3); assert.equal(luckOf(banked), 5); assert.equal(luckOf(small), 2);
  assert.equal(poolState(low, "impact").value, 1);
});

test("+1 Luck Die to all stops at each max", async () => {
  const a = character("A", { luck: [2, 6] });
  const full = character("Full", { luck: [6, 6] });
  assert.deepEqual(await awardLuckDie(), ["A"]);
  assert.equal(luckOf(a), 3); assert.equal(luckOf(full), 6);
});

test("the window lists pools with −/+ disabled at the limits, or a dash without the item", async () => {
  character("Ann", { luck: [0, 6], impact: [2, 2] });
  character("Bo");
  const app = new DiceTracker();
  const element = await app._renderHTML(await app._prepareContext());
  const html = element.firstElementChild.html;
  assert.match(html, /Ann[\s\S]*0 \/ 6[\s\S]*2 \/ 2/);
  assert.match(html, /data-pool="luck" data-delta="-1" disabled/);
  assert.match(html, /data-pool="impact" data-delta="1" disabled/);
  assert.match(html, /No Luck Dice item/);
  assert.match(html, /Start Session/);
});

test("only the GM opens it", () => {
  game.user.isGM = false;
  assert.equal(DiceTracker.open(), null);
});
