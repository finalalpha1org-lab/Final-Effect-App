# Licences: what we are, and what we may take from Blender

The goal of this project is an all-in-one suite in the spirit of Blender, and
Blender is open source, so the obvious question is "why not lift EEVEE and
Cycles?". The answer used to be "because our licence forbids it". It no longer
is. This file records the licence, what the change bought us, and what it did
not.

## Our licence

**GPL-3.0-or-later**, from 2026-10-24.

The project was **CC0-1.0** before that. CC0 is a public-domain dedication: it
asks nothing and grants everything, which is pleasant, and it also means the
project can never link a GPL library — copyleft cannot be satisfied by a
dedication that imposes no conditions. That trade was made deliberately, in one
step, because the components worth reusing from Blender are GPL.

What the change means, honestly:

- Anyone who distributes a build must ship the complete corresponding source
  under GPLv3 or later, and the same rights to anyone downstream. Shipping the
  source of this repository satisfies that. A closed-source fork does not.
- Selling the software is still allowed. The GPL restricts distribution terms,
  not commerce.
- **The CC0 versions stay CC0.** A licence already granted cannot be withdrawn,
  so the history up to and including commit `d373569` is, and remains, public
  domain. Everything from the change onward is GPL-3.0-or-later.
- It is "or later", not "v3 exactly", because **Apache-2.0 is compatible with
  GPLv3 but not GPLv2**. Cycles is Apache-2.0; mixing it with GPL code leaves
  GPLv3+ as the only common denominator.

## The Blender components, item by item

| Blender component | Licence | What we may do |
| --- | --- | --- |
| Blender application (`blender/blender`) | **GPL-2.0-or-later** | Copyable now, with headers and a `NOTICE` entry. Copying all of it would make this a Blender fork, which is not the goal. |
| **Cycles** (`blender/cycles`) | **Apache-2.0** | Link it, copy from it, ship a WASM build of it — with the copyright notice, a note that we changed it, and no implied endorsement. Also compatible with our GPL. |
| **EEVEE** | **GPL-2.0-or-later** (part of `blender/blender`) | Legally usable now. See the technical section — the obstacle is the GPU API, not the licence. |
| Shader node definitions, UI source, `.glsl` | GPL | Copyable now, with headers. |
| Blender's Python API / add-ons | GPL | A public add-on must be GPL-compatible. Ours now is. |
| Bundled assets: matcaps, studio HDRIs, icons, demo scenes | GPL | Distributable now, but pointless: they are large, and our look is ours. Still do not copy them. |
| `.blend` file format | Documented format; file contents are not code | Reading/writing `.blend` was never a licence problem. |
| Blender output (renders, simulations, exported meshes) | Yours | The GPL covers the program, not the artwork. |
| The names "Blender", "Cycles", "EEVEE" | Trademarks, **not** licensed by the GPL | Do not name our engine after theirs or imply the Blender Foundation endorses this. Our own engine names are our own. |

Sources: <https://www.blender.org/about/license/>, the Cycles repository
(`Apache-2.0`), and the Blender Foundation's 2013 announcement that Cycles moved
from GPL to Apache-2.0 specifically so it could be linked into commercial and
in-house software.

## The legal door is open; the technical door is narrow

Relicensing removes the permission problem. It does not compile anything.

**EEVEE is not a copy-paste.** It is written against OpenGL 4.3 compute shaders,
with GLSL 4.3 shader sources and a UBO/SSBO pipeline. The browser gives us
**WebGL2** (GLSL ES 3.0, no compute shaders, no SSBOs) or **WebGPU** (WGSL,
compute available, but not GLSL and not OpenGL semantics). Porting EEVEE means
replacing its entire GPU layer; at that point the GPL source is a *reference*,
and a clean reimplementation — which was always legal — is the sane path. What
the licence change actually buys here is that we can read the source while
writing ours, and copy isolated data (a colour-space table, a socket
definition) without a lawyer in the room.

**Cycles is closer to real.** It builds as a standalone CPU library with Embree
and OpenImageDenoise optional; a WASM build without them is technically
possible. It is also a very large program with a tile scheduler, and the
artifact would be tens of megabytes. That is a project, not an afternoon, and
our own path tracer (`cpp/src/fe_renderer.cpp`) already ships. If we ever take
Cycles, it is Apache-2.0: keep the notice, state the changes, add a `NOTICE`
entry.

**Techniques were never copyrightable.** Screen-space reflections, GTAO,
volumetric froxel grids, soft shadows, TAA, AgX-style tone mapping, light
probes, path guiding: the *ideas* are published, and reimplementing an idea was
always fine. What was not fine — and is fine only because we are now GPL — is
pasting the implementation.

**Interoperability is fine either way.** Exporting glTF, reading `.blend`,
matching Blender's shortcuts, units and camera framing — none of that is
restricted.

## Rules, and they are cheap to follow

1. Never copy a file from the Blender tree without keeping its copyright header
   and adding a `NOTICE` entry naming the file, the upstream commit and the
   licence, in the same commit.
2. Never copy assets (matcaps, HDRIs, icons, demo scenes). They are GPL, they
   are large, and they are not what makes this suite.
3. Anything copied stays under its own licence; our GPL does not overwrite it,
   and their notices do not disappear because ours changed.
4. Do not use the Blender, Cycles or EEVEE names to imply endorsement, and do
   not present this suite as a Blender build.
