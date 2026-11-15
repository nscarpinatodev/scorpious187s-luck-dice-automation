// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Countercharm (Bard).
//
//   2014 (Bard 6, the "saveRules" setting) — as an action, a performance until the end of the bard's
//        next turn: the bard and friendly creatures within 30 ft that can hear it (not Deafened) have
//        Advantage on saves against being Frightened or Charmed. Using the feature puts a mark on the
//        bard for that long; the save rules read it (save-rules.mjs). It ends early if the bard is
//        Incapacitated.
//   2024 (Bard 7, the "reactionPrompts" setting) — a reaction: when the bard or a creature within 30 ft
//        fails a save against an effect that applies Charmed or Frightened, the save is rerolled with
//        Advantage (checks.mjs, before the roller's Luck Dice). The bard is asked like any reaction.
// What a save is against is read from the statuses its activity applies (save-rules.mjs notes them on the
// save's card as it's rolled).

import { askReaction, hasReaction, asksFor } from "./reactions.mjs";
import { tokenDistance, rulesOf } from "./advantage.mjs";
import { MODULE_ID, debug, getReactionPrompts, isSaveRulesEnabled, LDA } from "./shared.mjs";

export const PERFORMANCE_FLAG = "countercharm"; // on the 2014 bard: its performance is under way
const MIND = ["charmed", "frightened"];
const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];
const feature = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;
const incapacitated = (actor) => INCAPACITATING.some(s => actor?.statuses?.has?.(s));
const doc = (token) => token?.document ?? token ?? null;

/** Whether a save is against being Charmed or Frightened (the statuses its activity applies). */
export const againstMind = (statuses) => MIND.filter(s => statuses?.has?.(s) || (Array.isArray(statuses) && statuses.includes(s)));

// ── 2014: the performance ─────────────────────────────────────────────────────

/** The mark on a bard performing Countercharm: until the end of its next turn. */
export const performanceEffect = (actor) => ({
  name: "Countercharm (performing)", img: "icons/svg/sound.svg", type: "base", origin: actor?.uuid ?? null,
  transfer: false, disabled: false, duration: { value: 1, units: "rounds", expiry: "turnEnd" },
  system: { changes: [] }, flags: { [MODULE_ID]: { [PERFORMANCE_FLAG]: true } }
});

/** dnd5e.postUseActivity (the bard's client): 2014 Countercharm used — the performance starts. */
export async function onCountercharmUsed(activity) {
  const item = activity?.item, actor = activity?.actor;
  if (!isSaveRulesEnabled() || item?.system?.identifier !== "countercharm" || rulesOf(item) !== "2014" || !actor?.isOwner) return;
  const old = [...(actor.effects ?? [])].filter(e => e.getFlag?.(MODULE_ID, PERFORMANCE_FLAG)).map(e => e.id);
  if (old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old);
  await actor.createEmbeddedDocuments("ActiveEffect", [performanceEffect(actor)]);
  debug(`countercharm: ${actor.name} is performing`);
}

/**
 * 2014 Countercharm over a creature's save against being Charmed or Frightened: the performing bard's name
 * (the creature itself, or a friendly bard within 30 ft it can hear), or null.
 */
export function countercharmFor(actor, tokenDoc, statuses) {
  if (!againstMind(statuses).length || actor?.statuses?.has?.("deafened")) return null;
  const me = doc(tokenDoc ?? actor?.getActiveTokens?.()?.[0]);
  const performing = (a) => !incapacitated(a) && [...(a?.effects ?? [])].some(e => !e.disabled && e.getFlag?.(MODULE_ID, PERFORMANCE_FLAG));
  if (performing(actor)) return me?.name ?? actor.name;
  if (!me?.parent) return null;
  for (const t of me.parent.tokens ?? []) {
    if (t.id === me.id || !t.actor || !t.disposition || t.disposition !== me.disposition) continue;
    if (performing(t.actor) && tokenDistance(t, me) <= 30) return t.name;
  }
  return null;
}

// ── 2024: the reaction ────────────────────────────────────────────────────────

/** Whether this creature can use 2024 Countercharm now (asked under the setting). */
function canCountercharm(actor, mode) {
  const item = feature(actor, "countercharm");
  return !!item && rulesOf(item) !== "2014" && asksFor(actor, mode) && hasReaction(actor) && !incapacitated(actor);
}

/**
 * A failed save against being Charmed or Frightened (checks.mjs, on the roller's client): the roller, then
 * bards within 30 ft on its side, are asked in turn. Resolves with { roll (the better of two), by } or null.
 */
export async function offerCountercharm(message, roll, actor, statuses, tokenDoc) {
  const mode = getReactionPrompts();
  const against = againstMind(statuses);
  if (mode === "off" || !against.length || !roll || !actor) return null;
  const me = doc(tokenDoc ?? actor.getActiveTokens?.()?.[0]);
  const bards = [];
  if (canCountercharm(actor, mode)) bards.push(me ?? { actor, uuid: null, name: actor.name });
  for (const t of me?.parent?.tokens ?? []) {
    if (t.id === me.id || !t.actor || !t.disposition || t.disposition !== me.disposition) continue;
    if (canCountercharm(t.actor, mode) && tokenDistance(t, me) <= 30) bards.push(t);
  }
  const dc = Number(roll.options?.target);
  for (const bard of bards) {
    const answer = await askReaction(bard.actor, { token: bard.uuid, actor: bard.actor.uuid, options: ["countercharm"], when: "failedSave",
      targetName: me?.name ?? actor.name, total: Number(roll.total ?? 0), ac: dc, rollType: `saving throw against being ${against.join(" or ")}` });
    if (answer?.identifier !== "countercharm") continue;
    // Rerolled with Advantage: two new d20s, the better kept.
    const [first, second] = [await LDA.evaluateReroll(roll), await LDA.evaluateReroll(roll)];
    const better = !second || Number(first?.total) >= Number(second.total) ? first : second;
    return better ? { roll: better, by: answer.by, faces: [first, second].filter(Boolean).map(r => LDA.getKeptD20Result?.(r) ?? "?") } : null;
  }
  return null;
}
