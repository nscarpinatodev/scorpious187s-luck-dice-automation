// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// What the module adds to dnd5e's chat cards: the Luck Dice history, Applied and Effects rows, Undo buttons.

import { RIDERS_FLAG } from "./riders.mjs";
import { REACTIONS_FLAG } from "./reactions.mjs";
import { ATTACK_REASONS_FLAG, reasonsHTML } from "./advantage.mjs";
import { MASTERY_RESULT_FLAG } from "./mastery.mjs";
import { MODULE_ID, HISTORY_FLAG, renderLuckSection, APPLIED_FLAG, escapeHTML, APPLIED_EFFECTS_FLAG } from "./shared.mjs";
import { undoAppliedDamage, undoAppliedEffects } from "./undo.mjs";

/**
 * An Undo button: the row's (every target, "Undo" / "Undo All") or, with an
 * index, one target's — a small icon beside its name. GM-only.
 */
export function undoButton(tooltip, { index = null, label = "Undo" } = {}) {
  if (index !== null) {
    return `<button type="button" class="lda-undo" data-lda-undo-index="${index}" data-tooltip="${escapeHTML(tooltip)}"
      aria-label="${escapeHTML(tooltip)}" style="flex:0 0 auto;width:auto;margin-left:3px;padding:0 4px;line-height:1.2;font-size:0.75em">
      <i class="fa-solid fa-rotate-left"></i></button>`;
  }
  return `<button type="button" class="lda-undo" data-tooltip="${escapeHTML(tooltip)}"
    style="flex:0 0 auto;width:auto;margin-left:auto;padding:0 6px;line-height:1.4;font-size:0.85em">
    <i class="fa-solid fa-rotate-left"></i> ${escapeHTML(label)}</button>`;
}

/**
 * Wire a rendered row's Undo buttons to its action, called with the target's
 * index or null for all (rows are re-injected each render). All of the row's
 * buttons are disabled while one runs.
 */
export function wireUndo(block, action) {
  const buttons = [...block.querySelectorAll(".lda-undo")];
  for (const button of buttons) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const index = button.dataset.ldaUndoIndex;
      buttons.forEach(b => { b.disabled = true; });
      try { await action(index === undefined ? null : Number(index)); }
      catch (err) { console.error(`[${MODULE_ID}] undo error:`, err); buttons.forEach(b => { b.disabled = false; }); }
    });
  }
}

export const UNDO_NOTE = "Doesn't reverse dnd5e's own follow-ups: a concentration check, Downed / Unconscious, death saves.";

// ── Luck Dice history on dnd5e's cards ────────────────────────────────────────

/**
 * Insert the history as its own row after the card's last roll row. dnd5e 6
 * puts each roll in a `section.icon-row` (icon + roll button); the history goes
 * after that whole row — inside it, it would be squeezed into the roll column.
 * Idempotent — safe to run from more than one render hook. Hidden where the
 * roll itself is: blind / private rolls, and attack results when dnd5e's attack
 * roll visibility hides them.
 */
export function injectNativeHistory(message, html) {
  if (!(html instanceof HTMLElement) || html.querySelector(".midi-results")) return;
  html.querySelectorAll(".lda-luck-history, .lda-attack-reasons-row, .lda-mastery, .lda-riders, .lda-reactions, .lda-applied-damage, .lda-applied-effects").forEach(el => el.remove());
  if (!message.isContentVisible) return;

  const blocks  = [];
  const history = message.getFlag?.(MODULE_ID, HISTORY_FLAG);
  if (history?.entries?.length && (game.user.isGM || message.system?.displayResult !== false)) {
    blocks.push(renderLuckSection(history));
  }
  const attackReasons = message.getFlag?.(MODULE_ID, ATTACK_REASONS_FLAG);
  if (attackReasons?.advantage?.length || attackReasons?.disadvantage?.length) blocks.push(renderAttackReasonsSection(attackReasons));
  const mastery = message.getFlag?.(MODULE_ID, MASTERY_RESULT_FLAG);
  if (mastery?.text) blocks.push(renderMasterySection(mastery));
  const reactions = message.getFlag?.(MODULE_ID, REACTIONS_FLAG);
  if (reactions?.length) blocks.push(renderReactionsSection(reactions));
  const riders = message.getFlag?.(MODULE_ID, RIDERS_FLAG);
  if (riders?.length) blocks.push(renderRidersSection(riders));
  const appliedEffects = message.getFlag?.(MODULE_ID, APPLIED_EFFECTS_FLAG);
  if (appliedEffects?.length) {
    const block = renderAppliedEffectsSection(appliedEffects);
    wireUndo(block, (index) => undoAppliedEffects(message, index));
    blocks.push(block);
  }
  const applied = message.getFlag?.(MODULE_ID, APPLIED_FLAG);
  if (applied?.length) {
    // While the damage stands, the "Applied" row replaces dnd5e's tray: the tray
    // would show everyone at full damage (it doesn't know the saves) and could
    // apply it a second time. Once any of it is undone, the tray is back for
    // applying by hand (with its own half / double / none per creature).
    if (!applied.some(a => a.undone)) html.querySelectorAll("damage-application").forEach(el => el.remove());
    if (canSeeDamageApplication()) {
      const block = renderAppliedSection(applied);
      wireUndo(block, (index) => undoAppliedDamage(message, index));
      blocks.push(block);
    }
  }
  if (!blocks.length) return;

  const rollRow = [...html.querySelectorAll("section.icon-row")].filter(row => row.querySelector(".dice-roll")).at(-1);
  if (rollRow) rollRow.after(...blocks);
  else (html.querySelector(".message-content") ?? html).append(...blocks);
}

/** "Effects  Goblin: Paralyzed · Pip: Poisoned" as a card row. */
export function renderAppliedEffectsSection(applied) {
  const undoable  = (a) => !a.undone && a.undo?.length;
  const canUndo   = game.user.isGM && applied.some(undoable);
  const perTarget = canUndo && applied.length > 1;
  const parts = applied.map((a, i) =>
    `<span style="white-space:nowrap"><span style="${a.undone ? "text-decoration:line-through;opacity:0.55" : ""}">${escapeHTML(a.name)}: <strong>${escapeHTML(a.effects.join(", "))}</strong></span>${
      perTarget && undoable(a) ? undoButton(`Remove ${a.name}'s effects only. ${UNDO_NOTE}`, { index: i }) : ""}</span>`);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <section class="icon-row lda-applied-effects" style="display:flex;align-items:flex-start;gap:6px;margin:2px 0">
      <i class="fa-fw fa-solid fa-wand-magic-sparkles" aria-label="Effects applied" style="margin-top:2px;opacity:0.8"></i>
      <div style="flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px">
        <strong>Effects${undoneLabel(applied)}</strong>${parts.join("")}
        ${canUndo ? undoButton(`Remove ${perTarget ? "every target's" : "these"} effects. ${UNDO_NOTE}`, { label: perTarget ? "Undo All" : "Undo" }) : ""}
      </div>
    </section>`.trim();
  return wrapper.firstElementChild;
}

/** "On hit  Sneak Attack 3d6 (11) · Hunter's Mark 1d6 (4)" as a card row. */
export function renderRidersSection(riders) {
  const parts = riders.map(r =>
    `<span style="white-space:nowrap" data-tooltip="${escapeHTML(r.formula)}">${escapeHTML(r.name)} <strong>${r.total}</strong></span>`);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <section class="icon-row lda-riders" style="display:flex;align-items:flex-start;gap:6px;margin:2px 0">
      <i class="fa-fw fa-solid fa-bolt" aria-label="On-hit damage" style="margin-top:2px;opacity:0.8"></i>
      <div style="flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px">
        <strong>On hit</strong>${parts.join("")}
      </div>
    </section>`.trim();
  return wrapper.firstElementChild;
}

/** "Reactions  Wizard: Shield (+5 AC) · Rogue: Uncanny Dodge (half damage)" as a card row. */
export function renderReactionsSection(reactions) {
  const parts = reactions.map(r => `<span style="white-space:nowrap">${escapeHTML(r.name)}: <strong>${escapeHTML(r.reaction)}</strong></span>`);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <section class="icon-row lda-reactions" style="display:flex;align-items:flex-start;gap:6px;margin:2px 0">
      <i class="fa-fw fa-solid fa-shield-halved" aria-label="Reactions" style="margin-top:2px;opacity:0.8"></i>
      <div style="flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px">
        <strong>Reactions</strong>${parts.join("")}
      </div>
    </section>`.trim();
  return wrapper.firstElementChild;
}

/** "Advantage: Target prone · Reckless Attack" as a card row. */
export function renderAttackReasonsSection(reasons) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <section class="icon-row lda-attack-reasons-row" style="display:flex;align-items:flex-start;gap:6px;margin:2px 0">
      <i class="fa-fw fa-solid fa-scale-balanced" aria-label="Advantage and disadvantage" style="margin-top:2px;opacity:0.8"></i>
      <div style="flex:1;min-width:0">${reasonsHTML(reasons)}</div>
    </section>`.trim();
  return wrapper.firstElementChild;
}

/** "Mastery (Topple)  DC 13 — Goblin knocked Prone" as a card row. */
export function renderMasterySection(mastery) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <section class="icon-row lda-mastery" style="display:flex;align-items:flex-start;gap:6px;margin:2px 0">
      <i class="fa-fw fa-solid fa-khanda" aria-label="Weapon mastery" style="margin-top:2px;opacity:0.8"></i>
      <div style="flex:1;min-width:0"><strong>Mastery (${escapeHTML(mastery.label)})</strong> ${escapeHTML(mastery.text)}</div>
    </section>`.trim();
  return wrapper.firstElementChild;
}

/** A row heading's note: " (undone)" once all of it is, " (partly undone)" for some. */
export function undoneLabel(applied) {
  const count = applied.filter(a => a.undone).length;
  return !count ? "" : count === applied.length ? " (undone)" : " (partly undone)";
}

/** Damage applied to targets is shown to whoever dnd5e lets use the damage tray. */
export function canSeeDamageApplication() {
  if (game.user.isGM) return true;
  try { return !!game.settings.get("dnd5e", "allowPlayerDamageTray"); } catch { return false; }
}

/** "Applied: Hill Giant 14 · Goblin 7" as a card row (healing shown as +N). */
export function renderAppliedSection(applied) {
  const undoable  = (a) => !a.undone && a.hp;
  const canUndo   = game.user.isGM && applied.some(undoable);
  const perTarget = canUndo && applied.length > 1;
  const parts = applied.map((a, i) =>
    `<span style="white-space:nowrap"><span style="${a.undone ? "text-decoration:line-through;opacity:0.55" : ""}">${escapeHTML(a.name)} <strong>${a.amount < 0 ? `+${-a.amount}` : a.amount}</strong>${a.hits > 1 || a.luck ? ` <span style="opacity:0.7">(${[a.hits > 1 ? `×${a.hits}` : "", a.luck ? "Luck Dice on one" : ""].filter(Boolean).join(", ")})</span>` : ""}${a.saved ? ` <span style="opacity:0.7">(saved)</span>` : ""}${a.reactions?.length ? ` <span style="opacity:0.7">(${a.reactions.map(escapeHTML).join(", ")})</span>` : ""}</span>${
      perTarget && undoable(a) ? undoButton(`Give back ${a.name}'s HP / temp HP only. ${UNDO_NOTE}`, { index: i }) : ""}</span>`);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <section class="icon-row lda-applied-damage" style="display:flex;align-items:flex-start;gap:6px;margin:2px 0">
      <i class="fa-fw fa-solid fa-heart-crack" aria-label="Damage applied" style="margin-top:2px;opacity:0.8"></i>
      <div style="flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px">
        <strong>Applied${undoneLabel(applied)}</strong>${parts.join("")}
        ${canUndo ? undoButton(`Give back ${perTarget ? "every target's" : "this"} HP / temp HP. ${UNDO_NOTE}`, { label: perTarget ? "Undo All" : "Undo" }) : ""}
      </div>
    </section>`.trim();
  return wrapper.firstElementChild;
}
