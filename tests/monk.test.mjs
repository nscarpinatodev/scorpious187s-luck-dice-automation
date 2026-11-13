import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { stunningStrikeWeapon, pointsLeft, applyStunningStrike, STUNNING_FLAG } from "../scripts/native/monk.mjs";
import { saveEffectApplies } from "../scripts/native/effects.mjs";
import { claimRiderUse } from "../scripts/native/riders.mjs";

const { settings, uuids, prompts, makeToken } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";
beforeEach(() => { env.reset(); game.combat = null; });

const weapon = (type, properties = []) => ({ type: "weapon", system: { identifier: "w", type: { value: type }, properties: new Set(properties) } });
const attackWith = (item, { range = "melee", classification = "weapon" } = {}) => ({ type: "attack", item, attack: { type: { value: range, classification } } });

test("Stunning Strike's weapons: 2024 a Monk weapon or an Unarmed Strike; 2014 any melee weapon", () => {
  assert.equal(stunningStrikeWeapon(attackWith(weapon("simpleM")), "2024"), true);
  assert.equal(stunningStrikeWeapon(attackWith(weapon("martialM", ["lgt"])), "2024"), true);       // shortsword
  assert.equal(stunningStrikeWeapon(attackWith(weapon("martialM", ["two"])), "2024"), false);      // greatsword
  assert.equal(stunningStrikeWeapon(attackWith(weapon("martialM", ["two"])), "2014"), true);
  assert.equal(stunningStrikeWeapon(attackWith({ type: "feat", system: { identifier: "unarmed-strike" } }), "2024"), true);
  assert.equal(stunningStrikeWeapon(attackWith(weapon("simpleR"), { range: "ranged" }), "2024"), false);
});

test("its points: the Focus (or Ki) item the save activity spends", () => {
  const focus = { id: "focusId", system: { identifier: "monks-focus", uses: { max: 5, value: 2 } } };
  const actor = { items: Object.assign([focus], { get: (id) => [focus].find(i => i.id === id) }) };
  assert.equal(pointsLeft(actor, { consumption: { targets: [{ type: "itemUses", target: "focusId" }] } }), 2);   // as dnd5e prepares it
  assert.equal(pointsLeft(actor, { consumption: { targets: [{ type: "itemUses", target: "feat:monks-focus" }] } }), 2);
  uuids.set("Compendium.dnd5e.classfeatures.Item.ki", { system: { identifier: "monks-focus" } });
  assert.equal(pointsLeft(actor, { consumption: { targets: [{ type: "itemUses", target: "Compendium.dnd5e.classfeatures.Item.ki" }] } }), 2);
  assert.equal(pointsLeft(actor, { consumption: { targets: [] } }), null);
});

test("its effects by outcome: 2024 Stunned on a failure and Slowed on a success; others by dnd5e's flags", () => {
  const stunned = { id: "s", statuses: new Set(["stunned"]) }, slowed = { id: "w", statuses: new Set() };
  const strike = (rules) => ({ item: { system: { identifier: "stunning-strike", source: { rules } } }, effects: [{ _id: "s" }, { _id: "w" }] });
  assert.deepEqual([stunned, slowed].filter(e => saveEffectApplies(strike("2024"), e, false)), [stunned]);
  assert.deepEqual([stunned, slowed].filter(e => saveEffectApplies(strike("2024"), e, true)), [slowed]);
  const holdPerson = { item: { system: { identifier: "hold-person" } }, effects: [{ _id: "s" }, { _id: "w", onSave: true }] };
  assert.deepEqual([stunned, slowed].filter(e => saveEffectApplies(holdPerson, e, false)), [stunned, slowed]);
  assert.deepEqual([stunned, slowed].filter(e => saveEffectApplies(holdPerson, e, true)), [slowed]);
});

test("offered after a hit while there are points; used through dnd5e at the creature hit, once per turn (2024)", async () => {
  settings.onHitRiders = true;
  settings.saveAutomation = "off";                       // the save stays on the card: nothing else to mock
  const orc = makeToken("orc", "Orc", { disposition: -1 });
  Object.assign(orc.document.actor, { statuses: new Set(), system: { attributes: { hp: { value: 10 } } } });
  uuids.set(orc.document.uuid, orc.document);
  const focus = { system: { identifier: "monks-focus", uses: { max: 5, value: 1 } } };
  const used = [];
  const save = { type: "save", save: { ability: new Set(["con"]), dc: { value: 13 } }, consumption: { targets: [{ type: "itemUses", target: "feat:monks-focus" }] },
    async use(usage, dialog) { used.push({ targets: [...game.user.targets].map(t => t.id), dialog, claimed: claimRiderUse(save, {}) }); return { message: { id: "use1" } }; } };
  const item = { id: "ss", system: { identifier: "stunning-strike", source: { rules: "2024" }, activities: new Map([["a", save]]) } };
  save.item = item;
  const monk = { uuid: "Actor.monk", name: "Monk", isOwner: true, items: [item, focus] };
  const card = () => { const flags = {}; return { flags, system: { evaluatedTargets: [{ token: orc.document.uuid, actor: orc.document.actor.uuid, name: "Orc", isMiss: false }] },
    getFlag: (_m, k) => flags[k], async setFlag(_m, k, v) { flags[k] = v; } }; };
  const fist = attackWith({ type: "feat", system: { identifier: "unarmed-strike" } }, { classification: "unarmed" });
  fist.actor = monk;
  let asked = 0;
  prompts.choice = async (title, content) => { asked++; assert.match(content, /DC 13/); return "strike"; };
  game.combat = { started: true, id: "c", round: 1, turn: 0 };
  const first = card();
  await applyStunningStrike(first, fist);
  assert.equal(asked, 1);
  assert.deepEqual(used, [{ targets: ["orc"], dialog: { configure: false }, claimed: true }]);   // no follow-up save automation of its own
  assert.match(first.flags[STUNNING_FLAG].text, /save is on the Stunning Strike card/);
  await applyStunningStrike(card(), fist);                                                     // once per turn
  assert.equal(asked, 1);
  game.combat.turn = 1;
  focus.system.uses.value = 0;                                                                 // no points left
  await applyStunningStrike(card(), fist);
  assert.equal(asked, 1);
  focus.system.uses.value = 1;
  const greatsword = attackWith(weapon("martialM", ["two"])); greatsword.actor = monk;            // not a Monk weapon
  await applyStunningStrike(card(), greatsword);
  assert.equal(asked, 1);
  settings.onHitRiders = false;
  await applyStunningStrike(card(), fist);
  assert.equal(asked, 1);
});
