// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Placed areas: clearing instantaneous ones, removing concentration ones when it ends, keeping lasting ones.
//
// The "clearInstantAreas" setting: once the automation has resolved a use of an
// instantaneous area spell (its saves and damage, or its healing), the area it
// placed is removed. With Flash Rolls 5e active and its "Remove Template" option on,
// that's left to Flash Rolls.
// dnd5e places a concentration spell's area after starting its concentration but
// never links the two, so ending concentration leaves the area (and any walls).
// Each such area is tagged with its concentration effect here; when that effect is
// deleted, the primary GM removes the area — always for lingering and wall spells
// (this module's own), and for other spells' areas with this setting on.
// Either way, a lingering area (lingering.mjs) or a wall spell's (walls.mjs) is kept
// while its spell lasts: anything that tries to delete it — Flash Rolls removes an
// item's areas after any of its damage rolls, which a lingering area's triggers make
// — is stopped with a notice. Hold Shift while deleting to remove it anyway.

import { LINGERING_FLAG, LINGERING_SPELLS, isTriggerClient } from "./lingering.mjs";
import { WALL_SPELL_FLAG, WALL_SPELLS } from "./walls.mjs";
import { MODULE_ID, isClearInstantAreasEnabled, socket } from "./shared.mjs";

const FLASH_ROLLS = "flash-rolls-5e";
export const CONCENTRATION_AREA_FLAG = "concentrationOf";   // on an area: its concentration effect's uuid
const isConcentrationEffect = (e) => e?.system?.type === "concentrating" || !!e?.statuses?.has?.("concentrating");

/** Whether Flash Rolls 5e is removing areas itself. */
export function flashRollsRemovesAreas() {
  if (!game.modules.get(FLASH_ROLLS)?.active) return false;
  try { return !!game.settings.get(FLASH_ROLLS, "remove-template"); } catch { return false; }
}

// Areas placed by uses still being resolved, by usage card id.
const placed = new Map();

/** dnd5e.postUseActivity: remember the areas this use placed, and tie a concentration spell's to its concentration. */
export function rememberAreas(activity, results) {
  const regions = (results?.templates ?? []).filter(r => r?.documentName === "Region");
  const usageId = results?.message?.id;
  if (regions.length && usageId) placed.set(usageId, { activity, regions: regions.map(r => r.uuid) });
  const concentration = (results?.effects ?? []).find(isConcentrationEffect);
  if (!concentration) return;
  for (const region of regions) {
    if (region.isOwner) region.setFlag(MODULE_ID, CONCENTRATION_AREA_FLAG, concentration.uuid)
      .catch(err => console.error(`[${MODULE_ID}] concentration area:`, err));
    else socket?.emit("tagArea", { uuid: region.uuid, concentration: concentration.uuid });
  }
}

/** GM side: tie an area a player placed to its concentration. */
export async function tagAreaGM({ uuid, concentration }) {
  const region = await fromUuid(uuid);
  if (region?.documentName === "Region" && typeof concentration === "string") await region.setFlag(MODULE_ID, CONCENTRATION_AREA_FLAG, concentration);
}

/** The concentration effect an area is tied to, by any of this module's links. */
function concentrationOf(region) {
  return region?.getFlag?.(MODULE_ID, CONCENTRATION_AREA_FLAG)
    ?? region?.getFlag?.(MODULE_ID, LINGERING_FLAG)?.concentration
    ?? region?.getFlag?.(MODULE_ID, WALL_SPELL_FLAG)?.concentration ?? null;
}

/** deleteActiveEffect (primary GM): concentration ended — remove the areas tied to it. */
export async function onConcentrationEnded(effect) {
  if (!isConcentrationEffect(effect) || !isTriggerClient() || !effect.uuid) return;
  for (const scene of game.scenes ?? []) {
    for (const region of [...(scene.regions ?? [])]) {
      if (concentrationOf(region) !== effect.uuid) continue;
      const ours = region.getFlag?.(MODULE_ID, LINGERING_FLAG) || region.getFlag?.(MODULE_ID, WALL_SPELL_FLAG);
      if (!ours && !isClearInstantAreasEnabled()) continue;
      await region.delete({ [MODULE_ID]: { allow: true } });
      console.log(`[${MODULE_ID}] areas: concentration ended — removed ${region.name ?? "an area"}`);
    }
  }
}

/** Whether a use's areas should go once it's resolved: an instantaneous, non-lingering spell. */
function isInstant(activity) {
  const item = activity?.item;
  if (!item || LINGERING_SPELLS.has(item.system?.identifier) || WALL_SPELLS[item.system?.identifier]) return false;
  const units = activity.duration?.units ?? item.system?.duration?.units;
  return !units || units === "inst";
}

/** The automation resolved a use: clear its areas (when it's ours to do). */
export async function clearAreasForUse(usageId) {
  const entry = placed.get(usageId);
  placed.delete(usageId);
  if (!entry || !isClearInstantAreasEnabled() || flashRollsRemovesAreas() || !isInstant(entry.activity)) return;
  for (const uuid of entry.regions) {
    const region = await fromUuid(uuid);
    if (!region || region.getFlag?.(MODULE_ID, LINGERING_FLAG)) continue;
    if (region.isOwner) await region.delete({ [MODULE_ID]: { allow: true } });
    else socket?.emit("clearArea", { uuid });
  }
}

/** GM side: clear an area a player's use placed. Not lingering ones. */
export async function clearAreaGM({ uuid }) {
  const region = await fromUuid(uuid);
  if (region?.documentName === "Region" && !region.getFlag?.(MODULE_ID, LINGERING_FLAG)) await region.delete({ [MODULE_ID]: { allow: true } });
}

/** Whether a lingering area's spell is still going (its concentration effect exists, when it had one). */
function stillLingering(data) {
  if (!data) return false;
  if (!data.concentration) return true;
  try { return !!fromUuidSync(data.concentration, { strict: false }); } catch { return false; }
}

const shiftHeld = () => ["ShiftLeft", "ShiftRight", "Shift"].some(k => game.keyboard?.downKeys?.has?.(k));

/** preDeleteRegion (the deleting client): keep a lingering area — or a wall spell's — while its spell lasts. */
export function onPreDeleteRegion(region, options) {
  const data = region?.getFlag?.(MODULE_ID, LINGERING_FLAG) ?? region?.getFlag?.(MODULE_ID, WALL_SPELL_FLAG);
  if (!data || options?.[MODULE_ID]?.allow || shiftHeld() || !stillLingering(data)) return;
  ui.notifications?.info("Luck Dice Automation: kept a lasting spell's area while the spell lasts (hold Shift to delete it).");
  return false;
}
