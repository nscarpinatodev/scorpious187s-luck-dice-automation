// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// A start-of-turn summary.
//
// The "turnSummary" setting: when a creature's turn starts in combat, its owners
// (and the GM) get a whispered note of what's going on with it: effects on it and
// how long they last, what it's concentrating on, saves it repeats at the end of
// the turn, lingering areas it's standing in, death saves while dying, and for NPCs
// their legendary actions and resistances. Posted by the primary GM's client;
// nothing is posted for a creature with nothing to report.

import { REPEAT_FLAG } from "./repeat-saves.mjs";
import { LINGERING_FLAG, isTriggerClient } from "./lingering.mjs";
import { MODULE_ID, escapeHTML, isTurnSummaryEnabled } from "./shared.mjs";

/** The lines for a creature's summary (empty when there's nothing to say). */
export function summaryLines(tokenDoc) {
  const actor = tokenDoc?.actor;
  if (!actor) return [];
  const lines = [];
  const effects = [...(actor.effects ?? [])].filter(e => !e.disabled && !e.isSuppressed && !e.transfer
    && e.system?.type !== "concentrating" && !e.statuses?.has?.("concentrating"));
  if (effects.length) {
    lines.push(`<strong>Effects:</strong> ${effects.map(e => {
      const left = e.duration?.label ?? (Number.isFinite(e.duration?.remaining) ? `${e.duration.remaining} left` : "");
      return `${escapeHTML(e.name)}${left ? ` <span style="opacity:0.7">(${escapeHTML(left)})</span>` : ""}`;
    }).join(" · ")}`);
  }
  const concentration = [...(actor.concentration?.effects ?? [])];
  if (concentration.length) lines.push(`<strong>Concentrating:</strong> ${concentration.map(e => escapeHTML(e.name.replace(/^Concentrating:?\s*/i, ""))).join(", ")}`);
  const repeats = [...(actor.effects ?? [])].filter(e => !e.disabled && e.getFlag?.(MODULE_ID, REPEAT_FLAG));
  if (repeats.length) {
    lines.push(`<strong>End of turn:</strong> ${repeats.map(e => { const d = e.getFlag(MODULE_ID, REPEAT_FLAG); return `${escapeHTML(d.name)} — ${escapeHTML(d.ability.toUpperCase())} save DC ${d.dc}`; }).join("; ")}`);
  }
  const areas = [...(tokenDoc.parent?.regions ?? [])].filter(r => r.getFlag?.(MODULE_ID, LINGERING_FLAG) && (() => {
    try { return tokenDoc.testInsideRegion(r); } catch { return false; }
  })());
  if (areas.length) lines.push(`<strong>Standing in:</strong> ${areas.map(r => escapeHTML(r.name ?? "an area")).join(", ")}`);
  const death = actor.system?.attributes?.death;
  if (actor.type === "character" && death && Number(actor.system.attributes.hp?.value ?? 1) <= 0 && !actor.statuses?.has?.("dead")) {
    lines.push(`<strong>Dying:</strong> ${death.success ?? 0} success(es), ${death.failure ?? 0} failure(s)`);
  }
  const { legact, legres } = actor.system?.resources ?? {};
  if (legact?.max) lines.push(`<strong>Legendary actions:</strong> ${legact.value ?? 0} of ${legact.max}`);
  if (legres?.max) lines.push(`<strong>Legendary resistance:</strong> ${legres.value ?? 0} of ${legres.max}`);
  return lines;
}

/** combatTurnChange (primary GM): whisper the summary for the creature whose turn starts. */
export async function onTurnStartSummary(combat, current) {
  if (!isTurnSummaryEnabled() || !isTriggerClient() || !combat?.started || !current?.tokenId) return;
  const tokenDoc = (combat.scene ?? canvas.scene)?.tokens?.get?.(current.tokenId);
  const lines = summaryLines(tokenDoc);
  if (!lines.length) return;
  const whisper = game.users.filter(u => u.isGM || tokenDoc.actor.testUserPermission(u, "OWNER")).map(u => u.id);
  await ChatMessage.implementation.create({
    speaker: ChatMessage.getSpeaker({ token: tokenDoc, actor: tokenDoc.actor }),
    whisper,
    content: `<div class="lda-turn-summary"><p style="margin:0 0 4px"><strong>${escapeHTML(tokenDoc.name)}'s turn</strong></p>${lines.map(l => `<p style="margin:2px 0">${l}</p>`).join("")}</div>`
  });
}
