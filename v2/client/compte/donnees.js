// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client, onglet Compte : section « Données personnelles »
// -----------------------------------------------------------------------------
//   - « Télécharger mes données » : un fichier JSON avec tout ce que LOC
//     RÉACTION garde sur le client, rien des autres personnes (fonction
//     mes_donnees de la base) ;
//   - « Supprimer mon compte » : une boîte dit ce qui est effacé, ce qui est
//     gardé sans coordonnées (comptabilité, litiges) et le solde perdu ; le
//     client écrit SUPPRIMER (DELETE en anglais). La base contrôle (course en
//     cours ou à venir, paiement non réglé, dossier chauffeur), efface et
//     ferme toutes les connexions (supprimer_mon_compte) ; la page oublie sa
//     session et ne propose plus que le retour à l'accueil.
// Ancre : #compte-donnees.
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { RACINE } from '../../commun/config.js';
import { t, langueActive, lienAvecLangue } from '../../commun/i18n.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';

const $ = (id) => document.getElementById(id);
// Date du jour à Paris, au format 2026-11-07 (nom du fichier)
const JOUR = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });

// Réponse de la base → texte dans la langue de la page
const ERREURS = [
  ['course est en cours ou à venir', 'donnees.erreur_course'],
  ['paiement est signalé non réglé', 'donnees.erreur_paiement'],
  ['dossier chauffeur', 'donnees.erreur_chauffeur'],
  ['réservée aux comptes clients', 'donnees.erreur_role'],
  ['réservé aux comptes clients', 'donnees.erreur_role'],
  ['écrivez SUPPRIMER', 'donnees.mot_errone']
];
function texteErreur(erreur) {
  const message = (erreur && erreur.message) || '';
  const connue = ERREURS.find(([extrait]) => message.includes(extrait));
  return connue ? t(connue[1], { mot: t('donnees.mot') }) : messageErreur(erreur, langueActive());
}

export function creerSectionDonnees({ contexte }) {
  let fini = false;          // compte supprimé : la boîte ne se referme plus

  const boite = el('dialog', { classe: 'dialogue-client', id: 'compte-suppression', 'aria-labelledby': 'compte-suppression-titre' },
    el('form', { classe: 'dialogue-client-contenu', id: 'compte-suppression-formulaire', novalidate: true },
      el('h2', { id: 'compte-suppression-titre', texte: t('donnees.titre_suppression') }),
      el('ul', { classe: 'consequences-suppression' },
        el('li', { texte: t('donnees.efface') }),
        el('li', { texte: t('donnees.garde') }),
        el('li', { id: 'compte-suppression-solde', hidden: true }),
        el('li', { texte: t('donnees.deconnexion') })),
      el('p', { classe: 'aide-client', texte: t('donnees.conseil') }),
      el('div', { classe: 'champ' },
        el('label', { for: 'compte-suppression-mot', texte: t('donnees.confirmer_libelle', { mot: t('donnees.mot') }) }),
        el('input', { id: 'compte-suppression-mot', classe: 'saisie', type: 'text', autocomplete: 'off', autocapitalize: 'characters',
          spellcheck: 'false', maxlength: '20', 'aria-describedby': 'compte-suppression-erreur' })),
      el('p', { classe: 'erreur-champ', id: 'compte-suppression-erreur', role: 'alert', hidden: true }),
      el('div', { classe: 'actions-client actions-larges' },
        el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'compte-suppression-garder', texte: t('donnees.garder'),
          onclick: () => boite.close() }),
        el('button', { type: 'submit', classe: 'bouton bouton-danger-plein', id: 'compte-suppression-confirmer',
          texte: t('donnees.supprimer_definitivement') }))),
    el('div', { classe: 'dialogue-client-contenu', id: 'compte-suppression-fait', hidden: true },
      el('h2', { texte: t('donnees.fait_titre') }),
      el('p', { texte: t('donnees.fait_texte') }),
      el('a', { classe: 'bouton bouton-principal', id: 'compte-suppression-accueil', href: lienAvecLangue(RACINE),
        texte: t('donnees.retour_accueil') })));
  // Compte supprimé : ni Échap ni retour ne ramènent à une page sans session
  boite.addEventListener('cancel', (e) => { if (fini) e.preventDefault(); });
  boite.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); supprimer(); });
  boite.querySelector('#compte-suppression-mot').addEventListener('input', () => erreur(null));

  const section = el('section', { classe: 'bloc-client', id: 'compte-donnees', 'aria-labelledby': 'compte-titre-donnees' },
    el('h2', { id: 'compte-titre-donnees', texte: t('donnees.titre') }),
    el('p', { classe: 'aide-client', texte: t('donnees.aide') }),
    el('div', { classe: 'actions-client actions-larges' },
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'compte-telecharger', texte: t('donnees.telecharger'),
        onclick: telecharger }),
      el('button', { type: 'button', classe: 'bouton bouton-texte bouton-retirer', id: 'compte-supprimer', texte: t('donnees.supprimer'),
        onclick: ouvrir })),
    boite);

  // -------------------------------------------------------------------------
  // Télécharger mes données
  // -------------------------------------------------------------------------
  async function telecharger() {
    const bouton = $('compte-telecharger');
    bouton.disabled = true;
    const { data, error } = await supabase.rpc('mes_donnees');
    bouton.disabled = false;
    if (error) { afficherMessage(texteErreur(error), 'erreur'); return; }
    const fichier = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const lien = el('a', { href: URL.createObjectURL(fichier), download: `loc-reaction-mes-donnees-${JOUR.format(new Date())}.json`, hidden: true });
    document.body.append(lien);
    lien.click();
    lien.remove();
    setTimeout(() => URL.revokeObjectURL(lien.href), 30000);
    afficherMessage(t('donnees.telecharge'), 'succes');
  }

  // -------------------------------------------------------------------------
  // Supprimer mon compte
  // -------------------------------------------------------------------------
  function erreur(texte) {
    $('compte-suppression-erreur').textContent = texte || '';
    $('compte-suppression-erreur').hidden = !texte;
    $('compte-suppression-mot').setAttribute('aria-invalid', texte ? 'true' : 'false');
  }

  async function ouvrir() {
    $('compte-suppression-mot').value = '';
    erreur(null);
    // Solde restant : annoncé comme perdu
    const { data } = await supabase.from('soldes').select('montant').eq('profil_id', contexte.profil.id).maybeSingle();
    const solde = Number(data && data.montant) || 0;
    $('compte-suppression-solde').hidden = solde <= 0;
    $('compte-suppression-solde').textContent = solde > 0 ? t('donnees.solde_perdu', { montant: euros(solde) }) : '';
    boite.showModal();
    $('compte-suppression-mot').focus();
  }

  async function supprimer() {
    const mot = $('compte-suppression-mot').value.trim().toUpperCase();
    if (mot !== t('donnees.mot')) {
      erreur(t('donnees.mot_errone', { mot: t('donnees.mot') }));
      $('compte-suppression-mot').focus();
      return;
    }
    const bouton = $('compte-suppression-confirmer');
    bouton.disabled = true;
    const { error } = await supabase.rpc('supprimer_mon_compte', { p_confirmation: mot });
    bouton.disabled = false;
    if (error) { erreur(texteErreur(error)); return; }
    // La base a fermé toutes les connexions : la page oublie la sienne
    fini = true;
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    $('compte-suppression-formulaire').hidden = true;
    $('compte-suppression-fait').hidden = false;
    $('compte-suppression-accueil').focus();
  }

  return { section };
}
