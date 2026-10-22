// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Saves, ability checks, skills, tools and concentration: Luck Dice on a failure; breaking concentration.

import { correctDeathSave } from "./deathsaves.mjs";
import { rollExtras } from "./boosts.mjs";
import { autoFailOf } from "./save-rules.mjs";
import { LDA, MODULE_ID, debug, getKeptD20Result, HISTORY_FLAG, requestRollActors, isConcentrationBreakEnabled, finishCardHistory, cardReporter, canUseLuck, promptChoice, escapeHTML, getLegendaryResistance } from "./shared.mjs";

// ── Saves, checks and concentration ──────────────────────────────────────────

// Post-roll hooks as dnd5e 6 fires them: saves and ability checks only have the
// plain name (Actor5e#rollD20Test fires no V2 variant); skills, tools and
// concentration fire both, so their V2 names are used. `kind` picks the extras (boosts.mjs).
export const D20_TESTS = {
  "dnd5e.rollSavingThrow":     { title: "Failed Saving Throw",       rollType: "saving throw",       natOneSave: true, kind: "save" },
  "dnd5e.rollConcentrationV2": { title: "Failed Concentration Save", rollType: "concentration save", natOneSave: true, kind: "save" },
  "dnd5e.rollAbilityCheck":    { title: "Failed Ability Check",      rollType: "ability check",      kind: "check" },
  "dnd5e.rollSkillV2":         { title: "Failed Skill Check",        rollType: "skill check",        kind: "check" },
  "dnd5e.rollToolCheckV2":     { title: "Failed Tool Check",         rollType: "tool check",         kind: "check" },
};

/**
 * A failed save, check or concentration roll against a known DC. Uses the same
 * prompts as the roll-request window and Midi saves; their reporter receives
 * each step and rewrites the card's roll, so dnd5e redraws success / failure.
 * Rolls without a DC are skipped — nothing says they failed — and so are
 * automatic failures (save-rules.mjs), which no bonus can turn around.
 */
export async function onD20TestRolled(rolls, data, test) {
  try {
    const roll    = rolls?.[0];
    const message = roll?.parent;
    const actor   = data?.subject;
    if (!message || !actor) return;
    if (requestRollActors.has(actor.id)) return; // the roll-request window runs its own prompt
    if (autoFailOf(roll)) return;

    const dc = Number(roll.options?.target);
    if (!Number.isFinite(dc) || dc <= 0) return;
    // Automated Conditions 5e's forced failure (its DC of 999): nothing could reach it.
    if (dc === 999 && game.modules.get("automated-conditions-5e")?.active) return;
    const total = Number(roll.total ?? 0);
    if (total >= dc) return;

    // Bardic Inspiration, Lucky… — offered with the Luck Dice, and to creatures without them.
    const extras = rollExtras(actor, test.kind ?? "check");
    if (!canUseLuck(actor) && !extras) return;

    debug(`native ${test.rollType}: ${actor.name} rolled ${total} vs DC ${dc}`);

    const reporter = cardReporter(message, roll);

    // dnd5e's own rule: the roller and the GM always see a DC; others per its setting.
    const showDC = message.shouldDisplayChallenge ?? true;
    const result = (test.natOneSave && getKeptD20Result(roll) === 1)
      ? await LDA.promptNatOneSave(actor, total, dc, roll, null, "", showDC, reporter, extras)
      : await LDA.promptLuckOnCheckFail(actor, total, dc, null, "", roll, test.title, test.rollType, showDC, reporter, extras);

    await finishCardHistory(message, result?.passed && result.finalTotal >= dc ? "passed" : "failed");
    await refreshOriginSummary(message);
  } catch (err) {
    console.error(`[${MODULE_ID}] native ${test.rollType} error:`, err);
  }
}

/**
 * A save linked to a usage card is summarized inside that card (dnd5e's
 * "summarize chat"), and the usage card doesn't re-render when the save card
 * changes — so after Luck Dice change the roll, its summary would still show the
 * original failure. Touch the usage card so it re-renders for everyone.
 */
export async function refreshOriginSummary(message) {
  if (!message.getFlag(MODULE_ID, HISTORY_FLAG)?.entries?.length) return;
  const origin = message.getOriginatingMessage?.();
  if (!origin || origin === message || !origin.canUserModify?.(game.user, "update")) return;
  await origin.setFlag(MODULE_ID, "summaryRefresh", Date.now());
}

// ── Concentration ─────────────────────────────────────────────────────────────
// dnd5e 6 never ends concentration itself: a failed concentration save card shows
// a Break Concentration button. With the "concentrationBreak" setting, press it
// for the owner once any Luck Dice are settled — the same two steps the button
// takes: end concentration, then mark the card "Concentration Lost".

/** dnd5e.rollConcentrationV2: Luck Dice first (as for any save), then the break. */
export async function onConcentrationRolled(rolls, data, test) {
  await onD20TestRolled(rolls, data, test);
  await offerLegendaryResistance(rolls?.[0]?.parent, data?.subject);
  await breakConcentrationIfFailed(rolls?.[0]?.parent, data?.subject);
}

/** dnd5e.rollSavingThrow — Luck Dice on a failure (a death save's result recorded again if they change it), then an NPC's Legendary Resistance. */
export async function onSaveRolled(rolls, data, test) {
  const first = rolls?.[0];
  const original = first ? { isSuccess: Number(first.total ?? 0) >= Number(first.options?.target ?? 10), isCritical: !!first.isCritical, isFumble: !!first.isFumble } : null;
  await onD20TestRolled(rolls, data, test);
  if (original && first?.parent?.system?.type === "death") await correctDeathSave(first.parent, data?.subject, original);
  await offerLegendaryResistance(rolls?.[0]?.parent, data?.subject);
}

/**
 * The "legendaryResistance" setting: an NPC failed a save it could resist
 * (dnd5e's own test — an owned NPC, Legendary Resistance left, not already
 * resisted or broken). The GM is asked, or it's used automatically; dnd5e's
 * resistSave spends a use and turns the save into a success. True if used.
 */
export async function offerLegendaryResistance(message, actor) {
  try {
    const mode = getLegendaryResistance();
    if (mode === "off" || !message || !game.user.isGM) return false;
    if (!message.system?.canResist || typeof actor?.system?.resistSave !== "function") return false;
    const roll = message.rolls?.[0];
    const { value = 0, max = 0 } = actor.system.resources?.legres ?? {};
    if (mode === "prompt") {
      const what = message.system?.type === "concentration" || roll?.options?.isConcentration ? "concentration save" : "saving throw";
      const choice = await promptChoice("Legendary Resistance",
        `<p><strong>${escapeHTML(message.speakerActor?.name ?? actor.name)}</strong> failed its ${what}
         (${roll?.total ?? "?"} vs DC ${roll?.options?.target ?? "?"}). Use Legendary Resistance? (${value} of ${max} left)</p>`,
        [{ action: "use", label: "Use Legendary Resistance" }, { action: "fail", label: "Fail the Save" }]);
      if (choice !== "use") return false;
    }
    await actor.system.resistSave(message);
    console.log(`[${MODULE_ID}] legendary resistance: ${actor.name} succeeded instead (${value - 1} of ${max} left)`);
    return true;
  } catch (err) {
    console.error(`[${MODULE_ID}] legendary resistance error:`, err);
    return false;
  }
}

export async function breakConcentrationIfFailed(message, actor) {
  try {
    if (!message || !actor?.isOwner || !isConcentrationBreakEnabled()) return;
    if (game.settings.get("dnd5e", "disableConcentration")) return;
    const roll = message.rolls?.[0];
    const dc   = Number(roll?.options?.target);
    if (!Number.isFinite(dc) || dc <= 0 || !roll.isFailure) return; // no DC: nothing says it failed
    if (message.system?.outcome === "broken" || message.system?.resisted) return; // resisted: Legendary Resistance made it a success
    const ended = await actor.endConcentration();
    if (ended?.length) await message.update({ "system.outcome": "broken" });
    console.log(`[${MODULE_ID}] concentration: ${actor.name} failed (${roll.total} vs DC ${roll.options.target}) — ${ended?.length ? "broken" : "nothing to end"}`);
  } catch (err) {
    console.error(`[${MODULE_ID}] concentration break error:`, err);
  }
}
