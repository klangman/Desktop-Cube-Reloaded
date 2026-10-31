// Desktop Cube Reloaded - a Cinnamon port of the GNOME Desktop Cube extension.
//
// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de> (original GNOME extension)
// SPDX-FileCopyrightText: Kevin Langman (Cinnamon port)
// SPDX-License-Identifier: GPL-3.0-or-later
//
// How this works
// --------------
// GNOME Shell moves whole workspace groups during a switch, and the GNOME extension
// only adds 3D transforms to them. Cinnamon has no such groups: its
// WindowManager._switchWorkspace() slides each window actor on its own. So this port
// replaces that method. While the cube is visible, global.window_group is hidden and a
// scene built from clones is shown instead:
//
//   root (in Main.uiGroup, directly above global.window_group)
//   |- one "cube" per rotating monitor
//   |    '- one "face" per workspace: wallpaper, desktop layer (icons, desklets), windows
//   |- one "static" layer per monitor that does not rotate
//   |    (only when workspaces are on the primary monitor only)
//   '- an overlay with windows that stay put: sticky windows and the window being
//      moved to the new workspace
//
// The cube is described by two numbers:
//   progress  horizontal rotation, measured in workspaces. Face i is rotated by
//             (i - progress) * faceAngle around a pivot behind the screen.
//   pitch     vertical tilt in [-1, 1], times MAX_VERTICAL_ROTATION degrees.
//   zoom      extra distance in pixels, set with the scroll wheel while dragging
//             (positive = closer). This is our own addition, not in the GNOME version.
//
// The cube is shown in three situations ("modes"):
//   switch    Muffin switched workspaces (e.g. Ctrl+Alt+Arrow); we animate to it.
//   drag      The user is dragging a panel; the cube follows the mouse.
//   settle    The drag ended; we animate to the nearest workspace and then activate it.
//
// Pushing a window that is being dragged against the left or right screen edge
// switches to the next workspace and takes the window along (see EdgeSwitch).

const Clutter = imports.gi.Clutter;
const Cogl = imports.gi.Cogl;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Graphene = imports.gi.Graphene;
const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const Settings = imports.ui.settings;

// Workspaces are laid out in a single row, so vertical switches are left to Cinnamon.
const NOOP_DIRECTIONS = [Meta.MotionDirection.UP, Meta.MotionDirection.DOWN];

// Maximum degrees the cube can be tilted up and down (same as the GNOME extension).
const MAX_VERTICAL_ROTATION = 50;

// Spacing to the screen sides of the tilted cube (same as the GNOME extension).
const PADDING_V_ROTATION = 0.2;

// Pixels the mouse has to move before a press on a panel turns into a drag.
const DRAG_THRESHOLD = 8;

// Name of the hold-to-rotate keybinding registered with Cinnamon.
const SHORTCUT_NAME = 'desktop-cube-reloaded-rotate';

// Scroll zoom, as fractions of the monitor width: per wheel click, and the limits.
const ZOOM_STEP = 0.1;
const MAX_ZOOM_IN = 0.3;
const MAX_ZOOM_OUT = 3.0;

let desktopCube = null;

class DesktopCube {
  constructor(metadata) {
    this._meta = metadata;
    this._anim = null;
    this._drag = null;
  }

  // ------------------------------------------------------------------------ lifecycle

  enable() {
    this._settings = new Settings.ExtensionSettings(this, this._meta.uuid);

    // The About tab of the settings dialog shows this.
    this._settings.setValue('ext-version', this._meta.version);

    // _switchWorkspace normally lives on WindowManager.prototype. Cinnamon connects
    // 'switch-workspace' with an arrow function that calls this._switchWorkspace(), so
    // shadowing the method on the Main.wm instance is enough to take it over.
    this._hadOwnSwitch = Object.prototype.hasOwnProperty.call(Main.wm, '_switchWorkspace');
    this._origSwitch = Main.wm._switchWorkspace;
    // Muffin waits for completed_switch_workspace() after every switch, so an error in
    // our code must never leave a switch uncompleted.
    this._hook = (cinnamonwm, from, to, direction) => {
      this._switchCounted = false;
      try {
        this._switchWorkspace(cinnamonwm, from, to, direction);
      } catch (e) {
        global.logError(`${this._meta.uuid}: workspace switch failed: ${e}\n${e.stack}`);
        this._finish();
        if (!this._switchCounted) {
          cinnamonwm.completed_switch_workspace();
        }
      }
    };
    Main.wm._switchWorkspace = this._hook;

    // Rotating the cube with the mouse: by dragging a panel, or while holding a shortcut.
    this._drag = new DragController(this);
    this._settings.bind('cube-shortcut', 'cubeShortcut', () => this._updateShortcut());
    this._updateShortcut();

    // Remember which window the user is dragging around; it stays in front of the cube.
    this._draggedWindow = null;
    // Muffin's grab-op-begin passes the display again as its first argument, so the
    // handler gets (emitter, display, window, op) - unlike GNOME's (display, window, op).
    this._grabBeginID = global.display.connect('grab-op-begin', (emitter, display, window, op) => {
      if (op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING) {
        this._draggedWindow = window;
      }
    });
    this._grabEndID = global.display.connect('grab-op-end', () => {
      this._draggedWindow = null;
    });

    this._edgeSwitch = new EdgeSwitch(this);

    this._skybox = null;
    this._settings.bind('enable-panorama', 'enablePanorama', () => this._updateSkybox());
    this._settings.bind('background-panorama', 'backgroundPanorama',
                        () => this._updateSkybox());
    this._updateSkybox();
  }

  disable() {
    Main.keybindingManager.removeHotKey(SHORTCUT_NAME);
    this._drag.destroy();
    this._drag = null;
    this._edgeSwitch.destroy();
    this._edgeSwitch = null;
    global.display.disconnect(this._grabBeginID);
    global.display.disconnect(this._grabEndID);
    this._draggedWindow = null;
    this._finish();

    if (this._skybox) {
      this._skybox.destroy();
      this._skybox = null;
    }

    if (Main.wm._switchWorkspace === this._hook) {
      if (this._hadOwnSwitch) {
        Main.wm._switchWorkspace = this._origSwitch;
      } else {
        delete Main.wm._switchWorkspace;
      }
    }
    this._hook = null;
    this._origSwitch = null;

    if (this._settings) {
      this._settings.finalize();
      this._settings = null;
    }
  }

  // (Re)loads the panorama when its settings change. The cube shown right now (if any)
  // keeps its old background; the new one is used from the next rotation on.
  _updateSkybox() {
    if (this._skybox) {
      if (this._anim && this._skybox.actor.get_parent() === this._anim.root) {
        this._anim.root.remove_child(this._skybox.actor);
      }
      this._skybox.destroy();
      this._skybox = null;
    }

    const file = this._settings.getValue('background-panorama');
    if (this._settings.getValue('enable-panorama') && file) {
      this._skybox = new Skybox(file, this._meta.uuid);
    }
  }

  // (Re)registers the hold-to-rotate shortcut. The binding passed to the callback tells
  // us which modifiers the user has to keep holding.
  _updateShortcut() {
    Main.keybindingManager.removeHotKey(SHORTCUT_NAME);
    const shortcut = this._settings.getValue('cube-shortcut');
    if (shortcut) {
      Main.keybindingManager.addHotKey(SHORTCUT_NAME, shortcut, (...args) => {
        const binding = args.find(arg => arg && typeof arg.get_mask === 'function');
        this._drag.startFromShortcut(binding ? binding.get_mask() : 0);
      });
    }
  }


  // ------------------------------------------------------------ workspace switching

  _switchWorkspace(cinnamonwm, from, to, direction) {
    const nWorkspaces = global.workspace_manager.get_n_workspaces();

    // We activated this workspace ourselves at the end of a drag, while the cube still
    // covers the screen. The cube is already showing it; just finish together with it.
    if (this._anim && (this._anim.absorbSwitch || this._anim.mode === 'drag')) {
      this._anim.pending++;
      this._switchCounted = true;
      this._playSwitchFeedback();
      return;
    }

    // Leave everything we don't handle to Cinnamon's own implementation. That includes
    // the case where animations are off, which Cinnamon handles by completing at once.
    const useCube = Main.animations_enabled && !Main.modalCount && nWorkspaces > 1 &&
      from !== to && !NOOP_DIRECTIONS.includes(direction);

    if (!useCube) {
      this._finish();
      this._switchCounted = true;   // Cinnamon's own code completes it.
      this._origSwitch.call(Main.wm, cinnamonwm, from, to, direction);
      return;
    }

    this._playSwitchFeedback();

    // A workspace was added or removed while the cube was shown; it is outdated.
    if (this._anim && this._anim.nWorkspaces !== nWorkspaces) {
      this._finish();
    }

    // If the cube is still moving, continue from where it is right now.
    const base = this._anim ? this._nearestEquivalent(from, this._anim.progress) : from;
    const target = base + this._getSteps(from, to, nWorkspaces);

    this._ensureScene(from);
    this._anim.mode = 'switch';
    this._anim.pending++;   // Muffin counts switches; each needs a completion call.
    this._switchCounted = true;
    this._animateTo(target, this._settings.getValue('animation-time'));
  }

  _playSwitchFeedback() {
    if (Main.soundManager) {
      Main.soundManager.play('switch');
    }
    Main.wm.showWorkspaceOSD();
  }

  // How many workspaces the cube turns, signed (positive = to the right).
  _getSteps(from, to, n) {
    // With the gap there is no wrap-around: we always rotate through the workspaces in
    // between, exactly like the GNOME extension.
    if (this._settings.getValue('last-first-gap')) {
      return to - from;
    }

    // A closed cube takes the shortest way. Muffin derives the direction from the
    // workspace positions, so it can't tell us that the user wrapped around.
    let steps = ((to - from) % n + n) % n;
    if (steps > n / 2) {
      steps -= n;
    }
    return steps;
  }

  // On a closed cube, progress values that differ by a multiple of n show the same
  // workspace. Returns the one for workspace `index` that is closest to `progress`.
  _nearestEquivalent(index, progress) {
    if (this._settings.getValue('last-first-gap')) {
      return index;
    }
    const n = this._anim.nWorkspaces;
    return index + n * Math.round((progress - index) / n);
  }

  // ----------------------------------------------------------------------- dragging

  // Called by DragController when a drag starts. Returns false if the cube can't be
  // shown.
  beginDrag() {
    const nWorkspaces = global.workspace_manager.get_n_workspaces();
    if (nWorkspaces < 2) {
      return false;
    }
    if (this._anim && this._anim.nWorkspaces !== nWorkspaces) {
      this._finish();
    }

    // If a switch animation is still running, grab the cube where it is.
    this._ensureScene(global.workspace_manager.get_active_workspace_index());
    this._anim.timeline.stop();
    this._anim.mode = 'drag';
    this._anim.dragStartProgress = this._nearestEquivalent(
      global.workspace_manager.get_active_workspace_index(), this._anim.progress);
    return true;
  }

  // Esc during a drag: go back to the workspace the drag started on.
  cancelDrag() {
    const anim = this._anim;
    if (!anim || anim.mode !== 'drag') {
      return;
    }
    anim.mode = 'settle';
    this._animateTo(anim.dragStartProgress, this._settings.getValue('animation-time'));
  }

  // deltaX is the horizontal mouse movement in pixels, pitch is in [-1, 1].
  updateDrag(deltaX, pitch) {
    const anim = this._anim;
    if (!anim || anim.mode !== 'drag') {
      return;
    }

    // Same as the GNOME extension: one workspace per screen width (divided by the
    // speed setting), and faster while the cube is tilted so you can spin it quickly.
    const speed = this._settings.getValue('mouse-rotation-speed');
    const width = Main.layoutManager.primaryMonitor.width;
    const tiltBoost = 1 + (anim.nWorkspaces - 1) * Math.abs(pitch);

    anim.progress = this._clampProgress(anim.progress - deltaX * speed * tiltBoost / width);
    anim.pitch = Math.max(-1, Math.min(1, pitch));
    this._updateCubes();
  }

  // Scroll wheel during a drag. steps > 0 zooms in, steps < 0 zooms out; smooth
  // scrolling gives fractional steps.
  zoomDrag(steps) {
    const anim = this._anim;
    if (!anim || anim.mode !== 'drag') {
      return;
    }
    const width = Main.layoutManager.primaryMonitor.width;
    anim.zoom = Math.max(-MAX_ZOOM_OUT * width,
                         Math.min(MAX_ZOOM_IN * width, anim.zoom + steps * ZOOM_STEP * width));
    this._updateCubes();
  }

  // velocity is in workspaces per millisecond, used to "throw" the cube.
  endDrag(velocity) {
    const anim = this._anim;
    if (!anim || anim.mode !== 'drag') {
      return;
    }

    const thrown = anim.progress + Math.max(-0.5, Math.min(0.5, velocity * 150));
    const target = this._clampProgress(Math.round(thrown));

    anim.mode = 'settle';
    const duration = Math.max(this._settings.getValue('animation-time'),
                              500 * Math.abs(anim.pitch));
    this._animateTo(target, duration);
  }

  _clampProgress(progress) {
    if (this._settings.getValue('last-first-gap')) {
      return Math.max(0, Math.min(this._anim.nWorkspaces - 1, progress));
    }
    return progress;
  }

  // ---------------------------------------------------------------------- animation

  // Shows the cube, facing workspace `index`, unless it is already shown.
  _ensureScene(index) {
    if (this._anim) {
      return;
    }

    const timeline = this._createTimeline();
    timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
    const cinnamonwm = global.window_manager;

    this._anim = {
      mode: 'switch',
      nWorkspaces: global.workspace_manager.get_n_workspaces(),
      pending: 0,
      absorbSwitch: false,
      progress: index,
      pitch: 0,
      zoom: 0,
      start: {progress: index, pitch: 0, zoom: 0},
      target: {progress: index, pitch: 0, zoom: 0},
      timeline: timeline,
      cubes: [],
      root: null,
    };

    // If building the scene fails half way, undo whatever was done.
    try {
      this._buildScene();
    } catch (e) {
      this._finish();
      throw e;
    }

    // Errors in the per-frame code end the animation instead of leaving the cube up.
    const guard = (what, func) => () => {
      try {
        func();
      } catch (e) {
        global.logError(`${this._meta.uuid}: ${what} failed: ${e}\n${e.stack}`);
        this._finish();
      }
    };

    const anim = this._anim;
    anim.newFrameID = timeline.connect('new-frame', guard('animation frame', () => {
      const t = timeline.get_progress();
      anim.progress = anim.start.progress + (anim.target.progress - anim.start.progress) * t;
      anim.pitch = anim.start.pitch + (anim.target.pitch - anim.start.pitch) * t;
      anim.zoom = anim.start.zoom + (anim.target.zoom - anim.start.zoom) * t;
      this._updateCubes();
    }));
    anim.completedID = timeline.connect('completed',
                                        guard('animation end', () => this._onAnimationDone()));

    // Muffin can ask us to abort, e.g. when a window is mapped during the switch.
    anim.killID = cinnamonwm.connect('kill-switch-workspace', () => {
      if (anim.mode === 'switch') {
        this._finish();
      }
    });

    this._updateCubes();
  }

  // Newer Clutter versions drive timelines from a frame clock and want an actor;
  // older ones (Cinnamon 6.0 and 6.2) don't have that property at all.
  _createTimeline() {
    try {
      return new Clutter.Timeline({duration: 1000, actor: global.stage});
    } catch (e) {
      return new Clutter.Timeline({duration: 1000});
    }
  }

  // Animates from the current position to the given progress, and back to zero pitch
  // and zoom.
  _animateTo(progress, duration) {
    const anim = this._anim;
    anim.start = {progress: anim.progress, pitch: anim.pitch, zoom: anim.zoom};
    anim.target = {progress: progress, pitch: 0, zoom: 0};

    const timeline = anim.timeline;
    timeline.stop();
    timeline.set_duration(Math.max(50, Math.round(duration)));
    timeline.rewind();
    timeline.start();
  }

  _onAnimationDone() {
    const anim = this._anim;
    if (!anim) {
      return;
    }

    // After a drag, the cube has turned to some workspace; now make it the real one.
    // This emits 'switch-workspace' right away, which _switchWorkspace absorbs.
    if (anim.mode === 'settle') {
      const n = anim.nWorkspaces;
      const index = ((Math.round(anim.target.progress) % n) + n) % n;
      const workspace = global.workspace_manager.get_workspace_by_index(index);
      if (workspace && index !== global.workspace_manager.get_active_workspace_index()) {
        anim.absorbSwitch = true;
        workspace.activate(global.get_current_time());
        anim.absorbSwitch = false;
      }
    }

    this._finish();
  }

  // Hides the cube, if shown, and restores the real windows. This also cleans up after
  // a scene that failed half way, so each step checks what actually happened and
  // errors in one step don't prevent the others.
  _finish() {
    const anim = this._anim;
    if (!anim) {
      return;
    }
    this._anim = null;

    const step = (func) => {
      try {
        func();
      } catch (e) {
        global.logError(`${this._meta.uuid}: cleanup failed: ${e}`);
      }
    };

    step(() => {
      if (anim.newFrameID) {
        anim.timeline.disconnect(anim.newFrameID);
      }
      if (anim.completedID) {
        anim.timeline.disconnect(anim.completedID);
      }
      anim.timeline.stop();
    });
    step(() => {
      if (anim.killID) {
        global.window_manager.disconnect(anim.killID);
      }
    });

    // The skybox is kept between rotations, so take it out before destroying the scene.
    step(() => {
      if (this._skybox && anim.root && this._skybox.actor.get_parent() === anim.root) {
        anim.root.remove_child(this._skybox.actor);
      }
    });
    step(() => {
      if (anim.root) {
        anim.root.destroy();
      }
    });
    step(() => global.window_group.show());
    step(() => {
      if (anim.unredirectDisabled) {
        Meta.enable_unredirect_for_display(global.display);
      }
    });
    Main.wm._movingWindow = undefined;

    for (let i = 0; i < anim.pending; i++) {
      step(() => global.window_manager.completed_switch_workspace());
    }
  }


  // ---------------------------------------------------------------- building the scene

  _buildScene() {
    const anim = this._anim;
    const monitors = Main.layoutManager.monitors;
    const primary = Main.layoutManager.primaryIndex;
    // Same check Cinnamon uses for its workspace OSD.
    const onlyPrimary = Main.wm.wm_settings.get_boolean('workspaces-only-on-primary');
    const isRotating = (index) => !onlyPrimary || index === primary;

    const root = new Clutter.Actor({
      name: 'desktop-cube-reloaded',
      width: global.screen_width,
      height: global.screen_height,
    });
    anim.root = root;

    // The panorama, if any, is painted first, behind everything else.
    if (this._skybox && this._skybox.ready) {
      root.add_child(this._skybox.actor);
      this._skybox.placeAtCamera(this._getCamera());
    }

    // Per monitor: either a cube with one face per workspace, or a single static layer.
    const layers = monitors.map((monitor, index) => {
      if (isRotating(index)) {
        const cube = new Clutter.Actor({
          x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
        });
        const faces = [];
        for (let i = 0; i < anim.nWorkspaces; i++) {
          const face = this._createFace(monitor);
          cube.add_child(face);
          faces.push(face);
        }
        root.add_child(cube);
        anim.cubes.push({monitor: monitor, monitorIndex: index, actor: cube, faces: faces});
        return {faces: faces};
      }

      const layer = this._createFace(monitor);
      layer.set_position(monitor.x, monitor.y);
      root.add_child(layer);
      return {faces: [layer]};
    });

    const overlay = new Clutter.Actor();
    root.add_child(overlay);

    // Sort clones of all window actors into the layers. get_window_actors() is in
    // stacking order, so adding them in this order keeps it.
    anim.followers = [];

    global.get_window_actors().forEach(actor => {
      const window = actor.meta_window;
      if (!window) {
        return;
      }

      const type = window.get_window_type();
      if (type === Meta.WindowType.OVERRIDE_OTHER || !window.showing_on_its_workspace()) {
        return;
      }

      const monitorIndex = Math.max(0, window.get_monitor());
      const monitor = monitors[monitorIndex] || monitors[primary];
      const layer = layers[monitorIndex] || layers[primary];

      // Desktop icons go on the face's flat desktop layer, everything else floats.
      const isDesktop = type === Meta.WindowType.DESKTOP;
      const addTo = (face, offsetX, offsetY) => {
        const parent = isDesktop ? face._desktop : face._windows;
        parent.add_child(new Clutter.Clone({
          source: actor,
          x: actor.x - offsetX,
          y: actor.y - offsetY,
        }));
      };

      // On a static monitor everything simply stays where it is.
      if (!isRotating(monitorIndex)) {
        addTo(layer.faces[0], monitor.x, monitor.y);
        return;
      }

      // The window being dragged to the new workspace, and windows on all workspaces,
      // don't rotate. This matches what Cinnamon's own animation does.
      const moving = window === Main.wm._movingWindow || window === this._draggedWindow;
      if (moving || (!isDesktop && window.is_on_all_workspaces())) {
        const clone = new Clutter.Clone({source: actor, x: actor.x, y: actor.y});
        overlay.add_child(clone);
        // A window that is dragged with the mouse keeps moving during the rotation.
        if (moving) {
          anim.followers.push({clone, actor});
        }
        return;
      }

      // Nemo's desktop window is on all workspaces; give every face a copy.
      if (isDesktop) {
        layer.faces.forEach(face => addTo(face, monitor.x, monitor.y));
        return;
      }

      const workspace = window.get_workspace();
      const face = workspace ? layer.faces[workspace.index()] : null;
      if (face) {
        addTo(face, monitor.x, monitor.y);
      }
    });

    // Desklets are on every workspace and live in a container that Muffin keeps inside
    // global.window_group, so they would vanish with it. Every face gets a copy of each
    // desklet on its desktop layer, above the desktop icons, flat on the wallpaper. We
    // clone the desklets one by one and measure their positions now, while they are
    // still mapped.
    //
    // Blur Cinnamon puts its blurred desklet backgrounds into the same container
    // (tagged with _blurCinnamonName). Their blur samples the screen behind them, which
    // doesn't work on a rotated copy and shows up as a large box, so we leave them out.
    // During the rotation the desklets are therefore drawn without blur.
    const container = global.desklet_container;
    const desklets = (container && global.window_group.contains(container)) ?
      container.get_children().filter(d => d.visible && d._blurCinnamonName === undefined) :
      [];
    const deskletPositions = desklets.map(d => d.get_transformed_position());

    layers.forEach((layer, index) => {
      const monitor = monitors[index];
      layer.faces.forEach(face => {
        desklets.forEach((desklet, k) => {
          const [x, y] = deskletPositions[k];
          face._desktop.add_child(new Clutter.Clone({
            source: desklet,
            x: x - monitor.x,
            y: y - monitor.y,
          }));
        });
      });
    });

    // Remember each clone's place in the stacking order. The children get reordered
    // for depth sorting later, but the topmost window must stay closest to the viewer.
    anim.cubes.forEach(cube => cube.faces.forEach(face => {
      const windows = face._windows.get_children();
      windows.forEach((clone, j) => {
        clone._depthFactor = (j + 1) / windows.length;
      });
    }));

    // Cinnamon draws a black stage background behind uiGroup, which is what shows
    // around the cube once the windows are hidden. Normally the cube goes right above
    // the window group, below the panels.
    //
    // To hide the panels, we don't touch them at all: fading them out made parts of
    // the cube flicker. Instead the cube goes above them, on a black backdrop that
    // covers each monitor where it rotates.
    let below = global.window_group;
    if (this._settings.getValue('hide-panels')) {
      anim.cubes.slice().reverse().forEach(cube => {
        const m = cube.monitor;
        root.insert_child_at_index(new Clutter.Actor({
          x: m.x, y: m.y, width: m.width, height: m.height,
          background_color: new Clutter.Color({red: 0, green: 0, blue: 0, alpha: 255}),
        }), 0);
      });
      below = this._getTopmostPanelActor() || below;
    }
    Main.uiGroup.insert_child_above(root, below);
    Meta.disable_unredirect_for_display(global.display);
    anim.unredirectDisabled = true;
    global.window_group.hide();
  }

  // Returns the panel actor that is highest in Main.uiGroup, or null.
  _getTopmostPanelActor() {
    if (!Main.panelManager) {
      return null;
    }
    const children = Main.uiGroup.get_children();
    let topmost = null;
    let topIndex = children.indexOf(global.window_group);
    Main.panelManager.getPanels().forEach(panel => {
      const index = panel ? children.indexOf(panel.actor) : -1;
      if (index > topIndex) {
        topIndex = index;
        topmost = panel.actor;
      }
    });
    return topmost;
  }

  // A face is a monitor-sized actor holding a clipped background and the window clones.
  _createFace(monitor) {
    const face = new Clutter.Actor({width: monitor.width, height: monitor.height});

    const backgroundHolder = new Clutter.Actor({
      width: monitor.width,
      height: monitor.height,
      clip_to_allocation: true,
    });
    const background = this._createBackground();
    if (background) {
      background.set_position(-monitor.x, -monitor.y);
      backgroundHolder.add_child(background);
    }
    face.add_child(backgroundHolder);
    face._background = backgroundHolder;

    // Desktop icons and desklets: these stay flat on the wallpaper.
    face._desktop = new Clutter.Actor();
    face.add_child(face._desktop);

    // Windows: these float in front of the face while the cube rotates.
    face._windows = new Clutter.Actor();
    face.add_child(face._windows);
    face._frontFacing = true;

    return face;
  }

  // Returns an actor that draws the wallpaper for the whole screen, or null.
  _createBackground() {
    try {
      // Newer Cinnamon versions have a helper that also works on Wayland.
      if (typeof Main.createFullScreenBackground === 'function') {
        return Main.createFullScreenBackground();
      }
      if (!Meta.is_wayland_compositor()) {
        return Meta.X11BackgroundActor.new_for_display(global.display);
      }
    } catch (e) {
      global.logError(`${this._meta.uuid}: could not create background: ${e}`);
    }
    return null;
  }

  // ------------------------------------------------------------------- per-frame update

  _updateCubes() {
    const anim = this._anim;

    const progress = anim.progress;
    const pitch = anim.pitch;
    const faceAngle = this._getFaceAngle(anim.nWorkspaces);
    const camera = this._getCamera();

    anim.followers.forEach(f => f.clone.set_position(f.actor.x, f.actor.y));

    if (this._skybox && this._skybox.actor.get_parent() === anim.root) {
      this._skybox.setRotation(progress, pitch, anim.nWorkspaces);
    }

    anim.cubes.forEach(cube => {
      const monitor = cube.monitor;
      const centerDepth = this._getCenterDist(monitor.width, faceAngle);
      const [depthOffset, explode] =
        this._getExplodeFactors(progress, pitch, centerDepth, monitor);

      // Vertical tilt and zoom are applied to the whole cube.
      cube.actor.set_pivot_point(0.5, 0.5);
      cube.actor.pivot_point_z = -centerDepth;
      cube.actor.rotation_angle_x = pitch * MAX_VERTICAL_ROTATION;
      cube.actor.translation_z = anim.zoom;

      cube.faces.forEach((face, i) => {
        const angle = this._normalizeAngle((i - progress) * faceAngle);

        face.set_pivot_point(0.5, 0.5);
        face.pivot_point_z = -centerDepth;
        face.rotation_angle_y = angle;
        face.translation_z = -depthOffset;

        // The wallpaper fades out while the cube is tilted, so you can see inside it.
        face._background.opacity = Math.round(255 * (1.0 - Math.abs(pitch)));

        // Spread the windows between the face and `explode` pixels in front of it. The
        // topmost window ends up closest to the viewer.
        face._windows.get_children().forEach(clone => {
          clone.translation_z = explode * clone._depthFactor;
        });
      });

      // Clutter has no depth buffer here, so paint order is depth order. Within a face,
      // the windows are parallel planes: painting them in stacking order is right when
      // the face is seen from the front, and has to be reversed when seen from behind.
      cube.faces.forEach(face => {
        const frontFacing = this._isFrontFacing(face, camera);
        if (frontFacing !== face._frontFacing) {
          face._frontFacing = frontFacing;
          this._reverseChildren(face);
          this._reverseChildren(face._windows);
        }
      });

      // Faces that are rotated further away are painted first.
      const sorted = cube.faces.slice().sort((a, b) =>
        Math.abs(b.rotation_angle_y) - Math.abs(a.rotation_angle_y));
      sorted.forEach((face, k) => cube.actor.set_child_at_index(face, k));
    });
  }

  _reverseChildren(actor) {
    actor.get_children().reverse().forEach((child, k) => actor.set_child_at_index(child, k));
  }

  // Whether the camera sees the front side of the face. We transform the face's center
  // and a point one pixel in front of it to stage coordinates; the face is front facing
  // if the camera is on the side that point lies on.
  _isFrontFacing(face, camera) {
    const x = face.width / 2;
    const y = face.height / 2;
    const a = face.apply_relative_transform_to_point(null, new Graphene.Point3D({x, y, z: 0}));
    const b = face.apply_relative_transform_to_point(null, new Graphene.Point3D({x, y, z: 1}));
    return (camera.x - a.x) * (b.x - a.x) + (camera.y - a.y) * (b.y - a.y) +
      (camera.z - a.z) * (b.z - a.z) > 0;
  }

  // ------------------------------------------------- cube geometry (from the GNOME code)

  // The angle between consecutive workspaces.
  _getFaceAngle(faceCount) {
    // With the gap the "cube" only covers 180° (90° for two workspaces), so it doesn't
    // look like you could rotate from the last to the first workspace.
    if (this._settings.getValue('last-first-gap')) {
      return (faceCount === 2 ? 90 : 180) / (faceCount - 1);
    }
    return 360.0 / faceCount;
  }

  // The z-distance from the cube faces to the rotation pivot.
  _getCenterDist(workspaceWidth, faceAngle) {
    let centerDepth = workspaceWidth / 2;
    if (faceAngle < 180) {
      centerDepth /= Math.tan(faceAngle * 0.5 * Math.PI / 180);
    }
    return centerDepth;
  }

  // Maps an angle to (-180, 180]. Needed because a closed cube can be rotated past the
  // last workspace, which would otherwise break the depth sorting.
  _normalizeAngle(angle) {
    let a = ((angle % 360) + 360) % 360;
    return a > 180 ? a - 360 : a;
  }

  _getFovy() {
    try {
      return global.stage.perspective.fovy || 60;
    } catch (e) {
      return 60;
    }
  }

  // Position of Clutter's virtual camera in stage coordinates: centered in front of
  // the stage, at the distance where the stage exactly fills the field of view.
  _getCamera() {
    const fovy = this._getFovy();
    return {
      x: global.screen_width / 2,
      y: global.screen_height / 2,
      z: global.screen_height / (2 * Math.tan(fovy / 2 * Math.PI / 180)),
      fovy: fovy,
    };
  }

  // While rotating, the cube moves back and the windows float in front of the faces.
  // Both effects are zero when facing a workspace. They are small for horizontal
  // rotations, so switching isn't obtrusive, and strong when the cube is tilted.
  // Returns [depthOffset, explode] in pixels.
  _getExplodeFactors(progress, pitch, centerDepth, monitor) {
    // 0 when facing a workspace, 1 when looking at an edge / when fully tilted.
    const fraction = ((progress % 1) + 1) % 1;
    const hFactor = 1.0 - 2.0 * Math.abs(fraction - 0.5);
    const vFactor = Math.abs(pitch);

    // Horizontal: move back far enough that the cube's corners stay behind the screen
    // plane. The topmost window then stays at a constant depth.
    const cornerDist = Math.sqrt(Math.pow(centerDepth, 2) + Math.pow(monitor.width / 2, 2));
    const hDepthOffset =
      this._settings.getValue('window-parallax') * (cornerDist - centerDepth);
    const hExplode = hDepthOffset;

    // Vertical: move back far enough to see the whole cube, and let the windows float
    // up to half a screen in front of their faces.
    const vExplode = this._settings.getValue('do-explode') ?
      Math.max(monitor.width, monitor.height) / 2 : 0;
    const diameter = 2 * (vExplode + centerDepth);
    const camDist = monitor.height / (2 * Math.tan(this._getFovy() / 2 * Math.PI / 180));
    const vDepthOffset =
      (1 + PADDING_V_ROTATION) * diameter * camDist / monitor.width - centerDepth;

    return [
      Math.max(hFactor * hDepthOffset, vFactor * vDepthOffset),
      Math.max(hFactor * hExplode, vFactor * vExplode),
    ];
  }
}

// -------------------------------------------------------------------- panorama skybox

// Draws a 360° panorama (equirectangular projection, usually 2:1) around the cube.
//
// The GNOME extension draws it with a fragment shader that computes a view ray per
// pixel. Cinnamon's shader classes can't bind a texture of our own in any released
// version (CinnamonGLSLEffect only gained get_pipeline() after 6.6), so we use a
// classic cube map instead: the panorama is resampled once into the six faces of a
// cube centered on Clutter's camera. Seen from the center, flat cube faces show the
// panorama exactly, with no seams and no approximation.
//
// The resampling uses the same mapping from direction to image as the GNOME shader,
// and the same yaw/pitch conventions, so a panorama looks the same as it does there:
//   u = 0.5 + 0.5 * atan2(view.x, -view.z) / pi,  v = acos(view.y) / pi
//   (view space: x right, y up, looking along -z; stage space has y pointing down)
//
// Actor tree (all rotations are around each actor's origin):
//   actor  - positioned at the camera
//    tilt  - rotation_angle_x = cube pitch
//     spin - rotation_angle_y = -yaw
//      faces - one per cube side, rotated to face front/right/back/left/top/bottom
//       tiles - SKY_FACE_TILES x SKY_FACE_TILES per face, SKY_RADIUS from the camera
//
// The cube surrounds the camera, so many tiles are beside or behind it. Clutter does
// not cope well with geometry at or behind the camera plane, so only tiles that lie
// completely in front of the camera and within the field of view are shown.
//
// Resampling a large panorama takes a few seconds, so the image is decoded
// asynchronously and the cube faces are then computed a few rows at a time from an
// idle callback, keeping Cinnamon responsive. The panorama is used once all six faces
// exist.
//
// The finished faces are saved as PNG files in ~/.cache/desktop-cube-reloaded/<key>/,
// where the key depends on the panorama's path, size and modification time. Next time
// (e.g. after logging in), the faces are simply loaded from there. Only the cache for
// the current panorama is kept.
const SKY_FACE_TILES = 8;
const SKY_MAX_FACE_SIZE = 2048;
const SKY_RADIUS = 500;
const SKY_BUILD_SLICE_US = 8000;   // Time spent computing faces per idle callback.
const SKY_CACHE_VERSION = 1;       // Bump when the face format or projection changes.
const SKY_CACHE_DIR = 'desktop-cube-reloaded';

// The six cube faces, as Clutter rotations of the front face (which looks along -z).
const SKY_FACES = [
  {rx: 0, ry: 0},      // front
  {rx: 0, ry: -90},    // right
  {rx: 0, ry: 180},    // back
  {rx: 0, ry: 90},     // left
  {rx: -90, ry: 0},    // top
  {rx: 90, ry: 0},     // bottom
];

// Rotations with the same conventions as Clutter's rotation_angle_x/y (in degrees).
function rotateX(degrees, [x, y, z]) {
  const c = Math.cos(degrees * Math.PI / 180);
  const s = Math.sin(degrees * Math.PI / 180);
  return [x, c * y - s * z, s * y + c * z];
}

function rotateY(degrees, [x, y, z]) {
  const c = Math.cos(degrees * Math.PI / 180);
  const s = Math.sin(degrees * Math.PI / 180);
  return [c * x + s * z, y, -s * x + c * z];
}

function normalize([x, y, z]) {
  const length = Math.sqrt(x * x + y * y + z * z);
  return [x / length, y / length, z / length];
}

class Skybox {
  constructor(file, uuid) {
    this._uuid = uuid;
    this.ready = false;
    this._destroyed = false;
    this._idleID = 0;
    this._tiles = [];      // {actor, center, corners}: unit directions before rotation.
    this._faceActors = [];
    this._cosCone = 0;

    this.actor = new Clutter.Actor({name: 'desktop-cube-reloaded-skybox'});
    this._tilt = new Clutter.Actor();
    this._spin = new Clutter.Actor();
    this.actor.add_child(this._tilt);
    this._tilt.add_child(this._spin);

    this._load(file);
  }

  destroy() {
    this._destroyed = true;
    if (this._idleID) {
      GLib.source_remove(this._idleID);
      this._idleID = 0;
    }
    this._source = null;
    this.actor.destroy();
  }

  // Puts the center of the cube at the camera position (in stage coordinates), and
  // works out the field of view: half the screen diagonal plus a margin for the tile
  // size.
  placeAtCamera(camera) {
    this.actor.set_position(camera.x, camera.y);
    this.actor.translation_z = camera.z;

    const aspect = global.screen_width / global.screen_height;
    const halfFovy = camera.fovy / 2 * Math.PI / 180;
    const halfDiagonal = Math.atan(Math.tan(halfFovy) * Math.sqrt(1 + aspect * aspect));
    const cone = Math.min(halfDiagonal + 12 * Math.PI / 180, 89 * Math.PI / 180);
    this._cosCone = Math.cos(cone);
  }

  // Same as the GNOME extension: one full turn of the panorama per full turn through
  // all workspaces, and the same tilt as the cube.
  setRotation(progress, pitch, nWorkspaces) {
    const spin = -360 * progress / nWorkspaces;
    const tilt = pitch * MAX_VERTICAL_ROTATION;
    this._spin.rotation_angle_y = spin;
    this._tilt.rotation_angle_x = tilt;

    // The camera looks along -z. Show a tile if its center is within the field of view
    // and all of its corners are clearly in front of the camera.
    const turn = (dir) => rotateX(tilt, rotateY(spin, dir));
    this._tiles.forEach(tile => {
      const center = turn(tile.center);
      tile.actor.visible = -center[2] > this._cosCone &&
        tile.corners.every(corner => -turn(corner)[2] > 0.05);
    });
  }

  _load(file) {
    // The settings widget may store a URI or a plain path.
    const gfile = file.startsWith('file://') ?
      Gio.File.new_for_uri(file) : Gio.File.new_for_path(file);
    this._name = gfile.get_basename() || file;
    this._file = file;

    // Look for cached cube faces first.
    try {
      const info = gfile.query_info('time::modified,standard::size',
                                    Gio.FileQueryInfoFlags.NONE, null);
      const key = GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256,
        [SKY_CACHE_VERSION, gfile.get_uri(), info.get_attribute_uint64('time::modified'),
         info.get_size(), SKY_MAX_FACE_SIZE, SKY_FACE_TILES].join('|'),
        -1);
      this._cacheRoot = GLib.build_filenamev([GLib.get_user_cache_dir(), SKY_CACHE_DIR]);
      this._cacheDir = GLib.build_filenamev([this._cacheRoot, key]);
    } catch (e) {
      this._fail(e);
      return;
    }

    if (GLib.file_test(this._cacheFile('complete'), GLib.FileTest.EXISTS)) {
      this._loadCachedFace(0);
    } else {
      this._loadPanorama(gfile);
    }
  }

  _cacheFile(name) {
    return GLib.build_filenamev([this._cacheDir, name]);
  }

  _fail(error) {
    global.logError(`${this._uuid}: could not load panorama ${this._file}: ${error}`);
    Main.warningNotify(
      'Desktop Cube Reloaded: the panorama could not be loaded',
      `"${this._name}" could not be read as an image. Use a JPEG or PNG file. The cube is ` +
      'shown on black for now.');
  }

  // Loads face `index` from the cache, then the next one. Falls back to converting the
  // panorama again if anything is wrong with the cache.
  _loadCachedFace(index) {
    if (this._destroyed) {
      return;
    }
    if (index === SKY_FACES.length) {
      this.ready = true;
      return;
    }

    const fallback = (error) => {
      global.log(`${this._uuid}: ignoring the panorama cache: ${error}`);
      this._clearFaces();
      const file = this._file;
      this._loadPanorama(file.startsWith('file://') ?
        Gio.File.new_for_uri(file) : Gio.File.new_for_path(file));
    };

    const gfile = Gio.File.new_for_path(this._cacheFile(`face-${index}.png`));
    gfile.read_async(GLib.PRIORITY_DEFAULT, null, (obj, readResult) => {
      try {
        const stream = gfile.read_finish(readResult);
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (obj2, result) => {
          try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(result);
            if (this._destroyed) {
              return;
            }
            if (pixbuf.width !== pixbuf.height || pixbuf.width < SKY_FACE_TILES) {
              throw new Error(`face ${index} has the wrong size`);
            }
            this._addFace(index, pixbuf);
            this._loadCachedFace(index + 1);
          } catch (e) {
            fallback(e);
          }
        });
      } catch (e) {
        fallback(e);
      }
    });
  }

  // Removes any faces that were already added (used when the cache turns out broken).
  _clearFaces() {
    this._faceActors.forEach(actor => actor && actor.destroy());
    this._faceActors = [];
    this._tiles = [];
  }

  // Decodes the panorama and starts converting it into cube faces.
  _loadPanorama(gfile) {
    gfile.read_async(GLib.PRIORITY_DEFAULT, null, (obj, readResult) => {
      let stream;
      try {
        stream = gfile.read_finish(readResult);
      } catch (e) {
        this._fail(e);
        return;
      }

      GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (obj2, result) => {
        let pixbuf;
        try {
          pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(result);
        } catch (e) {
          this._fail(e);
          return;
        }
        if (this._destroyed) {
          return;
        }

        // Equirectangular panoramas are twice as wide as they are high. Anything else
        // still works, but looks stretched or squashed.
        const aspect = pixbuf.width / pixbuf.height;
        if (Math.abs(aspect - 2) > 0.05) {
          Main.warningNotify(
            'Desktop Cube Reloaded: the panorama has an unusual shape',
            `"${this._name}" is ${pixbuf.width} × ${pixbuf.height} pixels. A 360° ` +
            'panorama should be twice as wide as it is high, otherwise it looks stretched.');
        }

        try {
          // A cube face showing 90° needs about a quarter of the panorama's width. It
          // must be a multiple of the number of tiles.
          const faceSize = Math.min(SKY_MAX_FACE_SIZE, Math.round(pixbuf.width / 4));
          this._faceSize = Math.max(1, Math.round(faceSize / SKY_FACE_TILES)) *
            SKY_FACE_TILES;
          this._source = {
            pixels: pixbuf.get_pixels(),
            width: pixbuf.width,
            height: pixbuf.height,
            rowstride: pixbuf.rowstride,
            channels: pixbuf.get_n_channels(),
          };
        } catch (e) {
          this._fail(e);
          return;
        }

        this._face = 0;
        this._row = 0;
        this._facePixels = new Uint8Array(this._faceSize * this._faceSize * 3);
        this._savedFaces = 0;
        this._prepareCacheDir();

        this._idleID = GLib.idle_add(GLib.PRIORITY_LOW, () => {
          try {
            return this._convertSome();
          } catch (e) {
            this._idleID = 0;
            this._source = null;
            this._facePixels = null;
            this._fail(e);
            return GLib.SOURCE_REMOVE;
          }
        });
      });
    });
  }

  // Computes face rows until the time slice is used up. Returns whether to be called
  // again.
  _convertSome() {
    const start = GLib.get_monotonic_time();
    const size = this._faceSize;

    while (this._face < SKY_FACES.length) {
      this._convertRow(this._face, this._row);
      this._row++;

      if (this._row === size) {
        // The face is complete: show it, and save it in the background.
        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
          new GLib.Bytes(this._facePixels), GdkPixbuf.Colorspace.RGB, false, 8, size, size,
          size * 3);
        this._addFace(this._face, pixbuf);
        this._saveFace(this._face, pixbuf);

        this._face++;
        this._row = 0;
        this._facePixels = new Uint8Array(size * size * 3);
      }

      if (GLib.get_monotonic_time() - start > SKY_BUILD_SLICE_US) {
        return GLib.SOURCE_CONTINUE;
      }
    }

    // Done. Let the decoded panorama be freed; the tiles have their own pixels.
    this._idleID = 0;
    this._source = null;
    this._facePixels = null;
    this.ready = true;
    return GLib.SOURCE_REMOVE;
  }

  // Direction from the camera to a point (a, b) on the front face, both in [-1, 1] with
  // b pointing down, rotated onto the given face.
  _faceDir(face, a, b) {
    const p = [a, b, -1];
    return face.rx !== 0 ? rotateX(face.rx, p) : rotateY(face.ry, p);
  }

  // Computes one row of a face by sampling the panorama in each pixel's direction.
  _convertRow(faceIndex, row) {
    const face = SKY_FACES[faceIndex];
    const size = this._faceSize;
    const src = this._source;
    const pixels = this._facePixels;
    const b = -1 + 2 * (row + 0.5) / size;
    let out = row * size * 3;

    for (let i = 0; i < size; i++) {
      const a = -1 + 2 * (i + 0.5) / size;
      const d = this._faceDir(face, a, b);

      // Stage space to view space (y up), then the GNOME shader's mapping.
      const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      const u = 0.5 + 0.5 * Math.atan2(d[0], -d[2]) / Math.PI;
      const v = Math.acos(Math.max(-1, Math.min(1, -d[1] / len))) / Math.PI;

      this._sample(src, u, v, pixels, out);
      out += 3;
    }
  }

  // Cuts a finished face into tiles and adds them to the scene.
  _addFace(faceIndex, pixbuf) {
    const face = SKY_FACES[faceIndex];
    const faceActor = new Clutter.Actor({
      rotation_angle_x: face.rx,
      rotation_angle_y: face.ry,
    });
    this._spin.add_child(faceActor);
    this._faceActors[faceIndex] = faceActor;

    const tileSize = Math.floor(pixbuf.width / SKY_FACE_TILES);
    const step = 2 * SKY_RADIUS / SKY_FACE_TILES;

    for (let ty = 0; ty < SKY_FACE_TILES; ty++) {
      for (let tx = 0; tx < SKY_FACE_TILES; tx++) {
        const tilePixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                                                pixbuf.get_has_alpha(), 8,
                                                tileSize, tileSize);
        pixbuf.copy_area(tx * tileSize, ty * tileSize, tileSize, tileSize,
                         tilePixbuf, 0, 0);

        const image = new Clutter.Image();
        image.set_data(tilePixbuf.get_pixels(),
                       tilePixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 :
                                                    Cogl.PixelFormat.RGB_888,
                       tileSize, tileSize, tilePixbuf.rowstride);

        const tile = new Clutter.Actor({
          x: -SKY_RADIUS + tx * step,
          y: -SKY_RADIUS + ty * step,
          width: step,
          height: step,
          translation_z: -SKY_RADIUS,
          content: image,
        });
        tile.set_content_scaling_filters(Clutter.ScalingFilter.TRILINEAR,
                                         Clutter.ScalingFilter.LINEAR);
        faceActor.add_child(tile);

        // Directions to the tile's center and corners, for deciding visibility.
        const a0 = -1 + 2 * tx / SKY_FACE_TILES;
        const b0 = -1 + 2 * ty / SKY_FACE_TILES;
        const a1 = a0 + 2 / SKY_FACE_TILES;
        const b1 = b0 + 2 / SKY_FACE_TILES;
        this._tiles.push({
          actor: tile,
          center: normalize(this._faceDir(face, (a0 + a1) / 2, (b0 + b1) / 2)),
          corners: [[a0, b0], [a1, b0], [a0, b1], [a1, b1]]
            .map(([a, b]) => normalize(this._faceDir(face, a, b))),
        });
      }
    }
  }

  // Creates this panorama's cache directory and removes the caches of other panoramas.
  // The cache is only an optimization, so errors are logged and otherwise ignored.
  _prepareCacheDir() {
    try {
      GLib.mkdir_with_parents(this._cacheDir, 0o755);

      // If faces are being rewritten (the old ones were broken), the cache is not
      // complete until they are all saved again.
      const marker = Gio.File.new_for_path(this._cacheFile('complete'));
      if (GLib.file_test(marker.get_path(), GLib.FileTest.EXISTS)) {
        marker.delete(null);
      }

      const root = Gio.File.new_for_path(this._cacheRoot);
      const entries = root.enumerate_children('standard::name,standard::type',
                                              Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
      let info;
      while ((info = entries.next_file(null)) !== null) {
        const dir = root.get_child(info.get_name());
        if (dir.get_path() === this._cacheDir ||
            info.get_file_type() !== Gio.FileType.DIRECTORY) {
          continue;
        }
        const files = dir.enumerate_children('standard::name',
                                             Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let child;
        while ((child = files.next_file(null)) !== null) {
          dir.get_child(child.get_name()).delete(null);
        }
        files.close(null);
        dir.delete(null);
      }
      entries.close(null);
    } catch (e) {
      global.logError(`${this._uuid}: could not prepare the panorama cache: ${e}`);
    }
  }

  // Saves a face as PNG on a worker thread. Once all six are written, the "complete"
  // marker is created, so a half-written cache is never used.
  _saveFace(index, pixbuf) {
    try {
      const gfile = Gio.File.new_for_path(this._cacheFile(`face-${index}.png`));
      const stream = gfile.replace(null, false, Gio.FileCreateFlags.NONE, null);
      pixbuf.save_to_streamv_async(stream, 'png', ['compression'], ['3'], null,
                                   (obj, result) => {
        try {
          GdkPixbuf.Pixbuf.save_to_stream_finish(result);
          stream.close(null);
          this._savedFaces++;
          if (this._savedFaces === SKY_FACES.length) {
            GLib.file_set_contents(this._cacheFile('complete'), '');
          }
        } catch (e) {
          global.logError(`${this._uuid}: could not save the panorama cache: ${e}`);
        }
      });
    } catch (e) {
      global.logError(`${this._uuid}: could not save the panorama cache: ${e}`);
    }
  }

  // Bilinear sample of the panorama at (u, v) in [0, 1], wrapping horizontally.
  _sample(src, u, v, out, offset) {
    const fx = u * src.width - 0.5;
    const fy = Math.max(0, Math.min(src.height - 1, v * src.height - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const wx = fx - x0;
    const wy = fy - y0;
    const xa = ((x0 % src.width) + src.width) % src.width;
    const xb = (xa + 1) % src.width;
    const ya = y0;
    const yb = Math.min(src.height - 1, y0 + 1);

    const p = src.pixels;
    const c = src.channels;
    const i00 = ya * src.rowstride + xa * c;
    const i10 = ya * src.rowstride + xb * c;
    const i01 = yb * src.rowstride + xa * c;
    const i11 = yb * src.rowstride + xb * c;

    for (let k = 0; k < 3; k++) {
      const top = p[i00 + k] + (p[i10 + k] - p[i00 + k]) * wx;
      const bottom = p[i01 + k] + (p[i11 + k] - p[i01 + k]) * wx;
      out[offset + k] = top + (bottom - top) * wy;
    }
  }
}

// --------------------------------------------------------- switching at the screen edges

// While a window is dragged, pushing it against the left or right edge of the screen
// switches to the neighboring workspace. Muffin moves the dragged window along by
// itself when a workspace is activated during a move, so all we do is activate it.
//
// This is a port of the GNOME extension's edge switching, which uses GNOME's
// PressureBarrier. Cinnamon has no such class, so the pressure logic is included here.
// Unlike GNOME, we only create the barriers while a window is being dragged.
const PRESSURE_TIMEOUT = 1000;

class EdgeSwitch {
  constructor(cube) {
    this._cube = cube;
    this._barriers = [];
    this._beginID = global.display.connect('grab-op-begin', (emitter, display, window, op) => {
      if (op === Meta.GrabOp.MOVING && this._cube._settings.getValue('enable-edge-switch')) {
        this._createBarriers();
      }
    });
    this._endID = global.display.connect('grab-op-end', () => this._destroyBarriers());
  }

  destroy() {
    global.display.disconnect(this._beginID);
    global.display.disconnect(this._endID);
    this._destroyBarriers();
  }

  _createBarriers() {
    this._destroyBarriers();
    this._reset();
    this._isTriggered = false;

    const width = global.screen_width;
    const height = global.screen_height;
    const make = (x, directions, direction) => {
      const barrier = new Meta.Barrier({
        display: global.display,
        x1: x, y1: 1, x2: x, y2: height,
        directions: directions,
      });
      barrier._direction = direction;
      barrier._isHit = false;
      barrier._hitID = barrier.connect('hit', (b, event) => this._onHit(b, event));
      barrier._leftID = barrier.connect('left', (b) => this._onLeft(b));
      return barrier;
    };

    try {
      this._barriers = [
        make(0, Meta.BarrierDirection.POSITIVE_X, Meta.MotionDirection.LEFT),
        make(width, Meta.BarrierDirection.NEGATIVE_X, Meta.MotionDirection.RIGHT),
      ];
    } catch (e) {
      global.logError(`Desktop Cube Reloaded: could not create edge barriers: ${e}`);
      this._destroyBarriers();
    }
  }

  _destroyBarriers() {
    this._barriers.forEach(barrier => {
      barrier.disconnect(barrier._hitID);
      barrier.disconnect(barrier._leftID);
      barrier.destroy();
    });
    this._barriers = [];
  }

  _reset() {
    this._events = [];
    this._pressure = 0;
  }

  // Same as GNOME's PressureBarrier: sum up how far the pointer tried to move into the
  // barrier during the last second, and trigger once that exceeds the threshold.
  _onHit(barrier, event) {
    barrier._isHit = true;

    // After triggering, wait until the pointer has left the edge before triggering again.
    if (this._isTriggered) {
      return;
    }

    const threshold = this._cube._settings.getValue('edge-switch-pressure');
    const slide = Math.abs(event.dy);
    let distance = Math.abs(event.dx);

    if (distance >= threshold) {
      this._trigger(barrier);
      return;
    }

    // Ignore movements that run more along the edge than into it.
    if (slide > distance) {
      return;
    }

    this._events = this._events.filter(([time]) => event.time - time < PRESSURE_TIMEOUT);
    this._pressure = this._events.reduce((sum, [, d]) => sum + d, 0);

    distance = Math.min(15, distance);
    this._events.push([event.time, distance]);
    this._pressure += distance;

    if (this._pressure >= threshold) {
      this._trigger(barrier);
    }
  }

  _onLeft(barrier) {
    barrier._isHit = false;
    if (this._barriers.every(b => !b._isHit)) {
      this._reset();
      this._isTriggered = false;
    }
  }

  _trigger(barrier) {
    this._isTriggered = true;
    this._reset();

    const manager = global.workspace_manager;
    const n = manager.get_n_workspaces();
    const active = manager.get_active_workspace_index();
    let index = active + (barrier._direction === Meta.MotionDirection.LEFT ? -1 : 1);

    // A closed cube wraps around; with the gap we stop at the first/last workspace.
    if (index < 0 || index >= n) {
      if (this._cube._settings.getValue('last-first-gap')) {
        return;
      }
      index = (index + n) % n;
    }

    const workspace = manager.get_workspace_by_index(index);
    if (workspace) {
      workspace.activate(global.get_current_time());
    }
  }
}

// ------------------------------------------------------ rotating the cube with the mouse

// Lets the user rotate the cube with the mouse. Horizontal movement rotates, vertical
// movement tilts, and the scroll wheel zooms. There are two ways to start:
//
//   panel     Drag an empty part of any panel with the left mouse button. Releasing
//             the button snaps to the workspace in front.
//   shortcut  Hold the shortcut (Super+Alt+Space by default) and move the mouse, no
//             button needed. Releasing the shortcut's modifier keys, a click, or Enter
//             snaps to the workspace in front. This works anywhere, including over the
//             desktop, whose clicks go to Nemo and never reach Cinnamon. It is modeled
//             on Cinnamon's Alt+Tab switcher, which also ends when the modifiers are
//             released.
//
// In both cases Esc goes back to the workspace the drag started on.
//
// This plays the role of DragGesture.js in the GNOME extension. GNOME feeds the drag
// into its SwipeTracker; Cinnamon has none, so we drive the cube directly.
//
// We watch the stage's captured-event signal, which sees every event before any actor
// does. A press on an empty panel area is remembered but passed on, so panels still
// work normally. Only once the mouse has moved past a threshold do we take a modal grab
// and consume the events until the drag ends. During the drag the pointer is hidden
// and kept near the screen center, so screen edges never stop the rotation.
const DragState = {INACTIVE: 0, PENDING: 1, ACTIVE: 2};

class DragController {
  constructor(cube) {
    this._cube = cube;
    this._state = DragState.INACTIVE;
    this._source = null;       // 'panel' or 'shortcut'
    this._grabActor = null;
    this._modal = false;

    // An error here must never leave the modal grab in place, or the desktop stops
    // responding. So any error ends the drag and removes the cube.
    this._eventID = global.stage.connect('captured-event', (actor, event) => {
      try {
        return this._onEvent(event);
      } catch (e) {
        global.logError(`Desktop Cube Reloaded: drag failed: ${e}\n${e.stack}`);
        this._state = DragState.INACTIVE;
        try {
          this._ungrab();
        } catch (e2) {
          global.logError(`Desktop Cube Reloaded: could not release the grab: ${e2}`);
        }
        this._cube._finish();
        return Clutter.EVENT_PROPAGATE;
      }
    });
  }

  destroy() {
    if (this._state === DragState.ACTIVE) {
      this._ungrab();
      this._cube.endDrag(0);
    }
    this._state = DragState.INACTIVE;
    global.stage.disconnect(this._eventID);
  }

  // Called when the shortcut is pressed. `mask` holds the modifier keys the user has to
  // keep holding; 0 if the shortcut has none (then a click or Enter ends the drag).
  startFromShortcut(mask) {
    if (this._state === DragState.ACTIVE || Main.modalCount) {
      return;
    }

    const [x, y] = global.get_pointer();
    this._source = 'shortcut';
    this._mask = mask;
    this._grabActor = global.stage;
    this._startX = x;
    this._startY = y;

    if (!this._begin(global.get_current_time())) {
      return;
    }

    // Like Alt+Tab: if the modifiers were already released before we got the grab,
    // we never see the release, so check now. A quick tap just shows nothing.
    if (this._modifiersReleased()) {
      this._end(true);
    }
  }

  _modifiersReleased() {
    if (!this._mask) {
      return false;
    }
    const [, , mods] = global.get_pointer();
    return (mods & this._mask) !== this._mask;
  }

  // Returns the panel if the actor is the panel itself or one of its three zone boxes,
  // i.e. the press was not on an applet.
  _panelForActor(actor) {
    const panels = Main.panelManager ? Main.panelManager.getPanels() : [];
    return panels.find(p => p && actor &&
      [p.actor, p._leftBox, p._centerBox, p._rightBox].includes(actor));
  }

  _onEvent(event) {
    const type = event.type();

    if (this._state === DragState.INACTIVE) {
      if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1 &&
          !Main.modalCount && this._cube._settings.getValue('enable-panel-dragging') &&
          this._panelForActor(event.get_source())) {
        this._state = DragState.PENDING;
        this._source = 'panel';
        this._grabActor = this._panelForActor(event.get_source()).actor;
        [this._startX, this._startY] = event.get_coords();
      }
      return Clutter.EVENT_PROPAGATE;
    }

    if (this._state === DragState.PENDING) {
      if (type === Clutter.EventType.MOTION) {
        if ((event.get_state() & Clutter.ModifierType.BUTTON1_MASK) === 0) {
          this._state = DragState.INACTIVE;
          return Clutter.EVENT_PROPAGATE;
        }
        const [x, y] = event.get_coords();
        if (Math.abs(x - this._startX) > DRAG_THRESHOLD ||
            Math.abs(y - this._startY) > DRAG_THRESHOLD) {
          this._begin(event.get_time());
        }
      } else if (type === Clutter.EventType.BUTTON_RELEASE) {
        this._state = DragState.INACTIVE;
      }
      return Clutter.EVENT_PROPAGATE;
    }

    // ACTIVE: we own all events until the drag ends.
    const shortcut = this._source === 'shortcut';
    if (type === Clutter.EventType.MOTION) {
      this._onDragMotion(event);
    } else if (type === Clutter.EventType.SCROLL) {
      this._onDragScroll(event);
    } else if (type === Clutter.EventType.KEY_PRESS) {
      const key = event.get_key_symbol();
      if (key === Clutter.KEY_Escape) {
        this._end(true);
      } else if (shortcut && (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter)) {
        this._end(false, event.get_time());
      }
    } else if (type === Clutter.EventType.KEY_RELEASE) {
      if (shortcut && this._modifiersReleased()) {
        this._end(false, event.get_time());
      }
    } else if (type === Clutter.EventType.BUTTON_RELEASE) {
      if (!shortcut) {
        this._end(false, event.get_time());
      }
    } else if (type === Clutter.EventType.BUTTON_PRESS) {
      if (shortcut) {
        this._end(false, event.get_time());
      }
    }
    return Clutter.EVENT_STOP;
  }

  // Ends the drag: snap to the workspace in front (throwing the cube if the mouse was
  // still moving), or go back to where the drag started if cancelled.
  _end(cancelled, time = 0) {
    this._ungrab();
    this._state = DragState.INACTIVE;

    if (cancelled) {
      this._cube.cancelDrag();
      return;
    }

    // If the mouse rested before the drag ended, don't throw.
    const resting = time - this._lastTime > 100;
    const speed = this._cube._settings.getValue('mouse-rotation-speed');
    const width = Main.layoutManager.primaryMonitor.width;
    this._cube.endDrag(resting ? 0 : -this._velocity * speed / width);
  }

  // Scrolling up zooms in, scrolling down zooms out.
  _onDragScroll(event) {
    // A wheel click can arrive both as a smooth scroll and as an emulated up/down
    // event. Only use the real one.
    if (event.is_pointer_emulated && event.is_pointer_emulated()) {
      return;
    }
    const direction = event.get_scroll_direction();
    if (direction === Clutter.ScrollDirection.UP) {
      this._cube.zoomDrag(1);
    } else if (direction === Clutter.ScrollDirection.DOWN) {
      this._cube.zoomDrag(-1);
    } else if (direction === Clutter.ScrollDirection.SMOOTH) {
      const [, dy] = event.get_scroll_delta();
      this._cube.zoomDrag(-dy);
    }
  }

  // While dragging, the pointer is hidden and kept near the center of the primary
  // monitor, so it never gets stuck at a screen edge. We only use the relative movement.
  _onDragMotion(event) {
    const [x, y] = event.get_coords();
    const time = event.get_time();

    // After warping, events that were queued before the warp still report the old
    // position. Skip everything until the warp itself arrives as a motion to the
    // center (or, to be safe, until a short time has passed).
    if (this._warpPending) {
      const arrived = Math.abs(x - this._centerX) <= 1 && Math.abs(y - this._centerY) <= 1;
      if (!arrived && time - this._warpTime < 150) {
        return;
      }
      this._warpPending = false;
      this._lastX = x;
      this._lastY = y;
      this._lastTime = time;
      return;
    }

    const deltaX = x - this._lastX;
    const deltaY = y - this._lastY;

    // Smoothed velocity in pixels per millisecond, for throwing the cube.
    const dt = time - this._lastTime;
    if (dt > 0) {
      this._velocity = 0.6 * (deltaX / dt) + 0.4 * this._velocity;
    }

    // Moving the mouse up tilts the cube one way, down the other. Clamp the total so
    // that reversing direction takes effect right away.
    const height = global.screen_height;
    this._totalY = Math.max(-height, Math.min(height, this._totalY + deltaY));

    this._lastX = x;
    this._lastY = y;
    this._lastTime = time;
    this._cube.updateDrag(deltaX, -this._totalY / height);

    if (Math.abs(x - this._centerX) > this._warpMarginX ||
        Math.abs(y - this._centerY) > this._warpMarginY) {
      this._warp(this._centerX, this._centerY);
      this._warpPending = true;
      this._warpTime = time;
    }
  }

  // Takes the modal grab and shows the cube. Returns whether that worked.
  _begin(time) {
    // The modal grab makes sure we keep getting all mouse and keyboard events, wherever
    // the pointer is. If something else already grabbed the pointer (possible when
    // started from a shortcut), try again with keyboard only, like Alt+Tab does.
    let modal = Main.pushModal(this._grabActor, time);
    if (!modal && this._source === 'shortcut') {
      modal = Main.pushModal(this._grabActor, time, Meta.ModalOptions.POINTER_ALREADY_GRABBED);
    }
    if (!modal) {
      this._state = DragState.INACTIVE;
      return false;
    }
    this._modal = true;
    if (!this._cube.beginDrag()) {
      this._ungrab();
      this._state = DragState.INACTIVE;
      return false;
    }

    const monitor = Main.layoutManager.primaryMonitor;
    this._centerX = Math.round(monitor.x + monitor.width / 2);
    this._centerY = Math.round(monitor.y + monitor.height / 2);
    this._warpMarginX = monitor.width / 4;
    this._warpMarginY = monitor.height / 4;

    this._state = DragState.ACTIVE;
    this._totalY = 0;
    this._velocity = 0;
    this._lastTime = time;

    // Hide the pointer and move it to the center; we put it back when the drag ends.
    this._setPointerVisible(false);
    this._warp(this._centerX, this._centerY);
    this._warpPending = true;
    this._warpTime = time;
    return true;
  }

  // Ends the modal grab (if we hold one) and restores the pointer.
  _ungrab() {
    if (!this._modal) {
      return;
    }
    this._modal = false;
    this._setPointerVisible(true);
    this._warp(this._startX, this._startY);
    Main.popModal(this._grabActor);
  }

  _warp(x, y) {
    try {
      Clutter.get_default_backend().get_default_seat().warp_pointer(Math.round(x),
                                                                    Math.round(y));
    } catch (e) {
      global.logError(`Desktop Cube Reloaded: could not move the pointer: ${e}`);
    }
  }

  _setPointerVisible(visible) {
    try {
      Meta.CursorTracker.get_for_display(global.display).set_pointer_visible(visible);
    } catch (e) {
      global.logError(`Desktop Cube Reloaded: could not change pointer visibility: ${e}`);
    }
  }
}

// --------------------------------------------------------------- Cinnamon entry points

function init(metadata) {
  desktopCube = new DesktopCube(metadata);
}

function enable() {
  desktopCube.enable();
}

function disable() {
  desktopCube.disable();
}
