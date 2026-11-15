// Tactical Mind, Stroke of Luck, Toll the Dead, Empowered Evocation, Great Weapon Master, Sundering Blow, Aura of Courage, Arcane Ward.
import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { boostsFor } from "../scripts/native/boosts.mjs";
import { onPreRollDamageFeatures, onFeatureUsed, auraOfCourage, arcaneWard, onPreApplyDamageWard } from "../scripts/native/features.mjs";
import { attackReasons } from "../scripts/native/advantage.mjs";
import { RIDERS } from "../scripts/native/riders.mjs";

const { settings, makeToken, uuids, rollResults } = env;

canvas.grid = {
  isGridless: false, distance: 5, size: 100, units: "ft",
  getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
  measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5 })
};
CONFIG.Canvas = { polygonBackends: { sight: { testCollision: () => false }, move: { testCollision: () => false } } };

beforeEach(() => {
  env.reset();
  game.combat = null;
  game.modules.delete("automated-conditions-5e");
});

let seq = 0;
const item = (identifier, { rules = "2024", uses = null, type = "feat", extra = {} } = {}) => {
  const it = { name: identifier, type, uuid: `Actor.x.Item.${identifier}${++seq}`, documentName: "Item",
    system: { identifier, source: { rules }, ...(uses ? { uses: { max: uses, spent: 0 } } : {}), ...extra },
    async update(u) { if ("system.uses.spent" in u) it.system.uses.spent = u["system.uses.spent"]; } };
  uuids.set(it.uuid, it);
  return it;
};
function creature(name, col, row = 0, { disposition = -1, items = [], hp = 20, max = 20, statuses = [] } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const d = token.document;
  Object.assign(d, { x: col * 100, y: row * 100, elevation: 0, width: 1, height: 1, isOwner: true, getOccupiedGridSpaceOffsets: () => [{ i: row, j: col }] });
  const actor = d.actor;
  Object.assign(actor, { name, documentName: "Actor", isOwner: true, statuses: new Set(statuses), items, effects: [],
    system: { attributes: { prof: 3, hp: { value: hp, max, temp: 0 } }, abilities: { int: { mod: 4 } } }, getActiveTokens: () => [d] });
  uuids.set(actor.uuid, actor);
  return { token, doc: d, actor };
}

// ── Roll extras ──
test("Tactical Mind: +1d10 to a failed check, spending a Second Wind use only if that makes it succeed", async () => {
  settings.rollBoosts = true;
  const wind = item("second-wind", { uses: 2 });
  const fighter = { items: [item("tactical-mind"), wind], effects: [], statuses: new Set() };
  const tactical = () => boostsFor(fighter, "check").find(b => b.id === "tactical-mind");
  assert.match(tactical().label, /Tactical Mind \(\+1d10.*2 left\)/);
  assert.equal(boostsFor(fighter, "save").some(b => b.id === "tactical-mind"), false);
  rollResults.push(2);
  let out = await tactical().use({ total: 10, options: { target: 15 } });   // 12: still a failure
  assert.equal(out.bonusRoll.total, 2);
  assert.equal(wind.system.uses.spent, 0);
  rollResults.push(7);
  out = await tactical().use({ total: 10, options: { target: 15 } });       // 17: a success
  assert.equal(wind.system.uses.spent, 1);
});

test("Stroke of Luck: 2024 on any d20 test; 2014 an attack or a check, not a save", () => {
  settings.rollBoosts = true;
  const has = (rules, kind) => boostsFor({ items: [item("stroke-of-luck", { rules, uses: 1 })], effects: [], statuses: new Set() }, kind)
    .some(b => b.id === "stroke-of-luck");
  assert.equal(has("2024", "save"), true);
  assert.equal(has("2024", "attack"), true);
  assert.equal(has("2014", "check"), true);
  assert.equal(has("2014", "save"), false);
});

// ── Damage ──
test("Toll the Dead: d12s when every target is missing Hit Points, d8s otherwise — whichever activity was used", () => {
  settings.attackAdvantage = true;
  const hurt = creature("Hurt", 1, 0, { hp: 10, max: 20 }), fresh = creature("Fresh", 2, 0);
  const toll = item("toll-the-dead", { type: "spell" });
  const roll = (formula, targets) => {
    canvas.tokens.setTargets(targets.map(t => t.token.id));
    const config = { subject: { item: toll, actor: { items: [] } }, rolls: [{ parts: [formula] }] };
    onPreRollDamageFeatures(config);
    return config.rolls[0].parts[0];
  };
  assert.equal(roll("2d8", [hurt]), "2d12");
  assert.equal(roll("2d12", [fresh]), "2d8");
  assert.equal(roll("2d8", [hurt, fresh]), "2d8");
});

test("Empowered Evocation: the Intelligence modifier on the first damage roll after a wizard Evocation spell is cast", async () => {
  settings.attackAdvantage = true;
  const wizard = { isOwner: true, items: [item("empowered-evocation")], classes: { wizard: {} }, system: { abilities: { int: { mod: 4 } } } };
  const fireball = item("fireball", { type: "spell", extra: { school: "evo", level: 3 } });
  const activity = { item: fireball, actor: wizard };
  const damage = () => { const config = { subject: activity, rolls: [{ parts: ["8d6"] }] }; onPreRollDamageFeatures(config); return config.rolls[0].parts; };
  assert.deepEqual(damage(), ["8d6"]);                                   // not cast through a use: nothing
  await onFeatureUsed(activity, {}, {});
  assert.deepEqual(damage(), ["8d6", "4"]);
  assert.deepEqual(damage(), ["8d6"]);                                   // one damage roll of that spell
  delete wizard.classes;                                                 // no class recorded and no Wizard levels: not a wizard spell
  await onFeatureUsed(activity, {}, {});
  assert.deepEqual(damage(), ["8d6"]);
});

test("Great Weapon Master (2024): a Heavy weapon hit on your own turn, added automatically", () => {
  const rider = RIDERS["great-weapon-master"];
  const actor = { uuid: "Actor.gwm" };
  const heavy = { actor, item: { type: "weapon", system: { properties: new Set(["hvy"]) } }, attack: { type: { value: "melee", classification: "weapon" } } };
  const light = { ...heavy, item: { type: "weapon", system: { properties: new Set() } } };
  assert.equal(rider.mode, "auto");
  assert.equal(rider.eligible({ activity: heavy }), true);
  assert.equal(rider.eligible({ activity: light }), false);
  game.combat = { started: true, combatant: { actor: { uuid: "Actor.other" } } };
  assert.equal(rider.eligible({ activity: heavy }), false);              // not your turn
  assert.deepEqual(rider.activities(item("great-weapon-master", { rules: "2014" })), []);
});

// ── Sundering Blow ──
test("Sundering Blow: +5 to the next attack roll against the creature by anyone but the barbarian, used up", () => {
  settings.attackAdvantage = true;
  const barb = creature("Barb", 0, 0, { disposition: 1 }), ally = creature("Ally", 0, 1, { disposition: 1 });
  const orc = creature("Orc", 1, 0);
  const brutal = item("brutal-strike");
  brutal.actor = barb.actor;
  orc.actor.effects.push({ uuid: "E.sundered", name: "Sundered", disabled: false, origin: brutal.uuid });
  canvas.tokens.setTargets([orc.token.id]);
  const swing = (who) => attackReasons({ type: "attack", actor: who.actor, item: { type: "weapon", system: { range: {}, properties: new Set(), type: {} } },
    attack: { type: { value: "melee", classification: "weapon" } }, getUsageToken: () => who.doc });
  const byAlly = swing(ally);
  assert.equal(byAlly.attackBonus, 5);
  assert.deepEqual(byAlly.bonuses, ["Sundering Blow +5"]);
  assert.ok(byAlly.consume.includes("E.sundered"));
  assert.equal(swing(barb).attackBonus, 0);                              // not for the barbarian who sundered it
});

// ── Aura of Courage ──
test("Aura of Courage: the paladin and allies within 10 ft (30 ft from 18th level)", () => {
  const paladin = creature("Paladin", 0, 0, { disposition: 1, items: [item("aura-of-courage")] });
  const near = creature("Near", 2, 0, { disposition: 1 }), far = creature("Far", 4, 0, { disposition: 1 }), foe = creature("Foe", 1, 0);
  assert.equal(auraOfCourage(paladin.actor, paladin.doc), "Paladin" + paladin.doc.name.slice(7));
  assert.ok(auraOfCourage(near.actor, near.doc));
  assert.equal(auraOfCourage(far.actor, far.doc), null);
  assert.equal(auraOfCourage(foe.actor, foe.doc), null);
  paladin.actor.statuses.add("unconscious");
  assert.equal(auraOfCourage(near.actor, near.doc), null);
});

// ── Arcane Ward ──
test("Arcane Ward: once created, damage goes to the ward first; an Abjuration spell creates it or restores 2 × its level", async () => {
  settings.deathSaves = true;
  const create = { name: "Create Ward", uses: { spent: 0 }, async update(u) { this.uses.spent = u["uses.spent"]; } };
  const ward = item("arcane-ward", { uses: 13 });
  ward.system.activities = new Map([["c", create]]);
  const wizard = creature("Wizard", 0, 0, { disposition: 1, items: [ward], hp: 30, max: 30 });
  assert.equal(arcaneWard(wizard.actor), null);                           // not created yet

  const shield = item("shield", { type: "spell", extra: { school: "abj", level: 1 } });
  await onFeatureUsed({ item: shield, actor: wizard.actor }, { scaling: 0 }, {});
  assert.equal(create.uses.spent, 1);
  assert.equal(arcaneWard(wizard.actor).hp, 13);

  const updates = { "system.attributes.hp.value": 12, "system.attributes.hp.temp": 0 };
  onPreApplyDamageWard(wizard.actor, 18, updates);                        // 13 to the ward, 5 to the wizard
  assert.equal(updates["system.attributes.hp.value"], 25);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(ward.system.uses.spent, 13);
  assert.equal(arcaneWard(wizard.actor), null);                           // down

  await onFeatureUsed({ item: shield, actor: wizard.actor }, { scaling: 1 }, {});   // a 2nd-level Abjuration: +4
  assert.equal(arcaneWard(wizard.actor).hp, 4);
});
