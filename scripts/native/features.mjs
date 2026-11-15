// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Smaller class features and spells on damage and on use.
//
//   Empowered Evocation (Wizard, Evoker; "attackAdvantage") — a wizard Evocation spell's first damage roll after
//       it's cast adds the Intelligence modifier (one damage roll of that spell).
//   Toll the Dead ("attackAdvantage") — whichever of its two activities was used, the damage is d12s when every
//       target is missing Hit Points, d8s otherwise.
//   Brutal Strike (Barbarian; "attackAdvantage") — using one of its options at a creature puts the option's effect
//       on it (Hamstrung, Staggered, Sundered); Forceful Blow pushes it 15 ft away. Sundered: the next attack roll
//       against it by another creature gets +5 (advantage.mjs reads sunderedFor), and is used up.
//   Arcane Ward (Wizard, Abjurer; "deathSaves") — once created (its "Create Ward" activity used, or the first
//       Abjuration spell cast with a slot), damage to the wizard goes to the ward's Hit Points (the feature's uses)
//       first; an Abjuration spell cast with a slot restores twice its level.

import { applyMasteryChange, pushDestination } from "./mastery.mjs";
import { requestApplyEffects } from "./effects.mjs";
import { effectsFrom, sourceActor, tokenDistance } from "./advantage.mjs";
import { MODULE_ID, debug, isAttackAdvantageEnabled, isDeathSavesEnabled, isLike } from "./shared.mjs";

const feature = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;
const activitiesOf = (item) => [...(item?.system?.activities?.values?.() ?? [])];
const doc = (token) => token?.document ?? token ?? null;
const castLevel = (item, usageConfig) => (Number(item?.system?.level) || 0) + (Number(usageConfig?.scaling) || 0);

// ── Empowered Evocation ───────────────────────────────────────────────────────

// Evocation spells just cast by an empowered wizard, by item uuid: their next damage roll gets the modifier.
const empowered = new Set();

// A wizard spell: its class is Wizard, or — with none recorded — its caster has Wizard levels.
const isWizardEvocation = (item, actor) => item?.type === "spell" && item.system?.school === "evo"
  && (item.system?.sourceClass ? item.system.sourceClass === "wizard" : !!actor?.classes?.wizard);

/** Toll the Dead: d12s against a creature missing Hit Points. */
const missingHP = (actor) => {
  const hp = actor?.system?.attributes?.hp;
  const max = Number(hp?.effectiveMax ?? hp?.max);
  return Number.isFinite(max) && Number(hp?.value ?? max) < max;
};

/** dnd5e.preRollDamageV2 — Empowered Evocation's modifier; Toll the Dead's die size. Never cancels. */
export function onPreRollDamageFeatures(config) {
  if (!isAttackAdvantageEnabled()) return;
  const activity = config?.subject, item = activity?.item, actor = activity?.actor;
  const base = config?.rolls?.find(r => r?.base) ?? config?.rolls?.[0];
  if (!item || !base) return;
  if (item.system?.identifier === "toll-the-dead") {
    const targets = [...(game.user?.targets ?? [])].map(t => doc(t)?.actor).filter(Boolean);
    if (targets.length) {
      const [from, to] = targets.every(missingHP) ? [8, 12] : [12, 8];
      base.parts = (base.parts ?? []).map(p => String(p).replace(new RegExp(`(\\d*)d${from}\\b`, "g"), `$1d${to}`));
    }
  }
  if (empowered.has(item.uuid) && feature(actor, "empowered-evocation")) {
    empowered.delete(item.uuid);
    const mod = Number(actor.system?.abilities?.int?.mod ?? 0) || 0;
    if (mod) (base.parts ??= []).push(String(mod));
    debug(`empowered evocation: ${item.name} +${mod}`);
  }
}

// ── Brutal Strike ─────────────────────────────────────────────────────────────

/** Sundering Blow's effect on a creature, from a barbarian other than this attacker (its +5), or null. */
export function sunderedFor(targetActor, attacker) {
  return effectsFrom(targetActor, "brutal-strike").find(e => /sunder/i.test(e.name ?? "")
    && (sourceActor(e)?.uuid ?? null) !== attacker?.uuid) ?? null;
}

// ── Aura of Courage ───────────────────────────────────────────────────────────

const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];

/**
 * Aura of Courage (Paladin 10; "saveRules"): the paladin and its allies in its Aura of Protection (10 ft; 30 ft
 * with Aura Expansion or from 18th level) can't be Frightened — no Frightened effect is applied to them (effects.mjs),
 * and a Frightened attacker there has no disadvantage (advantage.mjs). Resolves with the paladin's name, or null.
 */
export function auraOfCourage(actor, tokenDoc) {
  const me = doc(tokenDoc ?? actor?.getActiveTokens?.()?.[0]);
  if (!me?.parent) return null;
  for (const token of me.parent.tokens ?? []) {
    const paladin = token.actor;
    if (!feature(paladin, "aura-of-courage") || INCAPACITATING.some(s => paladin.statuses?.has?.(s))) continue;
    if (token.id === me.id) return token.name;
    if (!token.disposition || token.disposition !== me.disposition) continue;
    const range = feature(paladin, "aura-expansion") || Number(paladin.classes?.paladin?.system?.levels ?? 0) >= 18 ? 30 : 10;
    if (tokenDistance(token, me) <= range) return token.name;
  }
  return null;
}

// ── On use ────────────────────────────────────────────────────────────────────

/**
 * dnd5e.postUseActivity (the user's client): an empowered wizard's Evocation spell; a Brutal Strike option at a
 * creature; an Abjuration spell creating or restoring an Arcane Ward.
 */
export async function onFeatureUsed(activity, usageConfig, results) {
  const item = activity?.item, actor = activity?.actor;
  if (!item || !actor?.isOwner) return;
  if (isAttackAdvantageEnabled() && isWizardEvocation(item, actor) && feature(actor, "empowered-evocation")) empowered.add(item.uuid);

  // Brutal Strike: the option's effect on the creature (as dnd5e's effects tray would), and Forceful Blow's push.
  if (isAttackAdvantageEnabled() && item.system?.identifier === "brutal-strike" && /forceful|hamstring|stagger|sunder/i.test(activity.name ?? "")) {
    const me = doc(activity.getUsageToken?.() ?? actor.getActiveTokens?.()?.[0]);
    const targets = [...(game.user?.targets ?? [])].map(doc).filter(t => t?.actor && t.id !== me?.id);
    const usage = results?.message;
    const effectIds = usage ? ((await usage.system?.getEffects?.()) ?? []).map(e => e.id) : [];
    if (usage && targets.length && effectIds.length) {
      await requestApplyEffects(usage, targets.map(t => ({ actor: t.actor.uuid, token: t.uuid, name: t.name, effectIds })));
    }
    if (/forceful/i.test(activity.name ?? "") && me) {
      for (const t of targets) {
        const dest = pushDestination(me, t, 15);
        if (dest) await applyMasteryChange({ kind: "push", token: t.uuid, actor: t.actor.uuid, x: dest.x, y: dest.y });
      }
    }
  }

  // Arcane Ward: an Abjuration spell with a slot creates the ward (once a long rest) or restores 2 × its level.
  if (isDeathSavesEnabled() && item.type === "spell" && item.system?.school === "abj" && (Number(item.system?.level) || 0) > 0) {
    const ward = feature(actor, "arcane-ward");
    if (ward?.system?.uses?.max) {
      const create = activitiesOf(ward).find(a => /create/i.test(a.name ?? ""));
      const spent = Number(ward.system.uses.spent) || 0;
      if (create && !(Number(create.uses?.spent) > 0)) {
        await create.update?.({ "uses.spent": 1 }).catch(() => null);
        await ward.update({ "system.uses.spent": 0 });
        debug(`arcane ward: ${actor.name} creates the ward`);
      } else if (spent > 0) {
        await ward.update({ "system.uses.spent": Math.max(0, spent - 2 * castLevel(item, usageConfig)) });
      }
    }
  }
}

// ── Arcane Ward on damage ─────────────────────────────────────────────────────

/** The wizard's ward, if it's up: { item, hp }. */
export function arcaneWard(actor) {
  const item = feature(actor, "arcane-ward");
  if (!item?.system?.uses?.max) return null;
  const create = activitiesOf(item).find(a => /create/i.test(a.name ?? ""));
  if (create && !(Number(create.uses?.spent) > 0)) return null;           // not created since the last long rest
  const hp = Math.max(0, Number(item.system.uses.max) - (Number(item.system.uses.spent) || 0));
  return hp > 0 ? { item, hp } : null;
}

/**
 * dnd5e.preApplyDamage (synchronous; before the death saves read the update): the ward takes the damage first —
 * the HP update dnd5e is about to make is worked out again from what's left, and the ward's Hit Points go down.
 */
export function onPreApplyDamageWard(actor, amount, updates) {
  if (!isDeathSavesEnabled() || !(amount > 0) || !actor?.isOwner || !updates) return;
  const ward = arcaneWard(actor);
  if (!ward) return;
  const absorbed = Math.min(ward.hp, Math.round(amount));
  const hp = actor.system?.attributes?.hp ?? {};
  const temp0 = Number(hp.temp) || 0, value0 = Number(hp.value) || 0;
  let rest = Math.round(amount) - absorbed;
  const fromTemp = Math.min(temp0, rest);
  rest -= fromTemp;
  updates["system.attributes.hp.temp"] = temp0 - fromTemp;
  updates["system.attributes.hp.value"] = Math.max(0, value0 - rest);
  ward.item.update({ "system.uses.spent": (Number(ward.item.system.uses.spent) || 0) + absorbed }).catch(() => null);
  debug(`arcane ward: ${actor.name}'s ward takes ${absorbed} (${ward.hp - absorbed} left)`);
}
