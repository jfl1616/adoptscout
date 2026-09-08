'use strict';

/**
 * Sample/offline pet + shelter data, used whenever RESCUEGROUPS_API_KEY isn't configured (see
 * `isConfigured()` in rescuegroupsService.js and the routing choice in routes/pets.js). Mirrors
 * the Android app's MockPetRepository: lets the app run and be demoed/screenshotted without a
 * live API key, and gives `isUrgent`/`size`/`specialNeeds` real hand-set values so the feature
 * is visibly demonstrated even when live data's urgent signals are sparse.
 *
 * Photos are real (non-fictional-pet-specific) placeholder images: dogs from the Dog CEO API,
 * cats from TheCatAPI, a rabbit from LoremFlickr -- same sourcing as the Android app's sample
 * data, just referenced as hotlinked URLs here instead of bundled resources.
 */

const shelters = [
  {
    id: 'mock-1',
    name: 'Sunshine Paws Rescue',
    email: 'info@sunshinepawsrescue.example',
    phone: '(555) 010-1000',
    fax: null,
    address: '4200 Adoption Way',
    city: 'Los Angeles',
    state: 'CA',
    postalCode: '90001',
    country: 'US',
    about: 'A volunteer-run rescue focused on senior and special-needs animals.',
    capacityStatus: 'normal'
  },
  {
    id: 'mock-2',
    name: 'Second Chance Animal Shelter',
    email: 'adopt@secondchance.example',
    phone: '(555) 010-2000',
    fax: null,
    address: '850 Rescue Blvd',
    city: 'Long Beach',
    state: 'CA',
    postalCode: '90802',
    country: 'US',
    about: 'Municipal-adjacent shelter serving the greater Long Beach area.',
    capacityStatus: 'nearCapacity'
  },
  {
    id: 'mock-3',
    name: 'Harbor Hearts Humane Society',
    email: 'hello@harborhearts.example',
    phone: '(555) 010-3000',
    fax: '(555) 010-3001',
    address: '19 Pier Ave',
    city: 'San Pedro',
    state: 'CA',
    postalCode: '90731',
    country: 'US',
    about: 'Full-service shelter and low-cost vet clinic.',
    capacityStatus: 'overCapacity'
  }
];

const pets = [
  {
    id: 'mock-101',
    orgId: 'mock-3',
    name: 'Biscuit',
    species: 'Dog',
    breed: 'Labrador Retriever Mix',
    age: 'Senior',
    sex: 'Male',
    size: 'Large',
    description: 'Biscuit is a gentle old soul who loves slow walks and long naps in a sunbeam. Great with kids.',
    status: 'Available',
    photos: [
      'https://images.dog.ceo/breeds/labrador/n02099712_1123.jpg',
      'https://images.dog.ceo/breeds/labrador/n02099712_4425.jpg'
    ],
    attributes: { mixedBreed: true, altered: true, declawed: false, houseTrained: true, specialNeeds: false },
    isUrgent: true
  },
  {
    id: 'mock-102',
    orgId: 'mock-1',
    name: 'Luna',
    species: 'Cat',
    breed: 'Domestic Shorthair',
    age: 'Young',
    sex: 'Female',
    size: 'Small',
    description: "Luna is a curious, chatty tortoiseshell who'll supervise everything you do around the house.",
    status: 'Available',
    photos: [
      'https://cdn2.thecatapi.com/images/9j5.jpg',
      'https://cdn2.thecatapi.com/images/b6r.jpg'
    ],
    attributes: { mixedBreed: false, altered: true, declawed: false, houseTrained: true, specialNeeds: false },
    isUrgent: false
  },
  {
    id: 'mock-103',
    orgId: 'mock-2',
    name: 'Rocket',
    species: 'Dog',
    breed: 'Chihuahua Mix',
    age: 'Adult',
    sex: 'Male',
    size: 'Small',
    description: 'Rocket is a spirited little guy looking for an experienced dog owner. He needs daily insulin -- his special-needs care is simple once you get the routine down.',
    status: 'Available',
    photos: [
      'https://images.dog.ceo/breeds/chihuahua/n02085620_1152.jpg'
    ],
    attributes: { mixedBreed: true, altered: true, declawed: false, houseTrained: false, specialNeeds: true },
    isUrgent: true
  },
  {
    id: 'mock-104',
    orgId: 'mock-1',
    name: 'Mochi',
    species: 'Rabbit',
    breed: 'Holland Lop',
    age: 'Young',
    sex: 'Female',
    size: 'Small',
    description: 'Mochi is a floppy-eared sweetheart who loves fresh herbs and cardboard boxes.',
    status: 'Available',
    photos: [
      'https://loremflickr.com/640/480/rabbit?lock=104'
    ],
    attributes: { mixedBreed: false, altered: true, declawed: false, houseTrained: true, specialNeeds: false },
    isUrgent: false
  },
  {
    id: 'mock-105',
    orgId: 'mock-3',
    name: 'Duke',
    species: 'Dog',
    breed: 'German Shepherd Mix',
    age: 'Adult',
    sex: 'Male',
    size: 'Extra Large',
    description: "Duke is a loyal, well-trained shepherd mix. He's been waiting a while for the right match -- patient, food-motivated, and great on leash.",
    status: 'Available',
    photos: [
      'https://images.dog.ceo/breeds/germanshepherd/n02106662_3652.jpg'
    ],
    attributes: { mixedBreed: true, altered: true, declawed: false, houseTrained: true, specialNeeds: false },
    isUrgent: true
  },
  {
    id: 'mock-106',
    orgId: 'mock-2',
    name: 'Clementine',
    species: 'Cat',
    breed: 'Orange Tabby',
    age: 'Kitten',
    sex: 'Female',
    size: 'Small',
    description: 'Clementine is a playful kitten who loves feather toys and chasing her tail.',
    status: 'Available',
    photos: [
      'https://cdn2.thecatapi.com/images/c0v.jpg'
    ],
    attributes: { mixedBreed: true, altered: false, declawed: false, houseTrained: true, specialNeeds: false },
    isUrgent: false
  }
];

function matches(pet, { species, ages, genders, breed, sizes, state, city, q }) {
  // Accepts either a single species string (the landing page's hero search still sends this)
  // or an array (the browse page's checkbox group, which allows picking more than one).
  if (species) {
    const speciesList = Array.isArray(species) ? species : [species];
    if (speciesList.length > 0 && !speciesList.some((s) => String(s).toLowerCase() === pet.species.toLowerCase())) return false;
  }
  if (Array.isArray(ages) && ages.length > 0 && !ages.some((a) => a.toLowerCase() === pet.age.toLowerCase())) return false;
  if (Array.isArray(genders) && genders.length > 0 && !genders.some((g) => g.toLowerCase() === pet.sex.toLowerCase())) return false;
  if (breed && breed.trim() && !pet.breed.toLowerCase().includes(breed.trim().toLowerCase())) return false;
  if (Array.isArray(sizes) && sizes.length > 0 && !sizes.some((s) => s.toLowerCase() === pet.size.toLowerCase())) return false;
  if (state) {
    const shelter = shelters.find((s) => s.id === pet.orgId);
    if (!shelter || shelter.state.toLowerCase() !== String(state).trim().slice(-2).toLowerCase()) return false;
  }
  if (city && city.trim()) {
    const shelter = shelters.find((s) => s.id === pet.orgId);
    if (!shelter || shelter.city.toLowerCase() !== city.trim().toLowerCase()) return false;
  }
  if (q && q.trim() && !pet.name.toLowerCase().includes(q.trim().toLowerCase())) return false;
  return true;
}

function getMockPets(filters = {}) {
  const filtered = pets.filter((p) => matches(p, filters));
  return { pets: filtered, foundRows: filtered.length };
}

function getMockPetById(id) {
  return pets.find((p) => p.id === id) || null;
}

function getMockShelterById(orgId) {
  return shelters.find((s) => s.id === orgId) || null;
}

function getMockUrgentPets(state) {
  const urgent = pets.filter((p) => p.isUrgent);
  if (!state) return urgent;
  return urgent.filter((p) => matches(p, { state }));
}

/** Mock equivalent of rescuegroupsService's getCitiesForState -- distinct cities among the
 * sample shelters in a given state, so the City dropdown has something real to show even without
 * a live API key configured. */
function getMockCitiesForState(state) {
  const stateCode = state ? String(state).trim().slice(-2).toUpperCase() : null;
  if (!stateCode) return [];
  const cities = shelters
    .filter((s) => s.state.toUpperCase() === stateCode)
    .map((s) => s.city);
  return Array.from(new Set(cities)).sort((a, b) => a.localeCompare(b));
}

module.exports = {
  getMockPets,
  getMockPetById,
  getMockShelterById,
  getMockUrgentPets,
  getMockCitiesForState
};
