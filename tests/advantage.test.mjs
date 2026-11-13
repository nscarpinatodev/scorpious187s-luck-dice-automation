import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { attackReasons, onPreRollAttack, ac5eCovers, tokenDistance, ATTACK_REASONS_FLAG } from "../scripts/native/advantage.mjs";

const { settings, uuids, scene, makeToken, notes } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

// A square grid in feet: each space 5 ft, diagonals 5 ft too (dnd5e's default rule).
let wallBlocks = false;
canvas.grid = {
  isGridless: false, distance: 5, size: 100, units: "ft",
  getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
  measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5 })
};
scene.grid = { units: "ft" };
CONFIG.Canvas = { polygonBackends: { sight: { testCollision: () => wallBlocks } } };

beforeEach(() => {
  env.reset();
  settings.attackAdvantage = true;
  wallBlocks = false;
  game.modules.delete("automated-conditions-5e");
});

let seq = 0;
/** A token at grid space (col, row) with an actor; statuses, items, effects as given. */
function creature(name, col, row, { disposition = -1, statuses = [], items = [], effects = [], abilities = {}, size = "med" } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const d = token.document;
  Object.assign(d, { x: col * 100, y: row * 100, elevation: 0, width: 1, height: 1,
    getOccupiedGridSpaceOffsets: () => [{ i: row, j: col }] });
  const actor = d.actor;
  Object.assign(actor, {
    statuses: new Set(statuses), items, effects,
    system: { traits: { size }, abilities: Object.fromEntries(Object.entries({ str: 10, dex: 10, ...abilities }).map(([k, v]) => [k, { value: v }])) },
    getActiveTokens: () => [d]
  });
  return { token, doc: d, actor };
}
/** An item with an identifier (and its rules version), registered so effects can name it as their source. */
function item(identifier, { rules = "2024", type = "feat", owner = "Actor.x", name = identifier } = {}) {
  const it = { documentName: "Item", uuid: `${owner}.Item.${identifier}${++seq}`, name, type, system: { identifier, source: { rules } } };
  uuids.set(it.uuid, it);
  return it;
}
const effectFrom = (source, extra = {}) => ({ uuid: `${source.uuid}.ActiveEffect.e${++seq}`, disabled: false, system: { origin: { item: source.uuid } }, statuses: new Set(), ...extra });
function weapon({ range = { value: 80, long: 320, units: "ft" }, properties = [], type = "martialR", baseItem = "longbow", rules = "2024" } = {}) {
  return { type: "weapon", name: baseItem, system: { range, properties: new Set(properties), type: { value: type, baseItem }, source: { rules } } };
}
function attack(attacker, { ranged = true, item: it = weapon(), classification = "weapon" } = {}) {
  return { type: "attack", actor: attacker.actor, item: it, attack: { type: { value: ranged ? "ranged" : "melee", classification } },
    range: it.system?.range, getUsageToken: () => attacker.doc };
}
const target = (...tokens) => canvas.tokens.setTargets(tokens.map(t => t.token.id));

test("distance: nearest spaces, 5 ft adjacent and diagonal", () => {
  const a = creature("A", 0, 0), b = creature("B", 1, 1), c = creature("C", 4, 0);
  assert.equal(tokenDistance(a.doc, b.doc), 5);
  assert.equal(tokenDistance(a.doc, c.doc), 20);
});

test("ranged with an active enemy within 5 ft: disadvantage; incapacitated enemies don't count", () => {
  const archer = creature("Archer", 0, 0, { disposition: 1 });
  const goblin = creature("Goblin", 1, 0, { disposition: -1 });
  const far = creature("Far", 6, 0);
  target(far);
  assert.deepEqual(attackReasons(attack(archer)).disadvantage, ["Ranged attack with Goblin within 5 ft"]);
  goblin.actor.statuses.add("unconscious");
  assert.deepEqual(attackReasons(attack(archer)).disadvantage, []);
  // Melee: no such rule.
  goblin.actor.statuses.clear();
  assert.deepEqual(attackReasons(attack(archer, { ranged: false, item: weapon({ type: "martialM" }) })).disadvantage, []);
});

test("feats: Crossbow Expert (2014 all ranged, 2024 crossbows), Sharpshooter 2024, Spell Sniper 2024 for spells", () => {
  const nearby = (items, it, classification) => {
    env.reset(); settings.attackAdvantage = true;
    const me = creature("Me", 0, 0, { disposition: 1, items });
    creature("Foe", 1, 0);
    target(creature("Far", 5, 0));
    return attackReasons(attack(me, { item: it, classification })).disadvantage.some(r => r.startsWith("Ranged attack with"));
  };
  assert.equal(nearby([item("crossbow-expert", { rules: "2014" })], weapon()), false);
  assert.equal(nearby([item("crossbow-expert", { rules: "2024" })], weapon()), true);
  assert.equal(nearby([item("crossbow-expert", { rules: "2024" })], weapon({ baseItem: "lightcrossbow" })), false);
  assert.equal(nearby([item("sharpshooter", { rules: "2024" })], weapon()), false);
  assert.equal(nearby([item("sharpshooter", { rules: "2014" })], weapon()), true);
  const fireBolt = { type: "spell", name: "Fire Bolt", system: { range: { value: 120, units: "ft" } } };
  assert.equal(nearby([item("spell-sniper", { rules: "2024" })], fireBolt, "spell"), false);
});

test("long range: disadvantage (Sharpshooter ignores); beyond long range the attack is cancelled with a message", () => {
  const archer = creature("Archer", 0, 0, { disposition: 1 });
  const mid = creature("Mid", 20, 0);              // 100 ft: past 80
  target(mid);
  assert.deepEqual(attackReasons(attack(archer)).disadvantage, ["Long range"]);
  archer.actor.items = [item("sharpshooter")];
  assert.deepEqual(attackReasons(attack(archer)).disadvantage, []);

  const way = creature("Way", 70, 0);              // 350 ft: past 320
  target(way);
  const config = { subject: attack(archer) };
  assert.equal(onPreRollAttack(config, {}, {}), false);
  assert.match(notes.at(-1), /Way is out of range for longbow \(350 of 320\)/);
  // A spell attack has no long range: past its range is out of range.
  const fireBolt = { type: "spell", name: "Fire Bolt", system: { range: { value: 120, units: "ft" } } };
  assert.match(attackReasons(attack(archer, { item: fireBolt, classification: "spell" })).cancel, /out of range/);
});

test("prone target: advantage in melee within 5 ft, disadvantage otherwise", () => {
  const fighter = creature("Fighter", 0, 0, { disposition: 1 });
  const prone = creature("Prone", 1, 0, { statuses: ["prone"] });
  target(prone);
  const sword = weapon({ type: "martialM", range: { value: null, reach: 5 }, baseItem: "longsword" });
  assert.deepEqual(attackReasons(attack(fighter, { ranged: false, item: sword })).advantage, ["Target prone"]);
  assert.deepEqual(attackReasons(attack(fighter, { ranged: true })).disadvantage.filter(r => r.startsWith("Target")), ["Target prone (not within 5 ft)"]);
});

test("conditions on attacker and target; Invisible on both sides lists both (they cancel)", () => {
  const me = creature("Me", 0, 0, { disposition: 1, statuses: ["prone", "restrained", "invisible"] });
  const them = creature("Them", 2, 0, { statuses: ["restrained", "blinded", "invisible", "dodging"] });
  target(them);
  const melee = () => attackReasons(attack(me, { ranged: false, item: weapon({ type: "martialM", range: {} }) }));
  const r = melee();
  assert.deepEqual(r.advantage, ["Invisible", "Target restrained", "Target blinded"]);
  assert.deepEqual(r.disadvantage, ["Prone", "Restrained", "Target invisible", "Target dodging"]);
  // An incapacitated creature can't benefit from Dodge.
  them.actor.statuses.add("stunned");
  assert.ok(!melee().disadvantage.includes("Target dodging"));
  assert.ok(melee().advantage.includes("Target stunned"));
});

test("Frightened: only with the source of the fear on the scene and in sight", () => {
  const scary = creature("Dragon", 5, 0);
  const caster = item("cause-fear", { owner: scary.actor.uuid });
  scary.actor.items = [caster];
  caster.actor = scary.actor;
  const fear = effectFrom(caster, { statuses: new Set(["frightened"]) });
  const me = creature("Me", 0, 0, { disposition: 1, statuses: ["frightened"], effects: [fear] });
  target(scary);
  const frightened = () => attackReasons(attack(me)).disadvantage.filter(r => r.startsWith("Frightened"));
  assert.deepEqual(frightened(), ["Frightened of Dragon"]);
  wallBlocks = true;
  assert.deepEqual(frightened(), []);
  wallBlocks = false;
  me.actor.effects = [{ ...fear, system: {}, origin: null }];       // applied by hand: no known source
  assert.deepEqual(frightened(), []);
});

test("Reckless Attack: the attacker's Strength attacks (2014: melee weapons); attacks against a reckless creature", () => {
  const reckless = item("reckless-attack", { rules: "2024" });
  const barb = creature("Barb", 0, 0, { disposition: 1, effects: [effectFrom(reckless)] });
  const foe = creature("Foe", 1, 0);
  target(foe);
  const axe = weapon({ type: "martialM", range: { reach: 5 }, baseItem: "greataxe" });
  const melee = (ability) => attackReasons(attack(barb, { ranged: false, item: axe }), { ability }).advantage;
  assert.deepEqual(melee("str"), ["Reckless Attack"]);
  assert.deepEqual(melee("dex"), []);
  const legacy = item("reckless-attack", { rules: "2014" });
  barb.actor.effects = [effectFrom(legacy)];
  assert.deepEqual(attackReasons(attack(barb, { item: weapon({ type: "martialR", baseItem: "handaxe" }) }), { ability: "str", attackMode: "thrown" }).advantage, []);
  assert.deepEqual(melee("str"), ["Reckless Attack"]);

  // Attacking the barbarian.
  const goblin = creature("Goblin", 2, 0);
  target(barb);
  assert.ok(attackReasons(attack(goblin)).advantage.includes("Target attacking recklessly"));
});

test("Faerie Fire and Guiding Bolt on the target; the bolt's mark is used up", () => {
  const me = creature("Me", 0, 0, { disposition: 1 });
  const fire = effectFrom(item("faerie-fire")), bolt = effectFrom(item("guiding-bolt"));
  const them = creature("Them", 3, 0, { effects: [fire, bolt] });
  target(them);
  const r = attackReasons(attack(me));
  assert.deepEqual(r.advantage, ["Faerie Fire", "Guiding Bolt"]);
  assert.deepEqual(r.consume, [bolt.uuid]);
});

test("Heavy weapons: 2014 Small wielders; 2024 Strength / Dexterity below 13", () => {
  const foe = creature("Foe", 1, 0);
  target(foe);
  const heavy = (rules, type, opts) => {
    const me = creature("Me", 0, 0, { disposition: 1, ...opts });
    return attackReasons(attack(me, { ranged: type.endsWith("R"), item: weapon({ properties: ["hvy"], type, rules, range: { value: 100, long: 400, units: "ft" } }) })).disadvantage
      .filter(r => r.startsWith("Heavy"));
  };
  assert.deepEqual(heavy("2014", "martialM", { size: "sm" }), ["Heavy weapon (small wielder)"]);
  assert.deepEqual(heavy("2014", "martialM", { size: "med" }), []);
  assert.deepEqual(heavy("2024", "martialM", { abilities: { str: 12 } }), ["Heavy weapon (Strength below 13)"]);
  assert.deepEqual(heavy("2024", "martialR", { abilities: { dex: 14 } }), []);
});

test("with AC5E active, the checks it performs are left to it", () => {
  const ac5e = { automateStatuses: true, expandedConditions: false, autoRangeChecks: new Set(["rangedNearbyFoes", "rangedOoR"]), automateHeavy: false };
  game.modules.set("automated-conditions-5e", { active: true });
  const get = game.settings.get;
  game.settings.get = (scope, key) => scope === "automated-conditions-5e" ? ac5e[key] : get(scope, key);
  try {
    assert.deepEqual(ac5eCovers(), { statuses: true, dodging: false, nearbyFoes: true, longRange: false, outOfRange: true, heavy: false });
    const me = creature("Me", 0, 0, { disposition: 1, statuses: ["prone"] });
    creature("Foe", 1, 0);
    const them = creature("Them", 70, 0, { statuses: ["blinded", "dodging"] });
    target(them);
    const r = attackReasons(attack(me));
    assert.equal(r.cancel, null);                                   // AC5E's out-of-range check
    assert.deepEqual(r.advantage, []);                              // AC5E's statuses
    assert.deepEqual(r.disadvantage, ["Target dodging"]);           // AC5E needs expanded conditions for this
  } finally {
    game.settings.get = get;
  }
});

test("the hook: advantage / disadvantage set, reasons on the card; several targets ignore target reasons; off does nothing", () => {
  const me = creature("Me", 0, 0, { disposition: 1 });
  const a = creature("A", 1, 0, { statuses: ["stunned"] }), b = creature("B", 2, 0);
  target(a);
  const config = { subject: attack(me, { ranged: false, item: weapon({ type: "martialM", range: {} }) }) };
  const message = {};
  assert.equal(onPreRollAttack(config, {}, message), undefined);
  assert.equal(config.advantage, true);
  assert.deepEqual(message.data.flags[MODULE_ID][ATTACK_REASONS_FLAG].advantage, ["Target stunned"]);

  target(a, b);
  const several = { subject: config.subject };
  onPreRollAttack(several, {}, {});
  assert.equal(several.advantage, undefined);

  settings.attackAdvantage = false;
  target(a);
  const off = { subject: config.subject };
  onPreRollAttack(off, {}, {});
  assert.equal(off.advantage, undefined);
});

// ── Attack feats ──
import { onPreRollDamageFeats } from "../scripts/native/advantage.mjs";

const fireBolt = (level = 0, sourceClass = "") => ({ type: "spell", name: "Fire Bolt", system: { level, sourceClass, range: { value: 120, units: "ft" } } });
const withCover = (c, cover) => { c.actor.system.attributes = { ac: { cover } }; return c; };
function withAC5E(settingsMap, fn) {
  game.modules.set("automated-conditions-5e", { active: true });
  const get = game.settings.get;
  game.settings.get = (scope, key) => scope === "automated-conditions-5e" ? settingsMap[key] : get(scope, key);
  try { return fn(); } finally { game.settings.get = get; game.modules.delete("automated-conditions-5e"); }
}

test("Gunner: no disadvantage from an enemy within 5 ft on any ranged attack, spells too", () => {
  const me = creature("Me", 0, 0, { disposition: 1, items: [item("gunner", { rules: "2014" })] });
  creature("Foe", 1, 0);
  target(creature("Far", 6, 0));
  const r = attackReasons(attack(me, { item: fireBolt(), classification: "spell" }));
  assert.deepEqual(r.disadvantage, []);
  assert.deepEqual(r.ignored, ["Foe within 5 ft (Gunner)"]);
});

test("Spell Sniper range: doubled (2014), +60 ft (2024)", () => {
  const cast = (feats, col) => {
    env.reset(); settings.attackAdvantage = true;
    const me = creature("Me", 0, 0, { disposition: 1, items: feats });
    target(creature("Far", col, 0));
    return attackReasons(attack(me, { item: fireBolt(), classification: "spell" })).cancel;
  };
  assert.match(cast([], 30), /out of range/);                                       // 150 ft of 120
  assert.equal(cast([item("spell-sniper", { rules: "2014" })], 30), null);         // of 240
  assert.equal(cast([item("spell-sniper", { rules: "2024" })], 30), null);         // of 180
  assert.match(cast([item("spell-sniper", { rules: "2024" })], 40), /200 of 180/);
});

test("ignoring cover: Spell Sniper and Sharpshooter, half and three-quarters; total cover stands", () => {
  const reasonsFor = (feats, it, classification, cover, actorExtra = {}) => {
    env.reset(); settings.attackAdvantage = true;
    const me = creature("Me", 0, 0, { disposition: 1, items: feats });
    Object.assign(me.actor, actorExtra);
    target(withCover(creature("Them", 4, 0), cover));
    return attackReasons(attack(me, { item: it, classification }));
  };
  const ignoredCover = (r) => r.coverIgnored.map(c => c.bonus);
  assert.deepEqual(ignoredCover(reasonsFor([item("spell-sniper")], fireBolt(), "spell", 5)), [5]);
  assert.deepEqual(ignoredCover(reasonsFor([item("sharpshooter", { rules: "2014" })], weapon(), "weapon", 2)), [2]);
  assert.deepEqual(ignoredCover(reasonsFor([], weapon(), "weapon", 2)), []);
  assert.deepEqual(ignoredCover(reasonsFor([item("spell-sniper")], weapon(), "weapon", 2)), []);     // weapons aren't spells
  assert.deepEqual(ignoredCover(reasonsFor([item("spell-sniper")], fireBolt(), "spell", 0)), []);    // no cover (or total: no bonus)
  assert.deepEqual(ignoredCover(reasonsFor([item("sniper")], fireBolt(), "spell", 2)), []);          // Valda's Sniper isn't automated
});

test("the hook takes ignored cover off the card's target AC and the roll's own target", () => {
  const me = creature("Me", 0, 0, { disposition: 1, items: [item("spell-sniper")] });
  const them = withCover(creature("Them", 4, 0), 5);
  target(them);
  const config = { subject: attack(me, { item: fireBolt(), classification: "spell" }), target: 18, rolls: [{ options: { target: 18 } }] };
  const message = { data: { system: { targets: [{ token: them.doc.uuid, name: "Them", ac: 18 }] } } };
  onPreRollAttack(config, {}, message);
  assert.equal(message.data.system.targets[0].ac, 13);
  assert.equal(config.target, 13);
  assert.equal(config.rolls[0].options.target, 13);
  assert.deepEqual(message.data.flags[MODULE_ID][ATTACK_REASONS_FLAG].ignored, ["Them's cover (Spell Sniper)"]);
  assert.equal(config.advantage, false);                        // nothing else changed
});

test("with AC5E checking nearby enemies: Gunner takes its disadvantage back; 2024 Crossbow Expert only lets crossbows off", () => {
  const ac5e = { autoRangeChecks: new Set(["rangedNearbyFoes"]) };
  withAC5E(ac5e, () => {
    const gunner = creature("Gunner", 0, 0, { disposition: 1, items: [item("gunner", { rules: "2014" })] });
    creature("Foe", 1, 0);
    target(creature("Far", 6, 0));
    const ac5eState = { subject: { disadvantage: ["AC5E.NearbyFoe"] }, opponent: { disadvantage: [] }, hasTransitDisadvantage: true };
    const config = { subject: attack(gunner), rolls: [{ options: { "automated-conditions-5e": ac5eState } }] };
    onPreRollAttack(config, {}, {});
    assert.deepEqual(ac5eState.subject.disadvantage, []);
    assert.equal(ac5eState.hasTransitDisadvantage, false);
    assert.equal(config.disadvantage, false);

    // Another source of disadvantage stays.
    const blinded = { subject: { disadvantage: ["AC5E.NearbyFoe", "Blinded"] }, hasTransitDisadvantage: true };
    const second = { subject: attack(gunner), rolls: [{ options: { "automated-conditions-5e": blinded } }] };
    onPreRollAttack(second, {}, {});
    assert.equal(second.disadvantage, true);

    const expert = creature("Expert", 10, 10, { disposition: 1, items: [item("crossbow-expert", { rules: "2024" })] });
    creature("Foe2", 11, 10);
    target(creature("Far2", 16, 10));
    assert.deepEqual(attackReasons(attack(expert)).disadvantage, ["Ranged attack with Foe2 within 5 ft"]);          // a longbow
    assert.deepEqual(attackReasons(attack(expert, { item: weapon({ baseItem: "heavycrossbow" }) })).disadvantage, []); // AC5E lets it off
  });
});

test("2024 Crossbow Expert: an off-hand hand crossbow adds its ability modifier to the damage", () => {
  const handCrossbow = weapon({ baseItem: "handcrossbow", properties: ["lgt"], type: "simpleR" });
  const roll = (feats, attackMode = "offhand", parts = ["1d6"]) => {
    const me = creature("Me", 0, 0, { disposition: 1, items: feats });
    const config = { subject: attack(me, { item: handCrossbow }), attackMode, rolls: [{ base: true, parts: [...parts] }] };
    onPreRollDamageFeats(config);
    return config.rolls[0].parts;
  };
  assert.deepEqual(roll([item("crossbow-expert", { rules: "2024" })]), ["1d6", "@mod"]);
  assert.deepEqual(roll([item("crossbow-expert", { rules: "2014" })]), ["1d6"]);
  assert.deepEqual(roll([item("crossbow-expert", { rules: "2024" })], "oneHanded"), ["1d6"]);
  assert.deepEqual(roll([item("crossbow-expert", { rules: "2024" })], "offhand", ["1d6", "@mod"]), ["1d6", "@mod"]);
});

test("Spell Sniper through a spell conduit (the range already multiplied): 2014 doubles it, 2024 adds 60 ft times the multiplier", () => {
  const conduitBolt = { type: "spell", name: "Fire Bolt", flags: { "scorpious187s-custom-items": { conduitCast: { rangeMultiplier: 2 } } },
    system: { level: 0, range: { value: 240, units: "ft" } } };
  const reach = (rules, col) => {
    env.reset(); settings.attackAdvantage = true;
    const me = creature("Me", 0, 0, { disposition: 1, items: [item("spell-sniper", { rules })] });
    target(creature("Far", col, 0));
    return attackReasons(attack(me, { item: conduitBolt, classification: "spell" })).cancel;
  };
  assert.equal(reach("2024", 72), null);                 // 360 ft: (120 + 60) × 2
  assert.match(reach("2024", 73), /365 of 360/);
  assert.equal(reach("2014", 96), null);                 // 480 ft: 120 × 2 × 2
  assert.match(reach("2014", 97), /485 of 480/);
});

test("line of sight on Foundry 14 levels: each token's level is tested, at its height, with the surfaces between", async () => {
  const { hasLineOfSight, levelOf, elevatedCenter } = await import("../scripts/native/advantage.mjs");
  const calls = [], surfaces = [];
  const ground = { id: "ground" }, upper = { id: "upper" };
  const levelScene = { levels: new Map([["ground", ground], ["upper", upper]]),
    testSurfaceCollision: (from, to, o) => { surfaces.push([from.elevation, to.elevation, o.level.id]); return from.elevation !== to.elevation && floorBetween; } };
  let floorBetween = true, blockedOn = null;
  const saved = CONFIG.Canvas;
  CONFIG.Canvas = { polygonBackends: { sight: { testCollision: (from, to, o) => { calls.push([o.level?.id ?? null, from.elevation, to.elevation]); return o.level?.id === blockedOn; } } } };
  const token = (level, elevation, x) => ({ parent: levelScene, x, y: 0, width: 1, height: 1, depth: 1, elevation, _source: { level } });
  try {
    const archer = token("ground", 0, 0), lookout = token("upper", 10, 300), guard = token("ground", 0, 300);
    assert.equal(levelOf(archer), ground);
    assert.deepEqual(elevatedCenter(lookout), { x: 350, y: 50, elevation: 12.5 });   // its elevation plus half its depth

    // Same level, nothing in the way.
    assert.equal(hasLineOfSight(archer, guard), true);
    assert.deepEqual(calls, [["ground", 2.5, 2.5]]);
    // A wall on the guard's level only counts on that level's test.
    calls.length = 0; blockedOn = "ground";
    assert.equal(hasLineOfSight(archer, guard), false);
    blockedOn = null;
    // A floor between the levels blocks; with an opening in it, both levels' walls are checked.
    assert.equal(hasLineOfSight(archer, lookout), false);
    floorBetween = false; calls.length = 0;
    assert.equal(hasLineOfSight(archer, lookout), true);
    assert.deepEqual(calls.map(c => c[0]), ["ground", "upper"]);
    blockedOn = "upper";
    assert.equal(hasLineOfSight(archer, lookout), false);                             // a wall up there

    // A scene without levels: one test, as before.
    calls.length = 0; blockedOn = null;
    const flat = { x: 0, y: 0, width: 1, height: 1, elevation: 0, parent: {} };
    assert.equal(hasLineOfSight(flat, { ...flat, x: 300 }), true);
    assert.deepEqual(calls, [[null, 2.5, 2.5]]);
  } finally {
    CONFIG.Canvas = saved;
  }
});
