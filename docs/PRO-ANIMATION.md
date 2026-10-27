# Real-world graphics on a phone, and a professional animation pipeline

This page answers one question: **how does a mobile tab produce the kind of
image and the kind of animation that Blender, Houdini or DaVinci produce on a
workstation — and what is still missing here?**

It is written as a plan, not a promise. Every claim below is either already in
this repository with a measurement behind it, or is named as not done.

## The constraint, stated plainly

A phone in 2026 has roughly a tenth of a desktop GPU's fill rate, a fraction of
its memory bandwidth, a thermal budget measured in a few minutes and a per-tab
memory ceiling that will kill the page before it swaps. A workstation renders a
frame in 30 ms by doing *more work*; a phone has to reach the same picture by
doing **less work somewhere the eye will not check**.

That is not a compromise invented for phones. It is exactly what every game
engine does, and it is why a game looks better than a technical demo at the same
polygon count.

## The five levers

**1. Generate, do not store.** A gigabyte of assets is a PC habit. The core
already grows 26 species, rocks, buildings, a 50 km terrain, an ocean cascade and
a climate grid from a seed and a few kilobytes of code — `fe_flora`,
`fe_terrain`, `fe_ocean`, `fe_climate`. Nothing is downloaded, nothing is
decoded, and the same seed is the same world on every device.

**2. Simulate once, play back.** The single biggest lever for animation. A
physical simulation is expensive; the *result* of one is a table of numbers. Bake
it, interpolate it at playback, and the cost of a cloth or a soft body at frame
N is a lookup. This is how films do hair and how games do destruction. The
repository already has the start of it: `fe_sim_bake_compress` and
`bakeSimulation()` freeze a cloth or soft-body run into a quantised cache that
plays back for free. It is not yet a workflow — see gap 4.

**3. Templates with real parameters.** A professional tool does not ask a user to
start from an empty scene; it ships a flag, a rope, a smoke plume, a walk cycle —
each with a handful of parameters that behave *physically*, so a change is
predictable. "Cloth" is not a stiffness slider from 0 to 1; it is a fabric with a
mass per area, a stretch modulus and a bending length, and cotton, silk and denim
differ because those numbers differ.

**4. Draw less.** Quadtree LoD, impostors past a kilometre, frustum culling in
the core, ground-cover density falloff, the compacted visible-instance list —
all built, all measured (`docs/PERFORMANCE.md`, `docs/LOD-QUADTREE.md`).

**5. Real physics only where the eye looks.** Two or three solvers with real
equations carry the illusion; everything else is a cheap approximation shaped to
match them. The core already has XPBD deformable (with wind, air drag, plastic
deformation, self-collision), PBF liquid with surface reconstruction, and a
pyro step. The gap is not the integrator — it is the *material numbers* feeding
it.

## Where the 3D Workspace is, for animation specifically

| Capability | State |
| --- | --- |
| Timeline, keys, Catmull-Rom curves, dope/curve editing | built |
| Onion skin, keyframe stepping, bake | built |
| Edit Mode (46 tools), sculpt, 24 modifiers | built |
| Physics: cloth, soft body, fluid, smoke | built, parameterised by 0–1 sliders |
| Simulation bake → playback | built, not yet a workflow |
| **Skeleton, bind pose, skin weights, skinning** | **built this turn** (`docs/SKELETON.md`) |
| Rig UI: create a chain, pose it, paint weights | **not done** |
| IK, constraints, retargeting | not done |
| Material-accurate cloth (kg/m², N/m) | not done |
| Pre-simulated templates with parameters | not done |

## The gap list, in the order I would build it

**1. The rigging pass (kernel done, UI next).** Bones exist in the core now:
hierarchy, bind pose, inverse bind, distance weights, linear-blend and
dual-quaternion skinning, verified against three.js's own matrix stack and
against hand-worked rotations. What is missing is the thin UI that makes it
usable — bone objects in the outliner, a chain builder, weight painting, a pose
library, and using the keyframe system that already exists to animate bones.

**2. Material realism for the solvers.** Replace the 0–1 stiffness sliders with
physical quantities: areal density (kg/m²), stretch modulus (N/m), bending
stiffness, damping ratio, restitution, friction. Then a preset table for cotton,
silk, denim, leather, rubber, jelly, rope, steel spring. The solver does not need
new physics to *look* ten times more real; it needs numbers that mean something,
and it needs substepping so a stiff material stays stable at 30 fps on a phone
(today a stiff slider at 30 fps is a rubber band, which is the "fake" part the
work has to remove).

**3. Pre-simulated templates.** "Insert → Flag", "Insert → Rope", "Insert →
Smoke plume" on top of the bake that already exists: a physically parameterised
preset that arrives already baked, plays back at zero cost, and re-bakes in a
worker when a parameter changes. This is where mobile can *beat* a PC workflow
for a casual user: the expensive part already happened.

**4. Animation polish.** Curve and dope editing exist but are not where a
professional would look for them; a pose-to-pose workflow, mirroring, and a
motion-path preview are the next layer above the rig.

**5. Viewport performance.** The ⚙ sheet should report the *pass* breakdown
(shadow map, TAA, scene) instead of only the frame total, and the workspace
shadow pass should be event-driven like the landscaping studio's. Without those
numbers every further cut is a guess.

## The part that is genuinely hard

Simulating the real world at 60 fps on a phone is not possible for everything.
Water that obeys Navier–Stokes at high resolution, hair, large-scale destruction,
volumetrics at full resolution — those are off the table in real time on this
hardware, and pretending otherwise would be dishonest.

What *is* possible, and is what this plan targets:

* **precomputed** high-quality physics, re-baked off the frame, played back with
  interpolation;
* a **small number of live solvers** with real material parameters, in the places
  a viewer's eye actually lands — a cape, a flag, a splash;
* the **same numbers** driving preview and final, so what is keyed is what is
  rendered;
* the whole thing **generated from maths**, so nothing is stored, downloaded or
  licensed.

Real-world *looking* graphics on a phone come from moving work off the frame, not
from shrinking a workstation's frame.
