// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : support
// -----------------------------------------------------------------------------
// Point d'entrée de la page : choisit la vue d'après l'adresse.
//   ?vue=demandes      demandes au support (par défaut, demandes.js)
//   ?vue=site          messages du site : contact et devis (site.js)
//   ?vue=objets        objets trouvés (objets.js)
//   ?demande=…         fil d'une demande (fil.js)
// =============================================================================
import { el } from '../../commun/outils.js';
import { ouvrirAdministration } from '../commun/admin.js';
import { afficherDemandes } from './demandes.js';
import { ouvrirFil } from './fil.js';
import { afficherSite } from './site.js';
import { afficherObjets } from './objets.js';

const $ = (id) => document.getElementById(id);
const ONGLETS = [
  { code: 'demandes', libelle: 'Demandes', afficher: afficherDemandes },
  { code: 'site', libelle: 'Messages du site', afficher: afficherSite },
  { code: 'objets', libelle: 'Objets trouvés', afficher: afficherObjets }
];

ouvrirAdministration({ module: 'support' }).then(() => {
  const p = new URLSearchParams(location.search);
  if (!p.get('vue') && p.get('demande')) { ouvrirFil(p.get('demande')); return; }
  afficherVue(p.get('vue') || 'demandes', p);
});

export function afficherVue(vue, parametres = new URLSearchParams()) {
  const onglet = ONGLETS.find((o) => o.code === vue) || ONGLETS[0];
  document.title = 'Support, administration LOC RÉACTION';
  $('titre-page').textContent = 'Support';
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
