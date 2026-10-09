# 14 · Physics analysis, solver quality, optional domains (package AN)

Depends on: foundation, joints (JT-10 load estimation), soft (SF-8 elastic energy), zones (fields), FX (impact events).

## Analysis
- [ ] AN-1 — Joint force/torque readout per joint (net, along axis, shear, torque) in the inspector, as telemetry signals and as an overlay arrow; validated against statics in tests
- [ ] AN-2 — Stress view: colour joints and bodies by load ratio (load / break threshold or material strength estimate) with a legend; peak-hold; marks the most loaded element; tests on a loaded truss
- [ ] AN-3 — Contact history & impact log: a table (time, body A/B, point, normal, impulse, relative speed, material pair) with filtering, sorting, click-to-select/zoom, CSV export, cap/ring buffer; contact network overlay (force chains: line thickness ∝ force) 
- [ ] AN-4 — Conservation dashboard: total momentum, angular momentum, centre-of-mass motion, energy budget with drift % and (if damping/friction) dissipation accounting by source (friction/impact/damping/air drag) where the engine data allows, soft-body elastic energy included
- [ ] AN-5 — CSV/JSON export of any recorded telemetry series or event table; copy to clipboard; consistent column naming with units

## Solver quality
- [ ] AN-10 — Substeps and solver profiles: Fast / Balanced / Accurate / Ultra presets bundling physics Hz, substeps, solver iterations, CCD defaults; custom override; live switch with explanation of the trade-off and measured cost; tests that Accurate reduces drift on the double pendulum vs Fast
- [ ] AN-11 — Stiff-joint and mass-ratio handling: detect high mass ratios across joints, show a warning with an explanation and an auto-fix ("raise iterations", "add substeps", "increase hub mass"); optional automatic adaptation; tests (heavy-on-light chain stable after auto-fix)
- [ ] AN-12 — CCD defaults by speed/size heuristic (auto enable for small fast bodies), tunnelling tests with/without

## Optional domains (each real and tested; each can be disabled)
- [ ] AN-20 — Thermal: per-body temperature, heat from friction work and impact dissipation, conduction across contacts, convection/radiation cooling, ambient temperature, heat capacity from material; colour-by-temperature mode; optional thresholds (ice melts / wax softens → material change) ; tests (energy balance: heat gained = frictional work)
- [ ] AN-21 — Magnetism: dipole-like forces between magnetised bodies (permanent magnets with polarity), ferromagnetic attraction, magnet shapes/prefabs (bar/horseshoe/disc), visible field lines; tests (force falls with distance as expected, like poles repel)
- [ ] AN-22 — Electrical: simple DC circuit solver (battery, resistor, switch, lamp, motor, capacitor, wires as component ports) coupled to motors/lamps and sensors; a circuit editor view; tests (Ohm's law, RC charge curve, motor speed ∝ voltage)
