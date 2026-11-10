/* eslint-disable padded-blocks -- prettier strips class padding */
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {WIDGET_SHOWING_DURATION} from '../../constants.js';
import {easeActor} from '../utils/environment.js';
import {TouchpadPinchGesture} from './pinchTracker.js';

const END_OPACITY = 0;
const PINCH_THRESHOLD = 0.02;

enum MinimizeWindowGestureState {
    PINCH_IN = -1,
    DEFAULT = 0,
    PINCH_OUT = 1,
}

const PINCH_IN_ANIMATION = {
    style: 'gie-close-window-preview',
    start: 1,
    end: 0.5,
} as const;

const PINCH_OUT_ANIMATION = {
    style: 'gie-open-window-preview',
    start: 0.5,
    end: 1,
} as const;

declare type Type_TouchpadPinchGesture = typeof TouchpadPinchGesture.prototype;

/**
 * Pinch in minimizes the focused window. Pinch out restores the window this
 * gesture minimized most recently, and raises it.
 *
 * The restore list is only windows this gesture minimized, newest first.
 * Pinch out does nothing when that list is empty, or when the newest window
 * was already closed or restored another way. Desktop and dock windows are
 * ignored, and so is a pinch while nothing is focused. A window is minimized
 * only when it can be minimized.
 *
 * The window action waits until the preview animation ends, which is the same
 * point at which Open/Close Window closes. A window that is unmanaged before
 * then is dropped, so minimize() and unminimize() are not called on it
 * (upstream issue #19). destroy() disconnects every signal this object
 * connected; the extension calls destroy() on disable.
 */
export class MinimizeWindowExtension implements ISubExtension {
    private _pinchTracker: Type_TouchpadPinchGesture;
    private _preview: St.Widget;
    private _pinchHandlers: number[] = [];
    private _windowUnmanagedIds = new Map<Meta.Window, number>();
    private _minimizedWindows: Meta.Window[] = [];
    private _pinchInWindow: Meta.Window | null = null;
    private _pinchOutWindow: Meta.Window | null = null;
    private _activePinchAnimation:
        | typeof PINCH_IN_ANIMATION
        | typeof PINCH_OUT_ANIMATION
        | null = null;
    private _gestureActive = false;
    private _destroyed = false;

    constructor(nfingers: number[]) {
        this._preview = new St.Widget({
            reactive: false,
            style_class: 'gie-close-window-preview',
            visible: false,
        });
        this._preview.set_pivot_point(0.5, 0.5);
        Main.layoutManager.uiGroup.add_child(this._preview);

        this._pinchTracker = new TouchpadPinchGesture({
            nfingers: nfingers,
            allowedModes: Shell.ActionMode.NORMAL,
            pinchSpeed: 0.25,
        });
        this._pinchHandlers = [
            this._pinchTracker.connect('begin', this._gestureBegin.bind(this)),
            this._pinchTracker.connect(
                'update',
                this._gestureUpdate.bind(this)
            ),
            this._pinchTracker.connect('end', this._gestureEnd.bind(this)),
        ];
    }

    destroy(): void {
        if (this._destroyed) return;

        this._destroyed = true;
        this._pinchHandlers.forEach(id => this._pinchTracker.disconnect(id));
        this._pinchHandlers = [];
        this._pinchTracker.destroy();
        this._unwatchAll();
        this._minimizedWindows = [];
        this._pinchInWindow = null;
        this._pinchOutWindow = null;
        this._gestureActive = false;
        this._preview.remove_all_transitions();
        this._preview.destroy();
    }

    private _gestureBegin(tracker: Type_TouchpadPinchGesture) {
        if (this._destroyed || this._gestureActive) return;

        this._activePinchAnimation = null;
        this._pinchInWindow = null;
        this._pinchOutWindow = null;

        const focus = global.display.get_focus_window() as Meta.Window | null;

        if (this._isMinimizable(focus)) this._pinchInWindow = focus;

        const restorable = this._nextRestorable();

        if (!this._pinchInWindow && !restorable) return;

        if (this._pinchInWindow) this._watch(this._pinchInWindow);

        this._gestureActive = true;
        tracker.confirmPinch(
            0,
            [
                MinimizeWindowGestureState.PINCH_IN,
                MinimizeWindowGestureState.DEFAULT,
                MinimizeWindowGestureState.PINCH_OUT,
            ],
            MinimizeWindowGestureState.DEFAULT
        );
    }

    private _gestureUpdate(_tracker: unknown, progress: number): void {
        if (this._destroyed) return;

        progress = MinimizeWindowGestureState.DEFAULT - progress;
        let startAnimation = false;

        if (this._activePinchAnimation === null) {
            if (Math.abs(progress) <= PINCH_THRESHOLD) return;

            if (progress > 0) {
                const window = this._pinchInWindow;

                if (!this._isMinimizable(window)) return;

                this._activePinchAnimation = PINCH_IN_ANIMATION;
                this._placePreview(window);
            } else {
                const window = this._nextRestorable();

                if (!window) return;

                this._pinchOutWindow = window;
                this._activePinchAnimation = PINCH_OUT_ANIMATION;
                this._placePreview(window);
            }

            this._preview.set_style_class_name(
                this._activePinchAnimation.style
            );
            startAnimation = true;
        }

        if (this._activePinchAnimation === PINCH_OUT_ANIMATION)
            progress = -progress;

        const animation = this._activePinchAnimation;

        if (!animation) return;

        const scale = Util.lerp(animation.start, animation.end, progress);
        this._preview.set_scale(scale, scale);
        this._preview.opacity = Util.lerp(255, END_OPACITY, progress);

        if (startAnimation) {
            this._preview.show();
            easeActor(this._preview, {
                opacity: 255,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                duration: WIDGET_SHOWING_DURATION,
            });
        }
    }

    private _gestureEnd(
        _tracker: unknown,
        duration: number,
        progress: MinimizeWindowGestureState
    ) {
        if (this._destroyed) return;

        switch (progress) {
            case MinimizeWindowGestureState.PINCH_IN:
                this._animatePreview(
                    this._activePinchAnimation === PINCH_IN_ANIMATION,
                    duration,
                    () => this._complete(MinimizeWindowGestureState.PINCH_IN)
                );
                break;
            case MinimizeWindowGestureState.PINCH_OUT:
                this._animatePreview(
                    this._activePinchAnimation === PINCH_OUT_ANIMATION,
                    duration,
                    () => this._complete(MinimizeWindowGestureState.PINCH_OUT)
                );
                break;
            default:
                this._animatePreview(false, duration);
                break;
        }
    }

    private _complete(progress: MinimizeWindowGestureState) {
        if (
            progress === MinimizeWindowGestureState.PINCH_IN &&
            this._activePinchAnimation === PINCH_IN_ANIMATION
        )
            this._minimizeFocusedWindow();
        else if (
            progress === MinimizeWindowGestureState.PINCH_OUT &&
            this._activePinchAnimation === PINCH_OUT_ANIMATION
        )
            this._restorePreviewedWindow();
    }

    private _minimizeFocusedWindow() {
        const window = this._pinchInWindow;

        if (!this._isMinimizable(window)) return;

        window.minimize();
        this._remember(window);
    }

    private _restorePreviewedWindow() {
        const window = this._pinchOutWindow;

        if (!this._isRestorable(window)) {
            if (window) this._forget(window);

            return;
        }

        window.unminimize();

        if (this._isAlive(window)) window.activate(global.get_current_time());

        this._forget(window);
    }

    private _animatePreview(
        gestureCompleted: boolean,
        duration: number,
        callback?: () => void
    ) {
        const animation = this._activePinchAnimation;

        // A pinch that never crossed the threshold has no preview to ease.
        // Finishing here also avoids leaving the gesture stuck if there is
        // no animation to stop.
        if (!animation) {
            if (this._destroyed) return;

            if (callback) callback();

            this._finishGesture();
            return;
        }

        const scale = gestureCompleted ? animation.end : animation.start;

        easeActor(this._preview, {
            opacity: gestureCompleted ? END_OPACITY : 255,
            scaleX: scale,
            scaleY: scale,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (this._destroyed) return;

                if (callback) callback();

                this._finishGesture();
            },
        });
    }

    private _finishGesture() {
        const pinchInWindow = this._pinchInWindow;

        this._pinchInWindow = null;
        this._pinchOutWindow = null;
        this._gestureActive = false;
        this._activePinchAnimation = null;

        if (pinchInWindow && !this._minimizedWindows.includes(pinchInWindow))
            this._unwatch(pinchInWindow);

        this._preview.hide();
        this._preview.opacity = 0;
        this._preview.set_scale(1, 1);
    }

    private _remember(window: Meta.Window) {
        this._minimizedWindows = this._minimizedWindows.filter(
            candidate => candidate !== window
        );
        this._minimizedWindows.push(window);
        this._watch(window);
    }

    private _nextRestorable(): Meta.Window | null {
        while (this._minimizedWindows.length > 0) {
            const window =
                this._minimizedWindows[this._minimizedWindows.length - 1];

            if (this._isRestorable(window)) return window;

            this._forget(window);
        }

        return null;
    }

    private _forget(window: Meta.Window) {
        this._minimizedWindows = this._minimizedWindows.filter(
            candidate => candidate !== window
        );
        this._unwatch(window);
    }

    private _watch(window: Meta.Window) {
        if (this._windowUnmanagedIds.has(window)) return;

        const id = window.connect('unmanaged', () => {
            this._windowUnmanagedIds.delete(window);
            this._minimizedWindows = this._minimizedWindows.filter(
                candidate => candidate !== window
            );

            if (this._pinchInWindow === window) this._pinchInWindow = null;

            if (this._pinchOutWindow === window) this._pinchOutWindow = null;
        });
        this._windowUnmanagedIds.set(window, id);
    }

    private _unwatch(window: Meta.Window) {
        const id = this._windowUnmanagedIds.get(window);

        if (id === undefined) return;

        this._windowUnmanagedIds.delete(window);

        // The window is still managed, so disconnect is safe. Once it has
        // left the window list the object is going away with the signal.
        if (this._isAlive(window)) window.disconnect(id);
    }

    private _unwatchAll() {
        for (const window of [...this._windowUnmanagedIds.keys()])
            this._unwatch(window);
    }

    private _placePreview(window: Meta.Window) {
        if (!this._isAlive(window)) return;

        const frame = window.get_frame_rect();
        this._preview.set_position(frame.x, frame.y);
        this._preview.set_size(frame.width, frame.height);
    }

    private _isMinimizable(window: Meta.Window | null): window is Meta.Window {
        if (!window || !this._isAlive(window)) return false;

        const type = window.get_window_type();

        if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK)
            return false;

        return window.can_minimize() && !window.minimized;
    }

    private _isRestorable(window: Meta.Window | null): window is Meta.Window {
        if (!window || !this._isAlive(window)) return false;

        return window.minimized;
    }

    /**
     * list_all_windows() does not call methods on `window`. A window that
     * was already destroyed therefore cannot crash the shell here, which is
     * the failure in upstream issue #19. get_compositor_private() runs only
     * after that membership check, while the window is still managed.
     */
    private _isAlive(window: Meta.Window): boolean {
        if (!global.display.list_all_windows().includes(window)) return false;

        return window.get_compositor_private() != null;
    }
}
