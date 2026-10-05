// ── Scorpious187's Luck Dice Automation — Attack, Damage & Midi Saves ─────────
// Midi-QoL 14.6 / dnd5e 6 integration: luck dice on missed attacks and damage,
// failed Midi saves, and failed concentration saves.
//
// Midi 14.6 renders its chat cards from workflow data. This module hooks in
// after Midi has decided a result but before Midi renders or applies it
// (midi-qol.hitsChecked, midi-qol.postCheckSaves), corrects the workflow, and
// lets Midi draw and apply the corrected result. Luck dice spent on an attack
// are kept in this module's flag on Midi's card and injected under the attack
// roll at render, so every viewer sees each reroll as it happens.
// Depends on: core.js (must be loaded first).

(() => {
const LDA = window.LDA;
const {
  MODULE_ID, LUCK_DICE_ITEM_NAME, IMPACT_DICE_ITEM_NAME,
  workflowState, pendingMidiSaveResults, clamp, debug,
  getWorkflowKey, getState, getDiceUses,
  updateLuckUses, actorHasLuckDice, isWorkflowResponder,
  promptChoice, promptSlider, buildFakeRoll, getKeptD20Result, spendDiceFromPools,
  evaluateReroll, buildDiceAvailableHTML, whisperLuckRegain, maybeRegainLuckDie,
  isLuckDiceEnabled, isInspirationEnabled, actorHasInspiration, consumeInspiration,
  evaluateInspirationReroll, combineRolls,
  HISTORY_FLAG, diceFaces, renderLuckSection,
} = LDA;

// ── Hit state detection ───────────────────────────────────────────────────────

/**
 * Returns true (hit), false (miss), or null (uncertain — no targets).
 * Only called after Midi's checkHits(), so hitTargets / hitTargetsEC are Midi's
 * own verdict (AC, cover, flanking, reactions). A natural 20 / 1 is read from
 * the kept d20.
 */
function getDefiniteHitState(workflow) {
  if (!workflow?.attackRoll) return null;

  const d20Result = getKeptD20Result(workflow.attackRoll);
  if (d20Result === 20) return true;
  if (d20Result === 1)  return false;

  const hits = (workflow.hitTargets?.size ?? 0) + (workflow.hitTargetsEC?.size ?? 0);
  if (hits > 0) return true;
  return (workflow.targets?.size ?? 0) > 0 ? false : null;
}

// ── Attack roll manipulation ──────────────────────────────────────────────────

/**
 * Midi's checkHits() reads the natural-20 / natural-1 result from the workflow
 * (isCritical / isFumble), not from the roll, so keep both in step with the d20.
 */
function syncD20Flags(workflow, roll) {
  const d20Result = getKeptD20Result(roll);
  if (d20Result === undefined) return;
  workflow.isCritical = d20Result === 20;
  workflow.isFumble   = d20Result === 1;
}

/**
 * Replace the workflow's attack roll, have Midi re-judge it, and redraw it.
 * setAttackRoll tags the roll as the attack roll and links it to the card, which
 * is how Midi 14.6 finds it to render; checkHits() then recomputes hitTargets
 * with Midi's own rules. Reactions are suppressed for the recompute — they were
 * already offered on the original roll, and re-running would prompt targets twice.
 * displayAttackRoll() redraws the card straight away (keeping Midi's GM-only
 * attack roll setting), so the new total shows while the player is still deciding.
 */
async function setAttackRoll(workflow, roll) {
  await workflow.setAttackRoll(roll);
  const options = workflow.workflowOptions ??= {};
  const prevNoProvoke = options.noProvokeReaction;
  options.noProvokeReaction = true;
  try {
    await workflow.checkHits();
  } finally {
    if (prevNoProvoke === undefined) delete options.noProvokeReaction;
    else options.noProvokeReaction = prevNoProvoke;
  }
  const GMOnlyAttackRoll = !!workflow.chatCard?.getFlag?.("midi-qol", "GMOnlyAttackRoll");
  await workflow.displayAttackRoll?.({ GMOnlyAttackRoll });
  debug(`setAttackRoll: total=${roll.total} hits=${workflow.hitTargets?.size ?? 0}`);
}

/** The workflow's current attack total. */
function attackTotalOf(workflow) {
  return Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
}

/** Reroll the attack d20 with the given evaluator (luck dice or inspiration). */
async function rerollAttack(workflow, evaluate, label) {
  const before = attackTotalOf(workflow);
  debug(`rerollAttack: formula="${workflow.attackRoll.formula}" old total=${before}`);
  const newRoll = await evaluate(workflow.attackRoll);
  syncD20Flags(workflow, newRoll);
  await setAttackRoll(workflow, newRoll);
  await recordAttackLuck(workflow, before, { label, total: newRoll.total, detail: `d20: ${getKeptD20Result(newRoll) ?? "?"}` });
  console.log(`[${MODULE_ID}] rerollAttack: new total=${newRoll.total} isCritical=${workflow.isCritical} isFumble=${workflow.isFumble}`);
  return newRoll;
}

async function addLuckDiceToAttack(workflow, diceCount) {
  const bonusRoll = await new Roll(`${diceCount}d6`).evaluate();
  if (game.dice3d) await game.dice3d.showForRoll(bonusRoll, game.user, true, null, false);
  const before   = attackTotalOf(workflow);
  const combined = combineRolls(workflow.attackRoll, bonusRoll);
  await setAttackRoll(workflow, combined);
  workflow.luckAttackBonus = (workflow.luckAttackBonus ?? 0) + bonusRoll.total;
  await recordAttackLuck(workflow, before, {
    label:  `Added ${diceCount}d6 Luck Dice`,
    total:  combined.total,
    detail: `${diceFaces(bonusRoll).join(", ")} = +${bonusRoll.total}`
  });
  console.log(`[${MODULE_ID}] addLuckDiceToAttack: ${diceCount}d6 = ${bonusRoll.total}, total ${before} → ${combined.total}`);
  return bonusRoll;
}

/** Record a miss converted to a hit, so the damage prompt treats it as a hit. */
function markIfConverted(attack) {
  if (attack.hitState() === true) {
    attack.state.convertedMissToHit = true;
    debug("attack: luck converted miss to hit");
  }
}

// ── Luck Dice history on Midi's card ──────────────────────────────────────────
// Midi 14.6 renders its usage card from data and owns a fixed set of sections,
// so the history is kept in this module's flags on Midi's card and injected on
// every render — attack history under the attack roll, save history under the
// saves. Each flag update re-renders the card for all viewers, so the player
// sees each reroll as it happens.
//
// Attack history (HISTORY_FLAG):
//   { start, entries: [{ kind: "attack"|"damage", label, total?, detail? }], verdict? }
// Save history (SAVES_FLAG) — an array, since target uuids contain dots that a
// flag object would expand into nested keys:
//   [{ uuid, name, start, entries: [{ kind: "save", label, total, detail }], verdict? }]
// Entries without a total (luck damage) render as a plain line.

const SAVES_FLAG   = "luckSaves";
/** Read-modify-write one of this module's flags on the workflow's card. */
async function updateCardFlag(workflow, key, fallback, mutate) {
  const card = workflow?.chatCard;
  if (!card) { debug(`updateCardFlag(${key}): workflow has no chat card`); return; }
  const value = foundry.utils.deepClone(card.getFlag(MODULE_ID, key) ?? fallback);
  mutate(value);
  try {
    await card.setFlag(MODULE_ID, key, value);
  } catch (err) {
    console.warn(`[${MODULE_ID}] updateCardFlag(${key}): could not update card ${card.id}:`, err);
  }
}

function updateLuckHistory(workflow, mutate) {
  return updateCardFlag(workflow, HISTORY_FLAG, { start: null, entries: [] }, mutate);
}

/** Add one attack reroll / add-dice step; `before` is the total it replaced. */
function recordAttackLuck(workflow, before, entry) {
  return updateLuckHistory(workflow, (h) => {
    h.start ??= before;
    h.entries.push({ kind: "attack", ...entry });
    delete h.verdict;
  });
}

/** Stamp the final HIT / MISS once the player is done spending on the attack. */
async function finishLuckHistory(workflow) {
  const history = workflow?.chatCard?.getFlag(MODULE_ID, HISTORY_FLAG);
  if (!history?.entries?.some(e => e.kind === "attack")) return;
  const hit = getDefiniteHitState(workflow) === true;
  await updateLuckHistory(workflow, (h) => { h.verdict = hit ? "hit" : "miss"; });
}

/** Add one save reroll / add-dice step for a target. target: { uuid, name, start }. */
function recordSaveLuck(workflow, target, entry) {
  return updateCardFlag(workflow, SAVES_FLAG, [], (saves) => {
    let record = saves.find(s => s.uuid === target.uuid);
    if (!record) saves.push(record = { uuid: target.uuid, name: target.name, start: target.start, entries: [] });
    record.entries.push({ kind: "save", ...entry });
    delete record.verdict;
  });
}

/** Stamp PASSED / FAILED on a target's save history, if luck was spent on it. */
async function finishSaveLuck(workflow, uuid, passed) {
  const saves = workflow?.chatCard?.getFlag(MODULE_ID, SAVES_FLAG);
  if (!saves?.some(s => s.uuid === uuid)) return;
  await updateCardFlag(workflow, SAVES_FLAG, [], (list) => {
    const record = list.find(s => s.uuid === uuid);
    if (record) record.verdict = passed ? "passed" : "failed";
  });
}

/**
 * Insert the history blocks into a rendered Midi card. Anchors on Midi's section
 * wrappers (`midi-qol-hits-display`, `midi-qol-attack-roll`,
 * `midi-qol-saves-display`), which Midi keeps for third-party code. Idempotent —
 * safe to run from more than one render hook.
 */
function injectLuckHistory(message, html) {
  if (!(html instanceof HTMLElement)) return;
  html.querySelectorAll(".lda-luck-history, .lda-luck-saves").forEach(el => el.remove());
  const fallback = () => html.querySelector(".midi-results") ?? html;

  // Attack history, directly under the attack roll. Hidden from players when
  // Midi shows the attack roll to the GM only, so it never reveals that roll.
  const history = message.getFlag?.(MODULE_ID, HISTORY_FLAG);
  if (history?.entries?.length && (game.user.isGM || !message.getFlag?.("midi-qol", "GMOnlyAttackRoll"))) {
    const block  = renderLuckSection(history);
    const hits   = html.querySelector(".midi-qol-hits-display");
    const attack = html.querySelector(".midi-qol-attack-roll");
    if (hits) hits.before(block);
    else if (attack) attack.after(block);
    else fallback().append(block);
  }

  // Save history, one titled history per target, directly under Midi's saves.
  const saves = (message.getFlag?.(MODULE_ID, SAVES_FLAG) ?? []).filter(s => s.entries?.length);
  if (saves.length) {
    const blocks = saves.map(s => renderLuckSection(s, { className: "lda-luck-saves", title: `Luck Dice — ${s.name ?? ""}` }));
    const savesSection = html.querySelector(".midi-qol-saves-display");
    if (savesSection) savesSection.after(...blocks);
    else fallback().append(...blocks);
  }
}

// ── Damage injection ──────────────────────────────────────────────────────────

/** True when a dnd5e damage roll config belongs to this workflow's activity. */
function isWorkflowDamageRoll(config, workflow) {
  const subject = config?.subject;
  if (subject && workflow.activity) {
    return subject === workflow.activity || (!!subject.uuid && subject.uuid === workflow.activity.uuid);
  }
  return config?.workflow === workflow;
}

/**
 * Add luck dice to this workflow's damage roll. Midi rolls damage through
 * dnd5e's activity.rollDamage, which fires dnd5e.preRollDamageV2 with the
 * activity as config.subject — so the listener only touches this activity's
 * roll (not other-activity or unrelated damage), then removes itself.
 * The plain Nd6 is pushed and dnd5e scales it for a critical itself.
 */
function injectLuckDamage(workflow, diceCount) {
  const formula = `${diceCount}d6`;
  let hookId = null;
  const removeHook = () => {
    if (hookId === null) return;
    Hooks.off("dnd5e.preRollDamageV2", hookId);
    hookId = null;
  };

  hookId = Hooks.on("dnd5e.preRollDamageV2", (config) => {
    if (!isWorkflowDamageRoll(config, workflow)) return;
    const parts = Array.isArray(config?.rolls?.[0]?.parts) ? config.rolls[0].parts
      : Array.isArray(config?.parts) ? config.parts
      : null;
    if (parts) {
      parts.push(formula);
      console.log(`[${MODULE_ID}] injectLuckDamage: pushed "${formula}" onto damage parts`);
    } else {
      console.warn(`[${MODULE_ID}] injectLuckDamage: damage parts not found — config keys:`, Object.keys(config ?? {}));
    }
    removeHook();
  });

  // Never leave the listener behind if this workflow's damage is never rolled.
  setTimeout(removeHook, 120_000);
  debug(`injectLuckDamage: waiting for ${workflow.activity?.name ?? "activity"} damage roll to add "${formula}"`);
}

function isCritDiceMaximized() {
  try { return !!game.settings.get("dnd5e", "criticalDamageMaxDice"); } catch { return false; }
}

// ── Attack prompts ────────────────────────────────────────────────────────────
// promptLuckOnMiss / promptNatOne work on an "attack" adapter so Midi mode and
// native dnd5e mode (native.js) share them:
//   actor, state                       the attacker; per-attack prompt state
//   total(), hitState()                current attack total; true / false / null
//   reroll(evaluate, label), addDice(n) apply luck to the roll and record it
//   finish()                           stamp the final HIT / MISS in the history

/** Attack adapter over a Midi workflow. */
function midiAttack(workflow) {
  return {
    actor:    workflow?.actor,
    state:    getState(workflow),
    total:    () => attackTotalOf(workflow),
    hitState: () => getDefiniteHitState(workflow),
    reroll:   (evaluate, label) => rerollAttack(workflow, evaluate, label),
    addDice:  (diceCount) => addLuckDiceToAttack(workflow, diceCount),
    finish:   () => finishLuckHistory(workflow)
  };
}


async function promptLuckOnMiss(attack) {
  const actor = attack?.actor;
  if (!actor || (!game.user?.isGM && actor.hasPlayerOwner && !actor.isOwner)) return;

  const state = attack.state;
  if (state.attackPrompted) return;

  let diceAdded = false; // once true, reroll option is hidden

  try {
    while (true) {
      const hitState = attack.hitState();
      console.log(`[${MODULE_ID}] promptLuckOnMiss loop: hitState=${hitState} total=${attack.total()}`);
      if (hitState !== false) return;

      const luckEnabled = isLuckDiceEnabled();
      const luckAvail   = luckEnabled ? getDiceUses(actor, LUCK_DICE_ITEM_NAME)   : 0;
      const impactAvail = luckEnabled ? getDiceUses(actor, IMPACT_DICE_ITEM_NAME) : 0;
      const totalAvail  = luckAvail + impactAvail;
      const hasInsp     = isInspirationEnabled() && actorHasInspiration(actor);

      if (totalAvail <= 0 && !hasInsp) { debug("promptLuckOnMiss: no dice or inspiration available, exiting"); return; }

      console.log(`[${MODULE_ID}] promptLuckOnMiss: luck=${luckAvail} impact=${impactAvail} total=${totalAvail} inspiration=${hasInsp} diceAdded=${diceAdded}`);
      state.attackPrompted = true;

      const options = [];
      if (hasInsp)                       options.push({ action: "inspiration", label: "Use Inspiration (Reroll)" });
      if (totalAvail >= 2 && !diceAdded) options.push({ action: "reroll",      label: "Spend 2 Dice to Reroll" });
      if (totalAvail > 0)                options.push({ action: "add",         label: `Add Dice (1–${totalAvail}d6)` });
      options.push({ action: "decline", label: "Keep Miss" });

      const action = await promptChoice(
        "Missed Attack",
        `<p>Your attack missed with a <strong>${attack.total()}</strong>. What would you like to do?</p>${luckEnabled ? buildDiceAvailableHTML(actor) : ""}`,
        options
      );
      console.log(`[${MODULE_ID}] promptLuckOnMiss: player chose "${action}"`);
      if (action === "decline" || !action) return;

      if (action === "inspiration") {
        await consumeInspiration(actor);
        await attack.reroll(evaluateInspirationReroll, "Rerolled with Inspiration");
        markIfConverted(attack);
        // Inspiration and Luck Dice are mutually exclusive — stop here regardless of hit state.
        return;
      }

      if (action === "reroll" && totalAvail >= 2) {
        const spent = await spendDiceFromPools(actor, 2);
        if (spent < 2) { debug("promptLuckOnMiss: could not spend 2 dice for reroll"); return; }
        state.luckSpentOnAttack += 2;
        await attack.reroll(evaluateReroll, "Rerolled with 2 Luck Dice");
        markIfConverted(attack);
      }

      if (action === "add") {
        const curMax = getDiceUses(actor, LUCK_DICE_ITEM_NAME) + getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
        if (curMax <= 0) return;

        const raw = await promptSlider("Add Dice to Attack", buildDiceAvailableHTML(actor), "luckDiceCount", 1, curMax, 1);
        const diceCount = clamp(Number(raw ?? 0), 1, curMax);
        if (!Number.isFinite(diceCount) || diceCount < 1) { debug("promptLuckOnMiss: invalid diceCount"); return; }

        const spent = await spendDiceFromPools(actor, diceCount);
        if (spent < 1) { debug("promptLuckOnMiss: could not spend dice for add"); return; }
        diceAdded = true;
        state.luckSpentOnAttack += diceCount;
        await attack.addDice(diceCount);
        markIfConverted(attack);
      }
    }
  } finally {
    await attack.finish();
  }
}

async function promptLuckOnDamage(workflow) {
  const actor = workflow?.actor;
  if (!actor) return;

  const state = getState(workflow);
  if (state.damagePrompted) return;

  const hitState     = getDefiniteHitState(workflow);
  const effectiveHit = hitState === true || state.convertedMissToHit === true;
  const isCrit       = workflow.isCritical === true;
  const maximizeCrit = isCrit && isCritDiceMaximized();

  console.log(
    `[${MODULE_ID}] preDamageRoll:`,
    `hitState=${hitState}`,
    `convertedMissToHit=${state.convertedMissToHit ?? false}`,
    `effectiveHit=${effectiveHit}`,
    `isCrit=${isCrit}`,
    `maximizeCrit=${maximizeCrit}`,
    `hitTargets=${workflow.hitTargets?.size ?? "n/a"}`,
    `attackTotal=${workflow.attackTotal ?? workflow.attackRoll?.total ?? "n/a"}`
  );

  if (!effectiveHit) { debug("promptLuckOnDamage: not a hit — skipping damage prompt"); return; }

  const luckAvail   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
  const impactAvail = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
  const totalAvail  = luckAvail + impactAvail;
  if (totalAvail <= 0) { debug("promptLuckOnDamage: no dice available"); return; }

  let critNote = "";
  if (isCrit) {
    critNote = maximizeCrit
      ? `<p><em>Critical hit! Extra dice are maximized.</em></p>`
      : `<p><em>Critical hit! You'll roll double the chosen number of dice.</em></p>`;
  }

  const raw = await promptSlider(
    isCrit ? "Add Dice to Damage (Critical Hit!)" : "Add Dice to Damage",
    `<p>Attack ${isCrit ? "critically " : ""}hit! Add dice to damage?</p>${critNote}${buildDiceAvailableHTML(actor)}`,
    "luckDamageCount",
    0, totalAvail, 0
  );

  state.damagePrompted = true;

  const diceCount = clamp(Number(raw ?? 0), 0, totalAvail);
  if (!Number.isFinite(diceCount) || diceCount <= 0) { debug("promptLuckOnDamage: player chose 0 dice"); return; }

  const spent = await spendDiceFromPools(actor, diceCount);
  if (spent < 1) { debug("promptLuckOnDamage: could not spend dice"); return; }

  console.log(`[${MODULE_ID}] promptLuckOnDamage: injecting ${diceCount}d6 isCrit=${isCrit} maximizeCrit=${maximizeCrit}`);
  injectLuckDamage(workflow, diceCount);
  await updateLuckHistory(workflow, (h) => {
    h.entries.push({ kind: "damage", label: `+${diceCount}d6 Luck Dice to damage${isCrit ? " (critical)" : ""}` });
  });
}

async function promptNatOne(attack) {
  const actor = attack?.actor;
  if (!actor || (!game.user?.isGM && actor.hasPlayerOwner && !actor.isOwner)) return;

  const state       = attack.state;
  const luckEnabled = isLuckDiceEnabled();
  const luckAvail   = luckEnabled ? getDiceUses(actor, LUCK_DICE_ITEM_NAME)   : 0;
  const impactAvail = luckEnabled ? getDiceUses(actor, IMPACT_DICE_ITEM_NAME) : 0;
  const totalAvail  = luckAvail + impactAvail;
  const hasInsp     = isInspirationEnabled() && actorHasInspiration(actor);

  // No options at all — auto-regain if luck dice are enabled and the actor has them.
  if (totalAvail < 2 && !hasInsp) {
    debug("promptNatOne: fewer than 2 dice available and no inspiration — auto-regaining 1 Luck Die");
    if (luckEnabled) {
      await updateLuckUses(actor, 1);
      await whisperLuckRegain(actor, "natural 1 with no dice to reroll");
    }
    return;
  }

  const options = [];
  if (hasInsp)         options.push({ action: "inspiration", label: "Use Inspiration (Reroll)" });
  if (totalAvail >= 2) options.push({ action: "reroll",      label: "Spend 2 Dice to Reroll" });
  options.push({ action: "keep", label: luckEnabled ? "Keep Miss (Regain 1 Luck Die)" : "Keep Miss" });

  const action = await promptChoice(
    "Natural 1!",
    `<p>You rolled a natural 1. What would you like to do?</p>${luckEnabled ? buildDiceAvailableHTML(actor) : ""}`,
    options
  );

  console.log(`[${MODULE_ID}] promptNatOne: player chose "${action}"`);

  if (action === "inspiration") {
    await consumeInspiration(actor);
    await attack.reroll(evaluateInspirationReroll, "Rerolled with Inspiration");
    markIfConverted(attack);
    // Inspiration and Luck Dice are mutually exclusive — stop here regardless of hit state.
    await attack.finish();
    return;
  }

  if (action === "reroll") {
    const spent = await spendDiceFromPools(actor, 2);
    if (spent < 2) { debug("promptNatOne: could not spend 2 dice"); return; }
    state.luckSpentOnAttack += 2;
    await attack.reroll(evaluateReroll, "Rerolled with 2 Luck Dice");
    markIfConverted(attack);
    // Still missing — continue in the miss prompt, which adds to the same history.
    if (attack.hitState() === false) return promptLuckOnMiss(attack);
    await attack.finish();
    return;
  }

  if (luckEnabled) {
    await updateLuckUses(actor, 1);
    await whisperLuckRegain(actor, "kept natural 1 miss");
  }
}

// ── Midi save failure prompt ──────────────────────────────────────────────────

/**
 * Show the luck dice / inspiration prompt on the current client and return the
 * result. Called directly when this client owns the actor (with the real save
 * roll), or via the midiSaveFailed socket on a player's client (rebuilt from
 * its formula).
 *
 * reporter: optional async (entry) => void that receives each reroll / add-dice
 * step, for display on Midi's card. Without one (concentration), the prompts
 * post their own roll card instead.
 *
 * Cross-file calls to promptNatOneSave (saving-throw.js) and promptLuckOnCheckFail
 * (skill-check.js) go through LDA because those scripts load after attack.js.
 */
async function runMidiSavePrompt(actor, rollTotal, dc, formula, d20Result, rollMsgId, rollMsgContent, saveRoll = null, reporter = null) {
  const roll = saveRoll ?? buildFakeRoll(rollTotal, formula, d20Result);
  if (d20Result === 1) {
    return LDA.promptNatOneSave(actor, rollTotal, dc, roll, rollMsgId, rollMsgContent, true, reporter);
  }
  return LDA.promptLuckOnCheckFail(
    actor, rollTotal, dc, rollMsgId, rollMsgContent, roll,
    "Failed Saving Throw", "saving throw", true, reporter
  );
}

/**
 * Emit a midiSaveFailed socket to the owning player and await their result.
 * The Promise resolves when the player's client emits midiSaveResult back, or
 * with null after 60 seconds without a response.
 *
 * The player's client can't write to Midi's card (usually owned by whoever used
 * the item), so it sends each luck step back as midiSaveStep; onStep writes it
 * here, in order. Each step also restarts the timeout, since the player is still
 * deciding. The result resolves only after every step has been written.
 */
function requestMidiSaveFromPlayer(actor, rollTotal, dc, formula, d20Result, rollMsgId, rollMsgContent, onStep = null) {
  let steps = Promise.resolve();
  const result = new Promise((resolve) => {
    const expire  = () => { pendingMidiSaveResults.delete(actor.id); resolve(null); };
    const pending = { resolve, timeoutId: setTimeout(expire, 60_000) };
    pending.onStep = (entry) => {
      clearTimeout(pending.timeoutId);
      pending.timeoutId = setTimeout(expire, 60_000);
      if (onStep) steps = steps.then(() => onStep(entry)).catch(err => console.warn(`[${MODULE_ID}] midiSaveStep error:`, err));
    };
    pendingMidiSaveResults.set(actor.id, pending);

    game.socket.emit(`module.${MODULE_ID}`, {
      type: "midiSaveFailed",
      actorId: actor.id, rollTotal, dc, formula,
      d20Result, rollMsgId, rollMsgContent
    });
  });
  return result.then(async (res) => { await steps; return res; });
}

/** Resolve the token document, canvas token and actor for a targetSaveDetails key. */
function resolveSaveTarget(workflow, uuid) {
  let tokenDoc = null;
  try { tokenDoc = fromUuidSync(uuid); } catch {}
  const token = [...(workflow.targets ?? [])].find(
    t => t === tokenDoc?.object || t.document?.uuid === uuid || t.uuid === uuid || t.actor?.uuid === uuid
  ) ?? tokenDoc?.object ?? null;
  const actor = token?.actor ?? tokenDoc?.actor ?? (tokenDoc?.documentName === "Actor" ? tokenDoc : null);
  return { tokenDoc, token, actor };
}

/**
 * Turn a failed save into a pass inside Midi's workflow. Runs at postCheckSaves,
 * after Midi decided the saves and before it renders them or applies damage, so
 * this patches exactly what Midi reads next:
 *   - saves / failedSaves: displaySaves(), effect targets, and the damage save
 *     multiplier (workflow.saves.has(token)) all come from these Sets.
 *   - saveDisplayData: the per-target row displaySaves() renders.
 *   - the save roll's total, for anything else that reads targetSaveDetails.
 */
function applyLuckySavePass(workflow, { uuid, details, tokenDoc, token, newTotal, dc }) {
  const isTarget = (t) => t === token || t === tokenDoc || t === uuid || (t?.document?.uuid ?? t?.uuid) === uuid;

  let saved = null;
  if (workflow.failedSaves instanceof Set) {
    for (const t of [...workflow.failedSaves]) {
      if (!isTarget(t)) continue;
      workflow.failedSaves.delete(t);
      saved ??= t;
    }
  }
  if (workflow.saves instanceof Set) workflow.saves.add(saved ?? token ?? tokenDoc);

  const saveRoll = details?.saveRoll;
  if (saveRoll) {
    saveRoll._total = newTotal;
    try {
      Object.defineProperty(saveRoll, "total", { get() { return newTotal; }, configurable: true, enumerable: true });
    } catch {}
  }

  const rowId = (saved ?? token)?.id ?? tokenDoc?.id;
  const row = workflow.saveDisplayData?.find(r => r.id === rowId || r.target?.document?.uuid === uuid);
  if (row) {
    row.rollTotal   = String(newTotal);
    row.saveSymbol  = String(row.saveSymbol ?? "").replace("fa-xmark", "fa-check");
    row.saveClass   = "success";
    row.saveTooltip = `${newTotal} vs DC ${dc} (Luck Dice)`;
  } else {
    debug(`applyLuckySavePass: no saveDisplayData row for ${uuid}`);
  }

  console.log(`[${MODULE_ID}] applyLuckySavePass: ${token?.name ?? uuid} now passes (${newTotal} vs DC ${dc}) saves=${workflow.saves?.size} failedSaves=${workflow.failedSaves?.size}`);
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  console.log(`[${MODULE_ID}] attack.js ready — midi-qol active=${game.modules.get("midi-qol")?.active ?? false}`);
  // Without Midi, native.js handles rolls through dnd5e's own hooks instead.
  if (!game.modules.get("midi-qol")?.active) return;

  // ── Luck Dice history on Midi's card ───────────────────────────────────────
  // Both hooks run the same idempotent injection; whichever fires last wins.
  Hooks.on("renderChatMessageHTML", (message, html) => injectLuckHistory(message, html));
  Hooks.on("dnd5e.renderChatMessage", (message, html) => injectLuckHistory(message, html));

  // ── Missed attacks ─────────────────────────────────────────────────────────
  // hitsChecked fires after Midi's checkHits() and before it displays the hits
  // and final attack roll, so a reroll here is rendered and judged by Midi.
  Hooks.on("midi-qol.hitsChecked", async (workflow) => {
    try {
      if (!isWorkflowResponder(workflow)) return;
      const actor   = workflow?.actor;
      const hasLuck = isLuckDiceEnabled() && actorHasLuckDice(actor);
      const hasInsp = isInspirationEnabled() && actorHasInspiration(actor);
      if (!hasLuck && !hasInsp) return;

      const hitState  = getDefiniteHitState(workflow);
      const d20Result = getKeptD20Result(workflow?.attackRoll);
      console.log(
        `[${MODULE_ID}] hitsChecked:`,
        `actor="${actor?.name}"`,
        `item="${workflow?.item?.name}"`,
        `hitState=${hitState}`,
        `attackTotal=${workflow?.attackTotal ?? workflow?.attackRoll?.total ?? "n/a"}`,
        `d20=${d20Result ?? "n/a"}`,
        `hitTargets=${workflow?.hitTargets?.size ?? "n/a"}`,
        `targets=${workflow?.targets?.size ?? "n/a"}`
      );
      if (hitState !== false) return;

      if (d20Result === 1) await promptNatOne(midiAttack(workflow));
      else await promptLuckOnMiss(midiAttack(workflow));
    } catch (err) {
      console.error(`[${MODULE_ID}] hitsChecked error:`, err);
    }
  });

  // ── Luck damage ────────────────────────────────────────────────────────────
  Hooks.on("midi-qol.preDamageRoll", async (workflow) => {
    try {
      if (!isLuckDiceEnabled() || !actorHasLuckDice(workflow?.actor)) return;
      if (!isWorkflowResponder(workflow)) return;
      await promptLuckOnDamage(workflow);
    } catch (err) {
      console.error(`[${MODULE_ID}] preDamageRoll error:`, err);
    }
  });

  // ── Failed Midi saves ──────────────────────────────────────────────────────
  // postCheckSaves fires after Midi's checkSaves() and before displaySaves(),
  // and Midi awaits it — so the player can be prompted here, and a luck pass is
  // rendered, excluded from effects, and given save damage by Midi itself.
  Hooks.on("midi-qol.postCheckSaves", async (workflow) => {
    try {
      if (!isWorkflowResponder(workflow)) return;
      const luckOn = isLuckDiceEnabled();
      const inspOn = isInspirationEnabled();
      if (!luckOn && !inspOn) return;

      const detailEntries = Object.entries(workflow?.targetSaveDetails ?? {});
      if (!detailEntries.length) return;

      const workflowDC = Number(
        workflow.saveDetails?.rollDC ??
        workflow.saveDetails?.dc ??
        workflow.activity?.save?.dc?.value ??
        0
      );

      for (const [uuid, details] of detailEntries) {
        const saveRoll  = details?.saveRoll;
        const rollTotal = Number(saveRoll?.total ?? 0);
        const dc        = Number(details?.rollDC ?? details?.saveDetails?.rollDC ?? workflowDC);
        const { tokenDoc, token, actor } = resolveSaveTarget(workflow, uuid);

        // Only a genuine low roll Midi counted as a failure. A total that meets
        // the DC but still failed is an auto-fail (e.g. paralyzed) — dice can't help.
        const failed = token && workflow.failedSaves instanceof Set ? workflow.failedSaves.has(token) : true;
        debug(`postCheckSaves: ${actor?.name ?? uuid} total=${rollTotal} dc=${dc} failed=${failed}`);
        if (!dc || rollTotal >= dc || !failed) continue;
        if (!actor || actor.type !== "character") continue;

        const hasLuck = luckOn && actorHasLuckDice(actor);
        const hasInsp = inspOn && actorHasInspiration(actor);
        if (!hasLuck && !hasInsp) continue;

        const formula   = saveRoll?.formula ?? "1d20";
        const d20Result = getKeptD20Result(saveRoll) ?? null;

        // Each luck step is written to Midi's card under the saves as it happens.
        const target = { uuid, name: token?.name ?? actor.name, start: rollTotal };
        const report = (entry) => recordSaveLuck(workflow, target, entry);

        // Route to the owning player's client when they're online; otherwise prompt here.
        const activeOwner = game.users.find(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"));
        const result = (!activeOwner || activeOwner.id === game.user.id)
          ? await runMidiSavePrompt(actor, rollTotal, dc, formula, d20Result, null, "", saveRoll, report)
          : await requestMidiSaveFromPlayer(actor, rollTotal, dc, formula, d20Result, null, "", report);

        console.log(`[${MODULE_ID}] postCheckSaves: ${actor.name} result=${JSON.stringify(result)}`);
        const passed = !!(result?.passed && result.finalTotal >= dc);
        await finishSaveLuck(workflow, uuid, passed);
        if (passed) {
          applyLuckySavePass(workflow, { uuid, details, tokenDoc, token, newTotal: result.finalTotal, dc });
        }
      }
    } catch (err) {
      console.error(`[${MODULE_ID}] postCheckSaves error:`, err);
    }
  });

  // ── Workflow cleanup ───────────────────────────────────────────────────────
  Hooks.on("midi-qol.RollComplete", async (workflow) => {
    try {
      const key = getWorkflowKey(workflow);
      if (isLuckDiceEnabled() && actorHasLuckDice(workflow?.actor) && isWorkflowResponder(workflow)) {
        const kind   = workflow?.workflowType ?? workflow?.item?.system?.actionType ?? workflow?.type;
        const failed = workflow?.failed === true || workflow?.isFailed === true || workflow?.success === false;
        debug(`RollComplete: kind=${kind} failed=${failed}`);
        if ((kind === "save" || kind === "check") && failed) {
          await maybeRegainLuckDie(workflow.actor, getState(workflow));
        }
      }
      workflowState.delete(key);
    } catch (err) {
      console.error(`[${MODULE_ID}] RollComplete error:`, err);
    }
  });

  // ── Concentration save luck dice ───────────────────────────────────────────
  // Midi rolls concentration through actor.rollConcentration and ends it with
  // dnd5e's actor.endConcentration(), which deletes the effect. preDeleteActiveEffect
  // fires SYNCHRONOUSLY on the client that calls delete(); returning false cancels
  // it. We then run the luck prompt and re-delete manually if the save still fails.
  //
  // Only deletions caused by a failed concentration *save* are intercepted: the
  // actor's recent roll message must be a concentration roll (dnd5e 6 marks it
  // system.type "concentration"; Midi's wrapper adds flags.midi-qol.isConcentrationCheck).
  // Removals with no save — dropping to 0 HP, an incapacitating condition, casting
  // another concentration spell, dismissing it — pass straight through.
  //
  // pendingConcentrationPrompts prevents recursion: while an actor's entry exists,
  // our own re-delete short-circuits at the guard below and is allowed through.
  const pendingConcentrationPrompts = new Map(); // actorId → pending object

  const isConcentrationEffect = (e) =>
    e.statuses?.has("concentrating") ||
    /concentrat/i.test(e.name  ?? "") ||
    /concentrat/i.test(e.label ?? "");

  const isConcentrationRollMessage = (m) =>
    m.system?.type === "concentration" || !!m.getFlag?.("midi-qol", "isConcentrationCheck");

  Hooks.on("preDeleteActiveEffect", (effect, options, userId) => {
    if (!isConcentrationEffect(effect)) return;

    const actor = effect.parent;
    if (!actor || actor.type !== "character") return;

    // Only proceed if luck dice or inspiration could help.
    const luckOn = isLuckDiceEnabled();
    const inspOn = isInspirationEnabled();
    if (!luckOn && !inspOn) return;
    if (!actorHasLuckDice(actor) && !(inspOn && actorHasInspiration(actor))) return;

    // Route to the owning client only — non-owners skip.
    const activeOwner = game.users.find(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"));
    if (activeOwner && activeOwner.id !== game.user.id) return;
    if (!activeOwner && !game.user.isGM) return;

    // Guard: already being handled (lets our own re-delete through).
    if (pendingConcentrationPrompts.has(actor.id)) return;

    // Require a recent (≤30 s) concentration roll by this actor.
    const now         = Date.now();
    const concSaveMsg = game.messages.contents.slice(-8).reverse().find(m =>
      now - m.timestamp <= 30_000 &&
      m.rolls?.length &&
      m.speaker?.actor === actor.id &&
      isConcentrationRollMessage(m)
    );
    if (!concSaveMsg) {
      debug(`preDeleteActiveEffect: no recent concentration roll — not intercepting concentration end for ${actor.name}`);
      return;
    }

    const roll  = concSaveMsg.rolls[0];
    const total = Number(roll?.total ?? 0);
    // DC: the roll carries its target; fall back to the actor's concentration DC.
    const dc    = Number(roll?.options?.target ?? actor.concentration?.dc ?? 10);

    // If the roll actually PASSED the DC, this is not a failure deletion — skip.
    if (total >= dc) return;

    const formula   = roll.formula ?? "1d20";
    const d20Result = getKeptD20Result(roll) ?? null;

    console.log(`[${MODULE_ID}] preDeleteActiveEffect: intercepting concentration removal for ${actor.name} total=${total} dc=${dc}`);

    // Register pending entry synchronously (guard is set before we return false).
    const pending = { effectId: effect.id, shouldDelete: false, resolve: null };
    pending.promise = new Promise(res => { pending.resolve = res; });
    pendingConcentrationPrompts.set(actor.id, pending);

    (async () => {
      try {
        const result = await runMidiSavePrompt(actor, total, dc, formula, d20Result, null, "", roll);
        console.log(`[${MODULE_ID}] preDeleteActiveEffect conc: ${actor.name} result=${JSON.stringify(result)}`);
        pending.shouldDelete = !(result?.passed && result.finalTotal >= dc);
      } catch (err) {
        console.error(`[${MODULE_ID}] preDeleteActiveEffect conc error:`, err);
        pending.shouldDelete = true;
      } finally {
        pending.resolve();
        if (pending.shouldDelete) {
          const concEffect = actor.effects.get(pending.effectId) ?? actor.effects.find(isConcentrationEffect);
          if (concEffect) {
            // Keep the pending guard set across this delete. The call re-enters
            // this hook synchronously; the pendingConcentrationPrompts guard above
            // short-circuits it (returns undefined, NOT false) so the deletion
            // proceeds instead of re-prompting.
            await concEffect.delete();
            console.log(`[${MODULE_ID}] preDeleteActiveEffect: concentration removed for ${actor.name} after failed luck dice`);
          } else {
            console.log(`[${MODULE_ID}] preDeleteActiveEffect: concentration already gone for ${actor.name}`);
          }
        } else {
          console.log(`[${MODULE_ID}] preDeleteActiveEffect: ${actor.name} KEPT concentration via luck dice`);
        }
        // Clear the guard only AFTER the re-delete completes, so our own delete
        // above is allowed through rather than re-intercepted.
        pendingConcentrationPrompts.delete(actor.id);
      }
    })();

    return false; // Block the original deletion — prompt runs asynchronously above.
  });

  console.log(`[${MODULE_ID}] attack.js initialized.`);
});

Object.assign(LDA, { runMidiSavePrompt, promptLuckOnMiss, promptNatOne });
})();
