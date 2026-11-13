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
