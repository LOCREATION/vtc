// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : onglet Revenus
// -----------------------------------------------------------------------------
// Jour, semaine (du lundi au dimanche) ou mois, à l'heure de Paris ; les
// flèches remontent dans le temps (jamais au-delà de la période en cours) :
//   - chiffre d'affaires des courses terminées : prix fixe + attente
//     facturée, comme « Chiffre du jour » sur l'accueil ;
//   - détail : trajets (dont majorations de nuit, du dimanche et des jours
//     fériés), attente, frais d'annulation, remboursements, pourboires ;
//   - courses terminées et temps passé en course ; pour un salarié, heures
//     de travail saisies par l'administration ;
//   - jour par jour pour une semaine ou un mois ;
//   - relevé de la période, imprimable ou en PDF (document/, nouvel onglet :
//     le service continue dans celui-ci).
// Lectures : revenus_chauffeur (totaux par jour, remboursements compris),
// courses (part des majorations), salaries et temps_travail (salarié).
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { euros, el, afficherMessage } from '../../commun/outils.js';
import {
  jourParis, bornesPeriode, deplacerPeriode, libellePeriode, periodeDansPhrase,
  dateLongue, majuscule, dureeLisible, heuresLisibles
} from '../commun/periodes.js';
import { arrondi, majorationDe } from '../commun/libelles.js';
import { lireHistorique } from '../commun/historique.js';

const TYPES = [
  { code: 'jour', libelle: 'Jour' },
  { code: 'semaine', libelle: 'Semaine' },
  { code: 'mois', libelle: 'Mois' }
];
const etat = { type: 'jour', jour: null, demande: 0, contexte: null };
const $ = (id) => document.getElementById(id);

export async function afficher(conteneur, contexte) {
  etat.contexte = contexte;
  if (!conteneur.dataset.pret) {
    construire(conteneur);
    conteneur.dataset.pret = 'oui';
    etat.jour = jourParis();
  }
  await charger();
}

// ---------------------------------------------------------------------------
// Structure de l'onglet (une seule fois)
// ---------------------------------------------------------------------------
function construire(conteneur) {
  const bascule = el('div', { classe: 'bascule bascule-large', role: 'radiogroup', 'aria-label': 'Période' },
    ...TYPES.map((t) => {
      const choix = el('input', { type: 'radio', name: 'revenus-type', value: t.code, id: `revenus-type-${t.code}` });
      choix.checked = t.code === etat.type;
      choix.addEventListener('change', () => { etat.type = t.code; etat.jour = jourParis(); relire(); });
      return el('label', { for: `revenus-type-${t.code}` }, choix, el('span', { texte: t.libelle }));
    }));

  const precedente = el('button', { type: 'button', classe: 'bouton bouton-icone', id: 'revenus-precedente', 'aria-label': 'Période précédente' }, '‹');
  const suivante = el('button', { type: 'button', classe: 'bouton bouton-icone', id: 'revenus-suivante', 'aria-label': 'Période suivante' }, '›');
  precedente.addEventListener('click', () => deplacer(-1));
  suivante.addEventListener('click', () => deplacer(1));

  conteneur.replaceChildren(
    el('h1', { classe: 'vue-titre', id: 'titre-revenus', texte: 'Revenus' }),
    bascule,
    el('div', { classe: 'periode' }, precedente, el('p', { classe: 'periode-libelle', id: 'revenus-libelle', 'aria-live': 'polite' }), suivante),
    el('section', { classe: 'panneau revenus-total', 'aria-labelledby': 'revenus-etiquette' },
      el('p', { classe: 'etiquette-nuit', id: 'revenus-etiquette', texte: 'Chiffre d\'affaires des courses' }),
      el('p', { classe: 'revenus-montant', id: 'revenus-ca', texte: '…' }),
      el('p', { classe: 'aide', id: 'revenus-vide', hidden: true }),
      el('dl', { classe: 'chiffres', id: 'revenus-chiffres' }),
      el('p', { classe: 'aide', id: 'revenus-salarie', hidden: true,
        texte: 'Avec votre contrat de travail, ces montants sont le chiffre d\'affaires de vos courses pour LOC RÉACTION. Votre salaire figure sur votre bulletin de paie.' })),
    el('section', { classe: 'panneau', 'aria-labelledby': 'revenus-titre-detail' },
      el('h2', { id: 'revenus-titre-detail', texte: 'Détail' }),
      el('dl', { classe: 'lignes-valeurs', id: 'revenus-detail' })),
    el('section', { classe: 'panneau', id: 'revenus-bloc-jours', hidden: true, 'aria-labelledby': 'revenus-titre-jours' },
      el('h2', { id: 'revenus-titre-jours', texte: 'Jour par jour' }),
      el('ul', { classe: 'revenus-jours', id: 'revenus-jours' })),
    el('a', { classe: 'bouton bouton-secondaire bouton-large', id: 'revenus-releve', target: '_blank', rel: 'noopener', texte: 'Relevé de la période (PDF)' }),
    el('p', { classe: 'aide', texte: 'Le relevé s\'ouvre dans un nouvel onglet : imprimez-le ou enregistrez-le en PDF. Votre service continue ici.' }));
}

function deplacer(sens) {
  const { du } = bornesPeriode(etat.type, etat.jour);
  const cible = deplacerPeriode(etat.type, du, sens);
  if (cible > jourParis()) return;                 // pas de période à venir
  etat.jour = cible;
  relire();
}

// Relecture après un choix (période, flèches) : une erreur s'affiche en bas
function relire() {
  charger().catch((erreur) => afficherMessage(messageErreur(erreur), 'erreur'));
}

// ---------------------------------------------------------------------------
// Lecture et affichage
// ---------------------------------------------------------------------------
async function charger() {
  const moi = etat.contexte.profil.id;
  const { du, au } = bornesPeriode(etat.type, etat.jour);
  const numero = ++etat.demande;                   // seule la dernière demande s'affiche
  $('revenus-libelle').textContent = libellePeriode(etat.type, du, au);
  $('revenus-suivante').disabled = au >= jourParis();
  $('revenus-releve').href = `document/?type=releve&du=${du}&au=${au}`;

  // Totaux par jour (base), courses terminées (part des majorations), contrat
  const [revenus, terminees, salarie] = await Promise.all([
    supabase.rpc('revenus_chauffeur', { p_debut: du, p_fin: au }),
    lireHistorique({ chauffeur: moi, du, au, statuts: ['terminee'],
      colonnes: 'id, statut, terminee_le, annulee_le, prix_base, majoration_pourcentage, forfait_id' }),
    supabase.from('salaries').select('id').eq('profil_id', moi).maybeSingle()
  ]);
  if (revenus.error) throw revenus.error;
  if (salarie.error) throw salarie.error;
  let heures = null;
  if (salarie.data) {
    const temps = await supabase.from('temps_travail').select('heures').eq('salarie_id', salarie.data.id).gte('jour', du).lte('jour', au);
    if (temps.error) throw temps.error;
    heures = (temps.data || []).reduce((s, t) => s + Number(t.heures || 0), 0);
  }
  if (numero !== etat.demande) return;

  const jours = revenus.data || [];
  const somme = (champ) => arrondi(jours.reduce((s, j) => s + Number(j[champ] || 0), 0));
  const t = {
    courses: jours.reduce((s, j) => s + Number(j.courses || 0), 0),
    trajets: somme('chiffre_affaires'), attente: somme('attente'), pourboires: somme('pourboires'),
    annulations: somme('frais_annulation'), remboursements: somme('remboursements'), minutes: somme('minutes_en_course'),
    majorations: arrondi(terminees.reduce((s, c) => s + majorationDe(c), 0))
  };
  const chiffre = arrondi(t.trajets + t.attente);

  $('revenus-ca').textContent = euros(chiffre);
  $('revenus-vide').hidden = t.courses > 0;
  $('revenus-vide').textContent = `Aucune course terminée ${periodeDansPhrase(etat.type, du, au)}.`;
  $('revenus-salarie').hidden = !salarie.data;
  $('revenus-chiffres').replaceChildren(...[
    ['Courses terminées', String(t.courses)],
    ['Temps en course', dureeLisible(t.minutes)],
    ['Pourboires', euros(t.pourboires)],
    heures === null ? null : ['Heures de travail saisies', heures ? heuresLisibles(heures) : '—']
  ].filter(Boolean).map(([dt, dd]) => el('div', {}, el('dt', { texte: dt }), el('dd', { texte: dd }))));

  $('revenus-detail').replaceChildren(...[
    ['Trajets (prix fixes)', euros(t.trajets)],
    ['dont majorations (nuit, dimanche, jours fériés)', euros(t.majorations), 'retrait'],
    ['Attente facturée', euros(t.attente)],
    ['Chiffre d\'affaires des courses', euros(chiffre), 'total'],
    ['Frais d\'annulation', euros(t.annulations)],
    ['Remboursements aux clients', t.remboursements ? `− ${euros(t.remboursements)}` : euros(0)],
    ['Pourboires', euros(t.pourboires)]
  ].flatMap(([dt, dd, classe]) => [el('dt', { classe: classe || null, texte: dt }), el('dd', { classe: classe || null, texte: dd })]));

  // Jour par jour (semaine, mois) : les jours avec une activité, du plus récent
  const avecActivite = jours.filter((j) => Number(j.courses) > 0 || Number(j.frais_annulation) > 0 || Number(j.pourboires) > 0);
  $('revenus-bloc-jours').hidden = etat.type === 'jour' || !avecActivite.length;
  $('revenus-jours').replaceChildren(...avecActivite.slice().reverse().map((j) => el('li', {},
    el('span', { classe: 'revenus-jour-date', texte: majuscule(dateLongue(j.jour, { annee: false })) }),
    el('span', { classe: 'revenus-jour-courses', texte: `${j.courses} ${Number(j.courses) > 1 ? 'courses' : 'course'}` }),
    el('strong', { classe: 'revenus-jour-montant', texte: euros(arrondi(Number(j.chiffre_affaires) + Number(j.attente))) }))));
}
