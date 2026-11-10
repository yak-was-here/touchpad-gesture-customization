# Mirroring gestures to the touchscreen on GNOME 49–51

What the touchscreen switch can rely on, which built-in touchscreen gestures
exist, and why a mirrored gesture does not also run GNOME's own. Checked
against the gnome-shell `gnome-49`, `gnome-50`, and `gnome-51` branches and
mutter 50.1. See [`implementation-notes.md`](./implementation-notes.md) for
how the extension does it.

## Support by GNOME version

`metadata.json` on this branch lists shells 49, 50, and 51. The touchscreen
code uses the same Clutter touch events and `Clutter.PanGesture` on all three,
so it does not check the version at runtime.

| GNOME      | Published for       | Touchscreen mirroring | Reason                                                                                                                                                                                                     |
| ---------- | ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 45–48      | No (older branches) | Not built here        | Those branches are not this tree. `Clutter.PanGesture` already existed, but the extension's gesture handlers on those branches differ.                                                                     |
| 49, 50, 51 | Yes (`main`)        | Supported             | Touch contacts arrive as `TOUCH_BEGIN` / `UPDATE` / `END` on the stage. Built-in shell gestures are `Clutter.PanGesture` actions with the finger counts below. The three branches use the same parameters. |

A touchscreen does not emit touchpad swipe, pinch, or hold events. libinput
reports each finger as its own touch slot. The extension turns those slots
back into the touchpad events the rest of the code already handles.

## GNOME's built-in touchscreen gestures

Shell gestures go through `SwipeTracker` (`js/ui/swipeTracker.js`). The
touchpad path accepts 3 or more fingers. The touch path is a
`Clutter.PanGesture`:

- `allowDrag: false` → exactly 3 fingers (`min_n_points` and `max_n_points`
  are both `GESTURE_FINGER_COUNT`, which is 3).
- `allowDrag: true` (the default) → 1 or more fingers (`min_n_points` 1,
  `max_n_points` 0, and 0 means unlimited).

The recognizer starts after 16 pixels (`DEFAULT_BEGIN_THRESHOLD_PX` in
mutter's `clutter-pan-gesture.c`). A gesture that is refused from
`::may-recognize` is cancelled for the rest of that touch. It does not get
another chance when the fingers move further.

| Gesture                             | Where                    | Fingers   | Direction  | Phase                |
| ----------------------------------- | ------------------------ | --------- | ---------- | -------------------- |
| Workspace switching, normal session | `global.stage`           | exactly 3 | Horizontal | Capture              |
| Overview (show / hide)              | `global.stage`           | exactly 3 | Vertical   | Capture              |
| Workspaces in the overview          | `overviewGroup`          | exactly 3 | Horizontal | Bubble (the default) |
| App grid paging                     | the app-grid scroll view | 1 or more | Horizontal | Bubble               |

There is no built-in 4-finger touchscreen gesture. Four fingers makes the
exactly-3 pans cancel themselves. The app-grid pan is the exception: it will
accept 4 fingers because it has no maximum. One-finger controls (sliders, the
on-screen keyboard pager, a screenshot selection) are separate pan gestures
and are not the ones this switch overrides.

The extension already turns the overview's swipe tracker off while it is
enabled, for touchpad and touchscreen alike. That is unchanged. Workspace
switching's built-in tracker keeps its touch pan; only its touchpad handler
is disconnected. That pan is what a 3-finger horizontal touchscreen swipe
uses when mirroring is off.

## What the switch changes

The switch is off by default.

- **Off.** The extension does not watch touchscreen contacts. GNOME's pans
  behave as they do today, including the 3-finger pans the extension's own
  swipe trackers happen to install (removal of those pans is still commented
  out in `createSwipeTracker`).
- **On.** 3- and 4-finger swipes, pinches, holds, and taps are recognized
  from touch slots and handed to the handlers already configured for the
  touchpad. The same finger count, direction, and action are used. There is
  no second set of touchscreen settings.
- **A direction set to None** (and any 3-finger swipe no handler accepts) is
  not claimed. GNOME's built-in pan still runs.
- **One and two fingers** are never claimed, so tapping, scrolling, and
  dragging a window stay with the shell and the application.

Once a configured handler has accepted the gesture, the built-in pans listed
above are refused and a claim pan on the stage recognizes instead. That claim
takes Clutter's implicit grab, which cancels the touch for the window under
the fingers so the swipe is not also a drag in that window. Refusing a pan
cancels it for the rest of the touch, so the decision is made at the moment
the handler accepts and is not revisited.

## Sources

- [gnome-shell gnome-51, `js/ui/swipeTracker.js:35`](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-51/js/ui/swipeTracker.js#L35)
  and [lines 385–387](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-51/js/ui/swipeTracker.js#L385):
  `GESTURE_FINGER_COUNT = 3`, and the pan's min/max points. The same lines
  are in the `gnome-49` and `gnome-50` branches.
- [gnome-shell gnome-51, `js/ui/workspaceAnimation.js:374`](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-51/js/ui/workspaceAnimation.js#L374):
  3-finger horizontal workspace pan on the stage, capture phase. Same
  constructor on `gnome-49` and `gnome-50`.
- [gnome-shell gnome-51, `js/ui/overview.js:226`](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-51/js/ui/overview.js#L226):
  3-finger vertical overview pan. Same constructor on `gnome-49` and `gnome-50`.
- [gnome-shell gnome-51, `js/ui/workspacesView.js:868`](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-51/js/ui/workspacesView.js#L868):
  3-finger horizontal pan in the overview. On `gnome-49` and `gnome-50` the
  same constructor is at line 839.
- [gnome-shell gnome-51, `js/ui/appDisplay.js:615`](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-51/js/ui/appDisplay.js#L615):
  app-grid pan with default `allowDrag: true` (1 or more fingers). On
  `gnome-49` and `gnome-50` the same constructor is at line 603.
- [mutter 50.1, `clutter-pan-gesture.c:29`](https://gitlab.gnome.org/GNOME/mutter/-/blob/50.1/clutter/clutter/clutter-pan-gesture.c#L29):
  16px begin threshold. [Lines 543–547](https://gitlab.gnome.org/GNOME/mutter/-/blob/50.1/clutter/clutter/clutter-pan-gesture.c#L543):
  `max-n-points` 0 means unlimited.
- [mutter 50.1, `clutter-gesture.c:590`](https://gitlab.gnome.org/GNOME/mutter/-/blob/50.1/clutter/clutter/clutter-gesture.c#L590):
  a failed `may-recognize` cancels the gesture. [Lines 604–634](https://gitlab.gnome.org/GNOME/mutter/-/blob/50.1/clutter/clutter/clutter-gesture.c#L604):
  recognizing takes the implicit grab and cancels other gestures that are
  still possible.
- [libinput, touchpad gestures](https://wayland.freedesktop.org/libinput/doc/latest/gestures.html):
  swipe, pinch, and hold are touchpad gestures. A touchscreen is reported as
  individual touches, not as those gestures.
