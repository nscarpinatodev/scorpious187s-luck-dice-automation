// Opportunity attacks, the new reactions, retaliation, death saves, areas and the turn summary.
import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { meleeReach, leavesReach, onPreMoveTokenOA, moveWithOpportunityAttacks, opportunityReactors, reachExit, splitPath, answerOpportunity, onDisengageUsed, onTurnEndDisengage, DISENGAGED } from "../scripts/native/opportunity.mjs";
import { reactionOptions, offerReactions, damageReactions, onTurnStartReaction, onCombatEndedReactions, hasReaction, REACTION_USED, REACTIONS_FLAG } from "../scripts/native/reactions.mjs";
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

// A started combat with everyone in it, and a mover whose legs are recorded (and that really gets there).
// Foundry 14's getCombatantsByToken (the singular before it: see the stock effects test).
function inCombat() { game.combat = { started: true, getCombatantsByToken: () => [{}] }; }
function legged(mover) {
  mover.legs = [];
  mover.doc.move = async (waypoints, options) => {
    mover.legs.push({ to: waypoints.map(w => w.x), options });
    Object.assign(mover.doc, { x: waypoints.at(-1).x, y: waypoints.at(-1).y });
    return true;
  };
  return mover;
}
const reactorsOf = (mover, path) => opportunityReactors(mover.doc, path);
const walkTo = (...cols) => cols.map((c, i) => ({ x: c * 100, y: 0, action: "walk", ...(i === 0 ? {} : {}) }));

test("the mover stops at the last spot in reach: the attack is rolled there, then it carries on", async () => {
  settings.opportunityAttacks = true;
  inCombat();
  const glaive = weapon("Glaive", { rch: true });                          // 10 ft reach
  const orc = creature("Orc", 0, 0, { items: [glaive.item] });
  const pip = legged(creature("Pip", 1, 0, { disposition: 1 }));
  let at = null;
  prompts.choice = async () => { at = pip.doc.x; return "attack"; };
  const path = walkTo(1, 5);
  await moveWithOpportunityAttacks(pip.doc, path, reactorsOf(pip, path));
  assert.equal(at, 200);                                                   // still within the orc's 10 ft
  assert.equal(glaive.attacks.length, 1);
  assert.deepEqual(glaive.attacks[0].targets, [pip.token.id]);
  assert.match(glaive.attacks[0].args[2].data.flavor, /Opportunity Attack/);
  assert.deepEqual(pip.legs.map(l => l.to), [[200], [500]]);
  assert.equal(pip.doc.x, 500);
  // Every leg is marked, so it isn't caught again.
  assert.ok(pip.legs.every(l => l.options[MODULE_ID].opportunityLeg));
  assert.equal(orc.actor.statuses.has(REACTION_USED), true);
});

test("dnd5e 6.1's stock effects: No Opportunity Attacks and No Reactions keep an enemy from it; Disengaged provokes none", async () => {
  settings.opportunityAttacks = true;
  inCombat();
  const stock = (key, id, extra = {}) => ({ id, disabled: false, isSuppressed: false, _stats: { compendiumSource: `Compendium.dnd5e.effects.ActiveEffect.${key}` }, ...extra });
  const orc = creature("Orc", 0, 0, { items: [weapon("Axe").item] });
  const pip = creature("Pip", 1, 0, { disposition: 1 });
  const path = walkTo(1, 3);
  assert.equal(reactorsOf(pip, path).length, 1);
  game.combat = { started: true, getCombatantByToken: () => ({}) };      // before Foundry 14
  assert.equal(reactorsOf(pip, path).length, 1);
  inCombat();
  orc.actor.effects.push(stock("qfTVWq97wiQgSSSM", "noOA"));                 // Shocking Grasp: can't make them
  assert.equal(reactorsOf(pip, path).length, 0);
  orc.actor.effects[0].disabled = true;                                     // switched off: it counts no more
  assert.equal(reactorsOf(pip, path).length, 1);
  orc.actor.effects.splice(0, 1, stock("tZuPpkTWg8lVjxhL", "noR"));          // No Reactions
  assert.equal(reactorsOf(pip, path).length, 0);
  assert.equal(hasReaction(orc.actor), false);
  orc.actor.effects.length = 0;

  // A stock Disengaged (2024 Monk's Focus) provokes nothing, the module doesn't add its own, and both end with the turn.
  const walker = legged(creature("Walker", 1, 0, { disposition: 1 }));
  walker.actor.effects.push(stock("DovP6Uo8YmIohHeK", "dis", { _stats: { duplicateSource: "Compendium.dnd5e.effects.ActiveEffect.DovP6Uo8YmIohHeK" } }));
  const walk = { method: "dragging", chain: [], origin: { x: 100, y: 0 }, passed: { waypoints: [{ x: 300, y: 0, action: "walk" }] }, pending: { waypoints: [] } };
  assert.equal(onPreMoveTokenOA(walker.doc, walk, {}), undefined);
  await onDisengageUsed({ name: "Disengage", item: { name: "Step of the Wind" }, actor: walker.actor });
  assert.deepEqual(walker.actor.toggled, []);
  const deleted = [];
  walker.actor.deleteEmbeddedDocuments = async (_type, ids) => { deleted.push(...ids); };
  await onTurnEndDisengage({ started: true, scene }, { tokenId: walker.token.id });
  assert.deepEqual(deleted, ["dis"]);

  // 2024 Monk's Patient Defense isn't named Disengage, but applies the stock effect: the status goes on too.
  const monk = creature("Monk", 5, 5, { disposition: 1 });
  await onDisengageUsed({ name: "Patient Defense", item: { name: "Monk's Focus" }, actor: monk.actor,
    effects: [{ _id: "x", uuid: "Compendium.dnd5e.effects.ActiveEffect.DovP6Uo8YmIohHeK" }] });
  assert.ok(monk.actor.statuses.has(DISENGAGED));
  await onDisengageUsed({ name: "Flurry of Blows", item: { name: "Monk's Focus" }, actor: creature("Other", 6, 6).actor, effects: [] });
});

test("the SRD's own effects: Shocked (2024 Shocking Grasp) and Staggered stop opportunity attacks; 2014 Shocking Grasp, every reaction", () => {
  settings.opportunityAttacks = true;
  inCombat();
  const caster = (identifier, rules) => {
    const uuid = `Actor.caster.Item.${identifier}${rules}`;
    uuids.set(uuid, { documentName: "Item", uuid, system: { identifier, source: { rules } } });
    return uuid;
  };
  const from = (identifier, rules, extra = {}) => ({ id: `${identifier}${rules}`, disabled: false, isSuppressed: false,
    system: { origin: { item: caster(identifier, rules) } }, _stats: {}, name: "", ...extra });
  const orc = creature("Orc", 0, 0, { items: [weapon("Axe").item] });
  const pip = creature("Pip", 1, 0, { disposition: 1 });
  const path = walkTo(1, 3);
  const withEffect = (effect) => { orc.actor.effects.length = 0; if (effect) orc.actor.effects.push(effect); return reactorsOf(pip, path).length; };

  assert.equal(withEffect(null), 1);
  assert.equal(withEffect(from("shocking-grasp", "2024", { name: "Shocked" })), 0);
  assert.equal(hasReaction(orc.actor), true);                                    // its other reactions stay
  assert.equal(withEffect(from("brutal-strike", "2024", { name: "Staggered" })), 0);
  assert.equal(withEffect(from("brutal-strike", "2024", {                       // by its source, whatever it's called
    name: "Reeling", _stats: { duplicateSource: "Actor.b.Item.bs.ActiveEffect.uacly0JAXLVwAS6y" } })), 0);
  assert.equal(withEffect(from("brutal-strike", "2024", { name: "Hamstrung" })), 1); // its other blows don't
  assert.equal(withEffect(from("shocking-grasp", "2024", { name: "Shocked", disabled: true })), 1);
  assert.equal(withEffect(from("shocking-grasp", "2014", { name: "Shocking Grasp" })), 0);
  assert.equal(hasReaction(orc.actor), false);                                   // 2014: no reactions at all
  orc.actor.effects.length = 0;
});

test("already at the edge of reach: no first leg; each enemy is asked where the path leaves its own reach", async () => {
  settings.opportunityAttacks = true;
  inCombat();
  const axe = weapon("Axe"), glaive = weapon("Glaive", { rch: true });
  creature("Near", 0, 0, { items: [axe.item] });
  creature("Long", 3, 1, { items: [glaive.item] });
  const pip = legged(creature("Pip", 1, 0, { disposition: 1 }));
  const seen = [];
  prompts.choice = async (_t, content) => { seen.push([content.match(/<strong>(\w+)<\/strong>'s reach/)[1], pip.doc.x]); return "no"; };
  const path = walkTo(1, 8);
  await moveWithOpportunityAttacks(pip.doc, path, reactorsOf(pip, path));
  assert.deepEqual(seen, [["Near", 100], ["Long", 500]]);
  assert.deepEqual(pip.legs.map(l => l.to), [[500], [800]]);
  assert.equal(axe.attacks.length + glaive.attacks.length, 0);
});

test("the attack drops or moves the mover: it doesn't carry on", async () => {
  settings.opportunityAttacks = true;
  inCombat();
  creature("Orc", 0, 0, { items: [weapon("Axe").item] });
  const pip = legged(creature("Pip", 1, 0, { disposition: 1 }));
  prompts.choice = async () => { pip.actor.system.attributes.hp.value = 0; return "no"; };
  const path = walkTo(1, 5);
  await moveWithOpportunityAttacks(pip.doc, path, reactorsOf(pip, path));
  assert.deepEqual(pip.legs, []);

  const pushed = legged(creature("Pushed", 11, 0, { disposition: 1 }));
  creature("Ogre", 10, 0, { items: [weapon("Club").item] });
  prompts.choice = async () => { pushed.doc.x = 1300; return "no"; };
  const route = walkTo(11, 15);
  await moveWithOpportunityAttacks(pushed.doc, route, reactorsOf(pushed, route));
  assert.deepEqual(pushed.legs, []);
});

test("the movement hook refuses what would leave reach and remakes it in legs; everything else passes", async () => {
  settings.opportunityAttacks = true;
  inCombat();
  const axe = weapon("Axe");
  creature("Orc", 0, 0, { items: [axe.item] });
  creature("Ally", 0, 1, { disposition: 1, items: [weapon("Sword").item] });
  const pip = legged(creature("Pip", 1, 0, { disposition: 1 }));
  prompts.choice = async () => "no";
  const walk = (extra = {}) => ({ method: "dragging", chain: [], origin: { x: 100, y: 0 }, passed: { waypoints: [{ x: 300, y: 0, action: "walk", cost: 10 }] }, pending: { waypoints: [] }, constrainOptions: { ignoreWalls: true }, ...extra });
  // None of these are refused.
  assert.equal(onPreMoveTokenOA(pip.doc, walk({ passed: { waypoints: [{ x: 300, y: 0, action: "blink" }] } }), {}), undefined);
  assert.equal(onPreMoveTokenOA(pip.doc, walk({ method: "undo" }), {}), undefined);
  assert.equal(onPreMoveTokenOA(pip.doc, walk({ method: "config" }), {}), undefined);
  assert.equal(onPreMoveTokenOA(pip.doc, walk(), { [MODULE_ID]: { forced: true } }), undefined);
  assert.equal(onPreMoveTokenOA(pip.doc, walk(), { [MODULE_ID]: { opportunityLeg: true } }), undefined);
  assert.equal(onPreMoveTokenOA(pip.doc, walk({ chain: ["earlier"] }), {}), undefined);
  pip.actor.statuses.add(DISENGAGED);
  assert.equal(onPreMoveTokenOA(pip.doc, walk(), {}), undefined);
  pip.actor.statuses.delete(DISENGAGED);
  // Staying in reach.
  assert.equal(onPreMoveTokenOA(pip.doc, walk({ passed: { waypoints: [{ x: 100, y: 100, action: "walk" }] } }), {}), undefined);
  settings.opportunityAttacks = false;
  assert.equal(onPreMoveTokenOA(pip.doc, walk(), {}), undefined);
  settings.opportunityAttacks = true;
  // Outside combat, or with someone not in it: no attack.
  game.combat = null;
  assert.equal(onPreMoveTokenOA(pip.doc, walk(), {}), undefined);
  game.combat = { started: true, getCombatantsByToken: () => [] };
  assert.equal(onPreMoveTokenOA(pip.doc, walk(), {}), undefined);
  inCombat();

  // This one is: the whole path, its options kept, without the measured parts of its waypoints.
  assert.equal(onPreMoveTokenOA(pip.doc, walk(), {}), false);
  // While it's underway, another movement of the token waits.
  assert.equal(onPreMoveTokenOA(pip.doc, walk(), {}), false);
  await (await import("../scripts/native/opportunity.mjs")).legsDone;
  assert.deepEqual(pip.legs.map(l => l.to), [[300]]);
  assert.equal(pip.legs[0].options.method, "dragging");
  assert.deepEqual(pip.legs[0].options.constrainOptions, { ignoreWalls: true });
  assert.equal(pip.doc.x, 300);
});

test("paths cut at a stop", () => {
  const path = [{ x: 0, y: 0 }, { x: 100, y: 0, action: "walk", cost: 5 }, { x: 400, y: 0, action: "fly" }];
  const { walk, stop, rest } = splitPath(path, { segment: 2, point: { x: 200, y: 0, elevation: 0 } });
  assert.deepEqual(walk, [{ x: 100, y: 0, action: "walk" }, { x: 200, y: 0, elevation: 0, action: "fly", snapped: true }]);
  assert.deepEqual(rest, [stop, { x: 400, y: 0, action: "fly" }]);
  // A stop on the waypoint already reached: nothing to walk, nothing doubled.
  const there = splitPath([{ x: 0, y: 0 }, { x: 300, y: 0 }], { segment: 1, point: { x: 0, y: 0 } });
  assert.deepEqual(there.walk, []);
  assert.deepEqual(there.rest.map(w => w.x), [0, 300]);
});

test("a reaction is one status: used up, seen by everyone, back on its turn or when combat ends", async () => {
  settings.opportunityAttacks = true;
  inCombat();
  const axe = weapon("Axe");
  const orc = creature("Orc", 0, 0, { items: [axe.item] });
  const pip = legged(creature("Pip", 1, 0, { disposition: 1 }));
  prompts.choice = async () => "attack";
  const path = walkTo(1, 3);
  await moveWithOpportunityAttacks(pip.doc, path, reactorsOf(pip, path));
  assert.equal(axe.attacks.length, 1);
  assert.deepEqual(orc.actor.toggled, [[REACTION_USED, true]]);
  assert.equal(hasReaction(orc.actor), false);

  // Used: not a candidate for the next mover, so no attempt and no pause.
  const tam = legged(creature("Tam", 1, 1, { disposition: 1 }));
  assert.deepEqual(reactorsOf(tam, walkTo(1, 3)), []);

  // Another creature's turn changes nothing; its own turn gives it back.
  await onTurnStartReaction({ scene }, { tokenId: pip.token.id });
  assert.equal(hasReaction(orc.actor), false);
  await onTurnStartReaction({ scene }, { tokenId: orc.token.id });
  assert.equal(hasReaction(orc.actor), true);

  await orc.actor.toggleStatusEffect(REACTION_USED, { active: true });
  await onCombatEndedReactions({ combatants: [{ actor: orc.actor }, { actor: pip.actor }] });
  assert.equal(hasReaction(orc.actor), true);

  // Only the primary GM clears it.
  await orc.actor.toggleStatusEffect(REACTION_USED, { active: true });
  game.modules.get("scorpious187s-lib").api.utils.primaryGM = () => ({ id: "someone-else" });
  await onTurnStartReaction({ scene }, { tokenId: orc.token.id });
  assert.equal(hasReaction(orc.actor), false);
});

test("two prompts open for one enemy: only the first answered attacks; a mover gone by then isn't attacked", async () => {
  settings.opportunityAttacks = true;
  inCombat();
  const axe = weapon("Axe");
  const orc = creature("Orc", 0, 0, { items: [axe.item] });
  const pip = creature("Pip", 1, 0, { disposition: 1 });
  const answers = [];
  prompts.choice = () => new Promise(resolve => answers.push(resolve));
  const ask = () => answerOpportunity({ token: orc.doc.uuid, actor: orc.actor.uuid, mover: pip.doc.uuid, moverName: "Pip", activity: axe.activity.uuid, reach: 5 });
  const first = ask(), second = ask();
  await env.flush();
  answers.forEach(answer => answer("attack"));
  assert.equal((await first)?.identifier, "opportunity");
  assert.equal(await second, null);
  assert.equal(axe.attacks.length, 1);

  // The answer came after the mover carried on.
  await onTurnStartReaction({ scene }, { tokenId: orc.token.id });
  pip.doc.x = 500;
  prompts.choice = async () => "attack";
  assert.equal(await ask(), null);
  assert.equal(axe.attacks.length, 1);
  assert.equal(hasReaction(orc.actor), true);                             // and it isn't spent
});

test("outside combat a reaction isn't tracked: no turn would ever give it back", async () => {
  game.combat = null;
  const axe = weapon("Axe");
  const orc = creature("Orc", 0, 0, { items: [axe.item] });
  const pip = creature("Pip", 1, 0, { disposition: 1 });
  prompts.choice = async () => "attack";
  await answerOpportunity({ token: orc.doc.uuid, actor: orc.actor.uuid, mover: pip.doc.uuid, activity: axe.activity.uuid, reach: 5 });
  assert.equal(axe.attacks.length, 1);
  assert.deepEqual(orc.actor.toggled, []);
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

  // Healing isn't something to react to.
  let asked = false;
  prompts.choice = async () => { asked = true; return "parry"; };
  const healing = [{ value: 9, type: "healing", properties: [] }];
  const untouched = await damageReactions(melee, { token: fighter.doc.uuid, actor: fighter.actor.uuid }, healing);
  assert.equal(asked, false);
  assert.deepEqual(untouched.damages, healing);
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
