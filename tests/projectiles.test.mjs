import { env } from "./env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { projectileCount, assignProjectiles, rayCount, fireRays } from "../scripts/native/projectiles.mjs";
import { applyCardDamage } from "../scripts/native/apply.mjs";
import { pendingAttacks } from "../scripts/native/shared.mjs";

const { settings, dialogs, notes, makeToken, damageRoll, messages, uuids } = env;
beforeEach(() => env.reset());

const item = (identifier, scalingIncrease = 0) => ({ name: identifier, system: { identifier }, scalingIncrease, updateSource(u) { this.last = u; } });
const usage = (scaling) => ({ id: "use1", system: scaling == null ? {} : { scaling } });
const missile = () => ({ type: "damage", item: item("magic-missile") });
const values = (select) => select.options.map(o => o.value).join(",");

test("projectile counts: base, upcast, cantrip tiers, wrong activity", () => {
  assert.equal(projectileCount(missile(), usage(null)).count, 3);
  assert.equal(projectileCount(missile(), usage(2)).count, 5);
  assert.equal(projectileCount({ type: "damage", item: item("magic-missile", 1) }, null).count, 4);
  assert.equal(projectileCount({ type: "attack", item: item("scorching-ray") }, usage(1)).count, 4);
  assert.equal(projectileCount({ type: "attack", item: item("eldritch-blast", 2) }, usage(null)).count, 3);
  assert.equal(projectileCount({ type: "attack", item: item("magic-missile") }, null), null);
  assert.equal(projectileCount({ type: "attack", item: item("fire-bolt") }, null), null);
});

test("rayCount: needs the setting and more than one ray", () => {
  const ray = { type: "attack", item: item("scorching-ray") };
  assert.equal(rayCount(ray, usage(null)), null);
  settings.rayAutomation = true;
  assert.equal(rayCount(ray, usage(null)).count, 3);
  assert.equal(rayCount({ type: "attack", item: item("eldritch-blast", 0) }, usage(null)), null);
});

test("one target takes every dart, no dialog", async () => {
  const [t] = await assignProjectiles(missile(), [{ name: "A" }], { count: 5, noun: "dart" });
  assert.equal(t.hits, 5);
});

test("drop-downs only offer what the others leave; Confirm waits for all", async () => {
  dialogs.push(async (ui) => {
    assert.match(ui.config.content, /3 darts, <strong>4<\/strong> damage each\. Choose/);
    assert.equal(values(ui.select("lda-hits-0")), "0,1,2,3");
    assert.equal(ui.buttons.ok.disabled, true);
    ui.change("lda-hits-0", 1);
    assert.equal(values(ui.select("lda-hits-1")), "0,1,2");
    assert.match(ui.nodes[".lda-hits-left"].textContent, /2 darts left/);
    ui.change("lda-hits-1", 2);
    assert.equal(values(ui.select("lda-hits-0")), "0,1");
    assert.equal(ui.buttons.ok.disabled, false);
    return "ok";
  });
  const out = await assignProjectiles(missile(), [{ name: "A" }, { name: "B" }], { count: 3, noun: "dart" }, "<strong>4</strong> damage each.");
  assert.deepEqual(out.map(t => t.hits), [1, 2]);
});

test("targets left at 0 are dropped; closing applies nothing", async () => {
  dialogs.push(async (ui) => { ui.change("lda-hits-0", 3); assert.equal(values(ui.select("lda-hits-2")), "0"); return "ok"; });
  const out = await assignProjectiles(missile(), [{ name: "A" }, { name: "B" }, { name: "C" }], { count: 3, noun: "dart" });
  assert.deepEqual(out.map(t => [t.name, t.hits]), [["A", 3]]);
  dialogs.push(async () => "close");
  assert.equal(await assignProjectiles(missile(), [{ name: "A" }, { name: "B" }], { count: 3, noun: "dart" }), null);
  assert.match(notes.at(-1), /wasn't applied/);
});

test("Luck Dice dart: offered only to targets with a dart, kept while valid, else the first", async () => {
  dialogs.push(async (ui) => {
    const luck = ui.select("lda-luck");
    assert.equal(values(luck), "");
    ui.change("lda-hits-0", 1); ui.change("lda-hits-2", 2);
    assert.equal(values(luck), "0,2");
    luck.value = "2"; ui.change("lda-hits-2", 2);
    assert.equal(luck.value, "2");
    return "ok";
  });
  const out = await assignProjectiles(missile(), [{ name: "A" }, { name: "B" }, { name: "C" }], { count: 3, noun: "dart" }, "", { luck: true });
  assert.deepEqual(out.map(t => [t.name, t.hits, !!t.luck]), [["A", 1, false], ["C", 2, true]]);

  dialogs.push(async (ui) => {
    ui.change("lda-hits-1", 3); ui.select("lda-luck").value = "1";
    ui.change("lda-hits-1", 0); ui.change("lda-hits-0", 3);
    assert.equal(ui.select("lda-luck").value, "0");
    return "ok";
  });
  const fallback = await assignProjectiles(missile(), [{ name: "A" }, { name: "B" }], { count: 3, noun: "dart" }, "", { luck: true });
  assert.deepEqual(fallback.map(t => [t.name, !!t.luck]), [["A", true]]);

  const [single] = await assignProjectiles(missile(), [{ name: "A" }], { count: 3, noun: "dart" }, "", { luck: true });
  assert.equal(single.luck, true);
});

// ── applying darts ──
function hpActor(name, hp = 50, { resist = false } = {}) {
  const actor = {
    uuid: `Actor.${name}`, name, seen: [],
    system: { _source: { attributes: { hp: { value: hp, temp: 0, tempmax: 0 } } } },
    calculateDamage: (d, { multiplier }) => ({ amount: d.reduce((s, x) => s + (resist ? Math.floor(x.value * multiplier / 2) : x.value * multiplier), 0) }),
    async applyDamage(d, { multiplier }) {
      const v = d.reduce((s, x) => s + (resist ? Math.floor(x.value * multiplier / 2) : x.value * multiplier), 0);
      actor.seen.push(v); actor.system._source.attributes.hp.value -= v;
    }
  };
  uuids.set(`Token.${name}`, { actor });
  return actor;
}
const card = (id, rolls) => {
  const message = { id, rolls, flags: {}, setFlag: async (_m, k, v) => { message.flags[k] = v; } };
  messages.set(id, message);
  return message;
};
const sumAggregate = (rolls) => [{ total: rolls.reduce((s, r) => s + r.total, 0), options: { type: "force", properties: [] } }];

test("each dart is its own instance: resistance per dart, undo delta across all", async () => {
  const goblin = hpActor("g", 20, { resist: true });
  const message = card("m1", [damageRoll(3)]);
  await applyCardDamage({ messageId: "m1", targets: [{ token: "Token.g", name: "Goblin", hits: 3 }] });
  assert.deepEqual(goblin.seen, [1, 1, 1]);                     // not floor(9 / 2) = 4
  const [entry] = message.flags.appliedDamage;
  assert.equal(entry.amount, 3); assert.equal(entry.hits, 3); assert.equal(entry.hp.value, 3);
});

test("Luck Dice go on the luck target's first dart only", async () => {
  globalThis.dnd5e.dice.aggregateDamageRolls = sumAggregate;
  try {
    const a = hpActor("a"), b = hpActor("b");
    const message = card("m2", [damageRoll(4), damageRoll(7, { ldaLuckDice: true })]);
    await applyCardDamage({ messageId: "m2", targets: [{ token: "Token.a", name: "A", hits: 1 }, { token: "Token.b", name: "B", hits: 2, luck: true }] });
    assert.deepEqual(a.seen, [4]);
    assert.deepEqual(b.seen, [11, 4]);
    assert.deepEqual(message.flags.appliedDamage.map(e => [e.name, e.amount, !!e.luck]), [["A", 4, false], ["B", 15, true]]);
    // An ordinary card applies everything once.
    a.seen.length = 0;
    await applyCardDamage({ messageId: "m2", targets: [{ token: "Token.a", name: "A" }] });
    assert.deepEqual(a.seen, [11]);
  } finally {
    globalThis.dnd5e.dice.aggregateDamageRolls = (rolls) => rolls;
  }
});

// ── rays ──
test("rays: one attack each at its target, in order, one at a time; targets restored", async () => {
  makeToken("a", "Goblin A"); makeToken("b", "Goblin B");
  canvas.tokens.setTargets(["a", "b"]);
  const attacks = [];
  let inFlight = 0, most = 0;
  const activity = {
    type: "attack", item: item("scorching-ray"), actor: {}, createConsumedFlag: () => null,
    async rollAttack(_config, _dialog, message) {
      const id = `atk${attacks.length}`;
      attacks.push({ target: [...game.user.targets].map(t => t.id).join(","), flavor: message.data.flavor, origin: message.data.system.origin });
      inFlight++; most = Math.max(most, inFlight);
      pendingAttacks.set(id, env.flush(5).then(() => { inFlight--; }));
      return [{ parent: { id } }];
    }
  };
  dialogs.push(async (ui) => {
    assert.match(ui.config.content, /4 rays, one attack roll each\./);
    ui.change("lda-hits-0", 1); ui.change("lda-hits-1", 3);
    return "ok";
  });
  await fireRays(activity, {}, { message: usage(1) }, { count: 4, noun: "ray" });
  assert.deepEqual(attacks.map(a => a.target), ["a", "b", "b", "b"]);
  assert.equal(attacks[1].flavor, "scorching-ray - Attack Roll (Ray 2 of 4)");
  assert.equal(attacks[0].origin, "use1");
  assert.equal(most, 1);
  assert.deepEqual([...game.user.targets].map(t => t.id), ["a", "b"]);
});

test("rays: a cancelled attack stops the volley; no targets gives a notice", async () => {
  makeToken("a", "Goblin A");
  canvas.tokens.setTargets(["a"]);
  let rolled = 0;
  const activity = { type: "attack", item: item("scorching-ray"), actor: {}, rollAttack: async () => { rolled++; return null; } };
  await fireRays(activity, {}, { message: usage(0) }, { count: 3, noun: "ray" });
  assert.equal(rolled, 1);
  canvas.tokens.setTargets([]);
  await fireRays(activity, {}, { message: usage(0) }, { count: 3, noun: "ray" });
  assert.match(notes.at(-1), /no targets for scorching-ray/);
});
