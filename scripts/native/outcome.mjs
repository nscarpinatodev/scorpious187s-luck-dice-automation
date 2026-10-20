// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// The GM's private rolls: the public outcome card, or sharing the cards with targeted players.

import { MODULE_ID, getPrivateRollOutcome, escapeHTML } from "./shared.mjs";

// ── The GM's private rolls ────────────────────────────────────────────────────
// The "privateRollOutcome" setting, for GM rolls made privately (whispered or
// blind) that affect player characters:
//   outcome: one public card per use with just the outcome for those characters
//            — hit / miss, saved / failed, damage taken — added to as the use
//            resolves; never the NPC's totals, bonuses or DCs;
//   share:   the GM's attack and damage cards are also whispered to the owners
//            of the player characters they target;
//   private: nothing.

export const OUTCOME_FLAG = "outcome";
// Outcome cards this GM client created, by use (the usage card's id).
export const outcomeCards = new Map();

/** A GM's card that players can't see (whispered or blind). */
export function isPrivateGMCard(message) {
  return !!message?.author?.isGM && ((message.whisper?.length ?? 0) > 0 || !!message.blind);
}

/** The use a card belongs to: its usage card (every activity roll links to it). */
export function useKey(message) {
  return message.rolls?.[0]?.options?.originatingMessage ?? message.id;
}

/** Card target descriptors whose actors belong to players, with those players' ids. */
export function playerTargets(descriptors) {
  return (descriptors ?? []).map(t => {
    let actor = null;
    try { actor = fromUuidSync(t.token)?.actor ?? fromUuidSync(t.actor); } catch {}
    const owners = game.users.filter(u => !u.isGM && actor?.testUserPermission(u, "OWNER")).map(u => u.id);
    return owners.length ? { ...t, owners } : null;
  }).filter(Boolean);
}

/** Share mode: also whisper a private GM card to the owners of the player characters it targets. */
export async function shareWithTargets(message, descriptors) {
  const owners = playerTargets(descriptors).flatMap(t => t.owners);
  const whisper = [...new Set([...(message.whisper ?? []), ...owners])];
  if (whisper.length === (message.whisper?.length ?? 0) && !message.blind) return;
  await message.update({ whisper, blind: false });
}

/** Outcome card markup: one line per player character. */
export function renderOutcome({ title, rows }) {
  const result = (r) => [
    r.hit === true    ? `<strong style="color:#719f50">HIT</strong>` : "",
    r.hit === false   ? `<strong style="color:#c0392b">MISS</strong>` : "",
    r.saved === true  ? `<strong style="color:#719f50">saved</strong>` : "",
    r.saved === false ? `<strong style="color:#c0392b">failed</strong>` : "",
    Number.isFinite(r.damage) ? (r.damage < 0 ? `healed ${-r.damage}` : `${r.damage} damage`) : "",
    r.effects?.length ? escapeHTML(r.effects.join(", ")) : ""
  ].filter(Boolean).join(" · ");
  return `
    <div class="lda-outcome">
      <p style="margin:0 0 4px"><strong>${escapeHTML(title)}</strong></p>
      ${rows.map(r => `
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span>${escapeHTML(r.name)}</span><span>${result(r)}</span>
        </div>`).join("")}
    </div>`;
}

/**
 * Outcome mode: add or update player characters' rows on the public outcome
 * card for a use, creating it the first time. rows: [{ token, name, hit?,
 * saved?, damage? }]. Created without a message mode, so it's public however
 * the GM's own rolls are set.
 */
export async function recordOutcome(key, { actor, title }, rows) {
  if (!rows.length) return;
  const existing = game.messages.get(outcomeCards.get(key));
  const data = foundry.utils.deepClone(existing?.getFlag(MODULE_ID, OUTCOME_FLAG) ?? { title, rows: [] });
  for (const row of rows) {
    const current = data.rows.find(r => r.token === row.token);
    if (current) Object.assign(current, row);
    else data.rows.push(row);
  }
  const content = renderOutcome(data);
  if (existing) {
    await existing.update({ content, [`flags.${MODULE_ID}.${OUTCOME_FLAG}`]: data });
    return;
  }
  const created = await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags:   { [MODULE_ID]: { [OUTCOME_FLAG]: data } }
  });
  if (created) outcomeCards.set(key, created.id);
}

/** "Goblin — Scimitar" for an activity's outcome card. */
export function outcomeTitle(activity, message) {
  const actorName = activity?.actor?.name ?? message?.speaker?.alias ?? "";
  const itemName  = activity?.item?.name ?? activity?.name ?? "";
  return [actorName, itemName].filter(Boolean).join(" — ");
}

/** A GM's private attack card: outcome rows (hit / miss) or sharing, per the setting. */
export async function handlePrivateAttack(message, activity) {
  if (!isPrivateGMCard(message)) return;
  const mode = getPrivateRollOutcome();
  if (mode === "share") return shareWithTargets(message, message.system?.targets);
  if (mode !== "outcome") return;
  const rows = playerTargets(message.system?.evaluatedTargets).map(t => ({ token: t.token, name: t.name, hit: !t.isMiss }));
  await recordOutcome(useKey(message), { actor: activity?.actor, title: outcomeTitle(activity, message) }, rows);
}
