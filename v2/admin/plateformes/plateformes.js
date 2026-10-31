// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : plateformes
// -----------------------------------------------------------------------------
// Point d'entrée de la page : choisit la vue d'après l'adresse.
//   ?vue=releves        relevés des plateformes (par défaut, releves.js)
//   ?vue=rentabilite    rentabilité par chauffeur (rentabilite.js)
// =============================================================================
import { el } from '../../commun/outils.js';
import { ouvrirAdministration } from '../commun/admin.js';
import { afficherReleves } from './releves.js';
import { afficherRentabilite } from './rentabilite.js';

const $ = (id) => document.getElementById(id);
const ONGLETS = [
  { code: 'releves', libelle: 'Relevés', afficher: afficherReleves },
  { code: 'rentabilite', libelle: 'Rentabilité par chauffeur', afficher: afficherRentabilite }
];

ouvrirAdministration({ module: 'plateformes' }).then(() => {
  const p = new URLSearchParams(location.search);
  afficherVue(p.get('vue') || 'releves', p);
});

function afficherVue(vue, parametres = new URLSearchParams()) {
  const onglet = ONGLETS.find((o) => o.code === vue) || ONGLETS[0];
  document.title = 'Plateformes, administration LOC RÉACTION';
  $('onglets').hidden = false;
  $('onglets').replaceChildren(...ONGLETS.map((o) => {
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(o.code === onglet.code), texte: o.libelle });
    b.addEventListener('click', () => {
      if (o.code === onglet.code) return;
      history.replaceState(null, '', `${location.pathname}?vue=${o.code}`);
      afficherVue(o.code);
    });
    return b;
  }));
  onglet.afficher({ parametres });
}
