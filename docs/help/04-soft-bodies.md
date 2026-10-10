# Soft bodies

Jelly, balloons, cloth and cables: deformable objects that squash, drape and can tear.

## The four kinds

Add them from the **Add** tab (or the palette: *Add Jelly*, *Add Cloth* …).

| Kind | What it is |
| --- | --- |
| Jelly | A squishy volumetric block. |
| Balloon | An inflated elastic shell. |
| Cloth | A sheet that drapes and can tear. Pin an edge or corners to hang it. |
| Cable | A flexible rope or cable, pinned at both ends by default. |

Soft bodies collide with rigid bodies and the ground. They are simulated as particles.

## Settings

Select a soft body and use the Inspector:

- **Pinning** – *Free*, or pin one edge, two corners or all four corners for cloth; both ends, one end or free for cables.
- **Resolution** – more particles look smoother and cost more.
- **Mass**, **Stiffness** and **Damping** – how heavy, how springy and how quickly motion dies out.
- **Gravity scale** and **Air drag** – a low gravity scale makes things float.
- **Can tear** and **Tear strain** – cloth and cables break when stretched past the strain. Try the *Tearing banner* example and rip it with the wrecking ball or your own projectiles.
- **Self-collisions** – stops cloth passing through itself; slower.

## Tips

- Pin a cloth edge and press **Simulate** to see it hang; drag it while it runs.
- Start with the examples *Jelly playground* and *Cloth drape & hammock* in **File → Examples**.
- If a soft body explodes or jitters, raise the physics rate or sub-steps in the [World panel](simulation-and-time), or lower the stiffness.
