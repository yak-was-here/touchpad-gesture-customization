# Touchscreen mirroring: implementation notes

**Date:** 2026-11-10. Checked against gnome-shell 49, 50, and 51 and mutter
50.1. The version table and the list of built-in pans are in
[`gnome-version-support.md`](./gnome-version-support.md).

## Where touchpad gestures are hooked today

Every configured action ends up in one of three handlers, all listening to
`captured-event::touchpad` on `global.stage`:

| Handler                                                      | Events                            | What uses it                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TouchpadSwipeGesture` (`src/swipeTracker.ts`)               | `TOUCHPAD_SWIPE`, `TOUCHPAD_HOLD` | Overview, workspaces, window switching, volume, brightness, media, window tiling, app forward/back. Swipes emit `begin` / `update` / `end` into GNOME's `SwipeTracker`, which is what drives progress animations. Holds emit `hold` and arm hold-and-swipe. |
| `TouchpadPinchGesture` (`src/pinchGestures/pinchTracker.ts`) | `TOUCHPAD_PINCH`                  | Show desktop, open/close window or tab, notifications, pinch volume, keyboard backlight. Progress is `log2(pinch scale)` times the pinch-speed setting.                                                                                                     |
| `TapGestureExtension` (`src/tapGestures.ts`)                 | `TOUCHPAD_HOLD`                   | 3- and 4-finger taps. A tap is a hold that ends, without a swipe or pinch, within `TapConstants.MAX_HOLD_DURATION` (300ms) of `HOLD BEGIN`.                                                                                                                 |

`captured-event` stops calling later handlers when one returns
`Clutter.EVENT_STOP`. Handlers are connected in the order they are
constructed.

GNOME's `SwipeTracker` also adds a `Clutter.PanGesture` for touch. The
extension's `createSwipeTracker` passes `allowDrag: false`, so that pan is
exactly 3 fingers, and the block that would remove it is commented out. With
the switch off, those pans are left in place. That is the previous behavior.

## What the switch adds

`mirror-gestures-to-touchscreen` (default `false`) is read in
`_initializeSettings` into `ExtSettings.MIRROR_TOUCHSCREEN`. Changing it
reloads the extension, same as the other keys.

While it is true, `TouchscreenMirroring` (`src/touchscreenGestures.ts`)
watches touches with `Clutter.Event.add_filter` and:

1. Keeps one point per touch slot (`Clutter.EventSequence.get_slot()`), and
   ignores any device that is not a touchscreen.
2. Ignores 1- and 2-finger contacts. Five or more fingers cancel the gesture
   and are ignored until all fingers lift.
3. For 3 or 4 fingers, tracks the centroid and the average distance from the
   centroid (the spread).
4. After 16px of centroid travel, or 16px of spread change when that change
   is larger than the centroid travel, classifies the gesture as a swipe or
   a pinch. The dominant axis uses the same tie-break as
   `TouchpadSwipeGesture` (a tie is vertical).
5. Synthesizes `TOUCHPAD_SWIPE`, `TOUCHPAD_PINCH`, and `TOUCHPAD_HOLD`
   events and delivers them to the handlers in registration order, stopping
   at the first `EVENT_STOP`.

Swipe deltas are screen pixels. The handlers then apply the touchpad speed
(or pinch speed) and the same 400×300 base distance they use for the
touchpad, so a progress animation such as workspace switching follows the
finger through the existing `SwipeTracker` path. Natural scroll, allowed
action modes, and `checkAllowedGesture` run unchanged because they live in
those handlers.

A hold is synthesized 180ms after the fingers rest, which is libinput's
`DEFAULT_GESTURE_HOLD_TIMEOUT`. Media Control's play/pause on finger rest,
hold-and-swipe (app gestures and window tiling), and taps therefore see the
same events they see from a touchpad. A touchscreen tap still has to land in
the 180–480ms window. Lifting sooner produces no hold, so no tap action.
Unlike the touchpad, that quick lift is not a middle click; it simply does
nothing.

The finger count is locked when the gesture is classified. Adding or removing
a finger after that cancels it. Fingers have to be down before the swipe
starts; a fourth finger that lands after a 3-finger swipe is already moving
does not upgrade the gesture.

## How conflicts with GNOME's pans are handled

`::may-recognize` returning false cancels that pan for the rest of the touch.
The extension therefore does not refuse a built-in pan merely because three
fingers are down. It refuses only after a configured handler is in `pending`
or `handling` for this finger count, kind, and direction.

The pans it can refuse are the four navigation trackers: workspace
animation, the overview, the workspaces display, and the app grid. A pan
with fewer than 3 points is always allowed through, so a 1-finger app-grid
swipe still pages the grid. Sliders, the keyboard pager, screenshot
selection, and the lock screen are not in that list.

The filter is what makes the veto land on the right event. Mutter builds
the emission chain in `clutter-sprite.c` (`create_event_emission_chain`) so
that capture-phase actions run _before_ the actor's `captured-event`
signal, and `clutter_stage_handle_event` runs event filters before the
event is queued for that chain. A `captured-event` handler would see the
touch only after the pans had already accepted or refused it.

On the filtered event, before the pans run:

- If a handler accepted the gesture, `suppressBuiltin` is set and the claim
  pan's begin threshold is dropped to 0. Both stay that way until the claim
  pan emits `end` (or `cancel` once the fingers are up). The stage can
  filter a later `TOUCH_END` before it delivers the move that crossed the
  threshold, and clearing the veto in between would let the built-in pan
  accept that move.
- When the queue is flushed, GNOME's pans run first (they were added at
  shell startup). Their `may-recognize` handlers return false, so they are
  cancelled and do not emit `begin`.
- The claim pan (`min_n_points` 3, `max_n_points` 4, added on the stage at
  capture phase) is allowed to recognize. Recognizing takes the implicit
  grab, so the client under the fingers is told the touch was cancelled, and
  other gestures that were only possible are cancelled too.

The claim pan is not connected to `SwipeTracker`. It exists to win the grab.
The action itself comes only from the synthesized touchpad events. Extension
trackers created by `createSwipeTracker` also have their own 3-finger pan
removed while mirroring is on, so that pan cannot fire the action a second
time. GNOME's trackers keep their pans; the veto covers them, which is what
lets a direction set to None keep the built-in gesture.

The filter always returns `EVENT_PROPAGATE`. Stopping the event there drops
it before the pans, including the claim pan, and a pan that never sees
`TOUCH_END` would be stuck.

## Limits

- **GNOME 49, 50, and 51 only**, on Wayland, which is the shell versions this
  branch publishes and the session type the extension already requires.
- **Touchpad speed applies to the touchscreen.** A full step of a progress
  gesture is about 400px horizontally or 300px vertically at speed 1, not a
  full screen width. That is the touchpad handler's base distance. Raise or
  lower the existing speed sliders to change both devices.
- **Very low swipe speed.** The handler decides the direction once its own
  (speed-scaled) threshold is crossed. At the default speed that is the same
  16px GNOME uses. At a much lower speed the handler is still `pending` at
  16px, the built-in pan is already cancelled, and a direction that no
  handler wants will not fall back to GNOME for that touch.
- **`checkAllowedGesture`.** Handlers that reject a gesture (for example the
  overview workspace swipe while search is active) do not count as having
  accepted it, so the built-in pan is not refused on that event.
- **Pinch versus swipe** is decided once, from which changed more: spread or
  centroid. A pinch that also slides a long way can be classified as a swipe.
- **Quick taps** under 180ms do not fire. The touchscreen does not turn them
  into a middle click either.
- **One- and two-finger touches** are untouched. A 3-finger gesture started
  in the middle of a 1-finger drag is not reliable: the drag's pan may
  already be recognizing, and only one gesture can recognize at a time.
- **Not tested on hardware here.** Recognition was checked against the shell
  sources above. A headless GNOME 49/50/51 session was not available in this
  environment (Ubuntu 24.04 ships GNOME 46). The owner needs to confirm the
  feel on a touchscreen.

## References

- `extension/src/touchscreenGestures.ts` — recognizer, claim pan, vetoes
- `extension/src/swipeTracker.ts` — swipe and hold handler, pan removal
- `extension/src/pinchGestures/pinchTracker.ts` — pinch handler
- `extension/src/tapGestures.ts` — tap handler
- gnome-shell `js/ui/swipeTracker.js`, `workspaceAnimation.js`, `overview.js`,
  `workspacesView.js`, `appDisplay.js`
- mutter `clutter/clutter/clutter-gesture.c`, `clutter-pan-gesture.c`
- mutter 50.1 `clutter-sprite.c` `create_event_emission_chain` (capture
  actions are delivered before `captured-event`) and `clutter-main.c`
  `clutter_stage_handle_event` (filters run before the event is queued)
