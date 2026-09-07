'use strict';

const express = require('express');
const rescueGroups = require('../rescuegroupsService');
const mock = require('../mockData');

const router = express.Router();

/** true when a real RESCUEGROUPS_API_KEY is configured; false falls back to mock.js sample
 * data, exactly like the Android app's AppContainer picking between RescueGroupsPetRepository
 * and MockPetRepository. Checked per-request (not cached at startup) so the container can pick
 * up a key added to the environment without a code change, only a restart of the process. */
function usingRealData() {
  return rescueGroups.isConfigured();
}

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
 * contains search), size (comma-separated), state, q (name search), urgentOnly (true/false,
 * filtered client-side below), page (1-based), pageSize.
 *
 * species/age/gender/breed/size/state/q are all sent to RescueGroups (or matched in mock.js) as
 * real filters now. `urgentOnly` is the one exception that's still applied AFTER the page is
 * fetched, since "field is non-blank" isn't a confirmed RescueGroups filter operation -- there's
 * no single field to filter on, only this app's own heuristic computed from two other fields.
 * Because of that, a page can still come back smaller than pageSize when urgentOnly is checked
 * even though more urgent pets exist further in -- a known, documented limitation (see README)
 * that no longer applies to size now that it's a real server-side filter.
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
    q: req.query.q || undefined,
    resultStart: (page - 1) * pageSize,
    resultLimit: pageSize
  };

  try {
    let pets;
    let foundRows;
    let source;

    if (usingRealData()) {
      const result = await rescueGroups.searchPets(filters);
      pets = result.pets;
      foundRows = result.foundRows;
      source = 'rescuegroups';
    } else {
      const result = mock.getMockPets(filters);
      pets = result.pets;
      foundRows = result.foundRows;
      source = 'mock';
    }

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
      source
    });
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
    const pets = usingRealData() ? await rescueGroups.getUrgentPets(state) : mock.getMockUrgentPets(state);
    res.json({ pets, source: usingRealData() ? 'rescuegroups' : 'mock' });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to reach RescueGroups' });
  }
});

/** GET /api/pets/:id -- pet detail, plus its shelter embedded under `shelter` so the frontend
 * doesn't need a second round-trip. */
router.get('/:id', async (req, res) => {
  try {
    const pet = usingRealData()
      ? await rescueGroups.getPetById(req.params.id)
      : mock.getMockPetById(req.params.id);

    if (!pet) {
      res.status(404).json({ error: 'Pet not found (it may have been adopted or delisted)' });
      return;
    }

    const shelter = usingRealData()
      ? await rescueGroups.getShelterById(pet.orgId)
      : mock.getMockShelterById(pet.orgId);

    res.json({ pet, shelter, source: usingRealData() ? 'rescuegroups' : 'mock' });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to reach RescueGroups' });
  }
});

module.exports = router;
