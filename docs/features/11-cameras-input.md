# 11 · Cameras, input devices, accessibility, localisation (package CM)

Depends on: foundation (command/tool/panel registries, axes protocol). All input paths go through a central `InputMap` (actions → bindings) so rebinding, gamepad, touch and keyboard share one pipeline.

## Cameras and views
- [ ] CM-1 — Camera modes with smooth transitions: orbit (existing), fly (WASD/QE + mouse look, speed wheel), first-person (from a body/character/sensor), third-person follow (spring-arm with collision-avoid), vehicle chase cam (velocity-aligned, look-behind), top-down, free-orbit-around-point; mode switcher in the viewport bar + hotkeys
- [ ] CM-2 — Orthographic views: front/side/top/iso with a toggle between perspective/orthographic, ortho scale, grid in the view plane; view cube/gizmo (existing ViewHelper) works in ortho
- [ ] CM-3 — Camera bookmarks: save/recall named views (Ctrl+1..9 / 1..9 recall), thumbnail, persisted in the scene
- [ ] CM-4 — Cinematic camera paths: keyframe the camera along a spline with per-key time/FOV/easing, preview/scrub, loop, record-to-video hook (package DT), look-at target body; stored in the scene
- [ ] CM-5 — Split screen (2/3/4 viewports with independent cameras, e.g. chase + top + free) and picture-in-picture camera mounted on any body (dashcam, drone view), resizable/draggable PiP
- [ ] CM-6 — Minimap overlay (top-down live map of bodies/zones/paths with the camera frustum, click to move camera, zoom, rotate-with-camera)
- [ ] CM-7 — Camera polish: FOV slider, near/far auto, smooth focus-on-selection, camera shake integration with FX, "frame all/selection", fly-to animation, reduced-motion aware

## Input
- [x] CM-10 — Gamepad support (Gamepad API; Xbox/PlayStation/generic mapping): sticks → analog axes, triggers → throttle/brake, buttons → keys/actions, dead zones and response curves, hot-plug, connection toast; analog axes feed motors/thrusters/vehicles (`axes` protocol) with sensible default mappings for the car, plane, tank, crane (tests/input.test.ts › "gamepad reading", "analog axes drive motors in the engine"; e2e/tests/cm-input.mjs › "gamepad: right trigger drives the car…"; src/app/input/{gamepad,profiles,hub}.ts. Profiles: car, plane, tank, crane, general; bundled scenes with axis-driven motors: the car, motor wheel and piston/press — plane/tank/crane have profiles and thruster/motor axis support but no bundled scene.)
- [x] CM-11 — Analog steering/throttle processing: sensitivity/curve/smoothing/auto-centre, keyboard-to-analog ramping (so keys feel like a stick), per-vehicle profiles (tests/input.test.ts › "analog axis processing"; src/app/input/axes.ts; per-vehicle profiles with per-axis tuning in Settings › Gamepad & axes; motor `axis` field in the joint inspector; e2e › "keyboard ramp")
- [ ] CM-12 — Touch controls: on-screen virtual joysticks and buttons (configurable), multi-touch orbit/pan/pinch-zoom, tap select, long-press context menu, two-finger drag to move selected, touch-friendly hit areas
- [ ] CM-13 — Mobile/tablet responsive layout: panels collapse into bottom sheets/drawers, toolbar compacts, viewport-first; tested at 390×844 and 820×1180 with screenshots
- [x] CM-14 — Rebindable keys: Settings › Keyboard lists every command/action with its binding, click-to-rebind with conflict detection, reset per binding/all, presets (default, left-handed, one-handed, WASD-free), import/export bindings; motor key bindings in the inspector use the same pipeline (tests/input.test.ts › "InputMap"; e2e › "input settings: rebind…"; src/app/input/{inputMap,presets,chord,capture}.ts, src/ui/input/inputSettings.ts. Motor key fields capture keyboard keys and pad buttons through `captureKey`.)

## Accessibility
- [ ] CM-20 — Accessibility: full keyboard navigation of panels/menus/dialogs with visible focus rings, ARIA roles/labels on all controls, live-region announcements for sim events (started/stopped/joint broke/objective complete), skip links, reduced-motion setting (respects `prefers-reduced-motion`), colour-blind safe palettes (deuteranopia/protanopia/tritanopia modes affecting overlays, charts, highlights), UI scale 75–200 %, large-text and dyslexia-friendly font option, high-contrast theme hook (with VZ-50)

## Localisation and units
- [ ] CM-30 — i18n: all UI strings go through `t()` with ICU-ish plurals/placeholders; languages en, es, fr, de, pt, ja, zh-CN, ru, ko, ar (RTL layout supported) with a language picker; missing keys fall back to English; a test fails when a key exists in en but is missing from the bundled catalogs (warn-list allowed for stretch locales)
- [ ] CM-31 — Units & number formatting: Metric / Imperial / custom per-quantity (length, mass, speed, force, energy, angle deg/rad/turns, temperature) applied across inspector, telemetry, labels, overlays, measure tool and export; locale-aware numerals; round-trip-safe parsing of typed values with units ("5 ft", "2 kg")
