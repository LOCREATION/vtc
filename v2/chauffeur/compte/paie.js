// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur, onglet Compte : ma paie (salarié de LOC RÉACTION)
// -----------------------------------------------------------------------------
//   - bulletins de paie validés par l'administration, du plus récent au plus
//     ancien : mois, net à payer, date de paiement ; « Ouvrir le bulletin »
//     (le bulletin tel que calculé et validé, imprimable ou en PDF :
//     document/?type=bulletin) et, s'il a été joint, « PDF remis » ;
//   - contrats de travail remis pour signature, signés ou terminés :
//     « Ouvrir le contrat » (le contrat tel qu'établi par l'administration)
//     et « PDF signé » dès qu'il est classé. Un contrat signé avant
//     l'application n'existe qu'en PDF signé.
// Un bulletin en brouillon ou un contrat pas encore remis n'est jamais
// visible du salarié (règles d'accès de la base).
// Section cachée pour un chauffeur sans fiche salarié.
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';
import { libellePeriode, dateCourte, jourParis } from '../commun/periodes.js';
import { STATUTS_BULLETIN, TYPES_CONTRAT, STATUTS_CONTRAT } from '../commun/libelles.js';
import { ouvrirFichier } from '../commun/fichiers.js';

// Couleur de l'état : à signer (attente), signé (validé), terminé (neutre)
const COULEUR_CONTRAT = { envoye: 'en_attente', signe: 'valide', termine: 'neutre' };

export function creerSectionPaie() {
  const $ = (id) => document.getElementById(id);
  const section = el('section', { classe: 'panneau', id: 'compte-paie', 'aria-labelledby': 'paie-titre', hidden: true },
    el('h2', { id: 'paie-titre', texte: 'Ma paie' }),
    el('h3', { classe: 'sous-titre-compte', texte: 'Bulletins de paie' }),
    el('ul', { classe: 'liste-pieces', id: 'paie-bulletins' }),
    el('p', { classe: 'vide', id: 'paie-bulletins-vide', hidden: true, texte: 'Aucun bulletin pour le moment : il apparaît ici dès que LOC RÉACTION l\'a validé.' }),
    el('h3', { classe: 'sous-titre-compte', texte: 'Contrat de travail' }),
    el('ul', { classe: 'liste-pieces', id: 'paie-contrats' }),
    el('p', { classe: 'vide', id: 'paie-contrats-vide', hidden: true, texte: 'Aucun contrat remis pour le moment.' }),
    el('p', { classe: 'aide', texte: 'Les documents s\'ouvrent dans un nouvel onglet : imprimez-les ou enregistrez-les en PDF.' }));

  // Document imprimable de l'espace chauffeur (nouvel onglet)
  function lien(href, libelle) {
    return el('a', { classe: 'bouton bouton-secondaire bouton-compact', href, target: '_blank', rel: 'noopener', texte: libelle });
  }

  // PDF rangé par l'administration dans le dossier privé de la paie
  function boutonPdf(chemin, libelle) {
    const bouton = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-compact', texte: libelle });
    bouton.addEventListener('click', () => ouvrirFichier('paie', chemin).catch((erreur) => afficherMessage(messageErreur(erreur), 'erreur')));
    return bouton;
  }

  function carteBulletin(b) {
    return el('li', { classe: 'piece' },
      el('div', { classe: 'piece-entete' },
        el('strong', { texte: libellePeriode('mois', b.periode, b.periode) }),
        el('span', { classe: 'etat-piece', dataset: { statut: 'valide' }, texte: STATUTS_BULLETIN[b.statut] || b.statut })),
      el('span', { classe: 'piece-details', texte: [`Net à payer ${euros(b.net_a_payer)}`, b.date_paiement ? `payé le ${dateCourte(b.date_paiement)}` : null].filter(Boolean).join(' · ') }),
      el('div', { classe: 'actions-compte' },
        lien(`document/?type=bulletin&id=${b.id}`, 'Ouvrir le bulletin'),
        b.pdf_chemin ? boutonPdf(b.pdf_chemin, 'PDF remis') : null));
  }

  function carteContrat(k) {
    const champs = k.champs || {};
    const externe = champs.externe === true || !champs.salarie;           // signé avant l'application
    return el('li', { classe: 'piece' },
      el('div', { classe: 'piece-entete' },
        el('strong', { texte: TYPES_CONTRAT[k.type] || k.type }),
        el('span', { classe: 'etat-piece', dataset: { statut: COULEUR_CONTRAT[k.statut] || 'neutre' }, texte: STATUTS_CONTRAT[k.statut] || k.statut })),
      el('span', { classe: 'piece-details', texte: [
        k.type === 'avenant' ? `prend effet le ${dateCourte(k.date_debut)}` : `depuis le ${dateCourte(k.date_debut)}`,
        k.date_fin ? `jusqu'au ${dateCourte(k.date_fin)}` : null,
        k.signe_le ? `signé le ${dateCourte(jourParis(k.signe_le))}` : null
      ].filter(Boolean).join(' · ') }),
      k.statut === 'envoye' ? el('p', { classe: 'piece-details', texte: 'Relisez-le : vous le signez sur l\'exemplaire papier remis par LOC RÉACTION (mention « Lu et approuvé »).' }) : null,
      el('div', { classe: 'actions-compte' },
        externe ? null : lien(`document/?type=contrat&id=${k.id}`, k.type === 'avenant' ? 'Ouvrir l\'avenant' : 'Ouvrir le contrat'),
        k.pdf_chemin ? boutonPdf(k.pdf_chemin, 'PDF signé') : null));
  }

  // salarie : fiche salarié du chauffeur ({ id }), ou null
  async function charger(salarie) {
    section.hidden = !salarie;
    if (!salarie) return;
    const [bulletins, contrats] = await Promise.all([
      supabase.from('bulletins').select('id, periode, net_a_payer, statut, date_paiement, pdf_chemin')
        .eq('salarie_id', salarie.id).neq('statut', 'brouillon').order('periode', { ascending: false }),
      supabase.from('contrats').select('id, type, date_debut, date_fin, statut, signe_le, pdf_chemin, champs')
        .eq('salarie_id', salarie.id).neq('statut', 'brouillon').order('date_debut', { ascending: false })
    ]);
    if (bulletins.error) throw bulletins.error;
    if (contrats.error) throw contrats.error;
    const listeBulletins = bulletins.data || [];
    const listeContrats = contrats.data || [];
    $('paie-bulletins-vide').hidden = listeBulletins.length > 0;
    $('paie-bulletins').replaceChildren(...listeBulletins.map(carteBulletin));
    $('paie-contrats-vide').hidden = listeContrats.length > 0;
    $('paie-contrats').replaceChildren(...listeContrats.map(carteContrat));
  }

  return { section, charger };
}
