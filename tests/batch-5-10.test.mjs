// Opportunity attacks, the new reactions, retaliation, death saves, areas and the turn summary.
import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { meleeReach, leavesReach, onTokenMovedOA, onDisengageUsed, onTurnEndDisengage, DISENGAGED } from "../scripts/native/opportunity.mjs";
import { reactionOptions, offerReactions, damageReactions, onTurnStartReaction, REACTIONS_FLAG } from "../scripts/native/reactions.mjs";
import { retaliationsFor, recordAgathys, onActorUpdatedAgathys, AGATHYS_FLAG } from "../scripts/native/retaliation.mjs";
import { onPreApplyDamage, onDamageAppliedDeath, deathSaveResult, correctDeathSave, onPostRollDeathSave } from "../scripts/native/deathsaves.mjs";
import { rememberAreas, clearAreasForUse, onPreDeleteRegion, flashRollsRemovesAreas } from "../scripts/native/areas.mjs";
import { summaryLines } from "../scripts/native/turn-summary.mjs";
import { LINGERING_FLAG } from "../scripts/native/lingering.mjs";

const { settings, makeToken, prompts, uuids, scene, rollResults } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

canvas.grid = {
  isGridless: false, distance: 5, size: 100, units: "ft",
  getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
  measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5 })
};
CONFIG.Canvas = { polygonBackends: { sight: { testCollision: () => false }, move: { testCollision: () => false } } };

beforeEach(() => {
  env.reset();
  game.users = [game.user];
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => game.user } } });
  game.modules.delete("flash-rolls-5e");
  game.combat = null;
  scene.regions = [];
});

let seq = 0;
/** A token at (col, row) whose occupied space follows its x / y; its actor with tracked changes. */
function creature(name, col, row = 0, { disposition = -1, statuses = [], items = [], type = "npc", hp = 20, max = 20, temp = 0, prof = 2 } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const d = token.document;
  Object.assign(d, { x: col * 100, y: row * 100, elevation: 0, width: 1, height: 1, isOwner: true,
    getOccupiedGridSpaceOffsets: (data = {}) => [{ i: Math.round((data.y ?? d.y) / 100), j: Math.round((data.x ?? d.x) / 100) }] });
  const actor = d.actor;
  const effects = [];
  Object.assign(actor, {
    name, type, isOwner: true, statuses: new Set(statuses), items, flags: {},
    effects: Object.assign(effects, { get: (id) => effects.find(e => e.id === id) }),
    system: { attributes: { prof, hp: { value: hp, max, temp }, death: { success: 0, failure: 0 } } },
    getActiveTokens: () => [d], testUserPermission: () => false,
    toggled: [], async toggleStatusEffect(id, { active }) { actor.toggled.push([id, active]); active ? actor.statuses.add(id) : actor.statuses.delete(id); },
    getFlag: (m, k) => actor.flags[m]?.[k], async setFlag(m, k, v) { (actor.flags[m] ??= {})[k] = v; }, async unsetFlag(m, k) { delete actor.flags[m]?.[k]; },
    updates: [], async update(u) { actor.updates.push(u); }
  });
  uuids.set(actor.uuid, actor);
  return { token, doc: d, actor };
}
/** A melee weapon with an attack activity (reach in ft; or the Reach property). */
function weapon(name, { reach = null, rch = false, finesse = false } = {}) {
  const attacks = [];
  const activity = { uuid: `Item.${name}.Activity.a`, type: "attack", attack: { type: { value: "melee", classification: "weapon" } },
    item: null, async rollAttack(...args) { attacks.push({ args, targets: [...game.user.targets].map(t => t.id) }); return [{}]; } };
  const item = { name, type: "weapon", system: { equipped: true, range: { reach }, properties: new Set([...(rch ? ["rch"] : []), ...(finesse ? ["fin"] : [])]),
    activities: new Map([["a", activity]]) } };
  activity.item = item;
  uuids.set(activity.uuid, activity);
  return { item, activity, attacks };
}
const feat = (identifier, { type = "feat", level = 0, onUse } = {}) => {
  const used = [];
  const activity = { activation: { type: "reaction" }, effects: [], async use(...args) { used.push(args); return onUse ? onUse() : { message: { system: {} } }; },
    async rollDamage() { return [{ total: rollResults.shift() ?? 4 }]; } };
  return { name: identifier, type, used, system: { identifier, level, activities: new Map([["r", activity]]) } };
};

// ── Opportunity attacks ──
test("reach: 5 ft, the Reach property, or the weapon's reach", () => {
  assert.equal(meleeReach({ items: [weapon("Mace").item] }).reach, 5);
  assert.equal(meleeReach({ items: [weapon("Mace").item, weapon("Glaive", { rch: true }).item] }).reach, 10);
  assert.equal(meleeReach({ items: [] }), null);
});

test("leaving reach along the path, not staying in it or starting outside it", () => {
  const orc = creature("Orc", 0, 0);
  const pip = creature("Pip", 1, 0, { disposition: 1 });
  const path = (...cols) => cols.map(c => ({ x: c * 100, y: 0 }));
  assert.equal(leavesReach(orc.doc, pip.doc, path(1, 3), 5), true);
  assert.equal(leavesReach(orc.doc, pip.doc, path(1, 1), 5), false);
  assert.equal(leavesReach(orc.doc, pip.doc, path(3, 6), 5), false);
  assert.equal(leavesReach(orc.doc, pip.doc, path(1, 2), 10), false);  // still within a 10 ft reach
});

test("an opportunity attack is offered, made at the mover, and uses the reaction", async () => {
  settings.opportunityAttacks = true;
  const axe = weapon("Axe");
  const orc = creature("Orc", 0, 0, { items: [axe.item] });
  const pip = creature("Pip", 1, 0, { disposition: 1 });
  let asked = null;
  prompts.choice = async (_t, content) => { asked = content; return "attack"; };
  const move = { origin: { x: 100, y: 0 }, passed: { waypoints: [{ x: 300, y: 0, action: "walk" }] } };
  await onTokenMovedOA(pip.doc, move, {});
  assert.match(asked, /Pip<\/strong> is leaving <strong>Orc<\/strong>'s reach/);
  assert.equal(axe.attacks.length, 1);
  assert.deepEqual(axe.attacks[0].targets, [pip.token.id]);
  assert.match(axe.attacks[0].args[2].data.flavor, /Opportunity Attack/);
  // Reaction spent: not offered again until its turn.
  await onTokenMovedOA(pip.doc, move, {});
  assert.equal(axe.attacks.length, 1);
  onTurnStartReaction({ scene }, { tokenId: orc.token.id });
  await onTokenMovedOA(pip.doc, move, {});
  assert.equal(axe.attacks.length, 2);
});

test("no opportunity attack: Disengaged, teleporting, being pushed, allies, the setting off", async () => {
  settings.opportunityAttacks = true;
  const axe = weapon("Axe");
  creature("Orc", 0, 0, { items: [axe.item] });
  const pip = creature("Pip", 1, 0, { disposition: 1 });
  creature("Ally", 0, 1, { disposition: 1, items: [weapon("Sword").item] });
  prompts.choice = async () => "attack";
  const walk = { origin: { x: 100, y: 0 }, passed: { waypoints: [{ x: 300, y: 0, action: "walk" }] } };
  await onTokenMovedOA(pip.doc, { ...walk, passed: { waypoints: [{ x: 300, y: 0, action: "blink" }] } }, {});
  await onTokenMovedOA(pip.doc, walk, { [MODULE_ID]: { forced: true } });
  pip.actor.statuses.add(DISENGAGED);
  await onTokenMovedOA(pip.doc, walk, {});
  pip.actor.statuses.delete(DISENGAGED);
  settings.opportunityAttacks = false;
  await onTokenMovedOA(pip.doc, walk, {});
  assert.equal(axe.attacks.length, 0);
});

test("Disengage features give Disengaged; it ends with the creature's turn", async () => {
  settings.opportunityAttacks = true;
  const rogue = creature("Rogue", 0, 0, { disposition: 1 });
  await onDisengageUsed({ name: "Disengage", item: { name: "Cunning Action" }, actor: rogue.actor });
  assert.ok(rogue.actor.statuses.has(DISENGAGED));
  await onDisengageUsed({ name: "Dash", item: { name: "Cunning Action" }, actor: creature("Other", 3, 3).actor });
  await onTurnEndDisengage({ started: true, scene }, { tokenId: rogue.token.id });
  assert.ok(!rogue.actor.statuses.has(DISENGAGED));
});

// ── Reactions ──
test("Defensive Duelist: a melee hit, a finesse weapon, +proficiency would make it miss", () => {
  const duelist = { items: [feat("defensive-duelist"), weapon("Rapier", { finesse: true }).item], system: { attributes: { prof: 3 } } };
  assert.deepEqual(reactionOptions(duelist, { total: 16, ac: 15, melee: true }, "hit"), ["defensive-duelist"]);
  assert.deepEqual(reactionOptions(duelist, { total: 16, ac: 15, melee: false }, "hit"), []);
  assert.deepEqual(reactionOptions(duelist, { total: 19, ac: 15, melee: true }, "hit"), []);
});

test("Cutting Words from an ally of the target turns a hit into a miss", async () => {
  settings.reactionPrompts = "all";
  const orc = creature("Orc", 0, 0);
  const pip = creature("Pip", 1, 0, { disposition: 1 });
  const bard = creature("Bard", 2, 0, { disposition: 1, items: [feat("cutting-words")] });
  bard.actor.system.scale = { bard: { "bardic-inspiration": { die: "d8" } } };
  prompts.choice = async (_t, content, buttons) => buttons.find(b => b.action === "cutting-words") ? "cutting-words" : "none";
  rollResults.push(5);
  const message = {
    rolls: [{ total: 16, options: {} }], flags: {},
    system: { targets: [{ actor: pip.actor.uuid, token: pip.doc.uuid, name: "Pip", ac: 15 }] },
    getFlag: (_m, k) => message.flags[k],
    async update(u) { if (u.rolls) message.rolls = u.rolls; if (u["system.targets"]) message.system.targets = u["system.targets"];
      for (const [k, v] of Object.entries(u)) if (k.startsWith("flags.")) message.flags[k.split(".").pop()] = v; }
  };
  await offerReactions(message, { actor: orc.actor, item: { name: "Club" }, attack: { type: { value: "melee" } }, getUsageToken: () => orc.doc });
  assert.equal(message.rolls[0].total, 11);
  assert.match(message.flags[REACTIONS_FLAG][0].reaction, /Cutting Words .*\(16 → 11\)/);
  assert.equal(bard.actor.items[0].used.length, 1);
});

test("Absorb Elements halves the elemental damage; Parry reduces it", async () => {
  settings.reactionPrompts = "all";
  const mage = creature("Mage", 0, 0, { disposition: 1, items: [feat("absorb-elements", { type: "spell", level: 1 })] });
  mage.actor.system.spells = { spell1: { value: 1 } };
  prompts.choice = async () => "absorb-elements";
  const damage = [{ value: 10, type: "fire", properties: [] }, { value: 4, type: "piercing", properties: [] }];
  const absorbed = await damageReactions({}, { token: mage.doc.uuid, actor: mage.actor.uuid }, damage);
  assert.deepEqual(absorbed.damages.map(d => d.value), [5, 4]);

  const fighter = creature("Fighter", 1, 1, { disposition: 1, items: [feat("parry")] });
  prompts.choice = async () => "parry";
  rollResults.push(7);
  const melee = { getAssociatedActivity: () => ({ type: "attack", attack: { type: { value: "melee" } } }), rolls: [{ options: {} }] };
  const parried = await damageReactions(melee, { token: fighter.doc.uuid, actor: fighter.actor.uuid }, [{ value: 9, type: "slashing", properties: [] }]);
  assert.deepEqual(parried.damages.map(d => d.value), [2]);
  assert.match(parried.notes[0], /Parry/);
});

// ── Retaliation ──
test("Armor of Agathys (while its temp HP last) and Fire Shield (within 5 ft) hit back at a melee attacker", async () => {
  settings.retaliation = true;
  const orc = creature("Orc", 0, 0);
  const warlock = creature("Warlock", 1, 0, { disposition: 1, temp: 10 });
  await recordAgathys({ item: { uuid: "Actor.w.Item.aoa", system: { identifier: "armor-of-agathys" }, flags: {} }, actor: warlock.actor }, { scaling: 1 });
  assert.deepEqual(warlock.actor.flags[MODULE_ID][AGATHYS_FLAG], { item: "Actor.w.Item.aoa", scaling: 1 });
  const wizard = creature("Wizard", 0, 1, { disposition: 1 });
  wizard.actor.effects.push({ name: "Warm Shield", disabled: false });
  const far = creature("Far", 5, 5, { disposition: 1 });
  far.actor.effects.push({ name: "Chill Shield", disabled: false });
  const hit = (c) => ({ actor: c.actor.uuid, token: c.doc.uuid, name: c.actor.name, isMiss: false });
  const message = { system: { evaluatedTargets: [hit(warlock), hit(wizard), hit(far)] } };
  const list = await retaliationsFor(message, { attack: { type: { value: "melee" } }, getUsageToken: () => orc.doc, actor: orc.actor });
  assert.deepEqual(list.map(r => [r.kind, r.type ?? null]), [["agathys", null], ["fireShield", "fire"]]);   // Far isn't within 5 ft
  // Ranged: nothing.
  assert.deepEqual(await retaliationsFor(message, { attack: { type: { value: "ranged" } }, getUsageToken: () => orc.doc }), []);
  // Temp HP gone: Agathys ends.
  await onActorUpdatedAgathys(warlock.actor, { system: { attributes: { hp: { temp: 0 } } } });
  assert.equal(warlock.actor.flags[MODULE_ID][AGATHYS_FLAG], undefined);
});

// ── Death saves ──
test("damage at 0 HP: a failed death save, two on a crit; at or past the HP maximum (or massive damage): death", async () => {
  settings.deathSaves = true;
  const dying = creature("Pip", 0, 0, { type: "character", hp: 0, max: 20 });
  const updates = {};
  onPreApplyDamage(dying.actor, 5, updates, {});
  assert.equal(updates["system.attributes.death.failure"], 1);
  const crit = {};
  onPreApplyDamage(dying.actor, 5, crit, { originatingMessage: { rolls: [{ isCritical: true }] } });
  assert.equal(crit["system.attributes.death.failure"], 2);
  const huge = {};
  onPreApplyDamage(dying.actor, 25, huge, {});
  assert.equal(huge["system.attributes.death.failure"], 3);
  await onDamageAppliedDeath(dying.actor);
  assert.deepEqual(dying.actor.toggled, [["dead", true]]);

  const healthy = creature("Bo", 1, 0, { type: "character", hp: 8, max: 20 });
  const massive = {}, normal = {};
  onPreApplyDamage(healthy.actor, 28, massive, {});
  onPreApplyDamage(healthy.actor, 15, normal, {});
  assert.equal(massive["system.attributes.death.failure"], 3);
  assert.equal(normal["system.attributes.death.failure"], undefined);
  const npc = creature("Orc", 2, 0, { hp: 0 });
  const none = {};
  onPreApplyDamage(npc.actor, 5, none, {});
  assert.deepEqual(none, {});
});

test("Luck Dice turning a death save around: the first result undone, the new one recorded", async () => {
  const pip = creature("Pip", 0, 0, { type: "character", hp: 0 });
  pip.actor.system.attributes.death = { success: 1, failure: 2 };            // dnd5e recorded the failed roll (1 → 2)
  const card = { id: "ds1", system: { type: "death", deltas: { actor: [{ keyPath: "system.attributes.death.failure", delta: 1 }] } },
    rolls: [{ total: 12, options: { target: 10 }, isCritical: false, isFumble: false }], updated: null,
    async update(u) { this.updated = u; } };
  onPostRollDeathSave([{ parent: card }], { message: card });
  const changed = await correctDeathSave(card, pip.actor, { isSuccess: false, isCritical: false, isFumble: false });
  assert.equal(changed, true);
  assert.deepEqual(pip.actor.updates[0], { "system.attributes.death.success": 2, "system.attributes.death.failure": 1 });
  assert.deepEqual(deathSaveResult({ success: 2, failure: 0 }, { isSuccess: true }).outcome, "stable");
  assert.deepEqual(deathSaveResult({ success: 0, failure: 2 }, { isSuccess: false, isFumble: true }).outcome, "death");
});

// ── Areas ──
function areaRegion(id, { lingering } = {}) {
  const r = { id, uuid: `Scene.s.Region.${id}`, documentName: "Region", isOwner: true, deleted: false, flags: {},
    getFlag: (m, k) => r.flags[m]?.[k], async delete(options) { r.deleted = options; } };
  if (lingering) r.flags[MODULE_ID] = { [LINGERING_FLAG]: lingering };
  uuids.set(r.uuid, r);
  return r;
}

test("an instantaneous spell's area is cleared once resolved; lingering and lasting ones stay; Flash Rolls takes over", async () => {
  settings.clearInstantAreas = true;
  const fireball = { item: { system: { identifier: "fireball", duration: { units: "inst" } } } };
  const r1 = areaRegion("r1");
  rememberAreas(fireball, { templates: [r1], message: { id: "u1" } });
  await clearAreasForUse("u1");
  assert.ok(r1.deleted);
  const fog = { item: { system: { identifier: "fog-cloud", duration: { units: "hour" } } } };
  const r2 = areaRegion("r2");
  rememberAreas(fog, { templates: [r2], message: { id: "u2" } });
  await clearAreasForUse("u2");
  assert.equal(r2.deleted, false);

  game.modules.set("flash-rolls-5e", { active: true });
  const get = game.settings.get;
  game.settings.get = (scope, key) => scope === "flash-rolls-5e" ? key === "remove-template" : get(scope, key);
  try {
    assert.equal(flashRollsRemovesAreas(), true);
    const r3 = areaRegion("r3");
    rememberAreas(fireball, { templates: [r3], message: { id: "u3" } });
    await clearAreasForUse("u3");
    assert.equal(r3.deleted, false);
  } finally { game.settings.get = get; }
});

test("a lingering area is kept while its spell lasts (Shift deletes it anyway)", () => {
  uuids.set("Actor.c.ActiveEffect.conc", {});
  const live = areaRegion("live", { lingering: { concentration: "Actor.c.ActiveEffect.conc" } });
  const ended = areaRegion("ended", { lingering: { concentration: "Actor.c.ActiveEffect.gone" } });
  assert.equal(onPreDeleteRegion(live, {}), false);
  assert.equal(onPreDeleteRegion(ended, {}), undefined);
  assert.equal(onPreDeleteRegion(live, { [MODULE_ID]: { allow: true } }), undefined);
  game.keyboard = { downKeys: new Set(["ShiftLeft"]) };
  try { assert.equal(onPreDeleteRegion(live, {}), undefined); } finally { delete game.keyboard; }
});

// ── Turn summary ──
test("the turn summary lists effects, concentration, death saves and legendary pools", () => {
  const pip = creature("Pip", 0, 0, { type: "character", hp: 0 });
  pip.actor.effects.push({ name: "Bless", disabled: false, duration: { label: "9 rounds" } });
  pip.actor.concentration = { effects: new Set([{ name: "Concentrating: Hold Person" }]) };
  pip.actor.system.attributes.death = { success: 1, failure: 2 };
  const lines = summaryLines(pip.doc).join("\n");
  assert.match(lines, /Bless[\s\S]*9 rounds/);
  assert.match(lines, /Concentrating:<\/strong> Hold Person/);
  assert.match(lines, /1 success\(es\), 2 failure\(s\)/);
  const dragon = creature("Dragon", 1, 0);
  dragon.actor.system.resources = { legact: { value: 3, max: 3 }, legres: { value: 2, max: 3 } };
  assert.match(summaryLines(dragon.doc).join("\n"), /Legendary actions:<\/strong> 3 of 3[\s\S]*resistance:<\/strong> 2 of 3/);
  assert.deepEqual(summaryLines(creature("Plain", 2, 0).doc), []);
});
