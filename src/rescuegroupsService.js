'use strict';

/**
 * RescueGroups.org legacy "HTTP API" client (https://api.rescuegroups.org/http/v2.json).
 *
 * NOT the newer v5 API (test1-api.rescuegroups.org) -- that's a separate beta system with its
 * own key format. The key from RescueGroups.org's standard "Request an API Key" form is a
 * legacy key for THIS api, confirmed by hand against a real key while building the original
 * Android version of this app. Every request is a POST of the envelope built in `rgRequest`.
 *
 * This is a straight port of the logic that was built and live-tested (via a human running
 * PowerShell against the real API, since this sandbox can't reach rescuegroups.org) in the
 * Android app's RescueGroupsPetRepository.kt. All the field names and heuristics below are
 * carried over verbatim from that confirmed-working implementation -- see the project's status
 * doc / README "Real pet data" section for the full history of what was tested and how.
 */

const BASE_URL = 'https://api.rescuegroups.org/http/v2.json';

/** Confirmed real animal field names (tested live against the API). Casing is inconsistent
 * field-to-field (e.g. `animalHousetrained` lowercase vs `animalKillDate` capitalized) and is
 * NOT derivable by pattern -- every field here was individually confirmed, and several
 * plausible-looking guesses (e.g. `animalSpecialNeeds`, `animalIntakeDate`) were tried and
 * rejected. Don't add a field here without testing it first. */
const ANIMAL_FIELDS = [
  'animalID', 'animalOrgID', 'animalName', 'animalSpecies', 'animalGeneralAge', 'animalSex',
  'animalBreed', 'animalDescription', 'animalStatus', 'animalThumbnailUrl', 'animalMixedBreed',
  'animalAltered', 'animalDeclawed', 'animalHousetrained', 'animalPictures', 'animalKillDate',
  'animalGeneralSizePotential', 'animalSpecialneeds', 'animalAvailableDate'
];

/** Confirmed complete set of org fields -- there is no capacity/intake/occupancy field on the
 * org object anywhere in this API. Checked against RescueGroups' own docs and a third-party
 * field reference; this isn't a naming problem, the data simply isn't part of what shelters
 * submit. `shelter.capacityStatus` in this app's output is therefore always a placeholder. */
const ORG_FIELDS = [
  'orgID', 'orgName', 'orgEmail', 'orgPhone', 'orgFax', 'orgAddress', 'orgCity', 'orgState',
  'orgPostalcode', 'orgCountry', 'orgAbout'
];

/** How many days a pet can sit listed (via `animalAvailableDate`) before the urgent heuristic
 * flags it on its own, independent of `animalKillDate`. Not an official RescueGroups concept --
 * this whole scoring approach is this app's own heuristic. 60 was picked as a reasonable middle
 * ground when the app's owner had no preference; easy to tune here if it's too/not sensitive. */
const URGENT_LISTED_DAYS_THRESHOLD = 60;

/** How many available listings `getUrgentPets` scans (there's no confirmed server-side filter
 * for "has a kill date" or "listed a long time", so this samples rather than exhaustively
 * scanning every listing). */
const URGENT_SCAN_SIZE = 100;

/** Per-state shelter cache (in-memory, resets on server restart) so re-searching within the same
 * state doesn't re-fetch the shelter list every time. Keyed by state code, valued as an array of
 * `{ id, city }` -- keeping city alongside id (instead of the old id-only cache) is what makes
 * both the city dropdown (distinct cities per state) and city-narrowed search (filter this list
 * by city, then filter animals by the resulting org IDs) possible with zero extra API calls,
 * since `orgCity` is already part of ORG_FIELDS on every request this cache was already making. */
const stateOrgsCache = new Map();

function apiKey() {
  return process.env.RESCUEGROUPS_API_KEY || '';
}

function isConfigured() {
  return apiKey().trim().length > 0;
}

/**
 * POSTs one request to the legacy HTTP API and returns the parsed JSON response.
 * Throws on network failure or a non-2xx HTTP status; a RescueGroups-level "error" status
 * (e.g. an unsupported filter) is NOT thrown here -- callers check `response.status` themselves,
 * matching how invalid field names come back as non-fatal warnings rather than hard failures.
 */
async function rgRequest(objectType, search) {
  const body = JSON.stringify({
    apikey: apiKey(),
    objectType,
    objectAction: 'publicSearch',
    search
  });

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });

  if (!res.ok) {
    throw new Error(`RescueGroups HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Normalizes the API's `data` field -- an object keyed by record ID on success, or an empty
 * array on error/no-results -- into a plain array of record objects. Skips nothing else; unlike
 * the Kotlin version there's no per-record decode step to fail, since this is just JSON.
 */
function asRecordList(data) {
  if (!data || Array.isArray(data)) return [];
  return Object.values(data);
}

/** Maps "X-Large" (the value RescueGroups actually sends) to "Extra Large" for consistency with
 * this app's own sample/mock data. Everything else passes through unchanged. */
function normalizeSize(rawSize) {
  if (!rawSize) return 'Unknown';
  return rawSize.toLowerCase() === 'x-large' ? 'Extra Large' : rawSize;
}

/** The inverse of normalizeSize() -- callers (the browse-page size filter) work with this app's
 * own "Extra Large" label, but a server-side `animalGeneralSizePotential` filter has to send
 * RescueGroups the value it actually stores ("X-Large"). Case-insensitive on that one mapped
 * value; every other size (Small/Medium/Large) already matches RescueGroups' own casing and
 * passes through unchanged. */
function denormalizeSize(uiSize) {
  if (!uiSize) return uiSize;
  return String(uiSize).trim().toLowerCase() === 'extra large' ? 'X-Large' : uiSize;
}

function truthyYesNo(value) {
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1';
}

/**
 * Parses a RescueGroups date string into a plain `{ year, month, day }` (month 1-based) or
 * `null` if it doesn't match either confirmed real format. Deliberately does NOT use
 * `new Date(string)` -- JS's built-in date parser is inconsistent across engines for ambiguous
 * `M/d/yyyy` strings, so this parses digits explicitly instead.
 *
 * Two formats seen on real data:
 *   - "M/d/yyyy h:mm a" (e.g. "8/18/2026 8:51 AM") -- confirmed on the sibling `animalUpdatedDate`
 *     field.
 *   - "M/d/yyyy" with no time component (e.g. "3/30/2026") -- confirmed as the REAL format of
 *     populated `animalAvailableDate` values, by live-testing 2,000 sampled animals and
 *     inspecting the 238 that had a value set. This is why the date-only branch is tried, not
 *     just assumed as a fallback.
 */
function parseRescueGroupsDate(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // "M/d/yyyy h:mm a" (with or without the time portion) -- capture just the date part.
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}\s*[AaPp][Mm])?$/);
  if (!match) return null;

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return { year, month, day };
}

/** Days between a parsed `{year,month,day}` and today (UTC-based, so this stays a pure function
 * that doesn't depend on the server's local timezone). Positive means the date is in the past. */
function daysAgo(parsedDate) {
  const then = Date.UTC(parsedDate.year, parsedDate.month - 1, parsedDate.day);
  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((now - then) / msPerDay);
}

/**
 * This app's own "urgent" heuristic -- RescueGroups has no single field for it. True when
 * EITHER:
 *   - `animalKillDate` is set (a shelter's own at-risk/euthanasia-timeline flag). Confirmed
 *     essentially dormant in this dataset: 0 of 2,250 sampled available animals nationwide had
 *     it set, across multiple independent pages -- real field, but not one shelters populate in
 *     practice.
 *   - `animalAvailableDate` parses to at least URGENT_LISTED_DAYS_THRESHOLD days ago. Confirmed
 *     genuinely populated: 238 of 2,000 sampled (~12%), so this signal has real data to work
 *     with. A minority of real values are dated in the future relative to when sampled (shelters
 *     sometimes seem to use this as an "available starting on" date); that's handled safely here
 *     since a future date yields a negative `daysAgo` that can never clear the threshold.
 * Unparseable/blank dates simply don't count toward "long-listed" rather than throwing.
 */
function isUrgent(animal) {
  const hasKillDate = !!(animal.animalKillDate && String(animal.animalKillDate).trim());
  const parsedAvailable = parseRescueGroupsDate(animal.animalAvailableDate);
  const longListed = parsedAvailable !== null && daysAgo(parsedAvailable) >= URGENT_LISTED_DAYS_THRESHOLD;
  return hasKillDate || longListed;
}

/** Common named HTML entities seen in real shelter descriptions. Numeric entities (&#39;,
 * &#x2019; etc.) are handled separately in `stripDescriptionHtml` since they're computed, not
 * looked up. Anything not in this table (rare -- e.g. &copy;, &trade;) is dropped rather than
 * left as a literal "&foo;" on the page. */
const HTML_ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&ndash;': '–', '&mdash;': '—',
  '&rsquo;': '’', '&lsquo;': '‘', '&rdquo;': '”', '&ldquo;': '“'
};

/**
 * RescueGroups' `animalDescription` field is frequently NOT plain text -- individual shelters
 * paste rich HTML copied straight from their own website or a page-builder tool. Real examples
 * seen while testing this app: RescueGroups' own `rgHeader`/`rgSummary`/`rgDescription`/
 * `rgFooter` wrapper divs, and in one case dozens of levels of nested Squarespace/React-style
 * wrapper divs (`sc-pGaPU`, `pt-text-block`, etc.) around a couple of sentences of actual text.
 *
 * This app has always inserted `description` as a plain text node, never as raw HTML -- that's
 * deliberate and stays that way, since rendering arbitrary shelter-supplied markup as live HTML
 * would be a real XSS risk (any of RescueGroups' thousands of independent shelters could submit
 * a `<script>` tag or an inline event handler). The bug this fixes is different: text-node
 * insertion doesn't execute the tags, but it doesn't hide them either, so the literal
 * `<div class="rgSummary">...</div>` markup was showing up as visible text on the page. This
 * strips tags and decodes entities so the description reads as clean text instead, while still
 * never treating the shelter's content as executable markup.
 *
 * Deliberately DOM-free (no HTML parser dependency, to keep the Docker image small) -- good
 * enough for turning messy rich text into readable plain text, not a general-purpose sanitizer.
 */
function stripDescriptionHtml(raw) {
  if (!raw) return '';
  let text = String(raw);

  // Turn line-break-ish tags into real newlines BEFORE stripping tags, so paragraphs and list
  // items don't get mashed into one run-on line.
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');

  // Strip every remaining tag (opening tags, self-closing tags, whatever's left).
  text = text.replace(/<[^>]*>/g, '');

  // Decode entities: numeric first (computed), then the named lookup table above.
  text = text.replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
  text = text.replace(/&#(\d+);/g, (_match, dec) => String.fromCharCode(parseInt(dec, 10)));
  text = text.replace(/&[a-zA-Z#0-9]+;/g, (entity) => (entity in HTML_ENTITIES ? HTML_ENTITIES[entity] : ''));

  // Collapse whitespace left behind by all the empty formatting divs (lots of "&nbsp;"-only
  // lines in real data) -- trim each line, collapse runs of blank lines to at most one, trim
  // the whole thing.
  text = text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function photoUrls(animal) {
  const pictures = Array.isArray(animal.animalPictures) ? animal.animalPictures : [];
  const sorted = [...pictures].sort((a, b) => {
    const orderA = parseInt(a.mediaOrder, 10);
    const orderB = parseInt(b.mediaOrder, 10);
    return (Number.isNaN(orderA) ? Infinity : orderA) - (Number.isNaN(orderB) ? Infinity : orderB);
  });
  const urls = sorted
    .map((p) => (p.large && p.large.url) || (p.original && p.original.url) || (p.small && p.small.url))
    .filter(Boolean);
  if (urls.length > 0) return urls;
  return animal.animalThumbnailUrl ? [animal.animalThumbnailUrl] : [];
}

/** Maps one raw RescueGroups animal record into this app's clean Pet JSON shape. Returns `null`
 * for a record missing an ID or name, rather than shipping a broken card to the frontend --
 * real shelter data is messy, so one bad record shouldn't break a whole page. */
function toPet(animal) {
  if (!animal || !animal.animalID || !animal.animalName) return null;
  return {
    id: String(animal.animalID),
    orgId: animal.animalOrgID ? String(animal.animalOrgID) : null,
    name: animal.animalName,
    species: animal.animalSpecies || 'Unknown',
    breed: animal.animalBreed || 'Mixed breed',
    age: animal.animalGeneralAge || 'Unknown',
    sex: animal.animalSex || 'Unknown',
    size: normalizeSize(animal.animalGeneralSizePotential),
    description: stripDescriptionHtml(animal.animalDescription),
    status: animal.animalStatus || 'Unknown',
    photos: photoUrls(animal),
    attributes: {
      mixedBreed: truthyYesNo(animal.animalMixedBreed),
      altered: truthyYesNo(animal.animalAltered),
      declawed: truthyYesNo(animal.animalDeclawed),
      houseTrained: truthyYesNo(animal.animalHousetrained),
      specialNeeds: truthyYesNo(animal.animalSpecialneeds)
    },
    isUrgent: isUrgent(animal)
  };
}

/** Maps one raw RescueGroups org record into this app's clean Shelter JSON shape.
 * `capacityStatus` is always "unknown" on real data -- see ORG_FIELDS' doc comment for why. */
function toShelter(org) {
  if (!org || !org.orgID) return null;
  return {
    id: String(org.orgID),
    name: org.orgName || 'Unknown shelter',
    email: org.orgEmail || null,
    phone: org.orgPhone || null,
    fax: org.orgFax || null,
    address: org.orgAddress || null,
    city: org.orgCity || null,
    state: org.orgState || null,
    postalCode: org.orgPostalcode || null,
    country: org.orgCountry || null,
    about: org.orgAbout || null,
    capacityStatus: 'unknown'
  };
}

/** Pulls a trailing two-letter US state code out of a free-text location string (e.g.
 * "Los Angeles, CA" -> "CA"). Anything else (a bare city name, a ZIP code) is ignored rather
 * than erroring, matching the Android app's behavior -- confirmed there's no supported way to
 * filter `objectType=animals` directly by state (hard API error, messageID 1021), so state
 * filtering always goes through the two-step org-lookup path below instead. */
function extractStateCode(location) {
  if (!location) return null;
  const match = String(location).trim().match(/\b([A-Za-z]{2})\s*$/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Fetches up to 250 shelters in a US state (RescueGroups' page size cap) as `{ id, city }` pairs,
 * cached per state for this server process's lifetime. States with more than 250 shelters
 * (California had 766 when this was tested) only get the first page -- a sample, not exhaustive
 * coverage. This is the single fetch both `orgIdsForState` (plain state search) and
 * `getCitiesForState`/the city-narrowed branch of `searchPets` (city search) build on, so adding
 * city support didn't cost a second API call per state.
 */
async function orgsForState(stateCode) {
  if (stateOrgsCache.has(stateCode)) {
    return stateOrgsCache.get(stateCode);
  }
  const response = await rgRequest('orgs', {
    resultStart: '0',
    resultLimit: '250',
    filters: [{ fieldName: 'orgState', operation: 'equals', criteria: stateCode }],
    fields: ORG_FIELDS
  });
  const orgs = response.status === 'error'
    ? []
    : asRecordList(response.data)
      .filter((org) => org.orgID)
      .map((org) => ({ id: String(org.orgID), city: org.orgCity ? String(org.orgCity).trim() : '' }));
  stateOrgsCache.set(stateCode, orgs);
  return orgs;
}

/** Plain list of org IDs in a state -- what every caller needed before city support existed. */
async function orgIdsForState(stateCode) {
  const orgs = await orgsForState(stateCode);
  return orgs.map((org) => org.id);
}

/** Just the org IDs in a state whose `orgCity` matches (case-insensitive, exact) the given city --
 * how a chosen City dropdown value narrows a search, mirroring the org-then-animal two-step
 * `orgIdsForState` already uses for state alone. Confirmed against the live API (state CA + city
 * "Downey" narrowed 766 CA orgs down to exactly the 1 real Downey shelter) before this was built. */
async function orgIdsForStateAndCity(stateCode, city) {
  const orgs = await orgsForState(stateCode);
  const target = city.trim().toLowerCase();
  return orgs.filter((org) => org.city.toLowerCase() === target).map((org) => org.id);
}

/**
 * Distinct, alphabetically-sorted list of real city names among a state's cached shelters --
 * backs the Browse page's City dropdown, which only populates once a State is chosen (see
 * `extractStateCode`'s doc: RescueGroups has no city-only filter, so a city picker with nothing
 * to narrow within isn't useful, and a free-text city box was already ruled out separately --
 * `orgCity contains "Los Angeles"` returned 0 results since shelters register under specific
 * suburb names, not umbrella city names -- a dropdown of REAL values sidesteps that entirely).
 */
async function getCitiesForState(state) {
  const stateCode = extractStateCode(state);
  if (!stateCode) return [];
  const orgs = await orgsForState(stateCode);
  const seen = new Map(); // lowercase -> first-seen original casing, so dedup doesn't lose display casing
  orgs.forEach((org) => {
    if (!org.city) return;
    const key = org.city.toLowerCase();
    if (!seen.has(key)) seen.set(key, org.city);
  });
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

/**
 * Searches available animals nationwide, optionally narrowed by state (via the two-step
 * org-lookup above), city (a further narrowing of that same org list -- only meaningful together
 * with state, see getCitiesForState's doc), species, age, gender, breed, and size -- all sent to
 * RescueGroups as real server-side filters (`equals` for species/age/gender/size, `contains` for
 * name/breed text search). `urgentOnly` is the one filter that still applies CLIENT-SIDE after
 * the page loads (see the route layer), since "field is non-blank" isn't a confirmed RescueGroups
 * filter operation -- everything else here has a real field and a real operation behind it.
 */
async function searchPets({ species, ages, genders, breed, sizes, state, city, q, resultStart = 0, resultLimit = 24 } = {}) {
  const filters = [
    { fieldName: 'animalStatus', operation: 'equals', criteria: 'Available' }
  ];

  if (species) {
    filters.push({ fieldName: 'animalSpecies', operation: 'equals', criteria: species });
  }
  if (q && q.trim()) {
    filters.push({ fieldName: 'animalName', operation: 'contains', criteria: q.trim() });
  }
  if (breed && breed.trim()) {
    // RescueGroups' animalBreed is free text a shelter typed in, not a clean taxonomy (unlike
    // Petfinder's breed picker) -- `contains` is the closest match to "search for this breed".
    filters.push({ fieldName: 'animalBreed', operation: 'contains', criteria: breed.trim() });
  }
  if (Array.isArray(ages) && ages.length > 0) {
    filters.push({ fieldName: 'animalGeneralAge', operation: 'equals', criteria: ages });
  }
  if (Array.isArray(genders) && genders.length > 0) {
    filters.push({ fieldName: 'animalSex', operation: 'equals', criteria: genders });
  }
  if (Array.isArray(sizes) && sizes.length > 0) {
    filters.push({ fieldName: 'animalGeneralSizePotential', operation: 'equals', criteria: sizes.map(denormalizeSize) });
  }

  const stateCode = extractStateCode(state);
  if (stateCode) {
    // A city only narrows anything in combination with a state (see getCitiesForState's doc), so
    // an orphaned `city` param with no resolvable state is simply ignored here rather than erroring.
    const orgIds = city && city.trim()
      ? await orgIdsForStateAndCity(stateCode, city)
      : await orgIdsForState(stateCode);
    if (orgIds.length === 0) {
      // No shelters found for this state (or this city within it) -- return an empty page rather
      // than an unfiltered one.
      return { pets: [], foundRows: 0 };
    }
    filters.push({ fieldName: 'animalOrgID', operation: 'equals', criteria: orgIds });
  }

  const response = await rgRequest('animals', {
    resultStart: String(resultStart),
    resultLimit: String(resultLimit),
    filters,
    fields: ANIMAL_FIELDS
  });

  if (response.status === 'error') {
    const message = response.messages && response.messages.generalMessages
      ? response.messages.generalMessages.map((m) => m.messageText).join('; ')
      : 'RescueGroups returned an error';
    const err = new Error(message);
    err.rescueGroupsError = true;
    throw err;
  }

  const pets = asRecordList(response.data).map(toPet).filter(Boolean);
  return { pets, foundRows: response.foundRows || pets.length };
}

/** Fetches a single animal by ID. Returns `null` if not found rather than throwing, since "pet
 * no longer listed" is an expected, non-error outcome (adopted, removed, etc). */
async function getPetById(id) {
  const response = await rgRequest('animals', {
    resultStart: '0',
    resultLimit: '1',
    filters: [{ fieldName: 'animalID', operation: 'equals', criteria: String(id) }],
    fields: ANIMAL_FIELDS
  });
  if (response.status === 'error') return null;
  const records = asRecordList(response.data);
  return records.length > 0 ? toPet(records[0]) : null;
}

/** Fetches a shelter/org by ID, for the pet detail page's shelter card. */
async function getShelterById(orgId) {
  if (!orgId) return null;
  const response = await rgRequest('orgs', {
    resultStart: '0',
    resultLimit: '1',
    filters: [{ fieldName: 'orgID', operation: 'equals', criteria: String(orgId) }],
    fields: ORG_FIELDS
  });
  if (response.status === 'error') return null;
  const records = asRecordList(response.data);
  return records.length > 0 ? toShelter(records[0]) : null;
}

/**
 * Scans the first URGENT_SCAN_SIZE available listings -- nationwide, or narrowed to one state
 * via the same two-step org-lookup `searchPets` uses -- and returns just the ones the heuristic
 * flags as urgent. A sample, not an exhaustive search -- see the class doc above.
 *
 * The `state` param backs the landing page's geolocation-based "near you" personalization: the
 * browser detects the visitor's state client-side (see public/js/landing.js) and asks for urgent
 * pets scoped to it, so a scan of URGENT_SCAN_SIZE nationwide listings doesn't get diluted down
 * to zero local results for someone in a state with few urgent-flagged pets in the sample.
 */
async function getUrgentPets(state) {
  const filters = [{ fieldName: 'animalStatus', operation: 'equals', criteria: 'Available' }];

  const stateCode = extractStateCode(state);
  if (stateCode) {
    const orgIds = await orgIdsForState(stateCode);
    if (orgIds.length === 0) return [];
    filters.push({ fieldName: 'animalOrgID', operation: 'equals', criteria: orgIds });
  }

  const response = await rgRequest('animals', {
    resultStart: '0',
    resultLimit: String(URGENT_SCAN_SIZE),
    filters,
    fields: ANIMAL_FIELDS
  });
  if (response.status === 'error') return [];
  return asRecordList(response.data).map(toPet).filter(Boolean).filter((p) => p.isUrgent);
}

module.exports = {
  isConfigured,
  searchPets,
  getPetById,
  getShelterById,
  getUrgentPets,
  getCitiesForState,
  // Exported for the offline test script (test/run-tests.js) -- pure functions, no network.
  _internal: {
    normalizeSize,
    denormalizeSize,
    truthyYesNo,
    parseRescueGroupsDate,
    daysAgo,
    isUrgent,
    toPet,
    toShelter,
    extractStateCode,
    stripDescriptionHtml,
    URGENT_LISTED_DAYS_THRESHOLD
  }
};
