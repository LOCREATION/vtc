// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : marketing
// -----------------------------------------------------------------------------
// Point d'entrée de la page : choisit la vue d'après l'adresse.
//   ?vue=codes         codes promo (par défaut, codes.js)
//   ?vue=parrainage    parrainage (parrainage.js)
//   ?vue=campagnes     notifications groupées (campagnes.js)
// =============================================================================
import { el } from '../../commun/outils.js';
import { ouvrirAdministration } from '../commun/admin.js';
import { afficherCodes } from './codes.js';
import { afficherParrainage } from './parrainage.js';
import { afficherCampagnes } from './campagnes.js';

const $ = (id) => document.getElementById(id);
const ONGLETS = [
  { code: 'codes', libelle: 'Codes promo', afficher: afficherCodes },
  { code: 'parrainage', libelle: 'Parrainage', afficher: afficherParrainage },
  { code: 'campagnes', libelle: 'Notifications groupées', afficher: afficherCampagnes }
];

ouvrirAdministration({ module: 'marketing' }).then(() => {
  const p = new URLSearchParams(location.search);
  afficherVue(p.get('vue') || 'codes', p);
});

function afficherVue(vue, parametres = new URLSearchParams()) {
  const onglet = ONGLETS.find((o) => o.code === vue) || ONGLETS[0];
  document.title = 'Marketing, administration LOC RÉACTION';
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
  $('entete-actions').replaceChildren();
  onglet.afficher({ parametres });
}
