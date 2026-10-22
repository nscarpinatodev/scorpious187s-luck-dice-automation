// ── Scorpious187's Luck Dice Automation — Saving Throws ──────────────────────
// Nat-1 prompt for manual saving throws triggered via the skill check launcher.
// Depends on: core.js and skill-check.js (must be loaded first).

(() => {
const LDA = window.LDA;
const {
  MODULE_ID, LUCK_DICE_ITEM_NAME, IMPACT_DICE_ITEM_NAME,
  debug, getDiceUses, updateLuckUses, actorHasLuckDice,
  promptChoice, getKeptD20Result, spendDiceFromPools,
  evaluateReroll, buildDiceAvailableHTML, whisperLuckRegain,
  isLuckDiceEnabled, isInspirationEnabled, actorHasInspiration, consumeInspiration,
  evaluateInspirationReroll,
  promptLuckOnCheckFail,  // exported by skill-check.js, which loads before us
} = LDA;

console.log(`[${MODULE_ID}] saving-throw.js parsed — user=${game?.user?.name ?? "unknown"} isGM=${game?.user?.isGM ?? "?"} build=${Date.now()}`);

// ── Nat-1 on saving throw ─────────────────────────────────────────────────────

/**
 * Two-option dialog shown when a player rolls a natural 1 on a saving throw:
 *   • Use Inspiration (Reroll)  — if inspiration is available and enabled
 *   • Spend 2 Dice to Reroll   — if luck dice are enabled and enough are available
 *   • Keep Failure (Gain 1 Luck Die) / Keep Failure
 *
 * If a reroll is chosen and the save still fails, chains into promptLuckOnCheckFail
 * so the player can add dice (the "can add dice to the reroll" rule).
 * Inspiration blocks luck dice: if inspiration is used the chain stops.
 *
 * Returns { finalTotal, passed } or null (cancelled / could not spend).
 *
 * reporter: optional async (entry, rolls) => void. When given (Midi saves, native
 * dnd5e rolls), each reroll is reported to it — for display on that mode's card —
 * instead of being written to a roll card here. entry: { label, total, detail };
 * rolls: { roll } — the new roll, for a caller that rewrites the card's roll.
 *
 * extras: optional other ways to change the roll (native mode — see promptLuckOnCheckFail),
 * offered here too. One that adds to the roll leaves the natural 1, so this prompt comes back;
 * one that replaces it hands over to the full luck-dice loop like a reroll.
 */
async function promptNatOneSave(actor, rollTotal, dc, originalRoll, rollMsgId, rollMsgContent, showDC = true, reporter = null, extras = null) {
  if (!game.user.isGM && actor.hasPlayerOwner && !actor.isOwner) return null;

  const luckEnabled = isLuckDiceEnabled();
  const hasLuck     = luckEnabled && actorHasLuckDice(actor);
  const luckAvail   = luckEnabled
    ? getDiceUses(actor, LUCK_DICE_ITEM_NAME) + getDiceUses(actor, IMPACT_DICE_ITEM_NAME)
    : 0;
  // Something already added to the roll (an extra): a reroll would throw it away.
  const added   = rollTotal !== Number(originalRoll?.total ?? rollTotal);
  const hasInsp = isInspirationEnabled() && actorHasInspiration(actor) && !added;
  const canReroll = luckAvail >= 2 && !added;
  const extraOpts = extras?.options({ added }) ?? [];

  // No usable resources — auto-regain one luck die (mirrors nat-1 attack behaviour).
  if (!canReroll && !hasInsp && !extraOpts.length) {
    debug(`promptNatOneSave: no resources for ${actor.name} — auto-regaining`);
    if (hasLuck) {
      await updateLuckUses(actor, 1);
      await whisperLuckRegain(actor, "natural 1 saving throw with no dice to reroll");
    }
    return { finalTotal: rollTotal, passed: false };
  }

  const options = [];
  if (hasInsp)   options.push({ action: "inspiration", label: "Use Inspiration (Reroll)" });
  if (canReroll) options.push({ action: "reroll",      label: "Spend 2 Dice to Reroll" });
  options.push(...extraOpts);
  options.push({ action: "keep", label: hasLuck ? "Keep Failure (Gain 1 Luck Die)" : "Keep Failure" });

  const action = await promptChoice(
    "Natural 1 on Save!",
    `<p><strong>${actor.name}</strong> rolled a natural 1 on a saving throw${rollTotal !== Number(originalRoll?.total ?? rollTotal) ? ` (now <strong>${rollTotal}</strong>)` : ""}. What would you like to do?</p>
     ${hasLuck ? buildDiceAvailableHTML(actor) : ""}`,
    options
  );

  console.log(`[${MODULE_ID}] promptNatOneSave: ${actor.name} chose "${action}"`);

  if (!action || action === "keep") {
    if (hasLuck) {
      await updateLuckUses(actor, 1);
      await whisperLuckRegain(actor, "kept natural 1 saving throw");
    }
    return { finalTotal: rollTotal, passed: false };
  }

  if (extras?.handles(action)) {
    const out = await extras.run(action, originalRoll);
    if (!out) return promptNatOneSave(actor, rollTotal, dc, originalRoll, rollMsgId, rollMsgContent, showDC, reporter, extras);
    if (out.roll) {
      const newTotal = Number(out.roll.total ?? 0);
      if (reporter) await reporter({ label: out.label, total: newTotal, detail: out.detail }, { roll: out.roll });
      if (newTotal >= dc) return { finalTotal: newTotal, passed: true };
      return promptLuckOnCheckFail(actor, newTotal, dc, rollMsgId, rollMsgContent, out.roll,
        "Failed Saving Throw", "saving throw", showDC, reporter, extras);
    }
    const newTotal = rollTotal + Number(out.bonusRoll?.total ?? 0);
    if (reporter) await reporter({ label: out.label, total: newTotal, detail: out.detail }, { bonusRoll: out.bonusRoll });
    if (newTotal >= dc) return { finalTotal: newTotal, passed: true };
    return promptNatOneSave(actor, newTotal, dc, originalRoll, rollMsgId, rollMsgContent, showDC, reporter, extras);
  }

  // Helper: show a reroll — report it when a reporter is given, otherwise append
  // a section to the roll card. Returns [msgId, content] for the luck loop.
  async function applyRerollSection(newRoll, sectionLabel) {
    if (reporter) {
      await reporter({
        label:  sectionLabel === "Luck Dice" ? "Rerolled with 2 Luck Dice" : `Rerolled with ${sectionLabel}`,
        total:  Number(newRoll.total ?? 0),
        detail: `d20: ${getKeptD20Result(newRoll) ?? "?"}`
      }, { roll: newRoll });
      return [rollMsgId, rollMsgContent];
    }
    const rerollHtml    = await newRoll.render();
    const rerollSection = `
      <div style="border-top:1px solid #aaa;margin-top:4px;padding-top:4px">
        <p style="margin:0 0 4px;font-size:0.85em;opacity:0.7">Rerolled with ${sectionLabel}:</p>
        ${rerollHtml}
      </div>`;
    const updatedContent = rollMsgContent + rerollSection;
    const existingMsg    = rollMsgId ? game.messages.get(rollMsgId) : null;
    let   newMsgId       = rollMsgId;
    if (existingMsg) {
      await existingMsg.update({ content: updatedContent });
    } else {
      const msg = await ChatMessage.create({ content: updatedContent, speaker: { alias: actor.name } });
      newMsgId  = msg?.id ?? null;
    }
    return [newMsgId, updatedContent];
  }

  if (action === "inspiration") {
    await consumeInspiration(actor);
    const newRoll                = await evaluateInspirationReroll(originalRoll);
    const [newMsgId, newContent] = await applyRerollSection(newRoll, "Inspiration");
    const newTotal               = Number(newRoll.total ?? 0);
    if (newTotal >= dc) return { finalTotal: newTotal, passed: true };
    // Inspiration blocks luck dice — report the failure and stop.
    return { finalTotal: newTotal, passed: false };
  }

  if (action === "reroll") {
    const spent = await spendDiceFromPools(actor, 2);
    if (spent < 2) return null;
    const newRoll                = await evaluateReroll(originalRoll);
    const [newMsgId, newContent] = await applyRerollSection(newRoll, "Luck Dice");
    const newTotal               = Number(newRoll.total ?? 0);
    if (newTotal >= dc) return { finalTotal: newTotal, passed: true };
    // Still failing — hand off to the full luck-dice loop (add-dice now available).
    return await promptLuckOnCheckFail(
      actor, newTotal, dc, newMsgId, newContent, newRoll,
      "Failed Saving Throw", "saving throw", showDC, reporter, extras
    );
  }

  return null;
}

Object.assign(LDA, { promptNatOneSave });
})();
