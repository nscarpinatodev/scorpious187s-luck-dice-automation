// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// On-hit riders: damage an attacker's other features add when an attack hits.
//
// The "onHitRiders" setting. When a hit's damage is rolled, the attacker's riders
// are found by item identifier:
//   marks   — Hunter's Mark, Hex: added automatically when every target hit
//             carries this caster's mark (an effect that came from the item);
//   chosen  — Sneak Attack (finesse or ranged weapon, once per turn in combat),
//             Divine Smite (melee weapon or unarmed strike; its fiend / undead
//             version against those): offered as checkboxes.
// Each rider's own damage activity rolls its dice — as critical damage on a
// critical hit — and they join the hit's damage card, so the damage tray and the
// attack automation apply them as part of the same hit (one instance of damage).
// A rider that spends something (Divine Smite's spell slot, limited uses) is used
// through dnd5e first, with its own dialog; dnd5e's follow-up roll for that use
// is suppressed (see claimRiderUse) so its dice land on the hit instead.

import { MODULE_ID, debug, escapeHTML, isOnHitRidersEnabled } from "./shared.mjs";

export const RIDERS_FLAG = "riders";

const isWeaponAttack = (activity) => ["weapon", "unarmed"].includes(activity?.attack?.type?.classification)
  || activity?.item?.type === "weapon";
const isMelee  = (activity, card) => activity?.attack?.type?.value === "melee" && !String(card?.system?.mode ?? "").startsWith("thrown");
const isRanged = (activity, card) => activity?.attack?.type?.value === "ranged" || String(card?.system?.mode ?? "").startsWith("thrown");
const creatureType = (actor) => actor?.system?.details?.type?.value ?? actor?.system?.details?.race?.type ?? null;
const damageActivities = (item) => [...(item?.system?.activities?.values?.() ?? [])].filter(a => a.type === "damage");

/** By item identifier: how the rider is offered, when, and which damage activities it rolls. */
export const RIDERS = {
  "hunters-mark": { mode: "mark", activities: (item) => damageActivities(item).slice(0, 1) },
  "hex":          { mode: "mark", activities: (item) => damageActivities(item).slice(0, 1) },
  "sneak-attack": {
    mode: "choose", checked: true, oncePerTurn: true,
    eligible: ({ activity, card }) => isWeaponAttack(activity)
      && (activity.item?.system?.properties?.has?.("fin") || isRanged(activity, card)),
    activities: (item) => damageActivities(item).slice(0, 1)
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
  }
};

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
  const targets = (await Promise.all(hits.map(async t => (await fromUuid(t.token ?? t.uuid))?.actor ?? await fromUuid(t.actor ?? t.uuid))))
    .filter(Boolean);
  const turn = turnKey();
  const out = [];
  for (const item of actor.items ?? []) {
    const identifier = item.system?.identifier;
    const rider = RIDERS[identifier];
    if (!rider || item === activity.item) continue;
    if (rider.mode === "mark") {
      if (!targets.length || !targets.every(t => t.effects?.some?.(e => cameFrom(e, item)))) continue;
    } else {
      if (rider.eligible && !rider.eligible({ activity, card, targets })) continue;
      if (rider.oncePerTurn && turn && usedThisTurn.get(`${actor.uuid}:${identifier}`) === turn) continue;
    }
    const activities = rider.activities(item, { targets });
    if (activities.length) out.push({ item, rider, identifier, activities });
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
export function spendsSomething({ item, rider, activities }) {
  if (rider?.mode === "mark") return false;
  const activity = activities[0];
  if (item.type === "spell") return (item.system?.level ?? 0) > 0 && activity?.consumption?.spellSlot !== false;
  return (activity?.consumption?.targets?.length ?? 0) > 0;
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

/** The activity to roll for a rider: as is, or after using it through dnd5e. Null if the use was cancelled. */
async function riderActivity(choice, activity) {
  if (!spendsSomething(choice)) return activity;
  const claimed = new Promise(resolve => pendingRiderUses.set(choice.item.id, resolve));
  try {
    const results = await activity.use({ subsequentActions: true }, {}, {});
    if (!results) return null;
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
  if (!isOnHitRidersEnabled() || !message || !card || message.getFlag?.(MODULE_ID, RIDERS_FLAG)) return;
  const riders = await eligibleRiders(activity, card);
  if (!riders.length) return;
  const marks   = riders.filter(r => r.rider.mode === "mark");
  const chosen  = [...marks, ...await chooseRiders(card, riders.filter(r => r.rider.mode !== "mark"), marks)];
  if (!chosen.length) return;

  const isCritical = !!card.rolls?.[0]?.isCritical;
  const added = [], rolls = [];
  for (const choice of chosen) {
    for (const [index, base] of choice.activities.entries()) {
      // Only the first activity is used (spends the resource); the rest just roll.
      const act = index === 0 ? await riderActivity(choice, base) : base;
      if (!act) break;
      const riderRolls = await act.rollDamage({ isCritical }, { configure: false }, { create: false });
      if (!riderRolls?.length) continue;
      if (game.dice3d) for (const r of riderRolls) await game.dice3d.showForRoll(r, game.user, true, null, false);
      rolls.push(...riderRolls);
      added.push({ name: choice.item.name, formula: riderRolls.map(r => r.formula).join(" + "), total: riderRolls.reduce((s, r) => s + r.total, 0) });
    }
    if (choice.rider.oncePerTurn && turnKey()) usedThisTurn.set(`${activity.actor.uuid}:${choice.identifier}`, turnKey());
  }
  if (!rolls.length) return;
  await message.update({ rolls: [...message.rolls, ...rolls], [`flags.${MODULE_ID}.${RIDERS_FLAG}`]: added });
  debug(`riders: ${added.map(a => `${a.name} ${a.total}`).join(", ")}${isCritical ? " (critical)" : ""}`);
  console.log(`[${MODULE_ID}] on-hit riders: ${activity.actor.name} added ${added.map(a => `${a.name} (${a.formula} = ${a.total})`).join(", ")}`);
}
