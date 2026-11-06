// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : le dossier d'un compte qui n'est pas (ou plus) chauffeur
// en service
// -----------------------------------------------------------------------------
// L'espace chauffeur s'ouvre pour tout compte connecté par son entrée
// (chauffeur/connexion/). Tant que LOC RÉACTION n'a pas validé le chauffeur,
// la page montre son dossier à la place du service :
//   - nouveau compte (client) : « Devenir chauffeur », la candidature (ville,
//     expérience, carte professionnelle VTC, permis, message), envoyée par la
//     fonction deposer_candidature de la base ;
//   - candidature envoyée : son état (reçue, en cours d'examen), ce qui a été
//     déclaré, les documents à déposer (permis, carte VTC, pièce d'identité,
//     justificatif de domicile) et leur vérification. La page se recharge
//     d'elle-même dès que LOC RÉACTION valide le compte : le service s'ouvre ;
//   - candidature refusée (avec le motif), compte chauffeur suspendu, compte
//     marqué « chauffeur » sans fiche (à enregistrer par LOC RÉACTION), compte
//     administrateur, compte bloqué : la situation et que faire.
// Contact de l'entreprise et déconnexion dans tous les cas.
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { RACINE } from '../../commun/config.js';
import { el, afficherMessage } from '../../commun/outils.js';
import { jourParis, dateCourte } from '../commun/periodes.js';
import { telephoneLisible } from '../commun/feuille-route.js';
import { TYPES_DOCUMENT_CHAUFFEUR, STATUTS_DOCUMENT } from '../commun/libelles.js';
import { creerSectionDocuments } from '../compte/documents.js';

const $ = (id) => document.getElementById(id);
// Pièces demandées à un nouveau chauffeur
const PIECES_DEMANDEES = ['permis', 'carte_vtc', 'piece_identite', 'justificatif_domicile'];
const STATUTS_CANDIDATURE = { nouvelle: 'Reçue', en_cours: 'En cours d\'examen' };
const etat = { conteneur: null, profil: null, deconnecter: null, minuteur: null };

// conteneur : zone de la page ; profil : compte connecté ; fiche : fiche
// chauffeur (ou null) ; deconnecter : déconnexion de l'espace chauffeur
export async function afficherDossier(conteneur, { profil, fiche, deconnecter }) {
  etat.conteneur = conteneur;
  etat.profil = profil;
  etat.deconnecter = deconnecter;
  conteneur.hidden = false;
  const [candidature, societe] = await Promise.all([
    supabase.from('candidatures').select('statut, ville, experience, a_carte_vtc, message, motif_refus, cree_le')
      .eq('profil_id', profil.id).maybeSingle(),
    supabase.from('societe').select('telephone, email').maybeSingle()
  ]);
  if (candidature.error) throw candidature.error;
  etat.societe = societe.data || {};

  const situation = situationDu(profil, fiche, candidature.data);
  // Nouveau chauffeur dont l'identité est incomplète (compte créé côté client) :
  // la page de connexion de l'espace chauffeur la fait compléter, puis revient
  if (situation === 'candidature' && (!profil.prenom || !profil.nom || !profil.telephone)) {
    location.replace(`${RACINE}chauffeur/connexion/`);
    return;
  }
  const ecrans = {
    candidature: () => ecranCandidature(),
    en_examen: () => ecranEnExamen(fiche, candidature.data),
    refusee: () => ecranMessage('Candidature non retenue',
      'LOC RÉACTION ne donne pas suite à votre candidature.',
      candidature.data && candidature.data.motif_refus ? `Motif : ${candidature.data.motif_refus}` : null,
      'Pour toute question, contactez LOC RÉACTION.'),
    suspendu: () => ecranMessage('Compte chauffeur suspendu',
      'Vous ne recevez plus de courses pour le moment.',
      null,
      'Contactez LOC RÉACTION pour connaître la raison et la suite.'),
    a_activer: () => ecranMessage('Compte chauffeur à activer',
      'Votre compte est enregistré comme chauffeur, mais votre fiche chauffeur n\'est pas encore créée.',
      null,
      'LOC RÉACTION l\'active depuis l\'administration (Chauffeurs, « Enregistrer un chauffeur ») : vous êtes prévenu dès que c\'est fait.'),
    administrateur: () => ecranMessage('Compte administrateur',
      'Ce compte est celui d\'un administrateur de LOC RÉACTION : il n\'a pas d\'espace chauffeur.',
      null,
      'Ouvrez l\'administration, ou connectez-vous avec le compte du chauffeur.',
      el('a', { classe: 'bouton bouton-principal bouton-large', href: `${RACINE}admin/`, texte: 'Ouvrir l\'administration' })),
    bloque: () => ecranMessage('Compte suspendu',
      'Ce compte est suspendu.',
      null,
      'Contactez LOC RÉACTION.')
  };
  conteneur.replaceChildren(...ecrans[situation]());
  conteneur.dataset.situation = situation;

  // Dossier en cours d'examen : dès que LOC RÉACTION valide le compte, le
  // service s'ouvre (la page se recharge d'elle-même)
  clearInterval(etat.minuteur);
  if (situation === 'en_examen') etat.minuteur = setInterval(verifierValidation, 60000);
}

// Où en est ce compte ?
function situationDu(profil, fiche, candidature) {
  if (profil.statut !== 'actif') return 'bloque';
  if (profil.role === 'admin') return 'administrateur';
  if (!fiche) return profil.role === 'chauffeur' ? 'a_activer' : 'candidature';
  if (fiche.statut === 'refuse' || (candidature && candidature.statut === 'refusee')) return 'refusee';
  if (fiche.statut === 'suspendu') return 'suspendu';
  if (fiche.statut === 'candidat') return 'en_examen';
  return 'a_activer';                         // fiche validée sans le rôle chauffeur
}

async function verifierValidation() {
  const { data } = await supabase.from('chauffeurs').select('statut').eq('id', etat.profil.id).maybeSingle();
  if (data && data.statut !== 'candidat') location.reload();
}

// ---------------------------------------------------------------------------
// Éléments communs : titre, contact, déconnexion
// ---------------------------------------------------------------------------
function entete(titre, sousTitre) {
  return el('header', { classe: 'dossier-entete' },
    el('p', { classe: 'etiquette-nuit', texte: 'Espace chauffeur' }),
    el('h1', { classe: 'vue-titre', id: 'dossier-titre', texte: titre }),
    sousTitre ? el('p', { classe: 'dossier-sous-titre', texte: sousTitre }) : null);
}

function blocContact() {
  const s = etat.societe;
  const liens = [
    s.telephone ? el('a', { classe: 'bouton bouton-secondaire', href: `tel:${s.telephone}`, texte: `Appeler (${telephoneLisible(s.telephone)})` }) : null,
    s.email ? el('a', { classe: 'bouton bouton-secondaire', href: `mailto:${s.email}`, texte: 'Écrire un e-mail' }) : null
  ].filter(Boolean);
  if (!liens.length) return null;
  return el('section', { classe: 'panneau', 'aria-labelledby': 'dossier-contact-titre' },
    el('h2', { id: 'dossier-contact-titre', texte: 'Contacter LOC RÉACTION' }),
    el('div', { classe: 'actions-compte' }, ...liens));
}

function boutonDeconnexion() {
  const bouton = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-large', id: 'dossier-deconnexion', texte: 'Se déconnecter' });
  bouton.addEventListener('click', async () => {
    bouton.disabled = true;
    try {
      await etat.deconnecter();
    } catch (erreur) {
      bouton.disabled = false;
      afficherMessage(messageErreur(erreur), 'erreur');
    }
  });
  return bouton;
}

function ecranMessage(titre, texte, motif, consigne, ...actions) {
  return [
    entete(titre),
    el('section', { classe: 'panneau', 'aria-labelledby': 'dossier-titre' },
      el('p', { classe: 'dossier-texte', texte }),
      motif ? el('p', { classe: 'piece-motif', texte: motif }) : null,
      el('p', { classe: 'aide', texte: consigne }),
      ...actions),
    blocContact(),
    boutonDeconnexion()
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Nouveau chauffeur : la candidature
// ---------------------------------------------------------------------------
function ecranCandidature() {
  const champ = (id, libelle, saisie, aide = null) => el('div', { classe: 'champ' },
    el('label', { for: id, texte: libelle }), saisie,
    aide ? el('p', { classe: 'aide', id: `${id}-aide`, texte: aide }) : null,
    el('p', { classe: 'erreur-champ', id: `${id}-erreur`, hidden: true }));
  const ville = el('input', { id: 'cand-ville', classe: 'saisie', type: 'text', autocomplete: 'address-level2', maxlength: '120' });
  const experience = el('textarea', { id: 'cand-experience', classe: 'saisie', rows: '4', maxlength: '2000' });
  const carteOui = el('input', { type: 'radio', name: 'cand-carte', id: 'cand-carte-oui', value: 'oui' });
  const carteNon = el('input', { type: 'radio', name: 'cand-carte', id: 'cand-carte-non', value: 'non' });
  const carteNumero = el('input', { id: 'cand-carte-numero', classe: 'saisie', type: 'text', maxlength: '60', autocomplete: 'off' });
  const carteDate = el('input', { id: 'cand-carte-date', classe: 'saisie', type: 'date' });
  const permisNumero = el('input', { id: 'cand-permis-numero', classe: 'saisie', type: 'text', maxlength: '60', autocomplete: 'off' });
  const permisDate = el('input', { id: 'cand-permis-date', classe: 'saisie', type: 'date' });
  const message = el('textarea', { id: 'cand-message', classe: 'saisie', rows: '3', maxlength: '2000' });
  const blocCarte = el('div', { classe: 'champs-cote', id: 'cand-bloc-carte', hidden: true },
    champ('cand-carte-numero', 'N° de la carte VTC', carteNumero),
    champ('cand-carte-date', 'Valable jusqu\'au', carteDate));
  const choixCarte = (e) => {
    blocCarte.hidden = e.target.value !== 'oui';
    marquer('cand-carte', null);
  };
  carteOui.addEventListener('change', choixCarte);
  carteNon.addEventListener('change', choixCarte);

  const envoyer = el('button', { type: 'submit', classe: 'bouton bouton-principal bouton-large', id: 'cand-envoyer', texte: 'Envoyer ma candidature' });
  const formulaire = el('form', { classe: 'panneau compte-formulaire', id: 'candidature', novalidate: true, 'aria-labelledby': 'dossier-titre' },
    el('p', { classe: 'dossier-texte', texte: 'Pour conduire pour LOC RÉACTION, il vous faut une carte professionnelle VTC en cours de validité et un permis de conduire. Remplissez votre candidature : vous déposerez ensuite vos documents ici même.' }),
    champ('cand-ville', 'Ville où vous habitez', ville),
    champ('cand-experience', 'Votre expérience de chauffeur', experience, 'Depuis quand vous conduisez des passagers, avec quelles plateformes ou entreprises, quels trajets (aéroports, mise à disposition…).'),
    el('fieldset', { classe: 'champ choix-carte', id: 'cand-carte', 'aria-describedby': 'cand-carte-erreur' },
      el('legend', { texte: 'Avez-vous votre carte professionnelle VTC ?' }),
      el('div', { classe: 'options-carte' },
        el('label', { classe: 'option-carte', for: 'cand-carte-oui' }, carteOui, el('span', { texte: 'Oui' })),
        el('label', { classe: 'option-carte', for: 'cand-carte-non' }, carteNon, el('span', { texte: 'Pas encore' }))),
      el('p', { classe: 'erreur-champ', id: 'cand-carte-erreur', hidden: true })),
    blocCarte,
    el('div', { classe: 'champs-cote' },
      champ('cand-permis-numero', 'N° du permis (facultatif)', permisNumero),
      champ('cand-permis-date', 'Permis valable jusqu\'au (facultatif)', permisDate)),
    champ('cand-message', 'Un mot pour LOC RÉACTION (facultatif)', message),
    envoyer);
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); envoyerCandidature(); });
  // Un champ corrigé perd son message d'erreur
  const corrige = (e) => { if (e.target.id && e.target.getAttribute('aria-invalid') === 'true') marquer(e.target.id, null); };
  formulaire.addEventListener('input', corrige);
  formulaire.addEventListener('change', corrige);

  return [
    entete('Devenir chauffeur LOC RÉACTION', `Bonjour ${etat.profil.prenom || ''}`.trim()),
    formulaire,
    blocContact(),
    boutonDeconnexion()
  ].filter(Boolean);
}

function marquer(id, message) {
  const champ = $(id);
  if (!champ) return;
  champ.setAttribute('aria-invalid', message ? 'true' : 'false');
  const zone = $(`${id}-erreur`);
  if (zone) { zone.hidden = !message; zone.textContent = message || ''; }
}

async function envoyerCandidature() {
  const valeur = (id) => $(id).value.trim();
  const aujourdhui = jourParis();
  const carte = document.querySelector('input[name="cand-carte"]:checked');
  const aCarte = carte ? carte.value === 'oui' : null;
  marquer('cand-ville', valeur('cand-ville') ? null : 'Indiquez votre ville.');
  marquer('cand-experience', valeur('cand-experience').length >= 10 ? null : 'Décrivez votre expérience en quelques mots.');
  marquer('cand-carte', aCarte === null ? 'Répondez à cette question.' : null);
  marquer('cand-carte-numero', aCarte && !valeur('cand-carte-numero') ? 'Indiquez le numéro de votre carte VTC.' : null);
  marquer('cand-carte-date', aCarte && !$('cand-carte-date').value ? 'Indiquez la date de fin de validité.'
    : (aCarte && $('cand-carte-date').value < aujourdhui ? 'Cette carte n\'est plus valable : indiquez la carte en cours de validité.' : null));
  marquer('cand-permis-date', $('cand-permis-date').value && $('cand-permis-date').value < aujourdhui ? 'Ce permis n\'est plus valable.' : null);
  const ordre = ['cand-ville', 'cand-experience', 'cand-carte', 'cand-carte-numero', 'cand-carte-date', 'cand-permis-date'];
  const premier = ordre.find((id) => $(id) && $(id).getAttribute('aria-invalid') === 'true');
  if (premier) {
    const cible = premier === 'cand-carte' ? $('cand-carte-oui') : $(premier);
    cible.focus();
    return;
  }

  const bouton = $('cand-envoyer');
  bouton.disabled = true;
  bouton.textContent = 'Envoi…';
  try {
    const { error } = await supabase.rpc('deposer_candidature', {
      p_ville: valeur('cand-ville'),
      p_experience: valeur('cand-experience'),
      p_a_carte_vtc: aCarte,
      p_message: valeur('cand-message') || null,
      p_carte_vtc_numero: aCarte ? valeur('cand-carte-numero') : null,
      p_carte_vtc_expiration: aCarte ? $('cand-carte-date').value : null,
      p_permis_numero: valeur('cand-permis-numero') || null,
      p_permis_expiration: $('cand-permis-date').value || null
    });
    if (error) throw error;
    afficherMessage('Candidature envoyée : déposez maintenant vos documents.', 'succes');
    const { data: fiche, error: erreurFiche } = await supabase.from('chauffeurs').select('statut').eq('id', etat.profil.id).maybeSingle();
    if (erreurFiche) throw erreurFiche;
    await afficherDossier(etat.conteneur, { profil: etat.profil, fiche, deconnecter: etat.deconnecter });
    window.scrollTo(0, 0);
  } catch (erreur) {
    bouton.disabled = false;
    bouton.textContent = 'Envoyer ma candidature';
    afficherMessage(messageErreur(erreur), 'erreur');
  }
}

// ---------------------------------------------------------------------------
// Candidature envoyée : état du dossier et documents
// ---------------------------------------------------------------------------
function ecranEnExamen(fiche, candidature) {
  const c = candidature || {};
  const listePieces = el('ul', { classe: 'pieces-demandees', id: 'pieces-demandees' });
  // La liste des pièces demandées suit les documents déposés (dernier dépôt
  // de chaque type)
  const majPieces = (deposees) => {
    const dernier = {};
    for (const d of deposees) if (!dernier[d.type]) dernier[d.type] = d;
    listePieces.replaceChildren(...PIECES_DEMANDEES.map((type) => {
      const d = dernier[type];
      const texte = d ? (d.statut === 'refuse' ? 'Refusé : à renvoyer' : STATUTS_DOCUMENT[d.statut]) : 'À déposer';
      return el('li', { classe: 'piece-demandee', dataset: { statut: d ? d.statut : 'a_deposer' } },
        el('span', { classe: 'piece-demandee-nom', texte: TYPES_DOCUMENT_CHAUFFEUR[type] }),
        el('span', { classe: 'etat-piece', dataset: { statut: d ? d.statut : 'neutre' }, texte }));
    }));
  };
  const documents = creerSectionDocuments({ profil: etat.profil }, { apresChargement: majPieces });
  const declare = [
    ['Ville', c.ville || '—'],
    ['Carte professionnelle VTC', c.a_carte_vtc ? 'Oui' : 'Pas encore'],
    ['Envoyée le', c.cree_le ? dateCourte(jourParis(c.cree_le)) : '—']
  ];
  const etatDossier = el('section', { classe: 'panneau', 'aria-labelledby': 'dossier-etat-titre' },
    el('div', { classe: 'piece-entete' },
      el('h2', { id: 'dossier-etat-titre', texte: 'Ma candidature' }),
      el('span', { classe: 'etat-piece', dataset: { statut: 'en_attente' }, texte: STATUTS_CANDIDATURE[c.statut] || 'Reçue' })),
    el('dl', { classe: 'lignes-valeurs empilees' }, ...declare.flatMap(([dt, dd]) => [el('dt', { texte: dt }), el('dd', { texte: dd })])),
    el('p', { classe: 'aide', texte: 'LOC RÉACTION vérifie votre dossier et vos documents, puis valide votre compte. Vous êtes prévenu dans l\'application, et le service s\'ouvre ici : passer en ligne, courses, revenus.' }));

  const pieces = el('section', { classe: 'panneau', 'aria-labelledby': 'pieces-titre' },
    el('h2', { id: 'pieces-titre', texte: 'Documents à fournir' }),
    el('p', { classe: 'aide', texte: 'Déposez chaque pièce avec « Ajouter un document », ci-dessous : une photo nette ou un PDF.' }),
    listePieces);
  // Lecture des documents une fois la section dans la page (ses éléments
  // sont retrouvés par leur identifiant)
  setTimeout(() => documents.charger().catch((erreur) => afficherMessage(messageErreur(erreur), 'erreur')), 0);

  return [
    entete('Mon dossier chauffeur', `Bonjour ${etat.profil.prenom || ''}`.trim()),
    etatDossier,
    pieces,
    documents.section,
    blocContact(),
    boutonDeconnexion()
  ].filter(Boolean);
}
