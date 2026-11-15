// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Sculpt Spells and Potent Cantrip (Wizard, School of Evocation; 2014 and 2024).
//
// Potent Cantrip: a damaging cantrip's target that succeeds on its save takes half its damage, and no
// other effect (saves.mjs, the "saveRules" setting); 2024 also when the cantrip's attack misses (attacks.mjs,
// the "attackAdvantage" setting, when the attack automation rolls the damage).
//
// Sculpt Spells, under the "saveRules" setting.
//
// When the save automation rolls the saves for an Evocation spell cast by a wizard with
// Sculpt Spells, and an ally of the caster is among the creatures saving, the caster
// picks up to 1 + the spell's level (the level it was cast at) of the creatures it can
// see — its allies ticked. Those creatures succeed on the save without rolling, and take
// no damage where a success means half (saves.mjs). It combines with Careful Spell: a
// creature Careful Spell already protects isn't offered again. What it did is noted on
// the spell's card.

import { hasLineOfSight } from "./advantage.mjs";
import { pickCreatures } from "./targeting.mjs";
import { rulesOf } from "./advantage.mjs";
import { MODULE_ID, debug, isSaveRulesEnabled, isAttackAdvantageEnabled, resolveTarget } from "./shared.mjs";

export const SCULPT_FLAG = "sculptSpells"; // on the spell's card: { text }

const feature = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;

/** The caster's Potent Cantrip, when this activity is one of its cantrips (a spell of level 0). */
function potentCantripOf(activity) {
  const item = activity?.item;
  if (item?.type !== "spell" || (Number(item.system?.level) || 0) !== 0) return null;
  return feature(activity?.actor, "potent-cantrip");
}

/** Potent Cantrip on a cantrip's save: a success takes half the damage (with the "saveRules" setting). */
export function potentCantripSave(activity) {
  return isSaveRulesEnabled() && !!potentCantripOf(activity);
}

/** 2024 Potent Cantrip on a cantrip's attack: a miss takes half the damage (with the "attackAdvantage" setting). */
export function potentCantripMiss(activity) {
  const item = potentCantripOf(activity);
  return isAttackAdvantageEnabled() && !!item && rulesOf(item) !== "2014";
}

/** The level a spell was cast at: its own, plus the upcast dnd5e records on the card. */
export function castLevelOf(item, usage) {
  return (Number(item?.system?.level) || 0) + (Number(usage?.system?.scaling) || Number(item?.flags?.dnd5e?.scaling) || 0);
}

/** Whether Sculpt Spells can shape this activity: an Evocation spell, cast by a creature with the feature. */
export function sculptsSpell(activity) {
  const item = activity?.item;
  return isSaveRulesEnabled() && item?.type === "spell" && item.system?.school === "evo" && !!feature(activity?.actor, "sculpt-spells");
}

/**
 * Before the saves are rolled (on the caster's client): the creatures the caster sculpts the spell around.
 * `exclude`: token uuids already protected (Careful Spell). Resolves with a Set of token uuids.
 */
export async function chooseSculpted(activity, targets, usage, { exclude = new Set() } = {}) {
  const out = new Set();
  if (!sculptsSpell(activity) || !targets?.length) return out;
  const me = activity.getUsageToken?.()?.document ?? activity.actor?.getActiveTokens?.()?.[0]?.document ?? null;
  if (!me) return out;
  const tokens = [];
  for (const target of targets) {
    const tokenDoc = (await resolveTarget(target)).tokenDoc;
    if (!tokenDoc || tokenDoc.uuid === me.uuid || exclude.has(tokenDoc.uuid)) continue;
    if (!hasLineOfSight(me, tokenDoc)) continue; // creatures the caster can see
    tokens.push(tokenDoc);
  }
  // Only worth asking when an ally is caught in it.
  if (!tokens.some(t => t.disposition === me.disposition)) return out;
  const max = 1 + castLevelOf(activity.item, usage);
  const picked = await pickCreatures("Sculpt Spells",
    `Choose up to ${max} creature${max === 1 ? "" : "s"} to shape ${activity.item?.name ?? "the spell"} around: they succeed on the save, and take no damage where a success means half.`,
    tokens, { max, checked: (t) => t.disposition === me.disposition });
  for (const t of picked ?? []) out.add(t.uuid);
  if (out.size) {
    const text = `${(picked ?? []).map(t => t.name).join(", ")} succeed${out.size === 1 ? "s" : ""} on the save and take${out.size === 1 ? "s" : ""} no damage where a success means half`;
    if (usage?.setFlag) await usage.setFlag(MODULE_ID, SCULPT_FLAG, { text }).catch(() => null);
    debug(`sculpt spells: ${activity.actor?.name} — ${text}`);
  }
  return out;
}
