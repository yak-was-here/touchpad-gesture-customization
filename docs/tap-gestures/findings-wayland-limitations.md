# Why 3 & 4 Finger Tap Detection Cannot Be Implemented as a GNOME Extension on Wayland

**Date:** 2026-05-25.
**Test hardware:** Lenovo with SYNA8022:00 06CB:CE67 Synaptics touchpad,
GNOME Shell on Wayland.

## TL;DR

The plan's goal was a **single detection code path** that handles both
3-finger and 4-finger taps identically. Inside a GNOME Shell extension on
Wayland, that goal is unreachable: the two finger counts produce categorically
different (or no) observable events depending on the tap target, and the
event the extension would need for 4-finger taps over app windows never
exists at all. The plan in
[`tap-gestures-plan.md`](./tap-gestures-plan.md) is not implementable in its
current form. Four paths forward exist; only two preserve the unified-code
goal, and both leave the GNOME-extension boundary.

---

## 1. What was discovered

POC 1 attached two captured-event listeners to `global.stage` (matching the
existing extension's swipe/pinch trackers) and logged every touchpad-gesture
and button event for tap attempts in three target locations: the top panel,
a focused application window, and the bare desktop.

### 1.1 Observation matrix

| Gesture | Target | Event the extension sees |
|---|---|---|
| 3-finger swipe | App window | `TOUCHPAD_SWIPE BEGIN fingers=3` |
| 4-finger swipe | App window | `TOUCHPAD_SWIPE BEGIN fingers=4` |
| 3-finger tap | Top panel | `TOUCHPAD_HOLD BEGIN/END fingers=3` |
| 4-finger tap | Top panel | `TOUCHPAD_HOLD BEGIN/END fingers=4` |
| 3-finger tap | App window / desktop | `BUTTON_PRESS button=2` only — no HOLD |
| 4-finger tap | App window / desktop | **Nothing.** No HOLD, no button, zero. |

Swipes confirm the listener and its routing are correct; they reach the
extension in every target context for both finger counts. Taps do not.

### 1.2 Log evidence

Three deliberate 3-finger taps over an application window, followed by
4-finger tap attempts on the same window:

```
[TAP-POC-1] BUTTON_PRESS  button=2 device_type=TOUCHPAD ms_since_last_hold_end=86119
[TAP-POC-1] BUTTON_RELEASE button=2 device_type=TOUCHPAD ms_since_last_hold_end=86249
[TAP-POC-1] BUTTON_PRESS  button=2 device_type=TOUCHPAD ms_since_last_hold_end=86927
[TAP-POC-1] BUTTON_RELEASE button=2 device_type=TOUCHPAD ms_since_last_hold_end=87036
[TAP-POC-1] BUTTON_PRESS  button=2 device_type=TOUCHPAD ms_since_last_hold_end=88229
[TAP-POC-1] BUTTON_RELEASE button=2 device_type=TOUCHPAD ms_since_last_hold_end=88332
[TAP-POC-1] COUNTS over last 5000ms: hold=0 swipe=0 pinch=0 button_press=3 button_release=3
```

Two facts in this excerpt are decisive:

- `hold=0` for the entire 5-second window in which three 3-finger taps
  occurred. No `TOUCHPAD_HOLD` event of any kind reached the listener.
  3-finger taps surface **only** as synthesized `BTN_MIDDLE` button events.
- `ms_since_last_hold_end` of ~86 seconds — the `BTN_MIDDLE` events have no
  temporal relationship to any earlier `HOLD END`. The HOLD-based detection
  strategy the plan assumed is not happening.

For 4-finger taps in the same five-second window, every counter is zero.

### 1.3 The three underlying constraints

The observations above are explained by three nested constraints stacked
across the Linux input pipeline:

#### Constraint 1 — libinput discards 4-finger taps entirely

libinput's tap-to-click is a state machine that maps detected taps to button
events. The configuration interface (`tap-button-map`) has exactly two
values:

- `lrm` — 1=left, 2=right, 3=middle (default)
- `lmr` — 1=left, 2=middle, 3=right

**There is no entry for 4-finger.** When libinput classifies a 4-finger
contact as a tap, the result is mapped to nothing and dropped before any
event leaves libinput. No button is synthesized; no gesture event is emitted
in its place.

#### Constraint 2 — Mutter does not deliver HOLD events that libinput's tap-detector consumed

While libinput's tap-detection state machine is processing a candidate
multi-finger tap, the corresponding `TOUCHPAD_HOLD` gesture is not delivered
to Mutter as an independent event — the tap state has "claimed" those touch
points. The HOLD events we *do* see over the top panel happen because
Shell's own gesture handlers grab the touchpad gesture stream first, which
preempts libinput's tap-detection for that interaction. Over an application
window no such grab exists, and the HOLD is suppressed.

#### Constraint 3 — Wayland forbids cross-client event interception

Only the compositor (Mutter) may decide which events reach a focused client.
A separate process cannot intercept or drop input events bound for another
Wayland client. A GNOME extension lives inside `gnome-shell` and can
intercept events on `captured-event::touchpad` — but only events that
actually flow through Mutter's stage signal. Per constraints 1 and 2, that
excludes tap-derived 3- and 4-finger events over app windows.

Returning `EVENT_STOP` from a `captured-event` handler does block
panel-targeted button events, but does **not** reliably block events whose
target is a Wayland client surface.

---

## 2. How this blocks the unified-detection goal

The plan asks for one detection code path that classifies both 3-finger and
4-finger taps from a common signal. Inside an extension on Wayland, no such
signal exists. The two finger counts and the three target contexts produce
**six different combinations**, only one of which is uniform:

| | Top panel | App window | Desktop |
|---|---|---|---|
| 3-finger tap | `TOUCHPAD_HOLD` | `BUTTON_PRESS button=2` | `BUTTON_PRESS button=2` |
| 4-finger tap | `TOUCHPAD_HOLD` | *(no event)* | *(no event)* |

The consequences for a unified-code design:

1. **No shared input signal.** Any 3-finger detector must consume
   `BUTTON_PRESS` (the only signal that reaches the extension over windows
   and desktop). Any 4-finger detector that worked anywhere would have to
   consume `TOUCHPAD_HOLD` — which fires only over the top panel. The two
   detectors cannot share a code path because they cannot share an input.

2. **4-finger is unobservable on the primary target.** Over an app window
   or the desktop — i.e. anywhere a productivity tap gesture is actually
   useful — 4-finger taps produce no event the extension can see.
   Constraint 1 (libinput drops the tap) plus constraint 2 (no HOLD
   surfaces) leaves nothing to detect.

3. **Suppression of the 3-finger default is impossible.** Even the 3-finger
   half of the goal cannot meet the plan's acceptance criteria: constraint
   3 means the extension cannot keep `BTN_MIDDLE` from reaching the focused
   app. So a "3-finger tap → custom action" rule fires the action **and**
   middle-clicks in the app simultaneously — a UX regression, not a feature.

4. **Asymmetric, location-dependent behavior is the best an extension can
   achieve.** Implementing detection at all would mean: 3-finger works
   everywhere but always also middle-clicks; 4-finger works only on Shell
   chrome and silently does nothing elsewhere. That is the opposite of
   one-implementation-for-both.

### Plan acceptance criteria that cannot be met

- **AC 1** — 3-finger tap fires action **and does not produce middle-click
  in the focused application**: blocked by constraint 3.
- **AC 2** — 4-finger tap fires action exactly once: blocked by constraint
  1 (no event exists).
- **AC 4** — 4-finger NONE preserves existing behavior: trivially true only
  because there is no existing behavior; moot once AC 2 fails.

---

## 3. Possible solutions / ways forward

None of these are drop-in fixes within the existing extension. Each is a
project-shaping decision. They are evaluated below against two criteria:

- **U — Unified detection?** Does it preserve the goal of one code path for
  both finger counts in all target contexts?
- **E — Extension-only?** Does it ship as a normal GNOME extension via the
  GNOME Extensions Website?

### Option A — Drop 4-finger; ship 3-finger only

Implement 3-finger detection via `BUTTON_PRESS button=2` filtered by
`event.get_source_device().get_device_type() === TOUCHPAD_DEVICE`. Drop
4-finger entirely from the UI. Ship the 3-finger half as a partial feature,
accepting that `BTN_MIDDLE` will still fire in the focused app (constraint
3) — so the user's configured action plus a middle-click both happen.

- **U:** No. Abandons the unified-implementation goal and the 4-finger
  half of the feature.
- **E:** Yes.
- **Cost:** Small. Days of work.
- **Risk:** Concurrent middle-click is a real UX regression; many users
  will hate it. Effectively un-shippable as a default-on feature.

### Option B — Disable libinput tap-to-click and reimplement it in the extension

Turn off `tap-to-click` for the touchpad. With libinput's tap-detector out
of the picture, `TOUCHPAD_HOLD` events fire for all finger counts in all
target contexts. The extension then implements its own tap classifier on
top of HOLD events for 1, 2, 3, and 4 fingers — including everything
libinput currently handles (synthesized `BTN_LEFT`/`BTN_RIGHT`, tap-and-drag,
double-tap, palm rejection during typing).

- **U:** Yes. Symmetric detection across all finger counts and target
  contexts.
- **E:** Yes, but invasive — forces a system-wide setting change and
  replaces an interaction users rely on every minute.
- **Cost:** Large. 2–3× the original plan's scope; tap-and-drag alone is
  notoriously tricky to get right.
- **Risk:** High. Regressing 1- and 2-finger tap behavior is a daily-driver
  failure for most users. Coexistence with the GNOME touchpad settings
  panel is awkward — the panel will report tap-to-click as off even though
  the extension has secretly re-enabled it in software.

### Option C — Userspace daemon, libinput-gestures-style

Move tap detection out of the extension into a separate process that reads
libinput directly (via `libinput debug-events` parsing, `python-libinput`,
or `libei`). The daemon bypasses constraint 2 — it sees libinput's full
gesture stream regardless of what Mutter forwards. It still cannot bypass
constraint 1 (4-finger taps are dropped by libinput unless tap-to-click is
disabled), and it cannot bypass constraint 3 (no cross-client suppression),
so a workable design combines daemon-side detection with libinput
configuration:

1. Disable libinput tap-to-click for the touchpad device.
2. Daemon reads raw `TOUCHPAD_HOLD` events from libinput.
3. Daemon classifies short HOLDs by finger count as taps.
4. For 1/2-finger taps, daemon re-synthesizes `BTN_LEFT`/`BTN_RIGHT` via
   `uinput` to preserve normal tap-to-click.
5. For 3/4-finger taps, daemon fires the user's configured action via
   `ydotool`-style key injection.
6. Shell-API actions (`SHOW_OVERVIEW`, `SHOW_DESKTOP`, `NOTIFICATION_CENTER`)
   require a companion extension exposing them over D-Bus, since they live
   inside `gnome-shell`.

- **U:** Yes. Single detection path for all finger counts in all target
  contexts.
- **E:** No. Ships as a system service plus a small companion extension.
  Not hostable on the GNOME Extensions Website.
- **Cost:** Large. New project, install path, packaging story, security
  posture (`input` group, `/dev/uinput`), systemd unit.
- **Risk:** Medium. Proven precedent (libinput-gestures, fusuma). Main
  fragility is steps 1 and 4 — keeping the daemon's tap re-synthesis from
  diverging from libinput's behavior over time.

### Option D — Upstream the gap

File issues against libinput and Mutter:

- **libinput:** add a configuration knob for 4-finger tap-to-button mapping,
  symmetric to the existing 3-finger `tap-button-map`. Resolves
  constraint 1.
- **Mutter:** emit `TOUCHPAD_HOLD` events on `captured-event::touchpad`
  even when libinput's tap-detection claims them, so compositor-level
  consumers can observe taps. Resolves constraint 2.

If both land, the original plan becomes implementable as a normal
extension. Constraint 3 (Wayland suppression) is unaffected, but with
upstream changes in place, the extension would be detecting taps from
gesture events rather than from `BTN_MIDDLE`, so suppression of
`BTN_MIDDLE` is no longer needed — the original button never fires
because libinput's mapping is overridden.

- **U:** Yes (eventually).
- **E:** Yes (eventually).
- **Cost:** Small in code, large in calendar time. Multi-month upstream
  cycle plus a release-and-uptake delay before users actually have the
  versions.
- **Risk:** Upstream may reject either patch. Users on older
  libinput/Mutter never get the feature.

---

## 4. Recommendation

Pursue Option C (userspace daemon) as a separate project so users with
this hardware can have the feature in the near term, **and** file Option D
in parallel so that future versions of libinput and Mutter make a clean
extension-only implementation possible. When both upstream patches land,
the daemon can be retired in favor of an in-extension implementation.

In this repository, close issue #30 with a link to this document and the
new daemon project's tracker. The POC 1 logger and its wiring have already
been removed from the branch; the log evidence captured above is preserved
in this document.
