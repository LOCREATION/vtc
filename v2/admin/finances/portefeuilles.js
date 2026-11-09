// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : finances — portefeuilles des clients
// -----------------------------------------------------------------------------
// - Chiffres : argent dans les portefeuilles, recharges payées sur la
//   période, recharges en attente chez Mollie, reste dû.
// - Recharges de la période (Mollie) : numéro, client, montant, état, moyen
//   (carte, Apple Pay…), identifiant du paiement chez Mollie (à retrouver dans
//   le tableau de bord de Mollie), « essai » pour un paiement en mode test.
//   « Supprimer » : une recharge sans suite (échouée, annulée, expirée,
//   jamais ouverte) ; payée, c'est une pièce comptable (10 ans) ; en attente
//   chez Mollie, son paiement peut encore aboutir : la boîte le dit.
// - Reste dû : courses que le portefeuille ne couvrait plus (frais
//   d'attente) ; prélevé à la recharge suivante, ou depuis la fiche de la
//   course (« Prélever sur le portefeuille »).
// - Soldes des clients : les 100 plus élevés.
// Lecture : admin_portefeuilles ; suppression : admin_supprimer_recharge.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  tableau, tuile, pluriel, dateCourte, jourHeure, badge, messageErreurAdmin, STATUTS_RECHARGE, METHODES_MOLLIE, NATURES_PAIEMENT
} from '../commun/composants.js';
import { champsPeriode, bornes, periodeValable, periodeLisible, periodeCourte } from '../commun/periode.js';
import { boutonSupprimer, confirmerSuppression, expliquerConservation, CONSERVATION } from '../commun/suppression.js';
import { ecrireAdresse, lireDate } from '../commun/listes.js';

const $ = (id) => document.getElementById(id);
const filtres = { du: '', au: '' };

export function afficherPortefeuilles({ parametres }) {
  const mois = bornes('mois');
  filtres.du = lireDate(parametres, 'du') || mois.du;
  filtres.au = lireDate(parametres, 'au') || mois.au;
  if (!periodeValable(filtres.du, filtres.au)) Object.assign(filtres, mois);
  $('entete-actions').replaceChildren();

  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-portefeuilles', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-recharges' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-recharges', texte: 'Recharges' }),
        el('span', { classe: 'sous-titre', id: 'periode-recharges' })),
      el('p', { classe: 'aide-module', texte: 'Le client recharge son portefeuille sur la page de paiement de Mollie ; il est crédité '
        + 'dès que Mollie confirme. L\'identifiant « tr_… » permet de retrouver le paiement dans le tableau de bord de Mollie.' }),
      el('form', { classe: 'barre-outils', onsubmit: (e) => e.preventDefault() },
        ...champsPeriode({ prefixe: 'portefeuilles', du: filtres.du, au: filtres.au,
          changer: ({ du, au }) => { filtres.du = du; filtres.au = au; charger(); } })),
      el('div', { id: 'liste-recharges' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))),
    el('section', { classe: 'carte-admin', id: 'carte-dettes', hidden: true, 'aria-labelledby': 'titre-dettes' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-dettes', texte: 'Reste dû aux portefeuilles' })),
      el('p', { classe: 'aide-module', texte: 'Fin de course que le solde ne couvrait plus (frais d\'attente) : la somme est prélevée '
        + 'automatiquement à la prochaine recharge du client, ou depuis la fiche de la course, « Prélever sur le portefeuille ».' }),
      el('div', { id: 'liste-dettes' })),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-soldes' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-soldes', texte: 'Soldes des clients' }),
        el('span', { classe: 'sous-titre', texte: 'les 100 plus élevés' })),
      el('div', { id: 'liste-soldes' })));
  charger();
}

async function charger() {
  ecrireAdresse('portefeuilles', { du: filtres.du, au: filtres.au });
  $('liste-recharges').classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_portefeuilles', { p_debut: filtres.du, p_fin: filtres.au });
  $('liste-recharges').classList.remove('rechargement');
  if (error) { $('liste-recharges').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }

  const r = data.recharges;
  const dettes = data.dettes || [];
  const totalDettes = dettes.reduce((total, d) => total + Math.round(Number(d.montant) * 100), 0) / 100;
  const periode = periodeCourte(filtres.du, filtres.au);
  $('chiffres-portefeuilles').replaceChildren(
    tuile('Dans les portefeuilles', euros(data.soldes.total), pluriel(data.soldes.comptes, 'client avec un solde', 'clients avec un solde')),
    tuile('Recharges payées', euros(r.payees), `${pluriel(r.nb_payees, 'recharge', 'recharges')} · ${periode}`, Number(r.payees) > 0 ? 'vert' : null),
    tuile('Chez Mollie', String(r.nb_ouvertes), r.nb_ouvertes ? 'paiements en cours, pas encore crédités' : 'aucun paiement en cours',
      r.nb_ouvertes ? 'or' : null),
    tuile('Reste dû', euros(totalDettes), dettes.length ? pluriel(dettes.length, 'somme à prélever', 'sommes à prélever') : 'rien à prélever',
      dettes.length ? 'or' : null));
  $('periode-recharges').textContent = `Période : ${periodeLisible(filtres.du, filtres.au)}`;

  $('liste-recharges').replaceChildren(tableau({
    colonnes: [
      { titre: 'Recharge', valeur: (x) => el('span', {}, el('strong', { texte: x.numero }),
        el('span', { classe: 'secondaire', texte: jourHeure(x.payee_le || x.cree_le) })) },
      { titre: 'Client', valeur: (x) => el('span', {}, el('a', { href: lienAdmin(`clients/?id=${x.client_id}`), texte: x.client_nom || x.client_email || 'Client' }),
        x.client_nom && x.client_email ? el('span', { classe: 'secondaire', texte: x.client_email }) : null) },
      { titre: 'Montant', droite: true, valeur: (x) => euros(x.montant) },
      { titre: 'État', valeur: (x) => {
        const s = STATUTS_RECHARGE[x.statut] || { libelle: x.statut, ton: 'gris' };
        return el('span', {}, badge(s.libelle, s.ton), x.mollie_mode === 'test' ? el('span', { classe: 'secondaire', texte: 'essai (mode test)' }) : null);
      } },
      { titre: 'Paiement Mollie', valeur: (x) => el('span', {}, METHODES_MOLLIE[x.methode] || x.methode || '—',
        x.mollie_id ? el('span', { classe: 'secondaire', texte: x.mollie_id }) : null) },
      { titre: '', valeur: (x) => boutonSupprimer(() => supprimerRecharge(x), `Supprimer la recharge ${x.numero}`) }
    ],
    lignes: data.lignes || [],
    vide: 'Aucune recharge sur cette période.'
  }));

  $('carte-dettes').hidden = !dettes.length;
  $('liste-dettes').replaceChildren(tableau({
    colonnes: [
      { titre: 'Course', valeur: (d) => el('span', {}, el('a', { href: lienAdmin(`courses/?id=${d.course_id}`), texte: d.course_numero }),
        el('span', { classe: 'secondaire', texte: NATURES_PAIEMENT[d.nature] || d.nature })) },
      { titre: 'Client', valeur: (d) => el('a', { href: lienAdmin(`clients/?id=${d.client_id}`), texte: d.client_nom || d.client_email || 'Client' }) },
      { titre: 'Montant', droite: true, valeur: (d) => euros(d.montant) },
      { titre: 'Depuis', valeur: (d) => dateCourte(d.cree_le) }
    ],
    lignes: dettes,
    vide: 'Aucun reste dû.'
  }));

  $('liste-soldes').replaceChildren(tableau({
    colonnes: [
      { titre: 'Client', valeur: (c) => el('span', {}, el('a', { href: lienAdmin(`clients/?id=${c.id}`), texte: c.nom || c.email || 'Client' }),
        c.statut === 'supprime' ? el('span', { classe: 'secondaire', texte: 'compte supprimé' }) : (c.nom && c.email ? el('span', { classe: 'secondaire', texte: c.email }) : null)) },
      { titre: 'Solde', droite: true, valeur: (c) => el('strong', { texte: euros(c.solde) }) },
      { titre: 'Dernier mouvement', valeur: (c) => jourHeure(c.maj_le) }
    ],
    lignes: data.clients || [],
    vide: 'Aucun client n\'a de solde pour le moment.'
  }));
}

// Supprimer une recharge : seulement sans suite (ni payée, ni chez Mollie)
async function supprimerRecharge(x) {
  if (x.statut === 'payee') {
    await expliquerConservation({
      titre: `La recharge ${x.numero} ne peut pas être supprimée`,
      texte: [`Elle a été payée : ${euros(x.montant)} sont entrés sur le compte de l'entreprise. ${CONSERVATION.comptable}`,
        'Pour rendre l\'argent au client, faites un remboursement depuis Mollie, puis corrigez son portefeuille depuis sa fiche.']
    });
    return;
  }
  if (x.statut === 'ouverte') {
    await expliquerConservation({
      titre: `La recharge ${x.numero} attend Mollie`,
      texte: ['Le client est peut-être en train de payer : son paiement peut encore aboutir et doit pouvoir créditer son portefeuille.',
        'Elle se ferme d\'elle-même (payée, échouée, annulée ou expirée) dès que Mollie donne sa réponse.']
    });
    return;
  }
  const s = STATUTS_RECHARGE[x.statut] || { libelle: x.statut };
  const resultat = await confirmerSuppression({
    titre: `Supprimer la recharge ${x.numero} ?`,
    texte: `${euros(x.montant)}, ${s.libelle.toLowerCase()} : rien n'a été payé.`,
    efface: ['La recharge sans suite'],
    fonction: 'admin_supprimer_recharge',
    parametres: { p_recharge: x.id }
  });
  if (!resultat) return;
  afficherMessage(`Recharge ${x.numero} supprimée.`, 'succes');
  await charger();
}
