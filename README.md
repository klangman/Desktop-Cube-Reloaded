# Desktop Cube Reloaded

A Cinnamon extension that rotates your workspaces as the faces of a 3D cube. 

This is a port of Simon Schneegans' [Desktop Cube](https://github.com/Schneegans/Desktop-Cube) extension for GNOME Shell.

This Cinnamon port is called "Reloaded" because Cinnamon already has a simpler Desktop Cube extension.

![screen shot](Desktop-Cube-Reloaded@klangman/screenshot.png)

Supports Cinnamon 6.0 and newer.

## Status

| Feature from the GNOME extension                              | Status                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Cube rotation when switching workspaces                       | Done                                                                                                           |
| Gap between last and first workspace                          | Done                                                                                                           |
| Window parallax while rotating                                | Done                                                                                                           |
| Vertical rotation and "exploding" windows                     | Done                                                                                                           |
| Rotating the cube by dragging a panel                         | Done                                                                                                           |
| Rotating the cube by dragging the desktop                     | Replaced by a hold-to-rotate shortcut: on X11 the desktop belongs to Nemo, so Cinnamon never sees those clicks |
| Switching by pushing a dragged window against the screen edge | Done                                                                                                           |
| Panorama (skybox) background                                  | Done, as a cached cube map instead of a shader (see below)                                                     |
| Per-monitor perspective correction                            | Planned                                                                                                        |
| Cube in Expo (GNOME's overview cube)                          | To be decided                                                                                                  |

Additions that are not in the GNOME extension:

| Feature                                                                                               | Status |
| ----------------------------------------------------------------------------------------------------- | ------ |
| Hold a shortcut (default `Super+Alt+Space`) to rotate the cube with the mouse, anywhere on the screen | Done   |
| Zooming with the scroll wheel while rotating with the mouse                                           | Done   |
| Esc while rotating with the mouse goes back to the starting workspace                                 | Done   |
| Hiding the panels while the cube is shown                                                             | Done   |
| Desklets are shown on the cube faces                                                                  | Done   |

Known limitations and open items:

- Cinnamon 6.0 support is based on reading the 6.0 source; it has only been tested on newer versions so far.
- With Blur Cinnamon, desklets are shown without their blurred background while the cube rotates, and the workspace OSD isn't integrated with Blur Cinnamon yet.
- Tilting the cube shows the back sides of the other faces; that is expected.

## Usage

- Switch workspaces as usual (e.g. `Ctrl+Alt+Left/Right`) and the cube rotates.
- Hold `Super+Alt+Space` (or the shortcut set in the settings), keep `Super+Alt` held and move the mouse: sideways rotates the cube, up and down tilts it, the scroll wheel zooms.
  Release the keys to switch to the workspace facing you, or press `Esc` to go back.
- Or press the left mouse button on an empty part of any panel and move the mouse, with the same controls; release the button to switch.
- While dragging a window, push it against the left or right screen edge to rotate to the next workspace, taking the window along.
- The pointer is hidden while rotating with the mouse, so screen edges don't get in the way.
- Turn off *Leave a gap between the last and first workspace* in the settings for a
  closed cube.
- Pick a 360° panorama (equirectangular, 2:1) on the *Background* tab to show it around the cube.

## How it works

GNOME Shell slides whole workspace groups during a switch, and the GNOME extension adds 3D transforms to them. Cinnamon has no workspace groups: `WindowManager._switchWorkspace()` slides each window by itself. This extension replaces that method on `Main.wm`. During a switch it hides `global.window_group` and shows a scene of clones in its place: one cube per monitor, with one face per workspace (wallpaper, desktop icons and windows). A `Clutter.Timeline` turns the cube. When the timeline ends, the clones are destroyed, the real windows come back and Muffin is told the switch is complete.

The cube geometry (face angle, pivot distance, depth sorting, parallax) comes from the
GNOME extension.

The GNOME extension draws its panorama with a GLSL shader. Cinnamon's shader classes can't bind a texture of our own in any released version, so the panorama is converted once into a cube map (six faces around Clutter's camera, using the same projection as the GNOME shader) and drawn as plain textured actors. The faces are cached in `~/.cache/desktop-cube-reloaded/`, so the conversion only happens once per panorama.

## Repository layout

The layout matches the [cinnamon-spices-extensions](https://github.com/linuxmint/cinnamon-spices-extensions) repository, so the extension can be submitted there later:

```
Desktop-Cube-Reloaded@klangman/
  info.json
  files/Desktop-Cube-Reloaded@klangman/
    metadata.json          (multiversion)
    icon.png
    6.0/
      extension.js
      settings-schema.json
      CustomWidgets.py     (About tab and info labels, shared with BlurCinnamon)
```

## Testing a development copy

Link the extension into your local extensions folder:

```sh
ln -s "$PWD/Desktop-Cube-Reloaded@klangman/files/Desktop-Cube-Reloaded@klangman" \
      ~/.local/share/cinnamon/extensions/
```

Then enable it in *System Settings → Extensions*. After changing the code, reload it with
the extension's reload button in Looking Glass (`Alt+F2`, `lg`, *Extensions* tab), or restart Cinnamon (`Ctrl+Alt+Esc`). Errors show up in Looking Glass and in `~/.xsession-errors`.

## Credit

So far every single line of code is a copy from Simon Schneegans' [Desktop Cube](https://github.com/Schneegans/Desktop-Cube) Gnome version or written by Claude AI based on my prompting with very limited code review. Before I offer this up to Cinnamon Spices I will do a more detailed code review.

The extension icon is Simon Schneegans' Desktop Cube icon, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## License

GPL-3.0-or-later, like the original extension.
