// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// On-hit riders: damage an attacker's other features add when an attack hits.
//
// The "onHitRiders" setting. When a hit's damage is rolled, the attacker's riders
// are found by item identifier:
//   marks   — Hunter's Mark, Hex: added automatically when every target hit
//             carries this caster's mark (an effect that came from the item);
//   chosen  — Sneak Attack (finesse or ranged weapon, once per turn in combat),
//             Divine Smite (melee weapon or unarmed strike; its fiend / undead
//             version against those), Divine Strike and Primal Strike (weapon
//             hit, once per turn, their damage type picked) and Colossus Slayer
//             (a target missing Hit Points, once per turn, the weapon's damage
//             type): offered as checkboxes. With 2024 Cunning Strike, Sneak Attack then asks which of its
//             effects to pay for with its dice (cunning.mjs).
// Savage Attacker (applySavageAttacker, below) rolls a weapon hit's dice twice.
// Each rider's own damage activity rolls its dice — as critical damage on a
// critical hit — and they join the hit's damage card, so the damage tray and the
// attack automation apply them as part of the same hit (one instance of damage).
// A rider that spends something (Divine Smite's spell slot, limited uses) is used
// through dnd5e first, with its own dialog; dnd5e's follow-up roll for that use
// is suppressed (see claimRiderUse) so its dice land on the hit instead. A once-per-turn
// rider whose only cost is its own use (2024 Sneak Attack) just has that use marked spent.
// Under the "invocations" setting instead (invocations.mjs): Eldritch Smite (a Pact
// Magic slot; then Prone, if the target is Huge or smaller) and Lifedrinker (2014:
// the Charisma modifier as necrotic damage, on every pact weapon hit; 2024: 1d6 of a
// chosen type once per turn, then a Hit Die spent to heal, if wanted).

import { MODULE_ID, debug, escapeHTML, isOnHitRidersEnabled, isInvocationsEnabled, promptChoice, NO_DIALOG, showRollToAdd, waitForAddedRolls, antimagicStops, isLike } from "./shared.mjs";
import { tokenDistance, rulesOf } from "./advantage.mjs";
import { isPactWeapon } from "./invocations.mjs";
import { applyMasteryChange } from "./mastery.mjs";
import { smiteAfter } from "./smites.mjs";
import { cunningConfigure, cunningAfter } from "./cunning.mjs";

export const RIDERS_FLAG = "riders";

const isWeaponAttack = (activity) => ["weapon", "unarmed"].includes(activity?.attack?.type?.classification)
  || activity?.item?.type === "weapon";
const isMelee  = (activity, card) => activity?.attack?.type?.value === "melee" && !String(card?.system?.mode ?? "").startsWith("thrown");
const isRanged = (activity, card) => activity?.attack?.type?.value === "ranged" || String(card?.system?.mode ?? "").startsWith("thrown");
const creatureType = (actor) => actor?.system?.details?.type?.value ?? actor?.system?.details?.race?.type ?? null;
const damageActivities = (item) => [...(item?.system?.activities?.values?.() ?? [])].filter(a => isLike(a, "damage"));

/** By item identifier: how the rider is offered, when, and which damage activities it rolls. */
export const RIDERS = {
  "hunters-mark": { mode: "mark", activities: (item) => damageActivities(item).slice(0, 1) },
  "hex":          { mode: "mark", activities: (item) => damageActivities(item).slice(0, 1) },
  "sneak-attack": {
    mode: "choose", checked: true, oncePerTurn: true,
    // A finesse or ranged weapon, and either advantage on the roll, or an ally of yours (not incapacitated)
    // within 5 ft of the target — and never with disadvantage.
    eligible: ({ activity, card, tokens }) => isWeaponAttack(activity)
      && (activity.item?.system?.properties?.has?.("fin") || isRanged(activity, card))
      && sneakAttackAllowed(activity, card, tokens),
    activities: (item) => damageActivities(item).slice(0, 1),
    // 2024 Cunning Strike (cunning.mjs): effects paid for with Sneak Attack dice, then their saves.
    configure: cunningConfigure, after: cunningAfter
  },
  "divine-smite": {
    mode: "choose", checked: false,
    eligible: ({ activity, card }) => isWeaponAttack(activity) && isMelee(activity, card),
    // 2024 spell: a separate "Unholy Creature" activity replaces the base one against fiends and undead.
    // 2014 feature: a second activity adds its dice against them.
    activities: (item, { targets }) => {
      const all = damageActivities(item);
      const unholy = targets.length > 0 && targets.every(t => ["fiend", "undead"].includes(creatureType(t)));
      const named = all.find(a => /unholy|undead|fiend/i.test(a.name ?? ""));
      if (named) return [unholy ? named : all.find(a => a !== named) ?? named];
      return unholy ? all.slice(0, 2) : all.slice(0, 1);
    }
  },
  // The 2024 smite spells (smites.mjs): cast right after a melee weapon or Unarmed Strike hit, like Divine Smite;
  // their effect and save follow. 2014 Branding Smite (cast beforehand) is left to dnd5e.
  ...Object.fromEntries(["searing-smite", "thunderous-smite", "wrathful-smite", "shining-smite"].map(id => [id, {
    mode: "choose", checked: false,
    eligible: ({ activity, card }) => isWeaponAttack(activity) && isMelee(activity, card),
    activities: (item) => rulesOf(item) === "2014" ? [] : damageActivities(item).slice(0, 1),
    after: smiteAfter
  }])),
  // Great Weapon Master (2024): a hit with a Heavy weapon as part of the Attack action on your turn deals extra
  // damage equal to your Proficiency Bonus (its damage activity), the weapon's damage type. Added automatically.
  "great-weapon-master": {
    mode: "auto", checked: true,
    eligible: ({ activity }) => isWeaponAttack(activity) && !!activity.item?.system?.properties?.has?.("hvy") && onOwnTurn(activity.actor),
    activities: (item) => rulesOf(item) === "2014" ? [] : damageActivities(item).slice(0, 1), damageType: "weapon"
  },
  "eldritch-smite": {
    mode: "choose", checked: false, oncePerTurn: true, setting: isInvocationsEnabled,
    eligible: ({ activity }) => isPactWeapon(activity),
    activities: (item) => damageActivities(item).slice(0, 1),
    after: smiteProne
  },
  "lifedrinker": {
    // 2014: added to every pact weapon hit. 2024: offered once per turn, its type chosen, then a Hit Die to heal.
    mode: (item) => rulesOf(item) === "2014" ? "auto" : "choose",
    checked: true, oncePerTurn: (item) => rulesOf(item) !== "2014", setting: isInvocationsEnabled,
    eligible: ({ activity }) => isPactWeapon(activity),
    activities: () => [],
    roll: lifedrinkerDamage,
    after: lifedrinkerHeal
  },
  // Blessed Strikes / Elemental Fury (2024 Cleric 7, Druid 7): once per turn on a weapon hit, its type chosen;
  // the improved dice from Cleric 14 / Druid 15.
  "divine-strike": {
    mode: "choose", checked: true, oncePerTurn: true,
    eligible: ({ activity }) => isWeaponAttack(activity),
    activities: improvedStrike("cleric", 14), damageType: ["radiant", "necrotic"]
  },
  "primal-strike": {
    mode: "choose", checked: true, oncePerTurn: true,
    eligible: ({ activity }) => isWeaponAttack(activity),
    activities: improvedStrike("druid", 15), damageType: ["cold", "fire", "lightning", "thunder"]
  },
  // Hunter's Prey (2024 Hunter Ranger 3), Colossus Slayer: once per turn, a weapon hit on a creature missing
  // any of its Hit Points; the weapon's damage type. (Horde Breaker is an extra attack, not damage.)
  "hunters-prey": {
    mode: "choose", checked: true, oncePerTurn: true,
    eligible: ({ activity, targets }) => isWeaponAttack(activity) && targets.some(missingHP),
    activities: (item) => damageActivities(item).filter(a => /colossus/i.test(a.name ?? "")).slice(0, 1), damageType: "weapon"
  }
};

/** Whether it's this creature's turn in combat (or there's no combat). */
function onOwnTurn(actor) {
  const combat = game.combat;
  if (!combat?.started) return true;
  return combat.combatant?.actor === actor || (!!actor?.uuid && combat.combatant?.actor?.uuid === actor.uuid);
}

/** Divine / Primal Strike: the improved activity from this class level, else the base one. */
function improvedStrike(classId, level) {
  return (item) => {
    const all = damageActivities(item);
    const improved = all.find(a => /improved/i.test(a.name ?? ""));
    const base = all.find(a => a !== improved) ?? improved;
    const levels = Number(item.actor?.classes?.[classId]?.system?.levels ?? 0) || 0;
    return [levels >= level && improved ? improved : base].filter(Boolean);
  };
}

/** Whether a creature is missing any of its Hit Points. */
function missingHP(actor) {
  const hp = actor?.system?.attributes?.hp;
  const max = Number(hp?.effectiveMax ?? hp?.max);
  return Number.isFinite(max) && Number(hp?.value) < max;
}

/**
 * The damage type a rider's dice deal: one it names, the weapon's ("weapon": the hit's own damage roll), or
 * the attacker's pick of several. Null when the rider leaves its activity's own type.
 */
async function riderDamageType(choice, message) {
  const want = choice.rider.damageType;
  if (want === "weapon") return message?.rolls?.[0]?.options?.type ?? null;
  if (!Array.isArray(want) || !want.length) return null;
  if (want.length === 1) return want[0];
  const label = (t) => game.i18n.localize(CONFIG.DND5E?.damageTypes?.[t]?.label ?? t);
  const picked = await promptChoice(choice.item.name, "<p>Which damage type?</p>", want.map(t => ({ action: t, label: label(t) })));
  return want.includes(picked) ? picked : want[0];
}

/** Eldritch Smite: offer to knock each Huge or smaller creature hit Prone. */
async function smiteProne(choice, { hits }) {
  const done = [];
  for (const hit of hits) {
    const targetDoc = hit.token ? await fromUuid(hit.token) : null;
    const size = targetDoc?.actor?.system?.traits?.size ?? "med";
    if (!targetDoc?.actor || size === "grg" || targetDoc.actor.statuses?.has?.("prone")) continue;
    const answer = await promptChoice("Eldritch Smite", `<p>Knock <strong>${escapeHTML(hit.name)}</strong> Prone?</p>`,
      [{ action: "prone", label: "Knock Prone" }, { action: "no", label: "No" }]);
    if (answer !== "prone") continue;
    await applyMasteryChange({ kind: "prone", token: hit.token, actor: hit.actor });
    done.push(`${hit.name} knocked Prone`);
  }
  return done;
}

/** Lifedrinker's damage: the Charisma modifier as necrotic (2014), or 1d6 of the chosen type (2024). */
async function lifedrinkerDamage(choice, { activity, isCritical }) {
  const actor = activity.actor;
  if (rulesOf(choice.item) === "2014") {
    const amount = Math.max(1, Number(actor.system?.abilities?.cha?.mod ?? 0) || 0);
    return [await new CONFIG.Dice.DamageRoll(String(amount), {}, { type: "necrotic", types: ["necrotic"] }).evaluate()];
  }
  const type = await promptChoice("Lifedrinker", "<p>Which damage type?</p>",
    [{ action: "necrotic", label: "Necrotic" }, { action: "psychic", label: "Psychic" }, { action: "radiant", label: "Radiant" }]);
  if (!["necrotic", "psychic", "radiant"].includes(type)) return [];
  return [await new CONFIG.Dice.DamageRoll("1d6", actor.getRollData?.() ?? {}, { type, types: [type], isCritical }).evaluate()];
}

/** Lifedrinker 2024: offer to spend a Hit Die to heal — its heal activity, used through dnd5e. */
async function lifedrinkerHeal(choice) {
  if (rulesOf(choice.item) === "2014") return [];
  const heal = [...(choice.item.system?.activities?.values?.() ?? [])].find(a => isLike(a, "heal"));
  if (!heal) return [];
  const answer = await promptChoice("Lifedrinker", "<p>Spend a Hit Point Die to regain hit points?</p>",
    [{ action: "heal", label: "Spend a Hit Die" }, { action: "no", label: "No" }]);
  if (answer !== "heal") return [];
  return (await heal.use({}, {}, {})) ? ["Hit Die spent to heal"] : [];
}

const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];

/** Sneak Attack's condition: advantage, or an active ally within 5 ft of every target; never disadvantage. */
function sneakAttackAllowed(activity, card, tokens) {
  const modes = CONFIG.Dice.D20Roll?.ADV_MODE ?? { ADVANTAGE: 1, DISADVANTAGE: -1 };
  const mode = card?.rolls?.[0]?.options?.advantageMode;
  if (mode === modes.DISADVANTAGE) return false;
  if (mode === modes.ADVANTAGE) return true;
  const usage = activity?.getUsageToken?.() ?? null;
  const me = usage?.document ?? usage;
  if (!me?.parent || !tokens?.length) return false;
  const reach = canvas?.grid?.distance ?? 5;
  return tokens.every(target => [...(me.parent.tokens ?? [])].some(ally => ally.id !== me.id && ally.id !== target.id
    && ally.actor && ally.disposition === me.disposition && !INCAPACITATING.some(s => ally.actor.statuses?.has?.(s))
    && tokenDistance(ally, target) <= reach));
}

/** Whether an effect on a target came from this item (dnd5e's effects tray records the source). */
function cameFrom(effect, item) {
  if (effect.disabled || effect.isSuppressed) return false;
  const base = item.uuid;
  return [effect.system?.origin?.activity, effect.system?.origin?.item, effect._stats?.duplicateSource,
    effect._stats?.compendiumSource, effect.origin].some(source => typeof source === "string" && source.startsWith(base));
}

// Sneak Attack and the like: the turn each attacker last used a once-per-turn rider, by "actor uuid:identifier".
const usedThisTurn = new Map();
const turnKey = () => game.combat?.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : null;

/** The riders the attacker may add to this hit: [{ item, rider, identifier, activities }]. */
export async function eligibleRiders(activity, card) {
  const actor = activity?.actor;
  if (!actor) return [];
  const hits = (card?.system?.evaluatedTargets ?? []).filter(t => !t.isMiss);
  const tokens = (await Promise.all(hits.map(async t => t.token ? await fromUuid(t.token) : null))).filter(t => t?.actor);
  const targets = (await Promise.all(hits.map(async t => (await fromUuid(t.token ?? t.uuid))?.actor ?? await fromUuid(t.actor ?? t.uuid))))
    .filter(Boolean);
  const turn = turnKey();
  const out = [];
  for (const item of actor.items ?? []) {
    const identifier = item.system?.identifier;
    const rider = RIDERS[identifier];
    if (!rider || item === activity.item || !(rider.setting ?? isOnHitRidersEnabled)()) continue;
    if (antimagicStops(actor, item)) continue; // dnd5e 6.1+: no spell or Magical feature in antimagic
    const mode = typeof rider.mode === "function" ? rider.mode(item) : rider.mode;
    const oncePerTurn = typeof rider.oncePerTurn === "function" ? rider.oncePerTurn(item) : !!rider.oncePerTurn;
    if (mode === "mark") {
      if (!targets.length || !targets.every(t => t.effects?.some?.(e => cameFrom(e, item)))) continue;
    } else {
      if (rider.eligible && !rider.eligible({ activity, card, targets, tokens })) continue;
      if (oncePerTurn && turn && usedThisTurn.get(`${actor.uuid}:${identifier}`) === turn) continue;
    }
    const activities = rider.activities(item, { targets });
    if (activities.length || rider.roll) out.push({ item, rider, identifier, activities, mode, oncePerTurn });
  }
  return out;
}

/** Checkboxes for the chosen riders. Resolves with the chosen ones, [] when none or closed. */
async function chooseRiders(card, choices, marks) {
  const DialogV2 = foundry.applications.api?.DialogV2;
  if (!DialogV2 || !choices.length) return [];
  const label = (c) => `${escapeHTML(c.item.name)}${spendsSomething(c) ? ` <span style="opacity:0.7">(spends a resource)</span>` : ""}`;
  const rows = choices.map((c, i) => `
    <label style="display:flex;align-items:center;gap:6px;margin:3px 0">
      <input type="checkbox" name="lda-rider" value="${i}"${c.rider.checked ? " checked" : ""}> ${label(c)}
    </label>`).join("");
  const markNote = marks.length ? `<p style="opacity:0.8">Added: ${marks.map(m => escapeHTML(m.item.name)).join(", ")}.</p>` : "";
  const chosen = await DialogV2.wait({
    window:  { title: "On-Hit Damage" },
    content: `<p>Add to this hit${card.rolls?.[0]?.isCritical ? " (critical — extra dice are doubled)" : ""}?</p>${rows}${markNote}`,
    buttons: [
      { action: "ok", label: "Add", icon: "fa-solid fa-plus", default: true,
        callback: (_event, button) => [...button.form.querySelectorAll('input[name="lda-rider"]:checked')].map(i => Number(i.value)) },
      { action: "skip", label: "None", icon: "fa-solid fa-xmark", callback: () => [] }
    ],
    rejectClose: false
  });
  return Array.isArray(chosen) ? chosen.map(i => choices[i]).filter(Boolean) : [];
}

/**
 * Whether using the rider spends anything: a leveled spell's slot (when its
 * activity takes one), or item uses / resources. A mark's bonus damage never
 * does — the mark was paid for when it was cast (some legacy data says otherwise).
 */
export function spendsSomething({ item, rider, activities, mode, oncePerTurn }) {
  if ((mode ?? rider?.mode) === "mark" || rider?.roll) return false;
  const activity = activities[0];
  if (item.type === "spell") return (item.system?.level ?? 0) > 0 && activity?.consumption?.spellSlot !== false;
  if (oncePerTurn && ownUsesOnly(activity)) return false;
  return (activity?.consumption?.targets?.length ?? 0) > 0;
}

/** A consumption target that spends the activity's own uses, or its own item's (no other item named). */
const ownUseTarget = (t, activity) => t?.type === "activityUses"
  || (t?.type === "itemUses" && (!t.target || t.target === activity?.item?.id));

/**
 * Whether an activity's only cost is its own uses — 2024 Sneak Attack from dnd5e 6.1 (one use, back
 * every turn: the item's; the activity's in the pre-release). For a once-per-turn rider that's the
 * limit this module already keeps, so it's rolled as before, without dnd5e's use (its window and
 * card), and a use is marked spent while one is left.
 */
const ownUsesOnly = (activity) => {
  const targets = activity?.consumption?.targets ?? [];
  return targets.length > 0 && targets.every(t => ownUseTarget(t, activity));
};

/** Marks a rider's own use spent — the activity's or its item's — when one is left (never blocks the rider). */
async function spendOwnUse(activity) {
  const target = activity?.consumption?.targets?.[0];
  const onItem = target?.type === "itemUses";
  const doc = onItem ? activity.item : activity;
  const uses = onItem ? activity.item?.system?.uses : activity?.uses;
  if (!uses?.max || !(Number(uses.value) > 0) || typeof doc?.update !== "function") return;
  const cost = Math.max(1, Number(target?.value) || 1);
  await doc.update({ [onItem ? "system.uses.spent" : "uses.spent"]: (Number(uses.spent) || 0) + Math.min(cost, Number(uses.value)) });
}

// ── A rider used through dnd5e (to spend its slot or uses) ───────────────────

// Uses in progress for riders, by item id: resolves with the use's (scaled) activity.
const pendingRiderUses = new Map();

/**
 * dnd5e.postUseActivity: if this use is a rider in progress, turn off dnd5e's
 * follow-up roll and hand the scaled activity to the rider. True when claimed.
 */
export function claimRiderUse(activity, usageConfig) {
  const resolve = pendingRiderUses.get(activity?.item?.id);
  if (!resolve) return false;
  pendingRiderUses.delete(activity.item.id);
  if (usageConfig) usageConfig.subsequentActions = false;
  resolve(activity);
  return true;
}

/**
 * Use an activity through dnd5e (spending what it spends, posting its card), with neither dnd5e's follow-up
 * nor this module's save automation for it (claimRiderUse claims the use). Resolves with dnd5e's results, or null.
 */
export async function useClaimed(activity, usage = {}, dialog = {}) {
  pendingRiderUses.set(activity.item.id, () => {});
  try { return (await activity.use({ subsequentActions: true, ...usage }, dialog, {})) ?? null; }
  finally { pendingRiderUses.delete(activity.item.id); }
}

/** The activity to roll for a rider: as is, or after using it through dnd5e. Null if the use was cancelled. */
async function riderActivity(choice, activity) {
  if (!spendsSomething(choice)) {
    if (choice.oncePerTurn && ownUsesOnly(activity)) {
      await spendOwnUse(activity).catch(err => console.error(`[${MODULE_ID}] riders: ${choice.item.name}'s use:`, err));
    }
    return activity;
  }
  const claimed = new Promise(resolve => pendingRiderUses.set(choice.item.id, resolve));
  try {
    const results = await activity.use({ subsequentActions: true }, {}, {});
    if (!results) return null;
    choice.usage = results.message ?? null; // its card, for what follows (a smite's effect and save)
    return await Promise.race([claimed, new Promise(r => setTimeout(() => r(null), 1000))]);
  } finally {
    pendingRiderUses.delete(choice.item.id);
  }
}

/**
 * After a hit's damage is rolled: add the attacker's riders to the damage card.
 * Runs on the roller's client (they authored the card). Does nothing when the
 * setting is off, there are none, or they were already added to this card.
 */
export async function addOnHitRiders(message, activity, card) {
  if ((!isOnHitRidersEnabled() && !isInvocationsEnabled()) || !message || !card || message.getFlag?.(MODULE_ID, RIDERS_FLAG)) return;
  // Every target missed (damage rolled anyway — 2024 Potent Cantrip's half): no hit to ride on.
  const evaluated = card.system?.evaluatedTargets ?? [];
  if (evaluated.length && evaluated.every(t => t.isMiss)) return;
  const riders = await eligibleRiders(activity, card);
  if (!riders.length) return;
  const automatic = riders.filter(r => r.mode === "mark" || r.mode === "auto");
  const chosen  = [...automatic, ...await chooseRiders(card, riders.filter(r => r.mode === "choose"), automatic)];
  if (!chosen.length) return;

  const isCritical = !!card.rolls?.[0]?.isCritical;
  const hits = (card.system?.evaluatedTargets ?? []).filter(t => !t.isMiss);
  const added = [], rolls = [], afterwards = [];
  for (const choice of chosen) {
    const before = rolls.length;
    if (choice.rider.roll) {
      // A rider that rolls its own damage (Lifedrinker).
      const riderRolls = (await choice.rider.roll(choice, { activity, card, isCritical })) ?? [];
      for (const r of riderRolls) await showRollToAdd(r);
      rolls.push(...riderRolls);
      if (riderRolls.length) added.push({ name: choice.item.name, formula: riderRolls.map(r => r.formula).join(" + "), total: riderRolls.reduce((s, r) => s + r.total, 0) });
    }
    // A step before the dice (Sneak Attack's Cunning Strike): it can swap the activity and set its scaling.
    if (choice.rider.configure) await choice.rider.configure(choice, { activity, card, hits });
    const type = choice.activities.length ? await riderDamageType(choice, message) : null;
    for (const [index, base] of choice.activities.entries()) {
      // Only the first activity is used (spends the resource); the rest just roll.
      const act = index === 0 ? await riderActivity(choice, base) : base;
      if (!act) break;
      const riderRolls = await act.rollDamage({ isCritical, ...(choice.scaling ? { scaling: choice.scaling } : {}), ...NO_DIALOG }, { configure: false }, { create: false });
      if (!riderRolls?.length) continue;
      if (type) for (const r of riderRolls) Object.assign(r.options, { type, types: [type] });
      for (const r of riderRolls) await showRollToAdd(r);
      rolls.push(...riderRolls);
      added.push({ name: choice.item.name, formula: riderRolls.map(r => r.formula).join(" + "), total: riderRolls.reduce((s, r) => s + r.total, 0) });
    }
    if (rolls.length > before && choice.rider.after) afterwards.push(choice);
    if (choice.oncePerTurn && turnKey()) usedThisTurn.set(`${activity.actor.uuid}:${choice.identifier}`, turnKey());
  }
  if (!rolls.length) return;
  await message.update({ rolls: [...message.rolls, ...rolls], [`flags.${MODULE_ID}.${RIDERS_FLAG}`]: added });
  await waitForAddedRolls(message);
  debug(`riders: ${added.map(a => `${a.name} ${a.total}`).join(", ")}${isCritical ? " (critical)" : ""}`);
  console.log(`[${MODULE_ID}] on-hit riders: ${activity.actor.name} added ${added.map(a => `${a.name} (${a.formula} = ${a.total})`).join(", ")}`);

  // What a rider does besides damage (Eldritch Smite's Prone, Lifedrinker's healing), noted with it.
  for (const choice of afterwards) {
    const notes = await choice.rider.after(choice, { activity, card, hits });
    if (!notes?.length) continue;
    const entry = added.find(a => a.name === choice.item.name);
    if (entry) entry.note = notes.join("; ");
  }
  if (added.some(a => a.note)) await message.setFlag(MODULE_ID, RIDERS_FLAG, added);
}

// ── Savage Attacker ───────────────────────────────────────────────────────────

export const SAVAGE_FLAG = "savageAttacker"; // on the damage card: { first, second, kept }

/**
 * Savage Attacker (feat), under the "onHitRiders" setting: once per turn, when a weapon hit's damage is
 * rolled, its weapon damage dice (the hit's own damage roll) are rolled again and the higher total is used.
 * There's no reason to keep the lower, so nothing is asked; the card notes both.
 */
export async function applySavageAttacker(message, activity) {
  const actor = activity?.actor;
  if (!isOnHitRidersEnabled() || !actor?.isOwner || !message || message.getFlag?.(MODULE_ID, SAVAGE_FLAG)) return;
  if (!isWeaponAttack(activity) || !actor.items?.find?.(i => i.system?.identifier === "savage-attacker")) return;
  const turn = turnKey(), key = `${actor.uuid}:savage-attacker`;
  if (turn && usedThisTurn.get(key) === turn) return;
  const roll = message.rolls?.[0];
  if (!(roll instanceof CONFIG.Dice.DamageRoll) || roll.options?.ldaLuckDice) return;
  const dice = (roll.dice ?? []).flatMap((term, termIndex) => (term.results ?? [])
    .map((result, resultIndex) => ({ termIndex, resultIndex, faces: term.faces, value: result.result, active: result.active !== false && !result.rerolled })))
    .filter(d => d.active);
  if (!dice.length) return;
  if (turn) usedThisTurn.set(key, turn);
  const again = await new Roll(dice.map(d => `1d${d.faces}`).join(" + ")).evaluate();
  await showRollToAdd(again);
  const newValues = again.dice.map(d => d.total);
  const first = dice.reduce((s, d) => s + d.value, 0), second = newValues.reduce((s, v) => s + v, 0);
  const kept = second > first ? "second" : "first";
  const update = { [`flags.${MODULE_ID}.${SAVAGE_FLAG}`]: { first, second, kept } };
  if (kept === "second") {
    const copies = message.rolls.map(r => (typeof r?.toJSON === "function" && r.constructor?.fromData) ? r.constructor.fromData(r.toJSON()) : r);
    const copy = copies[0];
    dice.forEach((d, n) => {
      const term = copy.dice[d.termIndex];
      Object.assign(term.results[d.resultIndex], { active: false, rerolled: true });
      term.results.push({ result: newValues[n], active: true });
    });
    if (typeof copy._evaluateTotal === "function") copy._total = copy._evaluateTotal();
    update.rolls = copies;
  }
  await message.update(update);
  console.log(`[${MODULE_ID}] savage attacker: ${actor.name} rolled the weapon dice again (${first} / ${second}) — kept the ${kept}`);
}
