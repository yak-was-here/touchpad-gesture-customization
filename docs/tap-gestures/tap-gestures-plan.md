# Plan: 3 & 4 Finger Tap Gesture Support

Closes: https://github.com/HieuTNg/touchpad-gesture-customization/issues/30

---

## Feature Overview

Adds configurable 3-finger and 4-finger tap gestures. A "tap" = fingers touch the
touchpad briefly and lift without movement. Users independently assign an action to
each finger count. Defaults to NONE (disabled) so existing users are unaffected.

---

## GNOME Version Compatibility & Branch Strategy

The upstream repo maintains two active branches targeting different GNOME version
ranges:

| Branch | GNOME versions | Latest release |
|---|---|---|
| `48` | 45, 46, 47, 48 | 48.8.0 |
| `main` | 49, 50 | 50.0.0 |

**Two separate PRs are required** — one against each branch. Ideally, if possible, the implementation code should be **identical in both PRs**. The only differences between the two PRs are which base branch they target.

---

## Actions to Support

### Keyboard shortcut actions

| `TapGestureType` | Keys |
|---|---|
| `CLOSE_WINDOW` | Alt+F4 |
| `CLOSE_TAB` | Ctrl+W |
| `PLAY_PAUSE` | XF86AudioPlay (`Clutter.KEY_AudioPlay`) |
| `NEXT_TRACK` | XF86AudioNext (`Clutter.KEY_AudioNext`) |
| `PREV_TRACK` | XF86AudioPrev (`Clutter.KEY_AudioPrev`) |
| `MUTE` | XF86AudioMute (`Clutter.KEY_AudioMute`) |
| `SCREENSHOT` | Print (`Clutter.KEY_Print`) |

### GNOME Shell API actions

| `TapGestureType` | Implementation |
|---|---|
| `SHOW_OVERVIEW` | `Main.overview.visible ? Main.overview.hide() : Main.overview.show()` |
| `SHOW_DESKTOP` | Minimize all visible windows on current workspace; unminimize all if already all minimized |
| `NOTIFICATION_CENTER` | `Main.panel.toggleCalendar()` |

---

## Challenges

Three unknowns need to be proven before the rest of the plan can be built.
Each is gated by its own proof-of-concept; later POCs only make sense if
earlier ones succeed. All three need to work whether the tap target is a
GNOME taskbar, the desktop, or an application window.

### POC 1 — Tap detection

Can we observe 3- and 4-finger taps from inside a GNOME extension, in every
tap-target context, with enough fidelity (finger count + duration) to
distinguish a tap from a hold, a swipe, or a pinch?

- Listen to the event streams already used by the existing swipe/pinch
  trackers (`captured-event::touchpad` on `global.stage`) plus any others
  that surface tap-shaped events.
- Confirm the same events arrive over the top panel, the desktop, and a
  focused application window.
- Record duration, finger count, and the ordering of any related events
  (e.g. `HOLD CANCEL` preceding `SWIPE BEGIN`) so the production detector
  can be tuned.

### POC 2 — Suppression of default behavior

Can we prevent libinput's default 3-finger-tap `BTN_MIDDLE` (and any other
default action for 4-finger taps) from reaching the focused application
**when** the user has configured a non-NONE action, while leaving it
untouched when the action is NONE?

- Identify where in the event pipeline the synthetic button events surface.
- Confirm whether returning `EVENT_STOP` from a `captured-event` handler
  actually drops the button before the focused client sees it, across all
  three target contexts.
- Confirm the suppression is correctly scoped (only fires for taps from a
  touchpad device, never for real middle-clicks from a mouse).

### POC 3 — Action dispatch

Can we reliably fire each action in the supported list — both the
key-injection actions and the Shell-API actions — and have them affect the
correct target?

- Key-injection actions (`CLOSE_WINDOW`, `CLOSE_TAB`, `PLAY_PAUSE`, etc.)
  must land in the focused application, not in `gnome-shell` itself.
- Shell-API actions (`SHOW_OVERVIEW`, `SHOW_DESKTOP`, `NOTIFICATION_CENTER`)
  must work regardless of which application currently holds focus.
- Verify there is no race between suppression (POC 2) and dispatch — the
  configured action should fire exactly once per detected tap.

---


## Acceptance Criteria

1. When a 3-finger tap action is configured (non-NONE): a 3-finger tap fires the
   configured action exactly once and does NOT produce a middle-click in the focused
   application.
2. When a 4-finger tap action is configured (non-NONE): a 4-finger tap fires the
   configured action exactly once and suppresses any default OS behavior for that
   gesture.
3. When the 3-finger tap action is NONE: `BTN_MIDDLE` from tap-to-click passes through
   unmodified — existing system behavior is fully preserved.
4. When the 4-finger tap action is NONE: existing system behavior is fully preserved.
5. 3-finger swipe gestures work correctly regardless of whether a 3-finger tap action
   is configured.
6. 3-finger hold+swipe gestures work correctly regardless of whether a 3-finger tap
   action is configured.
7. 4-finger swipe gestures work correctly regardless of whether a 4-finger tap action
   is configured
8. 4-finger hold+swipe gestures work correctly regardless of whether a 4-finger tap
   action is configured.
9. Settings changes apply without a GNOME Shell restart (via the existing reload
   mechanism).
10. `npm run lint && npm run format` pass with no errors.
11. Passes on GNOME 46 (48-branch PR) and GNOME 49/50 (main-branch PR).

---

## Decisions Snapshot (Answered)

| Question | Decision |
|---|---|
| Which action categories to support? | Both keyboard shortcut actions AND GNOME Shell API actions |
| UI placement? | New "Tap Gestures" section on the existing System Gestures page, after Pinch Gestures |
| Suppress existing default behavior (BTN_MIDDLE)? | Yes — suppression is active when action is non-NONE; passes through unchanged when NONE |
| One PR or two? | Two — one per upstream branch (`48` and `main`); identical tap gesture code in both |

---

## Testing Checklist

### Both branches

- [ ] Proof-of-concept test passes
- [ ] `npm run lint && npm run format` pass
- [ ] 3-finger tap with configured action fires action; no middle-click in app
- [ ] 3-finger tap with NONE configured: middle-click passes through normally
- [ ] 4-finger tap with configured action fires action correctly
- [ ] 4-finger tap with NONE configured: no action fires, no side effects
- [ ] 3-finger tap does not conflict with 3-finger swipe
- [ ] 3-finger tap does not conflict with 3-finger hold+swipe
- [ ] Tap duration threshold setting prevents long 4-finger holds from triggering taps
- [ ] Settings changes reload the extension cleanly
- [ ] SHOW_DESKTOP minimize-all toggle works correctly

### `48` branch PR — GNOME 45–48 (test on GNOME 46)

- [ ] Extension loads without errors on GNOME 46
- [ ] All tap gesture actions work on GNOME 46
- [ ] No regressions in existing swipe/pinch gestures on GNOME 46

### `main` branch PR — GNOME 49–50 (test on GNOME 49 or 50)

- [ ] Extension loads without errors on GNOME 49/50
- [ ] All tap gesture actions work on GNOME 49/50
- [ ] No regressions in existing swipe/pinch gestures on GNOME 49/50
