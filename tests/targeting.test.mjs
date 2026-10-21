import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { needsConfirmation, confirmTargets, tokensInActivityArea } from "../scripts/native/targeting.mjs";
import { resolveSaveTargets } from "../scripts/native/saves.mjs";

const { settings, dialogs, hooks, makeToken, scene } = env;
beforeEach(() => env.reset());

const region = (inside) => ({ documentName: "Region", inside, parent: scene });
const listHTML = (ui) => ui.nodes[".lda-confirm-list"].innerHTML;
const untarget = (ui, id) => ui.click({ closest: () => ({ dataset: { ldaUntarget: id } }) });

test("needsConfirmation follows the setting, skips self-only uses", () => {
  const act = { type: "damage" };
  settings.targetConfirmation = "off";  assert.equal(needsConfirmation(act, { templates: [region(["a"])] }), false);
  settings.targetConfirmation = "area"; assert.equal(needsConfirmation(act, { templates: [region(["a"])] }), true);
  assert.equal(needsConfirmation(act, { templates: [] }), false);
  settings.targetConfirmation = "all";  assert.equal(needsConfirmation(act, {}), true);
  assert.equal(needsConfirmation({ target: { affects: { type: "self" } } }, {}), false);
  assert.equal(needsConfirmation({ range: { units: "self" } }, {}), false);
});

test("the list follows canvas targeting, removes from the list, and unhooks", async () => {
  makeToken("a", "Goblin A"); makeToken("b", "Goblin B"); makeToken("c", "Ogre");
  canvas.tokens.setTargets(["a", "b"]);
  dialogs.push(async (ui) => {
    assert.match(listHTML(ui), /Goblin A[\s\S]*Goblin B/);
    canvas.tokens.setTargets(["c"], { mode: "acquire" });
    assert.match(listHTML(ui), /Ogre/);
    untarget(ui, "a");
    assert.doesNotMatch(listHTML(ui), /Goblin A/);
    assert.equal(ui.buttons.ok.disabled, false);
    return "ok";
  });
  const confirmed = await confirmTargets({ name: "Spell" });
  assert.deepEqual(confirmed.map(t => t.id), ["b", "c"]);
  assert.equal(hooks.count("targetToken"), 0);
});

test("no targets disables Confirm; cancel and close resolve null", async () => {
  makeToken("a", "Goblin A");
  canvas.tokens.setTargets(["a"]);
  dialogs.push(async (ui) => { untarget(ui, "a"); assert.equal(ui.buttons.ok.disabled, true); return "cancel"; });
  assert.equal(await confirmTargets({ name: "Spell" }), null);
  dialogs.push(async () => "close");
  assert.equal(await confirmTargets({ name: "Spell" }), null);
  assert.equal(hooks.count("targetToken"), 0);
});

test("area tokens: in the region, by disposition, caster left out of a self-range area", () => {
  const caster = makeToken("me", "Caster", { disposition: 1 });
  makeToken("foe", "Foe", { disposition: -1 });
  makeToken("pal", "Pal", { disposition: 1 });
  const regions = [region(["me", "foe", "pal"])];
  const activity = (type, units = "ft") => ({ target: { affects: { type } }, range: { units }, getUsageToken: () => caster.document });
  assert.deepEqual(tokensInActivityArea(activity("enemy"), regions).map(t => t.id), ["foe"]);
  assert.deepEqual(tokensInActivityArea(activity("ally"), regions).map(t => t.id), ["me", "pal"]);
  assert.deepEqual(tokensInActivityArea(activity("", "self"), regions).map(t => t.id), ["foe", "pal"]);
});

test("save targets with confirmation: the area's creatures, then the confirmed list; cancel → null", async () => {
  makeToken("a", "Goblin A"); makeToken("c", "Ogre");
  settings.targetConfirmation = "area";
  dialogs.push(async (ui) => { assert.match(listHTML(ui), /Goblin A[\s\S]*Ogre/); untarget(ui, "c"); return "ok"; });
  const targets = await resolveSaveTargets({ type: "save", target: { affects: { choice: true } } }, { templates: [region(["a", "c"])] });
  assert.deepEqual(targets.map(t => t.name), ["Goblin A"]);
  dialogs.push(async () => "cancel");
  assert.equal(await resolveSaveTargets({ type: "save" }, { templates: [region(["a"])] }), null);
});

test("the confirm window leaves Foundry's targeting keys working (its buttons don't take keyboard focus)", async () => {
  const buttons = [{ dataset: {} }, { dataset: {} }];
  const original = foundry.applications.api.DialogV2.wait;
  foundry.applications.api.DialogV2.wait = async (config) => {
    const root = { querySelectorAll: (q) => q === "button" ? buttons : [], querySelector: () => null, addEventListener: () => {} };
    config.render({}, { element: root });
    return null;
  };
  try { await confirmTargets({ name: "Spell" }); } finally { foundry.applications.api.DialogV2.wait = original; }
  assert.deepEqual(buttons.map(b => b.dataset.keyboardFocus), ["false", "false"]);
});
