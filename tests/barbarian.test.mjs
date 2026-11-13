import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { onPreApplyDamageRelentless, onDamageAppliedRelentless, onRestRelentless, isRaging, relentlessUses, RELENTLESS_FLAG } from "../scripts/native/barbarian.mjs";

const { settings, uuids, makeToken } = env;
const MODULE_ID = "scorpious187s-luck-dice-automation";
beforeEach(() => { env.reset(); settings.deathSaves = true; game.users = [game.user]; });

let seq = 0;
/** A barbarian (GM-owned, no player online) at `hp`, raging or not, with Relentless Rage by these rules. */
function barbarian({ hp = 5, raging = true, rules = "2024", level = 11, spent = 0, saves = [] } = {}) {
  const token = makeToken(`barb${++seq}`, "Barbarian", { disposition: 1 });
  const actor = token.document.actor;
  const rage = { documentName: "Item", uuid: `Actor.b${seq}.Item.rage`, system: { identifier: "rage" } };
  uuids.set(rage.uuid, rage);
  const flags = {};
  const relentless = {
    name: "Relentless Rage", uuid: `Actor.b${seq}.Item.rr`, flags,
    system: { identifier: "relentless-rage", source: { rules }, uses: { spent }, activities: new Map([["s", { type: "save", uuid: `Actor.b${seq}.Item.rr.Activity.s` }]]) },
    getFlag: (_m, k) => flags[k], async setFlag(_m, k, v) { flags[k] = v; }, async unsetFlag(_m, k) { delete flags[k]; },
    async update(u) { relentless.system.uses.spent = u["system.uses.spent"]; }
  };
  const effects = raging ? [{ disabled: false, isSuppressed: false, system: { origin: { item: rage.uuid } }, _stats: {} }] : [];
  Object.assign(actor, {
    name: "Barbarian", type: "character", isOwner: true, statuses: new Set(), items: [relentless], effects, flags: {},
    classes: { barbarian: { system: { levels: level } } },
    system: { attributes: { hp: { value: hp, max: 120 }, death: { success: 0, failure: 0 } }, abilities: { con: { mod: 3 } } },
    getActiveTokens: () => [token], testUserPermission: () => false, toggled: [], saved: [],
    async toggleStatusEffect(id, { active }) { actor.toggled.push([id, active]); active ? actor.statuses.add(id) : actor.statuses.delete(id); },
    async update(u) { if ("system.attributes.hp.value" in u) actor.system.attributes.hp.value = u["system.attributes.hp.value"]; },
    async rollSavingThrow(config, dialog, message) {
      actor.saved.push({ dc: config.target, ability: config.ability, flavor: message?.data?.flavor });
      const passed = saves.shift() ?? false;
      return [{ parent: { id: `save${++seq}`, rolls: [{ isSuccess: passed, total: passed ? 18 : 4 }], system: {} } }];
    }
  });
  uuids.set(actor.uuid, actor);
  return { actor, relentless };
}
const drop = (actor, to = 0, extra = {}) => onPreApplyDamageRelentless(actor, 20, { "system.attributes.hp.value": to, ...extra });

test("noted only for a raging barbarian this damage drops from above 0 to 0 HP, and doesn't kill outright", () => {
  const b = barbarian();
  assert.equal(isRaging(b.actor), true);
  assert.equal(isRaging(barbarian({ raging: false }).actor), false);
  // Each case: the damage is applied next, and only the noted one is acted on (checked by the save it asks for).
  return (async () => {
    const cases = [
      [barbarian({ raging: false }), () => {}],
      [barbarian({ hp: 0 }), () => {}],                                       // already down: death saves instead
      [barbarian(), (a) => drop(a, 0, { "system.attributes.death.failure": 3 })], // massive damage: dead outright
      [barbarian(), (a) => drop(a, 3)]                                        // still standing
    ];
    for (const [{ actor }, hit] of cases) {
      if (hit.length) hit(actor); else drop(actor);
      actor.system.attributes.hp.value = 0;
      await onDamageAppliedRelentless(actor);
      assert.deepEqual(actor.saved, []);
    }
  })();
});

test("2024: a DC 10 Constitution save, back at twice the Barbarian level; each use adds 5 to the DC", async () => {
  const { actor, relentless } = barbarian({ saves: [true, false] });
  actor.statuses.add("unconscious");
  drop(actor); actor.system.attributes.hp.value = 0;
  await onDamageAppliedRelentless(actor);
  assert.deepEqual(actor.saved.map(s => [s.ability, s.dc]), [["con", 10]]);
  assert.match(actor.saved[0].flavor, /Relentless Rage — .*Saving Throw/);
  assert.equal(actor.system.attributes.hp.value, 22);                 // 2 × level 11
  assert.deepEqual(actor.toggled, [["unconscious", false]]);
  assert.equal(relentlessUses(relentless), 1);

  actor.system.attributes.hp.value = 5;
  drop(actor); actor.system.attributes.hp.value = 0;
  await onDamageAppliedRelentless(actor);
  assert.equal(actor.saved[1].dc, 15);
  assert.equal(actor.system.attributes.hp.value, 0);                  // failed: stays down
  assert.equal(relentlessUses(relentless), 2);
});

test("2014: back at 1 HP; the count is kept on the item and cleared by a rest; the setting off does nothing", async () => {
  const { actor, relentless } = barbarian({ rules: "2014", saves: [true] });
  drop(actor); actor.system.attributes.hp.value = 0;
  await onDamageAppliedRelentless(actor);
  assert.equal(actor.system.attributes.hp.value, 1);
  assert.equal(relentless.flags[RELENTLESS_FLAG], 1);
  await onRestRelentless(actor);
  assert.equal(relentless.flags[RELENTLESS_FLAG], undefined);

  settings.deathSaves = false;
  const other = barbarian({ saves: [true] });
  drop(other.actor); other.actor.system.attributes.hp.value = 0;
  await onDamageAppliedRelentless(other.actor);
  assert.deepEqual(other.actor.saved, []);
});
