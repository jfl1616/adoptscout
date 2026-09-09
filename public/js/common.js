'use strict';

/**
 * Shared helpers used by browse.js, pet.js, and favorites.js. Loaded as a plain script (no
 * bundler, no modules) -- everything hangs off `window.AdoptScout` so page scripts can just use
 * it after this tag runs first.
 *
 * Favorites are stored client-side in localStorage as full pet objects (not just IDs), so the
 * Favorites page can render fully offline without a second round-trip to the server -- same
 * spirit as the Android app's DataStore-backed offline-browsable favorites, just per-browser
 * instead of per-device.
 */

const FAVORITES_KEY = 'adoptscout:favorites';
/** This app was called "LA Pet Adopt" before it was renamed to AdoptScout (the old name was
 * inaccurate once the app covered pets nationwide, not just LA). One-time migration so anyone
 * who already saved favorites under the old key doesn't lose them silently. Safe to remove once
 * this has shipped for a while and the old key is very unlikely to still exist anywhere. */
const LEGACY_FAVORITES_KEY = 'lapetadopt:favorites';
function migrateLegacyFavorites() {
  try {
    if (localStorage.getItem(FAVORITES_KEY) !== null) return;
    const legacy = localStorage.getItem(LEGACY_FAVORITES_KEY);
    if (legacy !== null) {
      localStorage.setItem(FAVORITES_KEY, legacy);
      localStorage.removeItem(LEGACY_FAVORITES_KEY);
    }
  } catch (e) {
    // Storage blocked entirely (private browsing, etc.) -- nothing to migrate either way.
  }
}
migrateLegacyFavorites();

const SPECIES_EMOJI = {
  Dog: '🐶', Cat: '🐱', Rabbit: '🐰', Bird: '🐦', Horse: '🐴',
  'Small & Furry': '🐹', Reptile: '🦎', 'Barnyard': '🐐'
};

function getFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('Could not read favorites from localStorage (private browsing / storage blocked?)', e);
    return {};
  }
}

function saveFavorites(favorites) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  } catch (e) {
    console.warn('Could not save favorites to localStorage', e);
  }
}

function isFavorite(petId) {
  return !!getFavorites()[petId];
}

function toggleFavorite(pet) {
  const favorites = getFavorites();
  if (favorites[pet.id]) {
    delete favorites[pet.id];
  } else {
    favorites[pet.id] = pet;
  }
  saveFavorites(favorites);
  return !!favorites[pet.id];
}

async function fetchJSON(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function speciesEmoji(species) {
  return SPECIES_EMOJI[species] || '🐾';
}

/** Tiny DOM-builder helper so page scripts don't need innerHTML string-concatenation (which is
 * an easy way to accidentally break on a pet name containing a quote or special character). */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  });
  (Array.isArray(children) ? children : [children]).forEach((child) => {
    if (child === null || child === undefined) return;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return node;
}

/** Captures "where this card is being rendered, exactly as the visitor currently sees it" --
 * e.g. `browse.html?species=Dog&state=CA` -- so the pet detail page's Back button can return to
 * this *exact* filtered view instead of a blank `browse.html`. Reads the live URL at render time
 * rather than being passed in by each caller, since `browse.js` already keeps the address bar in
 * sync with the current filters via `history.replaceState` (see setUrlState()) every time a
 * filter changes -- by the time any card is rendered, `window.location.search` already reflects
 * whatever's currently selected, so this needs no extra plumbing. Falls back to `index.html` for
 * the root path (this app's landing page has no query-string state of its own to preserve). */
function currentPageRef() {
  const file = window.location.pathname.split('/').pop() || 'index.html';
  return `${file}${window.location.search}`;
}

/** Sets `target`'s background-image to `photoUrl`, or marks it with `emptyClass` (wired up in
 * CSS to a placeholder graphic, `img/photo-placeholder.svg`) when there's no photo at all -- some
 * shelters just don't provide one. Also guards against a photo URL that's *present but broken*
 * (a dead link on RescueGroups' end -- this does happen): a bad URL in a CSS background-image
 * fails completely silently, and these are background-image divs rather than `<img>` tags (for
 * the gradient-scrim-over-photo look), so a plain `onerror` handler doesn't apply here. Sets the
 * image optimistically first so the common case (a photo that loads fine) never waits on an
 * extra round trip, then probes it with a real `Image()` in parallel and swaps to the placeholder
 * only if that probe actually fails. */
function applyPhoto(target, photoUrl, emptyClass) {
  if (!photoUrl) {
    target.classList.add(emptyClass);
    return;
  }
  target.style.backgroundImage = `url('${photoUrl.replace(/'/g, "\\'")}')`;
  const probe = new Image();
  probe.onerror = () => {
    target.style.backgroundImage = '';
    target.classList.add(emptyClass);
  };
  probe.src = photoUrl;
}

/** Lightweight "parallax depth" hover tilt for a pet card -- the mouse-tracked 3D tilt plus a
 * moving highlight, in the style of pens like https://codepen.io/andymerskin/pen/XNMWvQ.
 * Reimplemented here in plain JS against this app's own single-photo cards rather than pulling in
 * a library: a `perspective`/`rotateX`/`rotateY` transform and a radial-gradient highlight that
 * tracks the cursor don't need anything jQuery/plugin-specific, and this project already prefers
 * a native approach over an extra dependency when one isn't actually required (see the scroll-spy
 * and CSS-spinner decisions elsewhere in this app). Skipped entirely on touch/coarse pointers --
 * tilt has no meaning without a hovering cursor -- and when the visitor has asked for reduced
 * motion. `photoLayer` is the inner image layer that shifts opposite the cursor for the parallax
 * depth illusion; `glare` is a plain overlay div whose background is repainted into a small
 * radial highlight following the cursor for the glossy "sheen" half of the effect. */
function enableTiltEffect(card, photoLayer, glare) {
  if (!window.matchMedia || !window.matchMedia('(pointer: fine)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const MAX_TILT_DEG = 8;
  const PHOTO_SHIFT_PX = 10;

  function handleMove(event) {
    const rect = card.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    const rotateY = (px - 0.5) * MAX_TILT_DEG * 2;
    const rotateX = (0.5 - py) * MAX_TILT_DEG * 2;
    card.style.transform = `perspective(700px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateY(-2px) scale(1.03)`;
    photoLayer.style.transform = `translate(${((0.5 - px) * PHOTO_SHIFT_PX).toFixed(1)}px, ${((0.5 - py) * PHOTO_SHIFT_PX).toFixed(1)}px) scale(1.12)`;
    glare.style.opacity = '1';
    glare.style.background = `radial-gradient(circle at ${(px * 100).toFixed(1)}% ${(py * 100).toFixed(1)}%, rgba(255,255,255,0.5), rgba(255,255,255,0) 55%)`;
  }

  function reset() {
    card.style.transform = '';
    photoLayer.style.transform = '';
    glare.style.opacity = '0';
  }

  card.addEventListener('mousemove', handleMove);
  card.addEventListener('mouseleave', reset);
  card.addEventListener('blur', reset);
}

/** Renders one pet card for the Browse/Favorites/landing grids. `onFavoriteChange` is called
 * after a favorite toggle so the caller can re-render (e.g. remove the card immediately on the
 * Favorites page). */
function renderPetCard(pet, { onFavoriteChange } = {}) {
  const card = el('a', {
    class: 'pet-card',
    href: `pet.html?id=${encodeURIComponent(pet.id)}&ref=${encodeURIComponent(currentPageRef())}`
  });
  const photoDiv = el('div', { class: 'pet-card__photo' });

  const photoLayer = el('div', { class: 'pet-card__photo-img' });
  applyPhoto(photoLayer, pet.photos && pet.photos[0], 'pet-card__photo-img--empty');
  photoDiv.appendChild(photoLayer);

  const glare = el('div', { class: 'pet-card__glare' });
  photoDiv.appendChild(glare);

  if (pet.isUrgent) {
    photoDiv.appendChild(el('span', { class: 'badge badge--urgent' }, 'Urgent'));
  }

  const favBtn = el('button', {
    class: `fav-btn${isFavorite(pet.id) ? ' fav-btn--active' : ''}`,
    type: 'button',
    'aria-label': 'Toggle favorite',
    onclick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nowFavorite = toggleFavorite(pet);
      favBtn.classList.toggle('fav-btn--active', nowFavorite);
      if (typeof onFavoriteChange === 'function') onFavoriteChange(pet, nowFavorite);
    }
  }, '♥');
  photoDiv.appendChild(favBtn);
  card.appendChild(photoDiv);

  card.appendChild(el('div', { class: 'pet-card__info' }, [
    el('h3', {}, `${speciesEmoji(pet.species)} ${pet.name}`),
    el('p', {}, `${pet.breed} · ${pet.age}`)
  ]));

  enableTiltEffect(card, photoLayer, glare);

  return card;
}

function googleMapsUrl(shelter) {
  const parts = [shelter.address, shelter.city, shelter.state, shelter.postalCode].filter(Boolean);
  const query = encodeURIComponent(parts.join(', ') || shelter.name);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/**
 * Best-effort, silent geolocation-based personalization, shared by the landing page (the "near
 * you" featured strip) and the browse page (pre-filling the state filter). Uses the browser's
 * own Geolocation API (shows the browser's native permission prompt -- nothing here bypasses or
 * pre-answers that) and, only on success, reverse-geocodes the coordinates via BigDataCloud's
 * free client-side reverse-geocode endpoint (no API key, CORS-enabled, built for exactly this
 * "turn a lat/lng into an approximate city/state, called straight from the browser" use case --
 * there's no server-side geocoding here, so this app's own server never needs outbound network
 * access for this feature: it's the visitor's browser making the call). Every failure mode --
 * permission denied, no geolocation support, a network hiccup reaching BigDataCloud, a non-US
 * result with no 2-letter state code -- resolves to `null` rather than throwing, so callers can
 * fall back silently to their normal nationwide behavior. This is a nice-to-have personalization
 * touch, never a hard dependency for either page.
 *
 * IMPORTANT: `getCurrentPosition`'s own `timeout` option only starts counting once permission
 * has been granted -- while its permission prompt is still up (unanswered, or in some
 * browsers/automation contexts never shown at all -- confirmed while testing this app in a
 * headless browser with no prompt UI), NEITHER callback ever fires, so relying only on that
 * option can hang this promise forever. A real visitor who simply ignores the permission popup
 * would hit the exact same hang. This wraps the whole call in its own independent timeout so
 * `detectLocation()` is guaranteed to settle within ~6 seconds no matter what the browser does.
 */
function detectLocation() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    if (!navigator.geolocation) {
      finish(null);
      return;
    }

    setTimeout(() => finish(null), 6000);

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const { latitude, longitude } = position.coords;
          const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`;
          const res = await fetch(url);
          const data = await res.json();
          const city = data.city || data.locality || null;
          const subdivisionCode = data.principalSubdivisionCode || '';
          // BigDataCloud returns e.g. "US-CA" -- take the part after the dash, and only trust it
          // if it's a plausible 2-letter US state code (this app's state filtering is US-state-
          // only, per RescueGroups' own org data).
          const stateCode = subdivisionCode.includes('-') ? subdivisionCode.split('-').pop() : null;
          if (stateCode && /^[A-Za-z]{2}$/.test(stateCode)) {
            finish({ city, state: stateCode.toUpperCase() });
          } else {
            finish(null);
          }
        } catch (err) {
          finish(null);
        }
      },
      () => finish(null), // permission denied or position unavailable
      { timeout: 5000, maximumAge: 15 * 60 * 1000 }
    );
  });
}

/** Builds the "Showing sample data" disclosure banner shown wherever a page's data might have
 * come from the mock/offline source instead of live RescueGroups shelters -- Browse, pet detail,
 * and the landing page's featured/urgent strip. Shared in one place (rather than each page
 * hand-writing the same string) specifically so the wording can't drift between pages: this
 * disclosure matters most exactly where the app makes a claim that could otherwise read as real
 * (e.g. the landing page's "🚨 Pets who need you most near Los Angeles, CA" -- a location- and
 * urgency-flavored claim that would be actively misleading if shown for made-up sample pets with
 * no visible caveat). Every caller already knows `source === 'mock'` before calling this; it just
 * builds the element, it doesn't decide when to show it.
 *
 * `reason` (from the API response's own `reason` field -- see petSource.js) picks which of two
 * messages to show, since they call for different next steps: `'unreachable'` means a real API
 * key IS configured but RescueGroups just failed or is still in its post-failure cooldown -- for
 * that case, telling the visitor to "set RESCUEGROUPS_API_KEY" would be actively wrong, since one
 * is already set. Anything else (including no `reason` at all, e.g. an older cached response)
 * falls back to the original "unconfigured" wording, which was the only case that existed before
 * the reachability-based fallback selector shipped. */
function buildSourceBanner(reason) {
  const message = reason === 'unreachable'
    ? 'Showing sample data — RescueGroups is temporarily unreachable. Live shelters will come back automatically once it recovers.'
    : 'Showing sample data — set RESCUEGROUPS_API_KEY on the server to see live shelters.';
  return el('div', { class: 'source-banner' }, message);
}

/** Renders the "📍 Showing pets near {City, ST}. Not you? ..." banner into `bannerEl` for a
 * successfully-detected `location` (see detectLocation). `onReset` runs when the visitor clicks
 * the reset link -- each page wires this to its own state input (browse.js also clears its
 * filter and re-searches; landing.js just focuses the field for the visitor to type into). */
function renderLocationBanner(bannerEl, location, onReset) {
  if (!bannerEl || !location) return;
  const label = location.city ? `${location.city}, ${location.state}` : location.state;
  bannerEl.innerHTML = '';
  bannerEl.appendChild(el('span', {}, `📍 Showing pets near ${label}.`));
  bannerEl.appendChild(document.createTextNode(' '));
  const resetLink = el('a', { href: '#', class: 'location-banner__reset' }, 'Not you? Search a different state above.');
  resetLink.addEventListener('click', (event) => {
    event.preventDefault();
    if (typeof onReset === 'function') onReset();
  });
  bannerEl.appendChild(resetLink);
  bannerEl.hidden = false;
}

/** US states + DC, for the Select2-powered state dropdowns on both the Browse page's Location
 * filter and the landing page's hero search -- RescueGroups' own state filtering (see
 * extractStateCode/orgIdsForState in rescuegroupsService.js) only ever deals in 2-letter US
 * state codes, so that's the full option set. Shared here (rather than duplicated per page) so
 * both dropdowns look and behave identically. */
const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
  ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'],
  ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'], ['WY', 'Wyoming']
];

/** Renders one state's flag icon + name for Select2's dropdown list (`templateResult`) and its
 * closed-box display (`templateSelection`). `state` is the option-wrapper object Select2 passes
 * in, not a plain string -- `state.id` is the <option>'s value (a state code, or "" for the
 * blank "Any state" option, which has no flag and is returned as plain text). Flags are bundled
 * locally at `img/state-flags/<CODE>.svg` (extracted from the MIT/ISC-licensed `us-state-flags`
 * npm package at build time, not fetched from a CDN) so this doesn't add another third-party
 * runtime dependency alongside Select2 itself. */
function formatStateOption(state) {
  if (!state.id) return state.text;
  const $wrapper = window.jQuery('<span class="state-option"></span>');
  window.jQuery('<img>', {
    src: `img/state-flags/${state.id}.svg`,
    class: 'state-flag-icon',
    alt: '',
    loading: 'lazy',
    width: 20,
    height: 13
  }).appendTo($wrapper);
  $wrapper.append(document.createTextNode(state.text));
  return $wrapper;
}

/**
 * Turns a plain, empty <select> into a Select2-powered US-state dropdown with per-state flag
 * icons -- shared by the Browse page's Location filter and the landing page's hero search so
 * both look and behave identically instead of each page hand-rolling its own copy. Falls back to
 * a plain native <select> (text only, no flags) if jQuery/Select2 failed to load from the CDN --
 * native <option> elements can't show images at all, so the flags are a Select2-only enhancement;
 * the fallback just shows text and still works.
 *
 * `onChange(code)` fires on every real, visitor-driven selection change -- NOT on programmatic
 * `setValue()` calls (see setValue's own doc below for why that distinction matters: Select2 only
 * repaints its box in response to a real "change" event, so setValue has to trigger one anyway,
 * and callers don't want that to double-fire a search). Returns `{ setValue }` so the caller can
 * still update the field programmatically (from a URL param, detected geolocation, or a "clear
 * filters" action) while keeping Select2's own rendered display in sync.
 */
function initStateSelect2(selectEl, { onChange, placeholder, width } = {}) {
  let suppressChange = false;

  US_STATES.forEach(([code, name]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${name} (${code})`;
    selectEl.appendChild(opt);
  });

  if (window.jQuery && window.jQuery.fn && window.jQuery.fn.select2) {
    window.jQuery(selectEl).select2({
      width: width || '100%',
      placeholder: placeholder || 'Any state',
      allowClear: true,
      templateResult: formatStateOption,
      templateSelection: formatStateOption
    });
    window.jQuery(selectEl).on('change', () => {
      if (!suppressChange && typeof onChange === 'function') onChange(selectEl.value);
    });
  } else {
    console.warn('Select2/jQuery did not load (CDN unreachable?) -- state field falls back to a plain dropdown.');
    selectEl.addEventListener('change', () => {
      if (!suppressChange && typeof onChange === 'function') onChange(selectEl.value);
    });
  }

  function setValue(code) {
    suppressChange = true;
    if (window.jQuery) {
      window.jQuery(selectEl).val(code || '').trigger('change');
    } else {
      selectEl.value = code || '';
    }
    suppressChange = false;
  }

  return { setValue };
}

/**
 * Header behavior shared by all five pages: a scroll-aware sticky header (glassy/transparent at
 * the top of the page, solid with a shadow once scrolled -- see `.app-header--scrolled` in
 * styles.css) and, on narrow screens, a hamburger-triggered slide-in nav drawer. Runs
 * automatically on every page that has a `.app-header` (this file is loaded on all of them,
 * including about.html which has no other JS) -- there's nothing page-specific to opt into.
 *
 * The drawer replaces what used to be a plain horizontal nav that quietly overflowed/got clipped
 * on narrow phones (the "About" link showing as just "Ab...", reported after AdoptScout first
 * went live) -- see styles.css's `@media (max-width: 700px)` block for the drawer's own layout.
 */
function initHeader() {
  const header = document.querySelector('.app-header');
  if (!header) return;

  const nav = header.querySelector('.app-nav');
  const toggle = header.querySelector('.nav-toggle');
  const scrim = header.querySelector('.nav-scrim');

  // "Vercel tabs"-style sliding underline: one indicator span, moved under whichever link is
  // hovered, that snaps back under the current page's .active link when the pointer leaves the
  // nav entirely. See the .app-nav__indicator comment in styles.css for the visual reasoning.
  // Desktop-only -- the mobile drawer below uses a left-border accent instead (an underline
  // doesn't read the same way under a stacked vertical list).
  if (nav) {
    const indicator = document.createElement('span');
    indicator.className = 'app-nav__indicator';
    indicator.setAttribute('aria-hidden', 'true');
    nav.appendChild(indicator);

    const isDesktopNav = () => window.matchMedia('(min-width: 701px)').matches;

    function moveIndicatorTo(link) {
      if (!link) {
        indicator.style.width = '0';
        return;
      }
      indicator.style.width = `${link.offsetWidth}px`;
      indicator.style.transform = `translateX(${link.offsetLeft}px)`;
    }

    function syncIndicatorToActive() {
      if (!isDesktopNav()) return;
      moveIndicatorTo(nav.querySelector('a.active'));
    }

    nav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('mouseenter', () => {
        if (isDesktopNav()) moveIndicatorTo(link);
      });
    });
    nav.addEventListener('mouseleave', syncIndicatorToActive);

    syncIndicatorToActive();
    // Re-measure after fonts/layout settle, and whenever the viewport crosses the drawer
    // breakpoint or is resized -- offsetLeft/offsetWidth are only meaningful once the row has
    // actually laid out at its final size.
    window.addEventListener('load', syncIndicatorToActive);
    window.addEventListener('resize', syncIndicatorToActive);
  }

  if (!toggle || !nav) return;

  function closeMenu() {
    nav.classList.remove('app-nav--open');
    if (scrim) scrim.classList.remove('nav-scrim--visible');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('nav-open-lock');
  }

  function openMenu() {
    nav.classList.add('app-nav--open');
    if (scrim) scrim.classList.add('nav-scrim--visible');
    toggle.setAttribute('aria-expanded', 'true');
    document.body.classList.add('nav-open-lock');
  }

  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.contains('app-nav--open');
    if (isOpen) closeMenu(); else openMenu();
  });
  if (scrim) scrim.addEventListener('click', closeMenu);
  nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  // Resizing (or rotating) past the drawer breakpoint while it's open would otherwise leave the
  // drawer's open state (and the body scroll lock) stuck even once .app-nav is back to laying
  // out horizontally.
  window.matchMedia('(min-width: 701px)').addEventListener('change', (e) => {
    if (e.matches) closeMenu();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHeader);
} else {
  initHeader();
}

window.AdoptScout = {
  getFavorites, saveFavorites, isFavorite, toggleFavorite,
  fetchJSON, speciesEmoji, el, renderPetCard, googleMapsUrl,
  detectLocation, renderLocationBanner, initStateSelect2, applyPhoto,
  buildSourceBanner
};
