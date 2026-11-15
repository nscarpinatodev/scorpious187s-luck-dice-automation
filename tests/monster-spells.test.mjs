// Pack Tactics, Blur, Shining Smite, the smite riders, Mirror Image, Regeneration, Undead Fortitude, Sanctuary, Sunlight Sensitivity.
import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { attackReasons } from "../scripts/native/advantage.mjs";
import { RIDERS } from "../scripts/native/riders.mjs";
import { applyMirrorImage, MIRROR_FLAG } from "../scripts/native/illusions.mjs";
import { regenerationBlockers, damageFacts, onPreApplyDamageMonsters, REGEN_BLOCKED } from "../scripts/native/monsters.mjs";
import { wardOf } from "../scripts/native/sanctuary.mjs";
import { inSunlight, SUNLIGHT_FLAG } from "../scripts/native/sunlight.mjs";
import { onPreRollCheck } from "../scripts/native/save-rules.mjs";

const { settings, makeToken, uuids, rollResults, scene } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";

canvas.grid = {
  isGridless: false, distance: 5, size: 100, units: "ft",
  getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
  measurePath: ([a, b]) => ({ distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5 })
};
CONFIG.Canvas = { polygonBackends: { sight: { testCollision: () => false }, move: { testCollision: () => false } } };

beforeEach(() => {
  env.reset();
  game.modules.delete("automated-conditions-5e");
  settings.attackAdvantage = true;
});

let seq = 0;
function creature(name, col, row = 0, { disposition = -1, items = [], statuses = [], senses = {}, dex = 0 } = {}) {
  const token = makeToken(`${name}${++seq}`, name, { disposition });
  const d = token.document;
  Object.assign(d, { x: col * 100, y: row * 100, elevation: 0, width: 1, height: 1, isOwner: true,
    getOccupiedGridSpaceOffsets: () => [{ i: row, j: col }] });
  const actor = d.actor;
  Object.assign(actor, { name, documentName: "Actor", isOwner: true, statuses: new Set(statuses), items, effects: [], flags: {},
    system: { attributes: { prof: 2, senses: { ranges: senses }, hp: { value: 20, max: 20 } }, abilities: { dex: { mod: dex } } },
    getActiveTokens: () => [d], getFlag: (m, k) => actor.flags[m]?.[k], async setFlag(m, k, v) { (actor.flags[m] ??= {})[k] = v; } });
  uuids.set(actor.uuid, actor);
  return { token, doc: d, actor };
}
const feat = (identifier, rules = "2024") => ({ type: "feat", name: identifier, system: { identifier, source: { rules } } });
/** An effect that came from an item with this identifier (and rules). */
function fromItem(identifier, { rules = "2024", uuid = `E.${identifier}${++seq}` } = {}) {
  const item = { documentName: "Item", uuid: `Actor.x.Item.${identifier}${seq}`, name: identifier, system: { identifier, source: { rules } } };
  uuids.set(item.uuid, item);
  return { uuid, disabled: false, isOwner: true, origin: item.uuid, deleted: false, async delete() { this.deleted = true; } };
}
const swing = (attacker) => ({ type: "attack", actor: attacker.actor, item: { type: "weapon", system: { range: {}, properties: new Set(), type: {} } },
  attack: { type: { value: "melee", classification: "weapon" } }, getUsageToken: () => attacker.doc });

// ── Attack rules ──
test("Pack Tactics: an ally (not incapacitated) within 5 ft of the target", () => {
  const wolf = creature("Wolf", 0, 0, { items: [feat("pack-tactics")] });
  const pip = creature("Pip", 1, 0, { disposition: 1 });
  const packmate = creature("Packmate", 2, 0);                         // 5 ft from Pip
  canvas.tokens.setTargets([pip.token.id]);
  assert.ok(attackReasons(swing(wolf)).advantage.some(r => /^Pack Tactics \(Packmate\d*\)$/.test(r)));
  packmate.actor.statuses.add("unconscious");
  assert.ok(!attackReasons(swing(wolf)).advantage.some(r => r.startsWith("Pack Tactics")));
});

test("Blur: disadvantage against the blurred creature — not for blindsight or truesight; Shining Smite: advantage against it", () => {
  const orc = creature("Orc", 0, 0);
  const mage = creature("Mage", 1, 0, { disposition: 1 });
  mage.actor.effects.push(fromItem("blur"));
  canvas.tokens.setTargets([mage.token.id]);
  assert.ok(attackReasons(swing(orc)).disadvantage.includes("Target blurred"));
  orc.actor.system.attributes.senses.ranges.truesight = 60;
  assert.ok(!attackReasons(swing(orc)).disadvantage.includes("Target blurred"));
  mage.actor.effects.push(fromItem("shining-smite"));
  assert.ok(attackReasons(swing(orc)).advantage.includes("Shining Smite"));
});

// ── Smites ──
test("the 2024 smites are offered on a melee weapon hit, like Divine Smite; 2014 Branding Smite isn't", () => {
  const melee = { item: { type: "weapon" }, attack: { type: { value: "melee", classification: "weapon" } } };
  const ranged = { item: { type: "weapon" }, attack: { type: { value: "ranged", classification: "weapon" } } };
  for (const id of ["searing-smite", "thunderous-smite", "wrathful-smite", "shining-smite"]) {
    const rider = RIDERS[id];
    assert.equal(rider.mode, "choose");
    assert.equal(rider.eligible({ activity: melee, card: { system: {} } }), true);
    assert.equal(rider.eligible({ activity: ranged, card: { system: {} } }), false);
    assert.equal(typeof rider.after, "function");
  }
  const branding = { system: { source: { rules: "2014" }, activities: new Map([["d", { type: "damage" }]]) } };
  assert.deepEqual(RIDERS["shining-smite"].activities(branding), []);
});

// ── Mirror Image ──
test("Mirror Image (2024): a hit, a d6 per duplicate; a 3+ and a duplicate takes it (destroyed); blindsight sees through", async () => {
  const orc = creature("Orc", 0, 0);
  const mage = creature("Mage", 1, 0, { disposition: 1 });
  const dups = [fromItem("mirror-image"), fromItem("mirror-image"), fromItem("mirror-image")];
  for (const d of dups) uuids.set(d.uuid, d);
  mage.actor.effects.push(...dups);
  const card = (total) => {
    const message = { flags: {}, rolls: [{ total, isCritical: false, isFumble: false }],
      system: { targets: [{ token: mage.doc.uuid, actor: mage.actor.uuid, name: "Mage", ac: 13 }] },
      getFlag: (_m, k) => message.flags[k], async update(u) { message.updated = u; } };
    return message;
  };
  rollResults.push(4);
  const hit = card(18);
  await applyMirrorImage(hit, { actor: orc.actor });
  assert.equal(hit.updated["system.targets"][0].ac, null);              // the duplicate took it: a miss on the card
  assert.match(hit.updated[`flags.${MODULE_ID}.${MIRROR_FLAG}`][0], /a duplicate was hit instead/);
  assert.equal(dups[0].deleted, true);

  const miss = card(9);
  await applyMirrorImage(miss, { actor: orc.actor });                   // a miss: nothing to roll
  assert.equal(miss.updated, undefined);
  orc.actor.system.attributes.senses.ranges.blindsight = 30;
  const seen = card(18);
  await applyMirrorImage(seen, { actor: orc.actor });
  assert.equal(seen.updated, undefined);
});

// ── Regeneration, Undead Fortitude ──
test("Regeneration: the damage types its description names stop it next turn; damage facts come from the card", () => {
  CONFIG.DND5E.damageTypes = { acid: { label: "Acid" }, fire: { label: "Fire" }, radiant: { label: "Radiant" }, cold: { label: "Cold" } };
  const regen = { system: { identifier: "regeneration", description: { value: "<p>The troll regains 15 Hit Points at the start of each of its turns. If the troll takes Acid or Fire damage, this trait doesn't function on the troll's next turn.</p>" } } };
  assert.deepEqual(regenerationBlockers(regen), ["acid", "fire"]);
  const card = { rolls: [{ options: { type: "fire" }, isCritical: true }, { options: { types: ["cold"] } }] };
  assert.deepEqual([...damageFacts(card).types], ["fire", "cold"]);
  assert.equal(damageFacts(card).critical, true);

  settings.deathSaves = true;
  const troll = creature("Troll", 0, 0, { items: [regen] });
  onPreApplyDamageMonsters(troll.actor, 10, { "system.attributes.hp.value": 10 }, { originatingMessage: card });
  assert.deepEqual(troll.actor.flags[MODULE_ID][REGEN_BLOCKED], ["fire"]);
});

// ── Sanctuary ──
test("Sanctuary: a warded creature's ward carries its spell's save DC", () => {
  const save = { type: "save", save: { ability: new Set(["wis"]), dc: { value: 14 } } };
  const cleric = creature("Cleric", 0, 0, { disposition: 1 });
  const effect = fromItem("sanctuary");
  uuids.get(effect.origin).system.activities = new Map([["s", save]]);
  cleric.actor.effects.push(effect);
  assert.equal(wardOf(cleric.actor).dc, 14);
  assert.equal(wardOf(creature("Other", 3, 0).actor), null);
});

// ── Sunlight Sensitivity ──
test("Sunlight Sensitivity: on a scene marked as in sunlight — attacks; 2024 every check, 2014 Perception", () => {
  const kobold = creature("Kobold", 0, 0, { items: [feat("sunlight-sensitivity")] });
  const pip = creature("Pip", 1, 0, { disposition: 1 });
  canvas.tokens.setTargets([pip.token.id]);
  assert.equal(inSunlight(kobold.doc), false);
  assert.ok(!attackReasons(swing(kobold)).disadvantage.includes("Sunlight Sensitivity"));
  const flags = { [MODULE_ID]: { [SUNLIGHT_FLAG]: true } };
  scene.getFlag = (m, k) => flags[m]?.[k];
  kobold.doc.parent = scene;
  assert.equal(inSunlight(kobold.doc), true);
  assert.ok(attackReasons(swing(kobold)).disadvantage.includes("Sunlight Sensitivity"));
  const check = (skill) => { const config = { subject: kobold.actor, skill, rolls: [{ options: {} }] }; onPreRollCheck(config, null, null); return config.disadvantage; };
  assert.equal(check("ath"), true);
  kobold.actor.items[0].system.source.rules = "2014";
  assert.equal(check("ath"), undefined);
  assert.equal(check("prc"), true);
  delete scene.getFlag;
});
