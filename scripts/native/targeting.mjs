// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Who a use affects: the creatures in a placed area, choosing among them, and target confirmation.

import { getTargetConfirmation, escapeHTML } from "./shared.mjs";

/**
 * The creatures inside an activity's placed area, filtered by what it affects
 * (activity.target.affects.type): enemies (a different disposition from the
 * caster), allies / willing (the same), the caster alone (self), or every
 * creature. The caster is left out when the area is cast from themselves
 * (range "self", e.g. Burning Hands); dead creatures are left out, and so are
 * hidden tokens when a player casts — they can't target what they can't see.
 */
export function tokensInActivityArea(activity, regions) {
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
export async function chooseAffected(activity, tokens) {
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

// ── Target confirmation ───────────────────────────────────────────────────────
// The "targetConfirmation" setting: before the module automates a use, the caster
// confirms its targets in a small list that follows their canvas targeting live.
// For heal and damage-only activities (which dnd5e rolls right after use) and
// rays, dnd5e's follow-up roll is suppressed (usageConfig.subsequentActions) and
// made here once the targets are confirmed.

/** The placed area of a use (dnd5e places it before postUseActivity fires). */
export function regionsOf(results) {
  return (results?.templates ?? []).filter(r => r?.documentName === "Region");
}

/** Whether this use's targets are confirmed first, per the setting. */
export function needsConfirmation(activity, results) {
  const mode = getTargetConfirmation();
  if (mode === "off" || !canvas?.ready) return false;
  if (activity?.target?.affects?.type === "self") return false;
  if (regionsOf(results).length) return true;
  return (mode === "all" || mode === "every") && activity?.range?.units !== "self";
}

/** Whether an ordinary attack's targets are confirmed first (the setting's "every attack" choice). */
export function needsAttackConfirmation(activity, results) {
  return activity?.type === "attack" && getTargetConfirmation() === "every" && needsConfirmation(activity, results);
}

/**
 * The caster's current targets, kept up to date as they target or untarget
 * creatures on the canvas, each removable from the list. Resolves with the
 * confirmed TokenDocuments, or null if cancelled / closed. Non-modal, so the
 * canvas stays usable while it's open.
 */
export async function confirmTargets(activity, fallback = null) {
  const DialogV2 = foundry.applications.api?.DialogV2;
  if (!DialogV2 || !canvas?.ready) return fallback;
  let hookId = null;
  const unhook = () => { if (hookId !== null) Hooks.off("targetToken", hookId); hookId = null; };

  const refresh = (root) => {
    const list = root.querySelector(".lda-confirm-list");
    if (!list) return;
    const targets = [...game.user.targets];
    list.innerHTML = targets.length ? targets.map(t => `
      <li style="display:flex;align-items:center;gap:8px;margin:3px 0">
        <img src="${escapeHTML(t.document.texture?.src ?? "")}" alt="" style="width:28px;height:28px;border:none;object-fit:contain">
        <span style="flex:1">${escapeHTML(t.name)}</span>
        <button type="button" data-lda-untarget="${t.id}" data-tooltip="Remove" aria-label="Remove ${escapeHTML(t.name)}"
          style="flex:0 0 auto;width:auto;padding:0 6px;line-height:1.4"><i class="fa-solid fa-xmark"></i></button>
      </li>`).join("")
      : `<li style="opacity:0.7;margin:3px 0">No targets — target creatures on the canvas.</li>`;
    const ok = root.querySelector('button[data-action="ok"]');
    if (ok) ok.disabled = !targets.length;
  };

  const result = await DialogV2.wait({
    window:   { title: `${activity.item?.name ?? activity.name}: Confirm Targets` },
    position: { width: 320 },
    content:  `<p>Target or untarget creatures on the canvas to change this list.</p>
      <ul class="lda-confirm-list" style="list-style:none;margin:0;padding:0"></ul>`,
    buttons: [
      { action: "ok", label: "Confirm", icon: "fa-solid fa-check", default: true,
        callback: () => [...game.user.targets].map(t => t.document) },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ],
    render: (_event, dialog) => {
      const root = dialog.element;
      root.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-lda-untarget]");
        if (!button) return;
        event.preventDefault();
        canvas.tokens?.setTargets([button.dataset.ldaUntarget], { mode: "release" });
      });
      unhook();
      hookId = Hooks.on("targetToken", (user) => { if (user === game.user) refresh(root); });
      refresh(root);
    },
    close: unhook,
    rejectClose: false
  });
  unhook();
  if (!Array.isArray(result)) {
    ui.notifications?.info(`Luck Dice Automation: ${activity.item?.name ?? activity.name} — targets not confirmed, nothing automated.`);
    return null;
  }
  return result;
}
