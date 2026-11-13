# Third-party software

`keyform.html` includes these open-source libraries, bundled into the file:

| Library | Version | License | Used for |
|---|---|---|---|
| [@zmkfirmware/zmk-studio-ts-client](https://github.com/zmkfirmware/zmk-studio-ts-client) | 0.0.18 | MIT | Talking to ZMK Studio keyboards |
| [protobufjs](https://github.com/protobufjs/protobuf.js) | 7.x | BSD-3-Clause | Encoding the messages the keyboard understands |
| [async-mutex](https://github.com/DirtyHairy/async-mutex) | 0.5.0 | MIT | Sending one message at a time |

The firmware in `firmware/` is built from [ZMK](https://github.com/zmkfirmware/zmk) (MIT)
using Boardsource's [Rechteck board files](https://github.com/boardsource/Rechtek-zmk-config).
