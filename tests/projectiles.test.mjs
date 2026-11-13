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
  // dnd5e 6.1: another module's activity type that declares itself like an attack counts as one.
  const like = (type) => ({ type: "homebrew-attack", item: item("scorching-ray"), isLike: (t) => t === type || t === "homebrew-attack" });
  assert.equal(rayCount(like("attack"), usage(null)).count, 3);
  assert.equal(rayCount(like("save"), usage(null)), null);
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

test("dnd5e 6.1: the card's application options reach calculateDamage and applyDamage", async () => {
  const goblin = hpActor("g", 20, { resist: true });
  const passed = [];
  const resistUnlessIgnored = (d, o) => d.reduce((s, x) => s + (o.ignore?.resistance?.has("force") ? x.value : Math.floor(x.value / 2)) * o.multiplier, 0);
  goblin.calculateDamage = (d, o) => { passed.push(["calc", o]); return { amount: resistUnlessIgnored(d, o) }; };
  goblin.applyDamage = async (d, o) => { passed.push(["apply", o]); goblin.seen.push(resistUnlessIgnored(d, o)); };
  const message = card("m3", [damageRoll(8)]);
  // As DamageMessageData#getDamageApplicationOptions: the card's defaults merged into the target's.
  message.system = { getDamageApplicationOptions: (base) => ({ ...base, ignore: { resistance: new Set(["force"]) } }) };
  await applyCardDamage({ messageId: "m3", targets: [{ token: "Token.g", name: "Goblin", multiplier: 0.5 }] });
  assert.deepEqual(goblin.seen, [4]);                           // half on a save, resistance ignored
  assert.equal(message.flags.appliedDamage[0].amount, 4);
  const [[, calc], [, apply]] = passed;
  assert.equal(calc.multiplier, 0.5); assert.ok(calc.ignore.resistance.has("force"));
  assert.equal(apply.multiplier, 0.5); assert.ok(apply.ignore.resistance.has("force"));
  assert.equal(apply.isDelta, true); assert.equal(apply.originatingMessage, message);

  // dnd5e 6.0 cards have no such method: just the multiplier.
  passed.length = 0;
  delete message.system;
  await applyCardDamage({ messageId: "m3", targets: [{ token: "Token.g", name: "Goblin" }] });
  assert.deepEqual(passed.map(([, o]) => o.ignore), [undefined, undefined]);
  assert.deepEqual(goblin.seen, [4, 4]);
});

test("healing heals: it reaches dnd5e positive, as its own tray passes it (dnd5e negates healing types itself)", async () => {
  const healed = hpActor("h", 20);
  // As Actor5e#calculateDamage: healing negated, temporary HP apart.
  const calculate = (d, { multiplier }) => {
    const out = { amount: 0, temp: 0 };
    for (const x of d) {
      const value = x.value * multiplier;
      if (x.type === "temphp") out.temp += value;
      else out.amount += x.type === "healing" ? -value : value;
    }
    return out;
  };
  healed.calculateDamage = (d, o) => calculate(d, o);
  healed.applyDamage = async (d, o) => { const { amount, temp } = calculate(d, o); healed.system._source.attributes.hp.value -= amount; healed.system._source.attributes.hp.temp = Math.max(healed.system._source.attributes.hp.temp, temp); };
  const cure = card("heal1", [damageRoll(8, { type: "healing" })]);
  await applyCardDamage({ messageId: "heal1", targets: [{ token: "Token.h", name: "Hurt" }] });
  assert.equal(healed.system._source.attributes.hp.value, 28);
  assert.equal(cure.flags.appliedDamage[0].amount, -8);                 // shown as +8 on the card
  assert.equal(cure.flags.appliedDamage[0].hp.value, -8);               // and undone the right way

  const armor = card("heal2", [damageRoll(5, { type: "temphp" })]);
  await applyCardDamage({ messageId: "heal2", targets: [{ token: "Token.h", name: "Hurt" }] });
  assert.equal(healed.system._source.attributes.hp.temp, 5);
  assert.equal(armor.flags.appliedDamage[0].temp, 5);
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
  // The targets are always confirmed first for rays (AC5E allows one target when casting).
  dialogs.push(async (ui) => { assert.match(ui.config.content, /Target each creature to fire at/); return "ok"; });
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
  dialogs.push(async () => "ok");
  await fireRays(activity, {}, { message: usage(0) }, { count: 3, noun: "ray" });
  assert.equal(rolled, 1);
  canvas.tokens.setTargets([]);
  dialogs.push(async () => "ok");
  await fireRays(activity, {}, { message: usage(0) }, { count: 3, noun: "ray" });
  assert.match(notes.at(-1), /no targets for scorching-ray/);
});
