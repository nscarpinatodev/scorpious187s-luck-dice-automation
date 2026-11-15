// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Sanctuary (2014 and 2024), under the "saveRules" setting.
//
// A creature warded by Sanctuary (the spell's effect on it): whoever targets it with an attack roll or a damaging
// spell first makes a Wisdom save against the spell's DC (rolled like the module's other requested saves: Luck
// Dice, Legendary Resistance). On a failure the warded creature is dropped from its targets — with no target left,
// the attack is lost (a spell is lost too, its slot spent).
//   attacks — each attack activity's rollAttack is wrapped, so any attack roll (dnd5e's button, the module's
//             own: Cleave, rays, opportunity attacks) waits for the save;
//   spells  — a damaging spell, at the point dnd5e spends its slot (activity.consume, as Counterspell waits).
// The ward ends when the warded creature makes an attack roll, casts a spell, or deals damage (2014: attacks or
// casts a spell that affects an enemy) — its effect is removed.

import { requestSaves, saveOf } from "./saves.mjs";
import { effectsFrom, sourceItem, removeMark } from "./advantage.mjs";
import { MODULE_ID, debug, activePlayerOwner, isSaveRulesEnabled, isLike } from "./shared.mjs";

const PATCHED = Symbol.for(`${MODULE_ID}.sanctuary`);
const doc = (token) => token?.document ?? token ?? null;
const activitiesOf = (item) => [...(item?.system?.activities?.values?.() ?? [])];

/** A creature's Sanctuary ward: { effect, dc } (its spell's save DC), or null. */
export function wardOf(actor) {
  const effect = effectsFrom(actor, "sanctuary")[0];
  if (!effect) return null;
  const save = activitiesOf(sourceItem(effect)).find(a => isLike(a, "save"));
  const dc = saveOf(save)?.dc;
  return Number.isFinite(dc) ? { effect, dc } : null;
}

/** Whether an activity is a damaging spell (Sanctuary's other trigger besides attack rolls). */
const damagingSpell = (activity) => activity?.item?.type === "spell" && (activity.damage?.parts?.length ?? 0) > 0;

/**
 * Before an attack roll or a damaging spell (the attacker's client): a Wisdom save for each warded creature
 * targeted; failures untarget it. Resolves with false when no target is left, else true.
 */
export async function checkSanctuary(activity) {
  if (!isSaveRulesEnabled()) return true;
  const attacker = activity?.actor;
  const mine = doc(activity?.getUsageToken?.() ?? attacker?.getActiveTokens?.()?.[0]);
  const targets = [...(game.user?.targets ?? [])].map(doc).filter(t => t?.actor);
  const warded = targets.filter(t => t.id !== mine?.id && wardOf(t.actor));
  if (!attacker || !warded.length) return true;
  const kept = new Set(targets.map(t => t.id));
  for (const t of warded) {
    const { dc } = wardOf(t.actor);
    const [result] = (await requestSaves(activePlayerOwner(attacker)?.id ?? null, {
      activityUuid: null, activityName: `Sanctuary (${t.name})`, casterName: t.name, usageId: null,
      ability: "wis", dc, targets: [{ actor: attacker.uuid, token: mine?.uuid ?? null, name: mine?.name ?? attacker.name }], prompt: false
    })) ?? [];
    if (result?.result?.passed) continue;
    kept.delete(t.id);
    ui.notifications?.info(`Luck Dice Automation: ${mine?.name ?? attacker.name} can't bring itself to target ${t.name} (Sanctuary).`);
  }
  if (kept.size !== targets.length) canvas.tokens?.setTargets?.([...kept], { mode: "replace" });
  return kept.size > 0;
}

/** The warded creature acted against others (an attack roll, a spell, damage): its ward ends. */
export async function endWard(actor) {
  if (!isSaveRulesEnabled()) return;
  const ward = effectsFrom(actor, "sanctuary")[0];
  if (!ward) return;
  await removeMark(ward.uuid);
  debug(`sanctuary: ${actor.name}'s ward ends`);
}

/** dnd5e.preApplyDamage: damage dealt by a warded creature (its damage card's speaker) ends its ward. Never cancels. */
export function onPreApplyDamageSanctuary(actor, amount, updates, options = {}) {
  if (!(amount > 0) || !isSaveRulesEnabled()) return;
  const dealer = options.originatingMessage?.speakerActor ?? null;
  if (dealer && dealer !== actor && effectsFrom(dealer, "sanctuary").length) endWard(dealer).catch(() => null);
}

/** Wrap each attack activity type's rollAttack and each activity type's consume (once per prototype chain). */
export function installSanctuary(types = CONFIG.DND5E?.activityTypes) {
  for (const config of Object.values(types ?? {})) {
    const proto = config?.documentClass?.prototype;
    if (!proto) continue;
    const roll = proto.rollAttack;
    if (typeof roll === "function" && !roll[PATCHED]) {
      const wrapped = async function (...args) {
        let go = true;
        try { go = await checkSanctuary(this); } catch (err) { console.error(`[${MODULE_ID}] sanctuary:`, err); }
        if (!go) return null;
        endWard(this.actor).catch(() => null); // the warded creature attacking ends its own ward
        return roll.apply(this, args);
      };
      wrapped[PATCHED] = true;
      Object.defineProperty(proto, "rollAttack", { configurable: true, writable: true, value: wrapped });
    }
    const consume = proto.consume;
    if (typeof consume === "function" && !consume[PATCHED]) {
      const wrapped = async function (usageConfig, messageConfig) {
        if (this.item?.type === "spell") endWard(this.actor).catch(() => null); // casting a spell ends the caster's ward
        if (!damagingSpell(this) || isLike(this, "attack")) return consume.call(this, usageConfig, messageConfig);
        let go = true;
        try { go = await checkSanctuary(this); } catch (err) { console.error(`[${MODULE_ID}] sanctuary:`, err); }
        if (go) return consume.call(this, usageConfig, messageConfig);
        await consume.call(this, usageConfig, messageConfig); // the spell is lost: its slot is spent
        return false;
      };
      wrapped[PATCHED] = true;
      Object.defineProperty(proto, "consume", { configurable: true, writable: true, value: wrapped });
    }
  }
}
