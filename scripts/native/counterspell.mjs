// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Counterspell (2014 and 2024), under the "reactionPrompts" setting.
//
// dnd5e's hooks around a use are synchronous, so nothing can wait on a prompt in them. Its
// activity.consume() is awaited, though — after the casting window (the slot is known), before
// anything is spent or posted. Each activity type's consume is wrapped: for a spell with Verbal,
// Somatic or Material components (not one cast with Subtle Spell), the caster's enemies within
// 60 ft who can see it, have a reaction, Counterspell and a 3rd-level slot (or it innate) are
// asked in turn. Whoever says yes casts it through dnd5e (its window picks the slot) on their own
// client, and it's resolved there:
//   2024 — the caster makes a Constitution save against the counterspeller's spell save DC
//          (rolled like the module's other requested saves: Luck Dice, Legendary Resistance).
//          A failure: the spell dissipates and its slot isn't spent.
//   2014 — a spell of the Counterspell's slot level or lower is countered; a higher one needs
//          the counterspeller's spellcasting ability check against DC 10 + its level (Luck Dice
//          on a failure). Countered: the spell fails, and its slot is still spent.
// A countered spell's use stops there (whatever cast it gets nothing back, as when its window is
// cancelled), and a card says what happened. Reaction spells cast from the module's own reaction
// prompts (Shield, Counterspell itself…) aren't offered: the prompt that asked for them is waiting.

import { askReaction, hasReaction, spendReaction, asksFor } from "./reactions.mjs";
import { tokenDistance, hasLineOfSight, rulesOf } from "./advantage.mjs";
import { useClaimed } from "./riders.mjs";
import { requestSaves, saveOf } from "./saves.mjs";
import { MODULE_ID, debug, escapeHTML, promptChoice, getReactionPrompts, activePlayerOwner, resolveTarget, pendingLuckChecks, antimagicStops, isLike } from "./shared.mjs";

const INCAPACITATING = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "dead"];
const COMPONENTS = ["vocal", "somatic", "material"];
const PATCHED = Symbol.for(`${MODULE_ID}.counterspell`);

const tokenOf = (token) => token?.document ?? token ?? null;
const activitiesOf = (item) => [...(item?.system?.activities?.values?.() ?? [])];
export const counterspellOf = (actor) => actor?.items?.find?.(i => i.type === "spell" && i.system?.identifier === "counterspell") ?? null;

/** Whether a creature can cast its Counterspell: a slot of 3rd level or higher (pact too), or it's innate / at will with uses left. */
export function canCastCounterspell(actor, item = counterspellOf(actor)) {
  if (!item) return false;
  const method = item.system?.method ?? item.system?.preparation?.mode;
  if (["innate", "atwill"].includes(method)) return !item.system?.uses?.max || (Number(item.system.uses.value) || 0) > 0;
  return Object.entries(actor?.system?.spells ?? {}).some(([key, slot]) =>
    (Number(slot?.value) || 0) > 0 && (Number(slot?.level ?? key.replace("spell", "")) || 0) >= 3);
}

/** Whether this use can be counterspelled: a spell with components, cast in the open. */
export function counterable(activity, usageConfig = {}) {
  const item = activity?.item;
  if (item?.type !== "spell" || usageConfig?.[MODULE_ID]?.noCounter) return false;
  if (usageConfig?.ldaMetamagic?.choice === "subtle") return false;
  const properties = item.system?.properties;
  return COMPONENTS.some(c => properties?.has?.(c) || (Array.isArray(properties) && properties.includes(c)));
}

/** The creatures that could counter this caster's spell, nearest first. */
export function counterspellers(casterDoc, mode = getReactionPrompts()) {
  if (!casterDoc?.parent || !casterDoc.disposition || mode === "off") return [];
  return [...(casterDoc.parent.tokens ?? [])].filter(t => {
    const actor = t.actor;
    if (!actor || t.id === casterDoc.id || t.disposition !== -casterDoc.disposition) return false;
    if (INCAPACITATING.some(s => actor.statuses?.has?.(s)) || !asksFor(actor, mode) || !hasReaction(actor)) return false;
    const item = counterspellOf(actor);
    if (!item || !canCastCounterspell(actor, item) || antimagicStops(actor, item)) return false;
    return tokenDistance(t, casterDoc) <= 60 && hasLineOfSight(t, casterDoc);
  }).sort((a, b) => tokenDistance(a, casterDoc) - tokenDistance(b, casterDoc));
}

/**
 * Before a spell's use spends anything (the caster's client): ask whoever could counter it.
 * Resolves with { countered, by, rules, how } — `countered` false when nobody did — or null when nobody was asked.
 */
export async function checkCounterspell(activity, usageConfig = {}) {
  if (!counterable(activity, usageConfig)) return null;
  const casterDoc = tokenOf(activity.getUsageToken?.() ?? activity.actor?.getActiveTokens?.()?.[0]);
  const candidates = counterspellers(casterDoc);
  if (!candidates.length) return null;
  const level = (Number(activity.item.system?.level) || 0) + (Number(usageConfig?.scaling) || 0);
  let last = { countered: false };
  for (const t of candidates) {
    const answer = await askReaction(t.actor, {
      kind: "counterspell", token: t.uuid, actor: t.actor.uuid, casterToken: casterDoc.uuid, casterActor: activity.actor?.uuid,
      casterName: casterDoc.name, spellName: activity.item.name, level
    });
    if (answer?.identifier !== "counterspell") continue;
    last = answer;
    if (answer.countered) break;
  }
  return last;
}

/** On the counterspeller's client (reactions.mjs's answerReaction): offer it, cast it, and resolve it. */
export async function answerCounterspell(payload) {
  const { token, actor: actorUuid, casterToken, casterActor: casterActorUuid, casterName, spellName, level = 0 } = payload ?? {};
  const { tokenDoc, actor } = await resolveTarget({ token, actor: actorUuid });
  const item = counterspellOf(actor);
  if (!actor?.isOwner || !item || !hasReaction(actor)) return null;
  const name = tokenDoc?.name ?? actor.name;
  const choice = await promptChoice("Counterspell",
    `<p><strong>${escapeHTML(casterName ?? "A creature")}</strong> is casting <strong>${escapeHTML(spellName ?? "a spell")}</strong>
     (${level ? `level ${level}` : "a cantrip"}). Use ${escapeHTML(name)}'s reaction to cast Counterspell?</p>`,
    [{ action: "counter", label: "Counterspell" }, { action: "none", label: "No Reaction" }]);
  if (choice !== "counter" || !hasReaction(actor)) return null;

  const rules = rulesOf(item);
  const activity = activitiesOf(item).find(a => isLike(a, rules === "2014" ? "check" : "save")) ?? activitiesOf(item)[0];
  if (!activity) return null;
  const casterDoc = casterToken ? await fromUuid(casterToken) : null;
  const casterActor = casterDoc?.actor ?? (casterActorUuid ? await fromUuid(casterActorUuid) : null);
  // Cast through dnd5e at the caster (its window picks the slot); the module resolves it here, not its usual follow-ups.
  const previous = [...(game.user?.targets ?? [])].map(t => t.id);
  if (casterDoc && canvas?.scene === casterDoc.parent) canvas.tokens?.setTargets?.([casterDoc.id], { mode: "replace" });
  let results;
  try { results = await useClaimed(activity, { [MODULE_ID]: { noCounter: true } }, {}); }
  finally { canvas?.tokens?.setTargets?.(previous, { mode: "replace" }); }
  if (!results) return null;
  await spendReaction(actor);

  let countered = false, how;
  if (rules === "2014") {
    const slotLevel = 3 + (Number(results.message?.system?.scaling) || 0);
    if (level <= slotLevel) {
      countered = true;
      how = `${level ? `a level ${level} spell` : "a cantrip"} against a level ${slotLevel} Counterspell`;
    } else {
      const dc = 10 + level;
      const ability = actor.system?.attributes?.spellcasting || "int";
      const rolls = await actor.rollAbilityCheck?.({ ability, target: dc }, { configure: false }, {});
      const message = rolls?.[0]?.parent;
      if (message) await pendingLuckChecks.get(message.id); // its Luck Dice
      const final = message?.rolls?.[0] ?? rolls?.[0];
      countered = Number(final?.total) >= dc;
      how = `${CONFIG.DND5E?.abilities?.[ability]?.label ?? ability.toUpperCase()} check ${final?.total ?? "?"} vs DC ${dc}`;
    }
  } else {
    const dc = saveOf(activity)?.dc;
    const [save] = (Number.isFinite(dc) && casterActor ? await requestSaves(activePlayerOwner(casterActor)?.id ?? null, {
      activityUuid: activity.uuid, activityName: "Counterspell", casterName: name, usageId: results.message?.id ?? null,
      ability: "con", dc, targets: [{ actor: casterActor.uuid, token: casterDoc?.uuid ?? null, name: casterName }], prompt: false
    }) : []) ?? [];
    if (save?.result) {
      countered = !save.result.passed;
      how = `Constitution save ${save.result.total ?? "?"} vs DC ${dc}`;
    } else how = "no Constitution save was rolled";
  }
  return { identifier: "counterspell", countered, by: name, rules, how };
}

/** The card for the result, from the caster. */
async function postResult(activity, verdict) {
  const spell = escapeHTML(activity.item?.name ?? "The spell");
  const text = verdict.countered
    ? `<strong>${spell}</strong> is countered by ${escapeHTML(verdict.by)}'s Counterspell (${escapeHTML(verdict.how)}). ` +
      (verdict.rules === "2014" ? "The spell fails and has no effect; its slot is spent." : "It dissipates with no effect; a spell slot isn't spent.")
    : `${escapeHTML(verdict.by)}'s Counterspell fails (${escapeHTML(verdict.how)}): <strong>${spell}</strong> goes ahead.`;
  try {
    await (ChatMessage.implementation ?? ChatMessage).create({
      speaker: ChatMessage.getSpeaker({ actor: activity.actor }), content: `<p><i class="fa-solid fa-ban"></i> ${text}</p>`
    });
  } catch (err) { console.error(`[${MODULE_ID}] counterspell card:`, err); }
}

/** Wrap each activity type's consume (once per prototype chain): a counterspelled spell stops there. */
export function installCounterspell(types = CONFIG.DND5E?.activityTypes) {
  for (const config of Object.values(types ?? {})) {
    const proto = config?.documentClass?.prototype;
    const original = proto?.consume;
    if (typeof original !== "function" || original[PATCHED]) continue;
    const wrapped = async function (usageConfig, messageConfig) {
      let verdict = null;
      try { verdict = await checkCounterspell(this, usageConfig); }
      catch (err) { console.error(`[${MODULE_ID}] counterspell:`, err); }
      if (verdict?.by) await postResult(this, verdict);
      if (!verdict?.countered) return original.call(this, usageConfig, messageConfig);
      // 2014: the slot is spent all the same. 2024: nothing is.
      if (verdict.rules === "2014") await original.call(this, usageConfig, messageConfig);
      debug(`counterspell: ${this.item?.name} countered by ${verdict.by}`);
      return false;
    };
    wrapped[PATCHED] = true;
    Object.defineProperty(proto, "consume", { configurable: true, writable: true, value: wrapped });
  }
}
