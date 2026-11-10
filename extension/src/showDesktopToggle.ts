import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {TouchpadSwipeGesture} from './swipeTracker.js';

// Travel still required after the swipe is recognised. Same units as Media
// Control: deltas are already multiplied by the touchpad swipe speed.
const SWIPE_THRESHOLD = 50;

/**
 * Minimizes and restores the windows on the active workspace. Follows the
 * rules of the pinch Show Desktop (pinchGestures/showDesktop.ts): only
 * minimizable windows are hidden, switching workspace, opening a window or
 * disabling the extension restores them, and restoring a window by hand
 * ends the toggle.
 *
 * Tap calls toggle(). A swipe calls show() or restore() from the direction
 * of the gesture. extension.ts passes one instance to both when both are
 * enabled, so either gesture can restore windows the other hid.
 */
export class ShowDesktopToggle implements ISubExtension {
    private _hiddenWindows: Meta.Window[] = [];
    private _workspace?: Meta.Workspace;
    private _workspaceChangedId = 0;
    private _windowAddedId = 0;
    private _windowUnMinimizedId = 0;

    constructor() {
        this._workspaceChangedId = global.workspace_manager.connect(
            'active-workspace-changed',
            this._workspaceChanged.bind(this)
        );
        this._windowUnMinimizedId = global.window_manager.connect(
            'unminimize',
            this._windowUnMinimized.bind(this)
        );
        this._workspaceChanged();
    }

    destroy() {
        this._restore();

        if (this._windowAddedId)
            this._workspace?.disconnect(this._windowAddedId);

        global.workspace_manager.disconnect(this._workspaceChangedId);
        global.window_manager.disconnect(this._windowUnMinimizedId);
    }

    /** Minimize minimizable windows on the active workspace. */
    show() {
        if (this._hiddenWindows.length) return;

        this._hiddenWindows = (this._workspace?.list_windows() ?? []).filter(
            window =>
                window.get_window_type() === Meta.WindowType.NORMAL &&
                !window.is_skip_taskbar() &&
                !window.minimized &&
                window.can_minimize()
        );
        this._hiddenWindows.forEach(window => window.minimize());
    }

    /** Restore the windows hidden by the latest show(). */
    restore() {
        this._restore();
    }

    toggle() {
        if (this._hiddenWindows.length) {
            this.restore();
            return;
        }

        this.show();
    }

    private _restore() {
        const windows = this._workspace?.list_windows() ?? [];
        const hiddenWindows = this._hiddenWindows;

        this._hiddenWindows = [];
        hiddenWindows
            .filter(window => windows.includes(window))
            .forEach(window => window.unminimize());
    }

    private _workspaceChanged() {
        if (this._windowAddedId)
            this._workspace?.disconnect(this._windowAddedId);

        this._restore();
        this._workspace = global.workspace_manager.get_active_workspace();
        this._windowAddedId = this._workspace.connect(
            'window-added',
            this._windowAdded.bind(this)
        );
    }

    private _windowAdded(_workspace: unknown, window: Meta.Window) {
        if (!window.is_skip_taskbar()) this._restore();
    }

    private _windowUnMinimized(_wm: Shell.WM, actor: Meta.WindowActor) {
        if (actor.meta_window?.get_workspace() === this._workspace)
            this._hiddenWindows = [];
    }
}

/**
 * Positive delta shows the desktop and negative delta restores it.
 * Callers pass a delta whose sign matches the physical direction:
 * down and right are positive. Natural scrolling is not applied.
 */
function showDesktopForDelta(toggle: ShowDesktopToggle, delta: number) {
    if (delta > SWIPE_THRESHOLD) toggle.show();
    else if (delta < -SWIPE_THRESHOLD) toggle.restore();
}

function connectShowDesktopSwipe(
    tracker: typeof TouchpadSwipeGesture.prototype,
    onDelta: (delta: number) => void
): number[] {
    let delta = 0;

    return [
        tracker.connect('begin', () => {
            delta = 0;
        }),
        tracker.connect('update', (_gesture, _time, deltaUpdate) => {
            delta += deltaUpdate;
        }),
        tracker.connect('end', () => {
            // The tracker emits end for both END and CANCEL.
            onDelta(delta);
        }),
    ];
}

/**
 * Swipe Show Desktop. Down or right shows the desktop; up or left restores.
 * Listens only in the normal mode so overview swipes are left to overview
 * navigation. The returned object disconnects every signal it connects;
 * it does not destroy `toggle`.
 */
export function createShowDesktopSwipes(
    toggle: ShowDesktopToggle,
    verticalFingers?: number[],
    horizontalFingers?: number[]
): ISubExtension {
    let verticalTracker: typeof TouchpadSwipeGesture.prototype | undefined;
    let horizontalTracker: typeof TouchpadSwipeGesture.prototype | undefined;
    let verticalHandlers: number[] | undefined;
    let horizontalHandlers: number[] | undefined;

    if (verticalFingers?.length) {
        verticalTracker = new TouchpadSwipeGesture(
            verticalFingers,
            Shell.ActionMode.NORMAL,
            Clutter.Orientation.VERTICAL,
            false
        );
        verticalHandlers = connectShowDesktopSwipe(verticalTracker, delta => {
            // Positive delta: fingers moved down.
            showDesktopForDelta(toggle, delta);
        });
    }

    if (horizontalFingers?.length) {
        horizontalTracker = new TouchpadSwipeGesture(
            horizontalFingers,
            Shell.ActionMode.NORMAL,
            Clutter.Orientation.HORIZONTAL,
            false
        );
        horizontalHandlers = connectShowDesktopSwipe(
            horizontalTracker,
            delta => {
                // Positive delta: fingers moved right.
                showDesktopForDelta(toggle, delta);
            }
        );
    }

    return {
        destroy() {
            verticalHandlers?.forEach(handle =>
                verticalTracker?.disconnect(handle)
            );
            verticalTracker?.destroy();

            horizontalHandlers?.forEach(handle =>
                horizontalTracker?.disconnect(handle)
            );
            horizontalTracker?.destroy();
        },
    };
}
