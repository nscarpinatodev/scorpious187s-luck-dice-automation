// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Eldritch Invocations (2014, Xanathar's, Tasha's, 2024), found by item identifier.
//
// The "invocations" setting.
//   Eldritch Blast — Agonizing Blast (+Charisma modifier to each beam's damage), Eldritch Spear
//     (range: 300 ft in 2014, +30 ft per Warlock level in 2024), Repelling Blast (push 10 ft;
//     2024: Large or smaller), Grasp of Hadar (pull 10 ft, once per turn), Lance of Lethargy
//     (−10 ft speed until the end of the warlock's next turn, once per turn). A 2024 invocation tied
//     to one cantrip goes to the cantrip its enchantment marks ("Make Repelling", Eldritch Spear's),
//     else to Eldritch Blast; Agonizing Blast, which marks nothing, to Eldritch Blast.
//   Pact weapon — Eldritch Smite and Lifedrinker (riders.mjs), Improved Pact Weapon (+1 to attack
//     and damage with a pact weapon that isn't magical). A pact weapon is one Pact of the Blade's
//     enchantment marks (2024), or named as one; the 2014 feature marks none, so its riders are
//     offered on any melee weapon of a warlock with it (Improved Pact Weapon needs the mark).
//   Elsewhere — Protection of the Talisman (boosts.mjs), Rebuke of the Talisman and Tomb of Levistus
//     (reactions.mjs), Gift of the Protectors, Cloak of Flies and Maddening Hex (here).
// What an invocation did on an attack is noted on the attack card.

import { requestApplyDamage } from "./apply.mjs";
import { sourceItem, sourceActor, rulesOf, tokenDistance, hasLineOfSight, conduitMultiplier } from "./advantage.mjs";
import { usesLeft, spendUses } from "./boosts.mjs";
import { isTriggerClient } from "./lingering.mjs";
import { applyMasteryChange, masteryEffect, pushDestination, pullDestination, attackerToken } from "./mastery.mjs";
import { askReaction } from "./reactions.mjs";
import { pickCreatures } from "./targeting.mjs";
import { MODULE_ID, debug, escapeHTML, promptChoice, isInvocationsEnabled, isLike } from "./shared.mjs";

export const INVOCATION_RESULT_FLAG = "invocationResult"; // on the attack card: what the invocations did

const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];
const LARGE_OR_SMALLER = new Set(["tiny", "sm", "med", "lg"]);
const incapacitated = (actor) => INCAPACITATING.some(s => actor?.statuses?.has?.(s));
const chaMod = (actor) => Number(actor?.system?.abilities?.cha?.mod ?? 0) || 0;
const isEldritchBlast = (item) => item?.system?.identifier === "eldritch-blast";

/** The creature's invocation (or any feature) with this identifier. */
export const feature = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;
/** Whether a limited-use invocation can be used: uses left, or no limit recorded on it. */
const available = (item) => !!item && (!item.system?.uses?.max || usesLeft(item) > 0);
const spendIfLimited = async (item) => { if (item?.system?.uses?.max) await spendUses(item, 1); };

// ── Which cantrip, which weapon ───────────────────────────────────────────────

/** The identifier of the item an enchantment came from (its origin is the enchanting activity). */
function enchantmentSource(effect) {
  const itemUuid = String(effect?.origin ?? "").split(".Activity.")[0];
  if (!itemUuid.includes("Item.")) return null;
  try { return fromUuidSync(itemUuid, { strict: false })?.system?.identifier ?? null; } catch { return null; }
}

/** Whether an item carries an invocation's enchantment — by its source, or the name it appends. */
export function enchantedBy(item, identifier, nameTag = null) {
  const byEffect = [...(item?.effects ?? [])].some(e => e.type === "enchantment" && !e.disabled
    && (enchantmentSource(e) === identifier || (nameTag && String(e.name ?? "").includes(nameTag))));
  return byEffect || (!!nameTag && String(item?.name ?? "").includes(nameTag));
}

/**
 * Whether an invocation tied to one cantrip applies to this one: the cantrip its enchantment marks,
 * else Eldritch Blast (2014's rule; with no marked cantrip, the usual 2024 choice).
 */
export function invocationApplies(actor, item, identifier, nameTag = null) {
  if (!isInvocationsEnabled() || item?.type !== "spell" || !feature(actor, identifier)) return false;
  if (nameTag && enchantedBy(item, identifier, nameTag)) return true;
  if (!isEldritchBlast(item)) return false;
  return !nameTag || ![...(actor.items ?? [])].some(i => i !== item && i.type === "spell" && enchantedBy(i, identifier, nameTag));
}

/**
 * Whether an attack is with the warlock's pact weapon. `strict`: only a weapon marked as one (Pact
 * of the Blade's enchantment or its name); otherwise also any melee weapon of a 2014 Pact of the
 * Blade warlock, whose feature marks none — for invocations that are offered, not applied.
 */
export function isPactWeapon(activity, { strict = false } = {}) {
  const item = activity?.item, actor = activity?.actor;
  if (!item || !actor) return false;
  if (item.system?.identifier === "pact-of-the-blade") return true; // its own attack
  if (item.type !== "weapon") return false;
  if (enchantedBy(item, "pact-of-the-blade", "Pact Weapon") || /\bpact\b/i.test(item.name ?? "")) return true;
  return !strict && !!feature(actor, "pact-of-the-blade") && activity.attack?.type?.value === "melee";
}

const isMagical = (item) => !!item?.system?.properties?.has?.("mgc") || (Number(item?.system?.magicalBonus) || 0) > 0;
const improvedPactWeapon = (activity) => isInvocationsEnabled() && isLike(activity, "attack") && isPactWeapon(activity, { strict: true })
  && !!feature(activity.actor, "improved-pact-weapon") && !isMagical(activity.item);

// ── Once per turn ─────────────────────────────────────────────────────────────

const usedThisTurn = new Map();
const turnKey = () => game.combat?.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : null;
const usableThisTurn = (actor, key) => !turnKey() || usedThisTurn.get(`${actor.uuid}:${key}`) !== turnKey();
const markUsed = (actor, key) => { if (turnKey()) usedThisTurn.set(`${actor.uuid}:${key}`, turnKey()); };

// ── Rolls ─────────────────────────────────────────────────────────────────────

/** dnd5e.preRollAttackV2 — Improved Pact Weapon: +1 to the attack. Never cancels. */
export function onPreRollAttackInvocations(config) {
  if (!improvedPactWeapon(config?.subject)) return;
  const first = config.rolls?.[0];
  if (first) (first.parts ??= []).push("1");
}

/** dnd5e.preRollDamageV2 — Agonizing Blast (+Charisma modifier), Improved Pact Weapon (+1). Never cancels. */
export function onPreRollDamageInvocations(config) {
  if (!isInvocationsEnabled()) return;
  const activity = config?.subject, actor = activity?.actor;
  const base = config?.rolls?.find(r => r?.base) ?? config?.rolls?.[0];
  if (!actor || !base) return;
  const parts = (base.parts ??= []);
  // The PHB's enchantment adds "@abilities.cha.mod" to the cantrip it marks (dnd5e's damage bonus), so
  // that one's left alone; with it on another cantrip, Eldritch Blast gets nothing.
  if (invocationApplies(actor, activity.item, "agonizing-blast", "Agonizing") && !parts.some(p => /abilities\.cha\.mod|@mod\b/.test(String(p)))) {
    parts.push("@abilities.cha.mod");
    debug(`agonizing blast: ${actor.name}'s ${activity.item.name} adds the Charisma modifier`);
  }
  if (improvedPactWeapon(activity)) parts.push("1");
}

/**
 * Eldritch Spear's range for this Eldritch Blast, when dnd5e's own enchantment hasn't changed it:
 * 300 ft (2014), or 30 ft per Warlock level more (2024) — multiplied, like the rest of the range, when
 * it's cast through a spell conduit (Kilian's Eldritch Rifle). Null when it doesn't apply.
 */
export function eldritchSpearRange(activity) {
  const actor = activity?.actor, item = activity?.item;
  const spear = isInvocationsEnabled() ? feature(actor, "eldritch-spear") : null;
  if (!spear || !isLike(activity, "attack") || !isEldritchBlast(item) || enchantedBy(item, "eldritch-spear", "Eldritch Spear")) return null;
  const range = activity.range ?? {};
  const mult = conduitMultiplier(item);
  if (rulesOf(spear) === "2014") return { value: 300 * mult, units: "ft" };
  const levels = Number(actor.classes?.warlock?.system?.levels ?? 0) || 0;
  const value = Number(range.value);
  return levels && Number.isFinite(value) && value / mult >= 10 ? { value: value + 30 * levels * mult, units: range.units ?? "ft" } : null;
}

// ── On a hit with the cantrip ─────────────────────────────────────────────────

/**
 * After a spell attack (the caster's client): Lance of Lethargy, then Repelling Blast's push or
 * Grasp of Hadar's pull, for each creature it hit — noted on the attack card.
 */
export async function applyInvocationsOnHit(message, activity) {
  if (!isInvocationsEnabled() || !message?.system || message.getFlag?.(MODULE_ID, INVOCATION_RESULT_FLAG)) return;
  const actor = activity?.actor, item = activity?.item;
  if (!actor || item?.type !== "spell") return;
  const hits = (message.system.evaluatedTargets ?? []).filter(t => !t.isMiss);
  if (!hits.length) return;
  const casterDoc = attackerToken(activity, message);
  const repelling = invocationApplies(actor, item, "repelling-blast", "Repelling") ? feature(actor, "repelling-blast") : null;
  let grasp = isEldritchBlast(item) && feature(actor, "grasp-of-hadar") && usableThisTurn(actor, "grasp-of-hadar");
  let lance = isEldritchBlast(item) && feature(actor, "lance-of-lethargy") && usableThisTurn(actor, "lance-of-lethargy");
  const done = [];
  for (const hit of hits) {
    const targetDoc = hit.token ? await fromUuid(hit.token) : null;
    if (!targetDoc?.actor) continue;
    if (lance) {
      const already = [...(targetDoc.actor.effects ?? [])].some(e => e.getFlag?.(MODULE_ID, "mastery")?.kind === "lethargy");
      if (!already) {
        const effect = masteryEffect("lethargy", actor, hit.token, {
          name: "Lance of Lethargy", img: "icons/svg/clockwork.svg", expiry: "sourceEnd", magical: true,
          changes: [{ key: "system.attributes.movement.speeds.walk", type: "add", value: -10 }]
        });
        await applyMasteryChange({ kind: "lethargy", token: hit.token, actor: hit.actor, effect });
        done.push(`${hit.name}'s speed −10 ft (Lance of Lethargy)`);
      }
      markUsed(actor, "lance-of-lethargy");
      lance = false;
    }
    if (!casterDoc) continue;
    if (repelling) {
      const size = targetDoc.actor.system?.traits?.size ?? "med";
      if (rulesOf(repelling) === "2024" && !LARGE_OR_SMALLER.has(size)) continue;
      const dest = pushDestination(casterDoc, targetDoc);
      if (dest && await promptChoice("Repelling Blast", `<p>Push <strong>${escapeHTML(hit.name)}</strong> ${dest.feet} ft away?</p>`,
        [{ action: "move", label: "Push" }, { action: "no", label: "Don't Push" }]) === "move") {
        await applyMasteryChange({ kind: "push", token: hit.token, actor: hit.actor, x: dest.x, y: dest.y });
        done.push(`${hit.name} pushed ${dest.feet} ft (Repelling Blast)`);
      }
    } else if (grasp) {
      const dest = pullDestination(casterDoc, targetDoc);
      if (dest && await promptChoice("Grasp of Hadar", `<p>Pull <strong>${escapeHTML(hit.name)}</strong> ${dest.feet} ft toward you?</p>`,
        [{ action: "move", label: "Pull" }, { action: "no", label: "Don't Pull" }]) === "move") {
        await applyMasteryChange({ kind: "push", token: hit.token, actor: hit.actor, x: dest.x, y: dest.y });
        done.push(`${hit.name} pulled ${dest.feet} ft (Grasp of Hadar)`);
        markUsed(actor, "grasp-of-hadar");
        grasp = false;
      }
    }
  }
  if (done.length) await message.setFlag(MODULE_ID, INVOCATION_RESULT_FLAG, done.join("; "));
}

// ── Damage cards ──────────────────────────────────────────────────────────────

/** Deal flat damage from a creature's invocation to tokens: a damage card, applied through the GM. */
export async function dealInvocationDamage(sourceActor, flavor, amount, type, tokenDocs) {
  if (!(amount > 0) || !tokenDocs.length) return null;
  const roll = await new CONFIG.Dice.DamageRoll(String(amount), {}, { type, types: [type] }).evaluate();
  const targets = tokenDocs.map(t => ({ actor: t.actor?.uuid, token: t.uuid, name: t.name, img: t.texture?.src,
    ac: t.actor?.system?.attributes?.ac?.value ?? null }));
  const card = await CONFIG.Dice.DamageRoll.toMessage([roll], {
    type: "damage", flavor, speaker: ChatMessage.getSpeaker({ actor: sourceActor }), system: { targets }
  });
  if (card) await requestApplyDamage(card, targets);
  return card;
}

// ── Gift of the Protectors ────────────────────────────────────────────────────

const giftAsked = new Map(); // by actor uuid: when it was last asked, so one drop asks once

/**
 * dnd5e.applyDamage: a creature dropped to 0 HP (not dead). Each warlock with Gift of the
 * Protectors uses left is asked whether that creature is written in their book; the first yes
 * brings it to 1 HP instead.
 */
export async function onDamageAppliedGift(actor) {
  if (!isInvocationsEnabled() || !actor?.isOwner || actor.statuses?.has?.("dead")) return;
  if (Number(actor.system?.attributes?.hp?.value ?? 1) > 0) return;
  if (Date.now() - (giftAsked.get(actor.uuid) ?? 0) < 3000) return;
  giftAsked.set(actor.uuid, Date.now());
  const warlocks = [...(game.actors ?? [])].filter(a => a.type === "character" && available(feature(a, "gift-of-the-protectors")));
  for (const warlock of warlocks) {
    const answer = await askReaction(warlock, { kind: "gift", actor: warlock.uuid, protectee: actor.uuid, name: actor.name });
    if (!answer?.used) continue;
    await actor.update({ "system.attributes.hp.value": 1 });
    if (actor.statuses?.has?.("unconscious")) await actor.toggleStatusEffect?.("unconscious", { active: false });
    console.log(`[${MODULE_ID}] gift of the protectors: ${warlock.name} kept ${actor.name} at 1 HP`);
    ui.notifications?.info(`Luck Dice Automation: ${warlock.name}'s Gift of the Protectors keeps ${actor.name} at 1 HP.`);
    return;
  }
}

/** The warlock's client: is the creature in the book? Spends a use on yes. */
export async function answerGift({ actor: warlockUuid, name }) {
  const warlock = await fromUuid(warlockUuid);
  const gift = feature(warlock, "gift-of-the-protectors");
  if (!warlock?.isOwner || !available(gift)) return null;
  const choice = await promptChoice("Gift of the Protectors",
    `<p><strong>${escapeHTML(name)}</strong> dropped to 0 HP. If their name is written in your book, they drop to 1 HP instead
     (once per long rest).</p>`,
    [{ action: "use", label: "Use It" }, { action: "no", label: "Not Now" }]);
  if (choice !== "use") return null;
  await spendIfLimited(gift);
  return { used: true };
}

// ── Cloak of Flies ────────────────────────────────────────────────────────────

/** Whether a warlock's Cloak of Flies is up: an active effect from it (or named for it) on the warlock. */
function cloakActive(actor) {
  return [...(actor?.effects ?? [])].some(e => !e.disabled && !e.isSuppressed
    && (sourceItem(e)?.system?.identifier === "cloak-of-flies" || /cloak of flies/i.test(e.name ?? "")));
}

/** combatTurnChange (the trigger client): poison damage to the creature whose turn starts next to an active Cloak of Flies. */
export async function onTurnStartCloak(combat, current) {
  if (!isInvocationsEnabled() || !isTriggerClient() || !combat?.started || !current?.tokenId) return;
  const scene = combat.scene ?? canvas.scene;
  const tokenDoc = scene?.tokens?.get?.(current.tokenId);
  if (!tokenDoc?.actor) return;
  for (const other of scene.tokens ?? []) {
    const warlock = other.actor;
    if (other.id === tokenDoc.id || !feature(warlock, "cloak-of-flies") || !cloakActive(warlock) || incapacitated(warlock)) continue;
    if (tokenDistance(other, tokenDoc) > (canvas?.grid?.distance ?? 5)) continue;
    await dealInvocationDamage(warlock, `Cloak of Flies — ${other.name}`, Math.max(0, chaMod(warlock)), "poison", [tokenDoc]);
  }
}

// ── Maddening Hex ─────────────────────────────────────────────────────────────

const CURSES = new Set(["hex", "hexblades-curse", "sign-of-ill-omen", "bestow-curse"]);

/** Tokens on the scene the warlock has cursed (Hex, Hexblade's Curse, Sign of Ill Omen…). */
export function cursedBy(warlock, scene) {
  return [...(scene?.tokens ?? [])].filter(t => [...(t.actor?.effects ?? [])].some(e => !e.disabled
    && sourceActor(e) === warlock && (e.statuses?.has?.("cursed") || CURSES.has(sourceItem(e)?.system?.identifier))));
}

/**
 * dnd5e.postUseActivity: Maddening Hex — psychic damage equal to the Charisma modifier (minimum 1)
 * to the cursed creature (within 30 ft, in sight) and the creatures picked within 5 ft of it.
 * Stays synchronous until dnd5e's own damage roll is turned off.
 */
export function onMaddeningHexUsed(activity, usageConfig, results) {
  if (!isInvocationsEnabled() || activity?.item?.system?.identifier !== "maddening-hex" || !activity.actor?.isOwner) return;
  if (isLike(activity, "damage") && usageConfig) usageConfig.subsequentActions = false; // rolled here instead
  maddeningHex(activity, results).catch(err => console.error(`[${MODULE_ID}] maddening hex:`, err));
}

async function maddeningHex(activity, results) {
  const warlock = activity.actor;
  const me = attackerToken(activity, results?.message);
  const scene = me?.parent ?? canvas.scene;
  const cursed = cursedBy(warlock, scene).filter(t => !me || (tokenDistance(me, t) <= 30 && hasLineOfSight(me, t)));
  if (!cursed.length) {
    ui.notifications?.warn("Luck Dice Automation: Maddening Hex needs a creature you've cursed, in sight and within 30 ft.");
    return;
  }
  const target = cursed[0];
  const nearby = [...(scene?.tokens ?? [])].filter(t => t.actor && t.id !== target.id && t.id !== me?.id
    && tokenDistance(target, t) <= (canvas?.grid?.distance ?? 5) && (!me || hasLineOfSight(me, t)));
  const picked = nearby.length
    ? await pickCreatures("Maddening Hex", `Who else within 5 ft of ${escapeHTML(target.name)} takes the damage?`, nearby,
      { checked: (t) => !me || t.disposition !== me.disposition })
    : [];
  if (picked === null) return;
  await dealInvocationDamage(warlock, "Maddening Hex", Math.max(1, chaMod(warlock)), "psychic", [target, ...picked]);
}
