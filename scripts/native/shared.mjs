// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Shared state and helpers: the core.js API (window.LDA), flags, in-progress maps, the socket.

export const LDA = window.LDA;
export const {
  MODULE_ID, LUCK_DICE_ITEM_NAME, IMPACT_DICE_ITEM_NAME, clamp, debug,
  getDiceUses, actorHasLuckDice, promptChoice, promptSlider, getKeptD20Result, spendDiceFromPools,
  buildDiceAvailableHTML, isLuckDiceEnabled, isInspirationEnabled, actorHasInspiration,
  combineRolls, HISTORY_FLAG, diceFaces, renderLuckSection, requestRollActors,
  getAttackAutomation, getSaveAutomation, getPrivateRollOutcome,
  isEffectAutomationEnabled, isHealingAutomationEnabled,
  isDamageOnlyAutomationEnabled, isConcentrationBreakEnabled, isConcentrationAutoRollEnabled, isOnHitRidersEnabled, isLingeringAreasEnabled, isRepeatSavesEnabled, getReactionPrompts, isSkipAttackDialogEnabled, isAttackAdvantageEnabled, getLegendaryResistance, isWeaponMasteryEnabled, isAutoCritsEnabled, isOpportunityAttacksEnabled, isRetaliationEnabled, isDeathSavesEnabled, isClearInstantAreasEnabled, isTurnSummaryEnabled, isWallSpellsEnabled, isRayAutomationEnabled, getTargetConfirmation,
  readCardHistory, updateRollCard, recordCardStep, finishCardHistory, cardReporter,
} = LDA;

export const APPLIED_FLAG = "appliedDamage";

/**
 * Spread into the config of a roll the module makes without a window (with `{ configure: false }`), so the
 * final dnd5e.preRollV2 check keeps it that way when another module turns the window back on (Flash Rolls 5e
 * does, for actors with an active player owner).
 */
export const NO_DIALOG = Object.freeze({ [MODULE_ID]: { noDialog: true } });
export const escapeHTML   = (s) => (foundry.utils.escapeHTML ?? String)(String(s ?? ""));

console.log(`[${MODULE_ID}] native modules loaded — user=${game?.user?.name ?? "unknown"} isGM=${game?.user?.isGM ?? "?"}`);

/** Whether luck dice or inspiration could help this actor at all. */
export function canUseLuck(actor) {
  return actor?.type === "character" && (
    (isLuckDiceEnabled() && actorHasLuckDice(actor)) ||
    (isInspirationEnabled() && actorHasInspiration(actor))
  );
}

// Luck Dice prompts on damage cards still in progress, by card id. Applying waits
// for them, so dice added to the damage are part of what gets applied.
export const pendingLuckDamage = new Map();
// Attack cards still being processed (Luck Dice, then attack automation), by card id.
export const pendingAttacks = new Map();

// scorpious187s-lib socket router; set on ready.
export let socket = null;
/** Set the socket router (index.mjs, on ready). */
export function setSocket(value) { socket = value; }

// Luck Dice prompts on d20 cards still in progress, by card id.
export const pendingLuckChecks = new Map();
// Save requests this (the caster's) client is waiting on, by request id.
export const pendingSaveRequests = new Map();

/** Track an in-progress Luck Dice prompt for a card, so automation can wait for it. */
export function trackPending(map, id, promise) {
  if (!id) return;
  map.set(id, promise);
  promise.finally(() => { if (map.get(id) === promise) map.delete(id); });
}

export function getPrimaryGM() {
  return game.modules.get("scorpious187s-lib")?.api?.utils?.primaryGM?.() ?? null;
}

/** The active, non-GM owner of an actor, if any. */
export function activePlayerOwner(actor) {
  return game.users.find(u => !u.isGM && u.active && actor?.testUserPermission(u, "OWNER")) ?? null;
}

export function abilityLabel(ability) {
  return game.i18n.localize(CONFIG.DND5E.abilities[ability]?.label ?? ability);
}

/** Resolve a target descriptor ({ actor, token }) to its token document and actor. */
export async function resolveTarget(target) {
  const tokenDoc = target.token ? await fromUuid(target.token) : null;
  const actor    = tokenDoc?.actor ?? (target.actor ? await fromUuid(target.actor) : null);
  return { tokenDoc, actor };
}

export const APPLIED_EFFECTS_FLAG = "appliedEffects";
