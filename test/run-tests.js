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
const mock = require('../src/mockData');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
}

function daysAgoDateString(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

console.log('--- parseRescueGroupsDate ---');

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

console.log('--- isUrgent heuristic ---');

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

console.log('--- normalizeSize ---');

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

console.log('--- denormalizeSize (the inverse, used to build the server-side size filter) ---');

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

console.log('--- extractStateCode ---');

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

console.log('--- stripDescriptionHtml ---');

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

console.log('--- toPet mapping ---');

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

console.log('--- mock data fallback ---');

test('mock search filters by species', () => {
  const { pets } = mock.getMockPets({ species: 'Cat' });
  assert.ok(pets.length > 0);
  assert.ok(pets.every((p) => p.species === 'Cat'));
});

test('mock search filters by species with multiple values (backs the browse page\'s Species checkbox group)', () => {
  const { pets } = mock.getMockPets({ species: ['Cat', 'Rabbit'] });
  assert.ok(pets.length > 0);
  assert.ok(pets.every((p) => p.species === 'Cat' || p.species === 'Rabbit'));
});

test('mock search filters by name (q)', () => {
  const { pets } = mock.getMockPets({ q: 'luna' });
  assert.ok(pets.some((p) => p.name === 'Luna'));
});

test('mock search filters by breed (contains, case-insensitive -- backs the new browse-page breed filter)', () => {
  const { pets } = mock.getMockPets({ breed: 'shepherd' });
  assert.deepStrictEqual(pets.map((p) => p.name), ['Duke']);
});

test('mock search filters by gender (backs the new browse-page gender filter)', () => {
  const { pets } = mock.getMockPets({ genders: ['Female'] });
  assert.deepStrictEqual(pets.map((p) => p.name).sort(), ['Clementine', 'Luna', 'Mochi']);
});

test('mock search filters by size (now a real filter, not just client-side after the page loads)', () => {
  const { pets } = mock.getMockPets({ sizes: ['Extra Large'] });
  assert.deepStrictEqual(pets.map((p) => p.name), ['Duke']);
});

test('mock getMockPetById finds a known sample pet', () => {
  const pet = mock.getMockPetById('mock-101');
  assert.ok(pet);
  assert.equal(pet.name, 'Biscuit');
});

test('mock getMockUrgentPets only returns urgent pets', () => {
  const urgent = mock.getMockUrgentPets();
  assert.ok(urgent.length > 0);
  assert.ok(urgent.every((p) => p.isUrgent));
});

test('mock getMockUrgentPets narrows to a state when one is passed (backs the landing page geolocation feature)', () => {
  // All mock shelters are in CA, so this should return the same set as no filter at all.
  const urgentCA = mock.getMockUrgentPets('CA');
  assert.deepStrictEqual(urgentCA.map((p) => p.id).sort(), mock.getMockUrgentPets().map((p) => p.id).sort());

  // A state with no mock shelters should come back empty rather than ignoring the filter.
  const urgentTX = mock.getMockUrgentPets('TX');
  assert.deepStrictEqual(urgentTX, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
