'use strict';

(function () {
  const { fetchJSON, el, renderPetCard, detectLocation, renderLocationBanner, initStateSelect2 } = window.AdoptScout;

  const resultsEl = document.getElementById('results');
  const loadMoreBtn = document.getElementById('load-more');
  const sourceBannerEl = document.getElementById('source-banner');
  const locationBannerEl = document.getElementById('location-banner');
  const urgentToggleLabel = document.getElementById('urgent-toggle-label');

  const form = {
    q: document.getElementById('filter-q'),
    breed: document.getElementById('filter-breed'),
    state: document.getElementById('filter-state'),
    city: document.getElementById('filter-city'),
    urgent: document.getElementById('filter-urgent')
  };

  // Species/Age/Gender/Size are checkbox groups (multiple values allowed, unlike the old single
  // <select> dropdowns) -- these two helpers read/write them as comma-separated URL values, the
  // same shape ages/genders/sizes already used server-side before this UI existed.
  function getCheckedValues(name) {
    return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((cb) => cb.value);
  }

  function setCheckedValues(name, csv) {
    const values = csv ? csv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
    document.querySelectorAll(`input[name="${name}"]`).forEach((cb) => {
      cb.checked = values.includes(cb.value.toLowerCase());
    });
  }

  /** Common breeds by species, used as Select2 suggestions for the Breed filter -- NOT an
   * exhaustive or authoritative list. RescueGroups' `animalBreed` field is free text a shelter
   * typed in (not a fixed taxonomy like this), so these are just a convenience starting point;
   * the field stays a full free-text search underneath (see `tags: true` in initBreedDropdown)
   * so a combo like "Lab/Pit Mix" that matches nothing here still works exactly as before. */
  const BREED_SUGGESTIONS = {
    Dogs: [
      'Labrador Retriever', 'German Shepherd', 'Golden Retriever', 'French Bulldog', 'Bulldog',
      'Poodle', 'Beagle', 'Rottweiler', 'Dachshund', 'Yorkshire Terrier', 'Boxer',
      'Siberian Husky', 'Great Dane', 'Doberman Pinscher', 'Australian Shepherd',
      'Cavalier King Charles Spaniel', 'Miniature Schnauzer', 'Shih Tzu', 'Boston Terrier',
      'Pomeranian', 'Havanese', 'Border Collie', 'Chihuahua', 'Pit Bull Terrier', 'Pug',
      'Bernese Mountain Dog', 'Pembroke Welsh Corgi', 'Shetland Sheepdog', 'Basset Hound',
      'Cocker Spaniel', 'Mixed Breed'
    ],
    Cats: [
      'Domestic Shorthair', 'Domestic Longhair', 'Domestic Medium Hair', 'Siamese', 'Maine Coon',
      'Persian', 'Ragdoll', 'Bengal', 'Sphynx', 'British Shorthair', 'Abyssinian', 'Russian Blue',
      'American Shorthair', 'Tabby', 'Calico', 'Tuxedo'
    ],
    Rabbits: [
      'Holland Lop', 'Netherland Dwarf', 'Mini Rex', 'Lionhead', 'Flemish Giant', 'Dutch',
      'English Angora', 'Mixed Breed'
    ],
    Birds: [
      'Parakeet (Budgerigar)', 'Cockatiel', 'Cockatoo', 'African Grey Parrot', 'Conure',
      'Lovebird', 'Finch', 'Canary'
    ]
  };

  // Set to true only while setBreedValue() is synchronously updating its dropdown so the
  // "change" event it triggers (needed to make Select2 redraw its display) never triggers a
  // duplicate/premature search. Every real, visitor-driven selection change still reaches
  // runSearch() normally through the listener below. (The State field's equivalent suppression
  // now lives inside initStateSelect2() in common.js, shared with the landing page.)
  let suppressBreedChange = false;
  // Set once initStateDropdown() below has wired up the shared state-select2 helper -- exposes
  // its setValue() so the rest of this file can still programmatically update the State field
  // (from a URL param, detected geolocation, or Clear All) without duplicating that logic.
  let stateSelect = { setValue: () => {} };
  // The Breed field's current text -- the single source of truth for what gets sent as the
  // `breed` filter. Not just `form.breed.value`: Select2's `tags: true` search box only commits
  // a value on Enter/selection/blur, not on every keystroke, so live-as-you-type search (kept
  // deliberately, see initBreedDropdown) needs its own variable updated straight from the raw
  // typed text, independent of when/whether a tag actually gets committed.
  let liveBreedText = '';

  /** Thin wrapper so the rest of this file can keep calling setStateValue(code) as before --
   * the actual Select2 wiring (and the programmatic-set-vs-real-change distinction) now lives in
   * the shared initStateSelect2() helper in common.js, see initStateDropdown() below. */
  function setStateValue(code) {
    stateSelect.setValue(code);
  }

  /** Sets the breed field's value (from a restored URL param, or Clear All) and keeps both
   * `liveBreedText` and the Select2/plain-select widget's own display in sync -- mirrors
   * setStateValue()'s reasoning below, plus one extra step: unlike the fixed 50-state list, a
   * restored breed might be free text that was typed rather than picked from
   * BREED_SUGGESTIONS (e.g. "Lab/Pit Mix" from a shared link), and a <select> -- Select2 or
   * plain -- can only display a value that exists as one of its own <option> elements, so this
   * creates that option first if it's missing. */
  function setBreedValue(text) {
    const value = text || '';
    suppressBreedChange = true;
    if (value && !Array.from(form.breed.options).some((o) => o.value === value)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      form.breed.appendChild(opt);
    }
    if (window.jQuery) {
      window.jQuery(form.breed).val(value).trigger('change');
    } else {
      form.breed.value = value;
    }
    liveBreedText = value;
    suppressBreedChange = false;
  }

  /** Select2 tears down and rebuilds its search box each time the dropdown opens, so the
   * live-as-you-type listener has to be (re)attached on every open rather than once at init --
   * the `liveBreedBound` marker stops it from being double-bound if a browser ever reuses the
   * same field element across opens. */
  function bindBreedLiveSearch() {
    const searchField = document.querySelector('.select2-container--open .select2-search__field');
    if (!searchField || searchField.dataset.liveBreedBound) return;
    searchField.dataset.liveBreedBound = 'true';
    searchField.addEventListener('input', (e) => {
      liveBreedText = e.target.value;
      debouncedSearch();
    });
  }

  /** Builds the Breed suggestion list and turns the plain <select> into a Select2 combobox: a
   * dropdown of common breeds (grouped by species) that still accepts any free text via
   * `tags: true`, since RescueGroups' breed field isn't a fixed taxonomy (see BREED_SUGGESTIONS's
   * doc) -- a plain closed dropdown would silently exclude real combinations like "Lab/Pit Mix".
   * Also keeps the pre-existing "search updates after every keystroke" feel (Jose's explicit
   * preference over Select2's own default of only searching on commit) via bindBreedLiveSearch().
   * Falls back to a plain native <select> -- suggestions only, no free text -- if jQuery/Select2
   * failed to load; see initStateDropdown's matching comment for why that tradeoff is acceptable
   * for a rare CDN-failure case rather than leaving the field broken outright. */
  function initBreedDropdown() {
    Object.entries(BREED_SUGGESTIONS).forEach(([group, breeds]) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group;
      breeds.forEach((breed) => {
        const opt = document.createElement('option');
        opt.value = breed;
        opt.textContent = breed;
        optgroup.appendChild(opt);
      });
      form.breed.appendChild(optgroup);
    });

    if (window.jQuery && window.jQuery.fn && window.jQuery.fn.select2) {
      window.jQuery(form.breed).select2({
        width: '100%',
        placeholder: 'Search or pick a breed…',
        allowClear: true,
        tags: true
      });
      window.jQuery(form.breed).on('select2:open', () => setTimeout(bindBreedLiveSearch, 0));
      window.jQuery(form.breed).on('change', () => {
        if (suppressBreedChange) return;
        liveBreedText = form.breed.value || '';
        runSearch();
      });
    } else {
      console.warn('Select2/jQuery did not load (CDN unreachable?) -- breed field falls back to a plain dropdown (suggestions only, no free text).');
      form.breed.addEventListener('change', () => {
        if (suppressBreedChange) return;
        liveBreedText = form.breed.value || '';
        runSearch();
      });
    }
  }

  /** Builds the state <select> into a Select2 searchable, flag-icon dropdown via the shared
   * initStateSelect2() helper in common.js (also used by the landing page's hero search, so both
   * look and behave identically). See that helper's own doc for the fallback/no-CDN behavior.
   * A real, visitor-driven state change always resets City -- a previously-picked city almost
   * certainly doesn't exist in the new state's shelter list -- then kicks off a fresh city-list
   * fetch for the new state (see loadCitiesForState) before re-running the search. */
  function initStateDropdown() {
    stateSelect = initStateSelect2(form.state, {
      onChange: (code) => {
        setCityValue('');
        loadCitiesForState(code);
        runSearch();
      }
    });
  }

  // Set once initCityDropdown() below runs, so setCityValue() doesn't fire a duplicate/premature
  // search while it's programmatically syncing the field (from a URL param, a state change, or
  // Clear All) -- same reasoning as suppressBreedChange above.
  let suppressCityChange = false;

  /** Replaces every option in the City <select> after the first ("Any city") with a fresh list --
   * used both when a new state's real city list comes back from `/api/pets/cities` and when
   * clearing the field back to empty. Kept separate from Select2 setup so it can run any time the
   * underlying state changes, not just once at page load. */
  function populateCityOptions(cities) {
    Array.from(form.city.options).slice(1).forEach((opt) => opt.remove());
    cities.forEach((city) => {
      const opt = document.createElement('option');
      opt.value = city;
      opt.textContent = city;
      form.city.appendChild(opt);
    });
  }

  /** Enables/disables the City field -- it only means anything once a state is chosen and that
   * state actually has cities to offer (see getCitiesForState's doc).
   *
   * Deliberately sets the plain `disabled` property directly rather than calling Select2's own
   * `.select2('enable', bool)` method -- that method is bugged in the pinned 4.1.0-rc.0 build
   * (confirmed by reading its actual source): the two-argument form always ends up disabling the
   * field regardless of which boolean is passed, because of how jQuery's plugin dispatcher calls
   * `enable(args)` -- `args` arrives as a bare boolean, not the array-wrapped value `enable()`'s
   * own body expects, so `args[0]` (meant to read the real value back out) is always `undefined`
   * and gets negated to `true`. This is what caused the City dropdown to stay visibly greyed out
   * even after a state with real cities was chosen and the options were correctly populated.
   * Setting the property directly still works because Select2 watches the underlying `<select>`
   * with a MutationObserver and reacts to its `disabled` attribute changing on its own (see
   * `_syncAttributes` in Select2's core.js) -- no Select2-specific call is needed at all. */
  function setCityDisabled(disabled) {
    form.city.disabled = disabled;
  }

  /** Sets the City field's value programmatically (URL param restore, or Clear All) without
   * treating it as a real visitor-driven change -- mirrors setStateValue/setBreedValue above. */
  function setCityValue(value) {
    suppressCityChange = true;
    if (window.jQuery && window.jQuery.fn && window.jQuery.fn.select2 && window.jQuery(form.city).data('select2')) {
      window.jQuery(form.city).val(value || '').trigger('change');
    } else {
      form.city.value = value || '';
    }
    suppressCityChange = false;
  }

  /** Fetches the real, distinct city list for a state from `/api/pets/cities` and repopulates the
   * City dropdown -- called on every state change (including a restored URL param and detected
   * geolocation), not just once, since the list is different for every state. An empty/missing
   * state code, a network failure, or a state with no cached shelters all land in the same
   * "reset and disable" branch rather than leaving a stale list from the previous state showing. */
  async function loadCitiesForState(stateCode) {
    if (!stateCode) {
      populateCityOptions([]);
      setCityDisabled(true);
      return;
    }
    try {
      const data = await fetchJSON(`/api/pets/cities?state=${encodeURIComponent(stateCode)}`);
      const cities = data.cities || [];
      populateCityOptions(cities);
      setCityDisabled(cities.length === 0);
    } catch (err) {
      populateCityOptions([]);
      setCityDisabled(true);
    }
  }

  /** Upgrades the City <select> into a searchable Select2 combobox (no free text -- unlike Breed,
   * every value here is a real shelter city fetched from the server, so there's nothing useful a
   * visitor could type that isn't already an option). Starts disabled; loadCitiesForState() turns
   * it on once a state with real cities is chosen. Falls back to a plain native <select> if
   * Select2/jQuery didn't load, same tradeoff as the other dropdowns on this page. */
  function initCityDropdown() {
    if (window.jQuery && window.jQuery.fn && window.jQuery.fn.select2) {
      window.jQuery(form.city).select2({
        width: '100%',
        placeholder: 'Any city',
        allowClear: true
      });
      window.jQuery(form.city).prop('disabled', true);
      window.jQuery(form.city).on('change', () => {
        if (suppressCityChange) return;
        runSearch();
      });
    } else {
      console.warn('Select2/jQuery did not load (CDN unreachable?) -- city field falls back to a plain dropdown.');
      form.city.addEventListener('change', () => {
        if (suppressCityChange) return;
        runSearch();
      });
    }
  }

  let currentPage = 1;
  let pets = [];
  let debounceTimer = null;
  // True only while the state filter's value came from auto-detected geolocation rather than
  // the visitor typing it in, an incoming URL param, or a landing-page hero search -- lets
  // loadPage() widen back to nationwide if that particular state's search comes up empty,
  // without ever overriding a state the visitor (or another page) explicitly chose.
  let stateFromGeolocation = false;

  function currentFilters() {
    const params = new URLSearchParams();
    if (form.q.value.trim()) params.set('q', form.q.value.trim());
    const species = getCheckedValues('species');
    if (species.length > 0) params.set('species', species.join(','));
    if (liveBreedText.trim()) params.set('breed', liveBreedText.trim());
    const ages = getCheckedValues('age');
    if (ages.length > 0) params.set('age', ages.join(','));
    const genders = getCheckedValues('gender');
    if (genders.length > 0) params.set('gender', genders.join(','));
    const sizes = getCheckedValues('size');
    if (sizes.length > 0) params.set('size', sizes.join(','));
    if (form.state.value.trim()) params.set('state', form.state.value.trim());
    if (form.city.value.trim()) params.set('city', form.city.value.trim());
    if (form.urgent.checked) params.set('urgentOnly', 'true');
    return params;
  }

  /** Async because a restored `state` param needs its City list fetched (and, if a `city` param
   * is also present, applied) before this resolves -- see init() below, which awaits this before
   * the first search runs, so a shared/reloaded URL with both params ends up narrowed correctly
   * on the very first page load instead of needing a second interaction. */
  async function restoreFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('q')) form.q.value = params.get('q');
    setCheckedValues('species', params.get('species'));
    if (params.get('breed')) setBreedValue(params.get('breed'));
    setCheckedValues('age', params.get('age'));
    setCheckedValues('gender', params.get('gender'));
    setCheckedValues('size', params.get('size'));
    if (params.get('state')) {
      setStateValue(params.get('state'));
      await loadCitiesForState(params.get('state'));
      if (params.get('city')) setCityValue(params.get('city'));
    }
    if (params.get('urgentOnly') === 'true') form.urgent.checked = true;
  }

  function clearAllFilters() {
    form.q.value = '';
    setBreedValue('');
    setStateValue('');
    setCityValue('');
    populateCityOptions([]);
    setCityDisabled(true);
    form.urgent.checked = false;
    document.querySelectorAll('.filters-sidebar input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
    stateFromGeolocation = false;
    locationBannerEl.hidden = true;
    runSearch();
  }

  function setUrlState(params) {
    const url = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, '', params.toString() ? url : window.location.pathname);
  }

  function renderStatus(message, kind) {
    resultsEl.innerHTML = '';
    const children = kind === 'loading' ? [el('div', { class: 'spinner' }), el('p', {}, message)] : message;
    resultsEl.appendChild(el('div', { class: `${kind}-state` }, children));
  }

  function renderGrid(append) {
    if (!append) resultsEl.innerHTML = '';
    if (pets.length === 0 && !append) {
      renderStatus('No pets matched your search. Try widening your filters.', 'empty');
      return;
    }
    let grid = resultsEl.querySelector('.pet-grid');
    if (!grid) {
      grid = el('div', { class: 'pet-grid' });
      resultsEl.appendChild(grid);
    }
    const newPets = append ? pets.slice(-lastPageCount) : pets;
    newPets.forEach((pet) => grid.appendChild(renderPetCard(pet)));
  }

  let lastPageCount = 0;

  async function loadPage(page, append) {
    urgentToggleLabel.classList.toggle('active', form.urgent.checked);
    loadMoreBtn.disabled = true;
    loadMoreBtn.innerHTML = '';
    loadMoreBtn.appendChild(el('span', { class: 'spinner spinner--sm' }));
    loadMoreBtn.appendChild(document.createTextNode('Loading…'));
    if (!append) renderStatus('Loading pets…', 'loading');

    const params = currentFilters();
    params.set('page', String(page));
    params.set('pageSize', '24');

    try {
      const data = await fetchJSON(`/api/pets?${params.toString()}`);

      if (!append && data.pets.length === 0 && stateFromGeolocation) {
        // The auto-detected state came up empty (a small state's sample, or the two-step org
        // lookup found no shelters there) -- clear it and retry nationwide rather than leaving
        // the browse page looking broken over a personalization touch the visitor never asked
        // for explicitly.
        stateFromGeolocation = false;
        setStateValue('');
        setCityValue('');
        populateCityOptions([]);
        setCityDisabled(true);
        locationBannerEl.hidden = true;
        setUrlState(currentFilters());
        await loadPage(1, false);
        return;
      }

      lastPageCount = data.pets.length;
      pets = append ? pets.concat(data.pets) : data.pets;
      currentPage = page;
      renderGrid(append);

      loadMoreBtn.hidden = !data.hasMore;
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more';

      if (data.source === 'mock') {
        sourceBannerEl.innerHTML = '';
        sourceBannerEl.appendChild(el('div', { class: 'source-banner' },
          'Showing sample data — set RESCUEGROUPS_API_KEY on the server to see live shelters.'));
      } else {
        sourceBannerEl.innerHTML = '';
      }
    } catch (err) {
      renderStatus(`Something went wrong: ${err.message}`, 'error');
      loadMoreBtn.hidden = true;
    }
  }

  function runSearch() {
    setUrlState(currentFilters());
    loadPage(1, false);
  }

  function debouncedSearch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 350);
  }

  /**
   * Auto-fills the state filter from the visitor's browser-detected location, but ONLY when
   * nothing has already specified a state -- not a URL param (e.g. a landing-page hero search
   * or a shared link), and not something the visitor already typed while this was resolving.
   * Geolocation is a default for "nothing else specified," never an override of an explicit
   * choice. Silent no-op on any detection failure (see detectLocation's own doc for the full
   * list of fallback cases) -- the page just behaves exactly as it did before this feature.
   */
  async function maybeDetectLocation() {
    if (form.state.value.trim()) return;
    const location = await detectLocation();
    if (!location || form.state.value.trim()) return;
    setStateValue(location.state);
    loadCitiesForState(location.state);
    stateFromGeolocation = true;
    renderLocationBanner(locationBannerEl, location, () => {
      stateFromGeolocation = false;
      setStateValue('');
      setCityValue('');
      populateCityOptions([]);
      setCityDisabled(true);
      locationBannerEl.hidden = true;
      runSearch();
    });
  }

  /** Each filter section (Species, Breed, Age, Gender, Size, Location) is its own collapsible
   * accordion panel, Petfinder-style, rather than one long flat list -- makes room for checkbox
   * groups without the sidebar turning into an unreadable wall of options. All sections start
   * expanded; clicking a header just toggles that one section. */
  function initAccordion() {
    document.querySelectorAll('.filter-group__toggle').forEach((toggle) => {
      const group = toggle.closest('.filter-group');
      const panel = group.querySelector('.filter-group__panel');
      group.classList.add('filter-group--open');
      toggle.addEventListener('click', () => {
        const nowOpen = panel.hidden; // opening if it was hidden
        panel.hidden = !nowOpen;
        group.classList.toggle('filter-group--open', nowOpen);
      });
    });
  }

  form.q.addEventListener('input', debouncedSearch);
  document.querySelectorAll('.filters-sidebar input[type="checkbox"][name]').forEach((cb) => {
    cb.addEventListener('change', runSearch);
  });
  form.urgent.addEventListener('change', runSearch);
  document.getElementById('filters-form').addEventListener('submit', (e) => e.preventDefault());
  document.getElementById('clear-filters').addEventListener('click', clearAllFilters);
  loadMoreBtn.addEventListener('click', () => loadPage(currentPage + 1, true));

  initAccordion();
  initStateDropdown();
  initCityDropdown();
  initBreedDropdown();

  (async function init() {
    await restoreFiltersFromUrl();
    await maybeDetectLocation();
    loadPage(1, false);
  })();
})();
