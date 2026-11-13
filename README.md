# liosh.dev

The home of **liosh**, creative dev projects by Liam and Josh. The page is a toy
physics playground: every word on it is a magnetized block you can drag, throw
and knock around, sitting in one of four simulations.

- **Magnetic**: tens of thousands of iron filings on paper, pulled into field
  lines by wandering bar magnets, the magnet in your hand, and the words.
- **Water**: a current streaming past the words like rocks in a river, with
  eddies, wakes and stirring.
- **Ferrofluid**: liquid chrome pulled into magnetic peaks around the words,
  with pointer attraction and expanding shockwaves.
- **Sand**: a Chladni plate. Dial in a frequency and, at each resonance, sand
  bouncing on the ringing plate gathers along its still nodal lines.

It's a static site with no build step and no runtime dependencies, served by
GitHub Pages at <https://liosh.dev> from the `main` branch.

## Running it

ES modules don't load from `file://`, so serve the folder:

```sh
npm run serve          # or: python3 -m http.server 8000
```

Then open <http://localhost:8000>.

To smoke-test all four modes at desktop and phone sizes:

```sh
npm install            # once; installs puppeteer-core, which drives your own Chrome
npm run check
```

`check` fails on any page error or failed request, prints frame rates, and saves
screenshots to `tools/shots/`. Look at the screenshots too: a simulation can run
without errors and still look wrong.

## Controls

| | Desktop | Phone |
|---|---|---|
| Move a word | drag it; let go mid-drag to throw | drag it |
| Hand magnet (magnetic) | follows the cursor; click to flip N/S | follows your finger |
| Tap the paper (magnetic) | space, or **tap paper** | shake the phone |
| Tilt | arrow keys | tilt the phone (iOS asks permission on first tap) |
| Pour filings or sand | hold P, or **pour** then drag | **pour** then drag |
| Stir (water) | move or drag the cursor | drag |
| Attract ferrofluid | move or hold the cursor | touch and drag |
| Ferrofluid shockwave | space, quick drag, throw a word, or **shockwave** | tap, quick drag, throw a word, or **shockwave** |
| Magnetic pull / calm surface | **pull** slider / **calm** | **pull** slider / **calm** |
| Plate frequency (sand) | **freq** slider (snaps when let go near a resonance); [ and ] step between resonances; **next resonance** | **freq** slider; **next resonance** |
| Damp the plate (sand) | hold the mouse down on it | touch and hold |
| Knock the plate (sand) | space | shake the phone |
| Recenter the words | C, or **recenter** | **recenter** |

## Files

```
index.html       Markup and styles. Each word is a .block with a data-pole (N/S).
home.js          The page: wiring, input, modes, and the main loop.
lib/sim.js       Iron filings physics (CPU).
lib/render.js    Draws the filings (WebGL2).
lib/blocks.js    Word blocks: their fields, rigid-body physics, collisions.
lib/fluid.js     Water: GPU fluid solver, and its rendering (WebGL2).
lib/ferrofluid.js Ferrofluid: magnetic heightfield and chrome shading (WebGL2).
lib/sand.js      Sand: Chladni plate modes, bouncing grains, and their rendering (WebGL2).
tools/check.mjs  Headless smoke test.
```

## How the simulations work

### Shared conventions

- **Units are CSS pixels and 60 Hz frames.** Velocities are px/frame,
  accelerations px/frame². The loop in `home.js` runs fixed 60 Hz steps (at most
  two per animation frame), so behaviour doesn't depend on screen refresh rate.
- **Page coordinates** (y down) everywhere on the CPU. The GPU fluid uses GL
  orientation (y up) internally, and `lib/fluid.js` converts at its edges.
- **Gravity and tilt.** `sim.gx`/`sim.gy` hold the in-plane pull of gravity
  from tilting (phone orientation or arrow keys). Filings and blocks slide under
  it once it beats static friction; the water current flows downhill.

### Word blocks (`lib/blocks.js`)

Each `.block` element is turned into a rigid body when the page loads, and
again on resize:

1. **Rasterize.** The word is drawn with its real CSS font into a local grid. Big
   text (the title) keeps its exact letter shapes as the solid. Small text is
   blurred into a rounded block, since filings are bigger than its letters.
2. **Field.** The solid mask is blurred at two scales into a potential, and its
   gradient becomes the block's *outward* field, normalized to 1. A block's `k`
   (slider strength × polarity × `fieldScale`) scales it, and its sign makes the
   block N or S.
3. **Body.** Mass comes from the collision box (the solid's bounds; tiny marks
   get a minimum size). The body has position, velocity, angle and spin.

Each step:

- **Forces.**
  - Gravity from tilt.
  - Block-to-block magnetism: like poles repel, opposites attract, roughly 1/r².
  - The hand magnet (magnetic mode).
  - Water drag (water mode), sampled in a ring just outside the block, which
    also spins it.
- **Friction.** Paper friction is static (holds until beaten) then kinetic, with
  spin friction too. Water mode scales friction down because the words are
  afloat.
- **Collisions.** Oriented boxes are tested with the separating axis test, then
  resolved with impulses: restitution, contact friction so glancing hits spin
  blocks, and positional correction. Screen edges are walls.
- **Dragging.** The held block is pulled by a damped spring at the exact point
  you grabbed, so off-centre grabs swing it and releasing throws it.

**Calibration.** After layout, `calibrate()` measures the magnetic pull each word
feels in its resting place and scales block-to-block magnetism so nothing exceeds
half of static friction at strength 1. That's why the layout holds still on every
screen size, while words still snap together when brought close or when the
slider goes up.

The simulations read blocks through a duck-typed **shape** interface: `x, y`,
`cos, sin`, a grid (`ox, oy, tc, gw, gh`), `solid`, the field `bx, by`, and `k`.
Anything with those fields can be an obstacle or a magnet.

### Iron filings (`lib/sim.js`, `lib/render.js`)

Each filing is a thin rigid rod of soft iron, with length, width, position,
velocity, angle and spin, stored in flat typed arrays.

1. **Magnetize.** The external field (bar-magnet poles, the hand magnet, every
   word block) is sampled at both ends of the rod. Long thin rods magnetize along
   their axis, so each gets a pole strength `q = Q_MAX · tanh(SUSCEPT · B·u)`: the
   tip facing the field becomes north, and it saturates in strong fields.
2. **External force.** The tip carries +q and the tail −q. Their difference in
   field gives a pull toward stronger fields; the field itself twists the rod
   into line.
3. **Filing-to-filing.** Filings are binned into a uniform grid (counting sort).
   For each nearby pair, the four end-to-end pole interactions are computed:
   opposite ends attract into chains, and like ends repel, which spaces the field
   lines apart. Short-range contact springs keep rods from passing through each
   other.
4. **Integrate with friction.** Paper friction is static then kinetic, for both
   sliding and spinning. Stiff terms are damped implicitly for stability.
   **Agitation** (tapping, shaking) briefly lifts filings and lowers friction so
   they hop into the pattern. A small `restless` floor keeps them drifting on the
   homepage.
5. **Solids.** Filings can't enter a block's solid. If a moving block lands on
   one, it's shoved back out along the block's outward field.

The renderer uploads each filing's shape once, then each frame streams position
and angle into an instanced buffer. Every filing is drawn twice, a soft shadow
then a ragged metal sliver, which glints when it lies across the light. The
background shows the poles faintly glowing through the paper: coral for N, teal
for S.

Pouring adds filings up to a reserved capacity (`sim.max`), then recycles random
old ones. If a device can't keep up, `adapt()` in `home.js` lowers the count.

### Water (`lib/fluid.js`)

A grid-based "stable fluids" solver on the GPU, in half-float textures. Each step:

1. **Obstacles.** Every word's solid mask is drawn into an obstacle texture at
   its current pose. Each texel stores "solid" plus the block's velocity at that
   point (including spin), so moving words push water.
2. **Vorticity confinement.** Curl is measured and a small force reinforces it,
   to keep eddies alive against numerical damping.
3. **Forcing.** Velocity relaxes toward the free-stream current: gently
   everywhere, strongly at the screen edges, so they act as inflow and outflow.
   Solids take their block's velocity.
4. **Stirring.** Pointer splats add velocity, and optionally foam dye.
5. **Pressure projection.** Divergence, then Jacobi iterations for pressure
   (solid neighbours mirror the centre value), then the gradient is subtracted.
   This makes the water incompressible and stops it flowing into the words.
6. **Advection.** Velocity and dye are carried along the flow (semi-Lagrangian),
   with slight dissipation.
7. **Inflow dye.** Bands of colour are injected along whichever edges the
   current enters through, so the streamlines are visible.

**Water to words.** Every few steps a small copy of the velocity field is encoded
to 8-bit and read back to the CPU. `fluid.velocityAt(x, y)` samples it, and
`Blocks.step` turns it into drag. Water drag (`K_WATER`) is tuned so the steady
current can't move resting words but hard stirring can. The tiny "·" is the
exception and can get swept away, which is fair given its size.

The display pass shades the dye as a rippled surface with a specular highlight.

### Ferrofluid (`lib/ferrofluid.js`)

Ferrofluid is a **magnetically forced, damped heightfield**, not a volumetric
liquid or a Navier–Stokes simulation. It shares the same rigid-body positions
and touch/mouse coordinate transforms as the other modes.

- **Solid masks.** Exact oriented collision rectangles are rasterized into a
  low-resolution top-down mask without re-measuring DOM layout.
- **Distance and potential.** A two-pass exact Euclidean distance transform
  provides the solid distance and its falloff. A broad potential supplies the
  liquid pool; localized, narrow super-Gaussian tips create the ferrofluid
  needles around the solid boundary.
- **Static and pointer fields.** The static word field and the pointer's
  narrow needle plus broad skirt are rendered to separate `R16F` textures and
  explicitly added in a total-field pass. Pointer velocity supplies impulses;
  sudden word acceleration also creates shockwaves. Touch release clears the
  attraction state and resets movement history.
- **Height dynamics.** A spring toward the target field, a Laplacian wave term,
  and damping advance ping-ponged height and velocity textures. Impulses have
  a signed front and wake, propagate outward as expanding rings, and decay
  with age. Consecutive impulses remain distinct.
- **Shading.** The heightfield provides normal-mapped relief. Procedural chrome
  shading uses Fresnel-weighted reflections, a neutral HDR softbox, restrained
  coral/teal rims, and highlights gated by relief so the level pool stays dark.
- **Precision and color.** Physical state uses `R16F`; scene and bloom use
  `RGBA16F`. Bloom is added to linear radiance before ACES tone mapping and
  display encoding, not in display space. Every pass has its own FBO and
  explicitly binds texture units; a pass never reads its render target.
- **Reduced motion.** The static shape is installed directly without ambient
  waves. Direct pointer movement, word dragging, and explicit shockwaves still
  work, then the surface settles again.
- **Controls.** The **pull** slider controls pointer attraction, **shockwave**
  adds an expanding impulse, and **calm** clears waves while retaining the
  magnetic shape. Space triggers a shockwave; **scatter** remains magnetic-only.

### Sand (`lib/sand.js`)

A Chladni plate: a steel plate driven at one frequency, with sand on it. The
plate spans the screen, and the grains are points in flat arrays, like the
filings but with a height so they can hop.

- **Modes.** The plate's standing waves are the classic square free-plate forms
  `cos(mπu)cos(nπv) ± cos(nπu)cos(mπv)` for orders up to `MAX_ORDER`. Their
  frequencies go as `m² + n²` (a plate's frequency rises with wavenumber
  squared), and the free edges split each ± pair apart by `SPLIT`. Modes closer
  than 3% to a lower one are dropped. Two modes ringing at nearly the same
  frequency are out of phase, so neither's nodes would hold still and the
  lines would break up.
- **Response.** Each mode responds as a damped oscillator,
  `1 / (1 − r² + i·r/Q)` with `r = f / fₙ`, so it peaks at `Q` on resonance.
  The responses are summed in phase with the strongest mode onto a grid
  (signed, so interpolation finds the exact zero crossing), relative to a full
  resonance. Between resonances the plate barely moves and the sand lies still.
  The field is only recomputed when the frequency or a touch changes.
- **Grains.** Where the amplitude is over `THRESHOLD`, a resting grain is thrown
  up (`HOP`) and sideways (`KICK`), tipped down the amplitude slope toward the
  nodes (`DRIFT`). Airborne grains fall under `GZ`, and landing scuffs off most
  of their speed. Below the threshold they still creep downhill onto the node,
  each stopping its own small distance short (`LINE`), which gives the lines
  their width without any grain-to-grain physics. On the plate, tilt slides them
  once it beats static friction, and while airborne it drifts them downhill.
- **Touch.** A finger on the plate adds damping to each mode in proportion to
  how much it moves there (`TOUCH`), so the plate favours patterns with a node
  under the finger.
- **Words** are solids the sand piles against, shoved out like filings if a
  word lands on them. The words don't feel the vibration and step like they do
  on paper, so the calibrated layout holds still.
- **Rendering.** Brushed steel glowing faintly coral where the plate moves most,
  then every grain as a point sprite twice: a shadow that falls further away the
  higher it hops, then the grain.
- **Reduced motion.** The sim jumps straight to the settled pattern
  (`settle()`) whenever the frequency, a touch, or the layout changes. Pouring
  and dragging words still animate, since they're direct, and the sand settles
  when you let go.

## Extending it

### Add or change words

Add an element with `class="block"` and `data-pole="N"` or `"S"` inside
`<main>` in `index.html`. It's picked up automatically: rasterized, given a
field, collidable, draggable, and an obstacle in the water. Everything is
measured from the real layout, so CSS changes carry through.

### Add a new simulation mode

The water mode is the template:

1. Create `lib/<mode>.js` exposing `resize(w, h, dpr)`, `setBlocks(bodies)` (if
   it needs the words), `step(...)` and `render(...)`. Give it its own
   `<canvas>`, so modes don't share GL state.
2. In `index.html`, add the canvas and the CSS that shows it only in that mode.
   Give mode-specific controls `data-mode="<mode>"`.
3. In `home.js`:
   - extend `setMode()` and the **mode** button so it cycles through modes;
   - branch in `update()`, choosing how blocks behave (`friction`, a `water`
     sampler, a `hand` magnet);
   - branch in `frame()` to step and render the new simulation;
   - route pointer input.
4. Make it fail soft: return `null` from the constructor if the device can't run
   it, and hide the mode button, as `createFluid` does.

### Tuning

The physics constants sit at the top of each file with comments. The most useful:

| Constant | File | Effect |
|---|---|---|
| `TEXT_B` | `home.js` | how strongly words' fields act on filings |
| `K_BLOCK`, `K_HAND` | `blocks.js` | word-to-word and hand-to-word magnetism (`K_BLOCK` is capped by calibration) |
| `K_WATER` | `blocks.js` | how hard water drags words |
| `MU_S`, `MU_K` | `sim.js`, `blocks.js` | static and kinetic friction |
| `Q_MAX`, `SUSCEPT`, `K_MAG` | `sim.js` | filing magnetization and chaining |
| `restless` | `home.js` | constant jostle that keeps filings drifting |
| `uStrength` (vorticity), `uRelax` | `fluid.js` | how swirly the water is, and how firmly it follows the current |
| `PRESSURE_ITERATIONS` | `fluid.js` | incompressibility accuracy against GPU cost |
| `Q`, `MAX_ORDER` | `sand.js` | how sharp the plate's resonances are, and how fine its patterns get |
| `THRESHOLD`, `HOP`, `KICK`, `DRIFT` | `sand.js` | how readily and how far sand bounces toward the nodes |

When tuning, keep three things true:

- the page holds still at rest, on desktop and phone layouts;
- it stays smooth on a mid-range phone;
- it still reads as the material it's meant to be.

### Performance budget

The filings run on the main thread. `adapt()` drops filings when a step averages
over 10 ms. The water runs on the GPU at about 170 cells on the screen's short
side (128 on small screens), with dye at a higher resolution. Test on a real
phone before raising either. The sand runs on the main thread too, but its
grains don't interact, so its cost is linear and small (up to 32,000 grains).

## Deploying

Push to `main`; GitHub Pages serves the repo root. `CNAME` holds the custom
domain and `.nojekyll` serves files as-is. There's nothing to build.
