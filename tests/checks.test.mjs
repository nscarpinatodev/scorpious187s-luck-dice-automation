import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { breakConcentrationIfFailed } from "../scripts/native/checks.mjs";

const { settings } = env;
beforeEach(() => { env.reset(); settings.concentrationBreak = true; });

function concentrationCard({ total = 8, target = 10, outcome } = {}) {
  const message = {
    rolls: [{ total, options: { target }, isFailure: target != null && total < target }],
    system: { outcome },
    updates: [],
    async update(u) { message.updates.push(u); }
  };
  return message;
}
function concentrator({ isOwner = true, ends = 1 } = {}) {
  return { name: "Wizard", isOwner, ended: 0, async endConcentration() { this.ended++; return Array(ends).fill({}); } };
}

test("a failed concentration save ends concentration and marks the card", async () => {
  const message = concentrationCard(), actor = concentrator();
  await breakConcentrationIfFailed(message, actor);
  assert.equal(actor.ended, 1);
  assert.deepEqual(message.updates, [{ "system.outcome": "broken" }]);
});

test("nothing ended → the card isn't marked", async () => {
  const message = concentrationCard(), actor = concentrator({ ends: 0 });
  await breakConcentrationIfFailed(message, actor);
  assert.equal(actor.ended, 1);
  assert.deepEqual(message.updates, []);
});

for (const [name, setup] of [
  ["the setting is off", () => { settings.concentrationBreak = false; }],
  ["dnd5e's concentration is disabled", () => { settings.dnd5e.disableConcentration = true; }]
]) {
  test(`skipped when ${name}`, async () => {
    setup();
    const actor = concentrator();
    await breakConcentrationIfFailed(concentrationCard(), actor);
    assert.equal(actor.ended, 0);
  });
}

test("skipped: a pass (e.g. after Luck Dice), no DC, already broken, not the owner", async () => {
  const cases = [
    [concentrationCard({ total: 12 }), concentrator()],
    [concentrationCard({ target: null }), concentrator()],
    [concentrationCard({ target: 0 }), concentrator()],
    [concentrationCard({ outcome: "broken" }), concentrator()],
    [concentrationCard(), concentrator({ isOwner: false })]
  ];
  for (const [message, actor] of cases) {
    await breakConcentrationIfFailed(message, actor);
    assert.equal(actor.ended, 0);
  }
});
