// Sentinel, Polearm Master, Mage Slayer, Shield Master, Crusher, Piercer, Slasher, Cunning Strike, Help, teleport range.
import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { opportunityReactors, reachCrossing, polearmWeapon, answerOpportunity, isHalted, HALTED } from "../scripts/native/opportunity.mjs";
import { reactionOptions, holdsShield } from "../scripts/native/reactions.mjs";
import { featMarkReasons, helpCheckMark, crusherCanMove, damageTypesOf, onPreRollDamagePiercer, onPreApplyDamageMageSlayer, mageSlayerMark } from "../scripts/native/feats.mjs";
import { saveReasons } from "../scripts/native/save-rules.mjs";
import { boostsFor } from "../scripts/native/boosts.mjs";
import { cunningOptions, cunningAffordable, sneakDice } from "../scripts/native/cunning.mjs";
import { teleportNeeds, teleportProblem, onPreTeleport, onTeleport } from "../scripts/native/teleport.mjs";

const { settings, makeToken, prompts, uuids, rollResults, notes } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

canvas.grid = {
  isGridless: false, distance: 5, size: 100, units: "ft",
  getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
  getSnappedPoint: (p) => ({ x: Math.round(p.x / 100) * 100, y: Math.round(p.y / 100) * 100 }),
  measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5 })
};
let sightBlocked = false;
CONFIG.Canvas = { polygonBackends: { sight: { testCollision: () => sightBlocked }, move: { testCollision: () => false } } };

beforeEach(() => {
  env.reset();
  game.combat = null;
  game.users = [game.user];
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => game.user } } });
  sightBlocked = false;
});

let seq = 0;
function creature(name, col, row = 0, { disposition = -1, items = [], statuses = [], size = "med" } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const d = token.document;
  Object.assign(d, { x: col * 100, y: row * 100, elevation: 0, width: 1, height: 1, isOwner: true,
    getOccupiedGridSpaceOffsets: (data = {}) => [{ i: Math.round((data.y ?? d.y) / 100), j: Math.round((data.x ?? d.x) / 100) }] });
  const actor = d.actor;
  const effects = [];
  Object.assign(actor, { name, type: "character", documentName: "Actor", isOwner: true, statuses: new Set(statuses), items, effects, flags: {},
    system: { attributes: { prof: 2, hp: { value: 20, max: 20 } }, traits: { size }, abilities: { dex: { mod: 3 } } },
    getActiveTokens: () => [d], getFlag: (m, k) => actor.flags[m]?.[k],
    created: [], async createEmbeddedDocuments(_t, data) { actor.created.push(...data); return data; } });
  uuids.set(actor.uuid, actor);
  return { token, doc: d, actor };
}
const feat = (identifier, rules = "2024", extra = {}) => ({ name: identifier, type: "feat", system: { identifier, source: { rules }, ...extra } });
function weapon(name, { baseItem = name.toLowerCase(), props = [], reach = null } = {}) {
  const activity = { uuid: `Item.${name}${++seq}.Activity.a`, type: "attack", attack: { type: { value: "melee", classification: "weapon" } }, item: null };
  const item = { name, type: "weapon", system: { equipped: true, type: { baseItem }, range: { reach }, properties: new Set(props), activities: new Map([["a", activity]]) } };
  activity.item = item;
  uuids.set(activity.uuid, activity);
  return item;
}
const inCombat = () => { game.combat = { started: true, getCombatantsByToken: () => [{}] }; };
const mark = (kind, attacker, extra = {}) => ({ uuid: `E.${kind}${++seq}`, disabled: false,
  getFlag: (m, k) => m === MODULE_ID && k === "mastery" ? { kind, attacker: attacker?.uuid ?? attacker, ...extra } : undefined });

// ── Polearm Master, Sentinel ──
test("Polearm Master: 2024 a Quarterstaff, Spear, or Heavy and Reach weapon; 2014 a glaive, halberd, pike or quarterstaff", () => {
  const holder = (rules, w) => ({ items: [feat("polearm-master", rules), w] });
  assert.ok(polearmWeapon(holder("2024", weapon("Spear"))));
  assert.equal(polearmWeapon(holder("2024", weapon("Glaive", { props: ["hvy", "rch"] }))).reach, 10);
  assert.equal(polearmWeapon(holder("2024", weapon("Longsword"))), null);
  assert.equal(polearmWeapon(holder("2014", weapon("Spear"))), null);
  assert.ok(polearmWeapon(holder("2014", weapon("Pike", { props: ["hvy", "rch"] }))));
});

test("a path coming into reach: the first spot in reach after being outside it; none when it starts in reach", () => {
  const guard = creature("Guard", 0, 0);
  const mover = creature("Mover", 4, 0, { disposition: 1 });
  const path = [{ x: 400, y: 0 }, { x: 100, y: 0 }];
  const enter = reachCrossing(guard.doc, mover.doc, path, 10, "enter");
  assert.deepEqual([enter.point.x, enter.point.y], [200, 0]);                // 10 ft away
  assert.equal(reachCrossing(guard.doc, mover.doc, [{ x: 100, y: 0 }, { x: 0, y: 100 }], 10, "enter"), null);
});

test("Disengaged: only a 2014 Sentinel's opportunity attack, and 2024 Polearm Master's reaction (not 2014's)", () => {
  inCombat();
  const sentinel14 = creature("Old Sentinel", 0, 0, { items: [feat("sentinel", "2014"), weapon("Mace")] });
  const sentinel24 = creature("New Sentinel", 0, 1, { items: [feat("sentinel", "2024"), weapon("Mace")] });
  const pole24 = creature("Pole", 6, 0, { items: [feat("polearm-master", "2024"), weapon("Quarterstaff")] });
  const pole14 = creature("Old Pole", 6, 1, { items: [feat("polearm-master", "2014"), weapon("Quarterstaff")] });
  const mover = creature("Mover", 1, 0, { disposition: 1 });
  const path = [{ x: 100, y: 0 }, { x: 500, y: 0 }];                            // away from the sentinels, toward the poles
  const who = (opts) => opportunityReactors(mover.doc, path, opts).map(r => `${r.doc.name}:${r.mode}`).sort();
  assert.deepEqual(who({}).filter(w => !w.startsWith("Old Pole")).length, 3);
  const disengaged = who({ disengaged: true });
  assert.ok(disengaged.some(w => w.startsWith("Old Sentinel") && w.endsWith(":exit")));
  assert.ok(!disengaged.some(w => w.startsWith("New Sentinel")));
  assert.ok(disengaged.some(w => w.startsWith("Pole") && w.endsWith(":enter")));
  assert.ok(!disengaged.some(w => w.startsWith("Old Pole")));
});

test("Sentinel's Halt: an opportunity attack that hits puts Speed 0 on the creature; not after a reaction that isn't one", async () => {
  inCombat();
  const mace = weapon("Mace");
  const sentinel = creature("Sentinel", 0, 0, { items: [feat("sentinel"), mace] });
  const mover = creature("Mover", 1, 0, { disposition: 1 });
  const card = { id: "card1", system: { evaluatedTargets: [{ token: mover.doc.uuid, isMiss: false }] } };
  game.messages.get = (id) => id === "card1" ? card : null;
  const activity = mace.system.activities.get("a");
  activity.rollAttack = async () => [{ parent: card }];
  prompts.choice = async () => "attack";
  const ask = (opportunity) => answerOpportunity({ token: sentinel.doc.uuid, actor: sentinel.actor.uuid, mover: mover.doc.uuid,
    moverName: "Mover", activity: activity.uuid, reach: 5, reason: "attack", opportunity });
  const answer = await ask(true);
  assert.equal(answer.halted, true);
  const halt = mover.actor.created.find(e => e.flags[MODULE_ID].mastery.kind === HALTED);
  assert.ok(halt.system.changes.every(c => c.value === 0));
  assert.equal(halt.duration.expiry, "turnEnd");
  game.combat = null;                                                         // outside combat there's no reaction to track
  mover.actor.created.length = 0;
  assert.equal((await ask(false)).halted, false);
  assert.equal(mover.actor.created.length, 0);
});

test("a halted creature is noticed", () => {
  const mover = creature("Mover", 1, 0);
  assert.equal(isHalted(mover.actor), false);
  mover.actor.effects.push(mark(HALTED, "Actor.x"));
  assert.equal(isHalted(mover.actor), true);
});

// ── Shield Master ──
test("Interpose Shield: offered after a successful Dexterity save only while holding a shield", () => {
  settings.reactionPrompts = "all";
  const shield = { type: "equipment", system: { equipped: true, type: { value: "shield" } } };
  const fighter = { items: [feat("shield-master"), shield], statuses: new Set() };
  assert.equal(holdsShield(fighter), true);
  assert.deepEqual(reactionOptions(fighter, {}, "saved"), ["shield-master"]);
  shield.system.equipped = false;
  assert.deepEqual(reactionOptions(fighter, {}, "saved"), []);
});

// ── Crusher, Piercer, Slasher ──
test("Crusher moves a creature no more than one size larger; the damage types come from the card's rolls", () => {
  assert.equal(crusherCanMove({ system: { traits: { size: "med" } } }, { system: { traits: { size: "lg" } } }), true);
  assert.equal(crusherCanMove({ system: { traits: { size: "med" } } }, { system: { traits: { size: "huge" } } }), false);
  assert.deepEqual([...damageTypesOf({ rolls: [{ options: { type: "bludgeoning" } }, { options: { type: "fire", types: ["fire"] } }] })], ["bludgeoning", "fire"]);
});

test("Piercer: one more critical die on a piercing weapon's damage (dnd5e counts it only on a critical hit)", () => {
  settings.onHitRiders = true;
  const actor = { name: "P", items: [feat("piercer")] };
  const config = (type) => ({ subject: { type: "attack", actor, damage: { parts: [] } }, rolls: [{ options: { type, critical: { bonusDice: 1 } } }] });
  const rapier = config("piercing");
  onPreRollDamagePiercer(rapier);
  assert.equal(rapier.rolls[0].options.critical.bonusDice, 2);
  const mace = config("bludgeoning");
  onPreRollDamagePiercer(mace);
  assert.equal(mace.rolls[0].options.critical.bonusDice, 1);
});

test("Crushed: Advantage on attacks against it; Slashed: Disadvantage on its attacks; Help: an ally's next attack, used up", () => {
  const helperUuid = "Actor.helper";
  const orc = creature("Orc", 1, 0);
  const ally = creature("Ally", 0, 0, { disposition: 1 });
  orc.actor.effects.push(mark("crusher", "Actor.crusher"));
  let r = featMarkReasons({ attackerActor: ally.actor, attackerDoc: ally.doc, targetActor: orc.actor });
  assert.deepEqual(r.advantage, ["Crusher (critical hit)"]);
  ally.actor.effects.push(mark("slasher", "Actor.slasher"));
  assert.deepEqual(featMarkReasons({ attackerActor: ally.actor, attackerDoc: ally.doc, targetActor: null }).disadvantage, ["Slasher (critical hit)"]);
  orc.actor.effects.length = 0;
  const help = mark("help", helperUuid, { disposition: 1, helperName: "Helper" });
  orc.actor.effects.push(help);
  r = featMarkReasons({ attackerActor: ally.actor, attackerDoc: ally.doc, targetActor: orc.actor });
  assert.deepEqual(r.advantage, ["Help (Helper)"]);
  assert.deepEqual(r.consume, [help.uuid]);
  const foe = creature("Foe", 2, 0);                                         // not the helper's ally
  assert.deepEqual(featMarkReasons({ attackerActor: foe.actor, attackerDoc: foe.doc, targetActor: orc.actor }).advantage, []);
  assert.deepEqual(featMarkReasons({ attackerActor: { uuid: helperUuid }, attackerDoc: ally.doc, targetActor: orc.actor }).advantage, []);
});

test("Help with a check: 2024 the skill or tool it named; 2014 any check", () => {
  const ally = creature("Ally", 0, 0, { disposition: 1 });
  ally.actor.effects.push(mark("help-check", "Actor.h", { skill: "ath" }));
  assert.ok(helpCheckMark(ally.actor, { skill: "ath" }));
  assert.equal(helpCheckMark(ally.actor, { skill: "ste" }), null);
  ally.actor.effects.length = 0;
  ally.actor.effects.push(mark("help-check", "Actor.h", { skill: null, tool: null }));
  assert.ok(helpCheckMark(ally.actor, { skill: "ste" }));
});

// ── Mage Slayer ──
test("Mage Slayer: damage from it to a concentrating creature marks Disadvantage on its concentration save", () => {
  settings.saveRules = true;
  const slayer = creature("Slayer", 0, 0, { items: [feat("mage-slayer")] });
  const mage = creature("Mage", 1, 0, { disposition: 1 });
  mage.actor.concentration = { effects: new Set([{}]) };
  onPreApplyDamageMageSlayer(mage.actor, 7, {}, { originatingMessage: { speakerActor: slayer.actor } });
  const effect = mage.actor.created[0];
  assert.equal(effect.flags[MODULE_ID].mastery.kind, "mage-slayer");
  mage.actor.effects.push({ ...effect, uuid: "E.slayer", disabled: false, getFlag: (m, k) => effect.flags[m]?.[k] });
  assert.ok(mageSlayerMark(mage.actor));
  const reasons = saveReasons(mage.actor, "con", {}, { tokenDoc: mage.doc, concentration: true });
  assert.ok(reasons.disadvantage.includes("Mage Slayer"));
  assert.ok(reasons.consume.includes("E.slayer"));
  assert.ok(!saveReasons(mage.actor, "con", {}, { tokenDoc: mage.doc }).disadvantage.includes("Mage Slayer"));
});

test("Guarded Mind (2024): a failed Intelligence, Wisdom or Charisma save succeeds, spending its use", async () => {
  settings.rollBoosts = true;
  const slayer = { name: "mage-slayer", type: "feat", system: { identifier: "mage-slayer", source: { rules: "2024" }, uses: { max: 1, spent: 0 } },
    async update(u) { slayer.system.uses.spent = u["system.uses.spent"]; } };
  const actor = { items: [slayer], effects: [], statuses: new Set() };
  assert.equal(boostsFor(actor, "save", { ability: "dex" }).some(b => b.id === "guarded-mind"), false);
  const guarded = boostsFor(actor, "save", { ability: "wis" }).find(b => b.id === "guarded-mind");
  const out = await guarded.use({ total: 9, options: { target: 15 } });
  assert.equal(out.bonusRoll.total, 6);
  assert.equal(slayer.system.uses.spent, 1);
});

// ── Cunning Strike ──
test("Cunning Strike: its effects and Devious Strikes', one at a time (two with Improved), paid in Sneak Attack dice", () => {
  const acts = (...names) => ({ activities: new Map(names.map((n, i) => [String(i), { name: n, type: "save" }])) });
  const rogue = { items: [feat("cunning-strike", "2024", acts("Poison", "Trip", "Withdraw"))], system: { scale: { rogue: { "sneak-attack": { number: 3 } } } } };
  let { options, max } = cunningOptions(rogue);
  assert.deepEqual(options.map(o => `${o.name}:${o.cost}`), ["Poison:1", "Trip:1", "Withdraw:1"]);
  assert.equal(max, 1);
  assert.equal(sneakDice(rogue), 3);
  rogue.items.push(feat("improved-cunning-strike"), feat("devious-strikes", "2024", acts("Daze", "Knock Out", "Obscure")));
  ({ options, max } = cunningOptions(rogue));
  assert.equal(max, 2);
  const by = (n) => options.find(o => o.name === n);
  assert.equal(cunningAffordable([by("Poison"), by("Obscure")], max, 4), true);
  assert.equal(cunningAffordable([by("Knock Out")], max, 3), false);
  assert.equal(cunningAffordable([by("Poison"), by("Trip"), by("Withdraw")], max, 7), false);
});

// ── Teleport range ──
test("teleport range: too far, a taken space, out of sight — each turned down, then planned again", async () => {
  settings.teleportRange = true;
  const me = creature("Me", 0, 0, { disposition: 1 });
  creature("Other", 3, 0);
  const misty = { item: { name: "Misty Step", system: { description: { value: "<p>You briefly surround yourself in silvery mist and teleport up to 30 feet to an unoccupied space you can see.</p>" } } },
    description: {}, planned: 0, async planTeleport() { this.planned++; } };
  assert.deepEqual(teleportNeeds(misty), { unoccupied: true, sight: true });
  assert.deepEqual(teleportNeeds({ item: { system: { description: { value: "You teleport to a location within range." } } } }), { unoccupied: false, sight: false });
  const plan = (x, y) => ({ origin: { x: 0, y: 0, width: 1, height: 1 }, destination: { x, y, width: 1, height: 1 } });
  assert.match(teleportProblem(me.doc, plan(700, 0), 30, teleportNeeds(misty)), /35 ft away; it reaches 30/);
  assert.match(teleportProblem(me.doc, plan(300, 0), 30, teleportNeeds(misty)), /taken \(Other/);
  sightBlocked = true;
  assert.match(teleportProblem(me.doc, plan(0, 400), 30, teleportNeeds(misty)), /can't see/);
  sightBlocked = false;
  assert.equal(teleportProblem(me.doc, plan(0, 400), 30, teleportNeeds(misty)), null);

  onPreTeleport(misty, { maxDistance: 30 });
  assert.equal(onTeleport(misty, [{ token: me.token, plan: plan(0, 400) }]), undefined);
  assert.equal(onTeleport(misty, [{ token: me.token, plan: plan(900, 0) }]), false);
  assert.ok(notes.some(n => /can't go there/.test(n)));
  await new Promise(r => setTimeout(r, 80));
  assert.equal(misty.planned, 1);
  settings.teleportRange = false;
  assert.equal(onTeleport(misty, [{ token: me.token, plan: plan(900, 0) }]), undefined);
});

// ── Pushes and Crusher's move: never onto another creature ──
test("a push stops short of a creature in the way; Crusher moves to the farthest free space, straight away when it can", async () => {
  const { pushDestination } = await import("../scripts/native/mastery.mjs");
  const { crusherDestination } = await import("../scripts/native/feats.mjs");
  const fighter = creature("Fighter", 6, 5, { disposition: 1 });
  const dummy = creature("Dummy", 5, 5);
  assert.deepEqual([pushDestination(fighter.doc, dummy.doc, 5).x, pushDestination(fighter.doc, dummy.doc, 5).y], [400, 500]);
  assert.deepEqual(crusherDestination(fighter.doc, dummy.doc), { x: 400, y: 500 });
  creature("Rogue", 4, 5, { disposition: 1 });                              // straight behind it
  assert.equal(pushDestination(fighter.doc, dummy.doc, 5), null);
  assert.equal(pushDestination(fighter.doc, dummy.doc, 10).feet, 10);        // the square past the rogue is free
  const dest = crusherDestination(fighter.doc, dummy.doc);
  assert.equal(dest.x, 400);                                                // a diagonal, still away from the fighter
  assert.notEqual(dest.y, 500);
});
