/*
 * Double Tap: a tap-dance whose two keys are parameters instead of fixed bindings.
 *   &dbl Q KP_N1   -> single tap sends Q, double tap sends Keypad 1
 * Because the keys are parameters, ZMK Studio (and Keyform) can set them per key.
 * Based on ZMK's behavior_tap_dance.c (MIT, The ZMK Contributors).
 *
 * SPDX-License-Identifier: MIT
 */

#define DT_DRV_COMPAT zmk_behavior_double_tap

#include <zephyr/device.h>
#include <drivers/behavior.h>
#include <zephyr/logging/log.h>
#include <zmk/behavior.h>
#include <zmk/event_manager.h>
#include <zmk/events/position_state_changed.h>
#include <zmk/events/keycode_state_changed.h>

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#if DT_HAS_COMPAT_STATUS_OKAY(DT_DRV_COMPAT)

#define MAX_HELD 10
#define POSITION_FREE UINT32_MAX

struct behavior_double_tap_config {
    uint32_t tapping_term_ms;
};

struct active_double_tap {
    int counter; // 1 = single tap, 2 = double tap
    uint32_t position;
    uint32_t tap_key;
    uint32_t double_key;
    bool is_pressed;
    const struct behavior_double_tap_config *config;

    bool timer_cancelled;
    bool decided;
    int64_t release_at;
    struct k_work_delayable release_timer;
};

static struct active_double_tap active_taps[MAX_HELD] = {};

static struct active_double_tap *find_tap(uint32_t position) {
    for (int i = 0; i < MAX_HELD; i++) {
        if (active_taps[i].position == position && !active_taps[i].timer_cancelled) {
            return &active_taps[i];
        }
    }
    return NULL;
}

static struct active_double_tap *new_tap(struct zmk_behavior_binding *binding,
                                         struct zmk_behavior_binding_event *event,
                                         const struct behavior_double_tap_config *config) {
    for (int i = 0; i < MAX_HELD; i++) {
        struct active_double_tap *t = &active_taps[i];
        if (t->position == POSITION_FREE) {
            t->counter = 0;
            t->position = event->position;
            t->tap_key = binding->param1;
            t->double_key = binding->param2;
            t->config = config;
            t->release_at = 0;
            t->is_pressed = true;
            t->timer_cancelled = false;
            t->decided = false;
            return t;
        }
    }
    return NULL;
}

static void clear_tap(struct active_double_tap *t) { t->position = POSITION_FREE; }

static void stop_timer(struct active_double_tap *t) {
    if (k_work_cancel_delayable(&t->release_timer) == -EINPROGRESS) {
        // too late to cancel, the timer handler will clean up
        t->timer_cancelled = true;
    }
}

static void reset_timer(struct active_double_tap *t, int64_t timestamp) {
    t->release_at = timestamp + t->config->tapping_term_ms;
    int32_t ms_left = t->release_at - k_uptime_get();
    if (ms_left > 0) {
        k_work_schedule(&t->release_timer, K_MSEC(ms_left));
    }
}

static inline uint32_t chosen_key(struct active_double_tap *t) {
    return t->counter >= 2 ? t->double_key : t->tap_key;
}

static int press_key(struct active_double_tap *t, int64_t timestamp) {
    t->decided = true;
    return raise_zmk_keycode_state_changed_from_encoded(chosen_key(t), true, timestamp);
}

static int release_key(struct active_double_tap *t, int64_t timestamp) {
    uint32_t key = chosen_key(t);
    clear_tap(t);
    return raise_zmk_keycode_state_changed_from_encoded(key, false, timestamp);
}

static int on_double_tap_binding_pressed(struct zmk_behavior_binding *binding,
                                         struct zmk_behavior_binding_event event) {
    const struct device *dev = zmk_behavior_get_binding(binding->behavior_dev);
    const struct behavior_double_tap_config *cfg = dev->config;
    struct active_double_tap *t = find_tap(event.position);
    if (t == NULL) {
        t = new_tap(binding, &event, cfg);
        if (t == NULL) {
            LOG_ERR("Double tap: too many keys held at once");
            return ZMK_BEHAVIOR_OPAQUE;
        }
    }
    t->is_pressed = true;
    stop_timer(t);
    if (t->counter < 2) {
        t->counter++;
    }
    if (t->counter == 2) {
        // second tap: decided straight away
        press_key(t, event.timestamp);
        return ZMK_EV_EVENT_BUBBLE;
    }
    reset_timer(t, event.timestamp);
    return ZMK_BEHAVIOR_OPAQUE;
}

static int on_double_tap_binding_released(struct zmk_behavior_binding *binding,
                                          struct zmk_behavior_binding_event event) {
    struct active_double_tap *t = find_tap(event.position);
    if (t == NULL) {
        return ZMK_BEHAVIOR_OPAQUE;
    }
    t->is_pressed = false;
    if (t->decided) {
        release_key(t, event.timestamp);
    }
    return ZMK_BEHAVIOR_OPAQUE;
}

static void double_tap_timer_handler(struct k_work *item) {
    struct k_work_delayable *d_work = k_work_delayable_from_work(item);
    struct active_double_tap *t = CONTAINER_OF(d_work, struct active_double_tap, release_timer);
    if (t->position == POSITION_FREE || t->timer_cancelled) {
        return;
    }
    // no second tap in time: it's a single tap (held keys stay held until released)
    press_key(t, t->release_at);
    if (!t->is_pressed) {
        release_key(t, t->release_at);
    }
}

#if IS_ENABLED(CONFIG_ZMK_BEHAVIOR_METADATA)
static const struct behavior_parameter_value_metadata tap_values[] = {
    {.display_name = "Tap", .type = BEHAVIOR_PARAMETER_VALUE_TYPE_HID_USAGE},
};
static const struct behavior_parameter_value_metadata double_values[] = {
    {.display_name = "Double tap", .type = BEHAVIOR_PARAMETER_VALUE_TYPE_HID_USAGE},
};
static const struct behavior_parameter_metadata_set metadata_sets[] = {{
    .param1_values = tap_values,
    .param1_values_len = ARRAY_SIZE(tap_values),
    .param2_values = double_values,
    .param2_values_len = ARRAY_SIZE(double_values),
}};
static const struct behavior_parameter_metadata metadata = {
    .sets_len = ARRAY_SIZE(metadata_sets),
    .sets = metadata_sets,
};
#endif

static const struct behavior_driver_api behavior_double_tap_driver_api = {
    .binding_pressed = on_double_tap_binding_pressed,
    .binding_released = on_double_tap_binding_released,
#if IS_ENABLED(CONFIG_ZMK_BEHAVIOR_METADATA)
    .parameter_metadata = &metadata,
#endif
};

// Pressing any other key settles a waiting double tap as a single tap right away
static int double_tap_position_listener(const zmk_event_t *eh);
ZMK_LISTENER(behavior_double_tap, double_tap_position_listener);
ZMK_SUBSCRIPTION(behavior_double_tap, zmk_position_state_changed);

static int double_tap_position_listener(const zmk_event_t *eh) {
    struct zmk_position_state_changed *ev = as_zmk_position_state_changed(eh);
    if (ev == NULL || !ev->state) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    for (int i = 0; i < MAX_HELD; i++) {
        struct active_double_tap *t = &active_taps[i];
        if (t->position == POSITION_FREE || t->position == ev->position) {
            continue;
        }
        stop_timer(t);
        if (!t->decided) {
            press_key(t, ev->timestamp);
            if (!t->is_pressed) {
                release_key(t, ev->timestamp);
            }
            return ZMK_EV_EVENT_BUBBLE;
        }
    }
    return ZMK_EV_EVENT_BUBBLE;
}

static int behavior_double_tap_init(const struct device *dev) {
    static bool first_run = true;
    if (first_run) {
        for (int i = 0; i < MAX_HELD; i++) {
            k_work_init_delayable(&active_taps[i].release_timer, double_tap_timer_handler);
            clear_tap(&active_taps[i]);
        }
    }
    first_run = false;
    return 0;
}

#define DBL_INST(n)                                                                                \
    static const struct behavior_double_tap_config behavior_double_tap_config_##n = {              \
        .tapping_term_ms = DT_INST_PROP(n, tapping_term_ms),                                       \
    };                                                                                             \
    BEHAVIOR_DT_INST_DEFINE(n, behavior_double_tap_init, NULL, NULL,                               \
                            &behavior_double_tap_config_##n, POST_KERNEL,                          \
                            CONFIG_KERNEL_INIT_PRIORITY_DEFAULT, &behavior_double_tap_driver_api);

DT_INST_FOREACH_STATUS_OKAY(DBL_INST)

#endif
