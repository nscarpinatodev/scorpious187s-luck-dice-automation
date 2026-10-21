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
// Native mode is split across the modules in this folder; this one registers the hooks.
// Depends on: core.js, attack.js, skill-check.js, saving-throw.js (classic scripts, loaded first).

import { applyCardDamage } from "./apply.mjs";
import { onAttackRolled, onDamageRolled, skipAttackDialog, finalRollDialog } from "./attacks.mjs";
import { autoRolledEnabled, targetAutoRolledArea, applyAutoRolledCard, confirmAndRoll, skipAutoRolledDamageDialog } from "./autoroll.mjs";
import { injectNativeHistory } from "./cards.mjs";
import { D20_TESTS, onD20TestRolled, onConcentrationRolled, onSaveRolled } from "./checks.mjs";
import { applyMasteryGM } from "./mastery.mjs";
import { onDisengageUsed, onTurnEndDisengage, onTokenMovedOA } from "./opportunity.mjs";
import { recordAgathys, onActorUpdatedAgathys, retaliateGM } from "./retaliation.mjs";
import { onTurnStartDeathSave, onPreApplyDamage, onDamageAppliedDeath, onPostRollDeathSave } from "./deathsaves.mjs";
import { rememberAreas, clearAreaGM, tagAreaGM, onPreDeleteRegion, onConcentrationEnded } from "./areas.mjs";
import { onTurnStartSummary } from "./turn-summary.mjs";
import { recordWallSpell, buildWallsGM, onRegionDeletedWalls, onPreUseActivityWalls, onPreRollAttackWalls } from "./walls.mjs";
import { onConcentrationPrompt, deleteConcentrationPrompt } from "./concentration.mjs";
import { applyActivityEffects } from "./effects.mjs";
import { isPrivateGMCard, shareWithTargets } from "./outcome.mjs";
import { rayCount, fireRays } from "./projectiles.mjs";
import { claimRiderUse } from "./riders.mjs";
import { recordLingeringArea, tagLingeringArea, onTurnChange, onTokenMoved, onRegionChanged } from "./lingering.mjs";
import { onEffectCreated, onTurnEndRepeatSaves } from "./repeat-saves.mjs";
import { answerReaction, pendingReactions, onTurnStartReaction } from "./reactions.mjs";
import { onPreRollAttack, onPreRollDamage, onRenderAttackDialog, consumeAttackMarks, consumeAttackMarkGM } from "./advantage.mjs";
import { noResults, rollGMSaves, rollPlayerSave, onActivityUsed } from "./saves.mjs";
import { MODULE_ID, getPrivateRollOutcome, pendingLuckDamage, pendingAttacks, socket, pendingLuckChecks, pendingSaveRequests, trackPending, setSocket } from "./shared.mjs";
import { needsConfirmation, needsAttackConfirmation } from "./targeting.mjs";

// ── Hooks ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  // Luck history and results on dnd5e roll cards. Registered in both modes: the
  // roll-request window uses dnd5e's cards with or without Midi-QoL. (Midi's own
  // usage cards are handled by attack.js.)
  Hooks.on("renderChatMessageHTML", injectNativeHistory);
  Hooks.on("dnd5e.renderChatMessage", injectNativeHistory);

  if (game.modules.get("midi-qol")?.active) {
    console.log(`[${MODULE_ID}] native: Midi-QoL is active — using Midi mode (attack.js)`);
    return;
  }
  console.log(`[${MODULE_ID}] native: Midi-QoL not active — using native dnd5e mode`);

  // Socket work between clients, via scorpious187s-lib's router. "gm" handlers run
  // on the primary active GM only, so nothing is rolled or applied twice; "any"
  // handlers run everywhere and act only on messages addressed to this user.
  const reply = (payload, results) => socket?.emit("saveResults", { to: payload.from, requestId: payload.requestId, results });
  setSocket(game.modules.get("scorpious187s-lib")?.api?.utils?.makeSocketRouter?.(MODULE_ID, {
    gm: {
      applyDamage: (payload) => applyCardDamage(payload)
        .catch(err => console.error(`[${MODULE_ID}] applyDamage error:`, err)),
      applyEffects: (payload) => applyActivityEffects(payload)
        .catch(err => console.error(`[${MODULE_ID}] applyEffects error:`, err)),
      deleteConcentrationPrompt: (payload) => deleteConcentrationPrompt(payload)
        .catch(err => console.error(`[${MODULE_ID}] deleteConcentrationPrompt error:`, err)),
      tagLingeringArea: (payload) => tagLingeringArea(payload)
        .catch(err => console.error(`[${MODULE_ID}] tagLingeringArea error:`, err)),
      buildWalls: (payload) => buildWallsGM(payload)
        .catch(err => console.error(`[${MODULE_ID}] buildWalls error:`, err)),
      retaliate: (payload) => retaliateGM(payload)
        .catch(err => console.error(`[${MODULE_ID}] retaliate error:`, err)),
      tagArea: (payload) => tagAreaGM(payload)
        .catch(err => console.error(`[${MODULE_ID}] tagArea error:`, err)),
      clearArea: (payload) => clearAreaGM(payload)
        .catch(err => console.error(`[${MODULE_ID}] clearArea error:`, err)),
      applyMastery: (payload) => applyMasteryGM(payload)
        .catch(err => console.error(`[${MODULE_ID}] applyMastery error:`, err)),
      consumeAttackMark: (payload) => consumeAttackMarkGM(payload)
        .catch(err => console.error(`[${MODULE_ID}] consumeAttackMark error:`, err)),
      offerReactionGM: (payload) => answerReaction(payload)
        .then(result => socket?.emit("reactionResult", { to: payload.from, requestId: payload.requestId, result }),
          err => { console.error(`[${MODULE_ID}] offerReaction error:`, err); socket?.emit("reactionResult", { to: payload.from, requestId: payload.requestId, result: null }); }),
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
      },
      offerReaction: (payload) => {
        if (payload?.to !== game.user.id) return;
        answerReaction(payload)
          .then(result => socket?.emit("reactionResult", { to: payload.from, requestId: payload.requestId, result }),
            err => { console.error(`[${MODULE_ID}] offerReaction error:`, err); socket?.emit("reactionResult", { to: payload.from, requestId: payload.requestId, result: null }); });
      },
      reactionResult: (payload) => {
        if (payload?.to !== game.user.id) return;
        pendingReactions.get(payload.requestId)?.(payload.result ?? null);
      }
    }
  }) ?? null);
  if (!socket) console.warn(`[${MODULE_ID}] native: scorpious187s-lib socket router unavailable — GM-side damage and remote saves are disabled`);

  // Solid barriers (Wall of Force…): no targeting through them. Each returns false only to cancel.
  Hooks.on("dnd5e.preUseActivity", onPreUseActivityWalls);
  Hooks.on("dnd5e.preRollAttackV2", onPreRollAttackWalls);
  // Advantage / disadvantage reasons first: returns false only to cancel an attack out of range.
  Hooks.on("dnd5e.preRollAttackV2", onPreRollAttack);
  Hooks.on("dnd5e.preRollAttackV2", skipAttackDialog); // never returns false: that would cancel the roll
  Hooks.on("renderAttackRollConfigurationDialog", onRenderAttackDialog);
  // The last word on whether a roll shows its window (after every type-specific preRoll hook). Never cancels.
  Hooks.on("dnd5e.preRollV2", finalRollDialog);
  Hooks.on("dnd5e.preRollDamageV2", onPreRollDamage); // automatic critical hits; never cancels
  Hooks.on("dnd5e.preRollDamageV2", skipAutoRolledDamageDialog); // never cancels
  Hooks.on("dnd5e.rollAttackV2", (rolls) =>
    consumeAttackMarks(rolls?.[0]?.parent).catch(err => console.error(`[${MODULE_ID}] attack marks:`, err)));
  // Tracked like the others, so rays can wait for each attack's Luck Dice and damage.
  Hooks.on("dnd5e.rollAttackV2", (rolls, data) => trackPending(pendingAttacks, rolls?.[0]?.parent?.id, onAttackRolled(rolls, data)));
  // Each card's Luck Dice prompt is tracked, so automation can wait for it.
  Hooks.on("dnd5e.rollDamageV2", (rolls, data) => {
    const message = rolls?.[0]?.parent;
    trackPending(pendingLuckDamage, message?.id, onDamageRolled(rolls, data));
    if (data?.subject?.type === "heal" || data?.subject?.type === "damage") {
      applyAutoRolledCard(message, data.subject).catch(err => console.error(`[${MODULE_ID}] ${data.subject.type} automation:`, err));
    }
    if (message && isPrivateGMCard(message) && getPrivateRollOutcome() === "share") {
      shareWithTargets(message, message.system?.targets).catch(err => console.error(`[${MODULE_ID}] share damage card:`, err));
    }
  });
  // Lingering areas: turns, movement, and areas moving (watched by the primary GM).
  // Turn changes: lingering areas, then repeat saves for the creature whose turn ended.
  Hooks.on("combatTurnChange", (combat, prior, current) => onTurnStartReaction(combat, current));
  // The turn that ended: Disengaged ends. The turn that starts: its summary, then a dying character's death save.
  Hooks.on("combatTurnChange", (combat, prior, current) => {
    onTurnEndDisengage(combat, prior).catch(err => console.error(`[${MODULE_ID}] disengage:`, err));
    onTurnStartSummary(combat, current)
      .catch(err => console.error(`[${MODULE_ID}] turn summary:`, err))
      .then(() => onTurnStartDeathSave(combat, current))
      .catch(err => console.error(`[${MODULE_ID}] death save:`, err));
  });
  Hooks.on("updateActor", (actor, changes) =>
    onActorUpdatedAgathys(actor, changes).catch(err => console.error(`[${MODULE_ID}] armor of agathys:`, err)));
  Hooks.on("dnd5e.preApplyDamage", onPreApplyDamage); // synchronous; never cancels
  Hooks.on("dnd5e.applyDamage", (actor) => onDamageAppliedDeath(actor).catch(err => console.error(`[${MODULE_ID}] death:`, err)));
  Hooks.on("dnd5e.postRollDeathSave", onPostRollDeathSave);
  Hooks.on("preDeleteRegion", onPreDeleteRegion); // returns false only to keep a lingering area or a wall spell's
  Hooks.on("deleteRegion", (region) => onRegionDeletedWalls(region).catch(err => console.error(`[${MODULE_ID}] wall spells:`, err)));
  // dnd5e doesn't remove a concentration spell's area when concentration ends; the module does.
  Hooks.on("deleteActiveEffect", (effect) => onConcentrationEnded(effect).catch(err => console.error(`[${MODULE_ID}] concentration areas:`, err)));
  Hooks.on("combatTurnChange", (combat, prior, current) =>
    onTurnChange(combat, prior, current)
      .catch(err => console.error(`[${MODULE_ID}] lingering turn:`, err))
      .then(() => onTurnEndRepeatSaves(combat, prior))
      .catch(err => console.error(`[${MODULE_ID}] repeat saves:`, err)));
  Hooks.on("createActiveEffect", (effect) =>
    onEffectCreated(effect).catch(err => console.error(`[${MODULE_ID}] repeat saves:`, err)));
  Hooks.on("moveToken", (tokenDoc, movement, operation) => {
    onTokenMoved(tokenDoc, movement).catch(err => console.error(`[${MODULE_ID}] lingering move:`, err));
    onTokenMovedOA(tokenDoc, movement, operation).catch(err => console.error(`[${MODULE_ID}] opportunity attacks:`, err));
  });
  Hooks.on("updateRegion", (region, changes) =>
    onRegionChanged(region, changes).catch(err => console.error(`[${MODULE_ID}] lingering region:`, err)));
  // dnd5e's concentration prompt when a concentrating creature takes damage.
  Hooks.on("createChatMessage", (message) =>
    onConcentrationPrompt(message).catch(err => console.error(`[${MODULE_ID}] concentration auto-roll:`, err)));
  for (const [hook, test] of Object.entries(D20_TESTS)) {
    const handler = hook === "dnd5e.rollConcentrationV2" ? onConcentrationRolled
      : hook === "dnd5e.rollSavingThrow" ? onSaveRolled : onD20TestRolled;
    Hooks.on(hook, (rolls, data) =>
      trackPending(pendingLuckChecks, rolls?.[0]?.parent?.id, handler(rolls, data, test)));
  }
  // Save automation. Hooks.call: never return false here, that would cancel dnd5e's follow-ups.
  // Synchronous up to the point dnd5e reads usageConfig.subsequentActions, right after.
  Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
    if (claimRiderUse(activity, usageConfig)) return; // an on-hit rider spending its slot / uses: its dice go on the hit
    recordLingeringArea(activity, usageConfig, results).catch(err => console.error(`[${MODULE_ID}] lingering area:`, err));
    rememberAreas(activity, results);
    recordWallSpell(activity, usageConfig, results).catch(err => console.error(`[${MODULE_ID}] wall spells:`, err));
    onDisengageUsed(activity).catch(err => console.error(`[${MODULE_ID}] disengage:`, err));
    recordAgathys(activity, usageConfig).catch(err => console.error(`[${MODULE_ID}] armor of agathys:`, err));
    const type     = activity?.type;
    const followUp = usageConfig?.subsequentActions !== false;
    if (type === "heal" || type === "damage") {
      if (followUp && autoRolledEnabled(activity) && needsConfirmation(activity, results)) {
        usageConfig.subsequentActions = false; // rolled once the targets are confirmed
        confirmAndRoll(activity, usageConfig, results).catch(err => console.error(`[${MODULE_ID}] target confirmation:`, err));
      } else targetAutoRolledArea(activity, results); // dnd5e rolls next
    } else if (type === "attack") {
      const rays = followUp ? rayCount(activity, results?.message) : null;
      if (rays) {
        usageConfig.subsequentActions = false; // one attack per ray instead
        fireRays(activity, usageConfig, results, rays).catch(err => console.error(`[${MODULE_ID}] rays:`, err));
      } else if (followUp && needsAttackConfirmation(activity, results)) {
        usageConfig.subsequentActions = false; // rolled once the targets are confirmed
        confirmAndRoll(activity, usageConfig, results).catch(err => console.error(`[${MODULE_ID}] target confirmation:`, err));
      }
    } else onActivityUsed(activity, usageConfig, results);
  });
});
