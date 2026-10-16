# Keyboard shortcuts

<!-- Generated from src/settings/keybindings.ts by src/settings/keybindings.doc.test.ts. Do not edit by hand. -->

This file is generated from the shortcut registry, so it cannot drift from the game. To change it, edit the registry and run `UPDATE_KEYBINDINGS_DOC=1 npx vitest run src/settings/keybindings.doc.test.ts`.

Every shortcut below can be changed in Settings, in the Keyboard section. Esc and the fixed keys cannot.

## Camera

| Action | Default key | Works | Description |
| --- | --- | --- | --- |
| Pan up | W or Up arrow | Park view: everywhere except overlays, dialogs and menus | Move the camera up. The letter names the physical key position, so it follows the same keys on other layouts. |
| Pan left | A or Left arrow | Park view: everywhere except overlays, dialogs and menus | Move the camera left. The letter names the physical key position, so it follows the same keys on other layouts. |
| Pan down | S or Down arrow | Park view: everywhere except overlays, dialogs and menus | Move the camera down. The letter names the physical key position, so it follows the same keys on other layouts. |
| Pan right | D or Right arrow | Park view: everywhere except overlays, dialogs and menus | Move the camera right. The letter names the physical key position, so it follows the same keys on other layouts. |

## Speed

| Action | Default key | Works | Description |
| --- | --- | --- | --- |
| Pause | 0 | Park view: everywhere except overlays, dialogs and menus | Pause the simulation. |
| Normal speed | 1 | Park view: everywhere except overlays, dialogs and menus | Run the simulation at 1x. |
| Double speed | 2 | Park view: everywhere except overlays, dialogs and menus | Run the simulation at 2x. |
| Fast forward | 4 | Park view: everywhere except overlays, dialogs and menus | Run the simulation at 4x. |

## View

| Action | Default key | Works | Description |
| --- | --- | --- | --- |
| Toggle grid | G | Park view: everywhere except overlays, dialogs and menus | Show or hide the tile grid. |
| Clean view | H | Park view: everywhere except overlays, dialogs and menus | Hide or show the menus to look at the park. |
| Rotate view left | Q | Park view: everywhere except overlays, dialogs and menus | Turn the whole map a quarter turn counter-clockwise. |
| Rotate view right | E | Park view: everywhere except overlays, dialogs and menus | Turn the whole map a quarter turn clockwise. |
| Recentre view | V | Park view: everywhere except overlays, dialogs and menus | Move the camera back to the park entrance. |
| Crowd heatmap | T | Park view: everywhere except overlays, dialogs and menus | Show or hide the crowd flow heatmap (the same as the ≋ button). |
| See through | X | While building: not behind the management dashboard, overlays, dialogs or menus | Hold to see through buildings and scenery near the cursor. Hold the key; release to stop. |

## Sound

| Action | Default key | Works | Description |
| --- | --- | --- | --- |
| Mute sound | M | Park view: everywhere except overlays, dialogs and menus | Mute or unmute all sound (sets the Master volume to 0 and back). |

## Tools

| Action | Default key | Works | Description |
| --- | --- | --- | --- |
| Bulldozer | B | While building, except in the coaster designer | Arm the bulldozer. |
| Path tool | P | While building, except in the coaster designer | Arm the path tool. |
| Paint tool | C | While building, except in the coaster designer | Arm the paint tool: click or drag to recolour buildings (Shift paints every part). |
| Colour picker | I | While building, except in the coaster designer | Arm the paint tool in pick mode: click a building to copy its colours into the paint brush. |
| Land tool | L | While building, except in the coaster designer | Arm the land tool: click a parcel next to your land to buy it (estates only). |
| Rotate building | R | While building, except in the coaster designer | Rotate the selected building. |

## Coaster designer

| Action | Default key | Works | Description |
| --- | --- | --- | --- |
| Raise track height | R | Only while the coaster designer is open | Raise the height the next coaster pieces climb to. |
| Lower track height | F | Only while the coaster designer is open | Lower the height the next coaster pieces climb to. |
| Toggle chain lift | L | Only while the coaster designer is open | Switch the hill under the cursor (or the last one laid) between a chain lift and a free climb. |

## Fixed keys

These cannot be rebound.

| Keys | What | Where | Description |
| --- | --- | --- | --- |
| Esc | Back out | Everywhere | Closes the topmost layer and nothing else: a focused text field, Save / Load, Settings, the scenario result, the loadout, the leave-run question, the screens of The Map (a drawer first, then the offer and the loadout step back to the run map and the run map closes; the cleared-level and run-over screens are answered with their buttons), the menu panel, the clock popover, the management dashboard, the inspector, then disarms the tool. With nothing open it opens the pause menu. The recovery prompt only closes through its buttons, and a reward draft refuses Esc until a card is picked. Esc always gets you out, so it cannot be changed. |
| Ctrl+Z / Cmd+Z | Undo | While building | Undoes the last construction action. Modifier combinations belong to the browser and the OS, and undo needs context-dependent default handling, so it is fixed. |
| Ctrl+S / Cmd+S | Quick save | Everywhere | Saves the park (or opens Save / Load when every slot is taken). The browser Save Page dialog must never open over the game, so it is fixed. |
| Delete / Backspace | Demolish | With a ride or stall inspector open | Asks to demolish the ride or stall in the open inspector; Keep it has the focus, so a second key press cannot demolish by accident. Delete and Backspace belong to text fields, so they are fixed. |
| Arrow keys | Pan and menus | Park view, widgets | Always pan the camera in addition to the pan keys, and move between options inside menus, tabs and grids. |
| Tab / Shift+Tab | Move focus | Everywhere | Moves between buttons and fields. Reserved so the game can always be operated from the keyboard. |
| Enter / Space | Activate | Widgets | Presses the focused button or toggles the focused option. |
| Home / End | First and last | Widgets | Jump to the first or last tab, option or card in a widget. |
| Mouse and touch gestures | Construction gestures | Park view | Dragging to build paths and rides, click or drag (Shift for every part) with the paint tool, right-click to cancel and middle-drag to pan are pointer gestures. This is the documented exception to keyboard operation; the keyboard can arm tools, rotate, cancel and pan, and recolour a ride or stall from its inspector or a preset for the whole park from the paint panel. |

## Rebinding rules

- One key or none per action. Clear leaves an action without a key; Reset restores the default.
- Plain keys are allowed, with or without Shift: letters, digits, and the punctuation keys minus, equals, brackets, semicolon, quote, comma, period, slash, backslash and backquote. Camera keys cannot use Shift.
- Refused with a message: Esc, Tab, Enter, Space, Backspace, Delete, arrow keys, Home, End, Page Up/Down, F1 to F12, and anything with Ctrl, Cmd or Alt.
- Two actions cannot share a key when both can be active at once. The coaster designer reuses R and F because its keys replace the tool keys while it is open.

## Keyboard layouts

- A typed letter and a physical position only name the same key once the layout is known, so the conflict check for a new binding uses the key press that captured it (what it types and where it sits). A letter that types on a camera key position of your layout is refused, and a different letter on a Dvorak or AZERTY keyboard is not flagged just because it shares a QWERTY label.
- Letters are matched by the character on the keycap, so a rebound letter works on AZERTY, QWERTZ and Dvorak as printed.
- Digits and punctuation are matched by physical key position (`event.code`), so the speed keys work on AZERTY, where the unshifted digit row types symbols. The numpad digits work as the matching digit.
- Camera keys are matched by physical position on every layout, so the WASD cluster stays where the hand expects it.

## Mouse gestures

Construction gestures (drag to build, right-click to cancel, middle-drag to pan, wheel to zoom) are pointer-based by design. Everything else can be operated from the keyboard; the keyboard can arm tools, rotate, cancel and pan.
