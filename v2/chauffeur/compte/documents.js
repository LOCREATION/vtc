// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur, onglet Compte : mes documents
// -----------------------------------------------------------------------------
//   - les pièces déposées : type, numéro, fin de validité, état (en cours de
//     vérification, validé, refusé avec son motif), date de dépôt ;
//   - « Voir » ouvre la pièce par un lien temporaire ; « Retirer » enlève une
//     pièce encore en vérification (erreur de fichier) ;
//   - « Ajouter un document » : type, numéro, fin de validité (obligatoire
//     pour le permis, la carte VTC et la pièce d'identité), fichier (photo ou
//     PDF, 10 Mo au plus). Le fichier va dans documents/{compte}/…, puis la
//     pièce est enregistrée « en cours de vérification ». L'administration la
//     valide ou la refuse (module Chauffeurs) et le chauffeur est prévenu ; à
//     la validation, numéro et date passent sur la fiche (permis, carte VTC).
// Les pièces du véhicule sont déposées par l'administration (module Flotte).
// Lectures et écritures directes, limitées par les règles d'accès : table
// documents (ses pièces), dossier « documents » (son sous-dossier).
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import { jourParis, dateCourte } from '../commun/periodes.js';
import { TYPES_DOCUMENT_CHAUFFEUR, DOCUMENTS_A_ECHEANCE, STATUTS_DOCUMENT } from '../commun/libelles.js';
import { ouvrirFichier, extension } from '../commun/fichiers.js';

const TAILLE_MAX = 10 * 1024 * 1024;                     // 10 Mo, comme le dossier
const TYPES_FICHIER = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
// Accord du message d'envoi : « Carte professionnelle VTC envoyée »
const FEMININS = ['carte_vtc', 'piece_identite', 'registre_vtc'];

// apresChargement (facultatif) : appelé avec la liste des pièces à chaque
// lecture (dossier d'un nouveau chauffeur : pièces encore à fournir)
export function creerSectionDocuments(contexte, { apresChargement = null } = {}) {
  const $ = (id) => document.getElementById(id);
  const champ = (id, libelle, saisie, aide = null) => el('div', { classe: 'champ' },
    el('label', { for: id, texte: libelle }), saisie,
    aide ? el('p', { classe: 'aide', texte: aide }) : null,
    el('p', { classe: 'erreur-champ', id: `${id}-erreur`, hidden: true }));

  const type = el('select', { id: 'docs-type', classe: 'saisie' },
    el('option', { value: '', texte: 'Choisissez…' }),
    ...Object.entries(TYPES_DOCUMENT_CHAUFFEUR).map(([valeur, libelle]) => el('option', { value: valeur, texte: libelle })));
  const numero = el('input', { id: 'docs-numero', classe: 'saisie', type: 'text', maxlength: '60', autocomplete: 'off' });
  const echeance = el('input', { id: 'docs-echeance', classe: 'saisie', type: 'date' });
  const fichier = el('input', { id: 'docs-fichier', classe: 'saisie saisie-fichier', type: 'file', accept: TYPES_FICHIER.join(',') });
  type.addEventListener('change', () => {
    const avecDate = DOCUMENTS_A_ECHEANCE.includes(type.value);
    $('docs-bloc-echeance').hidden = !avecDate;
    if (!avecDate) echeance.value = '';
  });

  const formulaire = el('form', { classe: 'compte-formulaire', id: 'docs-formulaire', novalidate: true, hidden: true },
    champ('docs-type', 'Type de document', type),
    champ('docs-numero', 'Numéro (facultatif)', numero, 'Le numéro inscrit sur le document : il est reporté sur votre fiche à la validation.'),
    el('div', { id: 'docs-bloc-echeance', hidden: true }, champ('docs-echeance', 'Valable jusqu\'au', echeance)),
    champ('docs-fichier', 'Fichier', fichier, 'Photo nette et lisible, ou PDF : 10 Mo au plus. Recto et verso dans le même fichier si possible.'),
    el('div', { classe: 'actions-compte' },
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'docs-annuler', texte: 'Annuler', onclick: () => fermer() }),
      el('button', { type: 'submit', classe: 'bouton bouton-principal', id: 'docs-envoyer', texte: 'Envoyer' })));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); envoyer(); });
  // Un champ corrigé perd son message d'erreur
  const corrige = (e) => { if (e.target.getAttribute('aria-invalid') === 'true') marquer(e.target.id, null); };
  formulaire.addEventListener('input', corrige);
  formulaire.addEventListener('change', corrige);

  const ajouter = el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'docs-ajouter', texte: 'Ajouter un document' });
  ajouter.addEventListener('click', ouvrir);

  const section = el('section', { classe: 'panneau', id: 'compte-documents', 'aria-labelledby': 'docs-titre' },
    el('div', { classe: 'entete-panneau' }, el('h2', { id: 'docs-titre', texte: 'Mes documents' }), ajouter),
    el('p', { classe: 'aide', texte: 'Permis, carte VTC, pièce d\'identité… LOC RÉACTION les vérifie, puis vous prévient. Les pièces du véhicule sont gérées par LOC RÉACTION.' }),
    formulaire,
    el('ul', { classe: 'liste-pieces', id: 'docs-liste' }),
    el('p', { classe: 'vide', id: 'docs-vide', hidden: true, texte: 'Aucun document déposé pour le moment.' }));

  function marquer(id, message) {
    $(id).setAttribute('aria-invalid', message ? 'true' : 'false');
    $(`${id}-erreur`).hidden = !message;
    $(`${id}-erreur`).textContent = message || '';
  }

  function ouvrir() {
    formulaire.reset();
    $('docs-bloc-echeance').hidden = true;
    ['docs-type', 'docs-numero', 'docs-echeance', 'docs-fichier'].forEach((id) => marquer(id, null));
    formulaire.hidden = false;
    ajouter.hidden = true;
    type.focus();
  }

  function fermer() {
    formulaire.hidden = true;
    ajouter.hidden = false;
  }

  async function envoyer() {
    const moi = contexte.profil.id;
    const choisi = fichier.files && fichier.files[0];
    const ext = choisi ? extension(choisi) : null;
    const avecDate = DOCUMENTS_A_ECHEANCE.includes(type.value);
    marquer('docs-type', type.value ? null : 'Choisissez le type de document.');
    marquer('docs-numero', numero.value.trim().length <= 60 ? null : 'Numéro trop long : 60 caractères au plus.');
    marquer('docs-echeance', !avecDate || (echeance.value && echeance.value >= jourParis()) ? null
      : (echeance.value ? 'Ce document n\'est plus valable : déposez le document en cours de validité.' : 'Indiquez la date de fin de validité.'));
    let erreurFichier = null;
    if (!choisi) erreurFichier = 'Choisissez le fichier (photo ou PDF).';
    else if (choisi.size > TAILLE_MAX) erreurFichier = 'Fichier trop lourd : 10 Mo au plus.';
    else if (!TYPES_FICHIER.includes(choisi.type) && !['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'].includes(ext)) erreurFichier = 'Format non accepté : photo (JPEG, PNG, HEIC) ou PDF.';
    marquer('docs-fichier', erreurFichier);
    const premier = ['docs-type', 'docs-numero', 'docs-echeance', 'docs-fichier'].find((id) => $(id).getAttribute('aria-invalid') === 'true');
    if (premier) { $(premier).focus(); return; }

    const bouton = $('docs-envoyer');
    bouton.disabled = true;
    bouton.textContent = 'Envoi…';
    const chemin = `${moi}/${type.value}-${Date.now()}.${ext || 'pdf'}`;
    try {
      const envoi = await supabase.storage.from('documents').upload(chemin, choisi, { contentType: choisi.type || undefined, upsert: false });
      if (envoi.error) throw envoi.error;
      const { error } = await supabase.from('documents').insert({
        chauffeur_id: moi, type: type.value, fichier_chemin: chemin,
        numero: numero.value.trim() || null, expire_le: avecDate ? echeance.value : null
      });
      if (error) {
        await supabase.storage.from('documents').remove([chemin]);        // pas de fichier orphelin
        throw error;
      }
      const feminin = FEMININS.includes(type.value);
      fermer();
      afficherMessage(`${TYPES_DOCUMENT_CHAUFFEUR[type.value]} ${feminin ? 'envoyée' : 'envoyé'} : LOC RÉACTION ${feminin ? 'la' : 'le'} vérifie.`, 'succes');
      await charger();
    } catch (erreur) {
      afficherMessage(messageErreur(erreur), 'erreur');
    } finally {
      bouton.disabled = false;
      bouton.textContent = 'Envoyer';
    }
  }

  async function retirer(d) {
    try {
      // La pièce d'abord (la règle d'accès ne laisse retirer qu'une pièce en
      // vérification : aucune ligne retirée = déjà vérifiée), puis son fichier
      const { data, error } = await supabase.from('documents').delete().eq('id', d.id).select('id');
      if (error) throw error;
      if (data && data.length) {
        await supabase.storage.from('documents').remove([d.fichier_chemin]);
        afficherMessage('Document retiré.', 'succes');
      } else {
        afficherMessage('LOC RÉACTION a déjà vérifié ce document : il ne peut plus être retiré.', 'erreur');
      }
      await charger();
    } catch (erreur) {
      afficherMessage(messageErreur(erreur), 'erreur');
    }
  }

  function carte(d) {
    const details = [
      d.numero ? `n° ${d.numero}` : null,
      d.expire_le ? `valable jusqu'au ${dateCourte(d.expire_le)}${d.expire_le < jourParis() ? ' (dépassée)' : ''}` : null,
      `déposé le ${dateCourte(jourParis(d.cree_le))}`
    ].filter(Boolean).join(' · ');
    const voir = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-compact', texte: 'Voir' });
    voir.addEventListener('click', () => ouvrirFichier('documents', d.fichier_chemin).catch((erreur) => afficherMessage(messageErreur(erreur), 'erreur')));
    const actions = [voir];
    if (d.statut === 'en_attente') {
      const bouton = el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'Retirer' });
      bouton.addEventListener('click', () => { bouton.disabled = true; retirer(d).finally(() => { bouton.disabled = false; }); });
      actions.push(bouton);
    }
    return el('li', { classe: 'piece' },
      el('div', { classe: 'piece-entete' },
        el('strong', { texte: TYPES_DOCUMENT_CHAUFFEUR[d.type] || d.type }),
        el('span', { classe: 'etat-piece', dataset: { statut: d.statut }, texte: STATUTS_DOCUMENT[d.statut] || d.statut })),
      el('span', { classe: 'piece-details', texte: details }),
      d.statut === 'refuse' && d.commentaire ? el('p', { classe: 'piece-motif', texte: `Motif : ${d.commentaire}` }) : null,
      el('div', { classe: 'actions-compte' }, ...actions));
  }

  async function charger() {
    const { data, error } = await supabase.from('documents')
      .select('id, type, numero, expire_le, statut, commentaire, fichier_chemin, cree_le')
      .eq('chauffeur_id', contexte.profil.id).order('cree_le', { ascending: false });
    if (error) throw error;
    const pieces = data || [];
    $('docs-vide').hidden = pieces.length > 0;
    $('docs-liste').replaceChildren(...pieces.map(carte));
    if (apresChargement) apresChargement(pieces);
  }

  return { section, charger, fermer };
}
