import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eligibleRiders, addOnHitRiders, claimRiderUse, spendsSomething, RIDERS } from "../scripts/native/riders.mjs";

const { settings, dialogs, uuids, damageRoll, makeToken } = env;
beforeEach(() => { env.reset(); settings.onHitRiders = true; game.combat = null; });

/** A damage activity whose rolls (and critical flag) are recorded. */
function damageActivity(name, total, { spellSlot, onUse } = {}) {
  const act = {
    type: "damage", name, consumption: { targets: [], ...(spellSlot === undefined ? {} : { spellSlot }) }, rolled: [],
    async rollDamage(config, dialog, message) {
      act.rolled.push({ config, dialog, message });
      return [Object.assign(damageRoll(total), { formula: `${name}-formula` })];
    },
    async use() { act.used = (act.used ?? 0) + 1; return onUse ? onUse(act) : null; }
  };
  return act;
}
function riderItem(actorUuid, identifier, activities, { type = "feat", level = 0, name = identifier } = {}) {
  const item = { id: identifier, name, type, uuid: `${actorUuid}.Item.${identifier}`, system: { identifier, level, activities: new Map(activities.map((a, i) => [String(i), a])) } };
  activities.forEach(a => { a.item = item; });
  return item;
}
function attacker(items) {
  const actor = { uuid: "Actor.rogue", name: "Rogue", items };
  return actor;
}
function target(id, { type = "humanoid", effects = [] } = {}) {
  const actor = { uuid: `Actor.${id}`, name: id, effects, system: { details: { type: { value: type } } } };
  uuids.set(`Token.${id}`, { actor });
  return { actor: actor.uuid, token: `Token.${id}`, name: id };
}
function weaponAttack(actor, { finesse = false, range = "melee", mode } = {}) {
  return { type: "attack", actor, attack: { type: { value: range, classification: "weapon" } },
    item: { type: "weapon", system: { properties: new Set(finesse ? ["fin"] : []) } } };
}
// Rolled with advantage unless told otherwise (Sneak Attack's usual way in).
const attackCard = (targets, { crit = false, mode, advantageMode = 1 } = {}) => ({
  rolls: [{ isCritical: crit, options: { advantageMode } }], system: { mode, evaluatedTargets: targets.map(t => ({ ...t, isMiss: false })) }
});
function damageCard() {
  const message = { rolls: [damageRoll(6)], flags: {}, getFlag: (_m, k) => message.flags[k],
    async update(u) { message.rolls = u.rolls; for (const [k, v] of Object.entries(u)) if (k.startsWith("flags.")) message.flags[k.split(".").pop()] = v; } };
  return message;
}
const names = (riders) => riders.map(r => r.identifier);

test("Sneak Attack: finesse or ranged weapons only", async () => {
  const sneak = riderItem("Actor.rogue", "sneak-attack", [damageActivity("Sneak", 10)]);
  const rogue = attacker([sneak]);
  const t = [target("goblin")];
  assert.deepEqual(names(await eligibleRiders(weaponAttack(rogue, { finesse: true }), attackCard(t))), ["sneak-attack"]);
  assert.deepEqual(names(await eligibleRiders(weaponAttack(rogue, { range: "ranged" }), attackCard(t))), ["sneak-attack"]);
  assert.deepEqual(names(await eligibleRiders(weaponAttack(rogue), attackCard(t))), []);
  assert.deepEqual(names(await eligibleRiders(weaponAttack(rogue), attackCard(t, { mode: "thrown" }))), ["sneak-attack"]);
});

test("marks: only when every target hit carries this caster's mark", async () => {
  const mark = riderItem("Actor.rogue", "hunters-mark", [damageActivity("Bonus Mark Damage", 4, { spellSlot: false })], { type: "spell", level: 1 });
  const rogue = attacker([mark]);
  const marked = target("marked", { effects: [{ system: { origin: { activity: `${mark.uuid}.Activity.x` } } }] });
  const other  = target("other", { effects: [{ system: { origin: { item: "Actor.someoneElse.Item.hunters-mark" } } }] });
  const viaSource = target("copied", { effects: [{ _stats: { duplicateSource: `${mark.uuid}.ActiveEffect.e` } }] });
  const disabled  = target("off", { effects: [{ disabled: true, system: { origin: { item: mark.uuid } } }] });
  const atk = weaponAttack(rogue);
  assert.deepEqual(names(await eligibleRiders(atk, attackCard([marked]))), ["hunters-mark"]);
  assert.deepEqual(names(await eligibleRiders(atk, attackCard([viaSource]))), ["hunters-mark"]);
  assert.deepEqual(names(await eligibleRiders(atk, attackCard([other]))), []);
  assert.deepEqual(names(await eligibleRiders(atk, attackCard([disabled]))), []);
  assert.deepEqual(names(await eligibleRiders(atk, attackCard([marked, other]))), []);
  assert.equal(spendsSomething({ item: mark, rider: RIDERS["hunters-mark"], activities: [...mark.system.activities.values()] }), false);
});

test("Divine Smite: melee only; the unholy version against fiends and undead", async () => {
  const base = damageActivity("Cast", 9), unholy = damageActivity("Unholy Creature Damage", 13);
  const smite = riderItem("Actor.rogue", "divine-smite", [unholy, base], { type: "spell", level: 1 });
  const pal = attacker([smite]);
  const [humanoid] = await eligibleRiders(weaponAttack(pal), attackCard([target("bandit")]));
  assert.equal(humanoid.activities[0], base);
  const [fiend] = await eligibleRiders(weaponAttack(pal), attackCard([target("imp", { type: "fiend" })]));
  assert.equal(fiend.activities[0], unholy);
  assert.deepEqual(names(await eligibleRiders(weaponAttack(pal, { range: "ranged" }), attackCard([target("x")]))), []);
  // 2014 feature: a second activity adds its dice.
  const extra = damageActivity("", 4), first = damageActivity("", 9);
  const legacy = riderItem("Actor.rogue", "divine-smite", [first, extra]);
  const [vsUndead] = await eligibleRiders(weaponAttack(attacker([legacy])), attackCard([target("zombie", { type: "undead" })]));
  assert.deepEqual(vsUndead.activities, [first, extra]);
});

test("marks are added without asking; chosen riders are checkboxes; dice join the card as critical", async () => {
  const sneakAct = damageActivity("Sneak", 10);
  const sneak = riderItem("Actor.rogue", "sneak-attack", [sneakAct]);
  const markAct = damageActivity("Bonus Mark Damage", 4, { spellSlot: false });
  const mark = riderItem("Actor.rogue", "hunters-mark", [markAct], { type: "spell", level: 1 });
  const rogue = attacker([sneak, mark]);
  const t = target("goblin", { effects: [{ system: { origin: { item: mark.uuid } } }] });
  dialogs.push(async (ui) => {
    assert.match(ui.config.content, /critical/);
    assert.match(ui.config.content, /value="0" checked> sneak-attack/);
    assert.match(ui.config.content, /Added: hunters-mark/);
    return "ok";
  });
  const message = damageCard();
  await addOnHitRiders(message, weaponAttack(rogue, { finesse: true }), attackCard([t], { crit: true }));
  assert.equal(markAct.rolled[0].config.isCritical, true);
  assert.deepEqual(markAct.rolled[0].message, { create: false });
  assert.equal(sneakAct.rolled.length, 1);
  assert.deepEqual(message.rolls.map(r => r.total), [6, 4, 10]);
  assert.deepEqual(message.flags.riders.map(r => [r.name, r.total]), [["hunters-mark", 4], ["sneak-attack", 10]]);

  // Once on the card: not again.
  await addOnHitRiders(message, weaponAttack(rogue, { finesse: true }), attackCard([t]));
  assert.equal(sneakAct.rolled.length, 1);
});

test("choosing none adds nothing; the setting off does nothing", async () => {
  const sneakAct = damageActivity("Sneak", 10);
  const rogue = attacker([riderItem("Actor.rogue", "sneak-attack", [sneakAct])]);
  dialogs.push(async () => "skip");
  const message = damageCard();
  await addOnHitRiders(message, weaponAttack(rogue, { finesse: true }), attackCard([target("g")]));
  assert.equal(sneakAct.rolled.length, 0);
  assert.equal(message.rolls.length, 1);
  settings.onHitRiders = false;
  await addOnHitRiders(message, weaponAttack(rogue, { finesse: true }), attackCard([target("g")]));
  assert.equal(dialogs.length, 0);
});

test("Sneak Attack once per turn in combat", async () => {
  game.combat = { started: true, id: "c1", round: 1, turn: 0 };
  const sneakAct = damageActivity("Sneak", 10);
  const rogue = attacker([riderItem("Actor.rogue", "sneak-attack", [sneakAct])]);
  const atk = weaponAttack(rogue, { finesse: true });
  dialogs.push(async () => "ok");
  await addOnHitRiders(damageCard(), atk, attackCard([target("g")]));
  assert.equal(sneakAct.rolled.length, 1);
  assert.deepEqual(names(await eligibleRiders(atk, attackCard([target("g")]))), []);    // same turn
  game.combat.turn = 1;
  assert.deepEqual(names(await eligibleRiders(atk, attackCard([target("g")]))), ["sneak-attack"]);
});

test("a rider that spends a slot is used through dnd5e; its scaled activity rolls; cancelling adds nothing", async () => {
  const scaled = damageActivity("Cast (3rd level)", 18);
  const cast = damageActivity("Cast", 9);
  // dnd5e's use: spends the slot, then postUseActivity hands over the scaled activity.
  cast.use = async () => {
    const config = {};
    assert.equal(claimRiderUse(Object.assign(scaled, { item: cast.item }), config), true);
    assert.equal(config.subsequentActions, false);
    return { message: {} };
  };
  const smite = riderItem("Actor.pal", "divine-smite", [cast], { type: "spell", level: 1 });
  const pal = attacker([smite]);
  // Divine Smite is unchecked by default: tick it.
  const tick = async (ui) => { assert.match(ui.config.content, /spends a resource/); assert.equal(ui.checkboxes[0].checked, false); ui.check(0); return "ok"; };
  dialogs.push(tick, tick);
  try {
    const message = damageCard();
    await addOnHitRiders(message, weaponAttack(pal), attackCard([target("bandit")]));
    assert.equal(scaled.rolled.length, 1);
    assert.equal(cast.rolled.length, 0);
    assert.deepEqual(message.flags.riders.map(r => r.total), [18]);

    // Cancelled use: nothing rolled.
    cast.use = async () => null;
    const second = damageCard();
    await addOnHitRiders(second, weaponAttack(pal), attackCard([target("bandit2")]));
    assert.equal(second.rolls.length, 1);
    assert.equal(claimRiderUse({ item: smite }, {}), false);   // nothing left pending
  } finally {
    dialogs.length = 0;
  }
});

test("Sneak Attack needs advantage or an ally beside the target, and never disadvantage", async () => {
  const sneak = riderItem("Actor.rogue", "sneak-attack", [damageActivity("Sneak", 10)]);
  const rogueToken = makeToken("rogue", "Rogue", { disposition: 1 });
  const goblinToken = makeToken("goblin", "Goblin", { disposition: -1 });
  const place = (token, col) => Object.assign(token.document, { x: col * 100, y: 0, elevation: 0, width: 1, height: 1,
    getOccupiedGridSpaceOffsets: () => [{ i: 0, j: col }] });
  place(rogueToken, 0); place(goblinToken, 5);
  canvas.grid = { isGridless: false, distance: 5, size: 100, getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
    measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5 }) };
  const rogue = attacker([sneak]);
  const atk = { ...weaponAttack(rogue, { range: "ranged" }), getUsageToken: () => rogueToken.document };
  const hit = { actor: goblinToken.document.actor.uuid, token: goblinToken.document.uuid, name: "Goblin" };
  const offered = async (advantageMode) => names(await eligibleRiders(atk, attackCard([hit], { advantageMode })));

  assert.deepEqual(await offered(1), ["sneak-attack"]);        // advantage
  assert.deepEqual(await offered(0), []);                      // normal, no ally
  const ally = makeToken("ally", "Fighter", { disposition: 1 });
  place(ally, 4);                                              // beside the goblin
  assert.deepEqual(await offered(0), ["sneak-attack"]);
  assert.deepEqual(await offered(-1), []);                     // disadvantage: never
  ally.document.actor.statuses = new Set(["unconscious"]);
  assert.deepEqual(await offered(0), []);                      // an incapacitated ally doesn't count
});
