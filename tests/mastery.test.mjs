// Weapon Mastery, Legendary Resistance and automatic critical hits.
import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { applyWeaponMastery, pushDestination, MASTERY_FLAG, MASTERY_RESULT_FLAG } from "../scripts/native/mastery.mjs";
import { offerLegendaryResistance, breakConcentrationIfFailed } from "../scripts/native/checks.mjs";
import { onPreRollDamage, attackReasons } from "../scripts/native/advantage.mjs";

const { settings, makeToken, prompts, uuids } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

// A square grid in feet: 5 ft spaces, diagonals 5 ft.
canvas.grid = {
  isGridless: false, distance: 5, size: 100, units: "ft",
  getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
  measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5 }),
  getSnappedPoint: (p) => ({ x: Math.round(p.x / 100) * 100, y: Math.round(p.y / 100) * 100 })
};
CONFIG.Canvas = { polygonBackends: { sight: { testCollision: () => false }, move: { testCollision: () => false } } };

beforeEach(() => {
  env.reset();
  settings.weaponMastery = true;
  game.users = [game.user];
  game.modules.delete("automated-conditions-5e");
});

let seq = 0;
/** A creature on the grid at (col, row), owned by the GM, with tracked changes. */
function creature(name, col, row = 0, { disposition = -1, statuses = [], size = "med", str = 16, saves = [] } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const d = token.document;
  Object.assign(d, { x: col * 100, y: row * 100, elevation: 0, width: 1, height: 1, isOwner: true,
    getOccupiedGridSpaceOffsets: () => [{ i: row, j: col }],
    async update(u) { Object.assign(d, u); d.updates = (d.updates ?? 0) + 1; } });
  const actor = d.actor;
  const effects = [];
  Object.assign(actor, {
    name, isOwner: true, statuses: new Set(statuses), items: [],
    effects: Object.assign(effects, { get: (id) => effects.find(e => e.id === id) }),
    system: { traits: { size }, abilities: { str: { value: str, mod: Math.floor((str - 10) / 2) } }, attributes: { prof: 2 } },
    getActiveTokens: () => [d], testUserPermission: () => false,
    created: [], toggled: [],
    async createEmbeddedDocuments(type, data) { actor.created.push(...data); return data; },
    async toggleStatusEffect(id, { active }) { actor.toggled.push([id, active]); if (active) actor.statuses.add(id); },
    async rollSavingThrow(config, dialog, message) {
      actor.saveMessages = [...(actor.saveMessages ?? []), message];
      const passed = saves.shift() ?? false;
      return [{ parent: { id: `save${++seq}`, rolls: [{ isSuccess: passed, total: passed ? 15 : 3 }], system: {} } }];
    }
  });
  uuids.set(actor.uuid, actor);
  return { token, doc: d, actor };
}
/** An attack card with a mastery, against these hits / misses. */
function card(mastery, { hits = [], misses = [], ability = "str" } = {}) {
  const flags = {};
  const target = (c, isMiss) => ({ actor: c.actor.uuid, token: c.doc.uuid, name: c.actor.name, ac: 13, isMiss });
  return {
    flags, rolls: [{ options: { ability } }],
    system: { mastery, ability, evaluatedTargets: [...hits.map(c => target(c, false)), ...misses.map(c => target(c, true))] },
    getFlag: (_m, k) => flags[k], async setFlag(_m, k, v) { flags[k] = v; }
  };
}
function weaponAttack(attacker) {
  return { uuid: "Actor.a.Item.w.Activity.x", type: "attack", actor: attacker.actor, getUsageToken: () => attacker.doc,
    item: { name: "Maul", system: { properties: new Set() } }, damage: { parts: [{ types: new Set(["bludgeoning"]) }] } };
}

// ── Weapon Mastery ──
test("Topple: a Constitution save (DC 8 + mod + proficiency); a failure knocks it Prone", async () => {
  const fighter = creature("Fighter", 0, 0, { disposition: 1, str: 16 });
  const orc = creature("Orc", 1, 0, { saves: [false] });
  const elf = creature("Elf", 1, 1, { saves: [true] });
  const message = card("topple", { hits: [orc, elf] });
  await applyWeaponMastery(message, weaponAttack(fighter));
  assert.deepEqual(orc.actor.toggled, [["prone", true]]);
  assert.deepEqual(elf.actor.toggled, []);
  assert.equal(orc.actor.saveMessages[0].data.flavor, "Weapon Mastery: Topple (Maul) — con Saving Throw");
  assert.match(message.flags[MASTERY_RESULT_FLAG].text, /DC 13 — Orc\d* knocked Prone; Elf\d* kept its footing/);
});

test("Graze: on a miss, the ability modifier as the weapon's damage type", async () => {
  const fighter = creature("Fighter", 0, 0, { disposition: 1, str: 16 });
  const orc = creature("Orc", 1, 0);
  let posted = null;
  CONFIG.Dice.DamageRoll.toMessage = async (rolls, data) => { posted = { rolls, data }; return { id: "graze", rolls }; };
  const message = card("graze", { misses: [orc] });
  await applyWeaponMastery(message, weaponAttack(fighter));
  assert.equal(posted.rolls[0].formula, "3");
  assert.equal(posted.rolls[0].options.type, "bludgeoning");
  assert.equal(posted.data.system.targets[0].token, orc.doc.uuid);
  assert.match(message.flags[MASTERY_RESULT_FLAG].text, /grazed for 3/);
  // No modifier, no graze.
  posted = null;
  await applyWeaponMastery(card("graze", { misses: [orc] }), weaponAttack(creature("Weakling", 0, 2, { disposition: 1, str: 10 })));
  assert.equal(posted, null);
});

test("Sap and Slow mark the target; Vex marks the attacker; effects expire on the attacker's turn", async () => {
  const fighter = creature("Fighter", 0, 0, { disposition: 1 });
  const orc = creature("Orc", 1, 0);
  await applyWeaponMastery(card("sap", { hits: [orc] }), weaponAttack(fighter));
  const [sap] = orc.actor.created;
  assert.equal(sap.flags[MODULE_ID][MASTERY_FLAG].kind, "sap");
  assert.equal(sap.duration.expiry, "sourceStart");
  assert.equal(sap.origin, fighter.actor.uuid);

  await applyWeaponMastery(card("slow", { hits: [orc] }), weaponAttack(fighter));
  const slow = orc.actor.created[1];
  assert.deepEqual(slow.system.changes, [{ key: "system.attributes.movement.speeds.walk", type: "add", value: -10 }]);

  await applyWeaponMastery(card("vex", { hits: [orc] }), weaponAttack(fighter));
  const [vex] = fighter.actor.created;
  assert.equal(vex.flags[MODULE_ID][MASTERY_FLAG].target, orc.doc.uuid);
  assert.equal(vex.duration.expiry, "sourceEnd");
});

test("Push: offered for Large or smaller; moves 10 ft straight away", async () => {
  const fighter = creature("Fighter", 0, 0, { disposition: 1 });
  const orc = creature("Orc", 1, 0);
  const giant = creature("Giant", 0, 1, { size: "huge" });
  prompts.choice = async () => "push";
  await applyWeaponMastery(card("push", { hits: [orc, giant] }), weaponAttack(fighter));
  assert.equal(orc.doc.x, 300);                       // 2 spaces further along +x
  assert.equal(giant.doc.updates, undefined);         // Huge: not pushed
  assert.deepEqual(pushDestination(fighter.doc, orc.doc, 10)?.feet, 10);
});

test("no mastery, the setting off, or a miss for hit-only masteries: nothing happens", async () => {
  const fighter = creature("Fighter", 0, 0, { disposition: 1 });
  const orc = creature("Orc", 1, 0);
  await applyWeaponMastery(card(undefined, { hits: [orc] }), weaponAttack(fighter));
  await applyWeaponMastery(card("sap", { misses: [orc] }), weaponAttack(fighter));
  settings.weaponMastery = false;
  await applyWeaponMastery(card("sap", { hits: [orc] }), weaponAttack(fighter));
  assert.equal(orc.actor.created.length, 0);
});

test("Sap and Vex in the advantage checks, used up by the attack", () => {
  settings.attackAdvantage = true;
  const fighter = creature("Fighter", 0, 0, { disposition: 1 });
  const orc = creature("Orc", 1, 0);
  const mark = (kind, target) => ({ uuid: `E.${kind}`, disabled: false, getFlag: (m, k) => m === MODULE_ID && k === MASTERY_FLAG ? { kind, target } : undefined });
  canvas.tokens.setTargets([orc.token.id]);
  orc.actor.effects.push(mark("sap"));
  const sapped = attackReasons({ type: "attack", actor: orc.actor, item: { type: "weapon", system: { range: {}, properties: new Set(), type: {} } },
    attack: { type: { value: "melee", classification: "weapon" } }, getUsageToken: () => orc.doc });
  fighter.actor.effects.push(mark("vex", orc.doc.uuid));
  const vexed = attackReasons({ type: "attack", actor: fighter.actor, item: { type: "weapon", system: { range: {}, properties: new Set(), type: {} } },
    attack: { type: { value: "melee", classification: "weapon" } }, getUsageToken: () => fighter.doc });
  assert.ok(sapped.disadvantage.includes("Sapped"));
  assert.deepEqual(sapped.consume, ["E.sap"]);
  assert.ok(vexed.advantage.includes("Vex"));
  assert.deepEqual(vexed.consume, ["E.vex"]);
});

// ── Automatic critical hits ──
test("auto-crit: damage against Paralyzed / Unconscious targets from within 5 ft; left to AC5E when it automates statuses", () => {
  settings.autoCrits = true;
  const fighter = creature("Fighter", 0, 0, { disposition: 1 });
  const held = creature("Held", 1, 0, { statuses: ["paralyzed"] });
  const far = creature("Far", 4, 0, { statuses: ["unconscious"] });
  const activity = { type: "attack", actor: fighter.actor, getUsageToken: () => fighter.doc };
  const roll = (targets) => { const config = { subject: activity, isCritical: false };
    onPreRollDamage(config, {}, { data: { system: { targets: targets.map(t => ({ token: t.doc.uuid })) } } }); return config.isCritical; };
  assert.equal(roll([held]), true);
  assert.equal(roll([far]), false);                    // not within 5 ft
  assert.equal(roll([held, far]), false);              // all of them must qualify
  game.modules.set("automated-conditions-5e", { active: true });
  const get = game.settings.get;
  game.settings.get = (scope, key) => scope === "automated-conditions-5e" ? key === "automateStatuses" : get(scope, key);
  try { assert.equal(roll([held]), false); } finally { game.settings.get = get; }
  settings.autoCrits = false;
  game.modules.delete("automated-conditions-5e");
  assert.equal(roll([held]), false);
});

// ── Legendary Resistance ──
function saveCard({ canResist = true, total = 8, dc = 15 } = {}) {
  return { type: "save", system: { canResist, type: "save" }, rolls: [{ total, options: { target: dc }, isFailure: total < dc }], speakerActor: null,
    updates: [], async update(u) { this.updates.push(u); } };
}
function dragon({ value = 3, max = 3 } = {}) {
  const actor = { name: "Dragon", isOwner: true, used: 0,
    system: { resources: { legres: { value, max } }, async resistSave(message) { actor.used++; message.system.resisted = true; } },
    async endConcentration() { actor.ended = true; return [{}]; } };
  return actor;
}

test("Legendary Resistance: asked or automatic; turns the failure into a success through dnd5e", async () => {
  const wyrm = dragon();
  settings.legendaryResistance = "prompt";
  let asked = null;
  prompts.choice = async (_t, content) => { asked = content; return "use"; };
  const message = saveCard();
  assert.equal(await offerLegendaryResistance(message, wyrm), true);
  assert.match(asked, /failed its saving throw\s+\(8 vs DC 15\)[\s\S]*3 of 3 left/);
  assert.equal(message.system.resisted, true);

  prompts.choice = async () => "fail";
  assert.equal(await offerLegendaryResistance(saveCard(), wyrm), false);

  settings.legendaryResistance = "auto";
  prompts.choice = async () => { throw new Error("no prompt in auto mode"); };
  assert.equal(await offerLegendaryResistance(saveCard(), wyrm), true);
  assert.equal(wyrm.used, 2);
});

test("Legendary Resistance: not when dnd5e says it can't, not for players, not when off; a resisted concentration save doesn't break", async () => {
  const wyrm = dragon();
  settings.legendaryResistance = "auto";
  assert.equal(await offerLegendaryResistance(saveCard({ canResist: false }), wyrm), false);
  game.user.isGM = false;
  assert.equal(await offerLegendaryResistance(saveCard(), wyrm), false);
  game.user.isGM = true;
  settings.legendaryResistance = "off";
  assert.equal(await offerLegendaryResistance(saveCard(), wyrm), false);
  assert.equal(wyrm.used, 0);

  settings.concentrationBreak = true;
  const resisted = { ...saveCard(), system: { canResist: false, resisted: true } };
  await breakConcentrationIfFailed(resisted, wyrm);
  assert.equal(wyrm.ended, undefined);
});

// ── Reasons that hold with Automated Conditions 5e ──
import { onPreRollAttack, applyFinalAttackMode, ATTACK_REASONS_FLAG } from "../scripts/native/advantage.mjs";
import { skipAutoRolledDamageDialog } from "../scripts/native/autoroll.mjs";

function vexAttack() {
  const fighter = creature("Fighter", 0, 0, { disposition: 1 });
  const orc = creature("Orc", 1, 0);
  fighter.actor.effects.push({ uuid: "E.vex", disabled: false,
    getFlag: (m, k) => m === MODULE_ID && k === MASTERY_FLAG ? { kind: "vex", target: orc.doc.uuid } : undefined });
  canvas.tokens.setTargets([orc.token.id]);
  const activity = { type: "attack", actor: fighter.actor, getUsageToken: () => fighter.doc,
    item: { type: "weapon", system: { range: {}, properties: new Set(), type: {} } }, attack: { type: { value: "melee", classification: "weapon" } } };
  return { activity, fighter, orc };
}
/** A built roll's d20, recording the mode it's given. */
const builtRoll = (mode) => { const roll = { options: { advantageMode: mode }, d20: { applied: null, applyAdvantage(m) { this.applied = m; } }, resetFormula() { this.reset = true; } }; return roll; };

test("Vex holds over AC5E's 'normal' verdict (it writes advantage + disadvantage), and is kept to the end", () => {
  settings.attackAdvantage = true;
  game.modules.set("automated-conditions-5e", { active: true });
  try {
    const { activity } = vexAttack();
    const config = { subject: activity, rolls: [{ options: { advantage: true, disadvantage: true,
      "automated-conditions-5e": { hasTransitAdvantage: false, hasTransitDisadvantage: false } } }] };
    const dialog = { options: {} }, message = {};
    onPreRollAttack(config, dialog, message);
    assert.equal(config.advantage, true);
    assert.equal(config.disadvantage, false);
    assert.equal(config.rolls[0].options.disadvantage, false);
    assert.equal(dialog.options.defaultButton, "advantage");
    const reasons = message.data.flags[MODULE_ID][ATTACK_REASONS_FLAG];
    assert.equal(reasons.finalMode, 1);

    // After AC5E's post-configuration put its own mode back on the built roll:
    const skipped = builtRoll(0);
    applyFinalAttackMode([skipped], config, { configure: false }, message);
    assert.equal(skipped.d20.applied, 1);
    assert.equal(skipped.options.advantageMode, 1);
    // A choice made in the roll window stands.
    const chosen = builtRoll(0);
    applyFinalAttackMode([chosen], config, { configure: true }, message);
    assert.equal(chosen.d20.applied, null);
  } finally { game.modules.delete("automated-conditions-5e"); }
});

test("our advantage and AC5E's disadvantage cancel to normal; dnd5e's own sources count without AC5E", () => {
  settings.attackAdvantage = true;
  game.modules.set("automated-conditions-5e", { active: true });
  try {
    const { activity } = vexAttack();
    const config = { subject: activity, rolls: [{ options: { "automated-conditions-5e": { hasTransitAdvantage: false, hasTransitDisadvantage: true } } }] };
    const message = {};
    onPreRollAttack(config, { options: {} }, message);
    assert.equal(message.data.flags[MODULE_ID][ATTACK_REASONS_FLAG].finalMode, 0);
  } finally { game.modules.delete("automated-conditions-5e"); }

  const { activity } = vexAttack();
  const poisoned = { subject: activity, rolls: [{ options: { disadvantage: true } }] };      // dnd5e: Poisoned
  const message = {};
  onPreRollAttack(poisoned, { options: {} }, message);
  assert.equal(message.data.flags[MODULE_ID][ATTACK_REASONS_FLAG].finalMode, 0);
});

test("Vex and Sap with only Weapon Mastery on (the advantage setting off)", () => {
  settings.attackAdvantage = false;
  const { activity } = vexAttack();
  const config = { subject: activity, rolls: [{ options: {} }] };
  onPreRollAttack(config, { options: {} }, {});
  assert.equal(config.advantage, true);
  settings.weaponMastery = false;
  const off = { subject: activity, rolls: [{ options: {} }] };
  onPreRollAttack(off, { options: {} }, {});
  assert.equal(off.advantage, undefined);
});

test("healing and damage-only activities the module applies skip dnd5e's damage window", () => {
  settings.healingAutomation = true;
  const heal = {};
  skipAutoRolledDamageDialog({ subject: { type: "heal" } }, heal);
  assert.equal(heal.configure, false);
  const damageOnlyOff = {};
  skipAutoRolledDamageDialog({ subject: { type: "damage" } }, damageOnlyOff);
  assert.equal(damageOnlyOff.configure, undefined);                  // damage-only automation off
  const attack = {};
  skipAutoRolledDamageDialog({ subject: { type: "attack" } }, attack);
  assert.equal(attack.configure, undefined);
  const forced = { configure: true };
  skipAutoRolledDamageDialog({ subject: { type: "heal" } }, forced);
  assert.equal(forced.configure, true);
});
