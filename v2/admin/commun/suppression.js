// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : « Supprimer », le même bouton dans tous les modules
// -----------------------------------------------------------------------------
// Demande de l'administrateur : pouvoir supprimer à tous les niveaux, sans
// ouvrir la base de données ; la suppression agit dans la base.
//   - boutonSupprimer(action, etiquette) : bouton rouge « Supprimer » (le nom
//     de ce qui part dans l'étiquette lue par les lecteurs d'écran) ;
//   - confirmerSuppression({ titre, texte, efface, garde, fonction,
//     parametres, mot }) : boîte qui dit ce qui part et ce qui reste ; pour
//     un compte, le mot SUPPRIMER est à écrire. Elle appelle la fonction de
//     la base ; un refus (pièce que la loi impose de garder, course en cours…)
//     s'affiche dans la boîte, avec la raison et ce qui se fait à la place.
//     Après la suppression, les fichiers du stockage partent aussi
//     (fichiers-en-attente.js). Renvoie le résultat de la base, ou null si
//     l'administrateur renonce ou si la base refuse ;
//   - expliquerConservation({ titre, texte, alternative }) : pour une pièce
//     que la loi interdit d'effacer (facture, avoir, paiement encaissé,
//     remboursement, remise d'espèces, bulletin validé, contrat signé) : la
//     boîte dit pourquoi et propose ce qui se fait à la place.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el } from '../../commun/outils.js';
import { messageErreurAdmin } from './composants.js';
import { effacerFichiersEnAttente } from './fichiers-en-attente.js';

export const MOT_SUPPRESSION = 'SUPPRIMER';

// Bouton rouge ; désactivé le temps de l'action (pas de double ouverture)
export function boutonSupprimer(action, etiquette = null, libelle = 'Supprimer') {
  const b = el('button', { type: 'button', classe: 'bouton bouton-danger bouton-petit', texte: libelle, 'aria-label': etiquette || null });
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await action(); } finally { b.disabled = false; }
  });
  return b;
}

// Liste « Effacé » ou « Gardé » de la boîte
function liste(titre, lignes, classe) {
  if (!lignes || !lignes.length) return null;
  return el('div', { classe: `suppression-liste${classe ? ` ${classe}` : ''}` },
    el('h3', { texte: titre }),
    el('ul', {}, ...lignes.map((t) => el('li', { texte: t }))));
}

export function confirmerSuppression({
  titre, texte = null, efface = [], garde = [], fonction, parametres = {}, mot = false,
  libelle = 'Supprimer définitivement'
}) {
  return new Promise((resoudre) => {
    let resultat = null;
    const saisie = mot
      ? el('input', { classe: 'saisie', id: 'suppression-mot', type: 'text', autocomplete: 'off', autocapitalize: 'characters',
        spellcheck: 'false', maxlength: '20', 'aria-describedby': 'suppression-erreur' })
      : null;
    const erreur = el('p', { classe: 'alerte', id: 'suppression-erreur', role: 'alert', hidden: true });
    const annuler = el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'suppression-annuler', texte: 'Annuler',
      onclick: () => dialogue.close() });
    const valider = el('button', { type: 'submit', classe: 'bouton bouton-danger-plein', id: 'suppression-confirmer', texte: libelle });
    const formulaire = el('form', { novalidate: true },
      el('h2', { id: 'fenetre-titre', texte: titre }),
      texte ? el('p', { texte }) : null,
      liste('Effacé', efface, null),
      liste('Gardé, comme la loi l\'impose', garde, 'suppression-garde'),
      mot ? el('div', { classe: 'champ' },
        el('label', { for: 'suppression-mot', texte: `Pour confirmer, écrivez ${MOT_SUPPRESSION}` }), saisie) : null,
      erreur,
      el('div', { classe: 'fenetre-actions' }, annuler, valider));
    const dialogue = el('dialog', { classe: 'fenetre fenetre-suppression', id: 'fenetre-suppression', 'aria-labelledby': 'fenetre-titre' },
      formulaire);

    const montrer = (message) => { erreur.textContent = message; erreur.hidden = false; };
    if (saisie) saisie.addEventListener('input', () => { erreur.hidden = true; });

    formulaire.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saisie && saisie.value.trim().toUpperCase() !== MOT_SUPPRESSION) {
        montrer(`Écrivez ${MOT_SUPPRESSION} pour confirmer.`);
        saisie.focus();
        return;
      }
      valider.disabled = true;
      erreur.hidden = true;
      const { data, error } = await supabase.rpc(fonction, parametres);
      if (error) {
        montrer(messageErreurAdmin(error));
        // Refus de la base : la raison et la marche à suivre sont affichées,
        // rien à retenter depuis cette boîte
        if (error.code === 'P0001') {
          valider.hidden = true;
          annuler.textContent = 'Fermer';
          annuler.focus();
        } else {
          valider.disabled = false;
        }
        return;
      }
      resultat = data ?? {};
      await effacerFichiersEnAttente();          // fichiers du stockage
      dialogue.close();
    });
    dialogue.addEventListener('close', () => { dialogue.remove(); resoudre(resultat); });
    document.body.append(dialogue);
    dialogue.showModal();
    (saisie || annuler).focus();                // par défaut sur « Annuler »
  });
}

// Pièce que la loi interdit d'effacer : pourquoi, et ce qui se fait à la place
export function expliquerConservation({ titre, texte, alternative = null }) {
  return new Promise((resoudre) => {
    let choisie = false;
    const compris = el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'conservation-compris', texte: 'Compris',
      onclick: () => dialogue.close() });
    const autre = alternative
      ? el('button', { type: 'button', classe: 'bouton bouton-principal', id: 'conservation-alternative', texte: alternative.libelle,
        onclick: () => { choisie = true; dialogue.close(); } })
      : null;
    const dialogue = el('dialog', { classe: 'fenetre fenetre-suppression', id: 'fenetre-conservation', 'aria-labelledby': 'fenetre-titre' },
      el('div', { classe: 'fenetre-corps' },
        el('h2', { id: 'fenetre-titre', texte: titre }),
        ...[].concat(texte).map((t) => el('p', { texte: t })),
        el('div', { classe: 'fenetre-actions' }, compris, autre)));
    dialogue.addEventListener('close', async () => {
      dialogue.remove();
      if (choisie && alternative) await alternative.action();
      resoudre(choisie);
    });
    document.body.append(dialogue);
    dialogue.showModal();
    compris.focus();
  });
}

// Textes de la loi, repris dans les boîtes
export const CONSERVATION = {
  comptable: 'La loi impose de conserver 10 ans les pièces comptables (Code de commerce, article L123-22) : une fois émise, elle ne s\'efface ni ne se modifie.',
  paie: 'La loi impose de conserver 5 ans les bulletins de paie et le dossier du salarié (Code du travail, article L3243-4).'
};
