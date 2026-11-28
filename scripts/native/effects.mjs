// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Effect automation: applying an activity's effects to the targets it hit or that failed their save.

import { isPrivateGMCard, playerTargets, recordOutcome, outcomeTitle } from "./outcome.mjs";
import { doubledDuration, METAMAGIC_FLAG } from "./metamagic.mjs";
import { rulesOf } from "./advantage.mjs";
import { auraOfCourage } from "./features.mjs";
import { MODULE_ID, getPrivateRollOutcome, isEffectAutomationEnabled, isSaveRulesEnabled, socket, getPrimaryGM, resolveTarget, APPLIED_EFFECTS_FLAG, antimagicStops, isLike, STOCK_EFFECTS } from "./shared.mjs";

// ── Effect automation ─────────────────────────────────────────────────────────
// The "effectAutomation" setting: an activity's effects (the ones listed on its
// usage card, e.g. Hold Person's Paralyzed) go to the targets an attack hits, and
// to the targets that fail its save — plus, for effects marked "apply on a
// successful save", those who pass. They're applied through dnd5e's own effects
// tray code, so they carry the same origin, spell scaling and concentration link
// as a click on the tray: an effect tied to concentration ends with it, and a
// repeat re-enables the existing copy instead of stacking a second one. An effect
// that only applies conditions the target is immune to is skipped (noted "immune").
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
export function applyActivityEffects(payload) {
  // One at a time: two requests for the same effect on the same creature (a reaction's own, and the one for a
  // use with no roll) must not both find it missing and create it twice — the second re-enables the first's.
  const run = applying.then(() => applyEffectsNow(payload));
  applying = run.catch(err => console.error(`[${MODULE_ID}] applyActivityEffects:`, err));
  return run;
}
let applying = Promise.resolve();

async function applyEffectsNow({ usageId, targets }) {
  const usage = game.messages.get(usageId);
  if (!usage?.system?.getEffects) return;
  const tray = document.createElement("effect-application");
  if (typeof tray._applyEffectToActor !== "function") {
    console.error(`[${MODULE_ID}] applyActivityEffects: dnd5e's effect-application element is unavailable`);
    return;
  }
  tray.chatMessage = usage;
  const effects = await usage.system.getEffects();
  // Extended Spell (metamagic.mjs): the spell's effects last twice as long.
  const extended = usage.getFlag?.(MODULE_ID, METAMAGIC_FLAG)?.name === "Extended Spell";
  const source = usage.getAssociatedItem?.() ?? usage.getAssociatedActivity?.()?.item ?? null;

  const applied = [];
  for (const target of targets ?? []) {
    const { actor } = await resolveTarget(target);
    if (!actor) continue;
    const names = [];
    const undo  = [];
    const immunities = actor.system?.traits?.ci?.value;
    // Antimagic (dnd5e 6.1+): a spell's or Magical feature's effects don't reach this creature.
    const shielded = antimagicStops(actor, source);
    for (const effect of effects.filter(e => target.effectIds?.includes(e.id))) {
      if (shielded) {
        names.push(`${effect.name} (antimagic)`);
        continue;
      }
      // Conditions the creature is immune to (dnd5e would ignore them, but still show the effect).
      const statuses = [...(effect.statuses ?? [])];
      if (statuses.length && statuses.every(s => immunities?.has?.(s))) {
        names.push(`${effect.name} (immune)`);
        continue;
      }
      // Aura of Courage (features.mjs): no Frightened for the paladin and its allies in the aura.
      if (statuses.length && statuses.every(s => s === "frightened") && isSaveRulesEnabled()
        && auraOfCourage(actor, (await resolveTarget(target)).tokenDoc)) {
        names.push(`${effect.name} (Aura of Courage)`);
        continue;
      }
      try {
        // dnd5e re-enables an existing copy instead of creating a second one, so
        // note which it was: Undo deletes a created copy, re-disables an enabled one.
        const existing = actor.effects.find(e =>
          e._stats?.duplicateSource === effect.uuid || e._stats?.compendiumSource === effect.uuid);
        const wasDisabled = !!existing?.disabled;
        const result = await tray._applyEffectToActor(effect, actor);
        const longer = extended ? doubledDuration(result?.duration) : null;
        if (longer) await result.update?.({ duration: longer });
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

// ── Uses with no roll ─────────────────────────────────────────────────────────
// Mage Armor, Bless, Haste, Rage, a potion: nothing is rolled against anyone, so there's no hit or failed save
// to hang the effect on — dnd5e leaves it in the usage card's effects tray. With the setting, it's applied when
// the activity is used:
//   • to the user alone, when the activity only affects its user (range Self, no area: Shield, Rage);
//   • otherwise to the creatures targeted;
//   • with nobody targeted, to the user when the range is Self or Touch (Mage Armor on yourself) — and to no one
//     for anything with a longer reach (an untargeted Hex doesn't curse its caster).
// Only when the activity lists exactly one effect: several are a choice (Enhance Ability's, Enlarge or Reduce),
// which stays with the tray. A reaction is only placed on its own user (Shield). Attacks and saves apply theirs on a hit or a failed save, above and below.

const NO_ROLL_TYPES = ["utility", "heal", "damage"];
// Used by the module elsewhere, each with its own way of placing the effect.
const OWN_HANDLING = new Set(["bardic-inspiration", "guidance", "resistance", "brutal-strike"]);

/** Who a no-roll activity's effect goes to: "self", "targets", "targets-or-self" — or null when it isn't the module's to place. */
export function useEffectAudience(activity) {
  if (!activity || !NO_ROLL_TYPES.some(type => isLike(activity, type))) return null;
  if (OWN_HANDLING.has(activity.item?.system?.identifier)) return null;
  const range = activity.range?.units ?? "";
  const affects = activity.target?.affects?.type ?? "";
  const area = !!activity.target?.template?.type;
  if (affects === "self" || (range === "self" && !area && !affects)) return "self";
  // A reaction at someone else (Silvery Barbs, Cutting Words) is placed by the reaction prompts, or by hand.
  if (activity.activation?.type === "reaction") return null;
  return ["self", "touch"].includes(range) && !area ? "targets-or-self" : "targets";
}

/** dnd5e.postUseActivity (the user's client): an activity with no attack or save puts its one effect on its creatures. */
export async function applyUseEffects(activity, results) {
  if (!isEffectAutomationEnabled() || !activity?.actor?.isOwner) return;
  const audience = useEffectAudience(activity);
  const usage = results?.message;
  if (!audience || typeof usage?.system?.getEffects !== "function") return;
  const effects = ((await usage.system.getEffects()) ?? []).filter(e => e?.type !== "enchantment");
  if (effects.length !== 1) return;
  // dnd5e's stock Disengaged: the module gives its own status for it (opportunity.mjs).
  if (String(effects[0].uuid ?? "").endsWith(`.ActiveEffect.${STOCK_EFFECTS.disengaged}`)) return;
  const doc = (token) => token?.document ?? token;
  const me = doc(activity.getUsageToken?.() ?? activity.actor.token ?? activity.actor.getActiveTokens?.()?.[0]) ?? null;
  const self = { actor: activity.actor.uuid, token: me?.uuid ?? null, name: me?.name ?? activity.actor.name };
  const targeted = [...(game.user?.targets ?? [])].map(doc).filter(t => t?.actor)
    .map(t => ({ actor: t.actor.uuid, token: t.uuid, name: t.name }));
  const list = audience === "self" ? [self] : targeted.length ? targeted : audience === "targets-or-self" ? [self] : [];
  if (!list.length) return;
  await requestApplyEffects(usage, list.map(t => ({ ...t, effectIds: [effects[0].id] })));
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
 * Whether a save activity's effect goes to a creature that passed (or failed) its save: on a failure every
 * effect, on a success the ones marked "apply on a successful save". 2024 Stunning Strike (monk.mjs): Stunned
 * on a failure, the rest (Slowed) on a success — dnd5e's data marks both for a failure.
 */
export function saveEffectApplies(activity, effect, passed) {
  if (activity?.item?.system?.identifier === "stunning-strike" && rulesOf(activity.item) !== "2014") {
    return effect.statuses?.has?.("stunned") ? !passed : passed;
  }
  return !passed || (activity?.effects ?? []).some(profile => profile.onSave && profile._id === effect.id);
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
  const list = targets.map(target => {
    const result = outcome.get(target.token);
    if (!result) return null;
    const effectIds = effects.filter(e => saveEffectApplies(activity, e, !!result.passed)).map(e => e.id);
    return effectIds.length ? { ...target, effectIds } : null;
  }).filter(Boolean);
  await requestApplyEffects(usage, list);
}
