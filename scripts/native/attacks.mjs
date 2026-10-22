// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Attacks and their damage: Luck Dice on a miss, Luck Dice on damage, attack automation.

import { requestApplyDamage } from "./apply.mjs";
import { applyHitEffects } from "./effects.mjs";
import { handlePrivateAttack } from "./outcome.mjs";
import { addOnHitRiders } from "./riders.mjs";
import { offerReactions, reactionMultiplier } from "./reactions.mjs";
import { applyWeaponMastery } from "./mastery.mjs";
import { autoRolledEnabled } from "./autoroll.mjs";
import { applyRetaliation } from "./retaliation.mjs";
import { rollExtras } from "./boosts.mjs";
import { LDA, MODULE_ID, LUCK_DICE_ITEM_NAME, IMPACT_DICE_ITEM_NAME, clamp, debug, getDiceUses, actorHasLuckDice, promptChoice, promptSlider, getKeptD20Result, spendDiceFromPools, buildDiceAvailableHTML, isLuckDiceEnabled, combineRolls, HISTORY_FLAG, diceFaces, getAttackAutomation, readCardHistory, updateRollCard, recordCardStep, finishCardHistory, escapeHTML, canUseLuck, pendingLuckDamage, isSkipAttackDialogEnabled, NO_DIALOG } from "./shared.mjs";

// ── Attacks ───────────────────────────────────────────────────────────────────

/**
 * true if any target is hit, false if all are missed, null when it can't be
 * judged (no targets, or none with a known AC). dnd5e's evaluatedTargets
 * compares the card's D20Roll to each target's AC, with natural 20 / 1 rules.
 */
export function attackHitState(message) {
  const targets = (message?.system?.evaluatedTargets ?? []).filter(t => Number.isFinite(t.ac));
  if (!targets.length) return null;
  return targets.some(t => !t.isMiss);
}

/** Attack adapter over a dnd5e attack card, for the shared attack prompts. */
export function nativeAttack(message, actor) {
  const current = () => message.rolls[0];
  return {
    actor,
    state:    { attackPrompted: false, luckSpentOnAttack: 0 },
    total:    () => Number(current()?.total ?? 0),
    hitState: () => attackHitState(message),
    async reroll(evaluate, label) {
      const before = this.total();
      const roll   = await evaluate(current());
      await recordCardStep(message, roll, before, {
        kind: "attack", label, total: roll.total, detail: `d20: ${getKeptD20Result(roll) ?? "?"}`
      });
      return roll;
    },
    async addDice(diceCount) {
      const bonus = await new Roll(`${diceCount}d6`).evaluate();
      if (game.dice3d) await game.dice3d.showForRoll(bonus, game.user, true, null, false);
      const before = this.total();
      const roll   = combineRolls(current(), bonus);
      await recordCardStep(message, roll, before, {
        kind: "attack", label: `Added ${diceCount}d6 Luck Dice`, total: roll.total,
        detail: `${diceFaces(bonus).join(", ")} = +${bonus.total}`
      });
      return bonus;
    },
    finish: () => finishCardHistory(message, attackHitState(message) === true ? "hit" : "miss"),
    // Bardic Inspiration, Lucky (boosts.mjs): offered with the Luck Dice.
    extras: rollExtras(actor, "attack"),
    roll: () => current(),
    async applyExtra(out) {
      const before = this.total();
      const roll   = out.roll ?? combineRolls(current(), out.bonusRoll);
      await recordCardStep(message, roll, before, { kind: "attack", label: out.label, total: roll.total, detail: out.detail });
    }
  };
}

/**
 * dnd5e.rollAttackV2 — on a miss, the Luck Dice prompts (shared with Midi mode)
 * for characters who have dice or inspiration; then, for any attacker, the
 * attack automation setting decides what happens on a hit.
 */
export async function onAttackRolled(rolls, data) {
  try {
    const roll     = rolls?.[0];
    const message  = roll?.parent;
    const activity = data?.subject;
    const actor    = activity?.actor;
    if (!message || !activity) return;

    const hitState = attackHitState(message);
    if (hitState === false) {
      const attack = nativeAttack(message, actor);
      if (canUseLuck(actor) || attack.extras) {
        debug(`native attack: ${actor.name} total=${roll.total} missed`);
        if (getKeptD20Result(roll) === 1) await LDA.promptNatOne(attack);
        else await LDA.promptLuckOnMiss(attack);
      }
    }

    // The creatures hit may react (Shield can turn the hit into a miss).
    await offerReactions(message, activity);
    await syncAutomatedAnimations(message, activity);
    await handlePrivateAttack(message, activity);
    await applyRetaliation(message, activity); // before the damage: Armor of Agathys needs its temp HP standing
    await applyHitEffects(message, activity);
    await automateAttack(message, activity);
    await applyWeaponMastery(message, activity);
  } catch (err) {
    console.error(`[${MODULE_ID}] native attack error:`, err);
  }
}

/**
 * Automated Animations (without Midi) judges an attack from its original roll —
 * total vs the AC dnd5e sets only when exactly one token is targeted — and keeps
 * that result on the actor (actor.hits[activity.relativeID]) for its damage-roll
 * animation ("Play animation on damage roll"). Bring it in line with the card's
 * actual result, so a miss Luck Dice turned into a hit animates as a hit, and so
 * do natural 20s / 1s and attacks on several targets (any hit counts, like AA's
 * single result). Only runs before the damage is rolled; can't undo an animation
 * AA already played at attack time.
 *
 * AA's cache is internal, not an API: this only rewrites an entry AA itself made
 * for this activity, and never throws.
 */
export async function syncAutomatedAnimations(message, activity) {
  try {
    if (!game.modules.get("autoanimations")?.active) return;
    // Let AA's own rollAttackV2 handler record its result first: hook listeners
    // run in turn, and AA records it before its first await.
    await Promise.resolve();
    const hits = activity?.actor?.hits;
    const id   = activity?.relativeID;
    if (!hits || !id || !(id in hits)) return;
    const hit = attackHitState(message);
    if (hit === null || hits[id] === hit) return;
    hits[id] = hit;
    debug(`Automated Animations: ${activity.actor.name}'s ${activity.item?.name ?? activity.name} → ${hit ? "hit" : "miss"} (from the card)`);
  } catch (err) {
    debug("Automated Animations sync skipped:", err);
  }
}

// ── Damage ────────────────────────────────────────────────────────────────────

/**
 * The attack card from the same use as this damage roll. Every roll from an
 * activity carries options.originatingMessage — the id of its usage card.
 */
export function findAttackCard(damageRoll) {
  const origin = damageRoll?.options?.originatingMessage;
  if (!origin) return null;
  return game.messages.contents.findLast(m =>
    m.system && ("evaluatedTargets" in m.system) &&
    m.rolls?.[0]?.options?.originatingMessage === origin
  ) ?? null;
}

/**
 * Options for the luck damage roll: the damage type and properties (so the
 * damage tray applies resistances to it like the rest of the damage) and the
 * critical multiplier settings, so dnd5e scales it on a critical hit. The
 * weapon's own extra critical dice / damage are left off — they belong to the
 * weapon's roll, not the luck dice.
 */
export function luckDamageOptions(roll) {
  const { type, types, properties, isCritical, critical } = roll.options ?? {};
  return {
    type, types, isCritical, ldaLuckDice: true,
    properties: [...(properties ?? [])],
    critical:   { ...foundry.utils.deepClone(critical ?? {}), bonusDice: 0, bonusDamage: "" }
  };
}

/** dnd5e.rollDamageV2 — offer luck dice on the damage of a hit. */
export async function onDamageRolled(rolls, data) {
  try {
    const roll     = rolls?.[0];
    const message  = roll?.parent;
    const activity = data?.subject;
    const actor    = activity?.actor;
    if (!message || !activity || activity.type === "heal") return;
    if (!(roll instanceof CONFIG.Dice.DamageRoll)) return;

    // Only after a hit. A use with no attack card (a save-for-damage spell) is offered.
    const attackCard = findAttackCard(roll);
    if (attackCard && attackHitState(attackCard) === false) {
      debug(`native damage: ${actor?.name}'s attack missed — no riders or luck damage prompt`);
      return;
    }
    // On-hit riders (any attacker), before the Luck Dice so the prompt follows them.
    if (attackCard) await addOnHitRiders(message, activity, attackCard);

    if (actor?.type !== "character" || !isLuckDiceEnabled() || !actorHasLuckDice(actor)) return;
    if (message.getFlag(MODULE_ID, HISTORY_FLAG)?.entries?.some(e => e.kind === "damage")) return;

    const totalAvail = getDiceUses(actor, LUCK_DICE_ITEM_NAME) + getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
    if (totalAvail <= 0) return;

    const isCrit = rolls.some(r => r.isCritical);
    const critNote = isCrit ? `<p><em>Critical hit! Extra dice are rolled as critical damage.</em></p>` : "";
    const raw = await promptSlider(
      isCrit ? "Add Dice to Damage (Critical Hit!)" : "Add Dice to Damage",
      `<p>Add Luck Dice to this damage?</p>${critNote}${buildDiceAvailableHTML(actor)}`,
      "luckDamageCount",
      0, totalAvail, 0
    );
    const diceCount = clamp(Number(raw ?? 0), 0, totalAvail);
    if (!Number.isFinite(diceCount) || diceCount <= 0) return;

    const spent = await spendDiceFromPools(actor, diceCount);
    if (spent < 1) return;

    const bonus = new CONFIG.Dice.DamageRoll(`${diceCount}d6`, roll.data ?? {}, luckDamageOptions(roll));
    await bonus.evaluate();
    if (game.dice3d) await game.dice3d.showForRoll(bonus, game.user, true, null, false);

    const history = readCardHistory(message);
    history.entries.push({ kind: "damage", label: `+${diceCount}d6 Luck Dice to damage${isCrit ? " (critical)" : ""}` });
    // The damage tray totals every DamageRoll on the card, so it applies these too.
    await updateRollCard(message, { rolls: [...message.rolls, bonus], history });
    console.log(`[${MODULE_ID}] native damage: ${actor.name} added ${diceCount}d6 = ${bonus.total}${isCrit ? " (critical)" : ""}`);
  } catch (err) {
    console.error(`[${MODULE_ID}] native damage error:`, err);
  }
}

// ── Attack automation ─────────────────────────────────────────────────────────
// The "attackAutomation" setting: after an attack (and any Luck Dice), on a hit —
//   prompt: a one-click "Roll Damage" prompt; roll: roll damage automatically;
//   apply:  roll damage, then apply it to each hit target.
// Damage is rolled exactly as dnd5e's own damage button does (ability, ammunition,
// attack mode and critical from the attack card). Applying it changes the targets'
// actors, which needs the GM: the primary GM's client does it, over the module
// socket (scorpious187s-lib's router), with dnd5e's applyDamage handling
// resistances, temp HP and healing types.

const AC5E_ID = "automated-conditions-5e";
// The entry lists AC5E offers opt-in choices from in an attack's roll window
// (its roll-selections getAllOptinEntriesForHook + getRollNonBonusOptinEntries).
const AC5E_OPTIN_MODES = ["bonus", "info", "targetADC", "range", "abilityOverride", "advantage", "disadvantage",
  "noAdvantage", "noDisadvantage", "critical", "noCritical", "fail", "fumble", "success", "modifiers"];

/**
 * Automated Conditions 5e's opt-in choices waiting on this attack. AC5E works
 * the attack out in dnd5e.preRollAttack — before dnd5e.preRollAttackV2 — and
 * keeps the result on the first roll's options; its opt-ins are only offered in
 * the roll window. Its advantage / disadvantage is already on the roll either way.
 */
export function ac5eOptins(config) {
  if (!game.modules.get(AC5E_ID)?.active) return [];
  const ac5e = config?.rolls?.[0]?.options?.[AC5E_ID] ?? config?.[AC5E_ID];
  if (!ac5e || typeof ac5e !== "object") return [];
  const list = (side, mode) => Array.isArray(ac5e[side]?.[mode]) ? ac5e[side][mode] : [];
  return AC5E_OPTIN_MODES.flatMap(mode => [...list("subject", mode), ...list("opponent", mode)])
    .filter(entry => entry && typeof entry === "object" && (!entry.hook || entry.hook === "attack") && (entry.optin || entry.forceOptin));
}

/**
 * dnd5e.preRollAttackV2 — the "skipAttackDialog" setting: roll without dnd5e's
 * attack roll window, with whatever advantage / disadvantage AC5E and this
 * module settled on. Runs before dnd5e reads the skip keys, which still pick
 * advantage / disadvantage. The window still opens when AC5E has opt-in choices
 * for this attack, or when something else asked for it.
 */
export function skipAttackDialog(config, dialog) {
  if (!isSkipAttackDialogEnabled() || !dialog) return;
  const optins = ac5eOptins(config);
  if (optins.length) {
    console.log(`[${MODULE_ID}] skip attack window: kept open for Automated Conditions 5e's opt-in choice(s): ${
      optins.map(o => `${o.label ?? o.name ?? o.id}${o.forceOptin ? " (required)" : o.preselected ? " (preselected)" : ""}`).join(", ")}`);
    return;
  }
  dialog.configure ??= false;
}

/**
 * dnd5e.preRollV2 — called after every type-specific preRoll hook, so after other modules have had their say
 * (Flash Rolls 5e turns the window back on for actors with an active player owner). The module's own
 * window-less rolls stay window-less; attacks with "skipAttackDialog" and damage the module applies (healing,
 * damage-only activities) roll without the window. AC5E's opt-in choices still open an attack's window.
 * Never cancels.
 */
export function finalRollDialog(config, dialog) {
  if (!dialog) return;
  if (config?.[MODULE_ID]?.noDialog) { dialog.configure = false; return; }
  const hooks = config?.hookNames ?? [];
  const subject = config?.subject;
  if (hooks.includes("attack") && subject?.type === "attack" && isSkipAttackDialogEnabled() && !ac5eOptins(config).length) {
    dialog.configure = false;
  } else if (hooks.includes("damage") && (subject?.type === "heal" || subject?.type === "damage") && autoRolledEnabled(subject)) {
    dialog.configure = false;
  }
}

/** Whether the activity has any damage to roll. */
export function hasDamage(activity) {
  return (activity.damage?.parts?.length ?? 0) > 0 || !!activity.damage?.includeBase;
}

/** Roll the activity's damage for an attack card, the way dnd5e's damage button does. */
export async function rollAttackDamage(attackMessage, activity, { fastForward }) {
  const { ability, ammunitionItem: ammunition, mode: attackMode } = attackMessage.system ?? {};
  const isCritical = !!attackMessage.rolls[0]?.isCritical;
  const dialog = fastForward ? { configure: false }
    : isCritical ? { options: { defaultButton: "critical" } } : {};
  const rolls = await activity.rollDamage({ ability, ammunition, attackMode, isCritical, ...(fastForward ? NO_DIALOG : {}) }, dialog);
  return rolls?.[0]?.parent ?? null;
}

export async function automateAttack(attackMessage, activity) {
  const mode = getAttackAutomation();
  if (mode === "off" || typeof activity.rollDamage !== "function" || !hasDamage(activity)) return;

  const hits = (attackMessage.system?.evaluatedTargets ?? []).filter(t => !t.isMiss);
  if (!hits.length) { debug("attack automation: no hit targets"); return; }

  if (mode === "prompt") {
    const choice = await promptChoice(
      "Attack Hit",
      `<p>Hit <strong>${escapeHTML(hits.map(t => t.name).join(", "))}</strong>. Roll damage?</p>`,
      [{ action: "roll", label: "Roll Damage" }, { action: "skip", label: "Not Now" }]
    );
    if (choice !== "roll") return;
  }

  const damageMessage = await rollAttackDamage(attackMessage, activity, { fastForward: mode !== "prompt" });
  if (!damageMessage || mode !== "apply") return;

  await pendingLuckDamage.get(damageMessage.id);
  // A reaction may halve a target's damage (Uncanny Dodge).
  await requestApplyDamage(damageMessage, hits.map(hit => {
    const multiplier = reactionMultiplier(attackMessage, hit.token);
    return multiplier === undefined ? hit : { ...hit, multiplier };
  }));
}
