'use strict';

const express = require('express');
const petSource = require('../petSource');

const router = express.Router();

/** Splits a comma-separated query param (e.g. "?age=Young,Adult") into a clean array, or
 * returns undefined if the param is absent -- keeps the service layer from having to guess
 * whether "no filter" or "empty filter" was intended. */
function parseListParam(value) {
  if (!value) return undefined;
  const items = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * GET /api/pets
 * Query params: species (comma-separated -- the browse page's checkbox groups let a visitor
 * pick more than one), age (comma-separated), gender (comma-separated), breed (free-text
 * contains search), size (comma-separated), state, city (only meaningful together with state --
 * see getCitiesForState's doc), q (name search), urgentOnly (true/false, filtered client-side
 * below), page (1-based), pageSize.
 *
 * species/age/gender/breed/size/state/city/q are all sent to whichever source petSource picks
 * (see src/petSource.js) as real filters now. `urgentOnly` is the one exception that's still
 * applied AFTER the page is fetched, since "field is non-blank" isn't a confirmed RescueGroups
 * filter operation -- there's no single field to filter on, only this app's own heuristic
 * computed from two other fields. Because of that, a page can still come back smaller than
 * pageSize when urgentOnly is checked even though more urgent pets exist further in -- a known,
 * documented limitation (see README) that no longer applies to size now that it's a real
 * server-side filter.
 *
 * This route no longer decides "real vs. mock" itself -- petSource does, per call, based on
 * whether RescueGroups is configured AND currently reachable (not just configured), falling back
 * live if it isn't. `source` in the response reflects whichever one actually served THIS
 * request, which is why it's read off the selector's result rather than assumed up front.
 */
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(48, Math.max(1, parseInt(req.query.pageSize, 10) || 24));
  const urgentOnly = String(req.query.urgentOnly).toLowerCase() === 'true';

  const filters = {
    species: parseListParam(req.query.species),
    ages: parseListParam(req.query.age),
    genders: parseListParam(req.query.gender),
    breed: req.query.breed || undefined,
    sizes: parseListParam(req.query.size),
    state: req.query.state || undefined,
    city: req.query.city || undefined,
    q: req.query.q || undefined,
    resultStart: (page - 1) * pageSize,
    resultLimit: pageSize
  };

  try {
    const { data, source, reason } = await petSource.searchPets(filters);
    let pets = data.pets;
    const foundRows = data.foundRows;

    if (urgentOnly) {
      pets = pets.filter((p) => p.isUrgent);
    }

    res.json({
      pets,
      page,
      pageSize,
      foundRows,
      // Based on the server-side found-row count, BEFORE client-side urgentOnly filtering --
      // so this can still be true even when urgentOnly shrank `pets` on this page. size is no
      // longer part of this caveat now that it's sent to RescueGroups as a real filter.
      hasMore: foundRows > page * pageSize,
      source,
      // Only meaningful when source is 'mock' -- 'unconfigured' (no key set) vs. 'unreachable'
      // (a key IS set, RescueGroups just failed or is still in its post-failure cooldown). See
      // petSource.js's doc comment for why the frontend needs to tell these apart.
      reason
    });
  } catch (err) {
    // petSource already absorbs a RescueGroups failure by falling back to mock -- reaching this
    // catch means BOTH sources failed (or, realistically, a bug), which is genuinely exceptional.
    res.status(502).json({ error: err.message || 'Failed to reach RescueGroups' });
  }
});

/** GET /api/pets/cities?state=XX -- distinct real shelter city names within a state, for the
 * Browse page's City dropdown (see getCitiesForState's doc for why this is a dropdown of real
 * values rather than a free-text box, and why it only makes sense once a state is chosen).
 * Registered ahead of the `/:id` route below so a request for "cities" doesn't get swallowed as
 * a pet-detail lookup for an animal literally named "cities". */
router.get('/cities', async (req, res) => {
  const state = req.query.state || undefined;
  if (!state) {
    res.json({ cities: [] });
    return;
  }
  try {
    const { data: cities } = await petSource.getCitiesForState(state);
    res.json({ cities });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to reach RescueGroups' });
  }
});

/** GET /api/pets/urgent?state=XX -- a sample of currently-urgent pets, optionally narrowed to
 * one state (see getUrgentPets's doc: this scans a fixed batch of listings, not an exhaustive
 * search of the whole dataset). The optional state param is how the landing page's
 * geolocation-based "near you" section asks for local results. */
router.get('/urgent', async (req, res) => {
  const state = req.query.state || undefined;
  try {
    const { data: pets, source, reason } = await petSource.getUrgentPets(state);
    res.json({ pets, source, reason });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to reach RescueGroups' });
  }
});

/** GET /api/pets/:id -- pet detail, plus its shelter embedded under `shelter` so the frontend
 * doesn't need a second round-trip. `source` reflects whichever source served the pet lookup --
 * in the rare case RescueGroups fails between the pet and shelter calls (entering cooldown
 * mid-request), the shelter would come from mock while `source` still says "rescuegroups"; an
 * acceptable, very unlikely edge case rather than something worth a more complex response shape. */
router.get('/:id', async (req, res) => {
  try {
    const { data: pet, source, reason } = await petSource.getPetById(req.params.id);

    if (!pet) {
      res.status(404).json({ error: 'Pet not found (it may have been adopted or delisted)' });
      return;
    }

    const { data: shelter } = await petSource.getShelterById(pet.orgId);

    res.json({ pet, shelter, source, reason });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to reach RescueGroups' });
  }
});

module.exports = router;
