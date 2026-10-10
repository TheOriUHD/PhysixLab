# Telemetry and charts

Live charts of the running simulation, in the dock at the bottom of the window.

Telemetry is still growing; this page describes what is there today.

## Showing the dock

Use **View → Telemetry dock** (or the *Show Energy* / *Show Selection* commands in the palette). The dock fills while the simulation runs. Its tab strip also hosts the Diagnostics and Profiler tabs, see [Troubleshooting and diagnostics](troubleshooting).

## Energy

A chart of the whole scene's energy over time, in joules:

- **Total mechanical** – the sum of the others.
- **Kinetic (motion)** and **Kinetic (spin)**.
- **Gravitational** potential energy.
- **Spring** (elastic) energy.

Click a name in the legend to show or hide that line. The legend also shows each current value.

## Selection

Follows what you have selected:

- **A body** – *Speed* and *Height* by default, with *Kinetic energy*, *Net force* and *Spin rate* available from the legend.
- **A hinge joint** – *Angle* and *Angular speed*.
- **A spring or rope** – *Length*, *Force* and *Stretch rate*.
- **A slider** – *Position* and *Speed*.

With nothing selected the chart says so.

## Toolbar

At the right end of the tab strip: a **time window** selector (how many seconds of history are shown) and a **clear** button. The values come straight from the physics engine's statistics, so they are exact, not estimates drawn from the picture.

> The charts only move while the simulation runs; pause to inspect them.
