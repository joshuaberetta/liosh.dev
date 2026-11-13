# CLAUDE.md

Guidance for AI agents (and humans) working in this repo. See `README.md` for how
the simulations work; read the relevant section there before changing physics.

## What this is

liosh.dev, a static GitHub Pages site by Liam and Josh. The homepage is an
interactive physics toy: draggable magnetized word blocks in an iron filings
simulation (CPU physics, WebGL2 rendering), a water simulation (GPU fluid), a
ferrofluid heightfield, or sand on a vibrating Chladni plate (CPU grains, WebGL2
rendering).

## Ground rules

- **No build step, no runtime dependencies.** Plain ES modules loaded directly by
  the browser. Don't add bundlers, frameworks or CDN libraries. `puppeteer-core`
  is a dev-only dependency for `tools/check.mjs`.
- **Keep it small and legible.** Each `lib/` file owns one simulation concern.
  Match the existing style: short comments that explain *why* or *what physically
  happens*, constants at the top of the file, and no speculative abstraction.
- **Units:** CSS pixels and 60 Hz frames (velocities in px/frame). Page
  coordinates are y-down; only `lib/fluid.js` works in GL y-up internally,
  converting at its API edge. Keep it that way.
- **The page must hold still at rest.** After any physics change, words must not
  drift on load on desktop (1440×900) or phone (390×844) layouts, in either mode.
  Block magnetism is auto-calibrated per layout (`Blocks.calibrate()`), so don't
  bypass it.
- **Phones matter.** Every interaction needs a touch equivalent. Tilt and shake
  use device orientation and motion, and iOS needs a permission request from a
  user gesture (`requestMotion()` in `home.js`). Respect
  `prefers-reduced-motion`.
- **Fail soft.** If WebGL2 or float render targets are missing, the page still
  shows its text, and unsupported modes are hidden.

## Verifying changes

1. `npm install` (once), then `npm run check`. It must report `no page errors`.
2. **Look at the screenshots** in `tools/shots/`. "No errors" doesn't mean
   "looks right". Check the filings form field lines, the water streams around
   the words, and the menu fits on the phone shot.
3. For physics changes, also confirm the rest-stability rule above. Log each
   `.block`'s `style.transform` a few seconds after load: they should all be
   `translate(0px, 0px)`. The "·" is light enough to be swept off in water mode;
   that's accepted.
4. For anything involving tilt, shake or touch, say so in the PR: headless
   Chrome can't test real device sensors, and someone needs to try it on a phone.

## Making changes

- **New word:** add `<span class="block" data-pole="N|S">` in `index.html`.
  Nothing else is needed.
- **New simulation mode:** follow "Add a new simulation mode" in `README.md`.
  Give it its own canvas and module, branch in `setMode`/`update`/`frame` in
  `home.js`, and mark its controls with `data-mode`.
- **New control:** a `<button data-action="…">` (plus `data-mode` if it belongs
  to one mode) in the footer, handled in the `.controls` click listener in
  `home.js`. Add a keyboard shortcut if it's handy on desktop, and list it in the
  README controls table.
- **Tuning:** change constants at the top of the relevant file; the README has a
  table of the useful ones. Re-run the checks above.

## Git

- `main` deploys straight to https://liosh.dev, so keep it working.
- Commit only when asked. Use focused commits with a short imperative subject and
  a body explaining the why.
- Don't commit `node_modules/` or `tools/shots/` (both git-ignored).
