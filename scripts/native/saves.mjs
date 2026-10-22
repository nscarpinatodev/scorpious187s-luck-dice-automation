// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Save automation: requesting and rolling saves for a save activity's targets, then its damage.

import { requestApplyDamage } from "./apply.mjs";
import { applySaveEffects } from "./effects.mjs";
import { clearAreasForUse } from "./areas.mjs";
import { evasionApplies } from "./save-rules.mjs";
import { MODULE_ID, debug, promptChoice, getSaveAutomation, escapeHTML, pendingLuckDamage, socket, pendingLuckChecks, pendingSaveRequests, getPrimaryGM, activePlayerOwner, abilityLabel, resolveTarget, NO_DIALOG } from "./shared.mjs";
import { tokensInActivityArea, chooseAffected, regionsOf, needsConfirmation, confirmTargets } from "./targeting.mjs";

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

export const SAVE_RESPONSE_TIMEOUT = 180_000;

/** A batch's results when it couldn't be rolled. */
export const noResults = (targets) => targets.map(t => ({ token: t.token, result: null }));

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
export async function rollAutomatedSave(target, { activityUuid, activityName, usageId, ability, dc, fastForward, link }) {
  const { tokenDoc, actor } = await resolveTarget(target);
  if (!actor?.rollSavingThrow) return null;
  const activity = activityUuid ? await fromUuid(activityUuid) : null;

  const rollData = { ability, target: dc, ...(fastForward ? NO_DIALOG : {}) };
  if (activity?.save?.bonus) {
    const bonus     = CONFIG.Dice.BasicRoll.replaceFormulaData(activity.save.bonus, activity.getRollData(), { missing: 0 });
    const bonusData = CONFIG.Dice.BasicRoll.constructParts({ activityBonus: bonus });
    if (bonusData.parts.length) rollData.rolls = [bonusData];
  }
  const speaker = ChatMessage.getSpeaker({ actor, scene: tokenDoc?.parent ?? canvas.scene, token: tokenDoc });
  // Name what the save is for: "Fireball — Dexterity Saving Throw", "Weapon Mastery: Topple (Maul) — …".
  const flavor = activityName ? `${activityName} — ${abilityLabel(ability)} Saving Throw` : undefined;
  const rolls = await actor.rollSavingThrow(rollData, fastForward ? { configure: false } : {}, {
    data: { speaker, ...(flavor ? { flavor } : {}), system: { ...(activity?.messageSources ?? {}), ...(link ? { origin: usageId } : {}) } }
  });
  const message = rolls?.[0]?.parent;
  if (!message) return null;

  await pendingLuckChecks.get(message.id);
  const final = message.rolls[0];
  // A save turned into a success by Legendary Resistance counts as passed.
  return { passed: !!final?.isSuccess || !!message.system?.resisted, total: Number(final?.total ?? 0) };
}

/**
 * GM side: roll the saves for the targets the GM handles (NPCs, offline
 * players). With `prompt` (request mode), asks once for the whole batch first.
 */
export async function rollGMSaves(request) {
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
export async function rollPlayerSave(request) {
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
export function requestSaves(rollerId, request) {
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
 * The targets of a save activity's use. When it placed an area (dnd5e places
 * it before postUseActivity fires, in results.templates), that wins: the
 * creatures inside it, set as the caster's targets so dnd5e's cards and damage
 * tray agree. Otherwise, the caster's current targets.
 */
export async function resolveSaveTargets(activity, results) {
  const regions = regionsOf(results);
  const confirm = needsConfirmation(activity, results);
  let tokens;
  if (regions.length) {
    tokens = tokensInActivityArea(activity, regions);
    // The confirmation list covers choosing who's affected.
    if (!confirm && activity.target?.affects?.choice) tokens = await chooseAffected(activity, tokens);
    if (!tokens) return [];
    if (canvas.scene === regions[0].parent) canvas.tokens?.setTargets(tokens.map(t => t.id), { mode: "replace" });
    debug(`save automation: ${tokens.length} creature(s) in the area: ${tokens.map(t => t.name).join(", ")}`);
  } else {
    tokens = [...game.user.targets].map(t => t.document);
  }
  if (confirm) tokens = await confirmTargets(activity, tokens);
  if (!tokens) return null; // cancelled
  return tokens.filter(t => t?.actor).map(t => ({ actor: t.actor.uuid, token: t.uuid, name: t.name }));
}

/** dnd5e.postUseActivity — automate a save activity's saves, and damage in full mode. */
export async function onActivityUsed(activity, usageConfig, results) {
  try {
    if (activity?.type !== "save") return;
    const mode  = getSaveAutomation();
    const usage = results?.message;
    if (mode === "off" || !usage) return;

    if (!saveOf(activity)) return;

    const targets = await resolveSaveTargets(activity, results);
    if (!targets) return;
    if (!targets.length) {
      ui.notifications?.info(`Luck Dice Automation: no targets for ${activity.item?.name ?? activity.name} — no saves requested.`);
      return;
    }
    await automateSaves(activity, targets, usage, mode);
  } catch (err) {
    console.error(`[${MODULE_ID}] save automation error:`, err);
  }
}

/** A save activity's ability and DC, or null without both. */
export function saveOf(activity) {
  const ability = activity?.save?.ability?.first?.() ?? [...(activity?.save?.ability ?? [])][0];
  const dc      = Number(activity?.save?.dc?.value);
  return ability && Number.isFinite(dc) ? { ability, dc } : null;
}

/**
 * The saves for a save activity's targets, per the save automation mode: request
 * them (players prompted, NPCs by the GM), or in full mode wait for them, then
 * roll and apply the damage and effects. Also used by lingering areas.
 * `usage` is the use's card (links the saves; its effects are applied), or null.
 */
export async function automateSaves(activity, targets, usage, mode = getSaveAutomation()) {
  const { ability, dc } = saveOf(activity) ?? {};
  if (!ability || mode === "off" || !targets.length) return;

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
    usageId:      usage?.id ?? null,
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
  await applySaveDamage(activity, targets, outcome, usage);
  if (usage) await applySaveEffects(activity, usage, targets, outcome);
  if (usage) await clearAreasForUse(usage.id);
}

/**
 * Full mode: roll the activity's damage once (with the caster's Luck Dice damage
 * prompt), then apply it per target — full on a failed save; on a success, per
 * the activity's on-save rule (½ by default, or none / full). Targets without a
 * save result (dismissed, timed out) are left for the damage tray.
 */
export async function applySaveDamage(activity, targets, outcome, usage = null) {
  if (!((activity.damage?.parts?.length ?? 0) > 0)) return; // a save with no damage (e.g. Hold Person)

  const rolled  = targets.filter(t => outcome.get(t.token));
  const missing = targets.filter(t => !outcome.get(t.token));
  if (missing.length) {
    ui.notifications?.warn(`Luck Dice Automation: no save from ${missing.map(t => t.name).join(", ")} — apply their damage from the damage card's tray.`);
  }
  if (!rolled.length) return;

  const rolls = await activity.rollDamage({ ...NO_DIALOG }, { configure: false });
  const damageMessage = rolls?.[0]?.parent;
  if (!damageMessage) return;
  await pendingLuckDamage.get(damageMessage.id);

  const onSave = activity.damage?.onSave ?? "half";
  const savedMultiplier = { none: 0, half: 0.5, full: 1 }[onSave] ?? 0.5;
  const ability = saveOf(activity)?.ability;
  const list = [];
  for (const t of rolled) {
    const saved = !!outcome.get(t.token).passed;
    // Evasion (the "saveRules" setting): none on a success, half on a failure.
    if (evasionApplies((await resolveTarget(t)).actor, ability, onSave)) {
      list.push({ ...t, saved, multiplier: saved ? 0 : 0.5, notes: ["Evasion"] });
    } else list.push({ ...t, saved, multiplier: saved ? savedMultiplier : 1 });
  }
  await requestApplyDamage(damageMessage, list, { outcomeKey: usage?.id });
}
