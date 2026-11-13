// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Stunning Strike (Monk 5), under the "onHitRiders" setting.
//
// After a hit (its damage settled), the monk is offered Stunning Strike on the
// creature hit, while they have a Focus Point (2024) or Ki Point (2014) left:
//   2024 — once per turn, with a Monk weapon (a Simple melee weapon, or a Martial
//          melee weapon with the Light property) or an Unarmed Strike;
//   2014 — any melee weapon attack, as often as there are points.
// A yes uses the feature's save activity through dnd5e (it spends the point and
// posts its card), and the save automation rolls the target's Constitution save
// (Luck Dice, Legendary Resistance and all). Effects, in full save automation:
//   failure — Stunned until the start of the monk's next turn (effects.mjs picks
//             the Stunned effect: dnd5e's 2024 data puts both on a failure);
//   success — 2024: Speed halved (dnd5e's "Slowed" effect), and the next attack
//             roll against it before then has Advantage (a mark the advantage
//             checks read and use up — Attack Rules or Weapon Mastery on).
// What happened is noted on the attack card.

import { automateSaves, saveOf } from "./saves.mjs";
import { useClaimed } from "./riders.mjs";
import { applyMasteryChange, masteryEffect } from "./mastery.mjs";
import { rulesOf } from "./advantage.mjs";
import { MODULE_ID, debug, escapeHTML, promptChoice, isOnHitRidersEnabled, getSaveAutomation, isLike } from "./shared.mjs";

export const STUNNING_FLAG = "stunningStrike"; // on the attack card: { text }
export const EXPOSED = "stunning-strike";      // the mastery-style mark: the next attack against it has Advantage

// Once per turn (2024), by monk actor uuid: the turn it was last used.
const usedThisTurn = new Map();
const turnKey = () => game.combat?.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : null;
const feature = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;
const activitiesOf = (item) => [...(item?.system?.activities?.values?.() ?? [])];

/**
 * Whether this attack can carry a Stunning Strike. 2024: a Monk weapon (Simple melee, or Martial melee with
 * the Light property) or an Unarmed Strike. 2014: any melee weapon attack.
 */
export function stunningStrikeWeapon(activity, rules) {
  if (!isLike(activity, "attack") || activity.attack?.type?.value !== "melee") return false;
  const item = activity.item;
  if (activity.attack?.type?.classification === "unarmed" || item?.system?.identifier === "unarmed-strike") return true;
  if (item?.type !== "weapon") return false;
  if (rules === "2014") return true;
  const kind = item.system?.type?.value;
  return kind === "simpleM" || (kind === "martialM" && !!item.system?.properties?.has?.("lgt"));
}

/**
 * The Focus (or Ki) Points left: the item uses the save activity spends — by id once dnd5e has prepared it,
 * else "type:identifier" or a compendium uuid as the data names it. Null when it can't be told.
 */
export function pointsLeft(actor, activity) {
  const target = activity?.consumption?.targets?.find?.(t => t.type === "itemUses")?.target;
  if (!target) return null;
  let item = actor?.items?.get?.(target) ?? null;
  if (!item) {
    let identifier = null;
    if (target.includes(":") && !target.startsWith("Compendium.")) identifier = target.split(":").pop();
    else { try { identifier = fromUuidSync(target, { strict: false })?.system?.identifier ?? null; } catch { identifier = null; } }
    item = identifier ? feature(actor, identifier) : null;
  }
  if (!item?.system?.uses?.max) return null;
  return Number(item.system.uses.value ?? 0) || 0;
}

/** After a hit (on the attacker's client): offer Stunning Strike, and carry it out. */
export async function applyStunningStrike(message, activity) {
  const actor = activity?.actor;
  if (!isOnHitRidersEnabled() || !actor?.isOwner || !message || message.getFlag?.(MODULE_ID, STUNNING_FLAG)) return;
  const item = feature(actor, "stunning-strike");
  const save = activitiesOf(item).find(a => isLike(a, "save"));
  if (!save) return;
  const rules = rulesOf(item);
  if (!stunningStrikeWeapon(activity, rules)) return;
  const turn = turnKey();
  if (rules !== "2014" && turn && usedThisTurn.get(actor.uuid) === turn) return;
  const hits = [];
  for (const hit of (message.system?.evaluatedTargets ?? []).filter(t => !t.isMiss)) {
    const target = hit.token ? (await fromUuid(hit.token))?.actor : await fromUuid(hit.actor);
    if (target && !target.statuses?.has?.("dead") && Number(target.system?.attributes?.hp?.value ?? 1) > 0) hits.push(hit);
  }
  const hit = hits[0];
  if (!hit) return;
  const left = pointsLeft(actor, save);
  if (left !== null && left < 1) { debug(`stunning strike: ${actor.name} has no points left`); return; }

  const points = rules === "2014" ? "Ki Point" : "Focus Point";
  const { dc } = saveOf(save) ?? {};
  const answer = await promptChoice("Stunning Strike",
    `<p>Spend 1 ${points} to try to stun <strong>${escapeHTML(hit.name)}</strong>? It makes a Constitution save` +
    `${dc ? ` (DC ${dc})` : ""}.${left !== null ? ` (${left} ${points}${left === 1 ? "" : "s"} left)` : ""}</p>`,
    [{ action: "strike", label: "Stunning Strike" }, { action: "no", label: "No" }]);
  if (answer !== "strike") return;

  // Used through dnd5e at that creature: it spends the point and posts its card. This module rolls the save.
  const previous = [...(game.user.targets ?? [])].map(t => t.id);
  const targetDoc = hit.token ? await fromUuid(hit.token) : null;
  if (targetDoc) canvas.tokens?.setTargets([targetDoc.id], { mode: "replace" });
  let results = null;
  try { results = await useClaimed(save, {}, { configure: false }); }
  finally { canvas.tokens?.setTargets(previous, { mode: "replace" }); }
  const usage = results?.message;
  if (!usage) return;
  if (rules !== "2014" && turn) usedThisTurn.set(actor.uuid, turn);

  const mode = getSaveAutomation();
  let text = `${hit.name}: its save is on the Stunning Strike card`;
  if (mode !== "off") {
    const outcome = await automateSaves(save, [{ actor: hit.actor, token: hit.token, name: hit.name }], usage, mode);
    const result = outcome?.get?.(hit.token);
    if (result && !result.passed) text = `${hit.name} is Stunned until the start of ${actor.name}'s next turn`;
    else if (result && rules === "2014") text = `${hit.name} resisted`;
    else if (result) {
      text = `${hit.name} resisted: its Speed is halved, and the next attack against it has Advantage`;
      const effect = masteryEffect(EXPOSED, actor, hit.token, {
        name: "Stunning Strike: Advantage against it", img: "icons/svg/target.svg", expiry: "sourceStart"
      });
      await applyMasteryChange({ kind: EXPOSED, token: hit.token, actor: hit.actor, effect });
    }
  }
  await message.setFlag(MODULE_ID, STUNNING_FLAG, { text });
  console.log(`[${MODULE_ID}] stunning strike: ${actor.name} — ${text}`);
}
