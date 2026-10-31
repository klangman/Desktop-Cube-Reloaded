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

const Clutter = imports.gi.Clutter;
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

// Scroll zoom, as fractions of the monitor width: per wheel click, and the limits.
const ZOOM_STEP = 0.1;
const MAX_ZOOM_IN = 0.3;
const MAX_ZOOM_OUT = 3.0;

let desktopCube = null;

class DesktopCube {
  constructor(metadata) {
    this._meta = metadata;
    this._anim = null;
    this._panelDrag = null;
  }

  // ------------------------------------------------------------------------ lifecycle

  enable() {
    this._settings = new Settings.ExtensionSettings(this, this._meta.uuid);

    // _switchWorkspace normally lives on WindowManager.prototype. Cinnamon connects
    // 'switch-workspace' with an arrow function that calls this._switchWorkspace(), so
    // shadowing the method on the Main.wm instance is enough to take it over.
    this._hadOwnSwitch = Object.prototype.hasOwnProperty.call(Main.wm, '_switchWorkspace');
    this._origSwitch = Main.wm._switchWorkspace;
    this._hook = (cinnamonwm, from, to, direction) =>
      this._switchWorkspace(cinnamonwm, from, to, direction);
    Main.wm._switchWorkspace = this._hook;

    this._settings.bind('enable-panel-dragging', 'enablePanelDragging',
                        () => this._updatePanelDrag());
    this._updatePanelDrag();
  }

  disable() {
    this._setPanelDrag(false);
    this._finish();

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

  _updatePanelDrag() {
    this._setPanelDrag(this._settings.getValue('enable-panel-dragging'));
  }

  _setPanelDrag(enabled) {
    if (enabled && !this._panelDrag) {
      this._panelDrag = new PanelDrag(this);
    } else if (!enabled && this._panelDrag) {
      this._panelDrag.destroy();
      this._panelDrag = null;
    }
  }

  // ------------------------------------------------------------ workspace switching

  _switchWorkspace(cinnamonwm, from, to, direction) {
    const nWorkspaces = global.workspace_manager.get_n_workspaces();

    // We activated this workspace ourselves at the end of a drag, while the cube still
    // covers the screen. The cube is already showing it; just finish together with it.
    if (this._anim && (this._anim.absorbSwitch || this._anim.mode === 'drag')) {
      this._anim.pending++;
      this._playSwitchFeedback();
      return;
    }

    // Leave everything we don't handle to Cinnamon's own implementation. That includes
    // the case where animations are off, which Cinnamon handles by completing at once.
    const useCube = Main.animations_enabled && !Main.modalCount && nWorkspaces > 1 &&
      from !== to && !NOOP_DIRECTIONS.includes(direction);

    if (!useCube) {
      this._finish();
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

  // Called by PanelDrag when a drag starts. Returns false if the cube can't be shown.
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
    return true;
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

    this._buildScene();

    const anim = this._anim;
    anim.newFrameID = timeline.connect('new-frame', () => {
      const t = timeline.get_progress();
      anim.progress = anim.start.progress + (anim.target.progress - anim.start.progress) * t;
      anim.pitch = anim.start.pitch + (anim.target.pitch - anim.start.pitch) * t;
      anim.zoom = anim.start.zoom + (anim.target.zoom - anim.start.zoom) * t;
      this._updateCubes();
    });
    anim.completedID = timeline.connect('completed', () => this._onAnimationDone());

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

  // Hides the cube, if shown, and restores the real windows.
  _finish() {
    const anim = this._anim;
    if (!anim) {
      return;
    }
    this._anim = null;

    anim.timeline.disconnect(anim.newFrameID);
    anim.timeline.disconnect(anim.completedID);
    anim.timeline.stop();
    global.window_manager.disconnect(anim.killID);

    anim.root.destroy();
    global.window_group.show();
    Meta.enable_unredirect_for_display(global.display);
    Main.wm._movingWindow = undefined;

    for (let i = 0; i < anim.pending; i++) {
      global.window_manager.completed_switch_workspace();
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
    const display = global.display;
    const grabOp = display.get_grab_op();
    const grabbedWindow =
      (grabOp === Meta.GrabOp.MOVING || grabOp === Meta.GrabOp.KEYBOARD_MOVING) ?
      display.focus_window : null;

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
      const moving = window === Main.wm._movingWindow || window === grabbedWindow;
      if (moving || (!isDesktop && window.is_on_all_workspaces())) {
        overlay.add_child(new Clutter.Clone({source: actor, x: actor.x, y: actor.y}));
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

// ----------------------------------------------------------------- dragging the panels

// Lets the user rotate the cube by dragging an empty part of any panel with the left
// mouse button. Horizontal movement rotates, vertical movement tilts, and the scroll
// wheel zooms.
//
// This plays the role of DragGesture.js in the GNOME extension. GNOME feeds the drag
// into its SwipeTracker; Cinnamon has none, so we drive the cube directly.
//
// We watch the stage's captured-event signal, which sees every event before any actor
// does. A press on an empty panel area is remembered but passed on, so panels still
// work normally. Only once the mouse has moved past a threshold do we take a modal grab
// and consume the events until the button is released. During the drag the pointer is
// hidden and kept near the screen center, so screen edges never stop the rotation.
const DragState = {INACTIVE: 0, PENDING: 1, ACTIVE: 2};

class PanelDrag {
  constructor(cube) {
    this._cube = cube;
    this._state = DragState.INACTIVE;
    this._grabActor = null;
    this._eventID = global.stage.connect('captured-event', (actor, event) =>
      this._onEvent(event));
  }

  destroy() {
    if (this._state === DragState.ACTIVE) {
      this._ungrab();
      this._cube.endDrag(0);
    }
    this._state = DragState.INACTIVE;
    global.stage.disconnect(this._eventID);
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
          !Main.modalCount && this._panelForActor(event.get_source())) {
        this._state = DragState.PENDING;
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
          this._begin(event);
        }
      } else if (type === Clutter.EventType.BUTTON_RELEASE) {
        this._state = DragState.INACTIVE;
      }
      return Clutter.EVENT_PROPAGATE;
    }

    // ACTIVE: we own all events until the button is released.
    if (type === Clutter.EventType.MOTION) {
      this._onDragMotion(event);
    } else if (type === Clutter.EventType.SCROLL) {
      this._onDragScroll(event);
    } else if (type === Clutter.EventType.BUTTON_RELEASE) {
      // If the mouse rested before release, don't throw.
      const resting = event.get_time() - this._lastTime > 100;
      const speed = this._cube._settings.getValue('mouse-rotation-speed');
      const width = Main.layoutManager.primaryMonitor.width;
      const velocity = resting ? 0 : -this._velocity * speed / width;

      this._ungrab();
      this._state = DragState.INACTIVE;
      this._cube.endDrag(velocity);
    }
    return Clutter.EVENT_STOP;
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

  _begin(event) {
    // The modal grab makes sure we keep getting events when the mouse leaves the panel.
    if (!Main.pushModal(this._grabActor)) {
      this._state = DragState.INACTIVE;
      return;
    }
    if (!this._cube.beginDrag()) {
      Main.popModal(this._grabActor);
      this._state = DragState.INACTIVE;
      return;
    }

    const monitor = Main.layoutManager.primaryMonitor;
    this._centerX = Math.round(monitor.x + monitor.width / 2);
    this._centerY = Math.round(monitor.y + monitor.height / 2);
    this._warpMarginX = monitor.width / 4;
    this._warpMarginY = monitor.height / 4;

    this._state = DragState.ACTIVE;
    this._totalY = 0;
    this._velocity = 0;
    this._lastTime = event.get_time();

    // Hide the pointer and move it to the center; we put it back on release.
    this._setPointerVisible(false);
    this._warp(this._centerX, this._centerY);
    this._warpPending = true;
    this._warpTime = this._lastTime;
  }

  _ungrab() {
    this._warp(this._startX, this._startY);
    this._setPointerVisible(true);
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
