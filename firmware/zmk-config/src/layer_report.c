/*
 * Layer report for the Keyform notifier.
 *
 * Whenever the highest active layer changes, the keyboard briefly "presses" a reserved HID key code
 * (0xA5 + the layer's ID). Operating systems and games ignore these reserved codes, so nothing is
 * typed, but the Keyform notifier on the computer can read them from the keyboard's HID device and
 * show which layer is on. Layer IDs stay the same when layers are reordered in Keyform.
 *
 * SPDX-License-Identifier: MIT
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zmk/event_manager.h>
#include <zmk/events/layer_state_changed.h>
#include <zmk/events/keycode_state_changed.h>
#include <zmk/keymap.h>
#include <dt-bindings/zmk/hid_usage_pages.h>

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#define LAYER_REPORT_BASE 0xA5 // 0xA5-0xAF are reserved in the HID keyboard page
#define LAYER_REPORT_COUNT 11
#define LAYER_REPORT_TAP_MS 20

static int last_layer_id = -1;
static uint32_t held_usage = 0;

static void release_work_cb(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(release_work, release_work_cb);

static void release_held(void) {
    if (held_usage) {
        raise_zmk_keycode_state_changed_from_encoded(held_usage, false, k_uptime_get());
        held_usage = 0;
    }
}

static void release_work_cb(struct k_work *work) { release_held(); }

static void report_work_cb(struct k_work *work) {
    zmk_keymap_layer_id_t id = zmk_keymap_layer_index_to_id(zmk_keymap_highest_layer_active());
    if ((int)id == last_layer_id || id >= LAYER_REPORT_COUNT) {
        return;
    }
    last_layer_id = id;
    k_work_cancel_delayable(&release_work);
    release_held();
    held_usage = ZMK_HID_USAGE(HID_USAGE_KEY, (LAYER_REPORT_BASE + id));
    LOG_DBG("Layer report: layer id %d", id);
    raise_zmk_keycode_state_changed_from_encoded(held_usage, true, k_uptime_get());
    k_work_schedule(&release_work, K_MSEC(LAYER_REPORT_TAP_MS));
}

static K_WORK_DELAYABLE_DEFINE(report_work, report_work_cb);

static int layer_report_listener(const zmk_event_t *eh) {
    if (as_zmk_layer_state_changed(eh) != NULL) {
        // short delay so several layer changes at once give one report
        k_work_reschedule(&report_work, K_MSEC(5));
    }
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(keyform_layer_report, layer_report_listener);
ZMK_SUBSCRIPTION(keyform_layer_report, zmk_layer_state_changed);
