// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : RH et paie
// -----------------------------------------------------------------------------
// Point d'entrée de la page : choisit la vue d'après l'adresse.
//   ?vue=salaries      salariés (par défaut, salaries.js)
//   ?vue=bulletins     bulletins d'un mois (bulletins.js)
//   ?vue=absences      congés et absences (absences.js)
//   ?vue=temps         temps de travail (temps.js)
//   ?vue=parametres    paramètres de paie (parametres-paie.js)
//   ?salarie=…         dossier d'un salarié (salaries.js)
//   ?contrat=…         contrat de travail imprimable (contrat.js)
//   ?bulletin=…        bulletin de paie imprimable (bulletin.js)
//   ?preparer=…&periode=AAAA-MM-01   préparation d'un bulletin (preparation.js)
// =============================================================================
import { el } from '../../commun/outils.js';
import { ouvrirAdministration } from '../commun/admin.js';
import { afficherSalaries, ouvrirDossier } from './salaries.js';
import { afficherBulletins } from './bulletins.js';
import { afficherAbsences } from './absences.js';
import { afficherTemps } from './temps.js';
import { afficherParametresPaie } from './parametres-paie.js';
import { ouvrirContrat } from './contrat.js';
import { ouvrirBulletin } from './bulletin.js';
import { ouvrirPreparation } from './preparation.js';

const $ = (id) => document.getElementById(id);
const ONGLETS = [
  { code: 'salaries', libelle: 'Salariés', afficher: afficherSalaries },
  { code: 'bulletins', libelle: 'Bulletins de paie', afficher: afficherBulletins },
  { code: 'absences', libelle: 'Congés et absences', afficher: afficherAbsences },
  { code: 'temps', libelle: 'Temps de travail', afficher: afficherTemps },
  { code: 'parametres', libelle: 'Paramètres de paie', afficher: afficherParametresPaie }
];

ouvrirAdministration({ module: 'rh' }).then(() => {
  const p = new URLSearchParams(location.search);
  const vue = p.get('vue');
  // Pages sans onglet ; avec « vue », « salarie » n'est qu'un filtre de l'onglet
  if (!vue) {
    if (p.get('salarie')) { ouvrirDossier(p.get('salarie')); return; }
    if (p.get('contrat')) { ouvrirContrat(p.get('contrat')); return; }
    if (p.get('bulletin')) { ouvrirBulletin(p.get('bulletin')); return; }
    if (p.get('preparer')) { ouvrirPreparation(p.get('preparer'), p.get('periode')); return; }
  }
  afficherVue(vue || 'salaries', p);
});

export function afficherVue(vue, parametres = new URLSearchParams()) {
  const onglet = ONGLETS.find((o) => o.code === vue) || ONGLETS[0];
  document.title = 'RH et paie, administration LOC RÉACTION';
  $('titre-page').textContent = 'RH et paie';
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
