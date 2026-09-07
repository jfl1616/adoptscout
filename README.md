# AdoptScout

A free, self-hosted pet adoption search — browse real, live shelter and rescue listings
nationwide, with no account or sign-up required.

A browser-based rewrite of the original LA Pet Adopt Android app: browse adoptable pets
nationwide via RescueGroups.org, filter by species/age/size/state, save favorites, and see an
"urgent" badge on pets flagged by this app's own length-of-stay heuristic. Runs as a single
small Node/Express server with a plain HTML/CSS/JS frontend — no build step, no framework,
designed to run as one Docker container behind your own reverse proxy.

**Renamed from "LA Pet Adopt" to AdoptScout** once the app covered pets nationwide via
RescueGroups.org rather than just LA — the old name (and the old Android app it came from) no
longer matched what the app actually does. Favorites saved under the old browser storage key are
migrated automatically the first time a returning visitor loads the app (see `common.js`).

## Why a rewrite instead of a port

The Android app already had this integration fully working and live-tested against
RescueGroups.org's real API. This project ports that same confirmed logic (field names, the
state-filtering two-step lookup, the urgent heuristic, date parsing) into JavaScript rather than
guessing again from scratch — see `src/rescuegroupsService.js`'s comments for the field-by-field
provenance.

The move to a self-hosted web app (instead of a native Android app) was made for two concrete
reasons: it moves the RescueGroups API key server-side, out of a client that could otherwise be
decompiled, and it means the whole app can be run and tested end-to-end from a terminal, not
just compiled and hoped for.

## Architecture

```
Browser  <-->  Express server (this app)  <-->  RescueGroups.org legacy HTTP API
               - serves public/ (static)
               - /api/pets/*  (JSON API, holds the API key)
```

- **`server.js`** — Express app: serves `public/` as static files, mounts the `/api/pets`
  router, and a `/api/health` check.
- **`src/rescuegroupsService.js`** — all RescueGroups.org integration: confirmed field names,
  state-filtering two-step org lookup, the urgent heuristic, date parsing. Pure functions are
  exported under `_internal` for the test script (see "Testing" below).
- **`src/mockData.js`** — sample pets/shelters used automatically whenever
  `RESCUEGROUPS_API_KEY` isn't set, so the app is fully usable (and demoable) with zero
  configuration.
- **`src/routes/pets.js`** — the JSON API, picking real vs. mock data per-request.
- **`public/`** — plain HTML/CSS/JS frontend: `index.html` is the landing page (hero + search,
  species category tiles, a "featured pets" strip, and a RescueGroups.org thank-you section),
  `browse.html` is the actual search+filter+grid experience, `pet.html` is the detail page,
  `favorites.html` lists saved pets, and `about.html` explains the project and credits its creator.
  `public/js/common.js` holds shared helpers (favorites in `localStorage`, a tiny DOM-builder, the
  shared pet-card renderer).

No frontend framework, no bundler, no build step — edit an HTML/CSS/JS file and refresh the
page. This was a deliberate choice for a personal project of this size; see "Notable scope
decisions" below if you're wondering why not React.

## Landing page & RescueGroups.org attribution

`index.html` is a proper landing page (Petfinder-style), not just the search screen: a gradient
hero with a quick species+state search that jumps straight into `browse.html` with the filters
pre-applied via query string, category tiles for the common species, a "Pets who need you most"
strip that shows real urgent-flagged pets when any exist and quietly falls back to a plain
"Meet some pets" sample when none do (worth remembering: only ~12% of real listings even have
the length-of-stay signal populated, so an empty urgent list on any given page load is the
common case, not a bug), and a dedicated section thanking RescueGroups.org for their API.

**Geolocation-based personalization:** on load, the landing page asks the browser's own
Geolocation API for the visitor's position (the browser shows its native permission prompt —
nothing here pre-answers or bypasses it) and, only on success, reverse-geocodes the coordinates
client-side via BigDataCloud's free `reverse-geocode-client` endpoint (no API key, CORS-enabled,
called straight from the visitor's browser — not from this server) to get an approximate city and
state. When that succeeds, the state field is pre-filled, a small "📍 Showing pets near
{City}, {ST}" line appears with a "Not you? Search a different state above" link, and both the
urgent-pets and featured-pets calls are narrowed to that state (see the new optional `state` param
on `GET /api/pets/urgent`). Every failure mode — permission denied, no geolocation support, the
reverse-geocode call failing, a non-US result, or a state with nothing to show — falls back
silently to the original nationwide behavior. This is a nice-to-have touch layered on top of the
existing manual state search, never a replacement for it.

Every page (landing, browse, detail, favorites) carries a footer crediting RescueGroups.org and
linking to `rescuegroups.org`, plus a line clarifying this is an independent project not
affiliated with or endorsed by them. **Worth double-checking:** this sandbox has no network
access to fetch RescueGroups' actual API terms of service or branding guidelines, so the
attribution wording here is a good-faith, respectful credit rather than a verified match to any
specific attribution requirement they may have. If their terms specify required wording, a
logo, or placement rules, update the footer text in the four HTML files (or the credit section
in `index.html`) to match.

## Running locally (without Docker)

```
npm install
npm start
```

Then open `http://localhost:3000`. Without `RESCUEGROUPS_API_KEY` set, it runs on sample data
(you'll see a "Showing sample data" banner). To use live data:

```
RESCUEGROUPS_API_KEY=yourkeyhere npm start
```

## Testing

```
npm test
```

Runs `test/run-tests.js` — a small assertion-based suite (no framework dependency) covering the
pure logic: date parsing against real confirmed formats, the urgent heuristic's boundary
conditions, size normalization, state-code extraction, and the raw-record-to-Pet mapping. This
sandbox that built the app has no network access to rescuegroups.org, so this can't be a true
live end-to-end test — what it verifies is that the logic behaves correctly against the *real*
values already confirmed live against the API (see the field-name history below), plus edge
cases like blank/garbage/future dates.

**Worth doing once you have this deployed with your real key:** hit `/api/health` and confirm
`"dataSource": "rescuegroups"` (not `"mock"`), then browse a state you know has real listings to
confirm end-to-end behavior against live data — that's the one thing this sandbox genuinely
couldn't test.

## Deploying via Docker / Portainer

1. Copy `.env.example` to `.env` and fill in your real `RESCUEGROUPS_API_KEY`. `.env` is
   gitignored — never commit your real key.
2. In Portainer: **Stacks → Add stack**, paste the contents of `docker-compose.yml` (or point
   it at this repo if you push it to git), and set `RESCUEGROUPS_API_KEY` in the stack's
   environment variables section (Portainer has a dedicated field for this — you don't need the
   `.env` file if you set it there instead).
3. Deploy the stack. Portainer will build the image from the `Dockerfile` and start the
   container, listening on port 3000 inside the container.

**Connecting your reverse nginx proxy** — two common setups, pick whichever matches yours:

- **Same Docker network as your proxy** (e.g. Nginx Proxy Manager): don't publish a host port at
  all — remove the `ports:` block in `docker-compose.yml` — and instead put both containers on
  the same Docker network (add a `networks:` section, or add this service to your proxy's
  existing compose file/stack). Point your proxy at `http://adoptscout-web:3000` — Docker's
  internal DNS resolves the container name.
- **Proxy running elsewhere / plain nginx.conf on the host**: keep the `ports: - "3000:3000"`
  mapping as-is, and point your nginx `proxy_pass` at `http://<docker-host-ip>:3000`.

Either way, the app itself doesn't need to know its own public URL or handle TLS — that's your
proxy's job, same as any other container behind it.

**Sanity check after deploying:** `curl https://your-domain/api/health` should return
`{"status":"ok","dataSource":"rescuegroups",...}`. If it says `"mock"` instead, the
`RESCUEGROUPS_API_KEY` environment variable didn't reach the container — check the stack's env
var settings, not just the `.env` file (Portainer stacks don't always read a `.env` file sitting
next to the compose file the way plain `docker compose` does).

## Real pet data: RescueGroups.org integration

Carried over verbatim from the Android app's confirmed-working integration (the original had two
rounds of live PowerShell testing against the real API — see `src/rescuegroupsService.js`'s
comments for the full field-by-field story). Quick summary:

- RescueGroups.org has *two* separate APIs. This app uses the **legacy HTTP API**
  (`api.rescuegroups.org/http/v2.json`, POST-based, `apikey`/`objectType`/`objectAction`/`search`
  envelope) — NOT the newer v5 beta API, which uses a different key format entirely. The key
  from RescueGroups' standard "Request an API Key" form is a legacy key.
- **Confirmed real animal fields:** `animalID`, `animalOrgID`, `animalName`, `animalSpecies`,
  `animalGeneralAge`, `animalSex`, `animalBreed`, `animalDescription`, `animalStatus`,
  `animalThumbnailUrl`, `animalMixedBreed`, `animalAltered`, `animalDeclawed`,
  `animalHousetrained`, `animalPictures`, `animalKillDate`, `animalGeneralSizePotential`
  (note the casing), `animalSpecialneeds` (lowercase "n"), `animalAvailableDate`.
- **Confirmed real org fields (complete set — no capacity field exists):** `orgID`, `orgName`,
  `orgEmail`, `orgPhone`, `orgFax`, `orgAddress`, `orgCity`, `orgState`, `orgPostalcode`,
  `orgCountry`, `orgAbout`.

## Known limitations of the real data

- **"Urgent" is this app's own heuristic score, not a single RescueGroups field.**
  `Pet.isUrgent` is `true` when EITHER `animalKillDate` is set (a shelter's own
  at-risk/euthanasia-timeline flag — confirmed essentially dormant: 0 of 2,250 sampled available
  animals nationwide) OR `animalAvailableDate` parses to 60+ days ago (confirmed genuinely
  populated: 238 of 2,000 sampled, ~12%, in plain `M/d/yyyy` form with no time component). A
  minority of real `animalAvailableDate` values are dated in the future relative to when
  sampled; that's handled safely since a future date yields a negative day count that can never
  clear the threshold. The raw date and any kill-reason text are never shown in the UI — only
  the generic "needs a home urgently" badge/banner.
- **Shelter/organization-level capacity (over-capacity, near-capacity) is confirmed *not*
  available in this API at all** — checked both the org fields RescueGroups accepts and a
  third-party field reference for this same API. `shelter.capacityStatus` is always `"unknown"`
  on real data (sample data hand-sets it to demonstrate what the UI looks like); this isn't a
  field-naming problem, the data simply isn't part of what shelters submit to RescueGroups.
- **"Good with kids/dogs/cats" traits aren't available** — several casing variants
  (`animalOkwithcats`/`animalOkWithCats` and siblings) were tried against the live API and all
  came back invalid.
- **Only "urgent only" still filters client-side, after a page loads.** Species, age, gender,
  breed, size, and name are all sent to RescueGroups (or matched in `mockData.js`) as real
  filters (`equals` for species/age/gender/size, `contains` for name/breed text search) — see
  `searchPets()` in `src/rescuegroupsService.js`. "Urgent" has no filter to send at all, since
  it's this app's own two-field heuristic, not a single RescueGroups field, so it's the one case
  where a filtered page can still come back with fewer results than `pageSize` even when more
  urgent pets exist further in. `hasMore`/pagination math is based on the server-side result
  count from *before* that one client-side urgentOnly filter.
- **The browse-page Gender and Breed filters (added 2026-09-07) mirror Petfinder's own filter
  sidebar for the fields RescueGroups actually has.** Gender maps directly to `animalSex`; Breed
  is a `contains` search on `animalBreed`, since that field is free text a shelter typed in, not
  a clean breed taxonomy like Petfinder's own breed picker — searching "Labrador" will match "Lab
  Mix", "Labrador Retriever", etc., but won't do fuzzy/synonym matching beyond that. The Breed
  field is a Select2 combobox (added 2026-09-07) with a curated list of common breeds by species
  as suggestions, but still accepts any free text via Select2's `tags: true` — the suggestion list
  is a convenience, not a restriction, since a real value like "Lab/Pit Mix" won't be in it.
  Results still live-update after every keystroke, matching how the field behaved before Select2.
- **The pet detail page's "← Back" link returns to your exact filtered listing view
  (2026-09-07)**, not a blank, unfiltered `browse.html`. Every pet card (`renderPetCard()` in
  `public/js/common.js`) now appends a `ref` query param carrying the exact listing page + query
  string it was rendered on (e.g. `browse.html?species=Dog&state=CA`, or `favorites.html`) —
  `pet.js`'s `resolveBackHref()` only trusts that value if it points at one of this app's own
  three listing pages (optionally with a query string); anything else falls back to plain
  `browse.html`, same as before this fix.
- **The pet detail page has a sticky left section-jump menu (Photos/About/Story/Shelter)
  (2026-09-07)**, added after Jose noticed a duplicate "Back to browse" link (removed — the hero's
  own "← Back" button already covers that) and asked for Petfinder-style section highlights, but
  explicitly as a left-side menu rather than a copy of this app's own top nav. Built with plain
  browser APIs only — `scroll-behavior: smooth` for the jump, `IntersectionObserver` in
  `initScrollSpy()` (`public/js/pet.js`) for the active-section highlight — no jQuery scroll-spy
  plugin, since jQuery isn't loaded on this page and nothing here needs a library the platform
  doesn't already provide. See `buildToc()`/`initScrollSpy()` in `pet.js` and `.detail-layout`/
  `.detail-toc` in `styles.css`; collapses to a plain non-sticky row above the content below 820px.
- **The pet detail page's Age/Sex/Size line was redesigned (2026-09-07)** from one small,
  dot-separated sentence (`Labrador Retriever Mix · Senior · Male · Large`) into a bigger breed
  line plus bold icon+value "trait chips" (🎂 **Senior**, ♂ **Male**, 📏 **Large**) — loosely
  inspired by Petfinder's icon+label physical-traits layout, but built from this app's own
  chip/pill visual language (see `.attr-tag`) and existing emoji set rather than copying
  Petfinder's specific design. See `traitChip()`/`sexIcon()` in `public/js/pet.js` and
  `.detail-breed`/`.detail-traits`/`.detail-trait` in `public/css/styles.css`.
  Petfinder
  sidebar filters with **no RescueGroups equivalent at all** (confirmed unavailable, not just
  unbuilt): "Good With" kids/dogs/cats (see above), Coat Length, and Color — none of these were
  found as real fields when the animal field list was originally confirmed field-by-field against
  the live API.
- **Location filtering is state-level only, not city/ZIP/radius.** Type a two-letter state code
  (or "City, XX" — only the trailing code is read) into the state field. Under the hood this
  fetches up to 250 shelter IDs in that state (RescueGroups' page cap), then filters animals to
  just those shelters — for a large state this is a sample, not exhaustive coverage.
- **Name search is server-side `contains` on `animalName` only** — it does not also search
  breed text (that's now its own separate Breed filter, not folded into name search, so the two
  can be combined -- e.g. name contains "Duke" AND breed contains "Shepherd").
- **Some shelters list promotional text as the pet's name** (e.g. "ADOPTION-Read First") instead
  of an individual pet's actual name — that's how the shelter entered its own data, not a bug in
  this app.

## Notable scope decisions

- **Plain HTML/CSS/JS, no framework** — matches the scale of a personal project, needs no build
  step, and was easiest for this to be genuinely tested end-to-end (server run, API hit with
  curl, pages screenshotted) rather than shipped unbuilt, which is what actually happened
  throughout the original Android app's development (no Android SDK was available there).
- **Favorites are `localStorage`-only, per-browser, not synced across devices.** This mirrors
  the Android app's per-device offline favorites, just scoped to a browser instead of a device.
  A server-side favorites store (a small JSON file or SQLite database) would be a natural
  follow-up if cross-device sync matters later.
- **The API key lives only on the server**, read from the `RESCUEGROUPS_API_KEY` environment
  variable — never sent to or embedded in anything the browser receives. This was one of the
  concrete motivations for moving off a native Android app in the first place.
- **Single Docker container, no separate frontend/backend containers** — simplest possible
  Portainer deployment; the static files and the API are served by the same Express process.
- **The State filter is a [Select2](https://select2.org) searchable dropdown with a per-state flag
  icon** (flags extracted from the MIT/ISC-licensed `us-state-flags` npm package and bundled
  locally at `public/img/state-flags/`, not fetched from a CDN), loaded from cdnjs.cloudflare.com
  (jQuery + Select2, both pinned to exact versions) rather than installed via a package manager —
  consistent with the "no build step" decision above. The dropdown/flag/fallback logic itself
  lives once in `initStateSelect2()` in `public/js/common.js` (added 2026-09-07) and is shared by
  both the browse page's Location filter and the landing page's hero search, so they look and
  behave identically. If the CDN scripts ever fail to load (offline, CDN outage, a restrictive
  network), it falls back to a plain native `<select>` with the same 50 states + DC, so the filter
  keeps working either way, just without the flags or type-to-search UI. The landing page's hero
  Species dropdown (added 2026-09-07) similarly gets a Select2 upgrade purely for icon + modern
  pill styling (🐶/🐱/🐰/🐦/🐾, reusing this app's existing species-emoji set), with the search box
  turned off since it's only 5 options — same CDN-failure fallback to a plain `<select>`.
- **Missing/broken pet photos fall back to a bundled placeholder graphic**
  (`public/img/photo-placeholder.svg`, added 2026-09-07), instead of showing a flat, blank box.
  `applyPhoto()` in `public/js/common.js` handles two separate cases: a pet with no photo at all
  (some shelters just don't provide one), and a photo URL that's present but broken (a dead link
  on RescueGroups' end) — the latter is probed with a real `Image()` in parallel with an
  optimistic `background-image` set, since a bad URL in a CSS background-image fails completely
  silently otherwise. Used by both the browse/favorites/landing pet cards and the pet detail
  page's hero photo; the detail page's thumbnail strip (plain `<img>` tags, not backgrounds) uses
  a simpler native `onerror` handler to hide a broken thumbnail outright.
- **Browse/favorites/landing pet cards get a mouse-tracked "parallax depth" tilt on hover**
  (`enableTiltEffect()` in `public/js/common.js`, added 2026-09-07) — a `perspective`/`rotateX`/
  `rotateY` tilt of the whole card plus an independent, oppositely-shifted photo layer for the
  parallax illusion, and a small radial-gradient highlight that tracks the cursor, in the style of
  effects like [this CodePen](https://codepen.io/andymerskin/pen/XNMWvQ). Implemented in plain JS
  rather than a jQuery plugin, since nothing about a CSS 3D transform or a repainted background
  gradient needs jQuery specifically — consistent with this project's general preference for a
  native approach over an extra dependency (see the scroll-spy and loading-spinner decisions
  above). Skipped entirely on touch/coarse pointers (`pointer: fine` media query) and when
  `prefers-reduced-motion: reduce` is set, since a hover tilt has no meaning on a touchscreen and
  shouldn't run for anyone who's asked for less motion.
- **The pet detail page's photo gallery swaps via a growing circular "wipe"** instead of an
  instant swap, and its thumbnails are now circular overlays on the hero photo itself (bottom
  center) rather than a square filmstrip below it — inspired by
  [this CodePen](https://codepen.io/ste-vg/pen/WNvYWKr) ("Circle Swap Photo Gallery"). Reimplemented
  as a plain CSS `clip-path` transition on a second photo layer (`circleSwapPhoto()` in
  `public/js/pet.js`) rather than that pen's own React + GSAP animation, growing from wherever the
  clicked thumbnail sits out to a radius that covers the whole hero, then settling the new photo
  in as the base layer. Clicking rapidly across thumbnails can't leave the animation stuck — each
  click gets its own token, and a stale finish step recognizes it's been superseded and backs off.
  Falls back to an instant swap under `prefers-reduced-motion: reduce`.
- **The shelter address (under the Shelter section) has a hovering/focusable map pin** that lifts
  with a snappy `cubic-bezier(0.645, 0.045, 0.355, 1)` easing curve, matching the interaction in
  [this CodePen](https://codepen.io/bobbyjnichols/pen/WYMzMd) ("Map Pin Hover") — pure CSS, no JS,
  same as that pen. The address itself is now also a link to Google Maps (same destination as the
  existing "Open in Maps" button), since this app has no Maps Static API key to render an actual
  map image behind the pin.
- **Fixed a phantom-scrollbar glitch on the pet detail hero** — hovering a circular thumbnail
  (which scales up slightly via `transform: scale(1.08)`) was popping a real vertical scrollbar
  over the photo. Root cause: `.detail-hero__thumbs` only set `overflow-x: auto`, and per the CSS
  spec, a non-`visible` value on one overflow axis forces the other axis to compute as `auto` too
  (so it can't "leak" scrollable content) — meaning `overflow-y` was implicitly `auto`, and the few
  extra pixels of scale-transform overflow were enough to trigger a browser-rendered scrollbar.
  Fixed by adding an explicit `overflow-y: hidden;` alongside it, which clips that harmless sliver
  instead of scrolling to it.
- **The Share button is a "pull apart" pill on any mouse-driven (fine-pointer) device** instead of
  a single "↗ Share" button, in the style of
  [this CodePen](https://codepen.io/RobVermeer/pen/aNYQMx) — it rests looking like a normal button,
  then on hover/focus/tap expands to reveal four real share targets (X/Twitter, Facebook, WhatsApp,
  Copy Link), each popping in with an elastic overshoot easing borrowed from
  [this CodePen](https://codepen.io/chrisdothtml/pen/azPYqq). Built in `buildSharePull()` in
  `public/js/pet.js` and `.share-pull*` in `public/css/styles.css`, using a CSS `width` transition
  plus cross-fading label/icon layers rather than either pen's own markup (Font Awesome icons and a
  demo auto-play timer for the first; five separate always-visible buttons needing Font Awesome for
  the second). Gated on `matchMedia('(pointer: fine)')`, not on whether
  [`navigator.share()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share) exists —
  the original version gated purely on `navigator.share`, which broke on real desktop Chrome
  (modern desktop browsers implement it too, not just phones/tablets the way they used to), so the
  button silently rendered as the exact same old plain pill there with no hover reveal at all. Now
  a coarse-pointer (touch) device with `navigator.share` gets the native OS share sheet, since hover
  doesn't exist there anyway; every mouse-driven device gets the pull-apart pill. Unlike either
  pen's own demo links, every icon here goes somewhere real: Twitter/X and Facebook use their
  standard web share-intent URLs, WhatsApp uses `wa.me`, and Copy Link reuses the existing
  clipboard-write-with-`prompt()`-fallback chain already used elsewhere in the app. The four icons
  are inline SVG (`SHARE_ICONS` in `public/js/pet.js`), not emoji — the first version used
  🐦/📘/💬/🔗, which render wildly inconsistently across platforms (unrecognizable colored blobs on
  Windows Chrome specifically, nothing like an actual brand mark); an SVG with
  `fill="currentColor"` draws identically everywhere and still inherits the button's rest/hover
  colors for free.
- **The pet detail hero shows the whole photo, never cropped**, instead of filling the box via
  `background-size: cover` (which cut off ears, tails, or faces on any photo that wasn't already a
  4:3 landscape). `.detail-hero__base`/`__reveal` now use `background-size: contain`, and a new
  `.detail-hero__backdrop` layer sits behind them holding a heavily blurred, darkened, oversized
  copy of the same photo (`filter: blur(28px) brightness(0.65) saturate(1.15)`) so a non-4:3 photo
  letterboxes onto an on-theme blurred version of itself instead of bare background color. Browse
  and Favorites pet cards intentionally keep `cover` — small, mixed-aspect cards where full-photo
  letterboxing would waste a lot of card space — this fix is scoped to the single large hero photo,
  where seeing the whole pet actually matters.
- **The left section-jump menu's "Shelter" link (or whichever section is last) now reliably
  highlights at the bottom of the page.** It didn't always before: the active-section
  `IntersectionObserver` only marks a section "current" once it scrolls into a thin band just below
  the sticky header, and a short trailing section can end before the page has any scroll room left
  to ever carry it into that band — the browser simply can't scroll further once it hits the bottom
  of the document. Fixed by folding a "we've reached the bottom of the page" check directly into
  the same `refreshActive()` function the observer already calls (also wired to a `scroll`
  listener), so the very last section's link wins outright once nothing can scroll any further,
  regardless of what the observer itself reports.
- **Clicking a section-jump link now always highlights the section you actually clicked**, even on
  a short pet page. The `scroll-margin-top` fix below stops the sticky header from covering the
  target section's own heading, but on a page short enough that everything below the hero fits in
  one screen, the document can run out of scroll room before that section's top ever reaches the
  scroll-spy's activation line — without this, clicking "About" could scroll to the right place
  while the menu kept a different link (often "Shelter", via the bottom-of-page fallback above)
  highlighted instead. `pinActiveSection()` in `public/js/pet.js` highlights the clicked link
  immediately and holds it for ~1.2s (long enough for the smooth scroll to settle) before handing
  control back to normal scroll-driven detection.
- **Clicking a section-jump link no longer scrolls past that section's own heading.** `.detail-
  content > section` now has `scroll-margin-top: 96px` (matching the scroll-spy's own header-offset
  buffer), since `scrollIntoView({ block: 'start' })` otherwise aligns a section flush with the very
  top of the viewport — directly behind the sticky `.app-header` — which hid short sections' (like
  About's) own heading behind the header and made the click look like it had jumped into the
  *next* section instead.
- **A new About page (`about.html`)** explains what AdoptScout is and why it exists, and credits
  its creator, Jose Lopez Jr, with a link to his LinkedIn — also linked from a small credit line
  added to every page's footer, alongside the existing RescueGroups.org attribution.

## Project layout

```
AdoptScout/
  server.js                 Express app entrypoint
  src/
    rescuegroupsService.js  RescueGroups.org integration (real data)
    mockData.js             Sample data fallback
    routes/pets.js          /api/pets JSON API
  public/
    index.html                Landing page (hero, category tiles, featured pets, RescueGroups credit)
    browse.html, pet.html, favorites.html
    css/styles.css
    js/common.js, landing.js, browse.js, pet.js, favorites.js
  test/run-tests.js         Offline logic test suite (npm test)
  Dockerfile, docker-compose.yml, .env.example
```
