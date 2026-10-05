// ── Scorpious187's Luck Dice Automation — Core ────────────────────────────────
// Shared constants, dice helpers, dialog utilities, and settings registration.
// Loaded first; attack.js and skill-check.js depend on everything defined here.

window.LDA = (() => {

const MODULE_ID = "scorpious187s-luck-dice-automation";
const LUCK_DICE_ITEM_NAME  = "Luck Dice";
const IMPACT_DICE_ITEM_NAME = "Impact Dice";

// Per-workflow transient state. Keyed by workflow UUID/ID so concurrent workflows
// don't interfere. Cleared at RollComplete.
const workflowState = new Map();

// Pending Midi save result Promises: actorId → {resolve, timeoutId}
// The preCheckSaves hook (GM client) puts entries here; the midiSaveResult socket
// message (from the player's client) resolves them.
const pendingMidiSaveResults = new Map();

// Math.clamp is a Foundry global extension, not native JS. Define a local fallback
// so the module works regardless of browser/Foundry execution order.
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Read the debug flag from settings at call time so it can be toggled live.
function debug(...args) {
  let on = false;
  try { on = game.settings.get(MODULE_ID, "debug"); } catch { /* settings not ready yet */ }
  if (on) console.log(`[${MODULE_ID}]`, ...args);
}

// Top-level load marker — always printed, even before the ready hook fires.
// If this line is missing from the console the script file itself isn't being executed.
console.log(`[${MODULE_ID}] core.js parsed — user=${game?.user?.name ?? "unknown"} isGM=${game?.user?.isGM ?? "?"} build=${Date.now()}`);

// ── Workflow state helpers ────────────────────────────────────────────────────

function getWorkflowKey(workflow) {
  return workflow?.uuid ?? workflow?.id ?? `${workflow?.actor?.id}-${workflow?.item?.id}-${Date.now()}`;
}

function getState(workflow) {
  const key = getWorkflowKey(workflow);
  if (!workflowState.has(key)) {
    workflowState.set(key, { luckSpentOnAttack: 0, damagePrompted: false, attackPrompted: false });
  }
  return workflowState.get(key);
}

// ── Dice resource helpers ─────────────────────────────────────────────────────
// Generalized so both Luck Dice and Impact Dice share the same read/write logic.

function getDiceItem(actor, itemName) {
  return actor?.items?.find((i) => i.name === itemName);
}

function getDiceUses(actor, itemName) {
  const item = getDiceItem(actor, itemName);
  if (!item) return 0;
  // dnd5e 5.x tracks uses as { spent, max } — value is computed, not stored.
  const max   = Number(item.system?.uses?.max   ?? 0);
  const spent = Number(item.system?.uses?.spent ?? 0);
  const available = Math.max(0, max - spent);
  debug(`getDiceUses(${itemName}): max=${max} spent=${spent} available=${available}`);
  return available;
}

async function updateDiceUses(actor, itemName, delta) {
  const item = getDiceItem(actor, itemName);
  if (!item) {
    console.warn(`[${MODULE_ID}] updateDiceUses: "${itemName}" not found on actor "${actor?.name}"`);
    return false;
  }
  const max              = Number(item.system?.uses?.max   ?? 0);
  const currentSpent     = Number(item.system?.uses?.spent ?? 0);
  const currentAvailable = Math.max(0, max - currentSpent);
  const newAvailable     = clamp(currentAvailable + delta, 0, max);
  if (newAvailable === currentAvailable) {
    debug(`updateDiceUses(${itemName}, ${delta}): no change (available=${currentAvailable})`);
    return false;
  }
  const newSpent = max - newAvailable;
  await item.update({ "system.uses.spent": newSpent });
  console.log(`[${MODULE_ID}] ${itemName}: ${currentAvailable} → ${newAvailable} (spent ${currentSpent} → ${newSpent})`);
  return true;
}

// Luck Dice convenience wrappers used by code that doesn't need Impact Dice.
function getLuckItem(actor)               { return getDiceItem(actor, LUCK_DICE_ITEM_NAME); }
function getLuckUses(actor)               { return getDiceUses(actor, LUCK_DICE_ITEM_NAME); }
async function updateLuckUses(actor, delta) { return updateDiceUses(actor, LUCK_DICE_ITEM_NAME, delta); }

/**
 * Returns true only if the actor is a player character (dnd5e type "character")
 * AND has at least one of the Luck Dice / Impact Dice items on their sheet.
 */
function actorHasLuckDice(actor) {
  if (!actor) return false;
  if (actor.type !== "character") return false;
  return !!(getDiceItem(actor, LUCK_DICE_ITEM_NAME) || getDiceItem(actor, IMPACT_DICE_ITEM_NAME));
}

/**
 * Returns true only on the one client that should handle luck-dice prompts.
 * Midi fires hooks on EVERY connected client simultaneously; if two clients
 * both show dialogs and modify the workflow they race and damage never fires.
 *
 * Priority:
 *  1. workflow.userId === game.user.id  → this IS the initiating client.
 *  2. workflow.userId is a different active user → defer to them.
 *  3. workflow.userId user is offline (or no userId) → fallback:
 *       a. Active non-GM owner of the actor → they handle it.
 *       b. Otherwise GM handles it.
 *
 * Mirror setting: when enabled the GM also receives every prompt in addition to
 * the initiating user. Both clients see the dialog simultaneously.
 */
function isWorkflowResponder(workflow) {
  let mirrorToGM = false;
  try { mirrorToGM = game.settings.get(MODULE_ID, "mirrorToGM"); } catch { /* pre-init */ }

  const wfUserId   = workflow?.userId;
  const isInitiator = !!(wfUserId && wfUserId === game.user.id);

  // Mirror mode: initiating user AND GM both receive the prompt.
  if (mirrorToGM) return isInitiator || game.user.isGM;

  // Normal mode: only the initiating user handles the workflow.
  if (isInitiator) return true;

  // Another active user initiated it — defer to them.
  if (wfUserId) {
    const wfUser = game.users.get(wfUserId);
    if (wfUser?.active) return false;
    // Initiating user is offline → fall through to fallback.
  }

  // Fallback for missing/offline workflow.userId: active non-GM owner, then GM.
  const actor = workflow?.actor;
  if (!actor) return game.user.isGM;
  const activeOwner = game.users.find(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"));
  if (activeOwner) return activeOwner.id === game.user.id;
  return game.user.isGM;
}

// ── Dialog helpers ────────────────────────────────────────────────────────────

/** Show a multi-button choice dialog. Falls back to legacy Dialog if DialogV2 is absent. */
async function promptChoice(title, content, buttons) {
  debug(`promptChoice: "${title}" — options: ${buttons.map((b) => b.action).join(", ")}`);
  const dialogButtons = buttons.map((b) => ({ action: b.action, label: b.label, callback: () => b.action }));

  if (foundry?.applications?.api?.DialogV2) {
    return foundry.applications.api.DialogV2.wait({ window: { title }, content, buttons: dialogButtons });
  }
  return Dialog.wait({
    title, content,
    buttons: Object.fromEntries(buttons.map((b) => [b.action, { label: b.label, callback: () => b.action }])),
    default: buttons[0]?.action,
    close: () => "decline"
  });
}

/**
 * Show a slider input dialog. Returns the selected number, or null if cancelled.
 * Falls back to legacy Dialog if DialogV2 is absent.
 */
async function promptSlider(title, content, inputId, min, max, defaultVal = min) {
  debug(`promptSlider: "${title}" min=${min} max=${max} default=${defaultVal}`);

  const sliderHtml = `${content}
    <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
      <input id="${inputId}" type="range" min="${min}" max="${max}" value="${defaultVal}" style="flex:1">
      <output id="${inputId}_out" style="min-width:2em;text-align:right;font-weight:bold">${defaultVal}</output>
      <span>d6</span>
    </div>`;

  function wireSlider(html) {
    const slider = html?.querySelector?.(`#${inputId}`) ?? document.getElementById(inputId);
    const output = html?.querySelector?.(`#${inputId}_out`) ?? document.getElementById(`${inputId}_out`);
    if (slider && output) {
      slider.addEventListener("input", () => { output.textContent = slider.value; });
      debug(`promptSlider: wired input listener for #${inputId}`);
    } else {
      debug(`promptSlider: could not find #${inputId} — html type=${html?.constructor?.name}`);
    }
  }

  if (foundry?.applications?.api?.DialogV2) {
    return foundry.applications.api.DialogV2.prompt({
      window: { title },
      content: sliderHtml,
      ok: {
        label: "Confirm",
        callback: (_event, button, html) => {
          const el  = html?.querySelector?.(`#${inputId}`) ?? button?.form?.elements?.[inputId];
          const val = Number(el?.value ?? defaultVal);
          debug(`promptSlider result: ${val}`);
          return val;
        }
      },
      render: function() { wireSlider(this.element); },
      rejectClose: false
    });
  }

  return new Promise((resolve) => {
    new Dialog({
      title,
      content: `<form>${sliderHtml}</form>`,
      buttons: {
        ok: {
          label: "Confirm",
          callback: (html) => {
            const val = Number(html.find(`#${inputId}`).val() ?? defaultVal);
            debug(`promptSlider result (legacy): ${val}`);
            resolve(val);
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "ok",
      close: () => resolve(null),
      render: (html) => wireSlider(html[0] ?? html)
    }).render(true);
  });
}

// ── Roll inspection helpers ───────────────────────────────────────────────────

/**
 * Build a minimal Roll-compatible object from serialised data.
 * Used when a real Roll is unavailable (e.g. socket messages for Midi saves).
 * formula should be a fully-evaluated string like "1d20 + 4", NOT a template.
 */
function buildFakeRoll(total, formula = "1d20", d20Result = null) {
  return {
    total,
    _total: total,
    formula,
    data: {},
    dice: d20Result !== null
      ? [{ results: [{ result: d20Result, active: true }] }]
      : []
  };
}

/**
 * Return the result of the kept d20 in a roll.
 * For advantage (2d20kh) or disadvantage (2d20kl), the discarded die has
 * active:false — we must find the active result, not blindly read results[0].
 */
function getKeptD20Result(roll) {
  const die = roll?.dice?.[0];
  if (!die) return undefined;
  const kept = die.results?.find(r => r.active !== false) ?? die.results?.[0];
  return kept?.result;
}

// ── Combined-pool helpers ─────────────────────────────────────────────────────

/**
 * Spend `count` dice across both pools: Luck Dice first, Impact Dice for any remainder.
 * Returns the number of dice actually spent.
 */
async function spendDiceFromPools(actor, count) {
  const luckAvail   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
  const impactAvail = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
  const luckToSpend   = Math.min(count, luckAvail);
  const impactToSpend = Math.min(count - luckToSpend, impactAvail);
  if (luckToSpend   > 0) await updateDiceUses(actor, LUCK_DICE_ITEM_NAME,   -luckToSpend);
  if (impactToSpend > 0) await updateDiceUses(actor, IMPACT_DICE_ITEM_NAME, -impactToSpend);
  return luckToSpend + impactToSpend;
}

/**
 * Build an unevaluated reroll of originalRoll. A reroll keeps advantage and
 * drops disadvantage; forceAdvantage gives advantage regardless (Inspiration
 * with the inspirationAdvantage setting).
 *
 * dnd5e 6 writes advantage as an `adv` / `dis` die modifier (1d20dis + 5), not
 * kh/kl, so a D20Roll is rebuilt through D20Roll itself: its constructor
 * re-applies the advantage mode, crit range, DC and Reliable Talent, so the
 * reroll keeps the original's crit/success styling and hit/miss evaluation.
 * A roll rebuilt from a formula (sent over the socket) falls back to editing
 * the formula, covering both notations.
 */
function buildReroll(originalRoll, { forceAdvantage = false } = {}) {
  const D20Roll = CONFIG.Dice.D20Roll;
  if (D20Roll && originalRoll instanceof D20Roll && originalRoll.validD20Roll) {
    const ADV  = D20Roll.ADV_MODE;
    const mode = forceAdvantage || originalRoll.options.advantageMode === ADV.ADVANTAGE ? ADV.ADVANTAGE : ADV.NORMAL;
    return new D20Roll(originalRoll.formula, originalRoll.data ?? {}, {
      ...foundry.utils.deepClone(originalRoll.options), advantageMode: mode, configured: false
    });
  }
  const formula = originalRoll.formula ?? "1d20";
  return new Roll(forceAdvantage
    ? formula.replace(/\b\d+d20(?:k[hl]\d*|adv\d?|dis)?/i, "2d20kh")
    : formula.replace(/\b\d+d20(?:kl\d*|dis)/gi, "1d20"),
    originalRoll.data ?? {});
}

/**
 * Evaluate a luck dice reroll of originalRoll, then show a Dice So Nice
 * animation visible to all players.
 * Dice spending is the caller's responsibility — call this AFTER spending.
 */
async function evaluateReroll(originalRoll) {
  const newRoll = await buildReroll(originalRoll).evaluate();
  if (game.dice3d) await game.dice3d.showForRoll(newRoll, game.user, true, null, false);
  return newRoll;
}

/**
 * Merge an evaluated bonus roll (luck d6s) into an evaluated base roll. The
 * result keeps the base roll's class and options — a D20Roll stays a D20Roll,
 * so dnd5e still judges it against the DC (isSuccess compares the full total)
 * and the target's AC.
 */
function combineRolls(baseRoll, bonusRoll) {
  try {
    const plus = new foundry.dice.terms.OperatorTerm({ operator: "+" });
    plus._evaluated = true;
    const combined = baseRoll.constructor.fromTerms(
      [...baseRoll.terms, plus, ...bonusRoll.terms],
      foundry.utils.deepClone(baseRoll.options)
    );
    debug(`combineRolls: ${baseRoll.total} + ${bonusRoll.total} = ${combined.total} (${combined.constructor.name})`);
    return combined;
  } catch (e) {
    debug(`combineRolls: fromTerms failed (${e.message}), patching _total`);
    baseRoll._total = (baseRoll._total ?? baseRoll.total) + bonusRoll.total;
    return baseRoll;
  }
}

/** HTML snippet showing available dice counts. */
function buildDiceAvailableHTML(actor) {
  const luck   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
  const impact = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
  const parts  = [];
  if (luck   > 0) parts.push(`${LUCK_DICE_ITEM_NAME}: <strong>${luck}</strong>`);
  if (impact > 0) parts.push(`${IMPACT_DICE_ITEM_NAME}: <strong>${impact}</strong>`);
  if (luck > 0 && impact > 0) parts.push(`Total: <strong>${luck + impact}</strong>`);
  return parts.length ? `<p>${parts.join(" &nbsp;·&nbsp; ")}</p>` : `<p>No dice available.</p>`;
}

// ── Whisper helpers ───────────────────────────────────────────────────────────

/** Whisper a Luck Die regain message to the GM(s) and the actor's owner(s). */
async function whisperLuckRegain(actor, reason) {
  const gmIds    = game.users.filter(u => u.isGM).map(u => u.id);
  const ownerIds = game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.id);
  const recipients = [...new Set([...gmIds, ...ownerIds])];
  await ChatMessage.create({
    content: `<p><strong>${actor.name}</strong> regained 1 Luck Die (${reason}).</p>`,
    whisper: recipients,
    speaker: { alias: "Scorpious187's Luck Dice Automation" }
  });
}

async function maybeRegainLuckDie(actor, state) {
  if (!actor || !state || state.luckSpentOnAttack > 0) return;
  console.log(`[${MODULE_ID}] maybeRegainLuckDie: restoring 1 Luck Die for "${actor.name}"`);
  await updateLuckUses(actor, 1);
  await whisperLuckRegain(actor, "failed save or check");
}

// ── Setting helpers ───────────────────────────────────────────────────────────

function isLuckDiceEnabled() {
  try { return game.settings.get(MODULE_ID, "enableLuckDice"); } catch { return true; }
}

/** Native mode attack automation: "off" | "prompt" | "roll" | "apply". */
function getAttackAutomation() {
  try { return game.settings.get(MODULE_ID, "attackAutomation"); } catch { return "off"; }
}

/** Native mode save automation: "off" | "request" | "npc" | "full". */
function getSaveAutomation() {
  try { return game.settings.get(MODULE_ID, "saveAutomation"); } catch { return "off"; }
}

/** Native mode, the GM's private rolls: "outcome" | "share" | "private". */
function getPrivateRollOutcome() {
  try { return game.settings.get(MODULE_ID, "privateRollOutcome"); } catch { return "outcome"; }
}

function isInspirationEnabled() {
  try { return game.settings.get(MODULE_ID, "enableInspiration"); } catch { return false; }
}

// ── Inspiration helpers ───────────────────────────────────────────────────────

/** Returns true if the actor is a player character who currently has Inspiration. */
function actorHasInspiration(actor) {
  if (!actor || actor.type !== "character") return false;
  return !!actor.system?.attributes?.inspiration;
}

/** Remove the actor's Inspiration point. */
async function consumeInspiration(actor) {
  await actor.update({ "system.attributes.inspiration": false });
  console.log(`[${MODULE_ID}] ${actor.name}: inspiration consumed`);
}

/**
 * Reroll using Inspiration. Honours the "inspirationAdvantage" setting:
 *   on  → always uses advantage, overriding any existing adv/disadv.
 *   off → plain reroll (keeps advantage, drops disadvantage, as evaluateReroll).
 */
async function evaluateInspirationReroll(originalRoll) {
  let useAdvantage = false;
  try { useAdvantage = game.settings.get(MODULE_ID, "inspirationAdvantage"); } catch {}

  const newRoll = await buildReroll(originalRoll, { forceAdvantage: useAdvantage }).evaluate();
  if (game.dice3d) await game.dice3d.showForRoll(newRoll, game.user, true, null, false);
  return newRoll;
}

// ── Luck Dice history (shared by Midi and native modes) ───────────────────────
// Rendered under the roll on whichever card the dice were spent on.
// History shape: { start, entries: [{ kind, label, total?, detail? }], verdict? }
// Entries without a total (luck damage) render as a plain line.

const HISTORY_FLAG = "luckHistory";
const VERDICTS     = { hit: ["HIT", true], miss: ["MISS", false], passed: ["PASSED", true], failed: ["FAILED", false] };

/** Active die faces of a roll, e.g. [4, 3] for 2d6. */
function diceFaces(roll) {
  return (roll?.dice ?? []).flatMap(d => (d.results ?? []).filter(r => r.active !== false).map(r => r.result));
}

/** The icon for one luck step, from its (module-generated) label. */
function stepIcon(label = "") {
  if (/inspiration/i.test(label)) return "fa-star";
  if (/^added/i.test(label))      return "fa-plus";
  return "fa-rotate";
}

/**
 * One history as a card row, matching dnd5e 6's card layout (an icon column
 * beside the content, like its `section.icon-row` roll rows):
 *
 *   🍀 Luck Dice                                MISS
 *      9 → ↻11 → ↻9 → ↻12                   (superseded totals struck; hover a step for details)
 *      ✸ +2d6 Luck Dice to damage
 *
 * Laid out with inline flex so it also renders inside Midi's card, which
 * doesn't carry dnd5e's icon-row styles. Returns a detached element.
 */
function renderLuckSection(history, {
  className = "lda-luck-history",
  title = history.entries?.length ? "Luck Dice" : "Result"
} = {}) {
  const escape   = foundry.utils.escapeHTML ?? ((s) => String(s));
  const hasTotal = (e) => e.total !== undefined && e.total !== null;
  const steps    = history.entries.filter(hasTotal);
  const notes    = history.entries.filter(e => !hasTotal(e));

  const token = (value, tooltip, icon, last) => `
    <span data-tooltip="${escape(tooltip)}" style="white-space:nowrap;${last ? "font-weight:bold;font-size:1.1em;" : "text-decoration:line-through;opacity:0.55;"}">${icon ? `<i class="fa-solid ${icon}" style="font-size:0.7em;opacity:0.7;margin-right:2px"></i>` : ""}${value}</span>`;
  const chain = [];
  if (steps.length && history.start !== null && history.start !== undefined) chain.push(token(history.start, "Original roll", null, false));
  steps.forEach((e, i) => chain.push(token(e.total, e.detail ? `${e.label} (${e.detail})` : e.label, stepIcon(e.label), i === steps.length - 1)));

  const [verdict, good] = VERDICTS[history.verdict] ?? [];
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <section class="icon-row ${className}" style="display:flex;align-items:flex-start;gap:6px;margin:2px 0">
      <i class="fa-fw fa-solid ${history.entries?.length ? "fa-clover" : "fa-dice-d20"}" aria-label="${escape(title)}" style="margin-top:2px;opacity:0.8"></i>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px">
          <strong>${escape(title)}</strong>
          ${verdict ? `<strong style="color:${good ? "#719f50" : "#c0392b"}">${verdict}</strong>` : ""}
        </div>
        ${chain.length ? `<div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px">${chain.join(`<span style="opacity:0.5">→</span>`)}</div>` : ""}
        ${notes.map(n => `<div style="opacity:0.85"><i class="fa-solid fa-burst" style="font-size:0.8em;margin-right:3px"></i>${escape(n.label)}</div>`).join("")}
      </div>
    </section>`.trim();
  return wrapper.firstElementChild;
}

// ── Luck history on dnd5e roll cards (native rolls, roll-request window) ─────
// Each luck step rewrites the card's first roll, so dnd5e redraws the total (and
// success / failure when the roll has a DC); the history and verdict go in this
// module's flag on the card and are shown under the roll (native.js renders it).

/** A writable copy of a card's luck history. */
function readCardHistory(message) {
  return foundry.utils.deepClone(message.getFlag(MODULE_ID, HISTORY_FLAG) ?? { start: null, entries: [] });
}

/** Rewrite a card's rolls and/or luck history in one update, so it re-renders once. */
async function updateRollCard(message, { rolls, history } = {}) {
  const update = {};
  if (rolls)   update.rolls = rolls;
  if (history) update[`flags.${MODULE_ID}.${HISTORY_FLAG}`] = history;
  await message.update(update);
}

/** Replace the card's first roll (the d20) and add one history entry. */
async function recordCardStep(message, roll, start, entry) {
  const history = readCardHistory(message);
  history.start ??= start;
  history.entries.push(entry);
  delete history.verdict;
  await updateRollCard(message, { rolls: [roll, ...message.rolls.slice(1)], history });
}

/**
 * Stamp the verdict on a card's history. Skipped when no luck was spent, unless
 * `always` — the roll-request window, whose rolls carry no DC for dnd5e to judge
 * (so the DC stays hidden), states pass / fail itself.
 */
async function finishCardHistory(message, verdict, { always = false } = {}) {
  if (!always && !message.getFlag(MODULE_ID, HISTORY_FLAG)?.entries?.length) return;
  const history = readCardHistory(message);
  history.verdict = verdict;
  await updateRollCard(message, { history });
}

/**
 * A reporter for the shared luck prompts (promptLuckOnCheckFail /
 * promptNatOneSave) that writes to a dnd5e roll card: a reroll replaces the
 * card's roll; added dice are merged into it.
 */
function cardReporter(message, originalRoll, kind = "check") {
  let current = originalRoll;
  const start = Number(originalRoll?.total ?? 0);
  return async (entry, { roll, bonusRoll } = {}) => {
    if (roll) current = roll;
    else if (bonusRoll) current = combineRolls(current, bonusRoll);
    await recordCardStep(message, current, start, { kind, ...entry });
  };
}

// Actors whose d20 roll is in progress through the roll-request window. That
// flow runs its own luck prompt, so native mode's post-roll hooks skip them.
const requestRollActors = new Set();

// ── Module settings ───────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enableLuckDice", {
    name: "Enable Luck Dice Automation",
    hint: "When enabled, players are prompted to spend Luck Dice on failed attacks, saves, and checks.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "enableInspiration", {
    name: "Enable Inspiration Automation",
    hint: "When enabled, players with Inspiration are prompted to use it on failed attacks, saves, and skill checks.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "inspirationAdvantage", {
    name: "Inspiration Rerolls with Advantage",
    hint: "When enabled, using Inspiration to reroll grants advantage (roll 2d20, keep the higher result).",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "mirrorToGM", {
    name: "Mirror roll requests to GM?",
    hint: "Off (default): Luck Dice prompts are sent only to the person who initiated " +
          "the roll — the player if the player rolled, the GM if the GM rolled — " +
          "even if the player controlling that character is currently online. " +
          "On: every Luck Dice prompt is shown to both the initiating user and the GM " +
          "simultaneously, regardless of who rolled.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "hideCheckCardsFromGM", {
    name: "Hide skill check roll cards from GM",
    hint: "When enabled, individual player roll cards are whispered to the rolling player only. " +
          "The GM sees only the summary card.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "attackAutomation", {
    name: "Attack Automation (without Midi-QoL)",
    hint: "What happens after an attack hits, once any Luck Dice are spent. " +
          "Prompt: a one-click \"Roll Damage\" prompt. Roll: damage is rolled automatically. " +
          "Roll and apply: damage is rolled and applied to each hit target (by the GM's client, " +
          "with resistances handled by dnd5e). Ignored when Midi-QoL is active.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      off:    "Off",
      prompt: "Prompt to roll damage",
      roll:   "Roll damage on hit",
      apply:  "Roll and apply damage on hit"
    },
    default: "off"
  });

  game.settings.register(MODULE_ID, "saveAutomation", {
    name: "Save Automation (without Midi-QoL)",
    hint: "When a save activity (e.g. Fireball) is used on targets. " +
          "Request: every target is asked to save — players get a prompt, the GM one prompt for NPCs. " +
          "Auto-roll NPC saves: the GM's client rolls NPC saves; players roll from the card as usual. " +
          "Full: NPC saves are rolled, players are prompted (with Luck Dice on a failure), then damage is " +
          "rolled and applied to each target — full on a failure, per the activity's on-save rule on a success. " +
          "Ignored when Midi-QoL is active.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      off:     "Off",
      request: "Request saves",
      npc:     "Auto-roll NPC saves",
      full:    "Full: saves, then roll and apply damage"
    },
    default: "off"
  });

  game.settings.register(MODULE_ID, "privateRollOutcome", {
    name: "Players See the GM's Private Rolls (without Midi-QoL)",
    hint: "When the GM rolls privately and the roll affects player characters (an NPC attacks a PC, an NPC's spell hits PCs). " +
          "Outcome card: a public card with just the outcome for those characters — hit or miss, saved or failed, damage taken — " +
          "never the NPC's totals, bonuses or DCs. Share: the GM's private attack and damage cards are also shown to the players " +
          "whose characters they target. Keep private: players see none of the GM's private rolls. Ignored when Midi-QoL is active.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      outcome: "Outcome card",
      share:   "Share full cards with targeted players",
      private: "Keep private"
    },
    default: "outcome"
  });

  game.settings.register(MODULE_ID, "debug", {
    name: "Debug Logging",
    hint: "Print detailed Scorpious187's Luck Dice Automation messages to the browser console. " +
          "Leave off in normal play.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  console.log(`[${MODULE_ID}] Settings registered.`);
});

return {
  MODULE_ID, LUCK_DICE_ITEM_NAME, IMPACT_DICE_ITEM_NAME,
  workflowState, pendingMidiSaveResults, clamp, debug,
  getWorkflowKey, getState,
  getDiceItem, getDiceUses, updateDiceUses,
  getLuckItem, getLuckUses, updateLuckUses,
  actorHasLuckDice, isWorkflowResponder,
  promptChoice, promptSlider,
  buildFakeRoll, getKeptD20Result,
  spendDiceFromPools, evaluateReroll, combineRolls, buildDiceAvailableHTML,
  whisperLuckRegain, maybeRegainLuckDie,
  isLuckDiceEnabled, isInspirationEnabled, getAttackAutomation, getSaveAutomation, getPrivateRollOutcome,
  actorHasInspiration, consumeInspiration, evaluateInspirationReroll,
  HISTORY_FLAG, diceFaces, renderLuckSection, requestRollActors,
  readCardHistory, updateRollCard, recordCardStep, finishCardHistory, cardReporter,
};
})();
