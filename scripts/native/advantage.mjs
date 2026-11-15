// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Advantage and disadvantage on attack rolls, from the obvious reasons.
//
// The "attackAdvantage" setting. Before an attack is rolled (dnd5e.preRollAttackV2,
// which runs before dnd5e reads its advantage keys), the attacker, its single
// target and the scene are checked for:
//   range      — a ranged attack with an active enemy within 5 ft (Crossbow Expert,
//                Sharpshooter, Gunner, Spell Sniper excepted, per their rules);
//                beyond normal range (Sharpshooter excepted); beyond long range
//                cancels the attack with a message;
//   conditions — the attacker Prone, Restrained, Blinded, Invisible, or Frightened
//                with the source of its fear in sight; the target Prone (melee
//                within 5 ft / otherwise), Restrained, Blinded, Paralyzed, Stunned,
//                Unconscious, Petrified, Invisible, or Dodging;
//   features   — Reckless Attack (the attacker's Strength attacks; attacks against
//                a reckless creature), Faerie Fire, Guiding Bolt (its mark is used
//                up by the attack), a Heavy weapon in small or weak hands, Studied
//                Attacks (fighter.mjs: after a miss, the next attack at that creature);
//                Grappler (the feat: a creature it's grappling);
//                a target with Elusive (Rogue 18) that isn't Incapacitated: no
//                Advantage from any source;
//   feats      — Spell Sniper (range; 2024: enemies within 5 ft), Crossbow Expert and
//                Gunner (enemies within 5 ft), Sharpshooter (long range; 2024: enemies
//                within 5 ft); Spell Sniper and Sharpshooter ignore half and
//                three-quarters cover — its bonus is taken off the target's AC on the card. 2024
//                Crossbow Expert's off-hand crossbow adds its modifier to the damage.
// dnd5e itself already covers Poisoned, encumbrance and exhaustion. Any advantage
// plus any disadvantage is a normal roll, so these combine safely with other
// sources. When Automated Conditions 5e (AC5E) is active, each check it performs
// with its current settings is left to it. Reasons about the target count only
// with exactly one target (dnd5e rolls once for all of them). The reasons are
// shown in dnd5e's roll window and on the attack card.

import { MODULE_ID, debug, escapeHTML, isAttackAdvantageEnabled, isAutoCritsEnabled, isWeaponMasteryEnabled, socket, isLike } from "./shared.mjs";
import { MASTERY_FLAG } from "./mastery.mjs";

export const ATTACK_REASONS_FLAG = "attackReasons";
export const SAVE_REASONS_FLAG = "saveReasons"; // save-rules.mjs
const AC5E_ID = "automated-conditions-5e";
const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];

// ── Automated Conditions 5e ───────────────────────────────────────────────────

function ac5eSetting(key) {
  try { return game.settings.get(AC5E_ID, key); } catch { return undefined; }
}

/** The checks AC5E performs with its current settings ({} when it isn't active). */
export function ac5eCovers() {
  if (!game.modules.get(AC5E_ID)?.active) return {};
  const statuses = !!ac5eSetting("automateStatuses");
  const rangeSetting = ac5eSetting("autoRangeChecks");
  const range = new Set(rangeSetting && typeof rangeSetting[Symbol.iterator] === "function" && typeof rangeSetting !== "string" ? rangeSetting : []);
  return {
    statuses,
    dodging: statuses && !!ac5eSetting("expandedConditions"),
    nearbyFoes: range.has("rangedNearbyFoes"),
    longRange: range.has("rangedLongDisadvantage"),
    outOfRange: range.has("rangedOoR"),
    heavy: !!ac5eSetting("automateHeavy")
  };
}

// ── Geometry ──────────────────────────────────────────────────────────────────

const doc = (token) => token?.document ?? token ?? null;

/** Distance between two tokens' nearest grid spaces (in scene units), elevation included. */
export function tokenDistance(a, b) {
  a = doc(a); b = doc(b);
  const grid = canvas?.grid;
  if (!a || !b || !grid || a.parent !== b.parent) return Infinity;
  const at = (token, point) => ({ ...point, elevation: token.elevation ?? 0 });
  if (!grid.isGridless && a.getOccupiedGridSpaceOffsets && b.getOccupiedGridSpaceOffsets) {
    let best = Infinity;
    for (const oa of a.getOccupiedGridSpaceOffsets()) {
      for (const ob of b.getOccupiedGridSpaceOffsets()) {
        const d = grid.measurePath([at(a, grid.getCenterPoint(oa)), at(b, grid.getCenterPoint(ob))]).distance;
        if (d < best) best = d;
      }
    }
    return best;
  }
  // Gridless: centre to centre, less each token's half-size.
  const center = (t) => t.object?.center ?? { x: t.x + (t.width * grid.size) / 2, y: t.y + (t.height * grid.size) / 2 };
  const d = grid.measurePath([at(a, center(a)), at(b, center(b))]).distance;
  return Math.max(0, d - ((a.width + b.width) / 2) * grid.distance + grid.distance);
}

// Foundry 14 Scene Levels: each wall belongs to a level, and floors and ceilings (surfaces) lie between
// levels. Unless told which level and elevation to test, Foundry's collision tests use the level the user
// is viewing, at its base elevation, so a test between two tokens names their own levels and heights.

/** A token's level (Foundry 14), or null where the scene has none — Foundry then uses the viewed one. */
export function levelOf(token) {
  const d = doc(token);
  const id = d?._source?.level ?? d?.level?.id ?? d?.level;
  return (id && d?.parent?.levels?.get?.(id)) || null;
}

/** A token's centre, at its own height: its elevation plus half its depth (the middle of its space). */
export function elevatedCenter(token) {
  const t = doc(token), grid = canvas?.grid;
  const size = grid?.size ?? 100, distance = grid?.distance ?? 5;
  const center = t.object?.center ?? { x: t.x + ((t.width ?? 1) * size) / 2, y: t.y + ((t.height ?? 1) * size) / 2 };
  return { x: center.x, y: center.y, elevation: (Number(t.elevation) || 0) + ((Number(t.depth ?? t.width) || 1) * distance) / 2 };
}

/**
 * Whether walls, floors or ceilings block sight between two tokens. On a scene with levels, sight is blocked
 * by a wall on either token's level, or by a surface between them (Foundry's own vision tests both levels).
 */
export function hasLineOfSight(a, b) {
  a = doc(a); b = doc(b);
  const backend = CONFIG.Canvas?.polygonBackends?.sight;
  if (!backend?.testCollision || !a || !b) return true;
  const from = elevatedCenter(a), to = elevatedCenter(b);
  const levels = [...new Set([levelOf(a), levelOf(b)].filter(Boolean))];
  try {
    if (!levels.length) return !backend.testCollision(from, to, { type: "sight", mode: "any" });
    for (const level of levels) {
      if (a.parent?.testSurfaceCollision?.(from, to, { type: "sight", mode: "any", level })) return false;
      if (backend.testCollision(from, to, { type: "sight", mode: "any", level })) return false;
    }
    return true;
  } catch { return true; }
}

// ── Where effects came from ───────────────────────────────────────────────────

/** The item an applied effect came from, from what dnd5e records on it. */
export function sourceItem(effect) {
  const candidates = [effect.system?.origin?.item, effect.system?.origin?.activity?.split(".Activity.")[0],
    effect._stats?.duplicateSource?.split(".ActiveEffect.")[0], effect._stats?.compendiumSource?.split(".ActiveEffect.")[0], effect.origin];
  for (const uuid of candidates) {
    if (typeof uuid !== "string" || !uuid.includes("Item.")) continue;
    try {
      const item = fromUuidSync(uuid, { strict: false });
      if (item?.documentName === "Item") return item;
    } catch { /* not resolvable synchronously */ }
  }
  return null;
}

/** The actor an effect came from (its origin's owner), resolved synchronously. */
export function sourceActor(effect) {
  const item = sourceItem(effect);
  if (item?.actor) return item.actor;
  for (const uuid of [effect.system?.origin?.activity, effect.origin]) {
    if (typeof uuid !== "string") continue;
    const actorPart = uuid.split(".Item.")[0];
    try {
      const found = fromUuidSync(actorPart, { strict: false });
      if (found?.documentName === "Actor") return found;
      if (found?.actor) return found.actor;
    } catch { /* ignore */ }
  }
  return null;
}

/** Active effects on an actor that came from an item with this identifier. */
export function effectsFrom(actor, identifier) {
  return [...(actor?.effects ?? [])].filter(e => !e.disabled && !e.isSuppressed && sourceItem(e)?.system?.identifier === identifier);
}

// Effects that take away a creature's opportunity attacks or reactions. dnd5e's SRD gives them no status or
// rule, so they're known by where they came from (and end when dnd5e expires them):
//   2024 Shocking Grasp ("Shocked") and Brutal Strike's Staggering Blow ("Staggered") — no opportunity attacks;
//   2014 Shocking Grasp — no reactions at all.
const STAGGERED_EFFECT = "uacly0JAXLVwAS6y"; // Brutal Strike's "Staggered", of its three effects
const isStaggered = (effect) => [effect._stats?.duplicateSource, effect._stats?.compendiumSource]
  .some(uuid => String(uuid ?? "").endsWith(`.ActiveEffect.${STAGGERED_EFFECT}`)) || /\bstagger/i.test(effect.name ?? "");
export const STAGGER_USED = "staggerSaveUsed"; // on a Staggered effect: its save disadvantage has been spent

/** Brutal Strike's Staggered effect on a creature whose next save still has its disadvantage (save-rules.mjs). */
export function staggeredSave(actor) {
  return effectsFrom(actor, "brutal-strike").find(e => isStaggered(e) && !e.getFlag?.(MODULE_ID, STAGGER_USED)) ?? null;
}

/** Whether the creature can't make opportunity attacks: Shocked (2024 Shocking Grasp) or Staggered (Brutal Strike). */
export function cantMakeOpportunityAttacks(actor) {
  return effectsFrom(actor, "shocking-grasp").some(e => rulesOf(sourceItem(e)) !== "2014")
    || effectsFrom(actor, "brutal-strike").some(isStaggered);
}

/** Whether the creature can't take reactions: hit by a 2014 Shocking Grasp. */
export function cantTakeReactions(actor) {
  return effectsFrom(actor, "shocking-grasp").some(e => rulesOf(sourceItem(e)) === "2014");
}

const hasFeat = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;
/** "2014" or "2024": the item's own rules, else the world's. */
export const rulesOf = (item) => {
  const rules = String(item?.system?.source?.rules ?? "");
  if (rules === "2014" || rules === "2024") return rules;
  try { return game.settings.get("dnd5e", "rulesVersion") === "legacy" ? "2014" : "2024"; } catch { return "2024"; }
};

// ── The checks ────────────────────────────────────────────────────────────────

/** What the attack is: who, with what, at whom. */
export function attackFacts(activity, config = {}) {
  const actor = activity?.actor ?? null;
  const item = activity?.item ?? null;
  const attacker = doc(activity?.getUsageToken?.() ?? actor?.getActiveTokens?.()?.[0]);
  const mode = String(config.attackMode ?? "");
  const thrown = mode.startsWith("thrown");
  const ranged = activity?.attack?.type?.value === "ranged" || thrown;
  const classification = activity?.attack?.type?.classification;
  const targets = [...(game.user?.targets ?? [])].map(doc).filter(t => t?.actor);
  return {
    actor, item, activity, attacker, ranged, thrown, melee: !ranged,
    weapon: item?.type === "weapon" || classification === "weapon" || classification === "unarmed",
    spell: classification === "spell" || item?.type === "spell",
    ability: config.ability ?? activity?.ability ?? null,
    targets, target: targets.length === 1 ? targets[0] : null
  };
}

/**
 * How much a spell conduit (Scorpious187's Custom Items: Kilian's Eldritch Rifle) multiplies this casting's
 * range: its copy of the spell records it. It multiplies the whole range, so what this module adds to the
 * range of a spell cast through one is multiplied too. 1 when the spell isn't channeled.
 */
export function conduitMultiplier(item) {
  return Number(item?.flags?.["scorpious187s-custom-items"]?.conduitCast?.rangeMultiplier) || 1;
}

/**
 * The weapon's or activity's range in scene units: { normal, long } or null when it has none.
 * Spell Sniper extends a spell attack's range: doubled (2014), or 60 ft more for a range of 10 ft
 * or more (2024) — multiplied along with the rest by a spell conduit.
 */
function rangeOf(fx) {
  const range = fx.item?.type === "weapon" ? fx.item.system?.range : fx.activity?.range;
  let normal = Number(range?.value);
  if (!Number.isFinite(normal) || normal <= 0) return null;
  const units = String(range?.units ?? "ft").toLowerCase();
  const sceneUnits = String(canvas?.scene?.grid?.units ?? canvas?.grid?.units ?? "ft").toLowerCase();
  const norm = (u) => ({ feet: "ft", foot: "ft", meters: "m", meter: "m", metres: "m", metre: "m" })[u] ?? u;
  if (!["ft", "m"].includes(norm(units)) || norm(units) !== norm(sceneUnits)) return null;
  const long = Number(range?.long);
  const spellSniper = fx.spell ? hasFeat(fx.actor, "spell-sniper") : null;
  if (spellSniper) {
    const feet = norm(units) === "ft" ? 1 : 0.3;
    const mult = conduitMultiplier(fx.item);
    if (rulesOf(spellSniper) === "2014") normal *= 2;
    else if (normal / mult >= 10 * feet) normal += 60 * feet * mult;
  }
  return { normal, long: Number.isFinite(long) && long > normal ? long : null };
}

const adjacent = () => canvas?.grid?.distance ?? 5;
const isCrossbow = (item) => /crossbow/i.test(String(item?.system?.type?.baseItem ?? item?.name ?? ""));

/**
 * The feat that lets this ranged attack ignore an enemy within 5 ft, by its rules: Crossbow Expert
 * (2014: any ranged attack; 2024: crossbows), Gunner (any ranged attack), Sharpshooter 2024
 * (weapons), Spell Sniper 2024 (spells). Null when none does.
 */
function nearbyFoeExemption(fx) {
  const crossbowExpert = hasFeat(fx.actor, "crossbow-expert");
  if (crossbowExpert && (rulesOf(crossbowExpert) === "2014" || isCrossbow(fx.item))) return "Crossbow Expert";
  if (hasFeat(fx.actor, "gunner")) return "Gunner";
  const sharpshooter = hasFeat(fx.actor, "sharpshooter");
  if (sharpshooter && rulesOf(sharpshooter) === "2024" && fx.weapon) return "Sharpshooter";
  const spellSniper = hasFeat(fx.actor, "spell-sniper");
  return spellSniper && rulesOf(spellSniper) === "2024" && fx.spell ? "Spell Sniper" : null;
}

/**
 * Whether Automated Conditions 5e's own nearby-foe check lets this attack off: it knows Crossbow Expert
 * (for every ranged attack, whatever its rules) and the 2024 Sharpshooter and Spell Sniper, not Gunner.
 */
function ac5eExemptsNearbyFoe(fx) {
  if (hasFeat(fx.actor, "crossbow-expert")) return true;
  const modern = (identifier) => { const feat = hasFeat(fx.actor, identifier); return feat && rulesOf(feat) === "2024"; };
  return fx.spell ? !!modern("spell-sniper") : !!modern("sharpshooter");
}

/**
 * The feat that lets this attack ignore cover, and how much of it: { feat, bonuses } — the cover
 * bonuses it ignores (half +2, three-quarters +5). Spell Sniper: spell attacks (2014: ranged ones);
 * Sharpshooter: ranged weapon attacks. Total cover always stands. Null when neither applies.
 */
export function coverBypass(fx) {
  const spellSniper = fx.spell ? hasFeat(fx.actor, "spell-sniper") : null;
  if (spellSniper && (rulesOf(spellSniper) === "2024" || fx.ranged)) return { feat: "Spell Sniper", bonuses: [2, 5] };
  if (fx.weapon && fx.ranged && hasFeat(fx.actor, "sharpshooter")) return { feat: "Sharpshooter", bonuses: [2, 5] };
  return null;
}

/** An active enemy within 5 ft of the attacker, if any. */
function nearbyFoe(fx) {
  const me = fx.attacker;
  if (!me || !me.parent || !me.disposition) return null;
  return [...(me.parent.tokens ?? [])].find(t => t.id !== me.id && t.actor && t.disposition === -me.disposition
    && !INCAPACITATING.some(s => t.actor.statuses?.has?.(s)) && tokenDistance(me, t) <= adjacent()) ?? null;
}

/**
 * Whether a creature is grappled by this one (the Grappler feat): its Grappled effect came from it. A Grappled
 * status with no source recorded (set from the token HUD) counts when the creature is within 5 ft.
 */
function grappledBy(targetActor, attacker, distance) {
  if (!targetActor?.statuses?.has?.("grappled")) return false;
  const sources = [...(targetActor.effects ?? [])].filter(e => !e.disabled && e.statuses?.has?.("grappled")).map(sourceActor).filter(Boolean);
  if (sources.length) return sources.some(a => a === attacker || (a.uuid && a.uuid === attacker?.uuid));
  return Number.isFinite(distance) && distance <= adjacent();
}

/** Frightened, with the source of its fear on the scene and in sight. Unknown sources don't count. */
function frightenedBySeenSource(fx) {
  const actor = fx.actor;
  if (!actor?.statuses?.has?.("frightened") || actor.statuses.has("blinded") || !fx.attacker) return null;
  for (const effect of actor.effects ?? []) {
    if (effect.disabled || !effect.statuses?.has?.("frightened")) continue;
    const source = sourceActor(effect);
    const token = source?.getActiveTokens?.()?.map(doc).find(t => t.parent === fx.attacker.parent);
    if (token && hasLineOfSight(fx.attacker, token)) return token;
  }
  return null;
}

/**
 * The reasons for advantage / disadvantage on this attack, and whether it
 * can't be made at all: { advantage: [], disadvantage: [], cancel, consume: [effect uuids] }.
 */
export function attackReasons(activity, config = {}) {
  const fx = attackFacts(activity, config);
  const covers = ac5eCovers();
  const advantage = [], disadvantage = [], consume = [], ignored = [], dropAc5e = [];
  let cancel = null;
  const target = fx.target, targetActor = target?.actor;
  const has = (actor, status) => !!actor?.statuses?.has?.(status);
  const distance = target && fx.attacker ? tokenDistance(fx.attacker, target) : Infinity;

  // Range.
  if (fx.ranged && fx.attacker) {
    const range = rangeOf(fx);
    if (range && target && Number.isFinite(distance)) {
      const max = range.long ?? range.normal;
      if (distance > max && !covers.outOfRange) {
        cancel = `${target.name} is out of range for ${fx.item?.name ?? "that attack"} (${Math.round(distance)} of ${max}).`;
      } else if (range.long && distance > range.normal && distance <= range.long && !covers.longRange && !hasFeat(fx.actor, "sharpshooter")) {
        disadvantage.push("Long range");
      }
    }
    // An enemy within 5 ft. When AC5E checks it, only where its feat list and the rules differ:
    // Gunner (it doesn't know it — its disadvantage is taken back), 2024 Crossbow Expert with
    // anything but a crossbow (it lets every ranged attack off).
    const foe = nearbyFoe(fx);
    if (foe) {
      const exemption = nearbyFoeExemption(fx);
      const disadvantageReason = `Ranged attack with ${foe.name} within 5 ft`;
      if (!covers.nearbyFoes) {
        if (exemption) ignored.push(`${foe.name} within 5 ft (${exemption})`);
        else disadvantage.push(disadvantageReason);
      } else if (exemption && !ac5eExemptsNearbyFoe(fx)) {
        ignored.push(`${foe.name} within 5 ft (${exemption})`);
        dropAc5e.push("nearbyFoe");
      } else if (!exemption && ac5eExemptsNearbyFoe(fx)) {
        disadvantage.push(disadvantageReason);
      }
    }
  }

  // Cover the attacker's feat ignores (Spell Sniper, Sharpshooter): taken off those targets' AC.
  const bypass = coverBypass(fx);
  const coverIgnored = bypass ? fx.targets.map(t => ({ token: t.uuid, name: t.name, bonus: Number(t.actor?.system?.attributes?.ac?.cover ?? 0) }))
    .filter(t => bypass.bonuses.includes(t.bonus)) : [];
  if (coverIgnored.length) ignored.push(`${coverIgnored.map(t => t.name).join(", ")}'s cover (${bypass.feat})`);

  // Conditions.
  if (!covers.statuses) {
    if (has(fx.actor, "prone")) disadvantage.push("Prone");
    if (has(fx.actor, "restrained")) disadvantage.push("Restrained");
    if (has(fx.actor, "blinded")) disadvantage.push("Blinded");
    if (has(fx.actor, "invisible")) advantage.push("Invisible");
    const fear = frightenedBySeenSource(fx);
    if (fear) disadvantage.push(`Frightened of ${fear.name}`);
    if (targetActor) {
      if (has(targetActor, "prone")) {
        if (fx.melee && distance <= adjacent()) advantage.push("Target prone");
        else disadvantage.push("Target prone (not within 5 ft)");
      }
      for (const [status, label] of [["restrained", "Restrained"], ["blinded", "Blinded"], ["paralyzed", "Paralyzed"],
        ["stunned", "Stunned"], ["unconscious", "Unconscious"], ["petrified", "Petrified"]]) {
        if (has(targetActor, status)) advantage.push(`Target ${label.toLowerCase()}`);
      }
      if (has(targetActor, "invisible")) disadvantage.push("Target invisible");
    }
  }
  if (!covers.dodging && targetActor && has(targetActor, "dodging") && !INCAPACITATING.some(s => has(targetActor, s))) {
    disadvantage.push("Target dodging");
  }

  // Features.
  const reckless = effectsFrom(fx.actor, "reckless-attack")[0];
  if (reckless && fx.ability === "str") {
    const modern = rulesOf(sourceItem(reckless)) === "2024";
    if (modern || (fx.melee && fx.weapon)) advantage.push("Reckless Attack");
  }
  if (targetActor && effectsFrom(targetActor, "reckless-attack").length) advantage.push("Target attacking recklessly");
  if (targetActor && effectsFrom(targetActor, "faerie-fire").length) advantage.push("Faerie Fire");
  if (targetActor && hasFeat(fx.actor, "grappler") && grappledBy(targetActor, fx.actor, distance)) advantage.push("Grappler");
  const bolt = targetActor ? effectsFrom(targetActor, "guiding-bolt")[0] : null;
  if (bolt) { advantage.push("Guiding Bolt"); consume.push(bolt.uuid); }
  addMasteryReasons(fx, { advantage, disadvantage, consume });
  if (!covers.heavy && fx.item?.type === "weapon" && fx.item.system?.properties?.has?.("hvy")) {
    const reason = heavyWeaponReason(fx);
    if (reason) disadvantage.push(reason);
  }

  // Elusive (Rogue 18): no attack roll has Advantage against it unless it's Incapacitated. The reasons
  // found are set aside (marks are still used up: this was the next attack); mergeRollMode drops the
  // Advantage from other sources too.
  let elusive = null;
  if (targetActor && hasFeat(targetActor, "elusive") && !INCAPACITATING.some(s => has(targetActor, s))) {
    elusive = { name: target.name, blocked: advantage.splice(0) };
  }

  return { advantage, disadvantage, cancel, consume, ignored, dropAc5e, coverIgnored, elusive };
}

/** Silvery Barbs' advantage mark on a creature (reactions.mjs), if it has one: its next attack, check or save. */
export const silveryMark = (actor) => [...(actor?.effects ?? [])]
  .find(e => !e.disabled && e.getFlag?.(MODULE_ID, MASTERY_FLAG)?.kind === "silvery-barbs") ?? null;

/**
 * Weapon Mastery marks (mastery.mjs): Sap on the attacker, Vex against this target; Studied Attacks'
 * (fighter.mjs) against this target; and Stunning Strike's (monk.mjs) on the target — the next attack
 * against it, by anyone, has Advantage. Used up by the attack.
 */
function addMasteryReasons(fx, { advantage, disadvantage, consume }) {
  const masteryOf = (effect) => effect.disabled ? null : effect.getFlag?.(MODULE_ID, MASTERY_FLAG);
  const effects = [...(fx.actor?.effects ?? [])];
  const sapped = effects.find(e => masteryOf(e)?.kind === "sap");
  if (sapped) { disadvantage.push("Sapped"); consume.push(sapped.uuid); }
  const vexing = fx.target ? effects.find(e => masteryOf(e)?.kind === "vex" && masteryOf(e).target === fx.target.uuid) : null;
  if (vexing) { advantage.push("Vex"); consume.push(vexing.uuid); }
  const studied = fx.target ? effects.find(e => masteryOf(e)?.kind === "studied-attacks" && masteryOf(e).target === fx.target.uuid) : null;
  if (studied) { advantage.push("Studied Attacks"); consume.push(studied.uuid); }
  const barbs = silveryMark(fx.actor);
  if (barbs) { advantage.push("Silvery Barbs"); consume.push(barbs.uuid); }
  const exposed = fx.target ? [...(fx.target.actor?.effects ?? [])].find(e => masteryOf(e)?.kind === "stunning-strike") : null;
  if (exposed) { advantage.push("Stunning Strike"); consume.push(exposed.uuid); }
}

/** Only the Weapon Mastery reasons (when the advantage setting is off but Weapon Mastery is on). */
export function masteryReasons(activity, config = {}) {
  const fx = attackFacts(activity, config);
  const reasons = { advantage: [], disadvantage: [], cancel: null, consume: [], ignored: [], dropAc5e: [], coverIgnored: [] };
  addMasteryReasons(fx, reasons);
  return reasons;
}

/** 2014: Small or Tiny wielders. 2024: Strength (melee) / Dexterity (ranged) below 13. */
function heavyWeaponReason(fx) {
  const actor = fx.actor;
  if (rulesOf(fx.item) === "2014") {
    return ["sm", "tiny"].includes(actor?.system?.traits?.size) ? "Heavy weapon (small wielder)" : null;
  }
  const meleeWeapon = /M$/.test(String(fx.item.system?.type?.value ?? "")) || !/R$/.test(String(fx.item.system?.type?.value ?? ""));
  const ability = meleeWeapon ? "str" : "dex";
  const score = Number(actor?.system?.abilities?.[ability]?.value);
  return Number.isFinite(score) && score < 13 ? `Heavy weapon (${ability === "str" ? "Strength" : "Dexterity"} below 13)` : null;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/**
 * dnd5e.preRollAttackV2: apply the reasons (before dnd5e reads its keys), note
 * them for the roll window and the card, or cancel an attack out of range.
 * Returns false only to cancel.
 */
export function onPreRollAttack(config, dialog, message) {
  const full = isAttackAdvantageEnabled();
  const activity = config?.subject;
  if (!isLike(activity, "attack")) return;
  // Without either setting, only a Silvery Barbs mark (Reaction Prompts) is read.
  if (!full && !isWeaponMasteryEnabled() && !silveryMark(activity.actor)) return;
  let reasons;
  try { reasons = full ? attackReasons(activity, config) : masteryReasons(activity, config); }
  catch (err) { console.error(`[${MODULE_ID}] attack reasons:`, err); return; }
  if (reasons.cancel) {
    ui.notifications?.warn(`Luck Dice Automation: ${reasons.cancel}`);
    return false;
  }
  if (!reasons.advantage.length && !reasons.disadvantage.length && !reasons.ignored?.length && !reasons.elusive) return;

  if (reasons.coverIgnored?.length) bypassCover(config, message, reasons.coverIgnored);
  if (reasons.dropAc5e?.includes("nearbyFoe")) dropAc5eNearbyFoe(config);
  reasons.finalMode = mergeRollMode(config, dialog, reasons);
  ensureFinalModeHook();
  if (message) foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.${ATTACK_REASONS_FLAG}`, reasons);
  debug(`attack reasons: +[${reasons.advantage.join(", ")}] −[${reasons.disadvantage.join(", ")}] → mode ${reasons.finalMode}`);
}

/**
 * Ignored cover: take each target's cover bonus off the AC dnd5e put on the attack card (its targets,
 * which decide hit or miss) — and off the roll's own target for a single target.
 */
function bypassCover(config, message, coverIgnored) {
  const targets = message?.data?.system?.targets;
  for (const { token, bonus } of coverIgnored) {
    const entry = Array.isArray(targets) ? targets.find(t => t.token === token) : null;
    if (entry && Number.isFinite(entry.ac)) entry.ac -= bonus;
  }
  if (Array.isArray(targets) && targets.length === 1 && coverIgnored.length === 1) {
    const ac = targets[0].ac;
    if (Number.isFinite(Number(config.target))) config.target = ac;
    for (const roll of config.rolls ?? []) if (Number.isFinite(Number(roll.options?.target))) roll.options.target = ac;
  }
}

/**
 * Take back Automated Conditions 5e's nearby-foe disadvantage (its entry on the attacker's side), for a
 * feat it doesn't know. Its verdict stays disadvantage only while some other source of it remains.
 */
function dropAc5eNearbyFoe(config) {
  const ac5e = game.modules.get(AC5E_ID)?.active ? config.rolls?.[0]?.options?.[AC5E_ID] : null;
  if (!ac5e) return;
  const label = game.i18n.localize("AC5E.NearbyFoe");
  const labelOf = (entry) => typeof entry === "string" ? entry : (entry?.label ?? entry?.name ?? "");
  let removed = false;
  for (const side of [ac5e.subject, ac5e.opponent]) {
    const list = side?.disadvantage;
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i--) if (labelOf(list[i]) === label) { list.splice(i, 1); removed = true; }
  }
  if (!removed) return;
  const remaining = [ac5e.subject, ac5e.opponent].some(side =>
    (side?.disadvantage?.length ?? 0) > 0 || (side?.disadvantageNames?.size ?? side?.disadvantageNames?.length ?? 0) > 0);
  if (!remaining) ac5e.hasTransitDisadvantage = false;
}

/**
 * dnd5e.preRollDamageV2 — weapon damage from feats and fighting styles ("Attack Rules"). Never cancels.
 *   Off-hand attack (the Light property's extra attack), which dnd5e rolls without the ability modifier:
 *     Two-Weapon Fighting adds it back; so does 2024 Crossbow Expert, with a Light crossbow.
 *   Great Weapon Fighting — a melee weapon held in two hands (Two-Handed, or Versatile used two-handed):
 *     2024 treats a 1 or 2 on its damage dice as a 3 ("min3"); 2014 rerolls them once ("r<3").
 */
export function onPreRollDamageFeats(config) {
  if (!isAttackAdvantageEnabled()) return;
  const activity = config?.subject, actor = activity?.actor;
  const item = activity?.item;
  if (!isLike(activity, "attack") || item?.type !== "weapon") return;
  const base = config.rolls?.find(r => r?.base) ?? config.rolls?.[0];
  if (!base) return;
  const mode = String(config.attackMode ?? "");

  if (mode.endsWith("offhand") && !(base.parts ?? []).some(p => String(p).includes("@mod"))) {
    const crossbow = hasFeat(actor, "crossbow-expert");
    const why = hasFeat(actor, "two-weapon-fighting") ? "Two-Weapon Fighting"
      : (crossbow && rulesOf(crossbow) === "2024" && isCrossbow(item) && item.system?.properties?.has?.("lgt")) ? "Crossbow Expert" : null;
    if (why) {
      (base.parts ??= []).push("@mod");
      debug(`${why}: ${actor.name}'s off-hand ${item.name} adds its ability modifier`);
    }
  }

  const gwf = hasFeat(actor, "great-weapon-fighting");
  const twoHands = mode === "twoHanded" || (!mode.startsWith("thrown") && item.system?.properties?.has?.("two"));
  if (gwf && twoHands && activity.attack?.type?.value === "melee") {
    const modifier = rulesOf(gwf) === "2014" ? "r<3" : "min3";
    base.parts = (base.parts ?? []).map(p => withDieModifier(p, modifier));
    debug(`great weapon fighting: ${actor.name}'s ${item.name} damage dice get "${modifier}"`);
  }
}

/** A formula part with this modifier on each of its plain dice ("2d6" → "2d6min3"), not on ones already modified. */
export function withDieModifier(part, modifier) {
  if (typeof part !== "string") return part;
  return part.replace(/(\d*)d(\d+)(?![\d\w<>=])/g, `$1d$2${modifier}`);
}

/**
 * Put the reasons' advantage / disadvantage on a d20 roll's config (attacks, saves), combined with
 * what's already on it: Automated Conditions 5e's verdict (it decides in the V1 preRoll hook, just
 * before this, and writes a normal roll as advantage + disadvantage, so its own record of its sources
 * is read instead), or dnd5e's own sources (e.g. Poisoned). Any advantage plus any disadvantage is a
 * normal roll. Returns the resulting mode, and makes it the roll window's default button.
 */
export function mergeRollMode(config, dialog, reasons) {
  const roll0 = config.rolls?.[0]?.options ?? {};
  const ac5e = game.modules.get(AC5E_ID)?.active ? roll0[AC5E_ID] : null;
  const priorAdvantage = ac5e ? !!ac5e.hasTransitAdvantage : !!(roll0.advantage || config.advantage);
  const priorDisadvantage = ac5e ? !!ac5e.hasTransitDisadvantage : !!(roll0.disadvantage || config.disadvantage);
  // Elusive: no Advantage from any source; what it cancelled is noted as ignored.
  const elusive = reasons.elusive;
  if (elusive) {
    const blocked = [...(elusive.blocked ?? []), ...(priorAdvantage ? ["advantage from other sources"] : [])];
    if (blocked.length) (reasons.ignored ??= []).push(`${blocked.join(", ")} (${elusive.name} is Elusive)`);
  }
  const hasAdvantage = !elusive && (priorAdvantage || reasons.advantage.length > 0);
  const hasDisadvantage = priorDisadvantage || reasons.disadvantage.length > 0;
  const modes = CONFIG.Dice.D20Roll?.ADV_MODE ?? { NORMAL: 0, ADVANTAGE: 1, DISADVANTAGE: -1 };
  const finalMode = hasAdvantage && !hasDisadvantage ? modes.ADVANTAGE : hasDisadvantage && !hasAdvantage ? modes.DISADVANTAGE : modes.NORMAL;
  config.advantage = hasAdvantage;
  config.disadvantage = hasDisadvantage;
  for (const roll of config.rolls ?? []) {
    roll.options ??= {};
    roll.options.advantage = hasAdvantage;
    roll.options.disadvantage = hasDisadvantage;
  }
  if (dialog) {
    dialog.options ??= {};
    dialog.options.defaultButton = finalMode === modes.ADVANTAGE ? "advantage" : finalMode === modes.DISADVANTAGE ? "disadvantage" : "normal";
  }
  return finalMode;
}

let finalModeHookRegistered = false;
/**
 * Registered on the first attack or save with reasons — after every module's setup, so after
 * Automated Conditions 5e's own dnd5e.postRollConfiguration handler, which re-applies its verdict
 * to the built roll. This one runs last and keeps the combined verdict.
 */
export function ensureFinalModeHook() {
  if (finalModeHookRegistered) return;
  finalModeHookRegistered = true;
  Hooks.on("dnd5e.postRollConfiguration", applyFinalAttackMode);
}

/**
 * dnd5e.postRollConfiguration: when the roll window was skipped, put the combined
 * advantage / disadvantage on the built d20 (a choice made in the window stands).
 */
export function applyFinalAttackMode(rolls, config, dialog, message) {
  const flags = message?.data?.flags?.[MODULE_ID];
  const reasons = flags?.[ATTACK_REASONS_FLAG] ?? flags?.[SAVE_REASONS_FLAG];
  if (!reasons || typeof reasons.finalMode !== "number" || dialog?.configure !== false) return;
  const roll = rolls?.[0];
  const d20 = roll?.d20;
  if (!d20?.applyAdvantage || roll.options?.advantageMode === reasons.finalMode) return;
  d20.applyAdvantage(reasons.finalMode);
  roll.options.advantageMode = reasons.finalMode;
  roll.resetFormula?.();
  debug(`attack mode kept: ${reasons.finalMode} (${AC5E_ID} active: ${!!game.modules.get(AC5E_ID)?.active})`);
}

/** A short line for the roll window and the card: "Advantage: a · b. Disadvantage: c." */
export function reasonsHTML(reasons) {
  const part = (label, list) => list?.length ? `<strong>${label}:</strong> ${list.map(escapeHTML).join(" · ")}` : "";
  const both = reasons?.advantage?.length && reasons?.disadvantage?.length;
  return [part("Advantage", reasons?.advantage), part("Disadvantage", reasons?.disadvantage)].filter(Boolean).join(" &nbsp; ")
    + (both ? ` <span style="opacity:0.75">(they cancel)</span>` : "")
    + (reasons?.ignored?.length ? `${reasons.advantage?.length || reasons.disadvantage?.length ? " &nbsp; " : ""}${part("Ignored", reasons.ignored)}` : "");
}

/** renderAttackRollConfigurationDialog: show the reasons at the top of dnd5e's roll window. */
export function onRenderAttackDialog(app, element) {
  const reasons = app?.message?.data?.flags?.[MODULE_ID]?.[ATTACK_REASONS_FLAG];
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!reasons || !root || root.querySelector(".lda-attack-reasons")) return;
  const note = document.createElement("p");
  note.className = "lda-attack-reasons";
  note.style.cssText = "margin:0 0 6px;font-size:0.9em";
  note.innerHTML = reasonsHTML(reasons);
  (root.querySelector("form") ?? root.querySelector(".window-content") ?? root).prepend(note);
}

/** After the attack: use up marks spent on it (Guiding Bolt). The GM removes what the attacker can't. */
export async function consumeAttackMarks(message) {
  return consumeMarks(message?.getFlag?.(MODULE_ID, ATTACK_REASONS_FLAG)?.consume);
}

/** After a save or check: use up marks spent on it (Silvery Barbs' advantage). */
export async function consumeRollMarks(message) {
  return consumeMarks(message?.getFlag?.(MODULE_ID, SAVE_REASONS_FLAG)?.consume);
}

// Marks being removed on this client: a roll can fire two post-roll hooks (a concentration save).
const consuming = new Set();
async function consumeMarks(uuids = []) {
  for (const uuid of uuids ?? []) {
    if (consuming.has(uuid)) continue;
    consuming.add(uuid);
    try {
      const effect = await fromUuid(uuid);
      if (!effect) continue;
      if (!effect.isOwner) socket?.emit("consumeAttackMark", { uuid });
      // Staggered stays (it still stops opportunity attacks): only its save disadvantage is spent.
      else if (isStaggered(effect)) await effect.setFlag(MODULE_ID, STAGGER_USED, true).catch(() => null);
      else await effect.delete().catch(() => null); // already gone
    } finally { consuming.delete(uuid); }
  }
}

/** GM side: remove a mark a roll used up — only marks this module consumes (Guiding Bolt, Sap, Vex, Studied Attacks, Stunning Strike, Silvery Barbs). */
export async function consumeAttackMarkGM({ uuid }) {
  const effect = await fromUuid(uuid);
  if (!effect) return;
  if (isStaggered(effect)) return effect.setFlag(MODULE_ID, STAGGER_USED, true);
  const mastery = effect.getFlag?.(MODULE_ID, MASTERY_FLAG)?.kind;
  if (sourceItem(effect)?.system?.identifier === "guiding-bolt" || ["sap", "vex", "studied-attacks", "stunning-strike", "silvery-barbs"].includes(mastery)) await effect.delete();
}

/**
 * dnd5e.preRollDamageV2 — the "autoCrits" setting: an attack's damage against
 * creatures that are all Paralyzed or Unconscious, from within 5 ft, is critical.
 * Left to AC5E when it automates statuses (it does the same). Never cancels.
 */
export function onPreRollDamage(config, dialog, message) {
  if (!isAutoCritsEnabled() || config?.isCritical || ac5eCovers().statuses) return;
  const activity = config?.subject;
  if (!isLike(activity, "attack")) return;
  const attacker = doc(activity.getUsageToken?.() ?? activity.actor?.getActiveTokens?.()?.[0]);
  const descriptors = message?.data?.system?.targets;
  const targets = Array.isArray(descriptors) && descriptors.length
    ? descriptors.map(t => { try { return fromUuidSync(t.token, { strict: false }); } catch { return null; } }).filter(t => t?.actor)
    : [...(game.user?.targets ?? [])].map(doc).filter(t => t?.actor);
  if (!attacker || !targets.length) return;
  const helpless = (t) => t.actor.statuses?.has?.("paralyzed") || t.actor.statuses?.has?.("unconscious");
  if (!targets.every(t => helpless(t) && tokenDistance(attacker, t) <= adjacent())) return;
  config.isCritical = true;
  debug(`auto-crit: ${targets.map(t => t.name).join(", ")} helpless within 5 ft`);
}
