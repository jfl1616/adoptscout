'use strict';

(function () {
  const { fetchJSON, el, isFavorite, toggleFavorite, speciesEmoji, googleMapsUrl, applyPhoto, buildSourceBanner } = window.AdoptScout;
  const root = document.getElementById('detail-root');

  const params = new URLSearchParams(window.location.search);
  const petId = params.get('id');

  /** Where the "← Back" button/link should return to. Pet cards (see renderPetCard() in
   * common.js) now pass a `ref` param carrying the exact listing page + query string the visitor
   * was viewing (e.g. `browse.html?species=Dog&state=CA`) -- without this, "Back" always landed
   * on a filter-less `browse.html`, silently dropping whatever filters were active before the
   * visitor clicked into a pet's detail page. Only ever trusts `ref` if it points at one of this
   * app's own three listing pages (optionally with a query string); anything else -- missing,
   * malformed, or pointing somewhere else entirely -- falls back to plain `browse.html`, same as
   * before this fix. */
  function resolveBackHref() {
    const ref = params.get('ref');
    if (ref && /^(?:browse|favorites|index)\.html(?:\?.*)?$/.test(ref)) return ref;
    return 'browse.html';
  }
  const backHref = resolveBackHref();

  function attrTag(label, active) {
    return active ? el('span', { class: 'attr-tag' }, label) : null;
  }

  /** Small icon for the sex trait chip below the pet's name -- ♂/♀ when RescueGroups gives a
   * clean Male/Female, a neutral ⚥ for anything else (e.g. "Unknown"), matching the same symbol
   * browse.html already uses for its Gender filter section header. */
  function sexIcon(sex) {
    const s = (sex || '').toLowerCase();
    if (s === 'male') return '♂';
    if (s === 'female') return '♀';
    return '⚥';
  }

  /** Age/Sex/Size as their own bold "trait chips" under the breed line, instead of one long
   * dot-separated sentence -- bigger, easier to scan, and bold on just the values (not the
   * breed, which can be a long compound string like "Australian Kelpie / Australian Shepherd /
   * Mixed (medium coat)"). Loosely inspired by Petfinder's icon+label physical-traits layout,
   * but built from this app's own emoji conventions (🎂/📏, already used in browse.html's filter
   * headers) and its own pill/chip visual language (see .attr-tag) rather than reproducing
   * Petfinder's specific design. */
  function traitChip(icon, value) {
    if (!value) return null;
    return el('span', { class: 'detail-trait' }, [
      el('span', { class: 'detail-trait__icon' }, icon),
      el('strong', {}, value)
    ]);
  }

  function renderShelterCard(pet, shelter) {
    if (!shelter) return null;
    const card = el('div', { class: 'card shelter-card' }, [
      // A short "how to adopt" lead-in -- RescueGroups has no separate structured field for
      // this the way Petfinder's own multi-step adopt flow does, so rather than fabricate one,
      // this just frames the existing shelter contact info as the next step.
      el('p', { class: 'shelter-card__intro' }, `Interested in adopting ${pet.name}? Reach out to the shelter below to start the process.`),
      el('h2', {}, shelter.name)
    ]);
    if (shelter.address) {
      const addressLine = `${shelter.address}, ${[shelter.city, shelter.state, shelter.postalCode].filter(Boolean).join(', ')}`;
      card.appendChild(el('a', {
        class: 'shelter-address',
        href: googleMapsUrl(shelter),
        target: '_blank',
        rel: 'noopener'
      }, [
        el('span', { class: 'shelter-address__pin', 'aria-hidden': 'true' }, '📍'),
        el('span', {}, addressLine)
      ]));
    }
    if (shelter.phone) card.appendChild(el('p', {}, `📞 ${shelter.phone}`));
    if (shelter.email) card.appendChild(el('p', {}, `✉️ ${shelter.email}`));
    if (shelter.about) card.appendChild(el('p', {}, shelter.about));
    if (shelter.address) {
      card.appendChild(el('a', {
        class: 'btn btn--secondary',
        href: googleMapsUrl(shelter),
        target: '_blank',
        rel: 'noopener'
      }, '📍 Open in Maps'));
    }
    return card;
  }

  /** Builds the left sticky section-jump menu. Deliberately NOT a horizontal top tab bar like
   * Petfinder's own Photos/About/Story/... tabs (which would end up looking like a second copy
   * of this app's own top `.app-nav`) -- a vertical menu down the left side reads as its own
   * distinct piece of chrome instead. Smooth-scrolling and the active-section highlight are both
   * done with plain browser APIs (`scroll-behavior: smooth`, `IntersectionObserver` in
   * initScrollSpy() below) rather than a jQuery scroll-spy plugin -- jQuery isn't loaded on this
   * page at all today, and pulling it in just for this would repeat the same tradeoff this app
   * already chose against once for the "modern spinner" ask (see loading-spinner history):
   * there's no jQuery-specific capability actually needed here that the platform doesn't already
   * provide directly. */
  // Shared between buildToc()'s click handler and initScrollSpy()'s refreshActive() below -- see
  // pinActiveSection()'s own comment for why a click needs to override scroll-driven detection
  // for a moment rather than just triggering a scroll and letting the observer figure it out.
  let pinnedSectionId = null;
  let pinnedTimer = null;

  /** Immediately highlights `id`'s link and holds it there for a moment, overriding whatever
   * scroll-driven detection would otherwise say. Needed for short pet pages (a brief Story, no
   * photos beyond the hero): clicking "About" scrolls toward it, but if the remaining page content
   * is shorter than one screen, the browser hits the bottom of the document before About's heading
   * ever reaches the activation line scroll-driven detection watches for -- so without this, the
   * click would land in the right place (see the `scroll-margin-top` fix on `.detail-content >
   * section` for that half of the bug) while the left menu kept the *previous* link highlighted, or
   * jumped straight to whichever section the bottom-of-page fallback favors, neither of which is
   * the section the visitor actually asked to jump to. */
  function pinActiveSection(id) {
    pinnedSectionId = id;
    document.querySelectorAll('.detail-toc__link').forEach((link) => {
      link.classList.toggle('detail-toc__link--active', link.dataset.target === id);
    });
    clearTimeout(pinnedTimer);
    // Long enough for the smooth scroll to finish settling (including the "can't actually reach
    // it, so the browser just scrolls to its max" case on a short page) before handing control
    // back to normal scroll/observer-driven detection.
    pinnedTimer = setTimeout(() => { pinnedSectionId = null; }, 1200);
  }

  function buildToc(sections) {
    const list = el('ul', { class: 'detail-toc__list' });
    sections.forEach(({ id, label }) => {
      const link = el('a', { href: `#${id}`, class: 'detail-toc__link', 'data-target': id }, label);
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const target = document.getElementById(id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        window.history.replaceState(null, '', `#${id}`);
        pinActiveSection(id);
      });
      list.appendChild(el('li', {}, link));
    });
    return el('nav', { class: 'detail-toc', 'aria-label': 'Jump to section' }, list);
  }

  /** Highlights whichever section link corresponds to the section currently nearest the top of
   * the viewport, using IntersectionObserver rather than a scroll-event handler (no manual
   * scroll-position math, and it doesn't run on every scroll tick). The `rootMargin` shrinks the
   * observed viewport to a thin band just below the sticky header, so a section is marked active
   * once it reaches that band -- not merely whenever any sliver of it is technically visible. */
  function initScrollSpy(sectionIds) {
    const links = new Map();
    document.querySelectorAll('.detail-toc__link').forEach((link) => links.set(link.dataset.target, link));
    const visible = new Set();

    // On a short page (or near the bottom of any page), more than one section can sit inside the
    // observed band at once -- picking whichever one comes LAST in document order among those
    // currently visible keeps exactly one link active at a time (the standard scroll-spy
    // convention: the section most recently scrolled to "wins"), instead of two links lighting up
    // together whenever sections happen to be short.
    //
    // A short trailing section -- almost always Shelter, since it's whatever comes last -- can
    // also end before the page has enough scroll room left to ever carry it into the observed band
    // at all: once the browser hits the bottom of the document it simply can't scroll any further,
    // so `entry.isIntersecting` may never fire true for that section, and its link never lights up
    // even though it's the very last thing on the page. Rather than pad the page out by some
    // guessed amount to force it to fit (fragile -- it'd need re-tuning per pet, since a longer
    // Story pushes Shelter further down), this forces the LAST section active whenever the page is
    // scrolled all the way (or nearly) to the bottom, regardless of what the observer itself
    // reports. That override has to live INSIDE refreshActive() itself, not as a separate check
    // layered on top -- a separate scroll listener setting the class directly raced against the
    // IntersectionObserver's own callback (each can fire after the other depending on timing), so
    // whichever ran last would win and silently undo the other's answer. Recomputing from scratch
    // here every time, from both triggers, means there's only ever one source of truth.
    function refreshActive() {
      // A just-clicked TOC link stays highlighted for a moment regardless of what scroll position
      // we land on -- see pinActiveSection()'s comment for why this matters on short pages.
      if (pinnedSectionId) return;
      let activeId = null;
      sectionIds.forEach((id) => { if (visible.has(id)) activeId = id; });
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) activeId = sectionIds[sectionIds.length - 1];
      links.forEach((link, id) => link.classList.toggle('detail-toc__link--active', id === activeId));
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      });
      refreshActive();
    }, { rootMargin: '-96px 0px -70% 0px', threshold: 0 });

    sectionIds.forEach((id) => {
      const sectionEl = document.getElementById(id);
      if (sectionEl) observer.observe(sectionEl);
    });

    window.addEventListener('scroll', refreshActive, { passive: true });
    refreshActive(); // covers a page short enough that it's already "at the bottom" with no scrolling at all
  }

  /** Swaps the pet-detail hero photo via a circular "wipe" that grows outward from wherever the
   * clicked thumbnail sits, instead of an instant swap -- in the spirit of pens like
   * https://codepen.io/ste-vg/pen/WNvYWKr ("Circle Swap Photo Gallery"). Reimplemented here as a
   * plain CSS `clip-path` transition on a second photo layer stacked on top of the settled one
   * (`.detail-hero__reveal`, see styles.css), rather than that pen's own React + GSAP timeline --
   * a clip-path transition doesn't need either, matching this app's usual "no library when the
   * platform already does it" approach (see the parallax tilt cards and sticky section menu for
   * the same reasoning). `isCurrent()` lets a later click's finish step recognize it's stale and
   * bail out, so clicking across several thumbnails quickly can't leave the reveal layer stuck
   * mid-animation or snap a newer swap back to hidden. Skips straight to an instant swap under
   * `prefers-reduced-motion: reduce`, same as this app's other motion-heavy effects. */
  function circleSwapPhoto(hero, backdrop, base, reveal, photoUrl, originX, originY, isCurrent) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      base.classList.remove('detail-hero-layer--empty');
      base.style.backgroundImage = '';
      applyPhoto(base, photoUrl, 'detail-hero-layer--empty');
      backdrop.style.backgroundImage = '';
      applyPhoto(backdrop, photoUrl, 'detail-hero-backdrop--empty');
      return;
    }

    // The circle has to grow large enough to cover the whole hero regardless of where the click
    // landed, so its radius is the distance from the click point to whichever corner is farthest.
    const rect = hero.getBoundingClientRect();
    const corners = [[0, 0], [rect.width, 0], [0, rect.height], [rect.width, rect.height]];
    const radius = Math.ceil(Math.max(...corners.map(([cx, cy]) => Math.hypot(originX - cx, originY - cy))));

    // The blurred backdrop isn't part of the circular wipe itself -- it just needs to match
    // whatever photo is currently on top, so it's swapped immediately rather than waiting for the
    // reveal animation to finish.
    backdrop.style.backgroundImage = '';
    applyPhoto(backdrop, photoUrl, 'detail-hero-backdrop--empty');

    reveal.classList.remove('detail-hero-layer--empty');
    reveal.style.backgroundImage = '';
    applyPhoto(reveal, photoUrl, 'detail-hero-layer--empty');
    reveal.style.transition = 'none';
    reveal.style.clipPath = `circle(0px at ${originX}px ${originY}px)`;
    void reveal.offsetHeight; // force layout so the 0px start state actually paints before animating
    reveal.style.transition = '';
    requestAnimationFrame(() => {
      if (!isCurrent()) return;
      reveal.style.clipPath = `circle(${radius}px at ${originX}px ${originY}px)`;
    });

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      reveal.removeEventListener('transitionend', onTransitionEnd);
      clearTimeout(fallbackTimer);
      if (!isCurrent()) return; // a newer click already took over -- leave its animation alone
      base.classList.remove('detail-hero-layer--empty');
      base.style.backgroundImage = '';
      applyPhoto(base, photoUrl, 'detail-hero-layer--empty');
      reveal.style.transition = 'none';
      reveal.style.clipPath = 'circle(0px at 50% 50%)';
      reveal.style.backgroundImage = '';
      reveal.classList.remove('detail-hero-layer--empty');
      void reveal.offsetHeight;
      reveal.style.transition = '';
    }
    function onTransitionEnd(event) {
      if (event.target === reveal && event.propertyName === 'clip-path') finish();
    }
    reveal.addEventListener('transitionend', onTransitionEnd);
    const fallbackTimer = setTimeout(finish, 700); // safety net if transitionend never fires
  }

  /** Builds the hero's Share control. Originally gated purely on `navigator.share` existing (real
   * native share sheet, strictly more useful than a handful of hardcoded web links) -- but that
   * turned out to be the wrong test: modern desktop Chrome implements `navigator.share` too (it's
   * not phone/tablet-only the way it used to be), so on Jose's own Chrome-on-Windows setup the
   * button was silently taking the native-share branch and rendering as the exact same plain
   * "Share" pill as before, with no hover reveal at all -- which is exactly what he reported
   * ("I don't see any changes with Share button"). Since the whole point of the pull-apart pill is
   * a *hover* reveal, and hovering is a mouse-specific gesture to begin with, this now gates on
   * pointer type instead: a fine (mouse) pointer always gets the hover-reveal pill below, and the
   * plain native-share button is reserved for coarse-pointer (touch) devices that actually have
   * `navigator.share` -- phones/tablets, where hover doesn't exist anyway. Inspired by
   * https://codepen.io/RobVermeer/pen/aNYQMx (the "pull apart" width/opacity motion) and
   * https://codepen.io/chrisdothtml/pen/azPYqq (the icons' elastic pop-in easing) -- neither pen's
   * own markup was reused (the first was decorative with dead links and an auto-play demo timer,
   * the second needed Font Awesome and 5 separate always-visible buttons); this instead wires each
   * icon to something that actually works: X/Twitter and Facebook's own share-intent URLs, a
   * WhatsApp `wa.me` link, and a copy-link button reusing this app's existing
   * clipboard-then-prompt fallback chain.
   *
   * Icons are inline SVG, not emoji. The first version used 🐦/📘/💬/🔗 -- these render wildly
   * inconsistently across platforms/fonts (Jose's own screenshot showed them as unrecognizable
   * colored blobs on Windows Chrome, nothing like an actual brand mark) and Windows' emoji font in
   * particular renders several of them oddly at this size. A small `viewBox="0 0 24 24"` SVG using
   * `fill="currentColor"` draws identically everywhere and inherits this button's text color at
   * rest / white on hover for free, same as the emoji were meant to. */
  const SHARE_ICONS = {
    twitter:
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    facebook:
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M22 12.06C22 6.505 17.523 2 12 2S2 6.505 2 12.06c0 4.99 3.657 9.128 8.438 9.878v-6.987H7.898v-2.89h2.54V9.845c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.196 2.238.196v2.459h-1.26c-1.243 0-1.63.771-1.63 1.562v1.876h2.773l-.443 2.89h-2.33v6.987C18.343 21.188 22 17.05 22 12.06z"/></svg>',
    whatsapp:
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.876 1.213 3.074.148.198 2.095 3.2 5.076 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12.001 2C6.478 2 2 6.477 2 12c0 1.86.507 3.601 1.388 5.098L2 22l5.03-1.35A9.94 9.94 0 0 0 12 22c5.523 0 10-4.477 10-10S17.524 2 12.001 2zm0 18.03a8.03 8.03 0 0 1-4.42-1.317l-.317-.19-2.987.802.79-2.905-.207-.324A7.99 7.99 0 0 1 4.03 12c0-4.4 3.57-7.97 7.97-7.97 4.4 0 7.97 3.57 7.97 7.97 0 4.4-3.57 8.03-7.97 8.03z"/></svg>',
    link:
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
  };

  function buildSharePull(pet) {
    const shareUrl = window.location.href;
    const shareText = `Check out ${pet.name}, a ${pet.age.toLowerCase()} ${pet.breed} looking for a home!`;
    const finePointer = window.matchMedia && window.matchMedia('(pointer: fine)').matches;

    if (navigator.share && !finePointer) {
      const btn = el('button', { class: 'btn btn--secondary' }, '↗ Share');
      btn.addEventListener('click', async () => {
        try { await navigator.share({ title: pet.name, text: shareText, url: shareUrl }); } catch (e) { /* user cancelled */ }
      });
      return btn;
    }

    const wrap = el('div', {
      class: 'share-pull',
      tabindex: '0',
      role: 'group',
      'aria-label': `Share ${pet.name}`
    });
    const label = el('span', { class: 'share-pull__label' }, '↗ Share');

    function expand() { wrap.classList.add('share-pull--expanded'); }
    function collapse() { wrap.classList.remove('share-pull--expanded'); }

    const copyIcon = el('button', {
      class: 'share-pull__icon share-pull__icon--copy',
      type: 'button',
      'aria-label': 'Copy link',
      onclick: async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(`${shareText} ${shareUrl}`);
          copyIcon.innerHTML = SHARE_ICONS.check;
          setTimeout(() => { copyIcon.innerHTML = SHARE_ICONS.link; }, 1200);
        } catch (e) {
          window.prompt('Copy this link:', shareUrl);
        }
        collapse();
      }
    });
    copyIcon.innerHTML = SHARE_ICONS.link;

    const twitterIcon = el('a', {
      class: 'share-pull__icon share-pull__icon--twitter',
      href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`,
      target: '_blank',
      rel: 'noopener',
      'aria-label': 'Share on X',
      onclick: (event) => event.stopPropagation()
    });
    twitterIcon.innerHTML = SHARE_ICONS.twitter;

    const facebookIcon = el('a', {
      class: 'share-pull__icon share-pull__icon--facebook',
      href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
      target: '_blank',
      rel: 'noopener',
      'aria-label': 'Share on Facebook',
      onclick: (event) => event.stopPropagation()
    });
    facebookIcon.innerHTML = SHARE_ICONS.facebook;

    const whatsappIcon = el('a', {
      class: 'share-pull__icon share-pull__icon--whatsapp',
      href: `https://wa.me/?text=${encodeURIComponent(`${shareText} ${shareUrl}`)}`,
      target: '_blank',
      rel: 'noopener',
      'aria-label': 'Share on WhatsApp',
      onclick: (event) => event.stopPropagation()
    });
    whatsappIcon.innerHTML = SHARE_ICONS.whatsapp;

    const icons = el('div', { class: 'share-pull__icons' }, [twitterIcon, facebookIcon, whatsappIcon, copyIcon]);

    wrap.appendChild(label);
    wrap.appendChild(icons);

    // Hover for desktop delight, but also a plain click-to-toggle and focus/blur handling so this
    // is fully usable on touch devices and via keyboard -- a hover-only interaction (all the
    // referenced pen needed, since it was a passive demo) wouldn't be a real, reachable control.
    wrap.addEventListener('mouseenter', expand);
    wrap.addEventListener('mouseleave', collapse);
    wrap.addEventListener('click', (event) => {
      if (event.target === wrap || event.target === label) wrap.classList.toggle('share-pull--expanded');
    });
    wrap.addEventListener('focusin', expand);
    wrap.addEventListener('focusout', (event) => {
      if (!wrap.contains(event.relatedTarget)) collapse();
    });
    wrap.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { collapse(); wrap.blur(); }
    });

    return wrap;
  }

  function render(pet, shelter, source, reason) {
    document.title = `About ${pet.name} — AdoptScout`;

    const photos = pet.photos && pet.photos.length > 0 ? pet.photos : [];
    const hero = el('div', { class: 'detail-hero' });
    // A blurred, oversized copy of the same photo behind everything else -- see
    // `.detail-hero__backdrop` in styles.css. Needed once `__base`/`__reveal` switched from
    // `background-size: cover` (cropped non-4:3 photos to fill the box, cutting off the pet) to
    // `contain` (always shows the whole photo, uncropped) after Jose reported photos getting cut
    // off; without this, a photo that isn't already 4:3 would otherwise letterbox onto bare
    // `.detail-hero` background color instead of a soft, on-theme blur of itself.
    const heroBackdrop = el('div', { class: 'detail-hero__backdrop' });
    applyPhoto(heroBackdrop, photos[0], 'detail-hero-backdrop--empty');
    const heroBase = el('div', { class: 'detail-hero__base' });
    applyPhoto(heroBase, photos[0], 'detail-hero-layer--empty');
    const heroReveal = el('div', { class: 'detail-hero__reveal' });
    hero.appendChild(heroBackdrop);
    hero.appendChild(heroBase);
    hero.appendChild(heroReveal);
    hero.appendChild(el('div', { class: 'detail-hero__scrim' }));

    const favBtnLabel = () => (isFavorite(pet.id) ? '♥ Saved' : '♡ Save');
    const favBtn = el('button', { class: 'btn btn--primary' }, favBtnLabel());
    favBtn.addEventListener('click', () => {
      toggleFavorite(pet);
      favBtn.textContent = favBtnLabel();
    });

    const shareControl = buildSharePull(pet);

    hero.appendChild(el('div', { class: 'detail-hero__actions' }, [
      el('a', { href: backHref, class: 'btn btn--secondary' }, '← Back'),
      el('div', { style: 'display:flex; gap:8px;' }, [shareControl, favBtn])
    ]));

    if (photos.length > 1) {
      // Overlaid on the hero photo itself (near the bottom, see .detail-hero__thumbs in
      // styles.css) rather than sitting in a filmstrip below it -- these circular thumbnails ARE
      // the gallery nav, matching the idea behind the "Circle Swap Photo Gallery" pen linked
      // above.
      const thumbs = el('div', { class: 'detail-hero__thumbs' });
      let swapToken = 0;
      photos.forEach((photo, index) => {
        // A thumbnail is a plain `<img>`, so a broken URL can just use `onerror` directly --
        // unlike the hero/cards, which are background-image divs (see applyPhoto() in
        // common.js) precisely because a background-image has no equivalent load-failure event.
        const img = el('img', {
          src: photo,
          class: index === 0 ? 'active' : '',
          onerror: (event) => event.target.classList.add('detail-hero__thumbs-img--broken')
        });
        img.addEventListener('click', () => {
          if (img.classList.contains('active')) return; // already showing this one
          swapToken += 1;
          const token = swapToken;
          const thumbRect = img.getBoundingClientRect();
          const heroRect = hero.getBoundingClientRect();
          const originX = thumbRect.left + thumbRect.width / 2 - heroRect.left;
          const originY = thumbRect.top + thumbRect.height / 2 - heroRect.top;
          circleSwapPhoto(hero, heroBackdrop, heroBase, heroReveal, photo, originX, originY, () => token === swapToken);
          thumbs.querySelectorAll('img').forEach((t) => t.classList.remove('active'));
          img.classList.add('active');
        });
        thumbs.appendChild(img);
      });
      hero.appendChild(thumbs);
    }
    const photosSection = el('section', { id: 'section-photos' }, [hero]);

    const aboutChildren = [];
    if (source === 'mock') {
      aboutChildren.push(buildSourceBanner(reason));
    }
    if (pet.isUrgent) {
      aboutChildren.push(el('div', { class: 'urgent-banner' }, `${pet.name} needs a home urgently — reach out to the shelter for details.`));
    }

    const traits = [
      traitChip('🎂', pet.age),
      traitChip(sexIcon(pet.sex), pet.sex),
      traitChip('📏', pet.size)
    ].filter(Boolean);

    aboutChildren.push(el('div', { class: 'detail-title-row' }, [
      el('div', {}, [
        el('h1', {}, `${speciesEmoji(pet.species)} ${pet.name}`),
        el('p', { class: 'detail-breed' }, pet.breed),
        traits.length > 0 ? el('div', { class: 'detail-traits' }, traits) : null
      ])
    ]));

    const tags = [
      attrTag('Mixed breed', pet.attributes.mixedBreed),
      attrTag('Spayed/neutered', pet.attributes.altered),
      attrTag('Declawed', pet.attributes.declawed),
      attrTag('House-trained', pet.attributes.houseTrained),
      attrTag('Special needs', pet.attributes.specialNeeds)
    ].filter(Boolean);
    if (tags.length > 0) aboutChildren.push(el('div', { class: 'attr-tags' }, tags));

    const aboutSection = el('section', { id: 'section-about' }, aboutChildren);

    const storySection = el('section', { id: 'section-story' }, [
      el('div', { class: 'card' }, [
        el('h2', {}, `${pet.name}'s Story`),
        // pre-line (see styles.css) preserves the line breaks stripDescriptionHtml() inserts on
        // the server, without needing to inject raw HTML here -- descriptions still go in as a
        // plain text node, never as innerHTML, since this is untrusted shelter-supplied content.
        el('p', { class: 'pet-description' }, pet.description || 'No description provided.')
      ])
    ]);

    const shelterCard = renderShelterCard(pet, shelter);
    const tocSections = [
      { id: 'section-photos', label: 'Photos' },
      { id: 'section-about', label: 'About' },
      { id: 'section-story', label: 'Story' }
    ];
    const sections = [photosSection, aboutSection, storySection];
    if (shelterCard) {
      sections.push(el('section', { id: 'section-shelter' }, [shelterCard]));
      tocSections.push({ id: 'section-shelter', label: 'Shelter' });
    }

    root.innerHTML = '';
    root.appendChild(el('div', { class: 'detail-layout' }, [
      buildToc(tocSections),
      el('div', { class: 'detail-content' }, sections)
    ]));
    initScrollSpy(tocSections.map((s) => s.id));
  }

  async function load() {
    if (!petId) {
      root.innerHTML = '';
      root.appendChild(el('div', { class: 'error-state' }, 'No pet ID given.'));
      return;
    }
    try {
      const data = await fetchJSON(`/api/pets/${encodeURIComponent(petId)}`);
      render(data.pet, data.shelter, data.source, data.reason);
    } catch (err) {
      root.innerHTML = '';
      root.appendChild(el('a', { href: backHref, class: 'back-link' }, '← Back'));
      root.appendChild(el('div', { class: 'error-state' }, `Couldn't load this pet: ${err.message}`));
    }
  }

  load();
})();
