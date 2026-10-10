# Simulation and time

Start, pause, step and slow down the physics, and control how accurately it runs.

## Transport

| Control | What it does | Shortcut |
| --- | --- | --- |
| Simulate / Pause / Resume | Starts the physics from your layout, pauses and resumes. | **Space** |
| Step | Advances exactly one physics step (use while paused). | **.** |
| Stop | Returns to the editable layout. | **Shift+Space** |

The mode chip next to the transport shows **Edit**, **Running** or **Paused**, and the clock shows simulated time.

## Speed

The speed buttons run the simulation at 0.1×, 0.25×, 0.5×, 1× (real time), 2× or 4×. The status bar's *speed* value shows how close to real time the engine actually runs; it is highlighted when the machine cannot keep up.

## Interacting while it runs

- **Drag a body** to grab and throw it.
- Keys bound to motors drive them, see [Joints and motors](joints-and-motors).
- The **Fire projectiles** tool (**T**) shoots balls and the **Blast** tool (**B**) pushes bodies away from a point.
- Editing a transform while running moves the live body only. Use *Use current simulation state as the starting layout* (Edit menu) to keep a result as your new layout.

## The World panel

The **World** tab of the right panel holds the scene's settings:

- **Gravity** – presets (Earth, Moon, Mars, Jupiter, zero gravity) or a custom vector, in m/s².
- **Ground** – on/off, friction, bounciness, size and colour of the ground plane. Things that fall off the edge keep falling and are switched off far below.
- **Air** – extra drag on every dynamic body; fully left is a vacuum.
- **Solver** – physics rate (60, 120, 240 or 480 Hz), solver iterations and sub-steps. Higher is more accurate and slower; raise them for stiff joints, tall stacks and fast objects.

See also: [Telemetry and charts](telemetry).
