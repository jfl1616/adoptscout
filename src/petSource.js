'use strict';

/**
 * Chooses which PetDataSource (see petDataSource.js) actually serves each call: RescueGroups
 * when it's configured and currently healthy, the mock/sample data source otherwise. This is the
 * resilience layer from the "start small, interface the source out, fall back to mock if
 * RescueGroups isn't reachable" plan -- sitting between routes/pets.js and the two concrete
 * providers in rescuegroupsService.js / mockData.js, replacing the old static
 * `usingRealData() ? real : mock` check that only ever looked at whether an API key was set, not
 * whether RescueGroups was actually working right now.
 *
 * Built as a factory (`createPetSource`) rather than a single set of module-level functions
 * specifically so tests can construct an isolated instance with fake providers and a short
 * cooldown, instead of needing to fake the system clock or share mutable state across test
 * cases. The one instance the real app uses is exported as this module's default export, at the
 * bottom of this file.
 *
 * Every method here resolves to `{ data, source, reason? }` rather than the bare PetDataSource
 * return value -- `source` (`'rescuegroups'` or `'mock'`) is what lets routes/pets.js accurately
 * report which source served THIS particular call. That can no longer be decided once, up front,
 * from "is an API key configured", the way the old code did it: the entire point of this module is
 * that a configured-but-currently-unreachable RescueGroups falls back to mock live, mid-session,
 * without a restart -- so the frontend's "Showing sample data" banner needs to reflect that too,
 * even while a real key is sitting in the environment.
 *
 * `reason` is only present when `source` is `'mock'`, and says WHY: `'unconfigured'` (no API key
 * set at all) vs. `'unreachable'` (a key is set, but RescueGroups just failed or is still in its
 * post-failure cooldown). The frontend shows a different banner for each -- telling someone who
 * already configured a real key to "go set RESCUEGROUPS_API_KEY" would be confusing, since the
 * actual problem in that case is a temporary outage, not a missing key.
 *
 * Reachability is inferred reactively (try the real call, catch a failure) rather than via a
 * separate proactive health-check ping -- simpler, and it reacts to the exact same failures a
 * real request would hit. A short cooldown after a failure stops a real outage from making every
 * subsequent request pay the full RescueGroups timeout before falling back; it does NOT persist
 * across a server restart, which is an accepted tradeoff for how small the cooldown window is.
 */

const DEFAULT_COOLDOWN_MS = 60 * 1000;

/** Every PetDataSource method this selector knows how to route -- kept as a plain array (not
 * pulled from petDataSource.js's REQUIRED_METHODS) because `isConfigured` is deliberately
 * excluded: it's a synchronous, no-fallback-needed check the selector calls directly on the real
 * provider, not something callers ask the selector to route between two sources. */
const ROUTED_METHODS = ['searchPets', 'getPetById', 'getShelterById', 'getUrgentPets', 'getCitiesForState'];

/**
 * @param {object} options
 * @param {object} options.realProvider - a PetDataSource, tried first whenever
 *   `realProvider.isConfigured()` is true and it's not in cooldown.
 * @param {object} options.fallbackProvider - a PetDataSource always used when the real one is
 *   unconfigured, in cooldown, or just failed for this call.
 * @param {number} [options.cooldownMs] - how long a failure keeps the real provider skipped
 *   before it's tried again. Defaults to 60s; tests pass a much shorter value so they don't
 *   need to sleep real wall-clock time to exercise the cooldown path.
 * @param {(message: string) => void} [options.logger] - defaults to `console.error`; tests pass
 *   a spy instead of writing to the real console.
 */
function createPetSource({ realProvider, fallbackProvider, cooldownMs = DEFAULT_COOLDOWN_MS, logger = console.error } = {}) {
  let cooldownUntil = 0; // epoch ms; 0 (or any past timestamp) means "not in cooldown"

  function inCooldown() {
    return Date.now() < cooldownUntil;
  }

  async function withFallback(methodName, args) {
    if (!realProvider.isConfigured()) {
      // No key at all -- go straight to mock, no attempt, no failure, no cooldown involved.
      // This is the same fast path the app has always had.
      return { data: await fallbackProvider[methodName](...args), source: 'mock', reason: 'unconfigured' };
    }

    if (inCooldown()) {
      const remainingSec = Math.ceil((cooldownUntil - Date.now()) / 1000);
      logger(
        `[petSource] Skipping RescueGroups for ${methodName}() -- still in cooldown after an ` +
        `earlier failure (retrying in ~${remainingSec}s). Serving mock data instead.`
      );
      return { data: await fallbackProvider[methodName](...args), source: 'mock', reason: 'unreachable' };
    }

    try {
      const data = await realProvider[methodName](...args);
      return { data, source: 'rescuegroups' };
    } catch (err) {
      cooldownUntil = Date.now() + cooldownMs;
      logger(
        `[petSource] RescueGroups call to ${methodName}() failed -- falling back to mock data ` +
        `for ~${Math.round(cooldownMs / 1000)}s: ${err.message}`
      );
      return { data: await fallbackProvider[methodName](...args), source: 'mock', reason: 'unreachable' };
    }
  }

  /** @type {Record<string, (...args: any[]) => Promise<{data: any, source: 'rescuegroups'|'mock'}>>} */
  const petSource = {};
  ROUTED_METHODS.forEach((methodName) => {
    petSource[methodName] = (...args) => withFallback(methodName, args);
  });
  return petSource;
}

const rescueGroups = require('./rescuegroupsService');
const mock = require('./mockData');

const defaultPetSource = createPetSource({ realProvider: rescueGroups, fallbackProvider: mock });

module.exports = defaultPetSource;
module.exports.createPetSource = createPetSource;
