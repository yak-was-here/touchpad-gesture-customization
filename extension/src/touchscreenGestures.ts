import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Same distance Clutter.PanGesture and the touchpad swipe tracker use before
// a gesture counts as started. See mutter clutter-pan-gesture.c
// (DEFAULT_BEGIN_THRESHOLD_PX) and TouchpadConstants.DRAG_THRESHOLD_DISTANCE.
const DRAG_THRESHOLD_PX = 16;
const PINCH_THRESHOLD_PX = 16;

// libinput's DEFAULT_GESTURE_HOLD_TIMEOUT. A touchpad hold (and therefore a
// tap) is not reported until the fingers have rested this long. Emitting the
// synthetic hold on the same delay keeps taps, media-control holds, and
// hold-and-swipe on the touchscreen on the touchpad's clock.
const HOLD_RECOGNITION_MS = 180;

const MIN_FINGERS = 3;
const MAX_FINGERS = 4;

// High enough that the claim gesture never recognizes on its own. It is
// lowered to 0 only after this recognizer has committed to a configured
// action, so it can take the implicit grab on that same event.
const CLAIM_THRESHOLD_IDLE = 1_000_000;

export type TouchscreenGestureKind = 'swipe' | 'pinch';

export type TouchscreenGestureState =
    | 'idle'
    | 'pending'
    | 'handling'
    | 'ignored';

/**
 * A touchpad-shaped event synthesized from touchscreen contacts. Gesture
 * handlers already speak this shape (see CustomEventType).
 */
export class SyntheticTouchpadEvent {
    private _type: Clutter.EventType;
    private _phase: Clutter.TouchpadGesturePhase;
    private _fingers: number;
    private _time: number;
    private _x: number;
    private _y: number;
    private _dx: number;
    private _dy: number;
    private _scale: number;

    constructor(init: {
        type: Clutter.EventType;
        phase: Clutter.TouchpadGesturePhase;
        fingers: number;
        time: number;
        x: number;
        y: number;
        dx: number;
        dy: number;
        scale: number;
    }) {
        this._type = init.type;
        this._phase = init.phase;
        this._fingers = init.fingers;
        this._time = init.time;
        this._x = init.x;
        this._y = init.y;
        this._dx = init.dx;
        this._dy = init.dy;
        this._scale = init.scale;
    }

    type(): Clutter.EventType {
        return this._type;
    }

    get_gesture_phase(): Clutter.TouchpadGesturePhase {
        return this._phase;
    }

    get_touchpad_gesture_finger_count(): number {
        return this._fingers;
    }

    get_time(): number {
        return this._time;
    }

    get_coords(): [number, number] {
        return [this._x, this._y];
    }

    get_gesture_motion_delta_unaccelerated(): [number, number] {
        return [this._dx, this._dy];
    }

    get_gesture_pinch_scale(): number {
        return this._scale;
    }

    get_gesture_pinch_angle_delta(): number {
        return 0;
    }
}

export interface TouchscreenSink {
    canHandle(
        fingerCount: number,
        kind: TouchscreenGestureKind,
        orientation: Clutter.Orientation
    ): boolean;
    touchscreenState(): TouchscreenGestureState;
    handleEvent(event: SyntheticTouchpadEvent): boolean;
}

const sinks: TouchscreenSink[] = [];

/**
 * Register a gesture handler to receive synthesized touchpad events.
 * Returns an unregister function. Safe to call after mirroring has stopped.
 * @param sink handler invoked in registration order, which matches the order
 * touchpad handlers connect to the stage
 */
export function registerTouchscreenSink(sink: TouchscreenSink): () => void {
    sinks.push(sink);

    return () => {
        const index = sinks.indexOf(sink);

        if (index >= 0) sinks.splice(index, 1);
    };
}

/**
 * Drop the pan gesture GNOME's SwipeTracker installs. The extension's own
 * trackers are driven by synthesized touchpad events while mirroring is on;
 * leaving the pan in place would run the same action a second time.
 * @param swipeTracker tracker created for an extension gesture
 */
export function detachBuiltinPanGesture(swipeTracker: {
    _panGesture?: Clutter.PanGesture;
}): void {
    const pan = swipeTracker._panGesture;

    if (!pan?.actor) return;

    pan.actor.remove_action(pan);
}

interface TrackedPoint {
    x: number;
    y: number;
}

type RecognizerKind = 'idle' | 'tracking' | 'swipe' | 'pinch' | 'ignore';

/**
 * Tracks touchscreen contacts and feeds the extension's existing gesture
 * handlers. Installed only while the mirror setting is on.
 *
 * GNOME's own touchscreen gestures are Clutter.PanGesture actions (exactly 3
 * fingers for overview and workspace switching; 1 or more for the app grid).
 * A pan that is refused in ::may-recognize is cancelled for the rest of the
 * touch, so built-in pans are refused only after a configured handler has
 * actually accepted the gesture. A second pan on the stage then recognizes
 * and takes Clutter's implicit grab, which is what stops the touches from
 * also being delivered as a drag to the window underneath.
 *
 * The decision has to be made in a Clutter event filter. Capture-phase
 * actions run before the stage's captured-event signal (see
 * create_event_emission_chain in mutter's clutter-sprite.c), and the stage
 * queues the event after the filter, so a captured-event handler would run
 * too late to veto the pan on the same touch.
 */
export class TouchscreenMirroring {
    // Read by the may-recognize handlers installed below.
    suppressBuiltin = false;
    private _points = new Map<number, TrackedPoint>();
    private _kind: RecognizerKind = 'idle';
    private _lockedFingers = 0;
    private _originX = 0;
    private _originY = 0;
    private _lastX = 0;
    private _lastY = 0;
    private _originSpread = 1;
    private _lastScale = 1;
    private _holdStarted = false;
    private _holdTimer = 0;
    private _lastEventTime = 0;
    private _lastMono = 0;
    private _disposed = false;
    private _filterId = 0;
    private _claimPan?: Clutter.PanGesture;
    private _vetoes: {gesture: Clutter.Gesture; id: number}[] = [];

    start(): void {
        // Filters run before the event is queued for actors and actions.
        this._filterId = Clutter.Event.add_filter(
            global.stage,
            this._onTouch.bind(this)
        );

        // Recognize only when we explicitly lower the threshold, after a
        // configured handler has accepted the gesture. min/max match the
        // finger counts this extension configures (3 and 4).
        this._claimPan = new Clutter.PanGesture({
            min_n_points: MIN_FINGERS,
            max_n_points: MAX_FINGERS,
            begin_threshold: CLAIM_THRESHOLD_IDLE,
        });
        this._claimPan.connect('may-recognize', () => this.suppressBuiltin);

        // The stage may deliver the touch that ends the gesture before the
        // earlier move that crossed the threshold (the filter runs at
        // arrival, the pans run when the queue is flushed). Hold the veto
        // until the claim pan itself finishes, which is during delivery.
        this._claimPan.connect('end', () => this._releaseClaim());
        this._claimPan.connect('cancel', () => {
            // A cancel while fingers are still down and a handler has
            // accepted the gesture must not drop the veto: the stage may
            // still be delivering the move that crossed the threshold.
            if (this._points.size === 0 || !this.suppressBuiltin)
                this._releaseClaim();
        });
        global.stage.add_action_full(
            'touchpad-gesture-customization-touchscreen',
            Clutter.EventPhase.CAPTURE,
            this._claimPan
        );

        this._installVetoes();
    }

    destroy(): void {
        this._disposed = true;
        this._cancelHoldTimer();

        if (this._filterId) {
            Clutter.Event.remove_filter(this._filterId);
            this._filterId = 0;
        }

        for (const veto of this._vetoes) {
            try {
                veto.gesture.disconnect(veto.id);
            } catch (ex) {
                // The shell actor may already have dropped the gesture.
            }
        }

        this._vetoes = [];

        if (this._claimPan) {
            this._claimPan.actor?.remove_action(this._claimPan);
            this._claimPan = undefined;
        }

        this._points.clear();
        this.suppressBuiltin = false;
        this._kind = 'idle';
    }

    private _installVetoes(): void {
        for (const tracker of navigationSwipeTrackers()) {
            const pan = tracker._panGesture;

            if (!pan) continue;

            const id = pan.connect('may-recognize', () => {
                if (!this.suppressBuiltin) return true;

                // One-finger drags (app-grid paging, sliders reached through
                // a shared tracker) keep working. Only a 3+ finger pan can
                // collide with a mirrored gesture.
                try {
                    if (pan.get_n_points() < MIN_FINGERS) return true;
                } catch (ex) {
                    return true;
                }

                return false;
            });

            this._vetoes.push({gesture: pan, id});
        }
    }

    private _releaseClaim(): void {
        this.suppressBuiltin = false;

        if (this._claimPan)
            this._claimPan.begin_threshold = CLAIM_THRESHOLD_IDLE;
    }

    private _onTouch(event: Clutter.Event, _actor: Clutter.Actor): boolean {
        const type = event.type();

        if (
            type !== Clutter.EventType.TOUCH_BEGIN &&
            type !== Clutter.EventType.TOUCH_UPDATE &&
            type !== Clutter.EventType.TOUCH_END &&
            type !== Clutter.EventType.TOUCH_CANCEL
        )
            return Clutter.EVENT_PROPAGATE;

        const device = event.get_source_device();

        if (
            device &&
            device.get_device_type() !==
                Clutter.InputDeviceType.TOUCHSCREEN_DEVICE
        )
            return Clutter.EVENT_PROPAGATE;

        const sequence = event.get_event_sequence();

        if (!sequence) return Clutter.EVENT_PROPAGATE;

        const slot = sequence.get_slot();
        const time = event.get_time();

        // A new contact after every finger has lifted means the previous
        // touch has already been flushed to the pans (TOUCH_END processes
        // the queue). Drop a veto that never reached the claim pan.
        if (type === Clutter.EventType.TOUCH_BEGIN && this._points.size === 0)
            this._releaseClaim();

        this._lastEventTime = time;
        this._lastMono = GLib.get_monotonic_time();

        if (
            type === Clutter.EventType.TOUCH_BEGIN ||
            type === Clutter.EventType.TOUCH_UPDATE
        ) {
            const [x, y] = event.get_coords();
            const point = this._points.get(slot);

            if (point && type === Clutter.EventType.TOUCH_UPDATE) {
                point.x = x;
                point.y = y;
            } else {
                this._points.set(slot, {x, y});
            }
        } else {
            this._points.delete(slot);
        }

        this._sync(time);

        return Clutter.EVENT_PROPAGATE;
    }

    private _sync(time: number): void {
        const count = this._points.size;

        if (count === 0) {
            if (this._kind !== 'idle' && this._kind !== 'ignore')
                this._endActive(time, Clutter.TouchpadGesturePhase.END);

            this._kind = 'idle';
            return;
        }

        if (count > MAX_FINGERS) {
            if (this._kind !== 'idle' && this._kind !== 'ignore')
                this._endActive(time, Clutter.TouchpadGesturePhase.CANCEL);

            this._kind = 'ignore';
            return;
        }

        if (this._kind === 'ignore') return;

        if (count < MIN_FINGERS) {
            if (this._kind !== 'idle')
                this._endActive(time, Clutter.TouchpadGesturePhase.END);

            return;
        }

        if (this._kind === 'swipe' || this._kind === 'pinch') {
            if (count !== this._lockedFingers) {
                this._endActive(time, Clutter.TouchpadGesturePhase.CANCEL);
                this._arm(count, time);
                return;
            }

            this._continue(time);
            return;
        }

        if (this._kind !== 'tracking' || count !== this._lockedFingers)
            this._arm(count, time);
        else this._consider(time);
    }

    private _arm(count: number, time: number): void {
        this._cancelHoldTimer();

        if (this._holdStarted) {
            this._emitHold(
                Clutter.TouchpadGesturePhase.CANCEL,
                time,
                this._lockedFingers
            );
            this._holdStarted = false;
        }

        this._kind = 'tracking';
        this._lockedFingers = count;
        const centroid = this._centroid();

        this._originX = centroid.x;
        this._originY = centroid.y;
        this._lastX = centroid.x;
        this._lastY = centroid.y;
        this._originSpread = Math.max(this._spread(centroid), 1);

        const expected = count;

        this._holdTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            HOLD_RECOGNITION_MS,
            () => {
                this._holdTimer = 0;

                if (
                    !this._disposed &&
                    this._kind === 'tracking' &&
                    this._points.size === expected
                ) {
                    this._holdStarted = true;
                    this._emitHold(
                        Clutter.TouchpadGesturePhase.BEGIN,
                        this._now(),
                        expected
                    );
                }

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    private _consider(time: number): void {
        const centroid = this._centroid();
        const translation = Math.hypot(
            centroid.x - this._originX,
            centroid.y - this._originY
        );
        const spreadNow = this._spread(centroid);
        const spreadDelta = Math.abs(spreadNow - this._originSpread);

        if (spreadDelta >= PINCH_THRESHOLD_PX && spreadDelta > translation) {
            this._beginCommitted('pinch', centroid, time, spreadNow);
            return;
        }

        if (translation >= DRAG_THRESHOLD_PX)
            this._beginCommitted('swipe', centroid, time, spreadNow);
    }

    private _beginCommitted(
        kind: TouchscreenGestureKind,
        centroid: TrackedPoint,
        time: number,
        spreadNow: number
    ): void {
        this._cancelHoldTimer();

        if (this._holdStarted) {
            this._emitHold(
                Clutter.TouchpadGesturePhase.CANCEL,
                time,
                this._lockedFingers
            );
            this._holdStarted = false;
        }

        this._kind = kind;

        if (kind === 'swipe') {
            this._emitSwipe(
                Clutter.TouchpadGesturePhase.BEGIN,
                time,
                centroid,
                centroid.x - this._originX,
                centroid.y - this._originY
            );
            this._lastX = centroid.x;
            this._lastY = centroid.y;
        } else {
            this._lastScale = 1;
            this._emitPinch(
                Clutter.TouchpadGesturePhase.BEGIN,
                time,
                centroid,
                1
            );
            this._lastScale = spreadNow / this._originSpread;
            this._emitPinch(
                Clutter.TouchpadGesturePhase.UPDATE,
                time,
                centroid,
                this._lastScale
            );
        }

        this._refreshSuppress(kind);

        // The pans see this event later, when the stage flushes its queue.
        // Lower the threshold now so the claim pan can recognize then.
        if (this.suppressBuiltin && this._claimPan)
            this._claimPan.begin_threshold = 0;
    }

    private _continue(time: number): void {
        const centroid = this._centroid();

        if (this._kind === 'swipe') {
            const dx = centroid.x - this._lastX;
            const dy = centroid.y - this._lastY;

            this._lastX = centroid.x;
            this._lastY = centroid.y;
            this._emitSwipe(
                Clutter.TouchpadGesturePhase.UPDATE,
                time,
                centroid,
                dx,
                dy
            );
            this._refreshSuppress('swipe');
            return;
        }

        this._lastScale = this._spread(centroid) / this._originSpread;
        this._emitPinch(
            Clutter.TouchpadGesturePhase.UPDATE,
            time,
            centroid,
            this._lastScale
        );
        this._refreshSuppress('pinch');
    }

    private _endActive(
        time: number,
        phase:
            | Clutter.TouchpadGesturePhase.END
            | Clutter.TouchpadGesturePhase.CANCEL
    ): void {
        this._cancelHoldTimer();
        const centroid = this._points.size
            ? this._centroid()
            : {x: this._lastX, y: this._lastY};

        if (this._kind === 'swipe')
            this._emitSwipe(phase, time, centroid, 0, 0);
        else if (this._kind === 'pinch')
            this._emitPinch(phase, time, centroid, this._lastScale);
        else if (this._holdStarted)
            this._emitHold(phase, time, this._lockedFingers);

        this._holdStarted = false;
        this._kind = 'idle';
        this._lockedFingers = 0;

        // Leave suppressBuiltin and the claim threshold latched. The pans
        // have not seen this event yet; _releaseClaim() runs once they have.
    }

    private _refreshSuppress(kind: TouchscreenGestureKind): void {
        const orientation = this._dominantOrientation();
        const claiming = sinks.some(sink => {
            if (!sink.canHandle(this._lockedFingers, kind, orientation))
                return false;

            const state = sink.touchscreenState();

            return state === 'pending' || state === 'handling';
        });

        if (claiming) this.suppressBuiltin = true;
    }

    private _dominantOrientation(): Clutter.Orientation {
        const centroid = this._points.size
            ? this._centroid()
            : {x: this._lastX, y: this._lastY};
        const dx = Math.abs(centroid.x - this._originX);
        const dy = Math.abs(centroid.y - this._originY);

        // Same tie-break as TouchpadSwipeGesture: a dead tie is vertical.
        return dx > dy
            ? Clutter.Orientation.HORIZONTAL
            : Clutter.Orientation.VERTICAL;
    }

    private _emitSwipe(
        phase: Clutter.TouchpadGesturePhase,
        time: number,
        centroid: TrackedPoint,
        dx: number,
        dy: number
    ): void {
        this._dispatch(
            new SyntheticTouchpadEvent({
                type: Clutter.EventType.TOUCHPAD_SWIPE,
                phase,
                fingers: this._lockedFingers,
                time,
                x: centroid.x,
                y: centroid.y,
                dx,
                dy,
                scale: 1,
            })
        );
    }

    private _emitPinch(
        phase: Clutter.TouchpadGesturePhase,
        time: number,
        centroid: TrackedPoint,
        scale: number
    ): void {
        this._dispatch(
            new SyntheticTouchpadEvent({
                type: Clutter.EventType.TOUCHPAD_PINCH,
                phase,
                fingers: this._lockedFingers,
                time,
                x: centroid.x,
                y: centroid.y,
                dx: 0,
                dy: 0,
                scale,
            })
        );
    }

    private _emitHold(
        phase: Clutter.TouchpadGesturePhase,
        time: number,
        fingers: number
    ): void {
        const centroid = this._points.size
            ? this._centroid()
            : {x: this._lastX, y: this._lastY};

        this._dispatch(
            new SyntheticTouchpadEvent({
                type: Clutter.EventType.TOUCHPAD_HOLD,
                phase,
                fingers,
                time,
                x: centroid.x,
                y: centroid.y,
                dx: 0,
                dy: 0,
                scale: 1,
            })
        );
    }

    private _dispatch(event: SyntheticTouchpadEvent): void {
        for (const sink of sinks) {
            // captured-event stops at the first handler that returns
            // EVENT_STOP. Keep that order so only one action runs.
            if (sink.handleEvent(event)) break;
        }
    }

    private _centroid(): TrackedPoint {
        let x = 0;
        let y = 0;

        for (const point of this._points.values()) {
            x += point.x;
            y += point.y;
        }

        const count = this._points.size || 1;

        return {x: x / count, y: y / count};
    }

    private _spread(centroid: TrackedPoint): number {
        if (this._points.size === 0) return 0;

        let sum = 0;

        for (const point of this._points.values())
            sum += Math.hypot(point.x - centroid.x, point.y - centroid.y);

        return sum / this._points.size;
    }

    private _now(): number {
        const elapsedMs = (GLib.get_monotonic_time() - this._lastMono) / 1000;

        return this._lastEventTime + elapsedMs;
    }

    private _cancelHoldTimer(): void {
        if (!this._holdTimer) return;

        GLib.source_remove(this._holdTimer);
        this._holdTimer = 0;
    }
}

/**
 * Start mirroring. Call once per enable, after the setting has been copied
 * into ExtSettings and before gesture handlers are constructed is fine;
 * handlers register themselves as they are created.
 */
export function startTouchscreenMirroring(): TouchscreenMirroring {
    const mirroring = new TouchscreenMirroring();

    mirroring.start();

    return mirroring;
}

function navigationSwipeTrackers(): {_panGesture?: Clutter.PanGesture}[] {
    const found: {_panGesture?: Clutter.PanGesture}[] = [];

    const push = (tracker?: {_panGesture?: Clutter.PanGesture}) => {
        if (tracker) found.push(tracker);
    };

    try {
        push(Main.wm._workspaceAnimation._swipeTracker);
    } catch (ex) {
        // Shell UI is not available yet.
    }

    try {
        push(Main.overview._swipeTracker);
    } catch (ex) {
        // Shell UI is not available yet.
    }

    try {
        push(
            Main.overview._overview._controls._workspacesDisplay._swipeTracker
        );
    } catch (ex) {
        // Shell UI is not available yet.
    }

    try {
        push(Main.overview._overview._controls._appDisplay._swipeTracker);
    } catch (ex) {
        // Shell UI is not available yet.
    }

    return found;
}
