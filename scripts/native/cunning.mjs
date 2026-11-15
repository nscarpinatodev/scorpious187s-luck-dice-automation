// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Cunning Strike (2024 Rogue 5), under the "onHitRiders" setting, with Sneak Attack (riders.mjs).
//
// When Sneak Attack is added to a hit, a rogue with Cunning Strike is asked which effects to add, each paid for by
// forgoing Sneak Attack dice: Poison (1d6: a Constitution save or Poisoned), Trip (1d6: a Large or smaller creature
// makes a Dexterity save or falls Prone), Withdraw (1d6: the rogue's next move, up to half its Speed, provokes no
// opportunity attacks); with Devious Strikes (Rogue 14) also Daze (2d6), Knock Out (6d6) and Obscure (3d6). One
// effect, two with Improved Cunning Strike (Rogue 11). The dice left are rolled with dnd5e's own "Cunning Sneak
// Attack" activity; then each save effect's own save activity goes through the save automation (DC 8 + Dexterity
// modifier + Proficiency Bonus, its effect on a failure).

import { automateSaves } from "./saves.mjs";
import { useClaimed } from "./riders.mjs";
import { rulesOf } from "./advantage.mjs";
import { grantWithdraw } from "./opportunity.mjs";
import { MODULE_ID, debug, escapeHTML, getSaveAutomation, isLike } from "./shared.mjs";

// By activity name: what it costs in Sneak Attack dice, and its note.
const COSTS = { poison: 1, trip: 1, withdraw: 1, daze: 2, "knock out": 6, obscure: 3 };
const SIZES = ["tiny", "sm", "med", "lg", "huge", "grg"];

const feat = (actor, identifier) => actor?.items?.find?.(i => i.system?.identifier === identifier) ?? null;
const activitiesOf = (item) => [...(item?.system?.activities?.values?.() ?? [])];
const costOf = (activity) => COSTS[String(activity?.name ?? "").trim().toLowerCase()] ?? null;

/** The Sneak Attack dice the rogue has (its scale value), or null. */
export function sneakDice(actor) {
  const scale = actor?.system?.scale?.rogue?.["sneak-attack"];
  const number = Number(scale?.number ?? scale?.value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** The Cunning Strike effects a rogue could add now: [{ activity, cost, name }], and how many at once. */
export function cunningOptions(actor) {
  const cunning = feat(actor, "cunning-strike");
  if (!cunning || rulesOf(cunning) === "2014") return { options: [], max: 0 };
  const options = [cunning, feat(actor, "devious-strikes")].filter(Boolean).flatMap(activitiesOf)
    .map(activity => ({ activity, cost: costOf(activity), name: activity.name }))
    .filter(o => o.cost);
  return { options, max: feat(actor, "improved-cunning-strike") ? 2 : 1 };
}

/** Whether a choice of effects can be paid for: no more than `max` of them, and no more dice than there are. */
export const cunningAffordable = (picked, max, dice) => picked.length <= max && picked.reduce((s, o) => s + o.cost, 0) <= dice;

/** Ask which effects to add (checkboxes). Resolves with the picked options ([] for none). */
async function askCunning(options, max, dice) {
  const DialogV2 = foundry.applications.api?.DialogV2;
  if (!DialogV2) return [];
  const rows = options.map((o, i) => `
    <label style="display:flex;align-items:center;gap:6px;margin:3px 0">
      <input type="checkbox" name="lda-cunning" value="${i}"${o.cost > dice ? " disabled" : ""}> ${escapeHTML(o.name)}
      <span style="opacity:0.7">(−${o.cost}d6)</span>
    </label>`).join("");
  const picked = await DialogV2.wait({
    window: { title: "Cunning Strike" },
    content: `<p>Add ${max === 1 ? "an effect" : `up to ${max} effects`} to this Sneak Attack, forgoing its dice (${dice}d6)?</p>${rows}`,
    buttons: [
      { action: "ok", label: "Add", icon: "fa-solid fa-check", default: true,
        callback: (_event, button) => [...button.form.querySelectorAll('input[name="lda-cunning"]:checked')].map(i => Number(i.value)) },
      { action: "skip", label: "None", icon: "fa-solid fa-xmark", callback: () => [] }
    ],
    rejectClose: false
  });
  return Array.isArray(picked) ? picked.map(i => options[i]).filter(Boolean) : [];
}

/**
 * Sneak Attack's configure step (riders.mjs), before its dice are rolled: the rogue's Cunning Strike effects. On a
 * pick, the rider rolls dnd5e's "Cunning Sneak Attack" activity with the dice forgone as its scaling.
 */
export async function cunningConfigure(choice, { activity, hits = [] }) {
  const actor = activity?.actor;
  const { options, max } = cunningOptions(actor);
  const dice = sneakDice(actor);
  if (!options.length || !dice) return;
  const reduced = activitiesOf(choice.item).find(a => isLike(a, "damage") && /cunning/i.test(a.name ?? ""));
  if (!reduced) return;
  let picked = await askCunning(options, max, dice);
  if (!picked.length) return;
  if (!cunningAffordable(picked, max, dice)) {
    ui.notifications?.warn(`Luck Dice Automation: Cunning Strike — at most ${max} effect${max === 1 ? "" : "s"}, and no more than ${dice}d6 forgone.`);
    picked = picked.slice(0, max);
    while (picked.length && !cunningAffordable(picked, max, dice)) picked.pop();
    if (!picked.length) return;
  }
  choice.cunning = picked;
  choice.scaling = picked.reduce((s, o) => s + o.cost, 0);
  choice.activities = [reduced];
  debug(`cunning strike: ${actor.name} — ${picked.map(o => o.name).join(", ")} (−${choice.scaling}d6)`);
}

/** After the Sneak Attack lands: Withdraw, and each save effect's save at the creatures hit. Resolves with notes. */
export async function cunningAfter(choice, { activity, hits = [] }) {
  const notes = [];
  if (!choice.cunning?.length) return notes;
  const actor = activity?.actor;
  const mode = getSaveAutomation();
  for (const option of choice.cunning) {
    const name = option.name;
    if (/withdraw/i.test(name)) {
      grantWithdraw(actor);
      notes.push("Withdraw: the next move (up to half Speed) provokes no opportunity attacks");
      continue;
    }
    let targets = hits.map(h => ({ actor: h.actor, token: h.token, name: h.name }));
    if (/trip/i.test(name)) {
      const sized = [];
      for (const t of targets) {
        const size = (t.token ? await fromUuid(t.token) : null)?.actor?.system?.traits?.size ?? "med";
        if (SIZES.indexOf(size) <= SIZES.indexOf("lg")) sized.push(t);
      }
      targets = sized;
    }
    if (!targets.length) { notes.push(`${name}: no creature it works on`); continue; }
    if (mode === "off") { notes.push(`${name}: roll its save from the Cunning Strike card`); continue; }
    const usage = (await useClaimed(option.activity, { consume: false, [MODULE_ID]: { noCounter: true } }, { configure: false })
      .catch(() => null))?.message ?? null;
    await automateSaves(option.activity, targets, usage, mode);
    notes.push(`${name} (−${option.cost}d6)`);
  }
  return notes;
}
