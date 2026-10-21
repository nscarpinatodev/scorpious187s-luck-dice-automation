// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Auto-rolled concentration checks.
//
// When a concentrating creature takes damage, dnd5e (Actor5e#challengeConcentration)
// only posts a prompt card — whispered to the creature's owners — with a
// Concentration button carrying the DC. The "concentrationAutoRoll" setting rolls
// it instead: on the creature's active player owner's client, so they get their
// Luck Dice; otherwise on the primary GM's. Every client that receives the card
// works out the same roller, so it's rolled once without any messaging. The roll
// then goes through the usual concentration flow (Luck Dice, breaking it on a
// failure), and the prompt card is removed — by the roller when they may delete
// it, otherwise by the primary GM.

import { MODULE_ID, debug, isConcentrationAutoRollEnabled, socket, getPrimaryGM, activePlayerOwner, NO_DIALOG } from "./shared.mjs";

// Prompt cards already handled on this client, by id.
const handledPrompts = new Set();

/** A dnd5e concentration prompt card's button — { dc, ability } — or null for any other card. */
export function concentrationButton(message) {
  if (message?.type !== "prompt") return null;
  const button = (message.system?.buttons ?? []).find(b => b?.type === "concentration");
  if (!button) return null;
  const dc = Number(button.dc);
  return { dc: Number.isFinite(dc) && dc > 0 ? dc : 10, ability: button.ability ?? null };
}

/** The user who rolls a creature's concentration check: its active player owner, else the primary GM. */
export function concentrationRoller(actor) {
  return activePlayerOwner(actor) ?? getPrimaryGM() ?? game.users.activeGM ?? null;
}

/** createChatMessage — roll a concentration prompt's check if this client is its roller. */
export async function onConcentrationPrompt(message) {
  const button = concentrationButton(message);
  if (!button || !isConcentrationAutoRollEnabled() || handledPrompts.has(message.id)) return;
  if (game.settings.get("dnd5e", "disableConcentration")) return;
  const actor = message.speakerActor ?? ChatMessage.getSpeakerActor?.(message.speaker);
  if (!actor || concentrationRoller(actor)?.id !== game.user.id) return;
  if (!(actor.concentration?.effects?.size > 0)) return; // ended since the card was posted
  handledPrompts.add(message.id);

  debug(`concentration: auto-rolling ${actor.name}'s check, DC ${button.dc}`);
  const config = { target: button.dc, ...NO_DIALOG };
  if (button.ability) config.ability = button.ability;
  const rolls = await actor.rollConcentration(config, { configure: false });
  if (!rolls?.length) { handledPrompts.delete(message.id); return; } // cancelled: leave the button

  await removePrompt(message);
  console.log(`[${MODULE_ID}] concentration: rolled ${actor.name}'s check (${rolls[0].total} vs DC ${button.dc})`);
}

/** Delete the prompt card, asking the primary GM when this user may not. */
async function removePrompt(message) {
  if (!game.messages.get(message.id)) return;
  if (message.canUserModify?.(game.user, "delete")) return message.delete();
  socket?.emit("deleteConcentrationPrompt", { messageId: message.id });
}

/** GM side: delete a concentration prompt card a player rolled from. Only concentration prompts. */
export async function deleteConcentrationPrompt({ messageId }) {
  const message = game.messages.get(messageId);
  if (concentrationButton(message)) await message.delete();
}
