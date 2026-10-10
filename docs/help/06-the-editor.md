# The editor

Select, move, rotate and scale objects, snap to a grid, and undo anything.

## Selecting

- **Click** an object to select it; **Shift+Click** adds to or removes from the selection.
- **Drag on empty space** to box-select.
- **Ctrl+A** selects everything. **Esc** cancels the current tool, then clears the selection.
- You can also click rows in the **Outliner** (the second tab of the right panel), which lists every object as a tree with search.

## Tools

| Tool | Key | Use |
| --- | --- | --- |
| Select | **Q** | Pick objects. |
| Move | **W** | Drag the arrows or planes of the gizmo. |
| Rotate | **E** | Drag the rings. |
| Scale | **R** | Drag the handles. |
| Joint | **J** | Click two bodies, see [Joints and motors](joints-and-motors). |
| Measure | **M** | Click two points to read the distance. |
| Blast | **B** | While simulating, click to set off an explosion. |
| Fire projectiles | **T** | While simulating, click to shoot a ball. |

**X** switches the gizmo between world and local axes. The Inspector fields do the same job with exact numbers.

## Snapping

**G** turns grid snapping on or off. The snap grid size cycles through 0.05, 0.1, 0.25, 0.5 and 1 m (command *Snap grid size*, in the palette). The toolbox and view bar at the edges of the viewport show the state of each option.

## Moving by keyboard

The **arrow keys** nudge the selection; hold **Shift** to move 1 m at a time. **Shift+Drag** moves vertically.

## Hide, lock, duplicate

- **H** hides or shows the selection. **L** locks it so it cannot be moved in the editor.
- **Ctrl+D** duplicates (joints between the copied bodies are copied too). **Ctrl+C** / **Ctrl+V** copy and paste.
- **Delete** removes the selection.

## Undo and redo

**Ctrl+Z** undoes and **Ctrl+Shift+Z** (or **Ctrl+Y**) redoes. The Edit menu and the buttons in the top bar name the step ("Undo Move"). Dragging a gizmo or a slider is one undo step.

## The Inspector

The first tab of the right panel shows the properties of the selection: Transform, shape size, material, body type, damping, locks, [components](components) and live values while simulating. Select several objects of one kind to edit them together. With nothing selected the Inspector tells you what to do next.

## Camera

Right-drag or Alt+drag orbits, middle-drag pans, the wheel zooms. **F** frames the selection, **Home** frames everything, **C** makes the camera follow the selection, and double-clicking an object frames it.

See also: [Groups, lights and paths](groups-lights-paths), [Keyboard shortcuts](keyboard-shortcuts).
