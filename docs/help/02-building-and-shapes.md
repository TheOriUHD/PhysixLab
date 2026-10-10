# Building and shapes

Add rigid bodies from the library, then size, place and give them a material.

## Adding shapes

Open the **Add** tab in the left panel and click a shape, or press its number key (**1**–**8**): box, sphere, cylinder, capsule, cone, wedge, prism and icosahedron. A new body appears at the centre of the view and is selected, ready to move.

You can also *Duplicate* (**Ctrl+D**), copy and paste (**Ctrl+C**, **Ctrl+V**) or insert a whole assembly from the **Prefabs** tab (car, pendulum, chain, brick wall, dominoes and more).

## Body type

In the [Inspector](the-editor) choose how a body behaves:

| Type | Meaning |
| --- | --- |
| Dynamic | Moves under gravity, forces and collisions. |
| Static | Immovable scenery: floors, walls, ramps. |
| Kinematic | Moved by a script or [component](components), pushes dynamic bodies but is not pushed back. |

## Size, position and rotation

The **Transform** section shows position (m) and rotation (degrees). The size fields depend on the shape (a box has three sizes, a sphere a radius, and so on). Type a number, or drag the field label to scrub the value. While the simulation runs, the transform shows the live pose and editing it moves the body only in the running simulation.

## Materials

Each body has a material: steel, aluminium, wood, rubber, plastic, concrete, glass, ice, foam, gold, lead or ceramic. A material sets **density**, **friction** and **bounciness** (restitution); you can fine-tune each value. Mass is density times volume, shown as a read-only *Mass* field (the engine's number once simulating).

- Contact friction is the average of the two touching surfaces; contact bounciness is the larger of the two.
- Colour comes from the material unless you change it; *View → Colour bodies by* can colour by body type, speed, kinetic energy, net force or sleep state.

## Advanced body options

- **Continuous collision** keeps fast, small bodies from tunnelling through thin walls.
- **Allow sleeping** lets resting bodies switch off to save work.
- **Ghost** removes collisions but keeps the mass.
- **Lock move** and **Lock rotate** (X, Y, Z) freeze movement or rotation on chosen axes.
- **Linear damping**, **angular damping** and **gravity scale** (0 = weightless, negative floats up) tune how the body moves.
- **Apply a force / torque** adds a thruster-like push, always on or while a key is held.

See also: [Joints and motors](joints-and-motors), [Simulation and time](simulation-and-time).
