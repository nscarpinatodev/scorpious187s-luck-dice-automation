# Roll-Time Bonuses

*A guide for players. Written for Luck Dice Automation 2.6.0, using dnd5e without Midi-QoL. With Midi-QoL active, Midi handles most of this instead.*

Many bonuses at our table don't show on your character sheet. They're worked out at the moment you roll, from where everyone is standing and what's going on right then, and they appear on that roll.

This page explains where to see them, what gets checked when you roll, and what to look at if one seems to be missing.

## An example: Aura of Protection

Your rogue is standing 10 feet from the party's paladin, who has a Charisma modifier of +3. A fireball goes off and you're asked for a Dexterity saving throw.

| Your character sheet | The roll window and the chat card |
| --- | --- |
| Dexterity saving throw: **+7** | `1d20 + 7 + 3` |
| No sign of the paladin's aura. The sheet only shows what's always true about you. | **Bonus:** Aura of Protection (Brother Tam) +3. The module saw the paladin within 10 ft and added +3 to this roll. |

If you step 15 feet away and roll again, the bonus isn't there. If the paladin is knocked unconscious, it isn't there. Nothing needs to be switched on or off: each roll looks at the board fresh.

## Where to see what was applied

- **The roll window.** When the window opens before you roll, a line under the roll lists what the module found, such as *Advantage: Faerie Fire* or *Bonus: Aura of Protection +3*. You can still change the roll there.
- **The chat card.** The same line appears on the card the roll posts, so everyone can see why it came out the way it did. This is also where you look if you skipped the roll window.
- **The roll's formula.** A flat bonus is part of the formula itself. Hover over or expand the total to see it.

> **Why it works this way.** The alternative is putting temporary effects on everyone's sheets and updating them every time a token moves. That's a lot of background work for Foundry, and it leaves stale bonuses behind when something is missed. Checking at the moment of the roll is always current and leaves nothing to clean up.

## What's checked when you roll

Your GM chooses which of these are on. The setting each one belongs to is in brackets, in case you need to ask.

### Attack rolls: advantage and disadvantage *(Attack Rules)*

| | |
| --- | --- |
| **Range** | Disadvantage at long range, and on a ranged attack with an enemy within 5 ft of you. Crossbow Expert, Sharpshooter, Spell Sniper and Gunner remove these where their rules say so. An attack beyond long range is stopped with a message. |
| **Your conditions** | Prone, Restrained or Blinded give disadvantage. Frightened gives disadvantage while you can see what frightened you. Invisible gives advantage. |
| **Your target's conditions** | Advantage against a target that's Restrained, Blinded, Paralyzed, Stunned, Unconscious or Petrified. Against a Prone target: advantage within 5 ft, disadvantage farther away. Disadvantage against a target that's Invisible or Dodging. |
| **Features and spells** | Reckless Attack (yours, or the target's), Faerie Fire, Guiding Bolt, Shining Smite on the target, Grappler against a creature you're grappling, Pack Tactics (an ally of yours within 5 ft of the target), disadvantage against a creature under Blur (unless you have blindsight or truesight), and disadvantage with a Heavy weapon you're too small or too weak to wield well. |
| **Mirror Image** | When the target is under Mirror Image, a duplicate may take the attack instead (2024: a d6 per duplicate on a hit, any 3 or more; 2014: a d20 for every attack). The card says what happened. Blindsight and truesight see through it. |
| **Sanctuary** | Attacking a creature warded by Sanctuary, or aiming a damaging spell at it, you make a Wisdom save first. On a failure you lose that target; with none left, the attack or spell is lost. |
| **Sunlight Sensitivity** | On a scene your GM has marked as in sunlight, a creature with Sunlight Sensitivity has disadvantage on its attack rolls and ability checks (2014: Perception checks). |
| **One-time marks** | Vex, Sap, Studied Attacks (after a Fighter misses a creature), Stunning Strike's advantage, Silvery Barbs' advantage (which also works on your next check or save) and Sundering Blow's +5 (for anyone but the barbarian). These apply to the next attack only and are used up by it. |
| **Elusive** | A Rogue with Elusive can't be attacked with advantage from any source, unless they're Incapacitated. The card lists the advantage that was ignored. |
| **Cover** | Spell Sniper and Sharpshooter ignore half and three-quarters cover. The card shows the target's AC without the cover bonus. |

Advantage and disadvantage from any sources cancel out, as the rules say. Checks about your target only work with exactly one target selected.

### Attack rolls: other changes

| | |
| --- | --- |
| **Improved Pact Weapon** | +1 to hit with a pact weapon that isn't already magical. *(Eldritch Invocations)* |
| **Solid walls** | An attack through Wall of Force, Wall of Stone, Wall of Ice or Forcecage is stopped before anything is spent. *(Wall Spells Block)* |

### Saving throws *(Saving Throw Rules)*

| | |
| --- | --- |
| **Aura of Protection** | The best Charisma modifier (at least +1) among friendly paladins within 10 ft, or 30 ft from 18th level. Two paladins don't stack; you get the higher one. A paladin who's incapacitated gives nothing. |
| **Automatic failure** | Strength and Dexterity saves while you're Paralyzed, Stunned, Unconscious or Petrified. The roll is still shown, and Legendary Resistance can still turn it. |
| **Advantage from traits** | Magic Resistance, Gnome Cunning, Duergar Resilience, Dwarven Resilience, Fey Ancestry, Brave, and 2014 Danger Sense, each against what it covers. Saves made to end a condition count too. |
| **Aura of Courage** | Allies in a paladin's Aura of Courage can't be frightened: a Frightened effect doesn't land on them, and if they're already frightened they attack normally. |
| **Countercharm (2014)** | While a bard performs it, the bard and friends within 30 ft who can hear it have advantage on saves against being charmed or frightened. |
| **Staggered** | A Barbarian's Brutal Strike (Staggering Blow) gives you disadvantage on your next save. |

### Concentration saves

| | |
| --- | --- |
| **Everything above** | A concentration save is a Constitution save, so Aura of Protection applies to it. |
| **Extended Spell (2024)** | Advantage on concentration saves for an extended spell. *(Metamagic)* |

### Damage rolls

| | |
| --- | --- |
| **Automatic critical hits** | A hit on a Paralyzed or Unconscious target from within 5 ft is a critical hit. *(Automatic Critical Hits)* |
| **Fighting styles and feats** | Great Weapon Fighting on two-handed melee damage. Two-Weapon Fighting, and 2024 Crossbow Expert, add your modifier to off-hand damage. *(Attack Rules)* |
| **Cleave** | The second attack's damage leaves out your ability modifier, unless it's negative. *(Weapon Mastery)* |
| **Invocations** | Agonizing Blast adds your Charisma modifier to each beam. Improved Pact Weapon adds +1. *(Eldritch Invocations)* |
| **Transmuted Spell** | The damage type you picked replaces the spell's. *(Metamagic)* |
| **Marks** | Hunter's Mark and Hex are added automatically when every creature you hit carries your mark. *(On-Hit Riders)* |
| **Empowered Evocation** | An Evoker adds their Intelligence modifier to the first damage roll of each wizard Evocation spell. *(Attack Rules)* |
| **Toll the Dead** | Rolls d12s instead of d8s when its target is already hurt, whichever version you picked. *(Attack Rules)* |
| **Potent Cantrip (2024)** | An Evoker's damaging cantrip that misses still deals half its damage, with no other effect. *(Attack Rules)* |
| **Choices on a hit** | Sneak Attack, Divine Smite, the 2024 smites (Searing, Thunderous, Wrathful and Shining Smite), Divine Strike, Primal Strike and Colossus Slayer are offered as checkboxes when the hit's damage is rolled, where they apply. A smite's save and effect follow it. Savage Attacker rolls your weapon dice twice and keeps the better total. Great Weapon Master (2024) adds your proficiency bonus to a Heavy weapon hit on your turn. *(On-Hit Riders)* |

## What's offered after a roll

These don't change the roll ahead of time. They show up as a prompt or a card note once the result is known.

| | |
| --- | --- |
| **A failed roll or a miss** | One prompt offers your Luck Dice, plus Bardic Inspiration, Guidance and Resistance (2014), Lucky, Indomitable, Protection of the Talisman, Dark One's Own Luck, Tactical Mind (a Second Wind use, spent only if it works), Stroke of Luck (your d20 becomes a 20) and Seeking Spell, whichever you have. |
| **A low Strength check** | Indomitable Might (Barbarian 18) uses your Strength score in place of a lower total, on Strength checks (and, with the 2024 rules, Strength saves). |
| **When you fail a save against charm or fear** | With the 2024 rules, you or a bard within 30 ft can use Countercharm to reroll the save with advantage. Your Luck Dice prompt follows if it still fails. |
| **After you hit** | Weapon Mastery effects (Topple, Sap, Vex, Slow, Push, Cleave) and Stunning Strike. Graze applies on a miss. |
| **When you're hit** | Your reactions: Shield, Parry, Uncanny Dodge, Deflect Attacks, Superior Hunter's Defense and the others you have. The prompt goes to you, not the attacker. If you have the Lucky feat, you can also spend a point to make the attacker reroll. |
| **When you succeed on a save or check** | An enemy within 60 ft who can see you may cast Silvery Barbs: you reroll and keep the lower. If that turns it into a failure, your Luck Dice prompt follows as usual. Whoever cast it then picks a creature to have advantage on its next attack, check or save within a minute. |
| **When you cast a spell** | An enemy within 60 ft who can see you may cast Counterspell. With the 2024 spell you make a Constitution save, and on a failure the spell fizzles without spending its slot. With the 2014 spell it's countered outright up to the Counterspell's level, otherwise the counterspeller makes a spellcasting ability check; a countered spell's slot is still spent. Spells cast with Subtle Spell can't be countered. |
| **When saves are settled** | Evasion, Careful Spell, Heightened Spell, Sculpt Spells and Potent Cantrip change the outcome or the damage. A cantrip from an Evoker with Potent Cantrip still deals half damage on a successful save. An evoker's spell with allies caught in it asks the wizard which creatures to shape it around. |
| **When damage lands** | Death-save failures from damage at 0 HP, massive damage, Relentless Rage, and Gift of the Protectors. An Abjurer's Arcane Ward takes damage before they do; casting an Abjuration spell with a slot creates the ward or restores twice the spell's level. |

## What happens on the board

These are the only things you'll see happen without rolling anything yourself.

- Opportunity attacks are offered when a creature moves out of reach.
- Lingering spell areas, such as Spirit Guardians or Cloud of Daggers, affect creatures as they move into them or take turns in them, following each spell's wording.
- Repeat saves against a condition are rolled at the end of your turn.
- Searing Smite burns its target at the start of each of its turns (a Constitution save ends it); monsters with Regeneration heal at the start of theirs, unless they took the damage that stops it; a zombie's Undead Fortitude can keep it standing at 1 HP.
- Concentration saves after damage, and death saves at the start of your turn, are rolled for you. You still get your Luck Dice prompt.
- Wall spells become real walls that block movement, and sight where the spell says so.

## If a bonus seems to be missing

1. **Is your token on the map?** The module measures between tokens on the same scene. Rolling from your sheet with no token on the scene means there's nothing to measure.
2. **Is it really in range?** Distance is measured between the nearest squares of the two tokens, and height counts. A creature flying 15 ft up is 15 ft away from you.
3. **Is the token marked friendly?** Auras go to tokens with the same disposition as the paladin. A companion set to neutral doesn't count. Ask your GM to change it.
4. **Did you select exactly one target?** Attack checks about the target, such as Prone or Faerie Fire, are skipped when several targets are selected.
5. **Did you roll through the sheet?** A roll typed into chat, such as `/r 1d20+5`, isn't a saving throw or an attack to Foundry, so nothing is added to it.
6. **Did advantage cancel out?** Any disadvantage on the same roll cancels the advantage, however many sources of each there are. The card lists both.
7. **Is the setting on?** If the card shows no line from the module at all, the GM may have turned that rule off.
