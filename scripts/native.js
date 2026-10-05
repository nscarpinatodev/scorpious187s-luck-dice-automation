// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Luck Dice without Midi-QoL, on dnd5e 6's own rolls. Active only when Midi-QoL
// is not (Midi mode lives in attack.js).
//
// dnd5e 6 has no hook between evaluating a roll and posting its card, so luck is
// spent after the card posts: a post-roll hook (dnd5e.roll…V2) reaches the card
// through roll.parent (set by BasicRoll.buildPost), prompts the roller, and
// writes the corrected roll back into the card's rolls. dnd5e then redraws the
// card from those rolls itself — attack hit/miss (system.evaluatedTargets),
// success or failure against the DC, and the damage tray's total. What was spent
// is kept in this module's flag on the same card and shown under the roll.
//
// The roller authored the card, so their client can update it directly.
// Depends on: core.js, attack.js, skill-check.js, saving-throw.js (loaded first).

(() => {
const LDA = window.LDA;
const {
  MODULE_ID, LUCK_DICE_ITEM_NAME, IMPACT_DICE_ITEM_NAME, clamp, debug,
  getDiceUses, actorHasLuckDice, promptChoice, promptSlider, getKeptD20Result, spendDiceFromPools,
  buildDiceAvailableHTML, isLuckDiceEnabled, isInspirationEnabled, actorHasInspiration,
  combineRolls, HISTORY_FLAG, diceFaces, renderLuckSection, requestRollActors,
  getAttackAutomation, getSaveAutomation, getPrivateRollOutcome,
  readCardHistory, updateRollCard, recordCardStep, finishCardHistory, cardReporter,
} = LDA;

const APPLIED_FLAG = "appliedDamage";
const escapeHTML   = (s) => (foundry.utils.escapeHTML ?? String)(String(s ?? ""));

console.log(`[${MODULE_ID}] native.js parsed — user=${game?.user?.name ?? "unknown"} isGM=${game?.user?.isGM ?? "?"}`);

/** Whether luck dice or inspiration could help this actor at all. */
function canUseLuck(actor) {
  return actor?.type === "character" && (
    (isLuckDiceEnabled() && actorHasLuckDice(actor)) ||
    (isInspirationEnabled() && actorHasInspiration(actor))
  );
}

// ── Attacks ───────────────────────────────────────────────────────────────────

/**
 * true if any target is hit, false if all are missed, null when it can't be
 * judged (no targets, or none with a known AC). dnd5e's evaluatedTargets
 * compares the card's D20Roll to each target's AC, with natural 20 / 1 rules.
 */
function attackHitState(message) {
  const targets = (message?.system?.evaluatedTargets ?? []).filter(t => Number.isFinite(t.ac));
  if (!targets.length) return null;
  return targets.some(t => !t.isMiss);
}

/** Attack adapter over a dnd5e attack card, for the shared attack prompts. */
function nativeAttack(message, actor) {
  const current = () => message.rolls[0];
  return {
    actor,
    state:    { attackPrompted: false, luckSpentOnAttack: 0 },
    total:    () => Number(current()?.total ?? 0),
    hitState: () => attackHitState(message),
    async reroll(evaluate, label) {
      const before = this.total();
      const roll   = await evaluate(current());
      await recordCardStep(message, roll, before, {
        kind: "attack", label, total: roll.total, detail: `d20: ${getKeptD20Result(roll) ?? "?"}`
      });
      return roll;
    },
    async addDice(diceCount) {
      const bonus = await new Roll(`${diceCount}d6`).evaluate();
      if (game.dice3d) await game.dice3d.showForRoll(bonus, game.user, true, null, false);
      const before = this.total();
      const roll   = combineRolls(current(), bonus);
      await recordCardStep(message, roll, before, {
        kind: "attack", label: `Added ${diceCount}d6 Luck Dice`, total: roll.total,
        detail: `${diceFaces(bonus).join(", ")} = +${bonus.total}`
      });
      return bonus;
    },
    finish: () => finishCardHistory(message, attackHitState(message) === true ? "hit" : "miss")
  };
}

/**
 * dnd5e.rollAttackV2 — on a miss, the Luck Dice prompts (shared with Midi mode)
 * for characters who have dice or inspiration; then, for any attacker, the
 * attack automation setting decides what happens on a hit.
 */
async function onAttackRolled(rolls, data) {
  try {
    const roll     = rolls?.[0];
    const message  = roll?.parent;
    const activity = data?.subject;
    const actor    = activity?.actor;
    if (!message || !activity) return;

    if (canUseLuck(actor)) {
      const hitState = attackHitState(message);
      debug(`native attack: ${actor.name} total=${roll.total} hitState=${hitState}`);
      if (hitState === false) {
        const attack = nativeAttack(message, actor);
        if (getKeptD20Result(roll) === 1) await LDA.promptNatOne(attack);
        else await LDA.promptLuckOnMiss(attack);
      }
    }

    await syncAutomatedAnimations(message, activity);
    await handlePrivateAttack(message, activity);
    await automateAttack(message, activity);
  } catch (err) {
    console.error(`[${MODULE_ID}] native attack error:`, err);
  }
}

/**
 * Automated Animations (without Midi) judges an attack from its original roll —
 * total vs the AC dnd5e sets only when exactly one token is targeted — and keeps
 * that result on the actor (actor.hits[activity.relativeID]) for its damage-roll
 * animation ("Play animation on damage roll"). Bring it in line with the card's
 * actual result, so a miss Luck Dice turned into a hit animates as a hit, and so
 * do natural 20s / 1s and attacks on several targets (any hit counts, like AA's
 * single result). Only runs before the damage is rolled; can't undo an animation
 * AA already played at attack time.
 *
 * AA's cache is internal, not an API: this only rewrites an entry AA itself made
 * for this activity, and never throws.
 */
async function syncAutomatedAnimations(message, activity) {
  try {
    if (!game.modules.get("autoanimations")?.active) return;
    // Let AA's own rollAttackV2 handler record its result first: hook listeners
    // run in turn, and AA records it before its first await.
    await Promise.resolve();
    const hits = activity?.actor?.hits;
    const id   = activity?.relativeID;
    if (!hits || !id || !(id in hits)) return;
    const hit = attackHitState(message);
    if (hit === null || hits[id] === hit) return;
    hits[id] = hit;
    debug(`Automated Animations: ${activity.actor.name}'s ${activity.item?.name ?? activity.name} → ${hit ? "hit" : "miss"} (from the card)`);
  } catch (err) {
    debug("Automated Animations sync skipped:", err);
  }
}

// ── Damage ────────────────────────────────────────────────────────────────────

/**
 * The attack card from the same use as this damage roll. Every roll from an
 * activity carries options.originatingMessage — the id of its usage card.
 */
function findAttackCard(damageRoll) {
  const origin = damageRoll?.options?.originatingMessage;
  if (!origin) return null;
  return game.messages.contents.findLast(m =>
    m.system && ("evaluatedTargets" in m.system) &&
    m.rolls?.[0]?.options?.originatingMessage === origin
  ) ?? null;
}

/**
 * Options for the luck damage roll: the damage type and properties (so the
 * damage tray applies resistances to it like the rest of the damage) and the
 * critical multiplier settings, so dnd5e scales it on a critical hit. The
 * weapon's own extra critical dice / damage are left off — they belong to the
 * weapon's roll, not the luck dice.
 */
function luckDamageOptions(roll) {
  const { type, types, properties, isCritical, critical } = roll.options ?? {};
  return {
    type, types, isCritical,
    properties: [...(properties ?? [])],
    critical:   { ...foundry.utils.deepClone(critical ?? {}), bonusDice: 0, bonusDamage: "" }
  };
}

/** dnd5e.rollDamageV2 — offer luck dice on the damage of a hit. */
async function onDamageRolled(rolls, data) {
  try {
    const roll     = rolls?.[0];
    const message  = roll?.parent;
    const activity = data?.subject;
    const actor    = activity?.actor;
    if (!message || !activity || activity.type === "heal") return;
    if (!(roll instanceof CONFIG.Dice.DamageRoll)) return;
    if (actor?.type !== "character" || !isLuckDiceEnabled() || !actorHasLuckDice(actor)) return;
    if (message.getFlag(MODULE_ID, HISTORY_FLAG)?.entries?.some(e => e.kind === "damage")) return;

    // Only after a hit. A use with no attack card (a save-for-damage spell) is offered.
    const attackCard = findAttackCard(roll);
    if (attackCard && attackHitState(attackCard) === false) {
      debug(`native damage: ${actor.name}'s attack missed — no luck damage prompt`);
      return;
    }

    const totalAvail = getDiceUses(actor, LUCK_DICE_ITEM_NAME) + getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
    if (totalAvail <= 0) return;

    const isCrit = rolls.some(r => r.isCritical);
    const critNote = isCrit ? `<p><em>Critical hit! Extra dice are rolled as critical damage.</em></p>` : "";
    const raw = await promptSlider(
      isCrit ? "Add Dice to Damage (Critical Hit!)" : "Add Dice to Damage",
      `<p>Add Luck Dice to this damage?</p>${critNote}${buildDiceAvailableHTML(actor)}`,
      "luckDamageCount",
      0, totalAvail, 0
    );
    const diceCount = clamp(Number(raw ?? 0), 0, totalAvail);
    if (!Number.isFinite(diceCount) || diceCount <= 0) return;

    const spent = await spendDiceFromPools(actor, diceCount);
    if (spent < 1) return;

    const bonus = new CONFIG.Dice.DamageRoll(`${diceCount}d6`, roll.data ?? {}, luckDamageOptions(roll));
    await bonus.evaluate();
    if (game.dice3d) await game.dice3d.showForRoll(bonus, game.user, true, null, false);

    const history = readCardHistory(message);
    history.entries.push({ kind: "damage", label: `+${diceCount}d6 Luck Dice to damage${isCrit ? " (critical)" : ""}` });
    // The damage tray totals every DamageRoll on the card, so it applies these too.
    await updateRollCard(message, { rolls: [...message.rolls, bonus], history });
    console.log(`[${MODULE_ID}] native damage: ${actor.name} added ${diceCount}d6 = ${bonus.total}${isCrit ? " (critical)" : ""}`);
  } catch (err) {
    console.error(`[${MODULE_ID}] native damage error:`, err);
  }
}

// ── Attack automation ─────────────────────────────────────────────────────────
// The "attackAutomation" setting: after an attack (and any Luck Dice), on a hit —
//   prompt: a one-click "Roll Damage" prompt; roll: roll damage automatically;
//   apply:  roll damage, then apply it to each hit target.
// Damage is rolled exactly as dnd5e's own damage button does (ability, ammunition,
// attack mode and critical from the attack card). Applying it changes the targets'
// actors, which needs the GM: the primary GM's client does it, over the module
// socket (scorpious187s-lib's router), with dnd5e's applyDamage handling
// resistances, temp HP and healing types.

// Luck Dice prompts on damage cards still in progress, by card id. Applying waits
// for them, so dice added to the damage are part of what gets applied.
const pendingLuckDamage = new Map();

// scorpious187s-lib socket router; set on ready.
let socket = null;

/** Whether the activity has any damage to roll. */
function hasDamage(activity) {
  return (activity.damage?.parts?.length ?? 0) > 0 || !!activity.damage?.includeBase;
}

/** Roll the activity's damage for an attack card, the way dnd5e's damage button does. */
async function rollAttackDamage(attackMessage, activity, { fastForward }) {
  const { ability, ammunitionItem: ammunition, mode: attackMode } = attackMessage.system ?? {};
  const isCritical = !!attackMessage.rolls[0]?.isCritical;
  const dialog = fastForward ? { configure: false }
    : isCritical ? { options: { defaultButton: "critical" } } : {};
  const rolls = await activity.rollDamage({ ability, ammunition, attackMode, isCritical }, dialog);
  return rolls?.[0]?.parent ?? null;
}

async function automateAttack(attackMessage, activity) {
  const mode = getAttackAutomation();
  if (mode === "off" || typeof activity.rollDamage !== "function" || !hasDamage(activity)) return;

  const hits = (attackMessage.system?.evaluatedTargets ?? []).filter(t => !t.isMiss);
  if (!hits.length) { debug("attack automation: no hit targets"); return; }

  if (mode === "prompt") {
    const choice = await promptChoice(
      "Attack Hit",
      `<p>Hit <strong>${escapeHTML(hits.map(t => t.name).join(", "))}</strong>. Roll damage?</p>`,
      [{ action: "roll", label: "Roll Damage" }, { action: "skip", label: "Not Now" }]
    );
    if (choice !== "roll") return;
  }

  const damageMessage = await rollAttackDamage(attackMessage, activity, { fastForward: mode !== "prompt" });
  if (!damageMessage || mode !== "apply") return;

  await pendingLuckDamage.get(damageMessage.id);
  await requestApplyDamage(damageMessage, hits);
}

/** Apply a damage card to targets — directly as a GM, otherwise via the primary GM. */
async function requestApplyDamage(damageMessage, targets) {
  const payload = {
    messageId: damageMessage.id,
    targets:   targets.map(({ actor, token, name, multiplier, saved }) => ({ actor, token, name, multiplier, saved }))
  };
  if (game.user.isGM) return applyCardDamage(payload);

  const primaryGM = game.modules.get("scorpious187s-lib")?.api?.utils?.primaryGM?.();
  if (!socket || !primaryGM) {
    ui.notifications?.warn("Luck Dice Automation: no GM is connected, so the damage wasn't applied — use the damage card's tray.");
    return;
  }
  socket.emit("applyDamage", payload);
}

/**
 * GM side: apply every DamageRoll on the card to each target, aggregated the way
 * dnd5e's own chat damage application does it, and note what was applied on the
 * card. A target's optional multiplier scales its damage (a successful save:
 * ½ or 0 per the activity's on-save rule); `saved` marks it on the card.
 */
async function applyCardDamage({ messageId, targets }) {
  const message   = game.messages.get(messageId);
  const aggregate = globalThis.dnd5e?.dice?.aggregateDamageRolls;
  if (!message || !aggregate) {
    console.error(`[${MODULE_ID}] applyCardDamage: ${message ? "dnd5e.dice.aggregateDamageRolls missing" : `no message ${messageId}`}`);
    return;
  }
  const damageRolls = message.rolls.filter(r => r instanceof CONFIG.Dice.DamageRoll);
  if (!damageRolls.length) return;

  const damages = aggregate(damageRolls, { respectProperties: true }).map(roll => ({
    value:      Math.max(0, roll.total) * (roll.options.type in CONFIG.DND5E.healingTypes ? -1 : 1),
    type:       roll.options.type,
    properties: new Set(roll.options.properties ?? [])
  }));

  const applied = [];
  for (const target of targets ?? []) {
    const actor = (await fromUuid(target.token))?.actor ?? await fromUuid(target.actor);
    if (!actor?.applyDamage) continue;
    const multiplier = Number.isFinite(target.multiplier) ? target.multiplier : 1;
    const amount = Number(actor.calculateDamage?.(damages, { multiplier })?.amount ?? 0);
    await actor.applyDamage(damages, { multiplier, isDelta: true, originatingMessage: message });
    applied.push({ token: target.token, name: target.name ?? actor.name, amount, saved: !!target.saved });
  }
  if (applied.length) await message.setFlag(MODULE_ID, APPLIED_FLAG, applied);

  // The GM's private damage card: players learn what happened to their characters.
  if (isPrivateGMCard(message) && getPrivateRollOutcome() === "outcome") {
    const byToken = new Map((targets ?? []).map(t => [t.token, t]));
    const rows = playerTargets(targets).map(t => {
      const entry = applied.find(a => a.token === t.token);
      const saved = byToken.get(t.token)?.saved;
      return { token: t.token, name: t.name, damage: entry?.amount, ...(typeof saved === "boolean" ? { saved } : {}) };
    }).filter(r => Number.isFinite(r.damage));
    const activity = message.getAssociatedActivity?.();
    await recordOutcome(useKey(message), { actor: activity?.actor ?? message.speakerActor, title: outcomeTitle(activity, message) }, rows);
  }
  console.log(`[${MODULE_ID}] applyCardDamage: ${applied.map(a => `${a.name} ${a.amount}`).join(", ") || "no targets"}`);
}

// ── The GM's private rolls ────────────────────────────────────────────────────
// The "privateRollOutcome" setting, for GM rolls made privately (whispered or
// blind) that affect player characters:
//   outcome: one public card per use with just the outcome for those characters
//            — hit / miss, saved / failed, damage taken — added to as the use
//            resolves; never the NPC's totals, bonuses or DCs;
//   share:   the GM's attack and damage cards are also whispered to the owners
//            of the player characters they target;
//   private: nothing.

const OUTCOME_FLAG = "outcome";
// Outcome cards this GM client created, by use (the usage card's id).
const outcomeCards = new Map();

/** A GM's card that players can't see (whispered or blind). */
function isPrivateGMCard(message) {
  return !!message?.author?.isGM && ((message.whisper?.length ?? 0) > 0 || !!message.blind);
}

/** The use a card belongs to: its usage card (every activity roll links to it). */
function useKey(message) {
  return message.rolls?.[0]?.options?.originatingMessage ?? message.id;
}

/** Card target descriptors whose actors belong to players, with those players' ids. */
function playerTargets(descriptors) {
  return (descriptors ?? []).map(t => {
    let actor = null;
    try { actor = fromUuidSync(t.token)?.actor ?? fromUuidSync(t.actor); } catch {}
    const owners = game.users.filter(u => !u.isGM && actor?.testUserPermission(u, "OWNER")).map(u => u.id);
    return owners.length ? { ...t, owners } : null;
  }).filter(Boolean);
}

/** Share mode: also whisper a private GM card to the owners of the player characters it targets. */
async function shareWithTargets(message, descriptors) {
  const owners = playerTargets(descriptors).flatMap(t => t.owners);
  const whisper = [...new Set([...(message.whisper ?? []), ...owners])];
  if (whisper.length === (message.whisper?.length ?? 0) && !message.blind) return;
  await message.update({ whisper, blind: false });
}

/** Outcome card markup: one line per player character. */
function renderOutcome({ title, rows }) {
  const result = (r) => [
    r.hit === true    ? `<strong style="color:#719f50">HIT</strong>` : "",
    r.hit === false   ? `<strong style="color:#c0392b">MISS</strong>` : "",
    r.saved === true  ? `<strong style="color:#719f50">saved</strong>` : "",
    r.saved === false ? `<strong style="color:#c0392b">failed</strong>` : "",
    Number.isFinite(r.damage) ? (r.damage < 0 ? `healed ${-r.damage}` : `${r.damage} damage`) : ""
  ].filter(Boolean).join(" · ");
  return `
    <div class="lda-outcome">
      <p style="margin:0 0 4px"><strong>${escapeHTML(title)}</strong></p>
      ${rows.map(r => `
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span>${escapeHTML(r.name)}</span><span>${result(r)}</span>
        </div>`).join("")}
    </div>`;
}

/**
 * Outcome mode: add or update player characters' rows on the public outcome
 * card for a use, creating it the first time. rows: [{ token, name, hit?,
 * saved?, damage? }]. Created without a message mode, so it's public however
 * the GM's own rolls are set.
 */
async function recordOutcome(key, { actor, title }, rows) {
  if (!rows.length) return;
  const existing = game.messages.get(outcomeCards.get(key));
  const data = foundry.utils.deepClone(existing?.getFlag(MODULE_ID, OUTCOME_FLAG) ?? { title, rows: [] });
  for (const row of rows) {
    const current = data.rows.find(r => r.token === row.token);
    if (current) Object.assign(current, row);
    else data.rows.push(row);
  }
  const content = renderOutcome(data);
  if (existing) {
    await existing.update({ content, [`flags.${MODULE_ID}.${OUTCOME_FLAG}`]: data });
    return;
  }
  const created = await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags:   { [MODULE_ID]: { [OUTCOME_FLAG]: data } }
  });
  if (created) outcomeCards.set(key, created.id);
}

/** "Goblin — Scimitar" for an activity's outcome card. */
function outcomeTitle(activity, message) {
  const actorName = activity?.actor?.name ?? message?.speaker?.alias ?? "";
  const itemName  = activity?.item?.name ?? activity?.name ?? "";
  return [actorName, itemName].filter(Boolean).join(" — ");
}

/** A GM's private attack card: outcome rows (hit / miss) or sharing, per the setting. */
async function handlePrivateAttack(message, activity) {
  if (!isPrivateGMCard(message)) return;
  const mode = getPrivateRollOutcome();
  if (mode === "share") return shareWithTargets(message, message.system?.targets);
  if (mode !== "outcome") return;
  const rows = playerTargets(message.system?.evaluatedTargets).map(t => ({ token: t.token, name: t.name, hit: !t.isMiss }));
  await recordOutcome(useKey(message), { actor: activity?.actor, title: outcomeTitle(activity, message) }, rows);
}

// ── Save automation ───────────────────────────────────────────────────────────
// The "saveAutomation" setting, for save activities (e.g. Fireball) used on targets:
//   request: every target is asked to save — players by a prompt, the GM by one
//            prompt for its batch; nothing waits on the results.
//   npc:     the GM's client rolls the saves it handles; players roll from the
//            card as usual.
//   full:    the GM rolls its saves and players are prompted (Luck Dice on a
//            failure); once every save is in, damage is rolled once and applied
//            per target — full on a failure, per the on-save rule on a success.
// Orchestrated on the caster's client. The usage card stores no targets, so the
// caster's targets at the moment of use go with each request. Saves are rolled
// exactly as dnd5e's save button rolls them: the activity's save bonus, and the
// card linked to the usage card via system.origin so dnd5e's summary lists it.
// Who rolls: a target's active player owner; otherwise (NPCs, offline players)
// the primary GM.

const SAVE_RESPONSE_TIMEOUT = 180_000;

// Luck Dice prompts on d20 cards still in progress, by card id.
const pendingLuckChecks = new Map();
// Save requests this (the caster's) client is waiting on, by request id.
const pendingSaveRequests = new Map();

/** Track an in-progress Luck Dice prompt for a card, so automation can wait for it. */
function trackPending(map, id, promise) {
  if (!id) return;
  map.set(id, promise);
  promise.finally(() => { if (map.get(id) === promise) map.delete(id); });
}

function getPrimaryGM() {
  return game.modules.get("scorpious187s-lib")?.api?.utils?.primaryGM?.() ?? null;
}

/** The active, non-GM owner of an actor, if any. */
function activePlayerOwner(actor) {
  return game.users.find(u => !u.isGM && u.active && actor?.testUserPermission(u, "OWNER")) ?? null;
}

function abilityLabel(ability) {
  return game.i18n.localize(CONFIG.DND5E.abilities[ability]?.label ?? ability);
}

/** Resolve a target descriptor ({ actor, token }) to its token document and actor. */
async function resolveTarget(target) {
  const tokenDoc = target.token ? await fromUuid(target.token) : null;
  const actor    = tokenDoc?.actor ?? (target.actor ? await fromUuid(target.actor) : null);
  return { tokenDoc, actor };
}

/** A batch's results when it couldn't be rolled. */
const noResults = (targets) => targets.map(t => ({ token: t.token, result: null }));

/**
 * Roll one target's save the way dnd5e's save button does, then wait for any
 * Luck Dice spent on it. Returns { passed, total }, or null if it wasn't rolled.
 *
 * `link` ties the save card to the usage card (system.origin), as dnd5e's button
 * does. With dnd5e's "summarize chat" setting a linked save card is hidden and
 * shown only as a summary inside the usage card — under that card's visibility,
 * and without the Luck history. So only GM-rolled saves are linked; a player's
 * own save stays a normal card, where they see their roll, any Luck Dice spent,
 * and the result.
 */
async function rollAutomatedSave(target, { activityUuid, usageId, ability, dc, fastForward, link }) {
  const { tokenDoc, actor } = await resolveTarget(target);
  if (!actor?.rollSavingThrow) return null;
  const activity = activityUuid ? await fromUuid(activityUuid) : null;

  const rollData = { ability, target: dc };
  if (activity?.save?.bonus) {
    const bonus     = CONFIG.Dice.BasicRoll.replaceFormulaData(activity.save.bonus, activity.getRollData(), { missing: 0 });
    const bonusData = CONFIG.Dice.BasicRoll.constructParts({ activityBonus: bonus });
    if (bonusData.parts.length) rollData.rolls = [bonusData];
  }
  const speaker = ChatMessage.getSpeaker({ actor, scene: tokenDoc?.parent ?? canvas.scene, token: tokenDoc });
  const rolls = await actor.rollSavingThrow(rollData, fastForward ? { configure: false } : {}, {
    data: { speaker, system: { ...(activity?.messageSources ?? {}), ...(link ? { origin: usageId } : {}) } }
  });
  const message = rolls?.[0]?.parent;
  if (!message) return null;

  await pendingLuckChecks.get(message.id);
  const final = message.rolls[0];
  return { passed: !!final?.isSuccess, total: Number(final?.total ?? 0) };
}

/**
 * GM side: roll the saves for the targets the GM handles (NPCs, offline
 * players). With `prompt` (request mode), asks once for the whole batch first.
 */
async function rollGMSaves(request) {
  const { targets } = request;
  if (request.prompt) {
    const choice = await promptChoice(
      "Saving Throws",
      `<p><strong>${escapeHTML(request.activityName)}</strong>${request.casterName ? ` (${escapeHTML(request.casterName)})` : ""}:
       roll <strong>${escapeHTML(abilityLabel(request.ability))}</strong> saves (DC ${request.dc}) for
       <strong>${escapeHTML(targets.map(t => t.name).join(", "))}</strong>?</p>`,
      [{ action: "roll", label: "Roll Saves" }, { action: "skip", label: "Skip" }]
    );
    if (choice !== "roll") return noResults(targets);
  }
  const results = [];
  for (const target of targets) {
    try {
      results.push({ token: target.token, result: await rollAutomatedSave(target, { ...request, fastForward: true, link: true }) });
    } catch (err) {
      console.error(`[${MODULE_ID}] rollGMSaves: ${target.name}:`, err);
      results.push({ token: target.token, result: null });
    }
  }
  return results;
}

/** Player side: prompt for this player's target, then roll with dnd5e's dialog. */
async function rollPlayerSave(request) {
  const [target] = request.targets;
  const choice = await promptChoice(
    "Saving Throw",
    `<p><strong>${escapeHTML(request.activityName)}</strong>${request.casterName ? ` from ${escapeHTML(request.casterName)}` : ""}:
     <strong>${escapeHTML(target.name)}</strong> must make a <strong>${escapeHTML(abilityLabel(request.ability))}</strong>
     saving throw (DC ${request.dc}).</p>`,
    [{ action: "roll", label: "Roll Save" }, { action: "dismiss", label: "Dismiss" }]
  );
  if (choice !== "roll") return noResults(request.targets);
  return [{ token: target.token, result: await rollAutomatedSave(target, { ...request, fastForward: false, link: false }) }];
}

/**
 * Have a batch of saves rolled by `rollerId` (a player's id, or null for the
 * primary GM) and resolve with [{ token, result }]. Rolls locally when this
 * client is the roller; otherwise asks over the socket and waits, giving up
 * (null results) after SAVE_RESPONSE_TIMEOUT.
 */
function requestSaves(rollerId, request) {
  if (rollerId === null ? game.user.isGM : rollerId === game.user.id) {
    return rollerId === null ? rollGMSaves(request) : rollPlayerSave(request);
  }
  if (!socket) return Promise.resolve(noResults(request.targets));

  const requestId = foundry.utils.randomID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingSaveRequests.delete(requestId);
      resolve(noResults(request.targets));
    }, SAVE_RESPONSE_TIMEOUT);
    pendingSaveRequests.set(requestId, (results) => {
      clearTimeout(timeout);
      pendingSaveRequests.delete(requestId);
      resolve(results);
    });
    const payload = { ...request, requestId, from: game.user.id };
    if (rollerId === null) socket.emit("rollGMSaves", payload);
    else socket.emit("rollPlayerSave", { ...payload, to: rollerId });
  });
}

/**
 * The creatures inside an activity's placed area, filtered by what it affects
 * (activity.target.affects.type): enemies (a different disposition from the
 * caster), allies / willing (the same), the caster alone (self), or every
 * creature. The caster is left out when the area is cast from themselves
 * (range "self", e.g. Burning Hands); dead creatures are left out, and so are
 * hidden tokens when a player casts — they can't target what they can't see.
 */
function tokensInActivityArea(activity, regions) {
  const scene  = regions[0]?.parent;
  const caster = activity.getUsageToken?.() ?? null;
  const type   = activity.target?.affects?.type;
  if (!scene) return [];
  if (type === "self") return caster ? [caster] : [];

  const fromSelf = activity.range?.units === "self";
  return scene.tokens.filter(token => {
    if (!token.actor || !regions.some(region => token.testInsideRegion(region))) return false;
    if (caster && token.id === caster.id && fromSelf) return false;
    if (token.actor.statuses?.has("dead")) return false;
    if (token.hidden && !game.user.isGM) return false;
    if (!caster) return true;
    if (type === "enemy") return token.disposition !== caster.disposition;
    if (type === "ally" || type === "willing") return token.disposition === caster.disposition;
    return true;
  });
}

/**
 * For areas where the caster chooses who's affected (target.affects.choice, e.g.
 * Spirit Guardians): a checkbox list of the creatures in the area, all checked.
 * Resolves with the chosen tokens, or null if the dialog is closed.
 */
async function chooseAffected(activity, tokens) {
  const DialogV2 = foundry.applications.api?.DialogV2;
  if (!DialogV2 || !tokens.length) return tokens;
  const rows = tokens.map(t => `
    <label style="display:flex;align-items:center;gap:6px;margin:2px 0">
      <input type="checkbox" name="lda-affected" value="${t.id}" checked> ${escapeHTML(t.name)}
    </label>`).join("");
  const ids = await DialogV2.prompt({
    window:  { title: `${activity.item?.name ?? activity.name}: Affected Creatures` },
    content: `<p>Choose which creatures in the area are affected.</p>${rows}`,
    ok: {
      label: "Confirm",
      callback: (_event, button) => [...button.form.querySelectorAll('input[name="lda-affected"]:checked')].map(i => i.value)
    },
    rejectClose: false
  });
  return Array.isArray(ids) ? tokens.filter(t => ids.includes(t.id)) : null;
}

/**
 * The targets of a save activity's use. When it placed an area (dnd5e places
 * it before postUseActivity fires, in results.templates), that wins: the
 * creatures inside it, set as the caster's targets so dnd5e's cards and damage
 * tray agree. Otherwise, the caster's current targets.
 */
async function resolveSaveTargets(activity, results) {
  const regions = (results?.templates ?? []).filter(r => r?.documentName === "Region");
  let tokens;
  if (regions.length) {
    tokens = tokensInActivityArea(activity, regions);
    if (activity.target?.affects?.choice) tokens = await chooseAffected(activity, tokens);
    if (!tokens) return [];
    if (canvas.scene === regions[0].parent) canvas.tokens?.setTargets(tokens.map(t => t.id), { mode: "replace" });
    debug(`save automation: ${tokens.length} creature(s) in the area: ${tokens.map(t => t.name).join(", ")}`);
  } else {
    tokens = [...game.user.targets].map(t => t.document);
  }
  return tokens.filter(t => t?.actor).map(t => ({ actor: t.actor.uuid, token: t.uuid, name: t.name }));
}

/** dnd5e.postUseActivity — automate a save activity's saves, and damage in full mode. */
async function onActivityUsed(activity, usageConfig, results) {
  try {
    if (activity?.type !== "save") return;
    const mode  = getSaveAutomation();
    const usage = results?.message;
    if (mode === "off" || !usage) return;

    const ability = activity.save?.ability?.first?.() ?? [...(activity.save?.ability ?? [])][0];
    const dc      = Number(activity.save?.dc?.value);
    if (!ability || !Number.isFinite(dc)) return;

    const targets = await resolveSaveTargets(activity, results);
    if (!targets.length) {
      ui.notifications?.info(`Luck Dice Automation: no targets for ${activity.item?.name ?? activity.name} — no saves requested.`);
      return;
    }

    // Group targets by who rolls them: an active player owner, else the GM (null).
    const groups = new Map();
    for (const target of targets) {
      const key = activePlayerOwner((await resolveTarget(target)).actor)?.id ?? null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(target);
    }

    const base = {
      activityUuid: activity.uuid,
      activityName: activity.item?.name ?? activity.name,
      casterName:   activity.actor?.name,
      usageId:      usage.id,
      ability, dc
    };
    const requests = [];
    for (const [rollerId, group] of groups) {
      if (rollerId === null) {
        if (!game.user.isGM && !getPrimaryGM()) {
          ui.notifications?.warn(`Luck Dice Automation: no GM is connected to roll saves for ${group.map(t => t.name).join(", ")}.`);
          continue;
        }
        requests.push(requestSaves(null, { ...base, targets: group, prompt: mode === "request" }));
      } else if (mode !== "npc") {
        for (const target of group) requests.push(requestSaves(rollerId, { ...base, targets: [target] }));
      }
    }

    if (mode !== "full") {
      // Nothing waits on the results; just surface failures.
      requests.forEach(r => r.catch(err => console.error(`[${MODULE_ID}] save automation:`, err)));
      return;
    }
    const outcome = new Map((await Promise.all(requests)).flat().map(r => [r.token, r.result]));
    await applySaveDamage(activity, targets, outcome);
  } catch (err) {
    console.error(`[${MODULE_ID}] save automation error:`, err);
  }
}

/**
 * Full mode: roll the activity's damage once (with the caster's Luck Dice damage
 * prompt), then apply it per target — full on a failed save; on a success, per
 * the activity's on-save rule (½ by default, or none / full). Targets without a
 * save result (dismissed, timed out) are left for the damage tray.
 */
async function applySaveDamage(activity, targets, outcome) {
  if (!((activity.damage?.parts?.length ?? 0) > 0)) return; // a save with no damage (e.g. Hold Person)

  const rolled  = targets.filter(t => outcome.get(t.token));
  const missing = targets.filter(t => !outcome.get(t.token));
  if (missing.length) {
    ui.notifications?.warn(`Luck Dice Automation: no save from ${missing.map(t => t.name).join(", ")} — apply their damage from the damage card's tray.`);
  }
  if (!rolled.length) return;

  const rolls = await activity.rollDamage({}, { configure: false });
  const damageMessage = rolls?.[0]?.parent;
  if (!damageMessage) return;
  await pendingLuckDamage.get(damageMessage.id);

  const onSave = activity.damage?.onSave ?? "half";
  const savedMultiplier = { none: 0, half: 0.5, full: 1 }[onSave] ?? 0.5;
  await requestApplyDamage(damageMessage, rolled.map(t => {
    const saved = !!outcome.get(t.token).passed;
    return { ...t, saved, multiplier: saved ? savedMultiplier : 1 };
  }));
}

// ── Saves, checks and concentration ──────────────────────────────────────────

// Post-roll hooks as dnd5e 6 fires them: saves and ability checks only have the
// plain name (Actor5e#rollD20Test fires no V2 variant); skills, tools and
// concentration fire both, so their V2 names are used.
const D20_TESTS = {
  "dnd5e.rollSavingThrow":     { title: "Failed Saving Throw",       rollType: "saving throw",       natOneSave: true },
  "dnd5e.rollConcentrationV2": { title: "Failed Concentration Save", rollType: "concentration save", natOneSave: true },
  "dnd5e.rollAbilityCheck":    { title: "Failed Ability Check",      rollType: "ability check" },
  "dnd5e.rollSkillV2":         { title: "Failed Skill Check",        rollType: "skill check" },
  "dnd5e.rollToolCheckV2":     { title: "Failed Tool Check",         rollType: "tool check" },
};

/**
 * A failed save, check or concentration roll against a known DC. Uses the same
 * prompts as the roll-request window and Midi saves; their reporter receives
 * each step and rewrites the card's roll, so dnd5e redraws success / failure.
 * Rolls without a DC are skipped — nothing says they failed.
 */
async function onD20TestRolled(rolls, data, test) {
  try {
    const roll    = rolls?.[0];
    const message = roll?.parent;
    const actor   = data?.subject;
    if (!message || !canUseLuck(actor)) return;
    if (requestRollActors.has(actor.id)) return; // the roll-request window runs its own prompt

    const dc = Number(roll.options?.target);
    if (!Number.isFinite(dc) || dc <= 0) return;
    const total = Number(roll.total ?? 0);
    if (total >= dc) return;

    debug(`native ${test.rollType}: ${actor.name} rolled ${total} vs DC ${dc}`);

    const reporter = cardReporter(message, roll);

    // dnd5e's own rule: the roller and the GM always see a DC; others per its setting.
    const showDC = message.shouldDisplayChallenge ?? true;
    const result = (test.natOneSave && getKeptD20Result(roll) === 1)
      ? await LDA.promptNatOneSave(actor, total, dc, roll, null, "", showDC, reporter)
      : await LDA.promptLuckOnCheckFail(actor, total, dc, null, "", roll, test.title, test.rollType, showDC, reporter);

    await finishCardHistory(message, result?.passed && result.finalTotal >= dc ? "passed" : "failed");
    await refreshOriginSummary(message);
  } catch (err) {
    console.error(`[${MODULE_ID}] native ${test.rollType} error:`, err);
  }
}

/**
 * A save linked to a usage card is summarized inside that card (dnd5e's
 * "summarize chat"), and the usage card doesn't re-render when the save card
 * changes — so after Luck Dice change the roll, its summary would still show the
 * original failure. Touch the usage card so it re-renders for everyone.
 */
async function refreshOriginSummary(message) {
  if (!message.getFlag(MODULE_ID, HISTORY_FLAG)?.entries?.length) return;
  const origin = message.getOriginatingMessage?.();
  if (!origin || origin === message || !origin.canUserModify?.(game.user, "update")) return;
  await origin.setFlag(MODULE_ID, "summaryRefresh", Date.now());
}

// ── Luck Dice history on dnd5e's cards ────────────────────────────────────────

/**
 * Insert the history as its own row after the card's last roll row. dnd5e 6
 * puts each roll in a `section.icon-row` (icon + roll button); the history goes
 * after that whole row — inside it, it would be squeezed into the roll column.
 * Idempotent — safe to run from more than one render hook. Hidden where the
 * roll itself is: blind / private rolls, and attack results when dnd5e's attack
 * roll visibility hides them.
 */
function injectNativeHistory(message, html) {
  if (!(html instanceof HTMLElement) || html.querySelector(".midi-results")) return;
  html.querySelectorAll(".lda-luck-history, .lda-applied-damage").forEach(el => el.remove());
  if (!message.isContentVisible) return;

  const blocks  = [];
  const history = message.getFlag?.(MODULE_ID, HISTORY_FLAG);
  if (history?.entries?.length && (game.user.isGM || message.system?.displayResult !== false)) {
    blocks.push(renderLuckSection(history));
  }
  const applied = message.getFlag?.(MODULE_ID, APPLIED_FLAG);
  if (applied?.length) {
    // The damage is already applied, per target and save. dnd5e's tray would
    // show everyone at full damage (it doesn't know the saves) and could apply
    // it a second time, so the "Applied" row replaces it.
    html.querySelectorAll("damage-application").forEach(el => el.remove());
    if (canSeeDamageApplication()) blocks.push(renderAppliedSection(applied));
  }
  if (!blocks.length) return;

  const rollRow = [...html.querySelectorAll("section.icon-row")].filter(row => row.querySelector(".dice-roll")).at(-1);
  if (rollRow) rollRow.after(...blocks);
  else (html.querySelector(".message-content") ?? html).append(...blocks);
}

/** Damage applied to targets is shown to whoever dnd5e lets use the damage tray. */
function canSeeDamageApplication() {
  if (game.user.isGM) return true;
  try { return !!game.settings.get("dnd5e", "allowPlayerDamageTray"); } catch { return false; }
}

/** "Applied: Hill Giant 14 · Goblin 7" as a card row (healing shown as +N). */
function renderAppliedSection(applied) {
  const parts = applied.map(a =>
    `<span style="white-space:nowrap">${escapeHTML(a.name)} <strong>${a.amount < 0 ? `+${-a.amount}` : a.amount}</strong>${a.saved ? ` <span style="opacity:0.7">(saved)</span>` : ""}</span>`);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <section class="icon-row lda-applied-damage" style="display:flex;align-items:flex-start;gap:6px;margin:2px 0">
      <i class="fa-fw fa-solid fa-heart-crack" aria-label="Damage applied" style="margin-top:2px;opacity:0.8"></i>
      <div style="flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px">
        <strong>Applied</strong>${parts.join("")}
      </div>
    </section>`.trim();
  return wrapper.firstElementChild;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  // Luck history and results on dnd5e roll cards. Registered in both modes: the
  // roll-request window uses dnd5e's cards with or without Midi-QoL. (Midi's own
  // usage cards are handled by attack.js.)
  Hooks.on("renderChatMessageHTML", injectNativeHistory);
  Hooks.on("dnd5e.renderChatMessage", injectNativeHistory);

  if (game.modules.get("midi-qol")?.active) {
    console.log(`[${MODULE_ID}] native.js: Midi-QoL is active — using Midi mode (attack.js)`);
    return;
  }
  console.log(`[${MODULE_ID}] native.js: Midi-QoL not active — using native dnd5e mode`);

  // Socket work between clients, via scorpious187s-lib's router. "gm" handlers run
  // on the primary active GM only, so nothing is rolled or applied twice; "any"
  // handlers run everywhere and act only on messages addressed to this user.
  const reply = (payload, results) => socket?.emit("saveResults", { to: payload.from, requestId: payload.requestId, results });
  socket = game.modules.get("scorpious187s-lib")?.api?.utils?.makeSocketRouter?.(MODULE_ID, {
    gm: {
      applyDamage: (payload) => applyCardDamage(payload)
        .catch(err => console.error(`[${MODULE_ID}] applyDamage error:`, err)),
      rollGMSaves: (payload) => rollGMSaves(payload)
        .then(results => reply(payload, results), err => { console.error(`[${MODULE_ID}] rollGMSaves error:`, err); reply(payload, noResults(payload.targets)); })
    },
    any: {
      rollPlayerSave: (payload) => {
        if (payload?.to !== game.user.id) return;
        rollPlayerSave(payload)
          .then(results => reply(payload, results), err => { console.error(`[${MODULE_ID}] rollPlayerSave error:`, err); reply(payload, noResults(payload.targets)); });
      },
      saveResults: (payload) => {
        if (payload?.to !== game.user.id) return;
        pendingSaveRequests.get(payload.requestId)?.(payload.results ?? []);
      }
    }
  }) ?? null;
  if (!socket) console.warn(`[${MODULE_ID}] native.js: scorpious187s-lib socket router unavailable — GM-side damage and remote saves are disabled`);

  Hooks.on("dnd5e.rollAttackV2", onAttackRolled);
  // Each card's Luck Dice prompt is tracked, so automation can wait for it.
  Hooks.on("dnd5e.rollDamageV2", (rolls, data) => {
    const message = rolls?.[0]?.parent;
    trackPending(pendingLuckDamage, message?.id, onDamageRolled(rolls, data));
    if (message && isPrivateGMCard(message) && getPrivateRollOutcome() === "share") {
      shareWithTargets(message, message.system?.targets).catch(err => console.error(`[${MODULE_ID}] share damage card:`, err));
    }
  });
  for (const [hook, test] of Object.entries(D20_TESTS)) {
    Hooks.on(hook, (rolls, data) =>
      trackPending(pendingLuckChecks, rolls?.[0]?.parent?.id, onD20TestRolled(rolls, data, test)));
  }
  // Save automation. Hooks.call: never return false here, that would cancel dnd5e's follow-ups.
  Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => { onActivityUsed(activity, usageConfig, results); });
});
})();
