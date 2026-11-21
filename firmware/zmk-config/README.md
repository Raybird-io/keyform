# Rechteck (Boardsource bs_lp_60) ZMK config with ZMK Studio

This folder is a backup. To build firmware, copy its contents (including the
hidden `.github` folder) into its own GitHub repository. GitHub only runs the
build from the root of a repository.


- `config/west.yml` - which ZMK version (v0.3) and Boardsource's board files to use
- `config/bs_lp_60.keymap` - the layers and keys (incl. 6 reserved layers for Studio)
- `config/bs_lp_60.conf` - settings: Studio on, unlock key off
- `config/bs_lp_60.overlay` - physical key positions so Studio can draw the board
- `build.yaml` - tells GitHub to build with the Studio USB snippet

To build: put this folder in a GitHub repo, push, then open the Actions tab
and download the `firmware` artifact (contains the .uf2).

To add more Studio layers: copy one `extra_layer_N { ... };` block in the
keymap, give it a new number, push, and flash the new .uf2.

Double Tap add-on: `zephyr/module.yml`, `CMakeLists.txt`, `Kconfig`, `dts/` and `src/` make this
repo a small ZMK module that adds a "Double Tap" behavior with two keys as parameters
(single tap, double tap). They are set per key in Keyform (Advanced -> Double Tap), so new pairs
need no reflashing. The Double Tap nodes at the top of the keymap are the speeds, 150-300 ms in steps of 5
(one node per speed, because ZMK Studio can't send a timing). Keyform shows them as one slider. Keep the node names as they are:
saved keys refer to them by name.

Game Mod-Tap add-on: `src/behaviors/behavior_game_mod_tap.c` adds a "Game Mod-Tap" behavior
(the `gmt` node at the top of the keymap). It works like ZMK's mod-tap, but keeps the tap key down
for a set time so games that check keys once per frame register the tap. All of its settings
(hold key, tap length, hold delay, hold rule, instant hold, repeat window) are packed into the key's
first parameter, so Keyform sets them per key with no reflashing. The bit layout is described at the
top of the .c file.

Layer report: `src/layer_report.c` makes the keyboard briefly send a reserved HID key code
(0xA5 + layer ID) whenever the active layer changes. Computers ignore these codes; the Keyform
notifier (`linux/notifier/` in the Keyform repo) reads them to show layer notifications.
Turn it off with `CONFIG_KEYFORM_LAYER_REPORT=n` in `config/bs_lp_60.conf`.
