# Components

Components add behaviour to a body without changing its shape: a steady push, a moving platform.

## Adding a component

1. Select a body.
2. In the Inspector, open the **Components** section and use the search box or the list to add one.
3. Fill in its fields. Each component has an on/off switch, buttons to run it earlier or later than the others, and a delete button.

Components only apply to the kinds of object they were made for (the list only shows what fits the selection). Like everything else, adding, editing and removing components is undoable.

## Built-in components

### Constant force

Pushes (and optionally spins) a dynamic body every step: a fan, a thruster, wind, a motor with no moving parts.

- **Force** (N) and **Torque** (N·m) vectors.
- **Frame** – *World axes* stay put (wind); *Body axes* turn with the body (a thruster).
- **Acts at** – where the force is applied.

### Sine mover

Moves a body back and forth along a direction on a sine wave, like a moving platform.

- **Direction**, **Amplitude** (m), **Frequency** (Hz) and **Phase**.
- While simulating, the component shows its current *Offset* and *Speed*.

A kinematic body is the natural choice for a sine mover: it pushes dynamic bodies around without being pushed.

## Quick alternative

For a simple thruster you can also tick **Apply a force / torque** in the body's *Forces* options, with an optional key trigger. See [Building and shapes](building-and-shapes).
