// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : actions sur un paiement
// -----------------------------------------------------------------------------
// Communes à la fiche d'une course et au module Finances :
//   - confirmer l'encaissement (espèces : gardées par le chauffeur jusqu'à
//     leur remise au bureau, ou reçues directement au bureau) ; un paiement
//     déclaré impayé s'encaisse de la même façon quand le client a réglé ;
//   - déclarer impayé (motif obligatoire, la somme reste due) ;
//   - annuler tout ou partie d'une somme due : la facture est corrigée par un
//     avoir, le client est prévenu ;
//   - rembourser (virement, carte, espèces) : avoir automatique ;
//   - paiement sur facture mensuelle : il se règle avec le relevé de
//     l'entreprise (lien vers la fiche de l'entreprise).
// Chaque action est vérifiée et enregistrée par la base (fonctions serveur),
// et inscrite au journal à votre nom.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from './admin.js';
import {
  fenetreFormulaire, confirmer, messageErreurAdmin, MODES_PAIEMENT, NATURES_PAIEMENT, MODES_REMBOURSEMENT, dateCourte, avecDe
} from './composants.js';

const centimes = (x) => Math.round(Number(x || 0) * 100);

// Mois « 2026-10 » en toutes lettres : « octobre 2026 »
function moisLisible(mois) {
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${mois}-15T12:00:00Z`));
}

// Bouton qui se désactive le temps de l'action (pas de double envoi)
function bouton(texte, action, classe = 'bouton-secondaire') {
  const b = el('button', { type: 'button', classe: `bouton ${classe} bouton-petit`, texte });
  b.addEventListener('click', async () => { b.disabled = true; try { await action(); } finally { b.disabled = false; } });
  return b;
}

// « la course C-2026-000123 », « le pourboire de la course … »
function quoi(p) {
  const course = p.course_numero ? ` de la course ${p.course_numero}` : '';
  if (p.nature === 'pourboire') return `le pourboire${course}`;
  if (p.nature === 'frais_annulation') return `les frais d'annulation${course}`;
  return p.course_numero ? `la course ${p.course_numero}` : 'la course';
}

// Boutons d'action d'un paiement (ligne renvoyée par la base : id, nature,
// mode, montant, statut, rembourse, course_numero, chauffeur_nom,
// compte_pro_id, compte_pro, releve_mois). recharger() : relecture après action.
export function actionsPaiement(p, recharger) {
  const actions = [];
  const du = ['a_encaisser', 'echoue'].includes(p.statut);
  if (du && p.mode === 'facture_mensuelle') {
    if (p.compte_pro_id) {
      actions.push(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`clients/?entreprise=${p.compte_pro_id}`),
        texte: p.releve_mois ? `Relevé ${avecDe(moisLisible(p.releve_mois))}` : 'Relevé de l\'entreprise' }));
    }
  } else if (du) {
    actions.push(bouton(p.statut === 'echoue' ? 'Encaisser (réglé depuis)' : 'Confirmer l\'encaissement',
      () => confirmerEncaissement(p, recharger), 'bouton-principal'));
  }
  if (p.statut === 'a_encaisser' && p.mode !== 'facture_mensuelle') {
    actions.push(bouton('Déclarer impayé', () => declarerImpaye(p, recharger)));
  }
  if (du) actions.push(bouton('Annuler la somme', () => annulerSomme(p, recharger), 'bouton-danger'));
  const reste = (centimes(p.montant) - centimes(p.rembourse)) / 100;
  if (['encaisse', 'rembourse'].includes(p.statut) && reste > 0) {
    actions.push(bouton('Rembourser', () => rembourserPaiement(p, reste, recharger)));
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Confirmer l'encaissement
// ---------------------------------------------------------------------------
export async function confirmerEncaissement(p, recharger) {
  let auBureau = false;
  if (p.mode === 'especes') {
    // Qui a reçu l'argent ? Le chauffeur le garde jusqu'à sa remise au bureau.
    const options = [];
    if (p.chauffeur_nom) options.push({ valeur: 'chauffeur', libelle: `${p.chauffeur_nom}, qui les remettra au bureau` });
    options.push({ valeur: 'bureau', libelle: 'Le bureau (espèces remises directement)' });
    let choix = null;
    const fait = await fenetreFormulaire({
      titre: `Confirmer l'encaissement de ${euros(p.montant)} ?`,
      intro: `Espèces pour ${quoi(p)} : confirmez seulement si l'argent a bien été reçu.`,
      champs: [{ nom: 'recu_par', libelle: 'Qui a reçu les espèces ?', type: 'choix', requis: true, options, plein: true,
        aide: 'Espèces gardées par le chauffeur : elles s\'ajoutent à ce qu\'il doit remettre au bureau (Finances, Espèces des chauffeurs).' }],
      valeurs: { recu_par: options[0].valeur },
      libelle: 'Confirmer',
      enregistrer: async (v) => { choix = v.recu_par; }
    });
    if (!fait) return;
    auBureau = choix === 'bureau';
  } else {
    const ok = await confirmer({
      titre: `Confirmer l'encaissement de ${euros(p.montant)} ?`,
      texte: `${MODES_PAIEMENT[p.mode] || p.mode} pour ${quoi(p)} : confirmez seulement si l'argent a bien été reçu.`,
      libelle: 'Confirmer'
    });
    if (!ok) return;
  }
  const { error } = await supabase.rpc('confirmer_encaissement', { p_paiement: p.id, p_especes_au_bureau: auBureau });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(p.mode === 'especes' && !auBureau && p.chauffeur_nom
    ? `Encaissement confirmé : ${euros(p.montant)} à remettre au bureau par ${p.chauffeur_nom}.`
    : 'Encaissement confirmé.', 'succes');
  await recharger();
}

// ---------------------------------------------------------------------------
// Déclarer impayé
// ---------------------------------------------------------------------------
export async function declarerImpaye(p, recharger) {
  const fait = await fenetreFormulaire({
    titre: `Déclarer impayés les ${euros(p.montant)} ?`,
    intro: `${NATURES_PAIEMENT[p.nature] || p.nature} : ${quoi(p)}. La somme reste due : vous pourrez l'encaisser quand le client aura réglé, ou l'annuler.`,
    champs: [{ nom: 'motif', libelle: 'Motif (client injoignable, carte refusée…)', type: 'zone', requis: true, longueur: 300, plein: true,
      aide: 'Conservé dans le journal ; il n\'est pas envoyé au client.' }],
    libelle: 'Déclarer impayé',
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('admin_paiement_impaye', { p_paiement: p.id, p_motif: v.motif });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Paiement déclaré impayé.', 'succes'); await recharger(); }
}

// ---------------------------------------------------------------------------
// Annuler tout ou partie d'une somme due (avoir)
// ---------------------------------------------------------------------------
export async function annulerSomme(p, recharger) {
  const avecFacture = p.nature !== 'pourboire';
  let resultat = null;
  const fait = await fenetreFormulaire({
    titre: 'Annuler tout ou partie de la somme due',
    intro: `${euros(p.montant)} dus pour ${quoi(p)}. `
      + (avecFacture ? 'La facture est corrigée par un avoir du montant annulé, et le client est prévenu.' : 'Le client est prévenu.'),
    champs: [
      { nom: 'montant', libelle: 'Montant à annuler (€)', type: 'nombre', requis: true, min: 0.01, max: Number(p.montant), pas: '0.01', plein: true,
        aide: 'La somme entière, ou une partie seulement (le reste demeure à encaisser).' },
      { nom: 'motif', libelle: avecFacture ? 'Motif, transmis au client et imprimé sur l\'avoir' : 'Motif, transmis au client',
        type: 'zone', requis: true, longueur: 300, plein: true }
    ],
    valeurs: { montant: Number(p.montant) },
    libelle: 'Annuler la somme',
    enregistrer: async (v) => {
      const { data, error } = await supabase.rpc('admin_annuler_paiement', { p_paiement: p.id, p_montant: Math.round(v.montant * 100) / 100, p_motif: v.motif });
      if (error) throw error;
      resultat = data;
    }
  });
  if (!fait) return;
  afficherMessage(resultat && resultat.avoir ? `Somme annulée : avoir ${resultat.avoir.numero} émis, le client est prévenu.` : 'Somme annulée, le client est prévenu.', 'succes');
  await recharger();
}

// ---------------------------------------------------------------------------
// Rembourser
// ---------------------------------------------------------------------------
export async function rembourserPaiement(p, reste, recharger) {
  const modes = [{ valeur: 'virement', libelle: MODES_REMBOURSEMENT.virement }];
  if (p.mode === 'carte') modes.unshift({ valeur: 'carte', libelle: `${MODES_REMBOURSEMENT.carte} (depuis le terminal de paiement)` });
  modes.push({ valeur: 'especes', libelle: `${MODES_REMBOURSEMENT.especes} (caisse du bureau)` });
  const parDefaut = p.mode === 'carte' ? 'carte' : p.mode === 'especes' ? 'especes' : 'virement';
  const avecFacture = p.nature !== 'pourboire';
  const fait = await fenetreFormulaire({
    titre: 'Rembourser le client',
    intro: `Paiement de ${euros(p.montant)} (${(NATURES_PAIEMENT[p.nature] || p.nature).toLowerCase()}, ${(MODES_PAIEMENT[p.mode] || p.mode).toLowerCase()}`
      + `${p.encaisse_le ? `, encaissé le ${dateCourte(p.encaisse_le)}` : ''}) : au plus ${euros(reste)} à rembourser.`
      + (avecFacture ? ' Un avoir du même montant corrige la facture.' : ''),
    champs: [
      { nom: 'montant', libelle: 'Montant à rembourser (€)', type: 'nombre', requis: true, min: 0.01, max: reste, pas: '0.01' },
      { nom: 'mode', libelle: 'Remboursé par', type: 'choix', requis: true, options: modes },
      { nom: 'motif', libelle: avecFacture ? 'Motif, transmis au client et imprimé sur l\'avoir' : 'Motif, transmis au client',
        type: 'zone', requis: true, longueur: 500, plein: true }
    ],
    valeurs: { montant: reste, mode: parDefaut },
    libelle: 'Rembourser',
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('rembourser', { p_paiement: p.id, p_montant: Math.round(v.montant * 100) / 100, p_motif: v.motif, p_mode: v.mode });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Remboursement enregistré. Le client est prévenu.', 'succes'); await recharger(); }
}

