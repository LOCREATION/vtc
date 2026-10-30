// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : finances
// -----------------------------------------------------------------------------
// Point d'entrée de la page : choisit la vue d'après l'adresse.
//   ?facture=…              facture imprimable (pieces.js)
//   ?avoir=…                avoir imprimable (pieces.js)
//   ?vue=a_encaisser        onglet Encaissements (par défaut), liste choisie :
//        impayes | encaisses | annules
//   ?vue=especes            espèces des chauffeurs (especes.js)
//   ?vue=factures           factures et avoirs (factures.js)
//   ?vue=remboursements     remboursements (remboursements.js)
//   ?vue=tva                TVA et dossier pour l'expert-comptable (tva.js)
// Les alertes du tableau de bord mènent directement à la bonne liste
// (paiements à encaisser, impayés, espèces des chauffeurs).
// =============================================================================
import { el } from '../../commun/outils.js';
import { ouvrirAdministration } from '../commun/admin.js';
import { afficherEncaissements, LISTES } from './encaissements.js';
import { afficherEspeces } from './especes.js';
import { afficherFactures } from './factures.js';
import { afficherRemboursements } from './remboursements.js';
import { afficherTva } from './tva.js';
import { ouvrirFacture, ouvrirAvoir } from './pieces.js';

const $ = (id) => document.getElementById(id);
const ONGLETS = [
  { code: 'encaissements', libelle: 'Encaissements', afficher: afficherEncaissements },
  { code: 'especes', libelle: 'Espèces des chauffeurs', afficher: afficherEspeces },
  { code: 'factures', libelle: 'Factures et avoirs', afficher: afficherFactures },
  { code: 'remboursements', libelle: 'Remboursements', afficher: afficherRemboursements },
  { code: 'tva', libelle: 'TVA et export', afficher: afficherTva }
];

ouvrirAdministration({ module: 'finances' }).then(async () => {
  const p = new URLSearchParams(location.search);
  if (p.get('facture')) { await ouvrirFacture(p.get('facture')); return; }
  if (p.get('avoir')) { await ouvrirAvoir(p.get('avoir')); return; }
  afficherVue(p.get('vue') || 'a_encaisser', p);
});

// Onglet d'une vue : les quatre listes de paiements sont dans « Encaissements »
function ongletDe(vue) {
  if (LISTES.includes(vue)) return 'encaissements';
  return ONGLETS.some((o) => o.code === vue) ? vue : 'encaissements';
}

function afficherVue(vue, parametres = new URLSearchParams()) {
  const onglet = ongletDe(vue);
  const vueEffective = onglet === 'encaissements' && !LISTES.includes(vue) ? 'a_encaisser' : vue;
  $('titre-page').textContent = 'Finances';
  document.title = 'Finances, administration LOC RÉACTION';
  $('onglets').hidden = false;
  $('onglets').replaceChildren(...ONGLETS.map((o) => {
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(o.code === onglet), texte: o.libelle });
    b.addEventListener('click', () => {
      if (o.code === onglet) return;
      const cible = o.code === 'encaissements' ? 'a_encaisser' : o.code;
      history.replaceState(null, '', `${location.pathname}?vue=${cible}`);
      afficherVue(cible);
    });
    return b;
  }));
  ONGLETS.find((o) => o.code === onglet).afficher({ vue: vueEffective, parametres });
}
