// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Other ways to change a d20 roll once it's made, offered beside the Luck Dice.
//
// The "rollBoosts" setting. When an attack misses or a check or save fails, the roller is also
// offered (in the same prompt as the Luck Dice — to creatures without Luck Dice too):
//   Bardic Inspiration — a die a bard gave them (attacks, checks, saves): rolled and added, then gone.
//                        dnd5e 2024's "Inspired" effect marks it; the 2014 feature applies no effect,
//                        so the module marks the creature when the bard uses it on them.
//   Guidance (2014)    — +1d4 to an ability check, then the spell ends. 2024's adds itself (dnd5e).
//   Resistance (2014)  — +1d4 to a save, then the spell ends. 2024's reduces damage instead.
//   Lucky (the feat)   — a Luck Point: roll another d20 and use the higher. When an attack hits the
//                        creature, it can spend one for the attacker to roll another d20 and use the
//                        lower (reactions.mjs — it isn't a reaction).
//   Indomitable        — reroll a failed save (2024: plus the Fighter level); the new roll stands.
// The marks for Bardic Inspiration, Guidance and Resistance go on the targets when they're used,
// through dnd5e's effects tray code (effects.mjs), so nobody has to apply them by hand. Extras that
// replace the roll (Lucky, Indomitable) are offered only before anything has been added to it.

//   Dark One's Own Luck — a Fiend warlock's +1d10 to a check or save, from its uses.
// Offered the same way under other settings: Protection of the Talisman (+1d4 to a failed save;
// "invocations") and Seeking Spell (reroll a missed spell attack's d20; "metamagic").

import { requestApplyEffects } from "./effects.mjs";
import { sourceItem, sourceActor, rulesOf } from "./advantage.mjs";
import { sorceryPoints, spendSorceryPoints, metamagicCost } from "./metamagic.mjs";
import { MODULE_ID, debug, isRollBoostsEnabled, isInvocationsEnabled, isMetamagicEnabled, combineRolls, getKeptD20Result, socket, getPrimaryGM, inAntimagic, antimagicStops } from "./shared.mjs";

export const BOOST_FLAG = "boost";
const BARDIC = "bardic-inspiration";
const SPELLS = { check: { identifier: "guidance", name: "Guidance" }, save: { identifier: "resistance", name: "Resistance" } };

const changesOf = (effect) => effect?.system?.changes ?? effect?.changes ?? [];
const usable = (effect) => !effect.disabled && !effect.isSuppressed;
const showDice = async (roll) => { if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true, null, false); };

/** Uses left on an item with limited uses (Luck Points, Indomitable), or 0. */
export function usesLeft(item) {
  const uses = item?.system?.uses;
  const max = Number(uses?.max);
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, max - (Number(uses.spent) || 0));
}
/** Spend uses of an item (Luck Points, Sorcery Points, an invocation's uses). */
export const spendUses = (item, count = 1) => item.update({ "system.uses.spent": (Number(item.system.uses.spent) || 0) + count });
const spendUse = (item) => spendUses(item, 1);
const itemWithUses = (actor, identifier) =>
  [...(actor?.items ?? [])].find(i => i.system?.identifier === identifier && usesLeft(i) > 0) ?? null;

/** A Bardic Inspiration die from the bard's scale values ("d8"), or d6. */
export function bardicDie(actor) {
  const scale = actor?.system?.scale ?? {};
  for (const values of Object.values(scale)) {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!/inspiration/i.test(key)) continue;
      const die = value?.die ?? value?.formula ?? (typeof value === "string" ? value : null);
      if (typeof die === "string" && /^\d*d\d+$/.test(die)) return die.startsWith("d") ? die : die.replace(/^\d+/, "");
    }
  }
  return "d6";
}

// ── What the creature has ─────────────────────────────────────────────────────

/** The creature's Bardic Inspiration: { effects, die, from } or null. */
export function bardicInspiration(actor) {
  const effects = [...(actor?.effects ?? [])].filter(e => usable(e)
    && (e.getFlag?.(MODULE_ID, BOOST_FLAG)?.kind === "bardic" || sourceItem(e)?.system?.identifier === BARDIC));
  if (!effects.length) return null;
  const mark = effects.map(e => e.getFlag?.(MODULE_ID, BOOST_FLAG)).find(f => f?.die);
  const bard = mark ? null : effects.map(sourceActor).find(Boolean);
  return { effects, die: mark?.die ?? bardicDie(bard), from: mark?.from ?? bard?.name ?? null };
}

/** A 2014 Guidance / Resistance on the creature — the spell's effect, which changes nothing itself. */
export function spellMark(actor, identifier) {
  return [...(actor?.effects ?? [])].find(e => usable(e) && !changesOf(e).length && sourceItem(e)?.system?.identifier === identifier) ?? null;
}

/** The Lucky feat with Luck Points left. (The halfling trait shares its identifier but has no uses; dnd5e handles it.) */
export const luckyFeat = (actor) => itemWithUses(actor, "lucky");

// ── Changing the roll ─────────────────────────────────────────────────────────

/**
 * A copy of the roll with one more d20 rolled into it: used if it's higher ("higher") or lower
 * ("lower") than the d20 the roll uses, otherwise shown as discarded. Null without a d20.
 */
export function withExtraD20(roll, value, keep = "higher") {
  if (typeof roll?.toJSON !== "function" || typeof roll.constructor?.fromData !== "function") return null;
  const copy = roll.constructor.fromData(roll.toJSON());
  const die = [copy.d20, ...(copy.dice ?? [])].find(d => d?.faces === 20 && Array.isArray(d.results));
  if (!die?.results?.length) return null;
  const kept = die.results.filter(r => r.active !== false).map(r => r.result);
  const current = kept.length ? (keep === "higher" ? Math.max(...kept) : Math.min(...kept)) : null;
  const used = current === null || (keep === "higher" ? value > current : value < current);
  if (used) for (const r of die.results) if (r.active !== false) Object.assign(r, { active: false, discarded: true });
  die.results.push(used ? { result: value, active: true } : { result: value, active: false, discarded: true });
  copy._total = copy._evaluateTotal();
  return copy;
}

async function rollOne(formula) {
  const roll = await new Roll(formula).evaluate();
  await showDice(roll);
  return roll;
}

/** Reroll a save the way it was rolled (same advantage mode), plus a flat bonus. */
async function rerollWithBonus(roll, bonus) {
  const D20Roll = CONFIG.Dice.D20Roll;
  let again = (D20Roll && roll instanceof D20Roll)
    ? new D20Roll(roll.formula, roll.data ?? {}, { ...foundry.utils.deepClone(roll.options), configured: false })
    : new Roll(roll.formula, roll.data ?? {});
  again = await again.evaluate();
  await showDice(again);
  if (bonus) again = combineRolls(again, await new Roll(String(bonus)).evaluate());
  return again;
}

/** Remove effects from the roller's own creature (it owns them), or have the GM do it. */
async function removeEffects(effects) {
  for (const effect of effects) {
    if (effect.isOwner) await effect.delete();
    else socket?.emit("consumeBoost", { uuid: effect.uuid });
  }
}

/** A used Guidance / Resistance: the spell ends — its caster's concentration, which takes the mark with it. */
async function endSpell(mark) {
  const caster = sourceActor(mark), item = sourceItem(mark);
  if (caster?.isOwner && item) await caster.endConcentration?.(item);
  else if (caster && item) socket?.emit("endBoostSpell", { caster: caster.uuid, item: item.uuid });
  if (mark.parent?.effects?.get?.(mark.id)) await removeEffects([mark]);
}

/**
 * What this creature could use on this roll (kind: "attack", "check" or "save"; `spell`: a spell's
 * attack), as prompt extras — each under its own setting.
 */
export function boostsFor(actor, kind, { spell: spellAttack = false } = {}) {
  const boosts = [...invocationAndMetamagicBoosts(actor, kind, { spell: spellAttack })];
  if (!isRollBoostsEnabled()) return boosts;
  const bardic = bardicInspiration(actor);
  if (bardic) boosts.push({
    id: "bardic", label: `Bardic Inspiration (+1${bardic.die})`,
    async use() {
      const bonusRoll = await rollOne(`1${bardic.die}`);
      await removeEffects(bardic.effects);
      return { bonusRoll, label: `Added 1${bardic.die} Bardic Inspiration`, detail: `+${bonusRoll.total}${bardic.from ? ` from ${bardic.from}` : ""}` };
    }
  });
  const spell = SPELLS[kind];
  const mark = spell && !inAntimagic(actor) ? spellMark(actor, spell.identifier) : null; // dnd5e 6.1+: suppressed there
  if (mark) boosts.push({
    id: spell.identifier, label: `${spell.name} (+1d4)`,
    async use() {
      const bonusRoll = await rollOne("1d4");
      await endSpell(mark);
      return { bonusRoll, label: `Added 1d4 ${spell.name}`, detail: `+${bonusRoll.total}` };
    }
  });
  const lucky = luckyFeat(actor);
  if (lucky) boosts.push({
    id: "lucky", replaces: true, label: `Lucky: roll another d20 (${usesLeft(lucky)} left)`,
    async use(roll) {
      const extra = await rollOne("1d20");
      const better = withExtraD20(roll, extra.total, "higher");
      if (!better) return null;
      await spendUse(lucky);
      return { roll: better, label: "Lucky: another d20", detail: `d20: ${extra.total}${getKeptD20Result(better) === extra.total ? " (used)" : " (kept the first)"}` };
    }
  });
  // Dark One's Own Luck (Warlock, Fiend Patron): +1d10 to a check or save, from its uses (2014: once a short rest;
  // 2024: the Charisma modifier a long rest) — once per roll, as each extra is.
  const luck = kind === "check" || kind === "save" ? [...(actor?.items ?? [])].find(i => i.system?.identifier === "dark-ones-own-luck") : null;
  if (luck && usesLeft(luck) > 0 && !antimagicStops(actor, luck)) boosts.push({
    id: "dark-ones-own-luck", label: `Dark One's Own Luck (+1d10, ${usesLeft(luck)} left)`,
    async use() {
      const bonusRoll = await rollOne("1d10");
      await spendUse(luck);
      return { bonusRoll, label: "Added 1d10 Dark One's Own Luck", detail: `+${bonusRoll.total}` };
    }
  });
  // Tactical Mind (2024 Fighter 2): +1d10 to a failed ability check from a Second Wind use — spent only if it
  // turns the check into a success.
  const tactical = kind === "check" && [...(actor?.items ?? [])].some(i => i.system?.identifier === "tactical-mind")
    ? itemWithUses(actor, "second-wind") : null;
  if (tactical) boosts.push({
    id: "tactical-mind", label: `Tactical Mind (+1d10, a Second Wind use if it succeeds; ${usesLeft(tactical)} left)`,
    async use(roll) {
      const bonusRoll = await rollOne("1d10");
      const dc = Number(roll?.options?.target);
      const succeeds = Number.isFinite(dc) && Number(roll?.total ?? 0) + bonusRoll.total >= dc;
      if (succeeds) await spendUse(tactical);
      return { bonusRoll, label: "Added 1d10 Tactical Mind", detail: `+${bonusRoll.total}${succeeds ? " (a Second Wind use spent)" : " (still failed: no use spent)"}` };
    }
  });
  // Stroke of Luck (Rogue 20): the d20 becomes a 20 — 2024 any D20 Test; 2014 a missed attack or a failed check.
  const stroke = itemWithUses(actor, "stroke-of-luck");
  if (stroke && (rulesOf(stroke) !== "2014" || kind !== "save")) boosts.push({
    id: "stroke-of-luck", replaces: true, label: `Stroke of Luck: the d20 becomes a 20 (${usesLeft(stroke)} left)`,
    async use(roll) {
      const twenty = withExtraD20(roll, 20, "higher");
      if (!twenty) return null;
      await spendUse(stroke);
      return { roll: twenty, label: "Stroke of Luck: a 20", detail: "d20: 20" };
    }
  });
  const indomitable = kind === "save" ? itemWithUses(actor, "indomitable") : null;
  if (indomitable) {
    const bonus = rulesOf(indomitable) === "2024" ? Number(actor.classes?.fighter?.system?.levels ?? 0) || 0 : 0;
    boosts.push({
      id: "indomitable", replaces: true, label: `Indomitable: reroll${bonus ? ` +${bonus}` : ""} (${usesLeft(indomitable)} left)`,
      async use(roll) {
        const again = await rerollWithBonus(roll, bonus);
        await spendUse(indomitable);
        return { roll: again, label: `Rerolled with Indomitable${bonus ? ` (+${bonus})` : ""}`, detail: `d20: ${getKeptD20Result(again) ?? "?"}` };
      }
    });
  }
  return boosts;
}

/** Protection of the Talisman (failed saves) and Seeking Spell (missed spell attacks). */
function invocationAndMetamagicBoosts(actor, kind, { spell }) {
  const boosts = [];
  const talisman = kind === "save" && isInvocationsEnabled()
    ? [...(actor?.items ?? [])].find(i => i.system?.identifier === "protection-of-the-talisman") : null;
  // dnd5e 6.1+: in antimagic, not a Magical invocation, nor Seeking Spell (no spell attacks there).
  if (talisman && !antimagicStops(actor, talisman) && (!talisman.system?.uses?.max || usesLeft(talisman) > 0)) boosts.push({
    id: "talisman", label: "Protection of the Talisman (+1d4)",
    async use() {
      const bonusRoll = await rollOne("1d4");
      if (talisman.system?.uses?.max) await spendUse(talisman);
      return { bonusRoll, label: "Added 1d4 Protection of the Talisman", detail: `+${bonusRoll.total}` };
    }
  });
  const seeking = kind === "attack" && spell && isMetamagicEnabled() && !inAntimagic(actor)
    ? [...(actor?.items ?? [])].find(i => i.system?.identifier === "seeking-spell") : null;
  const cost = seeking ? metamagicCost("seeking", seeking) : 0;
  if (seeking && sorceryPoints(actor) >= cost) boosts.push({
    id: "seeking", replaces: true, label: `Seeking Spell: reroll (${cost} Sorcery Point${cost === 1 ? "" : "s"})`,
    async use(roll) {
      const again = await rerollWithBonus(roll, 0);
      await spendSorceryPoints(actor, cost);
      return { roll: again, label: "Rerolled with Seeking Spell", detail: `d20: ${getKeptD20Result(again) ?? "?"}` };
    }
  });
  return boosts;
}

/**
 * The extras for the shared prompts (see promptLuckOnCheckFail) — each usable once per roll —
 * or null when the creature has none (each kind is under its own setting).
 */
export function rollExtras(actor, kind, context = {}) {
  if (!actor) return null;
  const used = new Set();
  const list = () => boostsFor(actor, kind, context).filter(b => !used.has(b.id));
  if (!list().length) return null;
  return {
    // Replacing the roll would undo what was added; adding can't fix a natural 1 on an attack.
    options: ({ added = false, autoMiss = false } = {}) => list()
      .filter(b => b.replaces ? !added : !autoMiss)
      .map(b => ({ action: `boost:${b.id}`, label: b.label })),
    handles: (action) => typeof action === "string" && action.startsWith("boost:"),
    async run(action, roll) {
      const boost = list().find(b => `boost:${b.id}` === action);
      if (!boost) return null;
      used.add(boost.id);
      try {
        const out = await boost.use(roll);
        if (out) console.log(`[${MODULE_ID}] ${actor.name}: ${out.label} (${out.detail})`);
        return out;
      } catch (err) {
        console.error(`[${MODULE_ID}] ${boost.id}:`, err);
        return null;
      }
    }
  };
}

/** Lucky against an attack: spend a Luck Point and roll the d20. Resolves with its result, or null. */
export async function useLuckyAgainst(actor) {
  const lucky = luckyFeat(actor);
  if (!lucky) return null;
  await spendUse(lucky);
  return (await rollOne("1d20")).total;
}

// ── Marking the creature when it's given ──────────────────────────────────────

/** The module's mark for a 2014 Bardic Inspiration die (that feature applies no effect of its own). */
export function bardicMark({ die, from, item, img }) {
  return {
    name: `Bardic Inspiration (${die})`, img: img ?? "icons/svg/sound.svg", type: "base", origin: item ?? null,
    transfer: false, disabled: false, duration: { value: 600, units: "seconds" }, system: { changes: [] },
    flags: { [MODULE_ID]: { [BOOST_FLAG]: { kind: "bardic", die, from } } }
  };
}

/** Put a 2014 Bardic Inspiration mark on a creature (one die at a time) — as its owner, or the GM. */
export async function markBardicGM({ actor: actorUuid, die, from, item, img }) {
  if (!/^d\d+$/.test(String(die))) return;
  const actor = await fromUuid(actorUuid);
  if (!actor?.createEmbeddedDocuments) return;
  const old = [...actor.effects].filter(e => e.getFlag?.(MODULE_ID, BOOST_FLAG)?.kind === "bardic").map(e => e.id);
  if (old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old);
  await actor.createEmbeddedDocuments("ActiveEffect", [bardicMark({ die, from: String(from ?? ""), item, img })]);
}

/**
 * dnd5e.postUseActivity (the user's client): a bard's Bardic Inspiration, or a 2014 Guidance /
 * Resistance, marks the creatures targeted — dnd5e's effect where the activity has one, the module's
 * mark for 2014 Bardic Inspiration. 2024 Guidance and Resistance (an effect per skill or damage type)
 * are left to dnd5e's effects tray.
 */
export async function markBoostTargets(activity, results) {
  if (!isRollBoostsEnabled() || !activity?.actor?.isOwner) return;
  const item = activity.item, identifier = item?.system?.identifier;
  if (![BARDIC, "guidance", "resistance"].includes(identifier)) return;
  const targets = [...(game.user?.targets ?? [])].map(t => t.document ?? t)
    .filter(t => t?.actor && (identifier !== BARDIC || t.actor !== activity.actor));
  if (!targets.length) return;
  const usage = results?.message;
  const effects = (await usage?.system?.getEffects?.()) ?? [];
  if (identifier !== BARDIC && (effects.length !== 1 || changesOf(effects[0]).length)) return;
  if (effects.length) {
    await requestApplyEffects(usage, targets.map(t => ({ actor: t.actor.uuid, token: t.uuid, name: t.name, effectIds: effects.map(e => e.id) })));
  } else {
    const data = { die: bardicDie(activity.actor), from: activity.actor.name, item: item.uuid, img: item.img };
    for (const t of targets) {
      if (t.actor.isOwner) await markBardicGM({ ...data, actor: t.actor.uuid });
      else if (socket && getPrimaryGM()) socket.emit("markBardic", { ...data, actor: t.actor.uuid });
    }
  }
  debug(`roll boosts: ${item.name} marked ${targets.map(t => t.name).join(", ")}`);
}

/** GM side: remove a used boost's mark — only Bardic Inspiration, Guidance and Resistance marks. */
export async function consumeBoostGM({ uuid }) {
  const effect = await fromUuid(uuid);
  if (!effect) return;
  const identifier = sourceItem(effect)?.system?.identifier;
  if (effect.getFlag?.(MODULE_ID, BOOST_FLAG) || [BARDIC, "guidance", "resistance"].includes(identifier)) await effect.delete();
}

/** GM side: a used Guidance / Resistance ends its caster's concentration on it. */
export async function endBoostSpellGM({ caster: casterUuid, item: itemUuid }) {
  const caster = await fromUuid(casterUuid), item = await fromUuid(itemUuid);
  if (!caster?.endConcentration || !item || item.actor !== caster) return;
  if (!["guidance", "resistance"].includes(item.system?.identifier)) return;
  await caster.endConcentration(item);
}
