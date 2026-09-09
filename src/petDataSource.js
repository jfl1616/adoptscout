'use strict';

/**
 * The contract every pet data source (RescueGroups, the mock/sample fallback, and any future
 * source) must implement. Kept as a plain JSDoc typedef rather than a TypeScript interface --
 * this project deliberately stays no-build-step plain JS (see README's "Notable scope
 * decisions") -- but it still buys two real things: editor hover/autocomplete wherever a
 * `@type {PetDataSource}` annotation is used, and a shape every provider is actually checked
 * against at startup via `assertImplementsPetDataSource` below, so a provider missing a method
 * (a typo'd export, a forgotten rename after a refactor) fails loudly the moment the server
 * starts, instead of surfacing as a confusing "X is not a function" deep inside a request
 * handler the first time a visitor happens to hit that one route.
 *
 * Deliberately does NOT include `source`/`externalId`/`url` fields for cross-provider dedup --
 * that's real complexity that only pays for itself once a second live source actually exists
 * and needs to be merged with the first (see the project's status doc for the fuller
 * multi-source-aggregation discussion). Adding it now, with one active source, would be
 * speculative plumbing for a problem that doesn't exist yet.
 *
 * @typedef {Object} PetAttributes
 * @property {boolean} mixedBreed
 * @property {boolean} altered
 * @property {boolean} declawed
 * @property {boolean} houseTrained
 * @property {boolean} specialNeeds
 *
 * @typedef {Object} Pet
 * @property {string} id
 * @property {string|null} orgId
 * @property {string} name
 * @property {string} species
 * @property {string} breed
 * @property {string} age
 * @property {string} sex
 * @property {string} size
 * @property {string} description
 * @property {string} status
 * @property {string[]} photos
 * @property {PetAttributes} attributes
 * @property {boolean} isUrgent
 *
 * @typedef {Object} Shelter
 * @property {string} id
 * @property {string} name
 * @property {string|null} email
 * @property {string|null} phone
 * @property {string|null} fax
 * @property {string|null} address
 * @property {string|null} city
 * @property {string|null} state
 * @property {string|null} postalCode
 * @property {string|null} country
 * @property {string|null} about
 * @property {'unknown'|'normal'|'nearCapacity'|'overCapacity'} capacityStatus
 *
 * @typedef {Object} SearchPetsParams
 * @property {string|string[]} [species]
 *   Both shapes are real: routes/pets.js's `parseListParam` always turns the `?species=` query
 *   param into an array (or leaves it undefined) before calling a provider, but a caller working
 *   with a provider directly (tests, or any future caller) may still pass a bare string -- every
 *   provider is expected to accept either, the way mockData.js's `matches()` already does.
 * @property {string[]} [ages]
 * @property {string[]} [genders]
 * @property {string} [breed]
 * @property {string[]} [sizes]
 * @property {string} [state]
 * @property {string} [city]
 * @property {string} [q]
 * @property {number} [resultStart]
 * @property {number} [resultLimit]
 *
 * @typedef {Object} SearchPetsResult
 * @property {Pet[]} pets
 * @property {number} foundRows
 *
 * @typedef {Object} PetDataSource
 * @property {() => boolean} isConfigured
 *   True when this source has whatever it needs (an API key, etc.) to be tried at all. Checked
 *   once up front so an unconfigured source is skipped entirely rather than attempted and failed.
 * @property {(params?: SearchPetsParams) => Promise<SearchPetsResult>} searchPets
 * @property {(id: string) => Promise<Pet|null>} getPetById
 * @property {(orgId: string|null) => Promise<Shelter|null>} getShelterById
 * @property {(state?: string) => Promise<Pet[]>} getUrgentPets
 * @property {(state: string) => Promise<string[]>} getCitiesForState
 */

/** Every method a valid PetDataSource must expose -- the runtime counterpart to the typedef
 * above, since plain JS has no compiler to check `@implements` for us. */
const REQUIRED_METHODS = [
  'isConfigured',
  'searchPets',
  'getPetById',
  'getShelterById',
  'getUrgentPets',
  'getCitiesForState'
];

/**
 * Throws a clear, specific error if `provider` is missing any required PetDataSource method.
 * Meant to be called once per provider at server startup (see petSource.js) -- catches a broken
 * provider immediately, with a message naming exactly which method(s) are missing, rather than
 * letting the gap surface as a vague crash the first time some visitor's request happens to need
 * that particular method.
 *
 * @param {object} provider
 * @param {string} name -- used in the error message, e.g. "rescuegroups" or "mock"
 */
function assertImplementsPetDataSource(provider, name) {
  const missing = REQUIRED_METHODS.filter((method) => typeof provider[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `Pet data source "${name}" is missing required method(s): ${missing.join(', ')}. ` +
      `Every source must implement all of: ${REQUIRED_METHODS.join(', ')}.`
    );
  }
}

module.exports = { REQUIRED_METHODS, assertImplementsPetDataSource };
