// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Retaliation: damage that hits back when a creature is hit in melee.
//
// The "retaliation" setting:
//   Armor of Agathys — while its temporary hit points last, a creature that hits
//                      the caster with a melee attack takes the spell's cold damage
//                      (5 per slot level). dnd5e gives the spell no effect to mark it
//                      as active, so its use is noted on the caster (cast level and
//                      all), and the note is cleared once those temporary HP run out.
//   Fire Shield      — a creature within 5 ft that hits the caster with a melee
//                      attack takes 2d8: fire from the Warm Shield, cold from the
//                      Chill Shield.
// The damage is rolled from the spell's own damage activity and applied to the
// attacker through the primary GM (from a card naming who it hit back).

import { requestApplyDamage } from "./apply.mjs";
import { tokenDistance } from "./advantage.mjs";
import { MODULE_ID, debug, isRetaliationEnabled, socket, getPrimaryGM, NO_DIALOG } from "./shared.mjs";

export const AGATHYS_FLAG = "agathys";
const damageActivity = (item, name) => [...(item?.system?.activities?.values?.() ?? [])]
  .find(a => a.type === "damage" && (!name || name.test(a.name ?? ""))) ?? null;

// ── Armor of Agathys bookkeeping ──────────────────────────────────────────────

/** dnd5e.postUseActivity (the caster's client): note Armor of Agathys and its cast level on the caster. */
export async function recordAgathys(activity, usageConfig) {
  const item = activity?.item;
  if (!isRetaliationEnabled() || item?.system?.identifier !== "armor-of-agathys" || !activity.actor?.isOwner) return;
  const scaling = Number(usageConfig?.scaling ?? item.flags?.dnd5e?.scaling ?? 0) || 0;
  await activity.actor.setFlag(MODULE_ID, AGATHYS_FLAG, { item: item.uuid, scaling });
}

/** updateActor (primary GM): Armor of Agathys ends with its temporary hit points. */
export async function onActorUpdatedAgathys(actor, changes) {
  if (!actor?.getFlag?.(MODULE_ID, AGATHYS_FLAG)) return;
  const temp = foundry.utils.getProperty(changes, "system.attributes.hp.temp");
  if (temp === undefined || Number(temp) > 0) return;
  const gm = getPrimaryGM();
  if (gm ? gm.id !== game.user.id : !game.user.isGM) return;
  await actor.unsetFlag(MODULE_ID, AGATHYS_FLAG);
}

// ── Hitting back ──────────────────────────────────────────────────────────────

/** Effects on an actor that came from an item with this identifier, active ones. */
function shieldEffects(actor) {
  return [...(actor?.effects ?? [])].filter(e => {
    if (e.disabled || e.isSuppressed) return false;
    const source = [e.system?.origin?.item, e.system?.origin?.activity, e._stats?.duplicateSource, e.origin].find(s => typeof s === "string");
    if (!source) return /warm shield|chill shield/i.test(e.name ?? "");
    try {
      const item = fromUuidSync(source.split(".Activity.")[0].split(".ActiveEffect.")[0], { strict: false });
      return item?.system?.identifier === "fire-shield";
    } catch { return /warm shield|chill shield/i.test(e.name ?? ""); }
  });
}

/** What each creature this melee attack hit would deal back: [{ target, attacker, kind, … }]. */
export async function retaliationsFor(message, activity) {
  if (activity?.attack?.type?.value !== "melee" || String(message?.system?.mode ?? "").startsWith("thrown")) return [];
  const attackerDoc = (() => { const t = activity.getUsageToken?.(); return t?.document ?? t ?? activity.actor?.getActiveTokens?.()?.[0]?.document ?? null; })();
  if (!attackerDoc) return [];
  const out = [];
  for (const hit of (message.system?.evaluatedTargets ?? []).filter(t => !t.isMiss)) {
    const targetDoc = hit.token ? await fromUuid(hit.token) : null;
    const actor = targetDoc?.actor;
    if (!actor) continue;
    const agathys = actor.getFlag?.(MODULE_ID, AGATHYS_FLAG);
    if (agathys && Number(actor.system?.attributes?.hp?.temp ?? 0) > 0) {
      out.push({ kind: "agathys", target: targetDoc.uuid, attacker: attackerDoc.uuid, item: agathys.item, scaling: agathys.scaling });
    }
    const shield = shieldEffects(actor)[0];
    if (shield && tokenDistance(targetDoc, attackerDoc) <= (canvas?.grid?.distance ?? 5)) {
      const chill = /chill/i.test(shield.name ?? "");
      const item = (() => { try { return fromUuidSync(String(shield.system?.origin?.item ?? shield.origin ?? "").split(".Activity.")[0], { strict: false }); } catch { return null; } })();
      out.push({ kind: "fireShield", target: targetDoc.uuid, attacker: attackerDoc.uuid, item: item?.uuid ?? null, type: chill ? "cold" : "fire" });
    }
  }
  return out;
}

/** After the attack (the attacker's client): have the primary GM deal the retaliation damage. */
export async function applyRetaliation(message, activity) {
  if (!isRetaliationEnabled()) return;
  const list = await retaliationsFor(message, activity);
  if (!list.length) return;
  if (game.user.isGM) return retaliateGM({ list });
  socket?.emit("retaliate", { list });
}

/** GM side: roll each retaliation from its spell and apply it to the attacker. */
export async function retaliateGM({ list }) {
  for (const entry of list ?? []) {
    const targetDoc = await fromUuid(entry.target), attackerDoc = await fromUuid(entry.attacker);
    if (!targetDoc?.actor || !attackerDoc?.actor) continue;
    let item = entry.item ? await fromUuid(entry.item) : null;
    if (!item) item = targetDoc.actor.items.find(i => i.system?.identifier === (entry.kind === "agathys" ? "armor-of-agathys" : "fire-shield"));
    if (entry.scaling) item = item?.clone?.({ "flags.dnd5e.scaling": entry.scaling }, { keepId: true }) ?? item;
    const activity = damageActivity(item);
    let rolls = null;
    if (activity?.rollDamage) rolls = await activity.rollDamage({ ...NO_DIALOG }, { configure: false }, { create: false });
    if (!rolls?.length) {
      const formula = entry.kind === "agathys" ? String(5 * (1 + (entry.scaling ?? 0))) : "2d8";
      rolls = [await new CONFIG.Dice.DamageRoll(formula, {}, { type: entry.type ?? "cold" }).evaluate()];
    }
    if (entry.type) for (const r of rolls) { r.options.type = entry.type; r.options.types = [entry.type]; }
    const name = entry.kind === "agathys" ? "Armor of Agathys" : (entry.type === "cold" ? "Fire Shield (Chill)" : "Fire Shield (Warm)");
    const descriptor = { actor: attackerDoc.actor.uuid, token: attackerDoc.uuid, name: attackerDoc.name, img: attackerDoc.texture?.src,
      ac: attackerDoc.actor.system?.attributes?.ac?.value ?? null };
    const card = await CONFIG.Dice.DamageRoll.toMessage(rolls, {
      type: "damage", flavor: `${name} - ${targetDoc.name} hits back at ${attackerDoc.name}`,
      speaker: ChatMessage.getSpeaker({ actor: targetDoc.actor, token: targetDoc }), system: { targets: [descriptor] }
    });
    if (card) await requestApplyDamage(card, [descriptor]);
    debug(`retaliation: ${name} — ${rolls.reduce((s, r) => s + r.total, 0)} to ${attackerDoc.name}`);
  }
}
