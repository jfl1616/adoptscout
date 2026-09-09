'use strict';

/**
 * Lightweight assertion-based test script (no framework dependency, kept as an npm devDependency
 * would just be more weight in the Docker image) covering the pure logic ported from the
 * Android app's confirmed-working RescueGroupsPetRepository.kt. This sandbox can't reach
 * rescuegroups.org, so it can't do a true end-to-end live test -- what it CAN verify is that
 * the parsing/heuristic/mapping logic behaves correctly against real values already confirmed
 * live (via the PowerShell scans run against the real API), plus edge cases.
 *
 * Run with: npm test
 */

const assert = require('node:assert/strict');
const { _internal } = require('../src/rescuegroupsService');
const rescueGroups = require('../src/rescuegroupsService');
const mock = require('../src/mockData');
const { assertImplementsPetDataSource } = require('../src/petDataSource');
const { createPetSource } = require('../src/petSource');

let passed = 0;
let failed = 0;

// `test`/`queueBanner` only enqueue -- they don't run anything immediately. That's what lets a
// single async runner (see the bottom of this file) safely `await` every test body in the exact
// order they were declared, which matters now that some test bodies call `async` PetDataSource
// methods (mockData.js's exports -- see that file's doc comment for why they're async even
// though the underlying work is synchronous). Section banners are queued as the same kind of
// entry as tests, rather than printed immediately at parse time, purely so they still print
// interleaved in the right place relative to their own tests' pass/fail output instead of all
// printing upfront before any test has actually run.
const queue = [];

function test(name, fn) {
  queue.push({ kind: 'test', name, fn });
}

function queueBanner(text) {
  queue.push({ kind: 'banner', text });
}

function daysAgoDateString(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

queueBanner('--- PetDataSource contract ---');

test('mockData.js implements the full PetDataSource contract', () => {
  assertImplementsPetDataSource(mock, 'mock');
});

test('rescuegroupsService.js implements the full PetDataSource contract', () => {
  assertImplementsPetDataSource(rescueGroups, 'rescuegroups');
});

test('assertImplementsPetDataSource names every missing method rather than failing on the first', () => {
  const broken = { isConfigured: () => true, searchPets: async () => ({}) };
  assert.throws(
    () => assertImplementsPetDataSource(broken, 'broken-test-double'),
    /Pet data source "broken-test-double" is missing required method\(s\): getPetById, getShelterById, getUrgentPets, getCitiesForState/
  );
});

queueBanner('--- petSource (reachability-based fallback selector) ---');

/** Builds a fake PetDataSource for petSource tests -- a plain object matching the interface
 * shape, with call counts so tests can assert whether the real provider was actually invoked
 * (e.g. it must NOT be called at all once a cooldown is active). `behavior` maps a method name to
 * either a return value or an Error to throw, so each test can script exactly one method's
 * outcome without needing to stub all five. */
function fakeProvider({ configured = true, behavior = {} } = {}) {
  const calls = {};
  const provider = { isConfigured: () => configured };
  ['searchPets', 'getPetById', 'getShelterById', 'getUrgentPets', 'getCitiesForState'].forEach((method) => {
    calls[method] = 0;
    provider[method] = async (...args) => {
      calls[method] += 1;
      const outcome = behavior[method];
      if (outcome instanceof Error) throw outcome;
      return typeof outcome === 'function' ? outcome(...args) : outcome;
    };
  });
  provider._calls = calls;
  return provider;
}

test('petSource uses the real provider and reports its source when the call succeeds', async () => {
  const real = fakeProvider({ behavior: { searchPets: { pets: ['real'], foundRows: 1 } } });
  const mockProvider = fakeProvider({ behavior: { searchPets: { pets: ['mock'], foundRows: 1 } } });
  const ps = createPetSource({ realProvider: real, fallbackProvider: mockProvider, cooldownMs: 10_000, logger: () => {} });

  const result = await ps.searchPets({});
  assert.deepStrictEqual(result, { data: { pets: ['real'], foundRows: 1 }, source: 'rescuegroups' });
  assert.equal(real._calls.searchPets, 1);
  assert.equal(mockProvider._calls.searchPets, 0); // never even tried -- the real call succeeded
});

test('petSource skips the real provider entirely when it is not configured', async () => {
  const real = fakeProvider({ configured: false, behavior: { getUrgentPets: [{ id: 'should-never-see-this' }] } });
  const mockProvider = fakeProvider({ behavior: { getUrgentPets: [{ id: 'mock-urgent' }] } });
  const ps = createPetSource({ realProvider: real, fallbackProvider: mockProvider, cooldownMs: 10_000, logger: () => {} });

  const result = await ps.getUrgentPets('CA');
  assert.deepStrictEqual(result, { data: [{ id: 'mock-urgent' }], source: 'mock', reason: 'unconfigured' });
  assert.equal(real._calls.getUrgentPets, 0); // isConfigured() was false -- no attempt at all
});

test('petSource falls back to mock and logs when the real provider throws', async () => {
  const logs = [];
  const real = fakeProvider({ behavior: { getCitiesForState: new Error('ECONNREFUSED') } });
  const mockProvider = fakeProvider({ behavior: { getCitiesForState: ['Mockville'] } });
  const ps = createPetSource({ realProvider: real, fallbackProvider: mockProvider, cooldownMs: 10_000, logger: (m) => logs.push(m) });

  const result = await ps.getCitiesForState('CA');
  assert.deepStrictEqual(result, { data: ['Mockville'], source: 'mock', reason: 'unreachable' });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /RescueGroups call to getCitiesForState\(\) failed.*ECONNREFUSED/);
});

test('petSource stays on mock (without retrying the real provider) for the rest of the cooldown window', async () => {
  const logs = [];
  const real = fakeProvider({ behavior: { getPetById: new Error('timeout') } });
  const mockProvider = fakeProvider({ behavior: { getPetById: { id: 'mock-1' } } });
  const ps = createPetSource({ realProvider: real, fallbackProvider: mockProvider, cooldownMs: 10_000, logger: (m) => logs.push(m) });

  await ps.getPetById('1'); // triggers the failure and starts the cooldown
  const second = await ps.getPetById('1'); // should be skipped, not retried, while cooldown is active

  assert.deepStrictEqual(second, { data: { id: 'mock-1' }, source: 'mock', reason: 'unreachable' });
  assert.equal(real._calls.getPetById, 1); // NOT 2 -- the second call never touched the real provider
  assert.equal(logs.length, 2);
  assert.match(logs[1], /Skipping RescueGroups for getPetById\(\).*cooldown/);
});

test('petSource automatically retries and recovers once the cooldown window elapses', async () => {
  const real = fakeProvider({ behavior: { getShelterById: new Error('down') } });
  const mockProvider = fakeProvider({ behavior: { getShelterById: { id: 'mock-shelter' } } });
  const ps = createPetSource({ realProvider: real, fallbackProvider: mockProvider, cooldownMs: 30, logger: () => {} });

  const duringOutage = await ps.getShelterById('org-1');
  assert.equal(duringOutage.source, 'mock');
  assert.equal(duringOutage.reason, 'unreachable');

  await new Promise((resolve) => setTimeout(resolve, 60)); // let the 30ms cooldown fully elapse

  real.getShelterById = async () => { real._calls.getShelterById += 1; return { id: 'real-shelter' }; };
  const afterRecovery = await ps.getShelterById('org-1');
  assert.deepStrictEqual(afterRecovery, { data: { id: 'real-shelter' }, source: 'rescuegroups' });
});

test('petSource does not treat a resolved null (pet not found) as a failure', async () => {
  const logs = [];
  const real = fakeProvider({ behavior: { getPetById: null } });
  const mockProvider = fakeProvider({ behavior: { getPetById: { id: 'should-not-be-used' } } });
  const ps = createPetSource({ realProvider: real, fallbackProvider: mockProvider, cooldownMs: 10_000, logger: (m) => logs.push(m) });

  const result = await ps.getPetById('missing-id');
  assert.deepStrictEqual(result, { data: null, source: 'rescuegroups' }); // real source, not mock
  assert.equal(mockProvider._calls.getPetById, 0);
  assert.equal(logs.length, 0);
});

queueBanner('--- parseRescueGroupsDate ---');

test('parses a real bare-date value seen on animalAvailableDate ("3/30/2026")', () => {
  const parsed = _internal.parseRescueGroupsDate('3/30/2026');
  assert.deepEqual(parsed, { year: 2026, month: 3, day: 30 });
});

test('parses a real bare-date value from 2009 ("5/17/2009")', () => {
  const parsed = _internal.parseRescueGroupsDate('5/17/2009');
  assert.deepEqual(parsed, { year: 2009, month: 5, day: 17 });
});

test('parses a datetime value seen on animalUpdatedDate ("8/18/2026 8:51 AM")', () => {
  const parsed = _internal.parseRescueGroupsDate('8/18/2026 8:51 AM');
  assert.deepEqual(parsed, { year: 2026, month: 8, day: 18 });
});

test('returns null for a blank string', () => {
  assert.equal(_internal.parseRescueGroupsDate(''), null);
  assert.equal(_internal.parseRescueGroupsDate('   '), null);
});

test('returns null for null/undefined', () => {
  assert.equal(_internal.parseRescueGroupsDate(null), null);
  assert.equal(_internal.parseRescueGroupsDate(undefined), null);
});

test('returns null for garbage rather than throwing', () => {
  assert.equal(_internal.parseRescueGroupsDate('not a date'), null);
  assert.equal(_internal.parseRescueGroupsDate('2026-08-18'), null);
});

test('rejects an out-of-range month/day rather than silently misparsing', () => {
  assert.equal(_internal.parseRescueGroupsDate('13/40/2026'), null);
});

queueBanner('--- isUrgent heuristic ---');

test('flags urgent when animalKillDate is set, regardless of availableDate', () => {
  assert.equal(_internal.isUrgent({ animalKillDate: '1/1/2026', animalAvailableDate: '' }), true);
});

test('flags urgent when availableDate is >= 60 days ago', () => {
  assert.equal(_internal.isUrgent({ animalKillDate: '', animalAvailableDate: daysAgoDateString(61) }), true);
});

test('does NOT flag urgent when availableDate is fewer than 60 days ago', () => {
  assert.equal(_internal.isUrgent({ animalKillDate: '', animalAvailableDate: daysAgoDateString(10) }), false);
});

test('boundary: exactly 60 days ago counts as urgent (threshold is inclusive)', () => {
  assert.equal(_internal.isUrgent({ animalKillDate: '', animalAvailableDate: daysAgoDateString(60) }), true);
});

test('does NOT flag urgent when both signals are blank', () => {
  assert.equal(_internal.isUrgent({ animalKillDate: '', animalAvailableDate: '' }), false);
});

test('a future availableDate is never urgent (negative day count can\'t clear threshold)', () => {
  const future = daysAgoDateString(-30); // 30 days in the future
  assert.equal(_internal.isUrgent({ animalKillDate: '', animalAvailableDate: future }), false);
});

test('an unparseable availableDate degrades to "not urgent" rather than throwing', () => {
  assert.equal(_internal.isUrgent({ animalKillDate: '', animalAvailableDate: 'garbage' }), false);
});

queueBanner('--- normalizeSize ---');

test('maps "X-Large" to "Extra Large"', () => {
  assert.equal(_internal.normalizeSize('X-Large'), 'Extra Large');
});

test('is case-insensitive on X-Large', () => {
  assert.equal(_internal.normalizeSize('x-large'), 'Extra Large');
});

test('passes other sizes through unchanged', () => {
  assert.equal(_internal.normalizeSize('Medium'), 'Medium');
});

test('falls back to "Unknown" for blank/missing size', () => {
  assert.equal(_internal.normalizeSize(''), 'Unknown');
  assert.equal(_internal.normalizeSize(null), 'Unknown');
});

queueBanner('--- denormalizeSize (the inverse, used to build the server-side size filter) ---');

test('maps this app\'s "Extra Large" label back to RescueGroups\' own "X-Large" value', () => {
  assert.equal(_internal.denormalizeSize('Extra Large'), 'X-Large');
});

test('is case-insensitive on "Extra Large"', () => {
  assert.equal(_internal.denormalizeSize('extra large'), 'X-Large');
});

test('passes other sizes through unchanged (Small/Medium/Large already match RescueGroups\' casing)', () => {
  assert.equal(_internal.denormalizeSize('Medium'), 'Medium');
  assert.equal(_internal.denormalizeSize('Small'), 'Small');
});

test('round-trips with normalizeSize', () => {
  assert.equal(_internal.normalizeSize(_internal.denormalizeSize('Extra Large')), 'Extra Large');
});

queueBanner('--- extractStateCode ---');

test('extracts a trailing two-letter state code', () => {
  assert.equal(_internal.extractStateCode('Los Angeles, CA'), 'CA');
});

test('extracts a bare state code', () => {
  assert.equal(_internal.extractStateCode('ca'), 'CA');
});

test('returns null for a location with no trailing state code', () => {
  assert.equal(_internal.extractStateCode('90001'), null);
  assert.equal(_internal.extractStateCode(''), null);
  assert.equal(_internal.extractStateCode(null), null);
});

queueBanner('--- stripDescriptionHtml ---');

test('strips RescueGroups\' own rgSummary wrapper div (real example from Catalina\'s listing)', () => {
  const raw = '<div class="rgSummary">Semi feral sibling of Carnegie &amp; Calista<br></div>';
  const cleaned = _internal.stripDescriptionHtml(raw);
  assert.equal(cleaned, 'Semi feral sibling of Carnegie & Calista');
  assert.ok(!cleaned.includes('<'), 'no tag characters should remain');
  assert.ok(!cleaned.includes('rgSummary'), 'the class name itself should not leak into the text');
});

test('strips deeply nested page-builder markup down to readable text (real example from a RescueCats listing)', () => {
  const raw = '<div class="rgHeader"><p>RescueCats, Inc.</p><br></div>'
    + '<div class="rgDescription"><p>&nbsp;</p>'
    + '<h1 align="center"><strong><a href="http://www.rescuecats.org/x">Adoption Center - All Week</a></strong></h1>'
    + '<div align="center"><strong><span>(I-75/Mt Zion Rd) 1986 Mount Zion Rd</span>'
    + '<span>- </span><span>Morrow, GA 30260</span></strong></div>'
    + '<div class="sc-pGaPU gWdCRD" data-testid="text-block"><div data-text="">'
    + '<span><strong>Daily</strong> (AUG 29 - SEPT 5)</span></div></div>'
    + '<div>&nbsp;</div><div>&nbsp;</div>'
    + '</div><div class="rgFooter"><br><p>www.rescuecats.org</p></div>';
  const cleaned = _internal.stripDescriptionHtml(raw);
  assert.ok(!cleaned.includes('<'), 'no tag characters should remain');
  assert.ok(!cleaned.includes('sc-pGaPU'), 'internal page-builder class names should not leak into the text');
  assert.ok(cleaned.includes('RescueCats, Inc.'));
  assert.ok(cleaned.includes('Adoption Center - All Week'));
  assert.ok(cleaned.includes('Daily'));
  assert.ok(cleaned.includes('www.rescuecats.org'));
  assert.ok(!/\n{3,}/.test(cleaned), 'runs of blank lines from empty &nbsp; divs should collapse');
});

test('decodes common HTML entities seen in real descriptions', () => {
  assert.equal(_internal.stripDescriptionHtml('Fixed &amp; friendly &ndash; loves everyone!'), 'Fixed & friendly – loves everyone!');
  assert.equal(_internal.stripDescriptionHtml('cat&#39;s favorite toy'), "cat's favorite toy");
});

test('returns an empty string for blank/missing descriptions rather than "null"/"undefined"', () => {
  assert.equal(_internal.stripDescriptionHtml(''), '');
  assert.equal(_internal.stripDescriptionHtml(null), '');
  assert.equal(_internal.stripDescriptionHtml(undefined), '');
});

test('passes plain text through unchanged (most descriptions are NOT HTML)', () => {
  assert.equal(_internal.stripDescriptionHtml('A very good dog who loves belly rubs.'), 'A very good dog who loves belly rubs.');
});

queueBanner('--- toPet mapping ---');

test('maps a realistic raw RescueGroups animal record end-to-end', () => {
  const pet = _internal.toPet({
    animalID: '12345',
    animalOrgID: '999',
    animalName: 'Test Dog',
    animalSpecies: 'Dog',
    animalBreed: 'Mixed',
    animalGeneralAge: 'Adult',
    animalSex: 'Male',
    animalGeneralSizePotential: 'X-Large',
    animalDescription: 'A good boy.',
    animalStatus: 'Available',
    animalKillDate: '',
    animalAvailableDate: daysAgoDateString(90),
    animalSpecialneeds: 'No',
    animalMixedBreed: 'Yes',
    animalAltered: 'Yes',
    animalDeclawed: 'No',
    animalHousetrained: 'Yes',
    animalPictures: [{ mediaOrder: '1', large: { url: 'https://example.com/dog.jpg' } }]
  });
  assert.equal(pet.id, '12345');
  assert.equal(pet.size, 'Extra Large');
  assert.equal(pet.isUrgent, true);
  assert.equal(pet.attributes.specialNeeds, false);
  assert.equal(pet.attributes.mixedBreed, true);
  assert.deepEqual(pet.photos, ['https://example.com/dog.jpg']);
});

test('returns null for a record missing an ID or name (bad shelter data)', () => {
  assert.equal(_internal.toPet({ animalName: 'No ID' }), null);
  assert.equal(_internal.toPet({ animalID: '1' }), null);
  assert.equal(_internal.toPet(null), null);
});

queueBanner('--- mock data fallback ---');

// Every mock.* call below is awaited -- mockData.js's exports are `async` (see its doc comment)
// purely so it honestly satisfies PetDataSource's Promise-returning contract, even though the
// underlying work is a synchronous array filter.

test('mock search filters by species', async () => {
  const { pets } = await mock.searchPets({ species: 'Cat' });
  assert.ok(pets.length > 0);
  assert.ok(pets.every((p) => p.species === 'Cat'));
});

test('mock search filters by species with multiple values (backs the browse page\'s Species checkbox group)', async () => {
  const { pets } = await mock.searchPets({ species: ['Cat', 'Rabbit'] });
  assert.ok(pets.length > 0);
  assert.ok(pets.every((p) => p.species === 'Cat' || p.species === 'Rabbit'));
});

test('mock search filters by name (q)', async () => {
  const { pets } = await mock.searchPets({ q: 'luna' });
  assert.ok(pets.some((p) => p.name === 'Luna'));
});

test('mock search filters by breed (contains, case-insensitive -- backs the new browse-page breed filter)', async () => {
  const { pets } = await mock.searchPets({ breed: 'shepherd' });
  assert.deepStrictEqual(pets.map((p) => p.name), ['Duke']);
});

test('mock search filters by gender (backs the new browse-page gender filter)', async () => {
  const { pets } = await mock.searchPets({ genders: ['Female'] });
  assert.deepStrictEqual(pets.map((p) => p.name).sort(), ['Clementine', 'Luna', 'Mochi']);
});

test('mock search filters by size (now a real filter, not just client-side after the page loads)', async () => {
  const { pets } = await mock.searchPets({ sizes: ['Extra Large'] });
  assert.deepStrictEqual(pets.map((p) => p.name), ['Duke']);
});

test('mock getPetById finds a known sample pet', async () => {
  const pet = await mock.getPetById('mock-101');
  assert.ok(pet);
  assert.equal(pet.name, 'Biscuit');
});

test('mock getUrgentPets only returns urgent pets', async () => {
  const urgent = await mock.getUrgentPets();
  assert.ok(urgent.length > 0);
  assert.ok(urgent.every((p) => p.isUrgent));
});

test('mock getUrgentPets narrows to a state when one is passed (backs the landing page geolocation feature)', async () => {
  // All mock shelters are in CA, so this should return the same set as no filter at all.
  const urgentCA = await mock.getUrgentPets('CA');
  const urgentAll = await mock.getUrgentPets();
  assert.deepStrictEqual(urgentCA.map((p) => p.id).sort(), urgentAll.map((p) => p.id).sort());

  // A state with no mock shelters should come back empty rather than ignoring the filter.
  const urgentTX = await mock.getUrgentPets('TX');
  assert.deepStrictEqual(urgentTX, []);
});

test('mock search filters by city (backs the new Browse page City dropdown)', async () => {
  // Rocket and Clementine are the only two pets at the Long Beach shelter (mock-2).
  const { pets } = await mock.searchPets({ state: 'CA', city: 'Long Beach' });
  assert.deepStrictEqual(pets.map((p) => p.name).sort(), ['Clementine', 'Rocket']);
});

test('mock search by city is case-insensitive and ignores extra whitespace', async () => {
  const { pets } = await mock.searchPets({ state: 'CA', city: '  long beach  ' });
  assert.deepStrictEqual(pets.map((p) => p.name).sort(), ['Clementine', 'Rocket']);
});

test('mock search by a city with no matching shelter returns no pets', async () => {
  const { pets } = await mock.searchPets({ state: 'CA', city: 'Sacramento' });
  assert.deepStrictEqual(pets, []);
});

test('mock getCitiesForState returns the distinct, sorted real cities in that state', async () => {
  assert.deepStrictEqual(await mock.getCitiesForState('CA'), ['Long Beach', 'Los Angeles', 'San Pedro']);
});

test('mock getCitiesForState returns an empty list for a state with no mock shelters', async () => {
  assert.deepStrictEqual(await mock.getCitiesForState('TX'), []);
});

test('mock search respects resultStart/resultLimit like the real provider does (interface alignment)', async () => {
  const all = await mock.searchPets({});
  assert.equal(all.pets.length, 6); // the full mock dataset, when no pagination is requested

  const firstPage = await mock.searchPets({ resultStart: 0, resultLimit: 2 });
  assert.equal(firstPage.pets.length, 2);
  assert.equal(firstPage.foundRows, 6); // foundRows is the TOTAL match count, not the page size

  const secondPage = await mock.searchPets({ resultStart: 2, resultLimit: 2 });
  assert.equal(secondPage.pets.length, 2);
  assert.notDeepEqual(firstPage.pets.map((p) => p.id), secondPage.pets.map((p) => p.id));
});

test('mock getCitiesForState returns an empty list when no state is given', async () => {
  assert.deepStrictEqual(await mock.getCitiesForState(), []);
  assert.deepStrictEqual(await mock.getCitiesForState(''), []);
});

/** Drains the queue in declaration order -- banners print, tests run (`await`ed, so an async
 * test body's rejection is caught same as a sync one's thrown error), pass/fail tallies as it
 * goes -- then prints the final summary and exits. See the `queue`/`test`/`queueBanner` doc
 * comment near the top of this file for why this two-phase "declare everything, then run it"
 * structure exists instead of running each test immediately as `test(...)` is called. */
async function runQueue() {
  for (const entry of queue) {
    if (entry.kind === 'banner') {
      console.log(entry.text);
      continue;
    }
    try {
      await entry.fn();
      console.log(`  ok  - ${entry.name}`);
      passed += 1;
    } catch (err) {
      console.log(`FAIL  - ${entry.name}`);
      console.log(`        ${err.message}`);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runQueue();
