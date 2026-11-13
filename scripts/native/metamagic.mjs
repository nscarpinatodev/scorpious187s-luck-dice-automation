// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Metamagic (2014, Tasha's, 2024). dnd5e gives each option as an item, but using one changes nothing.
//
// The "metamagic" setting. For a sorcerer with Sorcery Points (Font of Magic's uses) and options,
// dnd5e's spell casting window opens for every spell they cast (cantrips too) with a Metamagic
// section: one option per spell, each shown with its cost and only where it fits the spell.
//   Careful     — the caster picks up to their Charisma modifier of the creatures saving: they
//                 succeed without rolling (2024: and take no damage where a success means half).
//   Heightened  — one creature picked makes its save against the spell with disadvantage.
//   Distant     — double the range (touch: 30 ft), for this casting's attacks.
//   Extended    — double the spell's effects' durations (concentration too), up to 24 hours;
//                 2024: advantage on concentration saves for it.
//   Transmuted  — its acid, cold, fire, lightning, poison or thunder damage becomes the type chosen.
//   Twinned     — 2024: one spell level higher (an extra target, for spells that gain one).
//                 2014: a second target; a spell attack makes its attack at each.
//   Quickened, Subtle — noted on the card (nothing to work out).
// Empowered Spell is offered when a spell's damage is rolled (pick up to the Charisma modifier of
// dice to reroll), Seeking Spell on a missed spell attack (boosts.mjs); they combine with the others.
// The points come off Font of Magic once the spell is cast. What was used is noted on the card.

import { rulesOf, mergeRollMode, ensureFinalModeHook, ac5eCovers, conduitMultiplier, SAVE_REASONS_FLAG } from "./advantage.mjs";
import { usesLeft, spendUses } from "./boosts.mjs";
import { eldritchSpearRange, feature } from "./invocations.mjs";
import { confirmTargets, pickCreatures } from "./targeting.mjs";
import { MODULE_ID, debug, escapeHTML, isMetamagicEnabled, resolveTarget, pendingAttacks, inAntimagic, isLike } from "./shared.mjs";

export const METAMAGIC_FLAG = "metamagic"; // on a card: { name, cost, notes } — what was used

export const METAMAGIC = {
  careful:    { identifier: "careful-spell",    name: "Careful Spell" },
  distant:    { identifier: "distant-spell",    name: "Distant Spell" },
  extended:   { identifier: "extended-spell",   name: "Extended Spell" },
  heightened: { identifier: "heightened-spell", name: "Heightened Spell" },
  quickened:  { identifier: "quickened-spell",  name: "Quickened Spell" },
  subtle:     { identifier: "subtle-spell",     name: "Subtle Spell" },
  transmuted: { identifier: "transmuted-spell", name: "Transmuted Spell" },
  twinned:    { identifier: "twinned-spell",    name: "Twinned Spell" },
  // At their own moment, not in the casting window.
  empowered:  { identifier: "empowered-spell",  name: "Empowered Spell", later: true },
  seeking:    { identifier: "seeking-spell",    name: "Seeking Spell", later: true }
};
const COSTS = {
  2014: { careful: 1, distant: 1, empowered: 1, extended: 1, heightened: 3, quickened: 2, seeking: 2, subtle: 1, transmuted: 1 },
  2024: { careful: 1, distant: 1, empowered: 1, extended: 1, heightened: 2, quickened: 2, seeking: 1, subtle: 1, transmuted: 1, twinned: 1 }
};
export const TRANSMUTABLE = ["acid", "cold", "fire", "lightning", "poison", "thunder"];
const DAY = 86400;

/** An option's cost in Sorcery Points, by its item's rules; 2014 Twinned costs the spell's level (1 for a cantrip). */
export function metamagicCost(key, item, spellLevel = 0) {
  const rules = rulesOf(item) === "2014" ? "2014" : "2024";
  if (key === "twinned" && rules === "2014") return Math.max(1, spellLevel);
  return COSTS[rules][key] ?? COSTS["2024"][key] ?? 1;
}

/** The creature's Sorcery Points left (Font of Magic's uses). */
export function sorceryPoints(actor) {
  const font = feature(actor, "font-of-magic");
  return font ? usesLeft(font) : 0;
}
export async function spendSorceryPoints(actor, count) {
  const font = feature(actor, "font-of-magic");
  if (font && count > 0) await spendUses(font, count);
}

// ── Which options fit this spell ──────────────────────────────────────────────

const activitiesOf = (item) => [...(item?.system?.activities?.values?.() ?? [])];
const damageTypes = (item) => new Set(activitiesOf(item).flatMap(a => (a.damage?.parts ?? []).flatMap(p => [...(p.types ?? [])])));
const hasSave = (item) => activitiesOf(item).some(a => isLike(a, "save"));
const castLevel = (item, config) => (Number(item?.system?.level) || 0) + (Number(config?.scaling) || 0);
const lastsAMinute = (item) => {
  const { value, units } = item?.system?.duration ?? {};
  return ["minute", "hour", "day", "month", "year", "perm"].includes(units) && (units === "perm" || Number(value) >= 1);
};
const fits = {
  careful: (activity, item) => hasSave(item),
  heightened: (activity, item) => hasSave(item),
  distant: (activity, item) => {
    const range = item?.system?.range ?? {};
    return range.units === "touch" || (["ft", "m", "mi", "km"].includes(range.units) && Number(range.value) >= 5);
  },
  extended: (activity, item) => lastsAMinute(item),
  quickened: (activity) => activity?.activation?.type === "action",
  subtle: () => true,
  transmuted: (activity, item) => [...damageTypes(item)].some(t => TRANSMUTABLE.includes(t)),
  twinned: (activity, item, twin) => rulesOf(twin) === "2014"
    ? String(activity?.target?.affects?.count ?? "") === "1" && !activity?.target?.template?.type && activity?.range?.units !== "self"
    : (Number(item?.system?.level) || 0) >= 1
};

/**
 * The casting-window options for this use: [{ key, name, cost, affordable }], or null when the
 * caster has no Metamagic to offer for it (setting off, not a spell, no points, no options).
 */
export function castOptions(activity, config = {}) {
  const actor = activity?.actor, item = activity?.item;
  if (!isMetamagicEnabled() || item?.type !== "spell" || !actor) return null;
  if (inAntimagic(actor)) return null; // dnd5e 6.1+: no casting there
  const points = sorceryPoints(actor);
  if (points <= 0) return null;
  const options = [];
  for (const [key, option] of Object.entries(METAMAGIC)) {
    if (option.later) continue;
    const owned = feature(actor, option.identifier);
    if (!owned || !fits[key](activity, item, owned)) continue;
    const cost = metamagicCost(key, owned, castLevel(item, config));
    options.push({ key, name: option.name, cost, affordable: cost <= points, item: owned });
  }
  return options.length ? options : null;
}

// ── Casting: the window ───────────────────────────────────────────────────────

// This casting's Metamagic, by usage card id (saves) and by spell item uuid (its damage rolls).
const castsByUsage = new Map(), castsBySpell = new Map();
export const metamagicForUsage = (usageId) => castsByUsage.get(usageId) ?? null;
export const metamagicForSpell = (itemUuid) => castsBySpell.get(itemUuid) ?? null;

/**
 * dnd5e.preUseActivity (synchronous): a sorcerer's spell with Metamagic to offer opens the casting
 * window (unless it's being skipped); the last casting's range and Metamagic are put away. Never cancels.
 */
export function onPreUseMetamagic(activity, usageConfig, dialogConfig) {
  restoreRange(activity?.uuid);
  if (activity?.item?.uuid) castsBySpell.delete(activity.item.uuid);
  if (!castOptions(activity, usageConfig) || dialogConfig?.configure === false) return;
  usageConfig.ldaMetamagic ??= { choice: "", damageType: "" };
  // Only this casting's copy of the activity: dnd5e otherwise skips the window for cantrips.
  activity._requiresConfigurationDialog = () => true;
}

/** renderActivityUsageDialog: the Metamagic section of the casting window. */
export function onRenderUsageDialog(app, element) {
  const root = typeof element?.querySelector === "function" ? element : element?.[0] ?? app?.element;
  const activity = app?.activity ?? app?.options?.activity;
  const config = app?.config ?? app?.options?.config;
  const options = castOptions(activity, config);
  const form = root?.querySelector?.("form") ?? root;
  if (!options || !form) return;
  form.querySelectorAll(".lda-metamagic").forEach(el => el.remove());
  const choice = config?.ldaMetamagic?.choice ?? "";
  const type = config?.ldaMetamagic?.damageType || TRANSMUTABLE.find(t => !damageTypes(activity.item).has(t)) || "fire";
  const label = (t) => game.i18n.localize(CONFIG.DND5E?.damageTypes?.[t]?.label ?? t);
  const radio = (value, text, { disabled = false, checked = false } = {}) => `
    <label style="display:flex;align-items:center;gap:6px;margin:1px 0${disabled ? ";opacity:0.5" : ""}">
      <input type="radio" name="ldaMetamagic.choice" value="${value}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}> ${text}
    </label>`;
  const fieldset = document.createElement("fieldset");
  fieldset.className = "lda-metamagic";
  fieldset.innerHTML = `
    <legend>Metamagic <span style="opacity:0.7;font-weight:normal">(${sorceryPoints(activity.actor)} Sorcery Points)</span></legend>
    ${radio("", "None", { checked: !choice })}
    ${options.map(o => radio(o.key, `${escapeHTML(o.name)} <span style="opacity:0.7">(${o.cost})</span>`,
      { disabled: !o.affordable, checked: choice === o.key && o.affordable })).join("")}
    ${options.some(o => o.key === "transmuted") ? `
      <label style="display:flex;align-items:center;gap:6px;margin:4px 0 0">
        <span style="flex:1">Transmuted into</span>
        <select name="ldaMetamagic.damageType"${choice === "transmuted" ? "" : " disabled"}>
          ${TRANSMUTABLE.map(t => `<option value="${t}"${t === type ? " selected" : ""}>${escapeHTML(label(t))}</option>`).join("")}
        </select>
      </label>` : ""}`;
  const footer = form.querySelector(".form-footer, footer");
  if (footer) footer.before(fieldset); else form.append(fieldset);

  // 2024 Twinned: one level higher — added once the window closes, after dnd5e has worked out the slot's scaling.
  if (app && !app.ldaTwinListener && typeof app.addEventListener === "function") {
    app.ldaTwinListener = true;
    app.addEventListener("close", () => {
      const cfg = app.config;
      if (!app.used || cfg?.ldaMetamagic?.choice !== "twinned") return;
      const twin = feature(activity.actor, "twinned-spell");
      if (twin && rulesOf(twin) !== "2014") cfg.scaling = (Number(cfg.scaling) || 0) + 1;
    }, { once: true });
  }
}

// ── Casting: after the use ────────────────────────────────────────────────────

/**
 * dnd5e.postUseActivity: the chosen option. Synchronous up to dnd5e's follow-up roll (the range, a
 * 2014 Twinned attack's own rolls); then the points are spent and it's noted on the card.
 */
export function onMetamagicUsed(activity, usageConfig, results) {
  adjustCastRange(activity, null); // Eldritch Spear, even without Metamagic
  const key = usageConfig?.ldaMetamagic?.choice;
  const option = METAMAGIC[key];
  if (!option || option.later || !isMetamagicEnabled()) return;
  const actor = activity.actor, item = activity.item;
  const owned = feature(actor, option.identifier);
  const cost = owned ? metamagicCost(key, owned, castLevel(item, usageConfig)) : Infinity;
  if (!owned || cost > sorceryPoints(actor)) {
    ui.notifications?.warn(`Luck Dice Automation: not enough Sorcery Points for ${option.name}.`);
    return;
  }
  const state = { key, name: option.name, cost, rules: rulesOf(owned), damageType: usageConfig.ldaMetamagic?.damageType || null,
    usageId: results?.message?.id ?? null, notes: [] };
  if (state.usageId) castsByUsage.set(state.usageId, state);
  if (item?.uuid) castsBySpell.set(item.uuid, state);

  if (key === "distant") adjustCastRange(activity, "distant");
  let twinAttacks = false;
  if (key === "twinned" && state.rules === "2014" && isLike(activity, "attack") && usageConfig.subsequentActions !== false) {
    usageConfig.subsequentActions = false; // an attack at each of the two targets instead
    twinAttacks = true;
  }
  if (key === "transmuted" && state.damageType) state.notes.push(`damage becomes ${state.damageType}`);
  finishCasting(activity, usageConfig, results, state, { twinAttacks })
    .catch(err => console.error(`[${MODULE_ID}] metamagic:`, err));
}

async function finishCasting(activity, usageConfig, results, state, { twinAttacks }) {
  await spendSorceryPoints(activity.actor, state.cost);
  if (state.key === "extended") await extendConcentration(results, state);
  await noteMetamagic(results?.message, state);
  if (twinAttacks) await twinnedAttacks(activity, usageConfig, results);
  console.log(`[${MODULE_ID}] metamagic: ${activity.actor.name} — ${state.name} on ${activity.item?.name} (${state.cost} point${state.cost === 1 ? "" : "s"})`);
}

/** Note what was used on a card, adding to any notes already there. */
export async function noteMetamagic(message, state, extra = []) {
  if (!message?.setFlag) return;
  const notes = [...(state.notes ?? []), ...extra];
  await message.setFlag(MODULE_ID, METAMAGIC_FLAG, { name: state.name, cost: state.cost, notes });
}

// ── Range (Distant Spell, Eldritch Spear) ─────────────────────────────────────

// Activities whose range was changed for a casting, by uuid: the activity and its own range.
const rangeChanges = new Map();
function restoreRange(uuid) {
  const change = rangeChanges.get(uuid);
  if (!change) return;
  Object.assign(change.activity.range, change.original);
  clearTimeout(change.timer);
  rangeChanges.delete(uuid);
}

/**
 * An activity's range for this casting, or null when unchanged: Eldritch Spear's, then doubled by Distant
 * Spell (touch: 30 ft), then set for Automated Conditions 5e's Spell Sniper (ac5eSpellSniperRange).
 */
export function castRange(activity, choice) {
  const before = { value: activity.range.value, units: activity.range.units };
  let range = { ...before };
  const spear = eldritchSpearRange(activity);
  if (spear) range = spear;
  if (choice === "distant") {
    if (range.units === "touch") range = { value: 30, units: "ft" };
    else if (Number(range.value) >= 5) range = { ...range, value: Number(range.value) * 2 };
  }
  const forAC5E = ac5eSpellSniperRange(activity, Number(range.value));
  if (forAC5E !== null) range = { ...range, value: forAC5E };
  return range.value === before.value && range.units === before.units ? null : range;
}

/**
 * When Automated Conditions 5e checks range, it adds Spell Sniper itself — by the world's rules version, not
 * the feat's: +60 ft in a 2024 world (to a range of 10 ft or more), doubled in a 2014 one — after reading the
 * attack's range, so after a spell conduit (Kilian's Eldritch Rifle) has multiplied it. The range it should
 * end up with is the feat's own: doubled (2014) or 60 ft more (2024), the conduit's multiple applied to that
 * too. This is the range to give AC5E so its rule comes to that; null when there's nothing to correct.
 */
export function ac5eSpellSniperRange(activity, value) {
  if (!isLike(activity, "attack") || activity.item?.type !== "spell" || !Number.isFinite(value) || value <= 0) return null;
  const sniper = feature(activity.actor, "spell-sniper");
  const covers = ac5eCovers();
  if (!sniper || !(covers.outOfRange || covers.longRange)) return null;
  const unit = canvas?.grid?.distance ?? 5;
  const mult = conduitMultiplier(activity.item);
  const wanted = rulesOf(sniper) === "2014" ? value * 2 : (value / mult >= 2 * unit ? value + 12 * unit * mult : value);
  let modern = true;
  try { modern = game.settings.get("dnd5e", "rulesVersion") === "modern"; } catch { modern = true; }
  const given = modern ? (wanted - 12 * unit >= 2 * unit ? wanted - 12 * unit : wanted) : wanted / 2;
  return given === value ? null : given;
}

/**
 * This casting's range (castRange) on the casting's copy of the activity and on the actor's own (what
 * range checks read when the attack is rolled), each worked out from its own range — a conduit's copy
 * isn't the spell on the sheet — until the spell's next casting or ten minutes on.
 */
export function adjustCastRange(activity, choice) {
  if (!activity?.range) return;
  let real = null;
  try { real = fromUuidSync(activity.uuid, { strict: false }); } catch { real = null; }
  for (const target of new Set([activity, real].filter(a => a?.range))) {
    const range = castRange(target, choice);
    if (!range) continue;
    if (target !== activity && !rangeChanges.has(activity.uuid)) {
      const timer = setTimeout(() => restoreRange(activity.uuid), 600_000);
      timer?.unref?.(); // outside a browser (the tests), don't keep the process alive for it
      rangeChanges.set(activity.uuid, { activity: target, original: { value: target.range.value, units: target.range.units }, timer });
    }
    Object.assign(target.range, range);
    debug(`cast range: ${activity.item?.name}${target === activity ? "" : " (on the sheet)"} — ${range.value} ${range.units}`);
  }
}

// ── Extended Spell ────────────────────────────────────────────────────────────

/** A duration doubled, up to 24 hours (in seconds), or null when it can't be read. */
export function doubledDuration(duration) {
  const value = Number(duration?.value);
  const factor = { seconds: 1, minutes: 60, hours: 3600, days: DAY, rounds: 6, turns: 6 }[duration?.units ?? "seconds"];
  if (!Number.isFinite(value) || value <= 0 || !factor) return null;
  return { value: Math.min(value * factor * 2, DAY), units: "seconds" };
}

/** Extended: the caster's concentration lasts twice as long (2024: and is marked, for advantage on its saves). */
async function extendConcentration(results, state) {
  for (const effect of results?.effects ?? []) {
    if (!(effect?.statuses?.has?.("concentrating") || effect?.system?.type === "concentrating")) continue;
    const duration = doubledDuration(effect.duration);
    const update = { [`flags.${MODULE_ID}.extended`]: state.rules };
    if (duration) update.duration = { ...duration };
    await effect.update?.(update);
  }
}

/** 2024 Extended Spell: whether the creature is concentrating on an extended spell (advantage on its concentration saves). */
export function extendedConcentrationAdvantage(actor) {
  return [...(actor?.effects ?? [])].some(e => !e.disabled && e.getFlag?.(MODULE_ID, "extended") === "2024");
}

/** dnd5e.preRollConcentrationV2 — 2024 Extended Spell's advantage, with the other sources, noted for the card. Never cancels. */
export function onPreRollConcentrationMetamagic(config, dialog, message) {
  if (!isMetamagicEnabled() || !extendedConcentrationAdvantage(config?.subject)) return;
  const reasons = { advantage: ["Extended Spell"], disadvantage: [], bonuses: [], autoFail: null };
  reasons.finalMode = mergeRollMode(config, dialog, reasons);
  ensureFinalModeHook();
  if (message) foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.${SAVE_REASONS_FLAG}`, reasons);
}

// ── Careful, Heightened (save automation) ─────────────────────────────────────

/** The tokens behind save targets ({ token, actor, name }). */
async function tokensOf(targets) {
  return (await Promise.all(targets.map(async t => (await resolveTarget(t)).tokenDoc))).filter(Boolean);
}

/**
 * Careful (up to the Charisma modifier, minimum one: the caster's allies ticked) and Heightened (one
 * creature): asked of the caster before the saves are requested. Resolves with
 * { careful: Set of token uuids, heightened: token uuid | null }.
 */
export async function chooseSaveMetamagic(activity, targets, usage) {
  const state = usage ? metamagicForUsage(usage.id) : null;
  const out = { careful: new Set(), heightened: null, state };
  if (!state || !["careful", "heightened"].includes(state.key) || !targets.length) return out;
  const caster = activity.actor;
  const me = activity.getUsageToken?.()?.document ?? caster?.getActiveTokens?.()?.[0]?.document ?? null;
  const tokens = await tokensOf(targets);
  if (state.key === "careful") {
    const max = Math.max(1, Number(caster?.system?.abilities?.cha?.mod ?? 0) || 0);
    const picked = await pickCreatures("Careful Spell",
      `Choose up to ${max} creature${max === 1 ? "" : "s"} to protect: they succeed on the save${state.rules === "2024" ? " and take no damage where a success means half" : ""}.`,
      tokens, { max, checked: (t) => !!me && t.disposition === me.disposition });
    for (const t of picked ?? []) out.careful.add(t.uuid);
    if (out.careful.size) state.notes.push(`protected ${(picked ?? []).map(t => t.name).join(", ")}`);
  } else {
    const picked = await pickCreatures("Heightened Spell", "Choose the creature that saves with disadvantage.", tokens,
      { max: 1, checked: (t) => !!me && t.disposition !== me.disposition });
    out.heightened = picked?.[0]?.uuid ?? null;
    if (out.heightened) state.notes.push(`${picked[0].name} saves with disadvantage`);
  }
  if (usage) await noteMetamagic(usage, state);
  return out;
}

// ── Twinned (2014): an attack at each target ──────────────────────────────────

/** 2014 Twinned on a spell attack: confirm the two targets, then one attack roll at each. */
async function twinnedAttacks(activity, usageConfig, results) {
  let tokens = [...game.user.targets].map(t => t.document);
  tokens = await confirmTargets(activity, tokens, { hint: "Twinned Spell: target the two creatures (hold Shift to target both), then Confirm." });
  tokens = (tokens ?? []).filter(t => t?.actor).slice(0, 2);
  if (!tokens.length) return;
  const restore = [...game.user.targets].map(t => t.id);
  try {
    for (const [i, token] of tokens.entries()) {
      canvas.tokens?.setTargets([token.id], { mode: "replace" });
      const rolls = await activity.rollAttack({ event: usageConfig?.event }, {}, { data: {
        flavor: `${activity.item?.name ?? activity.name} - ${game.i18n.localize("DND5E.AttackRoll")} (Twinned ${i + 1} of ${tokens.length})`,
        system: { origin: results?.message?.id }
      } });
      const message = rolls?.[0]?.parent;
      if (!message) break;
      await pendingAttacks.get(message.id); // its Luck Dice and damage, before the next
    }
  } finally {
    canvas.tokens?.setTargets(restore, { mode: "replace" });
  }
}

// ── Transmuted (damage rolls) ─────────────────────────────────────────────────

/** dnd5e.preRollDamageV2 — Transmuted Spell: the listed damage types become the one chosen. Never cancels. */
export function onPreRollDamageMetamagic(config) {
  const item = config?.subject?.item;
  const state = item?.uuid ? metamagicForSpell(item.uuid) : null;
  if (state?.key !== "transmuted" || !TRANSMUTABLE.includes(state.damageType)) return;
  for (const roll of config.rolls ?? []) {
    const options = (roll.options ??= {});
    const types = options.types?.length ? [...options.types] : options.type ? [options.type] : [];
    if (!types.some(t => TRANSMUTABLE.includes(t))) continue;
    options.type = state.damageType;
    options.types = [state.damageType];
  }
}

// ── Empowered (when the damage is rolled) ─────────────────────────────────────

/** Every die result on a card's damage rolls that could be rerolled: [{ roll, term, result, faces, value }]. */
function damageDice(message) {
  const dice = [];
  (message?.rolls ?? []).forEach((roll, rollIndex) => {
    if (roll?.options?.ldaLuckDice || !(roll instanceof CONFIG.Dice.DamageRoll)) return;
    (roll.dice ?? []).forEach((term, termIndex) => (term.results ?? []).forEach((result, resultIndex) => {
      if (result.active !== false && !result.rerolled) dice.push({ rollIndex, termIndex, resultIndex, faces: term.faces, value: result.result });
    }));
  });
  return dice;
}

/**
 * After a spell's damage is rolled (the caster's client, before Luck Dice): Empowered Spell — the
 * caster ticks up to their Charisma modifier of the dice to reroll, and must use the new rolls.
 */
export async function offerEmpowered(message, activity) {
  const actor = activity?.actor;
  if (!isMetamagicEnabled() || activity?.item?.type !== "spell" || !actor?.isOwner || message?.getFlag?.(MODULE_ID, "empowered")) return;
  if (inAntimagic(actor)) return; // dnd5e 6.1+: no casting there
  const empowered = feature(actor, "empowered-spell");
  const cost = empowered ? metamagicCost("empowered", empowered) : Infinity;
  if (!empowered || sorceryPoints(actor) < cost) return;
  const dice = damageDice(message);
  const DialogV2 = foundry.applications.api?.DialogV2;
  if (!dice.length || !DialogV2) return;
  const max = Math.max(1, Number(actor.system?.abilities?.cha?.mod ?? 0) || 0);
  const rows = dice.map((d, i) => `
    <label style="display:inline-flex;align-items:center;gap:4px;margin:2px 8px 2px 0">
      <input type="checkbox" name="lda-die" value="${i}"> d${d.faces}: <strong>${d.value}</strong>
    </label>`).join("");
  const limit = (root) => {
    const boxes = [...(root.querySelectorAll?.('input[name="lda-die"]') ?? [])];
    const full = boxes.filter(b => b.checked).length >= max;
    for (const box of boxes) box.disabled = full && !box.checked;
  };
  const picked = await DialogV2.wait({
    window: { title: "Empowered Spell" },
    content: `<p>Reroll up to ${max} of these damage dice (${cost} Sorcery Point${cost === 1 ? "" : "s"})? The new rolls stand.</p><div>${rows}</div>`,
    buttons: [
      { action: "ok", label: "Reroll", icon: "fa-solid fa-rotate", default: true,
        callback: (_event, button) => [...button.form.querySelectorAll('input[name="lda-die"]:checked')].map(i => Number(i.value)).slice(0, max) },
      { action: "no", label: "No", icon: "fa-solid fa-xmark", callback: () => [] }
    ],
    render: (_event, dialog) => {
      const root = dialog?.element;
      if (!root?.addEventListener) return;
      root.addEventListener("change", () => limit(root));
      limit(root);
    },
    rejectClose: false
  });
  if (!Array.isArray(picked) || !picked.length) return;
  const rolls = await rerollDice(message.rolls, picked.map(i => dice[i]));
  const changes = picked.map((i, n) => `${dice[i].value}→${rolls.newValues[n]}`);
  await spendSorceryPoints(actor, cost);
  await message.update({ rolls: rolls.rolls, [`flags.${MODULE_ID}.empowered`]: true,
    [`flags.${MODULE_ID}.${METAMAGIC_FLAG}`]: { name: "Empowered Spell", cost, notes: [`rerolled ${changes.join(", ")}`] } });
  console.log(`[${MODULE_ID}] metamagic: ${actor.name} — Empowered Spell rerolled ${changes.join(", ")}`);
}

/** Copies of the rolls with the picked dice rerolled (the old results shown as rerolled). */
export async function rerollDice(rolls, picks) {
  const copies = rolls.map(r => (typeof r?.toJSON === "function" && r.constructor?.fromData) ? r.constructor.fromData(r.toJSON()) : r);
  const newValues = [];
  for (const pick of picks) {
    const roll = copies[pick.rollIndex];
    const term = roll?.dice?.[pick.termIndex];
    const old = term?.results?.[pick.resultIndex];
    if (!old) { newValues.push(null); continue; }
    const fresh = await new Roll(`1d${pick.faces}`).evaluate();
    if (game.dice3d) await game.dice3d.showForRoll(fresh, game.user, true, null, false);
    Object.assign(old, { active: false, rerolled: true });
    term.results.push({ result: fresh.total, active: true });
    newValues.push(fresh.total);
  }
  for (const roll of new Set(picks.map(p => copies[p.rollIndex]).filter(Boolean))) {
    if (typeof roll._evaluateTotal === "function") roll._total = roll._evaluateTotal();
  }
  return { rolls: copies, newValues };
}
