'use strict';

(function () {
  const { getFavorites, el, renderPetCard } = window.AdoptScout;
  const resultsEl = document.getElementById('results');

  function render() {
    const favorites = Object.values(getFavorites());
    resultsEl.innerHTML = '';

    if (favorites.length === 0) {
      resultsEl.appendChild(el('div', { class: 'empty-state' },
        'No favorites yet — tap the ♥ on any pet to save it here.'));
      return;
    }

    const grid = el('div', { class: 'pet-grid' });
    favorites.forEach((pet) => {
      grid.appendChild(renderPetCard(pet, { onFavoriteChange: () => render() }));
    });
    resultsEl.appendChild(grid);
  }

  render();
})();
