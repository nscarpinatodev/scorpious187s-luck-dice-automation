import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isMagical, antimagicStops, inAntimagic } from "../scripts/native/shared.mjs";
import { applyCardDamage } from "../scripts/native/apply.mjs";
import { reactionOptions, tombEffect } from "../scripts/native/reactions.mjs";
import { eligibleRiders } from "../scripts/native/riders.mjs";
import { rollExtras } from "../scripts/native/boosts.mjs";
import { masteryEffect } from "../scripts/native/mastery.mjs";

const { settings, messages, uuids, damageRoll } = env;
beforeEach(() => { env.reset(); game.combat = null; });

const spell = (identifier, level = 1) => ({ type: "spell", name: identifier, system: { identifier, level, properties: new Set() } });
const feat = (identifier, { magical = false } = {}) => ({ type: "feat", name: identifier, system: { identifier, properties: new Set(magical ? ["mgc"] : []) } });
const weapon = (magical = false) => ({ type: "weapon", name: "Sword", system: { identifier: "longsword", properties: new Set(magical ? ["mgc"] : []) } });
const creature = (name, { antimagic = false, items = [] } = {}) => ({
  uuid: `Actor.${name}`, name, items, statuses: new Set(antimagic ? ["antimagic"] : []),
  system: { attributes: { prof: 3 }, spells: { spell1: { value: 2 } } }
});

test("magic and antimagic: spells and Magical features, not weapons; only for creatures in it", () => {
  assert.equal(isMagical(spell("fireball")), true);
  assert.equal(isMagical(feat("eldritch-smite", { magical: true })), true);
  assert.equal(isMagical(feat("sneak-attack")), false);
  assert.equal(isMagical(weapon(true)), false);             // a +1 sword's strike still lands
  const inside = creature("In", { antimagic: true }), outside = creature("Out");
  assert.equal(inAntimagic(inside), true);
  assert.equal(antimagicStops(inside, { item: spell("fireball") }), true);           // an activity
  assert.equal(antimagicStops(inside, { documentName: "Item", ...spell("shield") }), true); // an item
  assert.equal(antimagicStops(inside, { item: weapon(true) }), false);
  assert.equal(antimagicStops(outside, { item: spell("fireball") }), false);
});

function hpActor(name, { antimagic = false } = {}) {
  const actor = { ...creature(name, { antimagic }), seen: [],
    system: { _source: { attributes: { hp: { value: 50, temp: 0, tempmax: 0 } } } },
    calculateDamage: (d) => ({ amount: d.reduce((s, x) => s + x.value, 0) }),
    async applyDamage(d) { actor.seen.push(d.reduce((s, x) => s + x.value, 0)); actor.system._source.attributes.hp.value -= actor.seen.at(-1); } };
  uuids.set(`Token.${name}`, { actor });
  return actor;
}
function card(id, item) {
  const message = { id, rolls: [damageRoll(10)], flags: {}, getAssociatedItem: () => item, setFlag: async (_m, k, v) => { message.flags[k] = v; } };
  messages.set(id, message);
  return message;
}

test("damage: a spell's leaves out a creature in antimagic (noted); a weapon's still lands", async () => {
  const inside = hpActor("in", { antimagic: true }), outside = hpActor("out");
  const fire = card("m1", spell("fireball", 3));
  await applyCardDamage({ messageId: "m1", targets: [{ token: "Token.in", name: "In" }, { token: "Token.out", name: "Out" }] });
  assert.deepEqual(inside.seen, []);
  assert.deepEqual(outside.seen, [10]);
  assert.deepEqual(fire.flags.appliedDamage.map(e => [e.name, e.amount, e.reactions ?? null, !!e.hp]),
    [["In", 0, ["antimagic"], false], ["Out", 10, null, true]]);   // nothing to undo for the one left out

  card("m2", weapon(true));
  await applyCardDamage({ messageId: "m2", targets: [{ token: "Token.in", name: "In" }] });
  assert.deepEqual(inside.seen, [10]);
});

test("reactions: no spell or Magical feature in antimagic; others still offered", () => {
  const items = [spell("shield"), feat("uncanny-dodge")];
  const hit = { total: 16, ac: 15, critical: false };
  assert.deepEqual(reactionOptions(creature("Out", { items }), hit, "hit"), ["shield", "uncanny-dodge"]);
  assert.deepEqual(reactionOptions(creature("In", { items, antimagic: true }), hit, "hit"), ["uncanny-dodge"]);
});

test("riders: Divine Smite (a spell) isn't offered in antimagic; Sneak Attack is", async () => {
  settings.onHitRiders = true;
  const smiteAct = { type: "damage", consumption: { targets: [] } }, sneakAct = { type: "damage", consumption: { targets: [] } };
  const smite = { ...spell("divine-smite"), id: "s", uuid: "Actor.p.Item.s", system: { ...spell("divine-smite").system, activities: new Map([["0", smiteAct]]) } };
  const sneak = { ...feat("sneak-attack"), id: "k", uuid: "Actor.p.Item.k", system: { ...feat("sneak-attack").system, activities: new Map([["0", sneakAct]]) } };
  const attacker = creature("P", { antimagic: true, items: [smite, sneak] });
  uuids.set("Token.g", { actor: { uuid: "Actor.g", name: "g", effects: [], system: { details: { type: { value: "humanoid" } } } } });
  const activity = { type: "attack", actor: attacker, attack: { type: { value: "melee", classification: "weapon" } },
    item: { type: "weapon", system: { properties: new Set(["fin"]) } } };
  const attack = { rolls: [{ options: { advantageMode: 1 } }], system: { evaluatedTargets: [{ token: "Token.g", actor: "Actor.g", isMiss: false }] } };
  assert.deepEqual((await eligibleRiders(activity, attack)).map(r => r.identifier), ["sneak-attack"]);
  attacker.statuses.clear();
  assert.deepEqual((await eligibleRiders(activity, attack)).map(r => r.identifier), ["divine-smite", "sneak-attack"]);
});

test("boosts: a Magical invocation (Protection of the Talisman) isn't offered in antimagic", () => {
  settings.invocations = true;
  const talisman = feat("protection-of-the-talisman", { magical: true });
  assert.ok(rollExtras(creature("Out", { items: [talisman] }), "save")?.options().some(o => o.action === "boost:talisman"));
  assert.equal(rollExtras(creature("In", { items: [talisman], antimagic: true }), "save"), null);
});

test("the module's magical effects are marked magical, so dnd5e 6.1 suppresses them in antimagic", () => {
  assert.equal(tombEffect().system.magical, true);
  const attacker = { uuid: "Actor.w" };
  assert.equal(masteryEffect("lethargy", attacker, "Token.t", { name: "Lance of Lethargy", magical: true }).system.magical, true);
  assert.equal("magical" in masteryEffect("slow", attacker, "Token.t", { name: "Slowed" }).system, false);
});
