// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Effect automation: applying an activity's effects to the targets it hit or that failed their save.

import { isPrivateGMCard, playerTargets, recordOutcome, outcomeTitle } from "./outcome.mjs";
import { MODULE_ID, getPrivateRollOutcome, isEffectAutomationEnabled, socket, getPrimaryGM, resolveTarget, APPLIED_EFFECTS_FLAG } from "./shared.mjs";

// ── Effect automation ─────────────────────────────────────────────────────────
// The "effectAutomation" setting: an activity's effects (the ones listed on its
// usage card, e.g. Hold Person's Paralyzed) go to the targets an attack hits, and
// to the targets that fail its save — plus, for effects marked "apply on a
// successful save", those who pass. They're applied through dnd5e's own effects
// tray code, so they carry the same origin, spell scaling and concentration link
// as a click on the tray: an effect tied to concentration ends with it, and a
// repeat re-enables the existing copy instead of stacking a second one.
// Changing other actors needs the GM: the primary GM's client applies them.

/** The usage card a roll card belongs to, if it lists effects. */
export function usageCardOf(message) {
  const usage = message?.getOriginatingMessage?.()
    ?? game.messages.get(message?.rolls?.[0]?.options?.originatingMessage);
  return (usage && usage !== message && typeof usage.system?.getEffects === "function") ? usage : null;
}

/** Apply effects from a usage card — directly as a GM, otherwise via the primary GM. */
export async function requestApplyEffects(usage, targets) {
  if (!usage || !targets.length) return;
  const payload = {
    usageId: usage.id,
    targets: targets.map(({ actor, token, name, effectIds }) => ({ actor, token, name, effectIds }))
  };
  if (game.user.isGM) return applyActivityEffects(payload);
  if (!socket || !getPrimaryGM()) {
    ui.notifications?.warn("Luck Dice Automation: no GM is connected, so effects weren't applied — use the card's effects tray.");
    return;
  }
  socket.emit("applyEffects", payload);
}

/**
 * GM side: apply a usage card's effects to targets (each target's effectIds) by
 * driving dnd5e's EffectApplicationElement — the effects tray's own
 * _applyEffectToActor, pointed at the usage card — and note what was applied on
 * the card (and on the outcome card, for the GM's private rolls).
 */
export async function applyActivityEffects({ usageId, targets }) {
  const usage = game.messages.get(usageId);
  if (!usage?.system?.getEffects) return;
  const tray = document.createElement("effect-application");
  if (typeof tray._applyEffectToActor !== "function") {
    console.error(`[${MODULE_ID}] applyActivityEffects: dnd5e's effect-application element is unavailable`);
    return;
  }
  tray.chatMessage = usage;
  const effects = await usage.system.getEffects();

  const applied = [];
  for (const target of targets ?? []) {
    const { actor } = await resolveTarget(target);
    if (!actor) continue;
    const names = [];
    const undo  = [];
    for (const effect of effects.filter(e => target.effectIds?.includes(e.id))) {
      try {
        // dnd5e re-enables an existing copy instead of creating a second one, so
        // note which it was: Undo deletes a created copy, re-disables an enabled one.
        const existing = actor.effects.find(e =>
          e._stats?.duplicateSource === effect.uuid || e._stats?.compendiumSource === effect.uuid);
        const wasDisabled = !!existing?.disabled;
        const result = await tray._applyEffectToActor(effect, actor);
        names.push(effect.name);
        if (!existing && result?.uuid) undo.push({ effect: result.uuid, action: "create" });
        else if (existing && wasDisabled) undo.push({ effect: existing.uuid, action: "enable" });
      } catch (err) {
        console.warn(`[${MODULE_ID}] applyActivityEffects: ${effect.name} → ${actor.name}:`, err);
      }
    }
    if (names.length) applied.push({ token: target.token, name: target.name ?? actor.name, effects: names, undo });
  }
  if (!applied.length) return;

  const record = foundry.utils.deepClone(usage.getFlag(MODULE_ID, APPLIED_EFFECTS_FLAG) ?? []);
  for (const entry of applied) {
    const current = record.find(r => r.token === entry.token);
    if (current) {
      current.effects = [...new Set([...current.effects, ...entry.effects])];
      current.undo = [...(current.undo ?? []), ...entry.undo];
      delete current.undone;
    }
    else record.push(entry);
  }
  await usage.setFlag(MODULE_ID, APPLIED_EFFECTS_FLAG, record);
  console.log(`[${MODULE_ID}] applyActivityEffects: ${applied.map(a => `${a.name}: ${a.effects.join(", ")}`).join("; ")}`);

  if (isPrivateGMCard(usage) && getPrivateRollOutcome() === "outcome") {
    const players = new Set(playerTargets(applied).map(t => t.token));
    const rows = applied.filter(a => players.has(a.token)).map(a => ({ token: a.token, name: a.name, effects: a.effects }));
    const activity = usage.getAssociatedActivity?.();
    await recordOutcome(usage.id, { actor: activity?.actor, title: outcomeTitle(activity, usage) }, rows);
  }
}

/** Attacks: every effect on the usage card goes to each target hit. */
export async function applyHitEffects(attackMessage, activity) {
  if (!isEffectAutomationEnabled()) return;
  const usage = usageCardOf(attackMessage);
  if (!usage) return;
  const effects = await usage.system.getEffects();
  if (!effects.length) return;
  const hits = (attackMessage.system?.evaluatedTargets ?? []).filter(t => !t.isMiss);
  await requestApplyEffects(usage, hits.map(t => ({
    actor: t.actor, token: t.token, name: t.name, effectIds: effects.map(e => e.id)
  })));
}

/**
 * Saves (Save Automation "Full", once every save is in): a failed save gets every
 * effect; a successful one only the effects the activity marks "apply on a
 * successful save". Targets without a save result get nothing.
 */
export async function applySaveEffects(activity, usage, targets, outcome) {
  if (!isEffectAutomationEnabled() || !usage?.system?.getEffects) return;
  const effects = await usage.system.getEffects();
  if (!effects.length) return;
  const onSave = new Set((activity.effects ?? []).filter(profile => profile.onSave).map(profile => profile._id));
  const list = targets.map(target => {
    const result = outcome.get(target.token);
    if (!result) return null;
    const effectIds = effects.filter(e => !result.passed || onSave.has(e.id)).map(e => e.id);
    return effectIds.length ? { ...target, effectIds } : null;
  }).filter(Boolean);
  await requestApplyEffects(usage, list);
}
