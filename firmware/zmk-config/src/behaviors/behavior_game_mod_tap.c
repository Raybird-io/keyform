/*
 * Game Mod-Tap: a mod-tap whose settings travel inside the key itself, so Keyform can tune
 * every key separately with no reflashing.
 *
 *   &gmt SETTINGS TAP_KEY
 *
 * Why it exists: ZMK's normal mod-tap sends the tap key's press and release about 1 ms apart.
 * Many games only look at the keyboard once per frame (every ~7-16 ms), so such a short tap
 * falls between two looks and never registers. Game Mod-Tap keeps the tap key down for
 * "tap length" ms, so games see it.
 *
 * SETTINGS (param1), packed as bits. Keyform builds and reads this for you.
 *   bits  0-7   hold key: keyboard key ID, usually a modifier (0xE0-0xE7, e.g. 0xE1 = Left Shift)
 *   bits  8-12  tap length in steps of 5 ms (0 = release straight away, like normal mod-tap)
 *   bits 13-19  hold delay (tapping term) in steps of 5 ms (0 = 200 ms)
 *   bits 20-21  hold rule: 0 hold-preferred, 1 balanced, 2 tap-preferred, 3 tap-unless-interrupted
 *   bit  22     instant hold: press the hold key right away while deciding (hold-while-undecided)
 *   bits 23-27  tap-then-hold repeat window (quick-tap) in steps of 10 ms (0 = off)
 *
 * Based on ZMK's behavior_hold_tap.c (MIT, The ZMK Contributors). The decision logic is the same;
 * the settings come from the key instead of the keymap, and the tap key is held for a minimum time.
 *
 * SPDX-License-Identifier: MIT
 */

#define DT_DRV_COMPAT zmk_behavior_game_mod_tap

#include <zephyr/device.h>
#include <drivers/behavior.h>
#include <zmk/keys.h>
#include <dt-bindings/zmk/keys.h>
#include <zephyr/logging/log.h>
#include <zmk/behavior.h>
#include <zmk/matrix.h>
#include <zmk/endpoints.h>
#include <zmk/event_manager.h>
#include <zmk/events/position_state_changed.h>
#include <zmk/events/keycode_state_changed.h>

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#if DT_HAS_COMPAT_STATUS_OKAY(DT_DRV_COMPAT)

#define GMT_MAX_HELD 10
#define GMT_MAX_CAPTURED_EVENTS 40
#define GMT_MAX_PENDING_RELEASES 8
#define GMT_POSITION_NOT_USED 9999

// ---- settings packed in param1 (keep in step with Keyform's app.js) ----
#define GMT_SETTINGS_MAX ((1 << 28) - 1)
#define GMT_HOLD_KEY(p) ((p) & 0xFF)
#define GMT_TAP_MS(p) ((((p) >> 8) & 0x1F) * 5)
#define GMT_TERM_MS(p) ((((p) >> 13) & 0x7F) * 5)
#define GMT_FLAVOR(p) (((p) >> 20) & 0x3)
#define GMT_INSTANT(p) (((p) >> 22) & 0x1)
#define GMT_QUICK_MS(p) ((((p) >> 23) & 0x1F) * 10)

enum flavor {
    FLAVOR_HOLD_PREFERRED,
    FLAVOR_BALANCED,
    FLAVOR_TAP_PREFERRED,
    FLAVOR_TAP_UNLESS_INTERRUPTED,
};

enum status {
    STATUS_UNDECIDED,
    STATUS_TAP,
    STATUS_HOLD_INTERRUPT,
    STATUS_HOLD_TIMER,
};

enum decision_moment {
    HT_KEY_DOWN,
    HT_KEY_UP,
    HT_OTHER_KEY_DOWN,
    HT_OTHER_KEY_UP,
    HT_TIMER_EVENT,
    HT_QUICK_TAP,
};

struct gmt_settings {
    uint32_t hold_usage;
    int tap_ms;
    int tapping_term_ms;
    int quick_tap_ms;
    enum flavor flavor;
    bool hold_while_undecided;
};

struct active_gmt {
    int32_t position;
    uint32_t param_tap;
    int64_t timestamp;
    int64_t tap_down_at;
    enum status status;
    struct gmt_settings config;
    struct k_work_delayable work;
    bool work_is_cancelled;
};

// A tap key waiting to be released once it has been down for its tap length
struct pending_release {
    bool used;
    uint32_t usage;
    struct k_work_delayable work;
};

static struct active_gmt *undecided_gmt = NULL;
static struct active_gmt active_gmts[GMT_MAX_HELD] = {};
static struct pending_release pending[GMT_MAX_PENDING_RELEASES] = {};

enum captured_event_tag {
    ET_NONE,
    ET_POS_CHANGED,
    ET_CODE_CHANGED,
};

union captured_event_data {
    struct zmk_position_state_changed_event position;
    struct zmk_keycode_state_changed_event keycode;
};

struct captured_event {
    enum captured_event_tag tag;
    union captured_event_data data;
};

static struct captured_event captured_events[GMT_MAX_CAPTURED_EVENTS] = {};

struct last_tapped {
    int32_t position;
    int64_t timestamp;
};
static struct last_tapped last_tapped = {INT32_MIN, INT32_MIN};

static void decode_settings(uint32_t p, struct gmt_settings *s) {
    uint32_t hold = GMT_HOLD_KEY(p);
    if (hold < 0x04) {
        hold = 0xE1; // no valid hold key: Left Shift
    }
    s->hold_usage = ZMK_HID_USAGE(HID_USAGE_KEY, hold);
    s->tap_ms = GMT_TAP_MS(p);
    s->tapping_term_ms = GMT_TERM_MS(p) != 0 ? GMT_TERM_MS(p) : 200;
    s->quick_tap_ms = GMT_QUICK_MS(p);
    s->flavor = (enum flavor)GMT_FLAVOR(p);
    s->hold_while_undecided = GMT_INSTANT(p);
}

static void store_last_tapped(int64_t timestamp) {
    if (timestamp > last_tapped.timestamp) {
        last_tapped.position = INT32_MIN;
        last_tapped.timestamp = timestamp;
    }
}

static void store_last_gmt_tapped(struct active_gmt *g) {
    last_tapped.position = g->position;
    last_tapped.timestamp = g->timestamp;
}

static bool is_quick_tap(struct active_gmt *g) {
    return g->config.quick_tap_ms > 0 && last_tapped.position == g->position &&
           (last_tapped.timestamp + g->config.quick_tap_ms) > g->timestamp;
}

static int capture_event(struct captured_event *data) {
    for (int i = 0; i < GMT_MAX_CAPTURED_EVENTS; i++) {
        if (captured_events[i].tag == ET_NONE) {
            captured_events[i] = *data;
            return 0;
        }
    }
    return -ENOMEM;
}

static bool have_captured_keydown_event(uint32_t position) {
    for (int i = 0; i < GMT_MAX_CAPTURED_EVENTS; i++) {
        struct captured_event *ev = &captured_events[i];
        if (ev->tag == ET_NONE) {
            return false;
        }
        if (ev->tag != ET_POS_CHANGED) {
            continue;
        }
        if (ev->data.position.data.position == position && ev->data.position.data.state) {
            return true;
        }
    }
    return false;
}

const struct zmk_listener zmk_listener_behavior_game_mod_tap;

// Same trick as ZMK's hold-tap: see the comment in behavior_hold_tap.c
static void release_captured_events() {
    if (undecided_gmt != NULL) {
        return;
    }
    for (int i = 0; i < GMT_MAX_CAPTURED_EVENTS; i++) {
        struct captured_event *captured_event = &captured_events[i];
        enum captured_event_tag tag = captured_event->tag;
        if (tag == ET_NONE) {
            return;
        }
        captured_events[i].tag = ET_NONE;
        if (undecided_gmt != NULL) {
            k_msleep(10);
        }
        switch (tag) {
        case ET_CODE_CHANGED:
            ZMK_EVENT_RAISE_AT(captured_event->data.keycode, behavior_game_mod_tap);
            break;
        case ET_POS_CHANGED:
            ZMK_EVENT_RAISE_AT(captured_event->data.position, behavior_game_mod_tap);
            break;
        default:
            break;
        }
    }
}

static struct active_gmt *find_gmt(uint32_t position) {
    for (int i = 0; i < GMT_MAX_HELD; i++) {
        if (active_gmts[i].position == position) {
            return &active_gmts[i];
        }
    }
    return NULL;
}

static struct active_gmt *store_gmt(struct zmk_behavior_binding_event *event, uint32_t settings,
                                    uint32_t param_tap) {
    for (int i = 0; i < GMT_MAX_HELD; i++) {
        struct active_gmt *g = &active_gmts[i];
        if (g->position != GMT_POSITION_NOT_USED) {
            continue;
        }
        g->position = event->position;
        g->status = STATUS_UNDECIDED;
        decode_settings(settings, &g->config);
        g->param_tap = param_tap;
        g->timestamp = event->timestamp;
        g->tap_down_at = 0;
        return g;
    }
    return NULL;
}

static void clear_gmt(struct active_gmt *g) {
    g->position = GMT_POSITION_NOT_USED;
    g->status = STATUS_UNDECIDED;
    g->work_is_cancelled = false;
}

static void decide_balanced(struct active_gmt *g, enum decision_moment event) {
    switch (event) {
    case HT_KEY_UP:
    case HT_QUICK_TAP:
        g->status = STATUS_TAP;
        return;
    case HT_OTHER_KEY_UP:
        g->status = STATUS_HOLD_INTERRUPT;
        return;
    case HT_TIMER_EVENT:
        g->status = STATUS_HOLD_TIMER;
        return;
    default:
        return;
    }
}

static void decide_tap_preferred(struct active_gmt *g, enum decision_moment event) {
    switch (event) {
    case HT_KEY_UP:
    case HT_QUICK_TAP:
        g->status = STATUS_TAP;
        return;
    case HT_TIMER_EVENT:
        g->status = STATUS_HOLD_TIMER;
        return;
    default:
        return;
    }
}

static void decide_tap_unless_interrupted(struct active_gmt *g, enum decision_moment event) {
    switch (event) {
    case HT_KEY_UP:
    case HT_TIMER_EVENT:
    case HT_QUICK_TAP:
        g->status = STATUS_TAP;
        return;
    case HT_OTHER_KEY_DOWN:
        g->status = STATUS_HOLD_INTERRUPT;
        return;
    default:
        return;
    }
}

static void decide_hold_preferred(struct active_gmt *g, enum decision_moment event) {
    switch (event) {
    case HT_KEY_UP:
    case HT_QUICK_TAP:
        g->status = STATUS_TAP;
        return;
    case HT_OTHER_KEY_DOWN:
        g->status = STATUS_HOLD_INTERRUPT;
        return;
    case HT_TIMER_EVENT:
        g->status = STATUS_HOLD_TIMER;
        return;
    default:
        return;
    }
}

// ---- sending keys ----

static int send(uint32_t usage, bool pressed, int64_t timestamp) {
    return raise_zmk_keycode_state_changed_from_encoded(usage, pressed, timestamp);
}

static void pending_release_handler(struct k_work *item) {
    struct k_work_delayable *d_work = k_work_delayable_from_work(item);
    struct pending_release *p = CONTAINER_OF(d_work, struct pending_release, work);
    if (!p->used) {
        return;
    }
    p->used = false;
    send(p->usage, false, k_uptime_get());
}

// If this key is still waiting for its delayed release, release it now (before it is pressed again)
static void flush_pending(uint32_t usage) {
    for (int i = 0; i < GMT_MAX_PENDING_RELEASES; i++) {
        struct pending_release *p = &pending[i];
        if (p->used && p->usage == usage) {
            k_work_cancel_delayable(&p->work);
            p->used = false;
            send(usage, false, k_uptime_get());
        }
    }
}

static void release_tap_later(uint32_t usage, int64_t release_at) {
    int32_t ms_left = (int32_t)(release_at - k_uptime_get());
    if (ms_left <= 0) {
        send(usage, false, k_uptime_get());
        return;
    }
    for (int i = 0; i < GMT_MAX_PENDING_RELEASES; i++) {
        struct pending_release *p = &pending[i];
        if (!p->used) {
            p->used = true;
            p->usage = usage;
            k_work_schedule(&p->work, K_MSEC(ms_left));
            return;
        }
    }
    // no free slot (more than 8 taps within one tap length): release now rather than get stuck
    send(usage, false, k_uptime_get());
}

static int press_hold_binding(struct active_gmt *g) {
    return send(g->config.hold_usage, true, g->timestamp);
}

static int release_hold_binding(struct active_gmt *g) {
    return send(g->config.hold_usage, false, g->timestamp);
}

static int press_tap_binding(struct active_gmt *g) {
    flush_pending(g->param_tap);
    store_last_gmt_tapped(g);
    g->tap_down_at = k_uptime_get();
    // same timestamp as the key-down, so the repeat window remembers this key (as in hold-tap)
    return send(g->param_tap, true, g->timestamp);
}

static int release_tap_binding(struct active_gmt *g) {
    release_tap_later(g->param_tap, g->tap_down_at + g->config.tap_ms);
    return 0;
}

static int press_binding(struct active_gmt *g) {
    if (g->status == STATUS_HOLD_TIMER || g->status == STATUS_HOLD_INTERRUPT) {
        if (g->config.hold_while_undecided) {
            return 0; // already held
        }
        return press_hold_binding(g);
    }
    if (g->config.hold_while_undecided) {
        release_hold_binding(g); // let go of the hold before the tap
    }
    return press_tap_binding(g);
}

static int release_binding(struct active_gmt *g) {
    if (g->status == STATUS_HOLD_TIMER || g->status == STATUS_HOLD_INTERRUPT) {
        return release_hold_binding(g);
    }
    return release_tap_binding(g);
}

static void decide_gmt(struct active_gmt *g, enum decision_moment decision_moment) {
    if (g->status != STATUS_UNDECIDED) {
        return;
    }
    if (g != undecided_gmt) {
        return;
    }
    if (g->config.hold_while_undecided && decision_moment == HT_KEY_DOWN) {
        press_hold_binding(g);
        return;
    }
    switch (g->config.flavor) {
    case FLAVOR_HOLD_PREFERRED:
        decide_hold_preferred(g, decision_moment);
        break;
    case FLAVOR_BALANCED:
        decide_balanced(g, decision_moment);
        break;
    case FLAVOR_TAP_PREFERRED:
        decide_tap_preferred(g, decision_moment);
        break;
    case FLAVOR_TAP_UNLESS_INTERRUPTED:
        decide_tap_unless_interrupted(g, decision_moment);
        break;
    }
    if (g->status == STATUS_UNDECIDED) {
        return;
    }
    LOG_DBG("%d game mod-tap decided %d (moment %d)", g->position, g->status, decision_moment);
    undecided_gmt = NULL;
    press_binding(g);
    release_captured_events();
}

static int on_gmt_binding_pressed(struct zmk_behavior_binding *binding,
                                  struct zmk_behavior_binding_event event) {
    if (undecided_gmt != NULL) {
        LOG_DBG("another game mod-tap is undecided");
        return ZMK_BEHAVIOR_OPAQUE;
    }
    struct active_gmt *g = store_gmt(&event, binding->param1, binding->param2);
    if (g == NULL) {
        LOG_ERR("game mod-tap: more than %d held at once", GMT_MAX_HELD);
        return ZMK_BEHAVIOR_OPAQUE;
    }
    undecided_gmt = g;
    if (is_quick_tap(g)) {
        decide_gmt(g, HT_QUICK_TAP);
    }
    decide_gmt(g, HT_KEY_DOWN);

    int32_t term_left = (g->timestamp + g->config.tapping_term_ms) - k_uptime_get();
    k_work_schedule(&g->work, K_MSEC(term_left));
    return ZMK_BEHAVIOR_OPAQUE;
}

static int on_gmt_binding_released(struct zmk_behavior_binding *binding,
                                   struct zmk_behavior_binding_event event) {
    struct active_gmt *g = find_gmt(event.position);
    if (g == NULL) {
        LOG_ERR("game mod-tap cleaned up too early");
        return ZMK_BEHAVIOR_OPAQUE;
    }
    int work_cancel_result = k_work_cancel_delayable(&g->work);
    if (event.timestamp > (g->timestamp + g->config.tapping_term_ms)) {
        decide_gmt(g, HT_TIMER_EVENT);
    }
    decide_gmt(g, HT_KEY_UP);
    release_binding(g);

    if (work_cancel_result == -EINPROGRESS) {
        g->work_is_cancelled = true; // the timer handler cleans up
    } else {
        clear_gmt(g);
    }
    return ZMK_BEHAVIOR_OPAQUE;
}

#if IS_ENABLED(CONFIG_ZMK_BEHAVIOR_METADATA)
static const struct behavior_parameter_value_metadata settings_values[] = {
    {.display_name = "Settings",
     .type = BEHAVIOR_PARAMETER_VALUE_TYPE_RANGE,
     .range = {.min = 0, .max = GMT_SETTINGS_MAX}},
};
static const struct behavior_parameter_value_metadata tap_values[] = {
    {.display_name = "Tap", .type = BEHAVIOR_PARAMETER_VALUE_TYPE_HID_USAGE},
};
static const struct behavior_parameter_metadata_set metadata_sets[] = {{
    .param1_values = settings_values,
    .param1_values_len = ARRAY_SIZE(settings_values),
    .param2_values = tap_values,
    .param2_values_len = ARRAY_SIZE(tap_values),
}};
static const struct behavior_parameter_metadata metadata = {
    .sets_len = ARRAY_SIZE(metadata_sets),
    .sets = metadata_sets,
};
#endif

static const struct behavior_driver_api behavior_gmt_driver_api = {
    .binding_pressed = on_gmt_binding_pressed,
    .binding_released = on_gmt_binding_released,
#if IS_ENABLED(CONFIG_ZMK_BEHAVIOR_METADATA)
    .parameter_metadata = &metadata,
#endif
};

static int position_state_changed_listener(const zmk_event_t *eh) {
    struct zmk_position_state_changed *ev = as_zmk_position_state_changed(eh);
    if (undecided_gmt == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (undecided_gmt->position == ev->position) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (ev->timestamp > (undecided_gmt->timestamp + undecided_gmt->config.tapping_term_ms)) {
        decide_gmt(undecided_gmt, HT_TIMER_EVENT);
    }
    if (undecided_gmt == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (!ev->state && !have_captured_keydown_event(ev->position)) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    struct captured_event capture = {
        .tag = ET_POS_CHANGED,
        .data = {.position = copy_raised_zmk_position_state_changed(ev)},
    };
    capture_event(&capture);
    decide_gmt(undecided_gmt, ev->state ? HT_OTHER_KEY_DOWN : HT_OTHER_KEY_UP);
    return ZMK_EV_EVENT_CAPTURED;
}

static int keycode_state_changed_listener(const zmk_event_t *eh) {
    struct zmk_keycode_state_changed *ev = as_zmk_keycode_state_changed(eh);

    if (ev->state) {
        // another key pressing a tap key that is still waiting to be released: release it first
        flush_pending(ZMK_HID_USAGE(ev->usage_page, ev->keycode));
    }
    if (ev->state && !is_mod(ev->usage_page, ev->keycode)) {
        store_last_tapped(ev->timestamp);
    }
    if (undecided_gmt == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (!is_mod(ev->usage_page, ev->keycode)) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (undecided_gmt->config.hold_while_undecided && undecided_gmt->status == STATUS_UNDECIDED) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    struct captured_event capture = {
        .tag = ET_CODE_CHANGED, .data = {.keycode = copy_raised_zmk_keycode_state_changed(ev)}};
    capture_event(&capture);
    return ZMK_EV_EVENT_CAPTURED;
}

static int behavior_gmt_listener(const zmk_event_t *eh) {
    if (as_zmk_position_state_changed(eh) != NULL) {
        return position_state_changed_listener(eh);
    } else if (as_zmk_keycode_state_changed(eh) != NULL) {
        return keycode_state_changed_listener(eh);
    }
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(behavior_game_mod_tap, behavior_gmt_listener);
ZMK_SUBSCRIPTION(behavior_game_mod_tap, zmk_position_state_changed);
ZMK_SUBSCRIPTION(behavior_game_mod_tap, zmk_keycode_state_changed);

static void gmt_timer_work_handler(struct k_work *item) {
    struct k_work_delayable *d_work = k_work_delayable_from_work(item);
    struct active_gmt *g = CONTAINER_OF(d_work, struct active_gmt, work);
    if (g->work_is_cancelled) {
        clear_gmt(g);
    } else {
        decide_gmt(g, HT_TIMER_EVENT);
    }
}

static int behavior_gmt_init(const struct device *dev) {
    static bool init_first_run = true;
    if (init_first_run) {
        for (int i = 0; i < GMT_MAX_HELD; i++) {
            k_work_init_delayable(&active_gmts[i].work, gmt_timer_work_handler);
            active_gmts[i].position = GMT_POSITION_NOT_USED;
        }
        for (int i = 0; i < GMT_MAX_PENDING_RELEASES; i++) {
            k_work_init_delayable(&pending[i].work, pending_release_handler);
            pending[i].used = false;
        }
    }
    init_first_run = false;
    return 0;
}

#define GMT_INST(n)                                                                                \
    BEHAVIOR_DT_INST_DEFINE(n, behavior_gmt_init, NULL, NULL, NULL, POST_KERNEL,                   \
                            CONFIG_KERNEL_INIT_PRIORITY_DEFAULT, &behavior_gmt_driver_api);

DT_INST_FOREACH_STATUS_OKAY(GMT_INST)

#endif
