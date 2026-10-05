// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Luck Dice without Midi-QoL, on dnd5e 6's own rolls. Active only when Midi-QoL
// is not (Midi mode lives in attack.js).
//
// dnd5e 6 has no hook between evaluating a roll and posting its card, so luck is
// spent after the card posts: a post-roll hook (dnd5e.roll…V2) reaches the card
// through roll.parent (set by BasicRoll.buildPost), prompts the roller, and
// writes the corrected roll back into the card's rolls. dnd5e then redraws the
// card from those rolls itself — attack hit/miss (system.evaluatedTargets),
// success or failure against the DC, and the damage tray's total. What was spent
// is kept in this module's flag on the same card and shown under the roll.
//
// The roller authored the card, so their client can update it directly.
// Depends on: core.js, attack.js, skill-check.js, saving-throw.js (loaded first).

(() => {
const LDA = window.LDA;
const {
  MODULE_ID, LUCK_DICE_ITEM_NAME, IMPACT_DICE_ITEM_NAME, clamp, debug,
  getDiceUses, actorHasLuckDice, promptChoice, promptSlider, getKeptD20Result, spendDiceFromPools,
  buildDiceAvailableHTML, isLuckDiceEnabled, isInspirationEnabled, actorHasInspiration,
  combineRolls, HISTORY_FLAG, diceFaces, renderLuckSection, requestRollActors,
  getAttackAutomation,
} = LDA;

const APPLIED_FLAG = "appliedDamage";
const escapeHTML   = (s) => (foundry.utils.escapeHTML ?? String)(String(s ?? ""));

console.log(`[${MODULE_ID}] native.js parsed — user=${game?.user?.name ?? "unknown"} isGM=${game?.user?.isGM ?? "?"}`);

/** Whether luck dice or inspiration could help this actor at all. */
function canUseLuck(actor) {
  return actor?.type === "character" && (
    (isLuckDiceEnabled() && actorHasLuckDice(actor)) ||
    (isInspirationEnabled() && actorHasInspiration(actor))
  );
}

// ── Card updates ──────────────────────────────────────────────────────────────

/** A writable copy of the card's luck history. */
function readHistory(message) {
  return foundry.utils.deepClone(message.getFlag(MODULE_ID, HISTORY_FLAG) ?? { start: null, entries: [] });
}

/** Rewrite the card's rolls and/or luck history in one update, so it re-renders once. */
async function updateCard(message, { rolls, history } = {}) {
  const update = {};
  if (rolls)   update.rolls = rolls;
  if (history) update[`flags.${MODULE_ID}.${HISTORY_FLAG}`] = history;
  await message.update(update);
}

/** Replace the card's first roll (the d20) and add one history entry. */
async function recordD20Step(message, roll, start, entry) {
  const history = readHistory(message);
  history.start ??= start;
  history.entries.push(entry);
  delete history.verdict;
  await updateCard(message, { rolls: [roll, ...message.rolls.slice(1)], history });
}

/** Stamp the final verdict, if any luck was spent on this card. */
async function finishHistory(message, verdict) {
  if (!message.getFlag(MODULE_ID, HISTORY_FLAG)?.entries?.length) return;
  const history = readHistory(message);
  history.verdict = verdict;
  await updateCard(message, { history });
}

// ── Attacks ───────────────────────────────────────────────────────────────────

/**
 * true if any target is hit, false if all are missed, null when it can't be
 * judged (no targets, or none with a known AC). dnd5e's evaluatedTargets
 * compares the card's D20Roll to each target's AC, with natural 20 / 1 rules.
 */
function attackHitState(message) {
  const targets = (message?.system?.evaluatedTargets ?? []).filter(t => Number.isFinite(t.ac));
  if (!targets.length) return null;
  return targets.some(t => !t.isMiss);
}

/** Attack adapter over a dnd5e attack card, for the shared attack prompts. */
function nativeAttack(message, actor) {
  const current = () => message.rolls[0];
  return {
    actor,
    state:    { attackPrompted: false, luckSpentOnAttack: 0 },
    total:    () => Number(current()?.total ?? 0),
    hitState: () => attackHitState(message),
    async reroll(evaluate, label) {
      const before = this.total();
      const roll   = await evaluate(current());
      await recordD20Step(message, roll, before, {
        kind: "attack", label, total: roll.total, detail: `d20: ${getKeptD20Result(roll) ?? "?"}`
      });
      return roll;
    },
    async addDice(diceCount) {
      const bonus = await new Roll(`${diceCount}d6`).evaluate();
      if (game.dice3d) await game.dice3d.showForRoll(bonus, game.user, true, null, false);
      const before = this.total();
      const roll   = combineRolls(current(), bonus);
      await recordD20Step(message, roll, before, {
        kind: "attack", label: `Added ${diceCount}d6 Luck Dice`, total: roll.total,
        detail: `${diceFaces(bonus).join(", ")} = +${bonus.total}`
      });
      return bonus;
    },
    finish: () => finishHistory(message, attackHitState(message) === true ? "hit" : "miss")
  };
}

/**
 * dnd5e.rollAttackV2 — on a miss, the Luck Dice prompts (shared with Midi mode)
 * for characters who have dice or inspiration; then, for any attacker, the
 * attack automation setting decides what happens on a hit.
 */
async function onAttackRolled(rolls, data) {
  try {
    const roll     = rolls?.[0];
    const message  = roll?.parent;
    const activity = data?.subject;
    const actor    = activity?.actor;
    if (!message || !activity) return;

    if (canUseLuck(actor)) {
      const hitState = attackHitState(message);
      debug(`native attack: ${actor.name} total=${roll.total} hitState=${hitState}`);
      if (hitState === false) {
        const attack = nativeAttack(message, actor);
        if (getKeptD20Result(roll) === 1) await LDA.promptNatOne(attack);
        else await LDA.promptLuckOnMiss(attack);
      }
    }

    await automateAttack(message, activity);
  } catch (err) {
    console.error(`[${MODULE_ID}] native attack error:`, err);
  }
}

// ── Damage ────────────────────────────────────────────────────────────────────

/**
 * The attack card from the same use as this damage roll. Every roll from an
 * activity carries options.originatingMessage — the id of its usage card.
 */
function findAttackCard(damageRoll) {
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
function luckDamageOptions(roll) {
  const { type, types, properties, isCritical, critical } = roll.options ?? {};
  return {
    type, types, isCritical,
    properties: [...(properties ?? [])],
    critical:   { ...foundry.utils.deepClone(critical ?? {}), bonusDice: 0, bonusDamage: "" }
  };
}

/** dnd5e.rollDamageV2 — offer luck dice on the damage of a hit. */
async function onDamageRolled(rolls, data) {
  try {
    const roll     = rolls?.[0];
    const message  = roll?.parent;
    const activity = data?.subject;
    const actor    = activity?.actor;
    if (!message || !activity || activity.type === "heal") return;
    if (!(roll instanceof CONFIG.Dice.DamageRoll)) return;
    if (actor?.type !== "character" || !isLuckDiceEnabled() || !actorHasLuckDice(actor)) return;
    if (message.getFlag(MODULE_ID, HISTORY_FLAG)?.entries?.some(e => e.kind === "damage")) return;

    // Only after a hit. A use with no attack card (a save-for-damage spell) is offered.
    const attackCard = findAttackCard(roll);
    if (attackCard && attackHitState(attackCard) === false) {
      debug(`native damage: ${actor.name}'s attack missed — no luck damage prompt`);
      return;
    }

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

    const history = readHistory(message);
    history.entries.push({ kind: "damage", label: `+${diceCount}d6 Luck Dice to damage${isCrit ? " (critical)" : ""}` });
    // The damage tray totals every DamageRoll on the card, so it applies these too.
    await updateCard(message, { rolls: [...message.rolls, bonus], history });
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

// Luck Dice prompts on damage cards still in progress, by card id. Applying waits
// for them, so dice added to the damage are part of what gets applied.
const pendingLuckDamage = new Map();

// scorpious187s-lib socket router; set on ready.
let socket = null;

/** Whether the activity has any damage to roll. */
function hasDamage(activity) {
  return (activity.damage?.parts?.length ?? 0) > 0 || !!activity.damage?.includeBase;
}

/** Roll the activity's damage for an attack card, the way dnd5e's damage button does. */
async function rollAttackDamage(attackMessage, activity, { fastForward }) {
  const { ability, ammunitionItem: ammunition, mode: attackMode } = attackMessage.system ?? {};
  const isCritical = !!attackMessage.rolls[0]?.isCritical;
  const dialog = fastForward ? { configure: false }
    : isCritical ? { options: { defaultButton: "critical" } } : {};
  const rolls = await activity.rollDamage({ ability, ammunition, attackMode, isCritical }, dialog);
  return rolls?.[0]?.parent ?? null;
}

async function automateAttack(attackMessage, activity) {
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
  await requestApplyDamage(damageMessage, hits);
}

/** Apply a damage card to targets — directly as a GM, otherwise via the primary GM. */
async function requestApplyDamage(damageMessage, targets) {
  const payload = {
    messageId: damageMessage.id,
    targets:   targets.map(({ actor, token, name }) => ({ actor, token, name }))
  };
  if (game.user.isGM) return applyCardDamage(payload);

  const primaryGM = game.modules.get("scorpious187s-lib")?.api?.utils?.primaryGM?.();
  if (!socket || !primaryGM) {
    ui.notifications?.warn("Luck Dice Automation: no GM is connected, so the damage wasn't applied — use the damage card's tray.");
    return;
  }
  socket.emit("applyDamage", payload);
}

/**
 * GM side: apply every DamageRoll on the card to each target, aggregated the way
 * dnd5e's own chat damage application does it, and note what was applied on the
 * card.
 */
async function applyCardDamage({ messageId, targets }) {
  const message   = game.messages.get(messageId);
  const aggregate = globalThis.dnd5e?.dice?.aggregateDamageRolls;
  if (!message || !aggregate) {
    console.error(`[${MODULE_ID}] applyCardDamage: ${message ? "dnd5e.dice.aggregateDamageRolls missing" : `no message ${messageId}`}`);
    return;
  }
  const damageRolls = message.rolls.filter(r => r instanceof CONFIG.Dice.DamageRoll);
  if (!damageRolls.length) return;

  const damages = aggregate(damageRolls, { respectProperties: true }).map(roll => ({
    value:      Math.max(0, roll.total) * (roll.options.type in CONFIG.DND5E.healingTypes ? -1 : 1),
    type:       roll.options.type,
    properties: new Set(roll.options.properties ?? [])
  }));

  const applied = [];
  for (const target of targets ?? []) {
    const actor = (await fromUuid(target.token))?.actor ?? await fromUuid(target.actor);
    if (!actor?.applyDamage) continue;
    const amount = Number(actor.calculateDamage?.(damages, {})?.amount ?? 0);
    await actor.applyDamage(damages, { isDelta: true, originatingMessage: message });
    applied.push({ name: target.name ?? actor.name, amount });
  }
  if (applied.length) await message.setFlag(MODULE_ID, APPLIED_FLAG, applied);
  console.log(`[${MODULE_ID}] applyCardDamage: ${applied.map(a => `${a.name} ${a.amount}`).join(", ") || "no targets"}`);
}

// ── Saves, checks and concentration ──────────────────────────────────────────

const D20_TESTS = {
  "dnd5e.rollSavingThrowV2":   { title: "Failed Saving Throw",       rollType: "saving throw",       natOneSave: true },
  "dnd5e.rollConcentrationV2": { title: "Failed Concentration Save", rollType: "concentration save", natOneSave: true },
  "dnd5e.rollAbilityCheckV2":  { title: "Failed Ability Check",      rollType: "ability check" },
  "dnd5e.rollSkillV2":         { title: "Failed Skill Check",        rollType: "skill check" },
  "dnd5e.rollToolCheckV2":     { title: "Failed Tool Check",         rollType: "tool check" },
};

/**
 * A failed save, check or concentration roll against a known DC. Uses the same
 * prompts as the roll-request window and Midi saves; their reporter receives
 * each step and rewrites the card's roll, so dnd5e redraws success / failure.
 * Rolls without a DC are skipped — nothing says they failed.
 */
async function onD20TestRolled(rolls, data, test) {
  try {
    const roll    = rolls?.[0];
    const message = roll?.parent;
    const actor   = data?.subject;
    if (!message || !canUseLuck(actor)) return;
    if (requestRollActors.has(actor.id)) return; // the roll-request window runs its own prompt

    const dc = Number(roll.options?.target);
    if (!Number.isFinite(dc) || dc <= 0) return;
    const total = Number(roll.total ?? 0);
    if (total >= dc) return;

    debug(`native ${test.rollType}: ${actor.name} rolled ${total} vs DC ${dc}`);

    let current = roll;
    const reporter = async (entry, { roll: newRoll, bonusRoll } = {}) => {
      if (newRoll) current = newRoll;
      else if (bonusRoll) current = combineRolls(current, bonusRoll);
      await recordD20Step(message, current, total, { kind: "check", ...entry });
    };

    // dnd5e's own rule: the roller and the GM always see a DC; others per its setting.
    const showDC = message.shouldDisplayChallenge ?? true;
    const result = (test.natOneSave && getKeptD20Result(roll) === 1)
      ? await LDA.promptNatOneSave(actor, total, dc, roll, null, "", showDC, reporter)
      : await LDA.promptLuckOnCheckFail(actor, total, dc, null, "", roll, test.title, test.rollType, showDC, reporter);

    await finishHistory(message, result?.passed && result.finalTotal >= dc ? "passed" : "failed");
  } catch (err) {
    console.error(`[${MODULE_ID}] native ${test.rollType} error:`, err);
  }
}

// ── Luck Dice history on dnd5e's cards ────────────────────────────────────────

/**
 * Insert the history as its own row after the card's last roll row. dnd5e 6
 * puts each roll in a `section.icon-row` (icon + roll button); the history goes
 * after that whole row — inside it, it would be squeezed into the roll column.
 * Idempotent — safe to run from more than one render hook. Hidden where the
 * roll itself is: blind / private rolls, and attack results when dnd5e's attack
 * roll visibility hides them.
 */
function injectNativeHistory(message, html) {
  if (!(html instanceof HTMLElement)) return;
  html.querySelectorAll(".lda-luck-history, .lda-applied-damage").forEach(el => el.remove());
  if (!message.isContentVisible) return;

  const blocks  = [];
  const history = message.getFlag?.(MODULE_ID, HISTORY_FLAG);
  if (history?.entries?.length && (game.user.isGM || message.system?.displayResult !== false)) {
    blocks.push(renderLuckSection(history));
  }
  const applied = message.getFlag?.(MODULE_ID, APPLIED_FLAG);
  if (applied?.length && canSeeDamageApplication()) blocks.push(renderAppliedSection(applied));
  if (!blocks.length) return;

  const rollRow = [...html.querySelectorAll("section.icon-row")].filter(row => row.querySelector(".dice-roll")).at(-1);
  if (rollRow) rollRow.after(...blocks);
  else (html.querySelector(".message-content") ?? html).append(...blocks);
}

/** Damage applied to targets is shown to whoever dnd5e lets use the damage tray. */
function canSeeDamageApplication() {
  if (game.user.isGM) return true;
  try { return !!game.settings.get("dnd5e", "allowPlayerDamageTray"); } catch { return false; }
}

/** "Applied: Hill Giant 14 · Goblin 7" as a card row (healing shown as +N). */
function renderAppliedSection(applied) {
  const parts = applied.map(a =>
    `<span style="white-space:nowrap">${escapeHTML(a.name)} <strong>${a.amount < 0 ? `+${-a.amount}` : a.amount}</strong></span>`);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <section class="icon-row lda-applied-damage" style="display:flex;align-items:flex-start;gap:6px;margin:2px 0">
      <i class="fa-fw fa-solid fa-heart-crack" aria-label="Damage applied" style="margin-top:2px;opacity:0.8"></i>
      <div style="flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px">
        <strong>Applied</strong>${parts.join("")}
      </div>
    </section>`.trim();
  return wrapper.firstElementChild;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  if (game.modules.get("midi-qol")?.active) {
    console.log(`[${MODULE_ID}] native.js: Midi-QoL is active — using Midi mode (attack.js)`);
    return;
  }
  console.log(`[${MODULE_ID}] native.js: Midi-QoL not active — using native dnd5e mode`);

  // GM-side work requested by players' clients (scorpious187s-lib routes "gm"
  // handlers to the primary active GM only, so damage is never applied twice).
  socket = game.modules.get("scorpious187s-lib")?.api?.utils?.makeSocketRouter?.(MODULE_ID, {
    gm: {
      applyDamage: (payload) => applyCardDamage(payload).catch(err => console.error(`[${MODULE_ID}] applyDamage error:`, err))
    }
  }) ?? null;
  if (!socket) console.warn(`[${MODULE_ID}] native.js: scorpious187s-lib socket router unavailable — players' damage can't be applied by the GM`);

  Hooks.on("dnd5e.rollAttackV2", onAttackRolled);
  // Track each damage card's Luck Dice prompt, so attack automation can wait for
  // it before applying the damage.
  Hooks.on("dnd5e.rollDamageV2", (rolls, data) => {
    const id      = rolls?.[0]?.parent?.id;
    const pending = onDamageRolled(rolls, data);
    if (!id) return;
    pendingLuckDamage.set(id, pending);
    pending.finally(() => { if (pendingLuckDamage.get(id) === pending) pendingLuckDamage.delete(id); });
  });
  for (const [hook, test] of Object.entries(D20_TESTS)) {
    Hooks.on(hook, (rolls, data) => onD20TestRolled(rolls, data, test));
  }

  // Both hooks run the same idempotent injection; whichever fires last wins.
  Hooks.on("renderChatMessageHTML", injectNativeHistory);
  Hooks.on("dnd5e.renderChatMessage", injectNativeHistory);
});
})();
