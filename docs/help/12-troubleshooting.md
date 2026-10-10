# Troubleshooting and diagnostics

What to do when something looks wrong, and how to read the Diagnostics and Profiler panels.

## The app shows an error card

If something unexpected goes wrong, PhysixLab shows a card that explains it in plain words instead of a blank screen. Your scene is never discarded without saying so. The card offers:

- **Copy diagnostics** – copies a text report (version, browser, graphics card, limits, recent errors, a summary of the scene) that you can paste into a bug report.
- **Dismiss** – close the card and keep working, if the app still responds.
- **Reload** – reload the page. Your last autosave is restored.
- **Download scene as JSON** – saves the current scene to a file first, so nothing is lost.
- **Restore last autosave** – replaces the current scene with the last automatic save.
- **Reset layout and preferences** – restores the default panels and settings without touching your scenes.
- **Start with an empty scene** – a clean slate (the autosave is kept until you save over it).

If errors repeat in a loop, the card shows the first ones and counts the rest instead of piling up.

## "Can't start" messages

At start-up PhysixLab checks what your browser supports: **WebGL 2** (3D drawing), **WebAssembly** (the physics engine), **Web Workers** (physics runs off the main thread), **module workers** and **local storage** (autosave, library, preferences). If something is missing you see which one, why it matters and what to try: update the browser, turn on hardware acceleration, leave private mode. Without local storage the app still works but cannot save, and says so.

## Common problems

- **Everything is slow.** Open the Profiler (below). If *render* dominates, lower *View → Graphics quality*. If *physics* dominates, lower the physics rate or the number of bodies, see [Simulation and time](simulation-and-time).
- **The page is black or the scene is missing.** Check that hardware acceleration is on in the browser settings and open the Diagnostics panel to see which graphics card is in use.
- **Fast things pass through walls.** Enable *Continuous collision* on the body, raise the physics rate, or make the wall thicker, see [Building and shapes](building-and-shapes).
- **Joints stretch or stacks wobble.** Raise solver iterations or sub-steps in the World panel.
- **My scenes disappeared.** Scenes live in this browser's local storage; clearing site data or using a private window removes them. Export important scenes from the File menu, see [Library](library).

## Diagnostics panel

Open it from the tabs of the bottom dock (or *Show Diagnostics* in the palette). It lists:

- **Application** – version and build, browser and operating system, screen size and pixel ratio, language.
- **Graphics** – the WebGL version, the graphics card as reported by the browser, and limits such as maximum texture size.
- **Physics worker** – whether it is running, the protocol version, frames received, step time, bodies, awake bodies, contacts and particles.
- **Memory** – JavaScript heap use when the browser reports it.
- **Capabilities** – the start-up checks.

The **Copy** button copies the same report the error card does.

## Profiler panel

Shows where each frame's time goes, as a rolling stacked graph with a table of average and maximum milliseconds per section:

| Section | Meaning |
| --- | --- |
| Physics | Handing a tick to the physics worker and reading its results back. |
| Scene | Updating the 3D objects, overlays, effects and labels. |
| Render | Drawing the scene. |
| UI | The remainder: panels, charts and everything else. |

The worker's own *step time* (the physics itself, which runs in parallel on another thread) is shown separately because it does not add to the frame time. The graph only draws while the Profiler tab is visible; collecting the numbers costs next to nothing.
