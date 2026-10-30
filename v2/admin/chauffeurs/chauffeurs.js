// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : chauffeurs
// -----------------------------------------------------------------------------
// Quatre onglets (gardés dans l'adresse : ?onglet=…) :
//   - Chauffeurs : validés et suspendus ; fiche (carte VTC, permis, option
//     chauffeuse), véhicule affecté, suspension et réactivation ;
//   - Candidatures : nouvelles et en cours d'examen (refusées repliées) ;
//     validation avec véhicule et option chauffeuse, refus motivé ;
//   - Documents : pièces déposées à vérifier, validation avec le numéro et la
//     date d'expiration lus sur la pièce (reportés sur la fiche) ;
//   - Activité : courses, chiffre d'affaires, demandes et notes par période.
// Lectures : admin_lister_chauffeurs, admin_activite_chauffeurs. Écritures :
// fonctions serveur (validation, refus, statut, véhicule, documents) ou
// modification directe de la fiche (règles d'accès : administration).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, afficherMessage } from '../../commun/outils.js';
import { ouvrirAdministration, lienAdmin } from '../commun/admin.js';
import {
  badge, dateCourte, dateHeureComplete, echeance, jourParis, ajouterJours, tableau, exporterCsv, nombreCsv,
  boutonExporter, fenetreFormulaire, confirmer, ouvrirFenetre, messageErreurAdmin, nomComplet, ouvrirPiece,
  TYPES_DOCUMENT, STATUTS_DOCUMENT, DOCUMENTS_DATES, lienTelephone, telephoneLisible
} from '../commun/composants.js';

const $ = (id) => document.getElementById(id);
const ONGLETS = [
  { code: 'chauffeurs', libelle: 'Chauffeurs' },
  { code: 'candidatures', libelle: 'Candidatures' },
  { code: 'documents', libelle: 'Documents à vérifier' },
  { code: 'activite', libelle: 'Activité' }
];
const STATUTS_CHAUFFEUR = {
  valide: { libelle: 'Validé', ton: 'vert' }, suspendu: { libelle: 'Suspendu', ton: 'rouge' },
  candidat: { libelle: 'Candidat', ton: 'or' }, refuse: { libelle: 'Refusé', ton: 'gris' }
};
const STATUTS_CANDIDATURE = {
  nouvelle: { libelle: 'Nouvelle', ton: 'or' }, en_cours: { libelle: 'En cours d\'examen', ton: 'bleu' },
  acceptee: { libelle: 'Acceptée', ton: 'vert' }, refusee: { libelle: 'Refusée', ton: 'gris' }
};
const etat = { onglet: 'chauffeurs', chauffeurs: [], vehicules: [], periode: 'mois' };

ouvrirAdministration({ module: 'chauffeurs' }).then(async () => {
  const demande = new URLSearchParams(location.search).get('onglet');
  if (ONGLETS.some((o) => o.code === demande)) etat.onglet = demande;
  $('enregistrer-chauffeur').addEventListener('click', enregistrerChauffeur);
  await charger();
});

async function charger() {
  const [chauffeurs, vehicules] = await Promise.all([
    supabase.rpc('admin_lister_chauffeurs'),
    supabase.from('vehicules').select('id, immatriculation, marque, modele, actif').order('immatriculation')
  ]);
  if (chauffeurs.error) { $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(chauffeurs.error) })); return; }
  etat.chauffeurs = chauffeurs.data || [];
  etat.vehicules = vehicules.data || [];
  afficher();
}

function afficher() {
  const compte = {
    chauffeurs: etat.chauffeurs.filter((c) => ['valide', 'suspendu'].includes(c.statut)).length,
    candidatures: etat.chauffeurs.filter((c) => c.statut === 'candidat').length,
    documents: documentsEnAttente().length
  };
  $('onglets').replaceChildren(...ONGLETS.map((o) => {
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(o.code === etat.onglet) },
      el('span', { texte: o.libelle }), compte[o.code] ? el('span', { classe: 'compte', texte: String(compte[o.code]) }) : null);
    b.addEventListener('click', () => {
      etat.onglet = o.code;
      history.replaceState(null, '', `${location.pathname}?onglet=${o.code}`);
      afficher();
    });
    return b;
  }));
  if (etat.onglet === 'chauffeurs') afficherChauffeurs();
  else if (etat.onglet === 'candidatures') afficherCandidatures();
  else if (etat.onglet === 'documents') afficherDocuments();
  else afficherActivite();
}

function bouton(texte, action, classe = 'bouton-secondaire') {
  const b = el('button', { type: 'button', classe: `bouton ${classe} bouton-petit`, texte });
  b.addEventListener('click', async () => { b.disabled = true; try { await action(); } finally { b.disabled = false; } });
  return b;
}

function contact(c) {
  return el('p', { classe: 'contact' },
    c.telephone ? lienTelephone(c.telephone) : el('span', { classe: 'texte-gris', texte: 'Sans téléphone' }),
    c.email ? el('span', { texte: ' · ' }) : null,
    c.email ? el('a', { href: `mailto:${c.email}`, texte: c.email }) : null);
}

function badgeStatut(table, code) {
  const s = table[code] || { libelle: code, ton: 'gris' };
  return badge(s.libelle, s.ton);
}

// Liste des pièces d'un chauffeur, avec « Voir » (lien signé) et la vérification
function listeDocuments(c) {
  if (!c.documents.length) return el('p', { classe: 'texte-gris', texte: 'Aucune pièce déposée.' });
  return el('ul', { classe: 'documents' }, ...c.documents.map((d) => el('li', {},
    el('div', {},
      el('strong', { texte: TYPES_DOCUMENT[d.type] || d.type }), ' ', badgeStatut(STATUTS_DOCUMENT, d.statut),
      el('span', { classe: 'secondaire', texte: [
        d.numero ? `n° ${d.numero}` : null,
        d.expire_le ? `expire le ${dateCourte(d.expire_le)}` : null,
        `déposée le ${dateCourte(d.cree_le)}`,
        d.commentaire ? `« ${d.commentaire} »` : null
      ].filter(Boolean).join(' · ') })),
    el('div', { classe: 'actions-ligne' },
      bouton('Voir la pièce', () => voirPiece(d)),
      d.statut === 'en_attente' ? bouton('Valider', () => validerDocument(d, c), 'bouton-principal') : null,
      d.statut === 'en_attente' ? bouton('Refuser', () => refuserDocument(d, c), 'bouton-danger') : null))));
}

async function voirPiece(d) {
  try { await ouvrirPiece('documents', d.fichier_chemin); }
  catch (erreur) { afficherMessage(messageErreurAdmin(erreur), 'erreur'); }
}

// #############################################################################
// Onglet « Chauffeurs »
// #############################################################################
function afficherChauffeurs() {
  const liste = etat.chauffeurs.filter((c) => ['valide', 'suspendu'].includes(c.statut));
  $('contenu').replaceChildren(liste.length
    ? el('div', { classe: 'fiches' }, ...liste.map(ficheChauffeur))
    : el('section', { classe: 'carte-admin' }, el('p', { classe: 'vide-admin', texte: 'Aucun chauffeur validé pour le moment. Les candidatures arrivent dans l\'onglet « Candidatures » ; un salarié embauché directement s\'enregistre avec le bouton « Enregistrer un chauffeur ».' })));
}

function ficheChauffeur(c) {
  const acceptation = c.courses_proposees > 0 ? `${Math.round((c.courses_acceptees / c.courses_proposees) * 100)} % d'acceptation` : 'aucune demande reçue';
  return el('section', { classe: 'carte-admin fiche-chauffeur', 'aria-label': nomComplet(c.prenom, c.nom) },
    el('div', { classe: 'carte-entete' },
      el('h2', { texte: nomComplet(c.prenom, c.nom) }),
      badgeStatut(STATUTS_CHAUFFEUR, c.statut),
      c.en_ligne ? badge('En ligne', 'vert') : null,
      c.chauffeuse ? badge('Chauffeuse', 'bleu') : null,
      c.compte_statut === 'bloque' ? badge('Compte bloqué', 'rouge') : null),
    contact(c),
    el('dl', { classe: 'fiche-donnees' },
      el('dt', { texte: 'Véhicule' }), el('dd', {}, c.vehicule || el('span', { classe: 'texte-rouge', texte: 'Aucun véhicule affecté' })),
      el('dt', { texte: 'Carte VTC' }), el('dd', {}, c.carte_vtc_numero ? `n° ${c.carte_vtc_numero} · ` : '', echeance(c.carte_vtc_expiration)),
      el('dt', { texte: 'Permis' }), el('dd', {}, c.permis_numero ? `n° ${c.permis_numero} · ` : '', echeance(c.permis_expiration)),
      el('dt', { texte: 'Contrat' }), el('dd', { texte: c.salarie ? 'Salarié de LOC RÉACTION' : 'Indépendant' }),
      el('dt', { texte: 'Activité' }), el('dd', { texte: `${c.courses_30_jours} course${c.courses_30_jours > 1 ? 's' : ''} sur 30 jours · ${acceptation}` }),
      el('dt', { texte: 'Note' }), el('dd', { texte: c.note_moyenne ? `${nombre(c.note_moyenne, 2)} / 5 (${c.nb_notes} note${c.nb_notes > 1 ? 's' : ''})` : 'Pas encore notée' }),
      el('dt', { texte: 'Validé le' }), el('dd', { texte: c.valide_le ? dateCourte(c.valide_le) : '—' })),
    el('details', { classe: 'pieces' }, el('summary', { texte: `Pièces (${c.documents.length})` }), listeDocuments(c)),
    el('div', { classe: 'actions-ligne' },
      bouton('Modifier la fiche', () => modifierFiche(c)),
      bouton('Changer de véhicule', () => changerVehicule(c)),
      c.statut === 'valide' ? bouton('Suspendre', () => suspendre(c), 'bouton-danger') : bouton('Réactiver', () => reactiver(c), 'bouton-principal'),
      el('a', { classe: 'bouton bouton-texte bouton-petit', href: lienAdmin(`courses/?q=${encodeURIComponent(nomComplet(c.prenom, c.nom))}`), texte: 'Ses courses' })));
}

async function modifierFiche(c) {
  const fait = await fenetreFormulaire({
    titre: `Fiche de ${nomComplet(c.prenom, c.nom)}`,
    intro: 'Ces informations sont reprises sur les feuilles de route et contrôlées au passage en ligne.',
    champs: [
      { nom: 'carte_vtc_numero', libelle: 'N° de carte VTC', type: 'texte', longueur: 40 },
      { nom: 'carte_vtc_expiration', libelle: 'Carte VTC valable jusqu\'au', type: 'date' },
      { nom: 'permis_numero', libelle: 'N° de permis', type: 'texte', longueur: 40 },
      { nom: 'permis_expiration', libelle: 'Permis valable jusqu\'au', type: 'date' },
      { nom: 'chauffeuse', libelle: 'Peut assurer l\'option « chauffeuse pour les clientes »', type: 'case' },
      { nom: 'salarie', libelle: 'Salarié de LOC RÉACTION (décocher pour un indépendant)', type: 'case' }
    ],
    valeurs: c,
    enregistrer: async (v) => {
      const { error } = await supabase.from('chauffeurs').update(v).eq('id', c.id);
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Fiche enregistrée.', 'succes'); await charger(); }
}

function optionsVehicules(actuel) {
  return etat.vehicules.filter((v) => v.actif || v.id === actuel)
    .map((v) => ({ valeur: v.id, libelle: `${v.marque} ${v.modele} · ${v.immatriculation}${v.actif ? '' : ' (désactivé)'}` }));
}

async function changerVehicule(c) {
  if (!etat.vehicules.some((v) => v.actif)) {
    afficherMessage('Aucun véhicule actif : ajoutez d\'abord un véhicule dans le module Flotte.', 'erreur');
    return;
  }
  const fait = await fenetreFormulaire({
    titre: `Véhicule de ${nomComplet(c.prenom, c.nom)}`,
    champs: [{ nom: 'vehicule', libelle: 'Véhicule affecté', type: 'choix', options: optionsVehicules(c.vehicule_id), vide: 'Aucun véhicule', plein: true,
      aide: 'Sans véhicule, le chauffeur ne peut pas passer en ligne.' }],
    valeurs: { vehicule: c.vehicule_id },
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('affecter_vehicule', { p_chauffeur: c.id, p_vehicule: v.vehicule });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Véhicule affecté.', 'succes'); await charger(); }
}

async function suspendre(c) {
  const reponse = await confirmer({
    titre: `Suspendre ${nomComplet(c.prenom, c.nom)} ?`,
    texte: 'Il passe aussitôt hors ligne et ne reçoit plus de courses ; ses réservations à venir reviennent au dispatch. Il est prévenu.',
    libelle: 'Suspendre', danger: true,
    motif: { libelle: 'Motif, transmis au chauffeur', obligatoire: true }
  });
  if (!reponse) return;
  const { error } = await supabase.rpc('admin_statut_chauffeur', { p_chauffeur: c.id, p_statut: 'suspendu', p_motif: reponse.motif });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Chauffeur suspendu.', 'succes');
  await charger();
}

async function reactiver(c) {
  const reponse = await confirmer({
    titre: `Réactiver ${nomComplet(c.prenom, c.nom)} ?`,
    texte: 'Il pourra de nouveau passer en ligne et recevoir des courses. Il est prévenu.', libelle: 'Réactiver'
  });
  if (!reponse) return;
  const { error } = await supabase.rpc('admin_statut_chauffeur', { p_chauffeur: c.id, p_statut: 'valide' });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Chauffeur réactivé.', 'succes');
  await charger();
}

// #############################################################################
// Onglet « Candidatures »
// #############################################################################
function afficherCandidatures() {
  const enCours = etat.chauffeurs.filter((c) => c.statut === 'candidat');
  const refusees = etat.chauffeurs.filter((c) => c.statut === 'refuse');
  $('contenu').replaceChildren(
    enCours.length ? el('div', { classe: 'fiches' }, ...enCours.map(ficheCandidature))
      : el('section', { classe: 'carte-admin' }, el('p', { classe: 'vide-admin', texte: 'Aucune candidature à examiner.' })),
    refusees.length ? el('details', { classe: 'carte-admin refusees' },
      el('summary', { texte: `Candidatures refusées (${refusees.length})` }),
      el('div', { classe: 'fiches' }, ...refusees.map(ficheCandidature))) : '');
}

function ficheCandidature(c) {
  const ca = c.candidature || {};
  const refusee = c.statut === 'refuse';
  return el('section', { classe: 'carte-admin fiche-chauffeur', 'aria-label': `Candidature de ${nomComplet(c.prenom, c.nom)}` },
    el('div', { classe: 'carte-entete' },
      el('h2', { texte: nomComplet(c.prenom, c.nom) }),
      ca.statut ? badgeStatut(STATUTS_CANDIDATURE, ca.statut) : badge('Sans candidature', 'gris')),
    contact(c),
    el('dl', { classe: 'fiche-donnees' },
      el('dt', { texte: 'Déposée le' }), el('dd', { texte: ca.cree_le ? dateHeureComplete(ca.cree_le) : dateCourte(c.cree_le) }),
      el('dt', { texte: 'Ville' }), el('dd', { texte: ca.ville || '—' }),
      el('dt', { texte: 'Carte VTC' }), el('dd', {}, ca.a_carte_vtc ? 'Oui' : 'Non',
        c.carte_vtc_numero ? ` · n° ${c.carte_vtc_numero}` : '', c.carte_vtc_expiration ? ' · ' : '',
        c.carte_vtc_expiration ? echeance(c.carte_vtc_expiration) : ''),
      el('dt', { texte: 'Permis' }), el('dd', {}, c.permis_numero ? `n° ${c.permis_numero}` : '—',
        c.permis_expiration ? ' · ' : '', c.permis_expiration ? echeance(c.permis_expiration) : ''),
      el('dt', { texte: 'Expérience' }), el('dd', { classe: 'texte-long', texte: ca.experience || '—' }),
      ...(ca.message ? [el('dt', { texte: 'Message' }), el('dd', { classe: 'texte-long', texte: ca.message })] : []),
      ...(refusee && ca.motif_refus ? [el('dt', { texte: 'Motif du refus' }), el('dd', { texte: ca.motif_refus })] : [])),
    el('h3', { classe: 'sous-section', texte: 'Pièces déposées' }),
    listeDocuments(c),
    refusee ? null : el('div', { classe: 'actions-ligne' },
      bouton('Valider la candidature', () => validerCandidature(c), 'bouton-principal'),
      ca.statut === 'nouvelle' ? bouton('Marquer « en cours d\'examen »', () => marquerEnCours(c)) : null,
      bouton('Refuser', () => refuserCandidature(c), 'bouton-danger')));
}

async function validerCandidature(c) {
  const enAttente = c.documents.filter((d) => d.statut === 'en_attente').length;
  const fait = await fenetreFormulaire({
    titre: `Valider ${nomComplet(c.prenom, c.nom)}`,
    intro: `Le compte devient « chauffeur » : il pourra passer en ligne dès que sa carte VTC est à jour et qu'un véhicule lui est affecté.${enAttente ? ` Attention : ${enAttente} pièce${enAttente > 1 ? 's' : ''} reste${enAttente > 1 ? 'nt' : ''} à vérifier.` : ''}`,
    champs: [
      { nom: 'vehicule', libelle: 'Véhicule affecté', type: 'choix', options: optionsVehicules(null), vide: 'Aucun pour l\'instant', plein: true },
      { nom: 'chauffeuse', libelle: 'Peut assurer l\'option « chauffeuse pour les clientes »', type: 'case' }
    ],
    valeurs: { chauffeuse: false },
    libelle: 'Valider',
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('valider_candidature', { p_profil: c.id, p_vehicule: v.vehicule, p_chauffeuse: v.chauffeuse });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage(`${nomComplet(c.prenom, c.nom)} est maintenant chauffeur. Il est prévenu.`, 'succes'); etat.onglet = 'chauffeurs'; await charger(); }
}

async function marquerEnCours(c) {
  const { error } = await supabase.from('candidatures').update({ statut: 'en_cours' }).eq('profil_id', c.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  await charger();
}

async function refuserCandidature(c) {
  const reponse = await confirmer({
    titre: `Refuser la candidature de ${nomComplet(c.prenom, c.nom)} ?`,
    texte: 'La personne est prévenue, avec le motif. Son compte client reste actif.',
    libelle: 'Refuser', danger: true,
    motif: { libelle: 'Motif, transmis au candidat', obligatoire: true }
  });
  if (!reponse) return;
  const { error } = await supabase.rpc('refuser_candidature', { p_profil: c.id, p_motif: reponse.motif });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Candidature refusée.', 'succes');
  await charger();
}

// #############################################################################
// Onglet « Documents à vérifier »
// #############################################################################
function documentsEnAttente() {
  return etat.chauffeurs.flatMap((c) => c.documents.filter((d) => d.statut === 'en_attente').map((d) => ({ ...d, chauffeur: c })))
    .sort((a, b) => a.cree_le.localeCompare(b.cree_le));
}

function afficherDocuments() {
  const liste = documentsEnAttente();
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('p', { classe: 'sous-titre', texte: 'Ouvrez la pièce, vérifiez-la, puis validez en recopiant le numéro et la date d\'expiration : ils sont reportés sur la fiche et contrôlés à chaque passage en ligne.' }),
    tableau({
      colonnes: [
        { titre: 'Pièce', valeur: (d) => el('span', {}, el('strong', { texte: TYPES_DOCUMENT[d.type] || d.type }), el('span', { classe: 'secondaire', texte: `déposée le ${dateCourte(d.cree_le)}` })) },
        { titre: 'Chauffeur', valeur: (d) => el('span', {}, nomComplet(d.chauffeur.prenom, d.chauffeur.nom), el('span', { classe: 'secondaire' }, badgeStatut(STATUTS_CHAUFFEUR, d.chauffeur.statut))) },
        { titre: 'Saisi par le chauffeur', valeur: (d) => [d.numero ? `n° ${d.numero}` : null, d.expire_le ? `jusqu'au ${dateCourte(d.expire_le)}` : null].filter(Boolean).join(' · ') || '—' },
        { titre: '', valeur: (d) => el('div', { classe: 'actions-ligne' },
          bouton('Voir la pièce', () => voirPiece(d)),
          bouton('Valider', () => validerDocument(d, d.chauffeur), 'bouton-principal'),
          bouton('Refuser', () => refuserDocument(d, d.chauffeur), 'bouton-danger')) }
      ],
      lignes: liste, vide: 'Aucun document à vérifier.'
    })));
}

async function validerDocument(d, c) {
  const avecDate = DOCUMENTS_DATES.includes(d.type);
  const fait = await fenetreFormulaire({
    titre: `Valider : ${TYPES_DOCUMENT[d.type] || d.type}`,
    intro: `${nomComplet(c.prenom, c.nom)} · recopiez les informations lues sur la pièce.`,
    avant: [el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Voir la pièce', onclick: () => voirPiece(d) })],
    champs: [
      { nom: 'numero', libelle: 'Numéro', type: 'texte', longueur: 60 },
      ...(avecDate ? [{ nom: 'expire_le', libelle: 'Valable jusqu\'au', type: 'date', requis: true, min: jourParis() }] : []),
      { nom: 'commentaire', libelle: 'Commentaire, transmis au chauffeur', type: 'zone', longueur: 500, plein: true }
    ],
    valeurs: { numero: d.numero, expire_le: d.expire_le },
    libelle: 'Valider la pièce',
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('admin_verifier_document', {
        p_document: d.id, p_statut: 'valide', p_commentaire: v.commentaire, p_numero: v.numero, p_expire_le: v.expire_le || null
      });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Pièce validée.', 'succes'); await charger(); }
}

async function refuserDocument(d, c) {
  const reponse = await confirmer({
    titre: `Refuser : ${TYPES_DOCUMENT[d.type] || d.type} ?`,
    texte: `${nomComplet(c.prenom, c.nom)} est prévenu et devra déposer une nouvelle pièce.`,
    libelle: 'Refuser la pièce', danger: true,
    motif: { libelle: 'Motif, transmis au chauffeur (pièce illisible, expirée…)', obligatoire: true }
  });
  if (!reponse) return;
  const { error } = await supabase.rpc('admin_verifier_document', { p_document: d.id, p_statut: 'refuse', p_commentaire: reponse.motif });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Pièce refusée.', 'succes');
  await charger();
}

// #############################################################################
// Onglet « Activité »
// #############################################################################
const PERIODES = [
  { code: 'mois', libelle: 'Ce mois-ci' },
  { code: 'mois_dernier', libelle: 'Mois dernier' },
  { code: '7j', libelle: '7 derniers jours' },
  { code: '30j', libelle: '30 derniers jours' }
];

function bornes(code) {
  const aujourdhui = jourParis();
  const premier = `${aujourdhui.slice(0, 8)}01`;
  if (code === 'mois') return [premier, aujourdhui];
  if (code === 'mois_dernier') {
    const fin = ajouterJours(premier, -1);
    return [`${fin.slice(0, 8)}01`, fin];
  }
  if (code === '7j') return [ajouterJours(aujourdhui, -6), aujourdhui];
  return [ajouterJours(aujourdhui, -29), aujourdhui];
}

const COLONNES_ACTIVITE = [
  { titre: 'Chauffeur', valeur: (a) => el('span', {}, a.nom || 'Sans nom', a.statut === 'suspendu' ? el('span', { classe: 'secondaire' }, badge('Suspendu', 'rouge')) : null), csv: (a) => a.nom },
  { titre: 'Courses', droite: true, valeur: (a) => String(a.courses_terminees), csv: (a) => a.courses_terminees },
  { titre: 'Chiffre d\'affaires TTC', droite: true, valeur: (a) => euros(a.chiffre_affaires), csv: (a) => nombreCsv(a.chiffre_affaires) },
  { titre: 'Pourboires', droite: true, valeur: (a) => euros(a.pourboires), csv: (a) => nombreCsv(a.pourboires) },
  { titre: 'Temps en course', droite: true, valeur: (a) => `${Math.floor(a.minutes_en_course / 60)} h ${String(a.minutes_en_course % 60).padStart(2, '0')}`, csv: (a) => a.minutes_en_course },
  { titre: 'Kilomètres', droite: true, valeur: (a) => nombre(a.kilometres, 0), csv: (a) => nombreCsv(a.kilometres) },
  { titre: 'Demandes', droite: true, valeur: (a) => `${a.demandes_acceptees} / ${a.demandes_recues}`, csv: (a) => a.demandes_recues },
  { titre: 'Acceptation', droite: true, valeur: (a) => (a.demandes_recues ? `${Math.round((a.demandes_acceptees / a.demandes_recues) * 100)} %` : '—'),
    csv: (a) => (a.demandes_recues ? Math.round((a.demandes_acceptees / a.demandes_recues) * 100) : '') },
  { titre: 'Sans réponse', droite: true, valeur: (a) => String(a.demandes_expirees), csv: (a) => a.demandes_expirees },
  { titre: 'Refus', droite: true, valeur: (a) => String(a.demandes_refusees), csv: (a) => a.demandes_refusees },
  { titre: 'Désistements', droite: true, valeur: (a) => String(a.desistements), csv: (a) => a.desistements },
  { titre: 'Note', droite: true, valeur: (a) => (a.note_periode ? `${nombre(a.note_periode, 2)} (${a.notes_periode})` : '—'), csv: (a) => nombreCsv(a.note_periode) }
];

async function afficherActivite() {
  const [debut, fin] = bornes(etat.periode);
  const zone = el('div', {}, el('p', { classe: 'chargement', texte: 'Chargement…' }));
  const choix = el('div', { classe: 'onglets', role: 'group', 'aria-label': 'Période' }, ...PERIODES.map((p) => {
    const b = el('button', { type: 'button', classe: 'onglet', 'aria-pressed': String(p.code === etat.periode), texte: p.libelle });
    if (p.code === etat.periode) b.setAttribute('aria-selected', 'true');
    b.addEventListener('click', () => { etat.periode = p.code; afficherActivite(); });
    return b;
  }));
  const exporter = boutonExporter(() => exporterCsv(`activite-chauffeurs-${debut}-${fin}.csv`, COLONNES_ACTIVITE, etat.activite || []));
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    choix,
    el('div', { classe: 'carte-entete' }, el('h2', { texte: `Du ${dateCourte(debut)} au ${dateCourte(fin)}` }), exporter),
    el('p', { classe: 'sous-titre', texte: 'Courses terminées sur la période (heure de Paris). « Demandes » : acceptées sur reçues, hors réservations prises directement ou attribuées à la main.' }),
    zone));
  const { data, error } = await supabase.rpc('admin_activite_chauffeurs', { p_debut: debut, p_fin: fin });
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.activite = data || [];
  zone.replaceChildren(tableau({ colonnes: COLONNES_ACTIVITE, lignes: etat.activite, vide: 'Aucun chauffeur validé.' }));
}

// #############################################################################
// Enregistrer un chauffeur embauché directement (le compte existe déjà)
// #############################################################################
async function enregistrerChauffeur() {
  const recherche = el('input', { id: 'recherche-compte', classe: 'saisie', type: 'search', placeholder: 'Nom, e-mail ou téléphone', autocomplete: 'off' });
  const resultats = el('div', { classe: 'resultats-comptes', 'aria-live': 'polite' });
  const formulaire = el('form', { classe: 'barre-outils', role: 'search' },
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'recherche-compte', texte: 'Retrouver le compte' }), recherche),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Chercher' }));
  const fenetre = ouvrirFenetre({
    titre: 'Enregistrer un chauffeur', large: true,
    contenu: [
      el('p', { classe: 'sous-titre', texte: 'Pour un salarié embauché directement, sans candidature en ligne. Il crée d\'abord son compte sur le site (connexion par code reçu par e-mail), puis vous le retrouvez ici.' }),
      formulaire, resultats,
      el('div', { classe: 'fenetre-actions' }, el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Fermer', onclick: () => fenetre.fermer() }))
    ]
  });
  recherche.focus();
  formulaire.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { data, error } = await supabase.rpc('admin_rechercher_comptes', { p_texte: recherche.value });
    if (error) { resultats.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
    if (!data.length) { resultats.replaceChildren(el('p', { classe: 'vide-admin', texte: 'Aucun compte trouvé. Vérifiez l\'orthographe, ou demandez à la personne de créer son compte.' })); return; }
    resultats.replaceChildren(el('ul', { classe: 'liste-choix' }, ...data.map((compte) => {
      const deja = ['valide', 'suspendu'].includes(compte.chauffeur_statut);
      const choisir = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Enregistrer comme chauffeur', disabled: deja || compte.statut !== 'actif' });
      choisir.addEventListener('click', async () => {
        fenetre.fermer();
        await validerCandidature({ ...compte, documents: [], cree_le: compte.cree_le });
      });
      return el('li', { classe: 'choix' },
        el('div', { classe: 'choix-identite' }, el('strong', { texte: nomComplet(compte.prenom, compte.nom) }),
          compte.role === 'admin' ? badge('Administrateur', 'bleu') : null,
          deja ? badgeStatut(STATUTS_CHAUFFEUR, compte.chauffeur_statut) : null,
          compte.statut !== 'actif' ? badge('Compte bloqué', 'rouge') : null),
        el('p', { classe: 'choix-details', texte: [compte.email, telephoneLisible(compte.telephone), `inscrit le ${dateCourte(compte.cree_le)}`].filter(Boolean).join(' · ') }),
        el('div', { classe: 'choix-action' }, choisir));
    })));
  });
}
