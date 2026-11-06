// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : onglet Compte
// -----------------------------------------------------------------------------
//   - Profil : prénom, nom, téléphone (modifiables ; transmis au client de
//     chaque course acceptée), e-mail de connexion (lecture seule) ;
//   - Ma fiche chauffeur : statut, contrat, véhicule affecté, carte VTC,
//     permis, note moyenne, taux d'acceptation ; ce qui expire dans les
//     30 jours, ou a expiré, est signalé. Ces informations sont tenues par
//     l'administration (la base refuse toute autre modification) ;
//   - Mes documents : pièces déposées et leur vérification (documents.js) ;
//   - Ma paie : bulletins et contrat de travail (paie.js), et Heures et
//     absences : heures du mois, congés demandés (planning.js), pour un
//     chauffeur salarié de LOC RÉACTION seulement ;
//   - Contacter LOC RÉACTION : téléphone et e-mail de l'entreprise ;
//   - Se déconnecter : hors ligne d'abord (chauffeur.js).
// Une adresse avec ancre (?onglet=compte#compte-documents, lien des
// notifications « Document validé ») amène directement à la section.
// Lectures : profils, chauffeurs, vehicules (véhicule affecté), societe,
// salaries (fiche salarié du chauffeur, s'il en a une).
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { el, afficherMessage, nombre, telephoneInternational } from '../../commun/outils.js';
import { jourParis, ajouterJours, dateCourte } from '../commun/periodes.js';
import { telephoneLisible } from '../commun/feuille-route.js';
import { creerSectionDocuments } from './documents.js';
import { creerSectionPaie } from './paie.js';
import { creerSectionPlanning } from './planning.js';

const STATUTS_FICHE = { candidat: 'Candidature en cours', valide: 'Validée', suspendu: 'Suspendue', refuse: 'Refusée' };
const ENERGIES = { hybride: 'hybride', electrique: 'électrique', essence: 'essence', diesel: 'diesel', autre: '' };
const etat = { contexte: null, sections: null };
const $ = (id) => document.getElementById(id);

export async function afficher(conteneur, contexte) {
  etat.contexte = contexte;
  if (!conteneur.dataset.pret) {
    construire(conteneur);
    conteneur.dataset.pret = 'oui';
  }
  fermerFormulaire();
  etat.sections.documents.fermer();
  etat.sections.planning.fermer();
  await charger();
  allerALaSection(conteneur);
}

// Ancre de l'adresse (#compte-documents…) : la section, sous la barre du haut
function allerALaSection(conteneur) {
  const id = decodeURIComponent(location.hash.slice(1));
  const cible = id ? document.getElementById(id) : null;
  if (cible && conteneur.contains(cible) && !cible.hidden) cible.scrollIntoView({ block: 'start' });
}

// ---------------------------------------------------------------------------
// Structure de l'onglet (une seule fois)
// ---------------------------------------------------------------------------
function construire(conteneur) {
  const champ = (id, libelle, attributs = {}) => el('div', { classe: 'champ' },
    el('label', { for: id, texte: libelle }),
    el('input', { id, classe: 'saisie', type: 'text', ...attributs }),
    el('p', { classe: 'erreur-champ', id: `${id}-erreur`, hidden: true }));

  const formulaire = el('form', { classe: 'compte-formulaire', id: 'compte-formulaire', novalidate: true, hidden: true },
    champ('compte-prenom', 'Prénom', { autocomplete: 'given-name', maxlength: '80', required: true }),
    champ('compte-nom', 'Nom', { autocomplete: 'family-name', maxlength: '80', required: true }),
    champ('compte-telephone', 'Téléphone mobile', { type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: '20', required: true }),
    el('div', { classe: 'actions-compte' },
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'compte-annuler', texte: 'Annuler', onclick: fermerFormulaire }),
      el('button', { type: 'submit', classe: 'bouton bouton-principal', id: 'compte-enregistrer', texte: 'Enregistrer' })));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); enregistrer(); });
  // Un champ corrigé perd son message d'erreur
  formulaire.addEventListener('input', (e) => { if (e.target.getAttribute('aria-invalid') === 'true') marquer(e.target.id, null); });

  const modifier = el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'compte-modifier', texte: 'Modifier' });
  modifier.addEventListener('click', ouvrirFormulaire);

  const deconnexion = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-large', id: 'compte-deconnexion', texte: 'Se déconnecter' });
  deconnexion.addEventListener('click', async () => {
    deconnexion.disabled = true;
    try {
      await etat.contexte.deconnecter();
    } catch (erreur) {
      deconnexion.disabled = false;
      afficherMessage(messageErreur(erreur), 'erreur');
    }
  });

  etat.sections = {
    documents: creerSectionDocuments(etat.contexte),
    paie: creerSectionPaie(),
    planning: creerSectionPlanning()
  };

  conteneur.replaceChildren(
    el('h1', { classe: 'vue-titre', id: 'titre-compte', texte: 'Compte' }),
    el('section', { classe: 'panneau', 'aria-labelledby': 'compte-titre-profil' },
      el('div', { classe: 'entete-panneau' }, el('h2', { id: 'compte-titre-profil', texte: 'Profil' }), modifier),
      el('dl', { classe: 'lignes-valeurs empilees', id: 'compte-profil' }),
      formulaire,
      el('p', { classe: 'aide', texte: 'Votre prénom et votre téléphone sont transmis au client de chaque course que vous acceptez.' })),
    el('section', { classe: 'panneau', 'aria-labelledby': 'compte-titre-fiche' },
      el('h2', { id: 'compte-titre-fiche', texte: 'Ma fiche chauffeur' }),
      el('div', { id: 'compte-alertes', classe: 'compte-alertes' }),
      el('dl', { classe: 'lignes-valeurs empilees', id: 'compte-fiche' }),
      el('p', { classe: 'aide', texte: 'Ces informations sont tenues par LOC RÉACTION. Pour les corriger, contactez-nous.' })),
    etat.sections.documents.section,
    etat.sections.paie.section,
    etat.sections.planning.section,
    el('section', { classe: 'panneau', id: 'compte-bloc-contact', 'aria-labelledby': 'compte-titre-contact', hidden: true },
      el('h2', { id: 'compte-titre-contact', texte: 'Contacter LOC RÉACTION' }),
      el('div', { classe: 'actions-compte', id: 'compte-contact' })),
    deconnexion,
    el('p', { classe: 'aide', id: 'compte-aide-deconnexion' }));
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------
async function charger() {
  const moi = etat.contexte.profil.id;
  const [profil, fiche, societe, salarie] = await Promise.all([
    supabase.from('profils').select('prenom, nom, telephone, email').eq('id', moi).maybeSingle(),
    supabase.from('chauffeurs').select('statut, salarie, chauffeuse, vehicule_id, carte_vtc_numero, carte_vtc_expiration, '
      + 'permis_numero, permis_expiration, note_moyenne, nb_notes, courses_proposees, courses_acceptees').eq('id', moi).maybeSingle(),
    supabase.from('societe').select('raison_sociale, telephone, email').maybeSingle(),
    supabase.from('salaries').select('id').eq('profil_id', moi).maybeSingle()
  ]);
  for (const r of [profil, fiche, societe, salarie]) if (r.error) throw r.error;
  let vehicule = null;
  if (fiche.data && fiche.data.vehicule_id) {
    const lecture = await supabase.from('vehicules').select('marque, modele, couleur, energie, immatriculation, '
      + 'assurance_expiration, controle_technique_expiration, vignette_vtc_expiration').eq('id', fiche.data.vehicule_id).maybeSingle();
    if (lecture.error) throw lecture.error;
    vehicule = lecture.data;
  }
  etat.profil = profil.data;
  afficherProfil();
  afficherFiche(fiche.data, vehicule);
  afficherContact(societe.data);
  $('compte-aide-deconnexion').textContent = etat.contexte.enLigne
    ? 'Vous êtes en ligne : la déconnexion vous passe d\'abord hors ligne.'
    : 'Sur ce téléphone, vous devrez ensuite vous reconnecter avec le code reçu par e-mail.';

  // Documents, paie, heures et absences : une section qui ne se lit pas
  // n'empêche pas le reste de l'onglet de s'afficher
  const { documents, paie, planning } = etat.sections;
  await Promise.all([documents.charger(), paie.charger(salarie.data), planning.charger(salarie.data)]
    .map((lecture) => lecture.catch((erreur) => afficherMessage(messageErreur(erreur), 'erreur'))));
}

function lignes(dl, liste) {
  dl.replaceChildren(...liste.filter(Boolean).flatMap(([dt, dd]) => [el('dt', { texte: dt }), el('dd', { texte: dd })]));
}

function afficherProfil() {
  const p = etat.profil || {};
  lignes($('compte-profil'), [
    ['Prénom', p.prenom || '—'],
    ['Nom', p.nom || '—'],
    ['Téléphone', telephoneLisible(p.telephone) || '—'],
    ['E-mail de connexion', p.email || '—']
  ]);
}

// Échéance d'un document : « 12/05/2027 », suivie de « (dépassée) » ou de
// « (dans 12 jours) » quand elle tombe dans les 30 jours
function echeance(jour) {
  if (!jour) return { texte: 'Date non renseignée', date: null, alerte: null };
  const aujourdhui = jourParis();
  const jours = Math.round((Date.parse(`${jour}T12:00:00Z`) - Date.parse(`${aujourdhui}T12:00:00Z`)) / 86400000);
  if (jour < aujourdhui) return { texte: `${dateCourte(jour)} (dépassée)`, date: dateCourte(jour), alerte: 'expiree' };
  if (jour <= ajouterJours(aujourdhui, 30)) {
    const delai = jours === 0 ? 'aujourd\'hui' : `dans ${jours} jour${jours > 1 ? 's' : ''}`;
    return { texte: `${dateCourte(jour)} (${delai})`, date: dateCourte(jour), alerte: 'proche' };
  }
  return { texte: dateCourte(jour), date: dateCourte(jour), alerte: null };
}

function afficherFiche(f, v) {
  if (!f) { lignes($('compte-fiche'), [['Statut', 'Aucune fiche chauffeur']]); return; }
  const carte = echeance(f.carte_vtc_expiration);
  const permis = echeance(f.permis_expiration);
  const vehicule = v ? {
    assurance: echeance(v.assurance_expiration), controle: echeance(v.controle_technique_expiration), vignette: echeance(v.vignette_vtc_expiration)
  } : null;

  lignes($('compte-fiche'), [
    ['Statut', STATUTS_FICHE[f.statut] || f.statut],
    ['Contrat', f.salarie ? 'Contrat de travail avec LOC RÉACTION' : 'Activité indépendante'],
    f.chauffeuse ? ['Option', 'Chauffeuse pour clientes'] : null,
    ['Véhicule', v ? [v.marque, v.modele, ENERGIES[v.energie] || null, v.couleur].filter(Boolean).join(' ') : 'Aucun véhicule affecté'],
    v ? ['Immatriculation', v.immatriculation] : null,
    v ? ['Assurance valable jusqu\'au', vehicule.assurance.texte] : null,
    v ? ['Contrôle technique jusqu\'au', vehicule.controle.texte] : null,
    v ? ['Vignette VTC jusqu\'au', vehicule.vignette.texte] : null,
    ['Carte VTC', f.carte_vtc_numero ? `n° ${f.carte_vtc_numero}` : 'Numéro non renseigné'],
    ['Carte VTC valable jusqu\'au', carte.texte],
    ['Permis de conduire', f.permis_numero ? `n° ${f.permis_numero}` : 'Numéro non renseigné'],
    ['Permis valable jusqu\'au', permis.texte],
    ['Note moyenne', f.note_moyenne !== null ? `${nombre(f.note_moyenne, 2)} / 5 (${f.nb_notes} note${f.nb_notes > 1 ? 's' : ''})` : 'Pas encore de note'],
    ['Taux d\'acceptation', f.courses_proposees > 0 ? `${Math.round((f.courses_acceptees / f.courses_proposees) * 100)} % (${f.courses_acceptees} sur ${f.courses_proposees})` : '—']
  ]);

  // Ce qui empêche de passer en ligne, ou l'empêchera bientôt.
  // « feminin » accorde la phrase : la carte… expirée, le permis… expiré.
  const alertes = [];
  const signaler = (libelle, e, feminin) => {
    const pronom = feminin ? 'la' : 'le';
    if (e.alerte === 'expiree') {
      alertes.push({ niveau: 'expiree', texte: `${libelle} ${feminin ? 'expirée' : 'expiré'} depuis le ${e.date} : renouvelez-${pronom} et envoyez-en une copie à LOC RÉACTION.` });
    } else if (e.alerte === 'proche') {
      alertes.push({ niveau: 'proche', texte: `${libelle} valable jusqu'au ${e.date} : pensez à ${pronom} renouveler.` });
    }
  };
  if (!f.carte_vtc_expiration) alertes.push({ niveau: 'expiree', texte: 'Validité de la carte VTC non renseignée : sans elle, vous ne pouvez pas passer en ligne.' });
  signaler('Carte VTC', carte, true);
  signaler('Permis de conduire', permis, false);
  if (!v) alertes.push({ niveau: 'expiree', texte: 'Aucun véhicule affecté : sans véhicule, vous ne pouvez pas passer en ligne.' });
  else {
    signaler('Assurance du véhicule', vehicule.assurance, true);
    signaler('Contrôle technique du véhicule', vehicule.controle, false);
    signaler('Vignette VTC du véhicule', vehicule.vignette, true);
  }
  $('compte-alertes').replaceChildren(...alertes.map((a) => el('p', { classe: a.niveau === 'expiree' ? 'alerte' : 'alerte alerte-attention', role: 'status', texte: a.texte })));
}

function afficherContact(s) {
  if (!s || (!s.telephone && !s.email)) { $('compte-bloc-contact').hidden = true; return; }
  $('compte-bloc-contact').hidden = false;
  $('compte-contact').replaceChildren(...[
    s.telephone ? el('a', { classe: 'bouton bouton-secondaire', href: `tel:${s.telephone}`, texte: `Appeler (${telephoneLisible(s.telephone)})` }) : null,
    s.email ? el('a', { classe: 'bouton bouton-secondaire', href: `mailto:${s.email}`, texte: 'Écrire un e-mail' }) : null
  ].filter(Boolean));
}

// ---------------------------------------------------------------------------
// Modification du profil
// ---------------------------------------------------------------------------
function ouvrirFormulaire() {
  const p = etat.profil || {};
  $('compte-prenom').value = p.prenom || '';
  $('compte-nom').value = p.nom || '';
  $('compte-telephone').value = telephoneLisible(p.telephone);
  ['compte-prenom', 'compte-nom', 'compte-telephone'].forEach((id) => marquer(id, null));
  $('compte-profil').hidden = true;
  $('compte-modifier').hidden = true;
  $('compte-formulaire').hidden = false;
  $('compte-prenom').focus();
}

function fermerFormulaire() {
  if (!$('compte-formulaire')) return;
  $('compte-formulaire').hidden = true;
  $('compte-profil').hidden = false;
  $('compte-modifier').hidden = false;
}

function marquer(id, message) {
  $(id).setAttribute('aria-invalid', message ? 'true' : 'false');
  $(`${id}-erreur`).hidden = !message;
  $(`${id}-erreur`).textContent = message || '';
}

async function enregistrer() {
  const prenom = $('compte-prenom').value.trim();
  const nom = $('compte-nom').value.trim();
  const telephone = telephoneInternational($('compte-telephone').value);
  marquer('compte-prenom', prenom ? null : 'Saisissez votre prénom.');
  marquer('compte-nom', nom ? null : 'Saisissez votre nom.');
  marquer('compte-telephone', telephone ? null : 'Numéro invalide : saisissez par exemple 06 12 34 56 78.');
  const premier = ['compte-prenom', 'compte-nom', 'compte-telephone'].find((id) => $(id).getAttribute('aria-invalid') === 'true');
  if (premier) { $(premier).focus(); return; }

  const bouton = $('compte-enregistrer');
  bouton.disabled = true;
  const { error } = await supabase.from('profils').update({ prenom, nom, telephone }).eq('id', etat.contexte.profil.id);
  bouton.disabled = false;
  if (error) { afficherMessage(messageErreur(error), 'erreur'); return; }
  etat.profil = { ...etat.profil, prenom, nom, telephone };
  etat.contexte.majProfil({ prenom, nom, telephone });
  afficherProfil();
  fermerFormulaire();
  afficherMessage('Profil enregistré.', 'succes');
}
