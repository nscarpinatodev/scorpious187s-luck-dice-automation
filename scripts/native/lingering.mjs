// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Lingering areas: spells whose area keeps working after the cast (Spirit
// Guardians, Moonbeam, Cloud of Daggers…).
//
// The "lingeringAreas" setting. When one of these spells places its area, the
// caster's client tags the region with the spell (item, the activity that runs
// on a trigger, cast level, caster, its concentration effect, rules version).
// The primary GM's client then watches for triggers, following each spell's own
// rules (its source: 2014 or 2024):
//   2014 — a creature starts its turn there, or enters it for the first time on a turn;
//   2024 — a creature enters it (or the area moves onto it) or ends its turn
//          there, at most once per turn.
// A trigger runs the spell's save through the save automation setting (request
// the save; in full mode also roll and apply the damage and effects), or rolls
// and applies a damage-only area's damage in full mode. The caster is left out of
// their own emanation, and for areas where the caster chooses who's affected,
// their allies. Once the spell's concentration ends, its area stops triggering.
// Wall of Fire isn't included: its damage depends on which side of the wall.

import { requestApplyDamage } from "./apply.mjs";
import { automateSaves } from "./saves.mjs";
import { MODULE_ID, debug, getSaveAutomation, getPrimaryGM, isLingeringAreasEnabled, pendingLuckDamage, socket } from "./shared.mjs";
import { regionsOf } from "./targeting.mjs";

export const LINGERING_FLAG = "lingering";

/** By item identifier. */
export const LINGERING_SPELLS = new Set([
  "spirit-guardians", "moonbeam", "cloud-of-daggers", "insect-plague", "cloudkill", "sickening-radiance",
  "incendiary-cloud", "evards-black-tentacles", "stinking-cloud", "web"
]);

/** "2014" or "2024", from the item's source, else the world's rules version. */
export function rulesOf(item) {
  const rules = String(item?.system?.source?.rules ?? "");
  if (rules === "2014" || rules === "2024") return rules;
  try { return game.settings.get("dnd5e", "rulesVersion") === "legacy" ? "2014" : "2024"; } catch { return "2024"; }
}

/** The activity a trigger runs: the save / damage activity marked "special" (2014 data), else the first one. */
export function triggerActivity(item) {
  const activities = [...(item?.system?.activities?.values?.() ?? [])].filter(a => a.type === "save" || a.type === "damage");
  return activities.find(a => a.activation?.type === "special") ?? activities[0] ?? null;
}

/** dnd5e.postUseActivity, on the caster's client: tag a lingering spell's placed area. */
export async function recordLingeringArea(activity, usageConfig, results) {
  if (!isLingeringAreasEnabled()) return;
  const item = activity?.item;
  if (!LINGERING_SPELLS.has(item?.system?.identifier)) return;
  const regions = regionsOf(results);
  const trigger = triggerActivity(item);
  if (!regions.length || !trigger) return;
  const concentration = (results?.effects ?? []).find(e => e?.system?.type === "concentrating" || e?.statuses?.has?.("concentrating"));
  const data = {
    item: item.uuid, activity: trigger.id, actor: activity.actor?.uuid ?? null,
    scaling: Number(usageConfig?.scaling ?? item.flags?.dnd5e?.scaling ?? 0) || 0,
    rules: rulesOf(item), usage: results?.message?.id ?? null, concentration: concentration?.uuid ?? null
  };
  for (const region of regions) {
    // The caster placed it, so usually owns it; otherwise the primary GM tags it.
    if (region.isOwner !== false) await region.setFlag(MODULE_ID, LINGERING_FLAG, data);
    else socket?.emit("tagLingeringArea", { regionUuid: region.uuid, data });
  }
  debug(`lingering: ${item.name} (${data.rules}) tagged ${regions.length} area(s)`);
}

/** GM side: tag an area for a caster who can't update it. Only lingering spells' data. */
export async function tagLingeringArea({ regionUuid, data }) {
  const region = await fromUuid(regionUuid);
  if (!region || region.documentName !== "Region" || !data?.item) return;
  const item = await fromUuid(data.item);
  if (!LINGERING_SPELLS.has(item?.system?.identifier)) return;
  await region.setFlag(MODULE_ID, LINGERING_FLAG, data);
}

// ── The primary GM's watch ────────────────────────────────────────────────────

/** Whether this client runs the triggers: the primary GM (or the active GM without the lib). */
export function isTriggerClient() {
  const gm = getPrimaryGM();
  return gm ? gm.id === game.user.id : !!game.user.isActiveGM;
}

const lingeringRegions = (scene) => [...(scene?.regions ?? [])].filter(r => r.getFlag?.(MODULE_ID, LINGERING_FLAG));
const membersOf = (region) => new Set([...(region.parent?.tokens ?? [])]
  .filter(t => t.actor && safeInside(t, region)).map(t => t.id));
function safeInside(token, region) {
  try { return token.testInsideRegion(region); } catch { return false; }
}
const turnKeyOf = (combat, state) => combat?.started && state ? `${combat.id}:${state.round}:${state.turn}` : null;
const currentTurn = () => turnKeyOf(game.combat, game.combat);

// Who's inside each lingering area, by region id, so entering can be told from staying.
const members = new Map();
// The turn each (area, creature) last triggered, for the once-per-turn limits.
const lastTriggered = new Map();
// Triggers run one at a time.
let queue = Promise.resolve();

/** The spell's activity for a trigger, scaled to the cast level. */
async function areaActivity(data) {
  const item = await fromUuid(data.item);
  if (!item) return null;
  const scaled = data.scaling ? item.clone({ "flags.dnd5e.scaling": data.scaling }, { keepId: true }) : item;
  return scaled.system?.activities?.get?.(data.activity) ?? null;
}

/** Whether the spell is still going: its concentration effect, if it had one, still exists. */
function stillActive(data) {
  if (!data.concentration) return true;
  try { return !!fromUuidSync(data.concentration, { strict: false }); } catch { return false; }
}

/**
 * Whether the area affects this creature — the targeting rules of placed areas
 * (see tokensInActivityArea), minus the caster's allies where the caster chooses
 * who's affected. Being in the area is the caller's test: a creature passing
 * through counts though it ends its move outside.
 */
function affects(activity, tokenDoc) {
  const caster = activity.getUsageToken?.() ?? null;
  const type = activity.target?.affects?.type;
  if (type === "self") return !!caster && caster.id === tokenDoc.id;
  if (tokenDoc.actor?.statuses?.has?.("dead")) return false;
  if (!caster) return true;
  if (tokenDoc.id === caster.id && activity.range?.units === "self") return false;
  if (type === "enemy" && tokenDoc.disposition === caster.disposition) return false;
  if ((type === "ally" || type === "willing") && tokenDoc.disposition !== caster.disposition) return false;
  const choice = activity.target?.affects?.choice || activity.item?.system?.target?.affects?.choice;
  return !(choice && tokenDoc.disposition === caster.disposition);
}

/** What a trigger does; replaceable in tests. */
export const lingeringRunner = { run: runAreaTrigger };

/**
 * A creature triggered an area: `kind` is "start" / "end" (of its turn) or
 * "enter". `turn` is the turn it belongs to (for the limits), when in combat.
 */
export async function triggerArea(region, tokenDoc, kind, turn = currentTurn()) {
  const data = region?.getFlag?.(MODULE_ID, LINGERING_FLAG);
  if (!data || !tokenDoc?.actor || !stillActive(data)) return false;
  if (kind === "start" && data.rules !== "2014") return false;
  if (kind === "end" && data.rules === "2014") return false;
  // 2024: once per turn for anything. 2014: entering only counts the first time on a turn.
  const limit = data.rules === "2014" ? (kind === "enter" ? `${region.id}:${tokenDoc.id}:enter` : null) : `${region.id}:${tokenDoc.id}`;
  if (turn && limit && lastTriggered.get(limit) === turn) return false;

  const activity = await areaActivity(data);
  if (!activity || !affects(activity, tokenDoc)) return false;
  if (turn && limit) lastTriggered.set(limit, turn);

  const usage = data.usage ? game.messages.get(data.usage) ?? null : null;
  // The cast's card carries the effects to apply, when the trigger is the same activity (2024 data).
  const sameUse = usage?.system?.activity?.id === activity.id || usage?.getAssociatedActivity?.()?.id === activity.id;
  const name = activity.item?.name ?? "area";
  console.log(`[${MODULE_ID}] lingering: ${tokenDoc.name} — ${kind === "enter" ? "entered" : `${kind === "start" ? "started" : "ended"} its turn in`} ${name}`);
  queue = queue.then(() => lingeringRunner.run(activity, tokenDoc, sameUse ? usage : null))
    .catch(err => console.error(`[${MODULE_ID}] lingering ${name}:`, err));
  await queue;
  return true;
}

/** Run a triggered area for one creature, per the save automation setting. */
async function runAreaTrigger(activity, tokenDoc, usage) {
  const mode = getSaveAutomation();
  if (mode === "off") return;
  const target = { actor: tokenDoc.actor.uuid, token: tokenDoc.uuid, name: tokenDoc.name };
  if (activity.type === "save") return automateSaves(activity, [target], usage, mode);
  // A damage-only area: roll it at the creature; apply it in full mode.
  const rolls = await activity.rollDamage({}, { configure: false }, {
    data: { system: { targets: [{ ...target, ac: tokenDoc.actor.system?.attributes?.ac?.value ?? null, img: tokenDoc.texture?.src }] } }
  });
  const message = rolls?.[0]?.parent;
  if (!message) return;
  await pendingLuckDamage.get(message.id);
  if (mode === "full") await requestApplyDamage(message, [target]);
}

/** combatTurnChange: the creature whose turn ended, and the one whose turn starts. */
export async function onTurnChange(combat, prior, current) {
  if (!isLingeringAreasEnabled() || !isTriggerClient() || !combat?.started) return;
  const scene = combat.scene ?? canvas.scene;
  const token = (id) => id ? scene?.tokens?.get?.(id) : null;
  const regions = lingeringRegions(scene);
  if (!regions.length) return;
  const ended = token(prior?.tokenId), starting = token(current?.tokenId);
  for (const region of regions) {
    if (ended && safeInside(ended, region)) await triggerArea(region, ended, "end", turnKeyOf(combat, prior));
    if (starting && safeInside(starting, region)) await triggerArea(region, starting, "start", turnKeyOf(combat, current));
  }
}

/**
 * moveToken: the mover entering an area along its path (passing through counts);
 * and, for 2024 spells, areas that moved onto other creatures (an emanation
 * moving with its caster).
 */
export async function onTokenMoved(tokenDoc, movement) {
  if (!isLingeringAreasEnabled() || !isTriggerClient()) return;
  const ENTER = globalThis.CONST?.REGION_MOVEMENT_SEGMENTS?.ENTER ?? 1;
  for (const region of lingeringRegions(tokenDoc.parent)) {
    const before = members.get(region.id) ?? membersOf(region);
    const now = membersOf(region);
    members.set(region.id, now);
    let entered = false;
    try {
      const waypoints = [movement?.origin, ...(movement?.passed?.waypoints ?? [])].filter(Boolean);
      entered = tokenDoc.segmentizeRegionMovementPath(region, waypoints).some(s => s.type === ENTER);
    } catch { entered = !before.has(tokenDoc.id) && now.has(tokenDoc.id); }
    if (entered) await triggerArea(region, tokenDoc, "enter");
    if (region.getFlag(MODULE_ID, LINGERING_FLAG)?.rules === "2024") {
      for (const id of now) {
        if (id !== tokenDoc.id && !before.has(id)) await triggerArea(region, region.parent.tokens.get(id), "enter");
      }
    }
  }
}

/**
 * updateRegion: when an area is first tagged, note who's already inside (they
 * haven't entered it); when a 2024 area moves, creatures it now covers entered it.
 */
export async function onRegionChanged(region, changes) {
  if (!isLingeringAreasEnabled() || !isTriggerClient()) return;
  const data = region.getFlag?.(MODULE_ID, LINGERING_FLAG);
  if (!data) return;
  const before = members.get(region.id);
  const now = membersOf(region);
  members.set(region.id, now);
  if (!before || changes?.flags?.[MODULE_ID]) return;
  if (data.rules !== "2024") return;
  for (const id of now) if (!before.has(id)) await triggerArea(region, region.parent.tokens.get(id), "enter");
}
