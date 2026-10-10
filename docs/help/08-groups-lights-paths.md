# Groups, lights and paths

Organise objects into folders, light the scene, and draw curves.

## Groups

A group is a folder with its own position that moves everything inside it.

- Select objects and press **Ctrl+G** to group them. With nothing selected, **Ctrl+G** adds an empty group.
- **Ctrl+Shift+G** ungroups; the members stay where they are.
- In the Inspector a group shows how many items are inside, a *Select members* button and an *Ungroup* button. The group's pivot is where the move and rotate handles sit.
- In the **Outliner** groups appear as a tree. Groups are edited in the document, so stop the simulation to move one.

## Lights

Add lights from the **Add** tab: **Point** (every direction), **Spot** (a cone), **Sun** (parallel rays) and **Area** (a soft rectangular panel).

- Lights shine along their −Z axis: rotate the light to aim it.
- The Inspector has *Type*, *State* (on/off), *Colour*, *Intensity* (candela for point and spot lights, lux for the sun), range and cone settings where they apply, and *Shadows* (not for area lights).
- Lights are part of the scene, saved with it, and undoable like everything else.

## Paths

A path is a spline through points. Add one from the **Add** tab (*Add Path*).

- The curve passes through every point. The green point is the start, the red one the end; arrows show the direction of travel.
- **Tension** goes from 0 (smooth Catmull-Rom spline) to 1 (straight segments). **Closed loop** connects the last point back to the first and needs three or more points.
- In the **Points** list you can edit each coordinate, move a point with the gizmo, insert a point after another, delete a point, or add a point.
- The Inspector shows the path's length.

See also: [The editor](the-editor), [Library](library).
