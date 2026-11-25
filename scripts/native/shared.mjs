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
  isDamageOnlyAutomationEnabled, isConcentrationBreakEnabled, isConcentrationAutoRollEnabled, isOnHitRidersEnabled, isLingeringAreasEnabled, isRepeatSavesEnabled, getReactionPrompts, isSkipAttackDialogEnabled, isAttackAdvantageEnabled, getLegendaryResistance, isWeaponMasteryEnabled, isAutoCritsEnabled, isOpportunityAttacksEnabled, isRetaliationEnabled, isDeathSavesEnabled, isClearInstantAreasEnabled, isTurnSummaryEnabled, isWallSpellsEnabled, isTeleportRangeEnabled, isPersistentDamageEnabled, isRayAutomationEnabled, getTargetConfirmation, isSaveRulesEnabled, isRollBoostsEnabled, isInvocationsEnabled, isMetamagicEnabled,
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

/**
 * Whether an activity is of this type ("attack", "save", "damage", "heal"…), or one that dnd5e 6.1 lets declare
 * itself like it — another module's activity type that works as an attack, say. Earlier versions: just its type.
 */
export const isLike = (activity, type) =>
  typeof activity?.isLike === "function" ? activity.isLike(type) : activity?.type === type;

// ── Antimagic ─────────────────────────────────────────────────────────────────
// dnd5e 6.1's Antimagic region gives the creatures inside it the "antimagic" status; dnd5e then suppresses
// their magical effects and magic items' bonuses, and hides their spells. Spells and other magic still
// reach them, so the module's automation leaves them out: no save, damage or effect from a spell or a
// Magical feature, and none of those offered to them as reactions, riders or boosts. Earlier versions
// have no such status, so nothing changes there.

export const ANTIMAGIC = "antimagic";

/** Whether this creature is in antimagic. */
export const inAntimagic = (actor) => !!actor?.statuses?.has?.(ANTIMAGIC);

/**
 * Whether an item works by magic, so antimagic stops it: a spell, or a feature or item marked Magical
 * (dnd5e 6.1 marks Eldritch Smite, Font of Magic…). Not a weapon: its strike still lands, magic aside.
 */
export const isMagical = (item) => item?.type === "spell"
  || (item?.type !== "weapon" && !!item?.system?.properties?.has?.("mgc"));

/** Whether antimagic keeps this source (an activity, or an item) from this creature, either side of it. */
export const antimagicStops = (actor, source) => inAntimagic(actor) && isMagical(source?.item ?? source);

// ── dnd5e 6.1's stock effects ─────────────────────────────────────────────────
// Its Effects compendium has Disengaged, No Opportunity Attacks and No Reactions. They carry no status or rule,
// so they're known by where they came from. Features apply them (2024 Monk's Focus: Disengaged), or a GM does.

export const STOCK_EFFECTS = Object.freeze({
  disengaged: "DovP6Uo8YmIohHeK", noOpportunityAttacks: "qfTVWq97wiQgSSSM", noReactions: "tZuPpkTWg8lVjxhL"
});

/** Whether an effect is a copy of one of dnd5e's stock effects (a STOCK_EFFECTS key). */
export function isStockEffect(effect, key) {
  const uuid = `Compendium.dnd5e.effects.ActiveEffect.${STOCK_EFFECTS[key]}`;
  return [effect?._stats?.compendiumSource, effect?._stats?.duplicateSource, effect?.flags?.core?.sourceId].includes(uuid);
}

/** The creature's copies of a stock effect. */
export const stockEffectsOf = (actor, key) => [...(actor?.effects ?? [])].filter(e => isStockEffect(e, key));

/** Whether a stock effect is in force on the creature. */
export const hasStockEffect = (actor, key) => stockEffectsOf(actor, key).some(e => !e.disabled && !e.isSuppressed);

// ── Dice added to a card ──────────────────────────────────────────────────────
// Dice So Nice 6 animates rolls added to a chat card by an update, to whoever may see them. Showing them
// as well would roll the same dice twice. Earlier versions don't, so there they're shown by hand first.

const diceSoNiceAnimatesAddedRolls = () => typeof game.dice3d?.pipeline?.messageUpdateHideSelector === "string";

/** Before adding a roll to a card: show it, unless Dice So Nice will when it's added. */
export async function showRollToAdd(roll) {
  if (game.dice3d && !diceSoNiceAnimatesAddedRolls()) await game.dice3d.showForRoll(roll, game.user, true, null, false);
}

/** After adding rolls to a card: wait for Dice So Nice's animation of them, so damage lands with the dice. */
export async function waitForAddedRolls(message) {
  if (!message?.id || !diceSoNiceAnimatesAddedRolls() || !game.dice3d.waitFor3DAnimationByMessageID) return;
  await Promise.race([game.dice3d.waitFor3DAnimationByMessageID(message.id), new Promise(r => setTimeout(r, 15_000))]);
}
