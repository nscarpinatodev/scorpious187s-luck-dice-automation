// ── Scorpious187's Luck Dice Automation — Native dnd5e 6 ──────────────────────
// Sunlight Sensitivity, under the "attackAdvantage" setting.
//
// Whether a creature stands in sunlight can't be read from the scene (a lit dungeon and a sunny field look the
// same to Foundry), so the GM says so per scene: Scene configuration gets a "This scene is in sunlight" checkbox
// (a module flag on the scene). On such a scene, a creature with Sunlight Sensitivity has disadvantage on its
// attack rolls (advantage.mjs) and — 2024 — its ability checks; 2014, its Wisdom (Perception) checks
// (save-rules.mjs's check hook).

import { MODULE_ID, escapeHTML } from "./shared.mjs";

export const SUNLIGHT_FLAG = "sunlight"; // on a scene: it's in sunlight

/** Whether a creature's token stands on a scene the GM marked as being in sunlight. */
export function inSunlight(tokenDoc) {
  const scene = tokenDoc?.parent ?? null;
  return !!scene?.getFlag?.(MODULE_ID, SUNLIGHT_FLAG);
}

/** The creature's Sunlight Sensitivity trait, if it has one. */
export const sunlightSensitivity = (actor) => actor?.items?.find?.(i => i.system?.identifier === "sunlight-sensitivity") ?? null;

/** renderSceneConfig: the "This scene is in sunlight" checkbox, saved with the scene's other settings. */
export function onRenderSceneConfig(app, element) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  const scene = app?.document;
  if (!root || !scene || root.querySelector(`[name="flags.${MODULE_ID}.${SUNLIGHT_FLAG}"]`)) return;
  // A tab's content panel (`.tab`), never its button in the navigation, which carries the same data-tab. With the
  // other lighting settings (Environment) where there is such a tab; else the first tab's panel.
  const panel = (tab) => root.querySelector(`.tab[data-tab="${tab}"]:not(nav *):not(a):not(button)`);
  const anchor = panel("environment") ?? panel("lighting") ?? panel("basics") ?? panel("basic");
  if (!anchor) return;
  const group = document.createElement("div");
  group.className = "form-group";
  group.innerHTML = `
    <label>${escapeHTML("In Sunlight")}</label>
    <div class="form-fields">
      <input type="checkbox" name="flags.${MODULE_ID}.${SUNLIGHT_FLAG}"${scene.getFlag(MODULE_ID, SUNLIGHT_FLAG) ? " checked" : ""}>
    </div>
    <p class="hint">${escapeHTML("Luck Dice Automation: creatures with Sunlight Sensitivity have disadvantage here (outdoor daylight scenes).")}</p>`;
  anchor.append(group);
}
