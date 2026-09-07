'use strict';

(function () {
  const { fetchJSON, el, renderPetCard, detectLocation, renderLocationBanner, speciesEmoji, initStateSelect2 } = window.AdoptScout;

  const heroSpeciesEl = document.getElementById('hero-species');
  const heroStateEl = document.getElementById('hero-state');

  document.getElementById('hero-search').addEventListener('submit', (event) => {
    event.preventDefault();
    const species = heroSpeciesEl.value;
    const state = heroStateEl.value.trim();
    const params = new URLSearchParams();
    if (species) params.set('species', species);
    if (state) params.set('state', state);
    const query = params.toString();
    window.location.href = query ? `browse.html?${query}` : 'browse.html';
  });

  /** Renders a species option's icon + label for Select2's dropdown list and closed-box display,
   * reusing this app's existing species-emoji mapping (the same 🐶/🐱/🐰/🐦 already used on the
   * category tiles and pet cards) rather than introducing new iconography just for this dropdown.
   * `state.element` is missing for Select2's own synthetic entries (e.g. a "no results" message)
   * but present for every real <option> -- including the empty-value "Any species" one, which
   * still gets an icon (🐾, speciesEmoji()'s default for an unrecognized/empty species). */
  function formatSpeciesOption(state) {
    if (!state.element) return state.text;
    const $wrapper = window.jQuery('<span class="species-option"></span>');
    $wrapper.append(document.createTextNode(`${speciesEmoji(state.element.value)} `));
    $wrapper.append(document.createTextNode(state.text));
    return $wrapper;
  }

  /** Upgrades the hero's plain Species <select> into a Select2 dropdown purely for the icon +
   * more modern pill styling (see the `.hero__search .select2-container` rules in styles.css) --
   * unlike Breed/State there's no search or free-text need for a 5-item list, so the search box
   * is turned off (`minimumResultsForSearch: Infinity`) to keep it feeling like a quick picker
   * rather than a searchable combobox. Falls back to the plain native <select> (no icons, but
   * still fully functional) if jQuery/Select2 didn't load from the CDN. */
  function initSpeciesDropdown() {
    if (window.jQuery && window.jQuery.fn && window.jQuery.fn.select2) {
      window.jQuery(heroSpeciesEl).select2({
        width: '160px',
        minimumResultsForSearch: Infinity,
        templateResult: formatSpeciesOption,
        templateSelection: formatSpeciesOption
      });
    } else {
      console.warn('Select2/jQuery did not load (CDN unreachable?) -- species field falls back to a plain dropdown.');
    }
  }

  initSpeciesDropdown();
  const heroState = initStateSelect2(heroStateEl, { width: '220px' });

  const locationBannerEl = document.getElementById('location-banner');

  function showLocationBanner(location) {
    if (!location) return;
    heroState.setValue(location.state);
    renderLocationBanner(locationBannerEl, location, () => {
      if (window.jQuery && window.jQuery.fn && window.jQuery.fn.select2) {
        window.jQuery(heroStateEl).select2('open');
      } else {
        heroStateEl.focus();
      }
    });
  }

  /**
   * Tries the urgent-pets endpoint first (a nicer, more meaningful homepage highlight than
   * generic "meet some pets" when it has something to show) and falls back to a plain page of
   * pets when there's nothing urgent right now -- which, per the live-data testing that shaped
   * this app's urgent heuristic, is the common case (only ~12% of real listings even have the
   * length-of-stay signal populated, so an empty urgent list on any given page load is normal,
   * not a bug).
   *
   * `location` (from detectLocation, or null) narrows both calls to that state and personalizes
   * the heading text ("...near Los Angeles, CA"); when nothing matches in that state, this falls
   * back to the nationwide view rather than showing an empty homepage over what's meant to be a
   * nice-to-have touch.
   */
  /** Shows a spinner in the featured-pets grid in place of whatever was there before. Used both
   * for the initial load (the grid starts empty in the HTML, and detectLocation() alone can take
   * a few seconds if geolocation is slow to resolve or times out) and for the recursive
   * nationwide-fallback call in loadFeatured, so that retry doesn't show a flash of blank grid
   * either. */
  function renderFeaturedLoading() {
    const grid = document.getElementById('featured-grid');
    grid.innerHTML = '';
    grid.appendChild(el('div', { class: 'loading-state' }, [
      el('div', { class: 'spinner' }),
      el('p', {}, 'Finding pets for you…')
    ]));
  }

  async function loadFeatured(location) {
    const grid = document.getElementById('featured-grid');
    const title = document.getElementById('featured-title');
    const nearLabel = location ? (location.city ? `${location.city}, ${location.state}` : location.state) : '';

    try {
      const urgentUrl = location ? `/api/pets/urgent?state=${encodeURIComponent(location.state)}` : '/api/pets/urgent';
      const urgentData = await fetchJSON(urgentUrl);
      if (urgentData.pets && urgentData.pets.length > 0) {
        grid.innerHTML = '';
        title.textContent = location ? `🚨 Pets who need you most near ${nearLabel}` : '🚨 Pets who need you most';
        urgentData.pets.slice(0, 4).forEach((pet) => grid.appendChild(renderPetCard(pet)));
        return;
      }
    } catch (err) {
      // Fall through to the plain listing below rather than showing an error on the homepage.
    }

    try {
      const params = new URLSearchParams({ pageSize: '4' });
      if (location) params.set('state', location.state);
      const data = await fetchJSON(`/api/pets?${params.toString()}`);

      if (data.pets.length === 0 && location) {
        // Nothing matched this specific state (a small state's sample, or the two-step org
        // lookup came back empty) -- widen back to nationwide rather than leaving the homepage
        // looking broken over a personalization touch that isn't the point of the page. Keep the
        // spinner showing through this retry rather than flashing an empty grid in between.
        locationBannerEl.hidden = true;
        renderFeaturedLoading();
        await loadFeatured(null);
        return;
      }

      grid.innerHTML = '';
      title.textContent = location ? `Meet some pets near ${nearLabel}` : 'Meet some pets';
      if (data.pets.length === 0) {
        grid.appendChild(el('div', { class: 'empty-state' }, 'No pets to show right now — try Browse for the full search.'));
        return;
      }
      data.pets.forEach((pet) => grid.appendChild(renderPetCard(pet)));
    } catch (err) {
      grid.innerHTML = '';
      title.textContent = 'Meet some pets';
      grid.appendChild(el('div', { class: 'error-state' }, `Couldn't load pets right now: ${err.message}`));
    }
  }

  (async function init() {
    renderFeaturedLoading();
    const location = await detectLocation();
    if (location) showLocationBanner(location);
    loadFeatured(location);
  })();
})();
