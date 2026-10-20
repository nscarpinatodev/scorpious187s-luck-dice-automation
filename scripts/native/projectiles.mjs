// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Projectile spells: Magic Missile's darts, Scorching Ray's rays, Eldritch Blast's beams.

import { applyConsumedFlag } from "./autoroll.mjs";
import { debug, isRayAutomationEnabled, escapeHTML, pendingAttacks } from "./shared.mjs";
import { needsConfirmation, confirmTargets } from "./targeting.mjs";

// ── Projectile spells ─────────────────────────────────────────────────────────
// dnd5e rolls one of a spell's projectiles and keeps no count of them.
//   Darts (Magic Missile, damage-only automation): the card's one roll is every
//   dart's damage (Sage Advice: roll once, all darts deal it); the caster splits
//   the darts among their targets, each applied as its own instance of damage.
//   Rays and beams (Scorching Ray, Eldritch Blast; the ray setting): the caster
//   splits them among their targets, then each is its own attack roll, through
//   the usual attack flow — Luck Dice on a miss, attack automation on a hit.

// By item identifier: the activity type that fires them, how many at the spell's
// base level, and how many more per step of scaling — a slot level above the
// base, or a cantrip's tier (Eldritch Blast: 1 beam, 2 at level 5, 3 at 11, 4 at 17).
export const PROJECTILE_SPELLS = {
  "magic-missile":  { type: "damage", base: 3, perLevel: 1, noun: "dart" },
  "scorching-ray":  { type: "attack", base: 3, perLevel: 1, noun: "ray" },
  "eldritch-blast": { type: "attack", base: 1, perLevel: 1, noun: "beam" }
};

/** How many projectiles this use fires, or null for an activity that isn't one. */
export function projectileCount(activity, usage) {
  const spell = PROJECTILE_SPELLS[activity?.item?.system?.identifier];
  if (!spell || spell.type !== activity.type) return null;
  const scaling = Number(usage?.system?.scaling) || Number(activity.item.scalingIncrease) || 0;
  return { ...spell, count: spell.base + spell.perLevel * Math.max(0, scaling) };
}

/**
 * The targets with how many projectiles hit each. One target takes them all;
 * with several, the caster picks a count per target from drop-downs that only
 * offer what's still unassigned. Resolves null if the dialog is closed.
 */
export async function assignProjectiles(activity, targets, { count, noun }, detail = "", { luck = false } = {}) {
  if (targets.length === 1) return [{ ...targets[0], hits: count, ...(luck ? { luck: true } : {}) }];
  const DialogV2 = foundry.applications.api?.DialogV2;
  if (!DialogV2) return null;

  const plural  = (n) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const options = (max, selected) => Array.from({ length: max + 1 }, (_, n) =>
    `<option value="${n}"${n === selected ? " selected" : ""}>${n}</option>`).join("");
  const rows = targets.map((t, i) => `
    <label style="display:flex;align-items:center;gap:8px;margin:4px 0">
      <span style="flex:1">${escapeHTML(t.name)}</span>
      <select name="lda-hits-${i}" style="flex:0 0 4em">${options(count, 0)}</select>
    </label>`).join("");
  // With Luck Dice on the card: which target's dart carries them (only targets with a dart).
  const luckRow = luck ? `
    <label style="display:flex;align-items:center;gap:8px;margin:8px 0 4px">
      <span style="flex:1">Luck Dice ${noun} hits</span>
      <select name="lda-luck" style="flex:0 0 50%"></select>
    </label>` : "";
  const luckOptions = (values, selected) => {
    const hit = targets.map((t, i) => ({ t, i })).filter(({ i }) => values[i] > 0);
    if (!hit.length) return `<option value="">—</option>`;
    const chosen = hit.some(({ i }) => i === selected) ? selected : hit[0].i;
    return hit.map(({ t, i }) => `<option value="${i}"${i === chosen ? " selected" : ""}>${escapeHTML(t.name)}</option>`).join("");
  };

  // Each drop-down offers 0 up to what the others leave; Confirm waits for all of them.
  const refresh = (root) => {
    const selects = [...root.querySelectorAll('select[name^="lda-hits-"]')];
    const values  = selects.map(s => Number(s.value) || 0);
    const total   = values.reduce((a, b) => a + b, 0);
    selects.forEach((s, i) => { s.innerHTML = options(count - (total - values[i]), values[i]); });
    const luckSelect = root.querySelector('select[name="lda-luck"]');
    if (luckSelect) luckSelect.innerHTML = luckOptions(values, luckSelect.value === "" ? -1 : Number(luckSelect.value));
    const left = root.querySelector(".lda-hits-left");
    if (left) left.textContent = count - total ? `${plural(count - total)} left to assign` : `All ${plural(count)} assigned`;
    const ok = root.querySelector('button[data-action="ok"]');
    if (ok) ok.disabled = total !== count;
  };

  const result = await DialogV2.wait({
    window:  { title: `${activity.item?.name ?? activity.name}: Assign ${noun[0].toUpperCase()}${noun.slice(1)}s` },
    content: `<p>${plural(count)}${detail ? `, ${detail}` : "."} Choose how many hit each target.</p>
      ${rows}${luckRow}<p class="lda-hits-left" style="opacity:0.8"></p>`,
    buttons: [{
      action: "ok", label: "Confirm", icon: "fa-solid fa-check", default: true,
      callback: (_event, button) => ({
        hits: targets.map((_, i) => Number(button.form.elements[`lda-hits-${i}`]?.value) || 0),
        luck: luck ? Number(button.form.elements["lda-luck"]?.value) : -1
      })
    }],
    render: (_event, dialog) => {
      const root = dialog.element;
      root.addEventListener("change", (event) => { if (event.target.matches?.('select[name^="lda-hits-"]')) refresh(root); });
      refresh(root);
    },
    rejectClose: false
  });
  if (!Array.isArray(result?.hits)) {
    ui.notifications?.info(`Luck Dice Automation: ${activity.item?.name ?? "the spell"} wasn't applied — use the card's tray.`);
    return null;
  }
  return targets.map((t, i) => ({ ...t, hits: result.hits[i], ...(i === result.luck ? { luck: true } : {}) })).filter(t => t.hits > 0);
}

/** A ray / beam spell's projectiles when the ray setting is on and it fires more than one. */
export function rayCount(activity, usage) {
  if (!isRayAutomationEnabled() || activity?.type !== "attack") return null;
  const rays = projectileCount(activity, usage);
  return rays?.count > 1 ? rays : null;
}

/**
 * After a ray / beam spell's use (dnd5e's single attack roll suppressed): the
 * caster assigns the rays to their targets, then each ray is an attack roll at
 * its target, one after another — each waits for its Luck Dice prompt and its
 * damage before the next. The caster's targets are put back afterwards.
 */
export async function fireRays(activity, usageConfig, results, rays) {
  const usage = results?.message;
  const name  = activity.item?.name ?? activity.name;
  let tokens  = [...game.user.targets].map(t => t.document);
  if (needsConfirmation(activity, results)) tokens = await confirmTargets(activity, tokens);
  tokens = (tokens ?? []).filter(t => t?.actor && t.parent === canvas.scene);
  if (!tokens.length) {
    ui.notifications?.info(`Luck Dice Automation: no targets for ${name} — roll its attacks from the card.`);
    return;
  }
  const assigned = await assignProjectiles(activity, tokens.map(t => ({ id: t.id, token: t.uuid, name: t.name })), rays, "one attack roll each.");
  if (!assigned?.length) return;
  applyConsumedFlag(activity, results);

  const restore = [...game.user.targets].map(t => t.id);
  const order   = assigned.flatMap(t => Array(t.hits).fill(t));
  const label   = rays.noun[0].toUpperCase() + rays.noun.slice(1);
  try {
    for (const [i, target] of order.entries()) {
      canvas.tokens?.setTargets([target.id], { mode: "replace" });
      const rolls = await activity.rollAttack({ event: usageConfig?.event }, {}, { data: {
        flavor: `${name} - ${game.i18n.localize("DND5E.AttackRoll")} (${label} ${i + 1} of ${order.length})`,
        system: { origin: usage?.id }
      } });
      const message = rolls?.[0]?.parent;
      if (!message) { debug(`rays: attack ${i + 1} cancelled — stopping`); break; }
      await pendingAttacks.get(message.id);
    }
  } finally {
    canvas.tokens?.setTargets(restore, { mode: "replace" });
  }
}
