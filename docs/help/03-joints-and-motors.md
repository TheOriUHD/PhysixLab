# Joints and motors

Connect bodies with hinges, sliders, springs and ropes, and drive them with motors.

## Making a joint

1. Press **J** (or choose a joint type in the **Add** tab, which starts the joint tool for that type).
2. Click the first body, then the second body. Clicking empty ground instead pins the joint to the world.
3. The joint appears at your first click. Select it to edit it in the [Inspector](the-editor).

Press **Esc** to cancel the tool.

## Joint types

| Type | What it does |
| --- | --- |
| Fixed | Locks two bodies together rigidly. |
| Hinge | Rotation about one axis: doors, wheels, arms. Supports limits and a motor. |
| Slider | Sliding along one axis: pistons, drawers. Supports limits and a motor. |
| Ball | Free rotation about a point: chains, shoulders. |
| Spring | A spring-damper between two points, with rest length, stiffness and damping. |
| Rope | Holds two points within a maximum length but lets them come closer. |

## Editing a joint

The Inspector shows the joint **Type**, **Body A** and **Body B**, and whether **connected bodies collide**. In **Anchors** you can drag the end gizmos or align the axis to the world.

- **Limits** – tick *Limit the range of motion* and set *Min* and *Max* (angle for hinges, distance for sliders).
- **Spring** – *Rest length*, *Stiffness k*, *Damping c* and an optional *Break force* (the spring snaps when its force exceeds it; 0 = unbreakable).
- **Rope** – *Max length*.

## Motors

Hinges and sliders can have a motor. Choose its mode:

- **Off** – the joint moves freely.
- **Velocity** – tries to reach a *Target speed*, limited by *Max force*. Good for wheels and conveyors.
- **Position** – holds a *Target* with a given *Stiffness* and *Damping*, moving at most at the *Slew rate*. Good for steering and robot arms.

Bind **keys** to the motor (*Key (−)* and the matching positive key) and press them while the simulation runs; for example the *Drivable car* example uses W A S D. Optionally *hold position when no key is pressed*.

While simulating, the **Live** section shows the current angle or length and speed of the joint.

## Tips

- Heavy bodies on light ones make joints look stretchy; raise the solver iterations in the [World panel](simulation-and-time).
- The joint tool and the *Show joints & constraints* option (View menu) make joints visible while you work.
- Try the example scenes *Double pendulum*, *Lever launcher*, *Drivable car* and *Rope bridge* from **File → Examples**.
