import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  invocationApplies, eldritchSpearRange, isPactWeapon, onPreRollAttackInvocations, onPreRollDamageInvocations,
  applyInvocationsOnHit, onDamageAppliedGift, onTurnStartCloak, cursedBy, INVOCATION_RESULT_FLAG
} from "../scripts/native/invocations.mjs";
import { eligibleRiders, addOnHitRiders } from "../scripts/native/riders.mjs";
import { reactionOptions, damageReactions } from "../scripts/native/reactions.mjs";
import { rollExtras } from "../scripts/native/boosts.mjs";

const { settings, uuids, makeToken, rollResults, damageRoll, scene } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

canvas.grid = {
  isGridless: false, distance: 5, size: 100, units: "ft",
  getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
  measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5 })
};

let cards = [];
CONFIG.Dice.DamageRoll.toMessage = async (rolls, data) => { cards.push({ rolls, ...data }); return null; };

let choices = [];
beforeEach(() => {
  env.reset();
  settings.invocations = true;
  game.combat = null;
  game.users = [game.user];
  game.modules.set("scorpious187s-lib", { active: true, api: { utils: { primaryGM: () => game.user } } });
  cards = [];
  choices = [];
  env.prompts.choice = async (_title, _content, buttons) => choices.shift() ?? buttons.at(-1).action;
});

let seq = 0;
const feat = (identifier, { rules = "2024", uses = null } = {}) => {
  const it = { name: identifier, type: "feat", system: { identifier, source: { rules }, ...(uses ? { uses: { max: uses, spent: 0 } } : {}) },
    async update(u) { if ("system.uses.spent" in u) it.system.uses.spent = u["system.uses.spent"]; } };
  return it;
};
/** A creature on the scene at grid space (col, row). */
function creature(name, col = 0, row = 0, { items = [], disposition = 1, cha = 3, warlock = 5, size = "med" } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const d = token.document;
  Object.assign(d, { x: col * 100, y: row * 100, elevation: 0, width: 1, height: 1, isOwner: true,
    getOccupiedGridSpaceOffsets: () => [{ i: row, j: col }],
    async update(u) { Object.assign(d, u); } });
  const actor = d.actor;
  Object.assign(actor, {
    name, type: "character", isOwner: true, items, effects: [], statuses: new Set(),
    system: { abilities: { cha: { mod: cha } }, attributes: { prof: 3, hp: { value: 20, temp: 0 } }, traits: { size } },
    classes: warlock ? { warlock: { system: { levels: warlock } } } : {},
    getActiveTokens: () => [d],
    async createEmbeddedDocuments(_t, data) { actor.effects.push(...data.map(e => ({ ...e, getFlag: (s, k) => e.flags?.[s]?.[k] }))); },
    async update(u) { for (const [k, v] of Object.entries(u)) foundry.utils.setProperty(actor, k, v); },
    async toggleStatusEffect(s, { active }) { if (active) actor.statuses.add(s); else actor.statuses.delete(s); }
  });
  uuids.set(actor.uuid, actor);
  return { token, doc: d, actor };
}
const spell = (identifier, { effects = [], name = identifier } = {}) => ({ type: "spell", name, system: { identifier, level: 0 }, effects, uuid: `Item.${identifier}${++seq}` });
const castAttack = (who, item, extra = {}) => ({ type: "attack", actor: who.actor, item, attack: { type: { value: "ranged" } },
  range: { value: 120, units: "ft" }, getUsageToken: () => who.doc, uuid: `${item.uuid}.Activity.a`, ...extra });

test("Agonizing Blast: Eldritch Blast's damage gains the Charisma modifier, once; not other cantrips; not with the setting off", () => {
  const warlock = creature("Warlock", 0, 0, { items: [feat("agonizing-blast")] });
  const blast = spell("eldritch-blast");
  const damage = (item, parts = ["1d10"]) => { const config = { subject: castAttack(warlock, item), rolls: [{ parts: [...parts] }] }; onPreRollDamageInvocations(config); return config.rolls[0].parts; };
  assert.deepEqual(damage(blast), ["1d10", "@abilities.cha.mod"]);
  assert.deepEqual(damage(blast, ["1d10", "@abilities.cha.mod"]), ["1d10", "@abilities.cha.mod"]);
  assert.deepEqual(damage(spell("fire-bolt")), ["1d10"]);
  // The PHB's enchantment on another cantrip: that one already has dnd5e's bonus, Eldritch Blast gets none.
  const fireBolt = spell("fire-bolt", { name: "Fire Bolt (Agonizing)", effects: [{ type: "enchantment", name: "Agonizing Blast" }] });
  warlock.actor.items.push(blast, fireBolt);
  assert.deepEqual(damage(blast), ["1d10"]);
  assert.deepEqual(damage(fireBolt, ["1d10", "@abilities.cha.mod"]), ["1d10", "@abilities.cha.mod"]);
  warlock.actor.items.length = 1;
  settings.invocations = false;
  assert.deepEqual(damage(blast), ["1d10"]);
});

test("an invocation tied to a cantrip follows the cantrip its enchantment marks, else Eldritch Blast", () => {
  const invocation = { ...feat("repelling-blast"), uuid: "Actor.w.Item.rb" };
  uuids.set(invocation.uuid, invocation);
  const warlock = creature("Warlock", 0, 0, { items: [invocation] });
  const blast = spell("eldritch-blast");
  const fireBolt = spell("fire-bolt", { effects: [{ type: "enchantment", origin: "Actor.w.Item.rb.Activity.e", name: "Repelling Blast" }] });
  warlock.actor.items.push(blast, fireBolt);
  assert.equal(invocationApplies(warlock.actor, fireBolt, "repelling-blast", "Repelling"), true);
  assert.equal(invocationApplies(warlock.actor, blast, "repelling-blast", "Repelling"), false);
  warlock.actor.items.pop();
  assert.equal(invocationApplies(warlock.actor, blast, "repelling-blast", "Repelling"), true);
});

test("Eldritch Spear: 300 ft (2014), +30 ft per Warlock level (2024); left to dnd5e when its enchantment is on the cantrip", () => {
  const w14 = creature("Old", 0, 0, { items: [feat("eldritch-spear", { rules: "2014" })] });
  assert.deepEqual(eldritchSpearRange(castAttack(w14, spell("eldritch-blast"))), { value: 300, units: "ft" });
  const w24 = creature("New", 0, 0, { items: [feat("eldritch-spear")], warlock: 5 });
  assert.deepEqual(eldritchSpearRange(castAttack(w24, spell("eldritch-blast"))), { value: 270, units: "ft" });
  const enchanted = spell("eldritch-blast", { name: "Eldritch Blast, Eldritch Spear" });
  assert.equal(eldritchSpearRange(castAttack(w24, enchanted)), null);
  assert.equal(eldritchSpearRange(castAttack(w24, spell("fire-bolt"))), null);
});

test("pact weapons: marked by Pact of the Blade; a 2014 warlock's melee weapons only where the invocation is offered; Improved Pact Weapon +1", () => {
  const warlock = creature("Hexblade", 0, 0, { items: [feat("pact-of-the-blade", { rules: "2014" }), feat("improved-pact-weapon", { rules: "2014" })] });
  const weapon = (name, props = []) => ({ type: "weapon", name, system: { properties: new Set(props), identifier: "longsword" }, effects: [] });
  const swing = (item) => ({ type: "attack", actor: warlock.actor, item, attack: { type: { value: "melee" } } });
  assert.equal(isPactWeapon(swing(weapon("Longsword"))), true);
  assert.equal(isPactWeapon(swing(weapon("Longsword")), { strict: true }), false);
  assert.equal(isPactWeapon(swing(weapon("Longsword, Pact Weapon")), { strict: true }), true);

  const pactAttack = { subject: swing(weapon("Longsword, Pact Weapon")), rolls: [{ parts: [] }] };
  onPreRollAttackInvocations(pactAttack);
  assert.deepEqual(pactAttack.rolls[0].parts, ["1"]);
  const magic = { subject: swing(weapon("Flame Tongue, Pact Weapon", ["mgc"])), rolls: [{ parts: [] }] };
  onPreRollAttackInvocations(magic);
  assert.deepEqual(magic.rolls[0].parts, []);
  const damage = { subject: swing(weapon("Longsword, Pact Weapon")), rolls: [{ base: true, parts: ["1d8"] }] };
  onPreRollDamageInvocations(damage);
  assert.deepEqual(damage.rolls[0].parts, ["1d8", "1"]);
});

test("on a hit: Lance of Lethargy once per turn; Repelling Blast's push and Grasp of Hadar's pull when chosen", async () => {
  const warlock = creature("Warlock", 0, 0, { items: [feat("lance-of-lethargy", { rules: "2014" }), feat("repelling-blast", { rules: "2014" })] });
  const goblin = creature("Goblin", 3, 0, { disposition: -1 });
  const blast = spell("eldritch-blast");
  const card = () => {
    const message = { flags: {}, system: { evaluatedTargets: [{ token: goblin.doc.uuid, actor: goblin.actor.uuid, name: "Goblin", isMiss: false }] },
      getFlag: (_m, k) => message.flags[k], async setFlag(_m, k, v) { message.flags[k] = v; } };
    return message;
  };
  game.combat = { started: true, id: "c", round: 1, turn: 0 };
  choices = ["move"];
  const first = card();
  await applyInvocationsOnHit(first, castAttack(warlock, blast));
  assert.equal(goblin.actor.effects.length, 1);
  assert.equal(goblin.actor.effects[0].name, "Lance of Lethargy");
  assert.equal(goblin.doc.x, 500);                                            // pushed 10 ft (2 squares) away
  assert.match(first.flags[INVOCATION_RESULT_FLAG], /Lance of Lethargy.*pushed 10 ft \(Repelling Blast\)/);
  // A second beam on the same turn: no second Lance.
  choices = ["no"];
  await applyInvocationsOnHit(card(), castAttack(warlock, blast));
  assert.equal(goblin.actor.effects.length, 1);

  // Grasp of Hadar: pulled toward the caster, stopping next to it.
  const puller = creature("Puller", 10, 10, { items: [feat("grasp-of-hadar", { rules: "2014" })] });
  const orc = creature("Orc", 14, 10, { disposition: -1 });
  const pull = { flags: {}, system: { evaluatedTargets: [{ token: orc.doc.uuid, actor: orc.actor.uuid, name: "Orc", isMiss: false }] },
    getFlag: () => undefined, async setFlag(_m, k, v) { pull.flags[k] = v; } };
  choices = ["move"];
  await applyInvocationsOnHit(pull, castAttack(puller, spell("eldritch-blast")));
  assert.equal(orc.doc.x, 1200);
  assert.match(pull.flags[INVOCATION_RESULT_FLAG], /pulled 10 ft/);
});

test("Eldritch Smite and Lifedrinker as riders: pact weapon hits; 2014 Lifedrinker added on its own as necrotic", async () => {
  const smiteAct = { type: "damage", consumption: { targets: [] }, async rollDamage() { return [damageRoll(9)]; } };
  const smite = { ...feat("eldritch-smite"), uuid: "Actor.w.Item.smite", system: { identifier: "eldritch-smite", source: { rules: "2024" }, activities: new Map([["s", smiteAct]]) } };
  smiteAct.item = smite;
  const drinker = feat("lifedrinker", { rules: "2014" });
  const warlock = creature("Warlock", 0, 0, { items: [smite, drinker, feat("pact-of-the-blade", { rules: "2014" })] });
  const sword = { type: "weapon", name: "Longsword", system: { properties: new Set() }, effects: [] };
  const swing = { type: "attack", actor: warlock.actor, item: sword, attack: { type: { value: "melee", classification: "weapon" } } };
  const goblin = creature("Goblin", 1, 0, { disposition: -1 });
  const attackCard = { rolls: [{ isCritical: false, options: {} }], system: { evaluatedTargets: [{ token: goblin.doc.uuid, actor: goblin.actor.uuid, name: "Goblin", isMiss: false }] } };
  const riders = await eligibleRiders(swing, attackCard);
  assert.deepEqual(riders.map(r => [r.identifier, r.mode]), [["eldritch-smite", "choose"], ["lifedrinker", "auto"]]);
  assert.deepEqual((await eligibleRiders({ ...swing, attack: { type: { value: "ranged" } } }, attackCard)).map(r => r.identifier), []);

  settings.invocations = false;
  assert.deepEqual(await eligibleRiders(swing, attackCard), []);
  settings.invocations = true;

  // Only Lifedrinker (Smite declined in the checklist): the Charisma modifier as necrotic, on the hit's card.
  env.dialogs.push(() => "skip");
  const damageCard = { rolls: [damageRoll(6)], flags: {}, getFlag: (_m, k) => damageCard.flags[k],
    async update(u) { damageCard.rolls = u.rolls; for (const [k, v] of Object.entries(u)) if (k.startsWith("flags.")) damageCard.flags[k.split(".").pop()] = v; },
    async setFlag(_m, k, v) { damageCard.flags[k] = v; } };
  await addOnHitRiders(damageCard, swing, attackCard);
  assert.equal(damageCard.rolls.length, 2);
  assert.equal(damageCard.rolls[1].formula, "3");
  assert.equal(damageCard.rolls[1].options.type, "necrotic");
});

test("Rebuke of the Talisman and Tomb of Levistus as reactions; Protection of the Talisman on a failed save", async () => {
  settings.reactionPrompts = "all";
  const warlock = creature("Warlock", 0, 0, { items: [feat("rebuke-of-the-talisman"), feat("tomb-of-levistus", { rules: "2014", uses: 1 }), feat("protection-of-the-talisman", { uses: 3 })], warlock: 7 });
  assert.deepEqual(reactionOptions(warlock.actor, { total: 15, ac: 12, attackerWithin30: true }, "hit"), ["rebuke-of-the-talisman"]);
  assert.deepEqual(reactionOptions(warlock.actor, { total: 15, ac: 12, attackerWithin30: false }, "hit"), []);

  // Tomb: the temporary HP before the damage, the ice after.
  choices = ["tomb-of-levistus"];
  const { notes, afterApply } = await damageReactions({ getAssociatedActivity: () => null, rolls: [] },
    { token: warlock.doc.uuid, actor: warlock.actor.uuid }, [{ value: 30, type: "slashing" }]);
  assert.equal(warlock.actor.system.attributes.hp.temp, 70);
  assert.match(notes[0], /Tomb of Levistus \(70 temporary HP/);
  await afterApply();
  assert.equal(warlock.actor.effects[0].name, "Tomb of Levistus");
  assert.deepEqual(warlock.actor.effects[0].statuses, ["incapacitated"]);

  // Protection of the Talisman: +1d4, one of its uses.
  const extras = rollExtras(warlock.actor, "save");
  assert.deepEqual(extras.options().map(o => o.action), ["boost:talisman"]);
  rollResults.push(3);
  const out = await extras.run("boost:talisman", null);
  assert.equal(out.bonusRoll.total, 3);
  assert.equal(warlock.actor.items[2].system.uses.spent, 1);
});

test("Gift of the Protectors: a creature at 0 HP is kept at 1 when the warlock says it's in the book", async () => {
  const warlock = creature("Warlock", 0, 0, { items: [feat("gift-of-the-protectors", { uses: 1 })] });
  game.actors.push(warlock.actor);
  const friend = creature("Friend", 1, 0);
  friend.actor.system.attributes.hp.value = 0;
  friend.actor.statuses.add("unconscious");
  choices = ["use"];
  await onDamageAppliedGift(friend.actor);
  assert.equal(friend.actor.system.attributes.hp.value, 1);
  assert.equal(friend.actor.statuses.has("unconscious"), false);
  assert.equal(warlock.actor.items[0].system.uses.spent, 1);
});

test("Cloak of Flies: poison damage to a creature starting its turn within 5 ft; Maddening Hex finds the warlock's curse", async () => {
  const cloak = { ...feat("cloak-of-flies"), uuid: "Actor.w.Item.cloak" };
  const warlock = creature("Warlock", 0, 0, { items: [cloak], cha: 4 });
  warlock.actor.effects.push({ name: "Cloak of Flies", disabled: false });
  const near = creature("Near", 1, 0, { disposition: -1 });
  creature("Far", 4, 0, { disposition: -1 });
  scene.tokens.forEach(t => { t.parent = scene; });
  await onTurnStartCloak({ started: true, scene }, { tokenId: near.doc.id });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].rolls[0].options.type, "poison");
  assert.deepEqual(cards[0].system.targets.map(t => t.name), ["Near"]);

  const hexItem = { system: { identifier: "hex" }, documentName: "Item", actor: warlock.actor, uuid: "Actor.w.Item.hex" };
  uuids.set(hexItem.uuid, hexItem);
  near.actor.effects.push({ disabled: false, statuses: new Set(["cursed"]), system: { origin: { item: hexItem.uuid } } });
  assert.deepEqual(cursedBy(warlock.actor, scene).map(t => t.name), ["Near"]);
});
