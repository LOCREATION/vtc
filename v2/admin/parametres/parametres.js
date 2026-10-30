// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : paramètres
// -----------------------------------------------------------------------------
// Quatre onglets (gardés dans l'adresse : ?onglet=…) :
//   - Entreprise : identité légale saisie une seule fois, reprise sur les
//     feuilles de route, factures, bulletins et pages légales ; les mentions
//     manquantes sont signalées ;
//   - Administrateurs : qui a les droits ; nommer ou retirer un
//     administrateur (fonction serveur admin_definir_role, journalisée ; le
//     dernier administrateur ne peut pas se retirer) ;
//   - Mon compte : changer de mot de passe, changer de téléphone pour la
//     double authentification ;
//   - Journal : qui a modifié quoi, et quand (journal_lister), par table,
//     avec les valeurs avant et après ; export CSV.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import { ouvrirAdministration } from '../commun/admin.js';
import {
  badge, dateCourte, heure, dateHeureComplete, jourParis, tableau, exporterCsv, boutonExporter, fenetreFormulaire,
  confirmer, ouvrirFenetre, messageErreurAdmin, nomComplet, telephoneLisible
} from '../commun/composants.js';

const $ = (id) => document.getElementById(id);
const ONGLETS = [
  { code: 'entreprise', libelle: 'Entreprise' },
  { code: 'administrateurs', libelle: 'Administrateurs' },
  { code: 'compte', libelle: 'Mon compte' },
  { code: 'journal', libelle: 'Journal des modifications' }
];
const etat = { onglet: 'entreprise', profil: null, societe: null, journal: [], tableJournal: '', finJournal: false };

ouvrirAdministration({ module: 'parametres' }).then(async (profil) => {
  etat.profil = profil;
  const demande = new URLSearchParams(location.search).get('onglet');
  if (ONGLETS.some((o) => o.code === demande)) etat.onglet = demande;
  afficher();
});

function afficher() {
  $('onglets').replaceChildren(...ONGLETS.map((o) => {
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(o.code === etat.onglet), texte: o.libelle });
    b.addEventListener('click', () => {
      etat.onglet = o.code;
      history.replaceState(null, '', `${location.pathname}?onglet=${o.code}`);
      afficher();
    });
    return b;
  }));
  $('contenu').replaceChildren(el('p', { classe: 'chargement', texte: 'Chargement…' }));
  ({ entreprise: afficherEntreprise, administrateurs: afficherAdministrateurs, compte: afficherCompte, journal: afficherJournal })[etat.onglet]();
}

function bouton(texte, action, classe = 'bouton-secondaire') {
  const b = el('button', { type: 'button', classe: `bouton ${classe} bouton-petit`, texte });
  b.addEventListener('click', async () => { b.disabled = true; try { await action(); } finally { b.disabled = false; } });
  return b;
}

// #############################################################################
// Onglet « Entreprise »
// #############################################################################
const GROUPES_SOCIETE = [
  { titre: 'Identité légale', champs: [
    { nom: 'raison_sociale', libelle: 'Raison sociale', type: 'texte', requis: true, longueur: 120, plein: true,
      aide: 'Exactement comme sur le Kbis : reprise sur tous les documents.' },
    { nom: 'forme_juridique', libelle: 'Forme juridique', type: 'texte', longueur: 80 },
    { nom: 'capital', libelle: 'Capital (€)', type: 'nombre', min: 0, pas: '0.01', format: (v) => `${new Intl.NumberFormat('fr-FR').format(v)} €` },
    { nom: 'siren', libelle: 'SIREN', type: 'texte', longueur: 9, motif: /^[0-9]{9}$/, messageMotif: '9 chiffres, sans espace.' },
    { nom: 'siret', libelle: 'SIRET du siège', type: 'texte', longueur: 14, motif: /^[0-9]{14}$/, messageMotif: '14 chiffres, sans espace.',
      aide: 'Obligatoire sur les factures et les bulletins de paie.' },
    { nom: 'rcs', libelle: 'RCS', type: 'texte', longueur: 80 },
    { nom: 'code_ape', libelle: 'Code APE (NAF)', type: 'texte', longueur: 6, majuscules: true, motif: /^[0-9]{2}\.?[0-9]{2}[A-Z]$/,
      messageMotif: 'Format : 4932Z ou 49.32Z.' },
    { nom: 'tva_intracommunautaire', libelle: 'N° de TVA intracommunautaire', type: 'texte', longueur: 20, majuscules: true,
      motif: /^FR[0-9A-Z]{2}[0-9]{9}$/, messageMotif: 'Format : FR suivi de 11 caractères (ex. FR12100052570).' },
    { nom: 'numero_urssaf', libelle: 'N° URSSAF', type: 'texte', longueur: 30, aide: 'Repris sur les bulletins de paie.' },
    { nom: 'registre_vtc_numero', libelle: 'N° d\'inscription au registre des exploitants VTC', type: 'texte', longueur: 40,
      aide: 'Obligatoire sur chaque feuille de route.' }
  ] },
  { titre: 'Siège', champs: [
    { nom: 'adresse', libelle: 'Adresse', type: 'texte', longueur: 200, plein: true },
    { nom: 'code_postal', libelle: 'Code postal', type: 'texte', longueur: 10 },
    { nom: 'ville', libelle: 'Ville', type: 'texte', longueur: 80 },
    { nom: 'pays', libelle: 'Pays', type: 'texte', requis: true, longueur: 60 }
  ] },
  { titre: 'Représentant légal', champs: [
    { nom: 'representant_nom', libelle: 'Nom', type: 'texte', longueur: 120 },
    { nom: 'representant_qualite', libelle: 'Qualité', type: 'texte', longueur: 80 }
  ] },
  { titre: 'Contact', champs: [
    { nom: 'telephone', libelle: 'Téléphone', type: 'tel', longueur: 30 },
    { nom: 'whatsapp', libelle: 'WhatsApp', type: 'tel', longueur: 30 },
    { nom: 'email', libelle: 'E-mail', type: 'email', longueur: 120 },
    { nom: 'site_web', libelle: 'Site internet', type: 'texte', longueur: 120 }
  ] },
  { titre: 'Factures', champs: [
    { nom: 'mentions_factures', libelle: 'Mentions en pied de facture', type: 'zone', longueur: 1000, plein: true,
      aide: 'Ex. conditions de paiement, pénalités de retard, indemnité forfaitaire de recouvrement.' }
  ] }
];

async function afficherEntreprise() {
  const { data, error } = await supabase.from('societe').select('*').maybeSingle();
  if (error || !data) { $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error || new Error('Identité introuvable.')) })); return; }
  etat.societe = data;
  const manquants = GROUPES_SOCIETE.flatMap((g) => g.champs).filter((c) => ['siret', 'code_ape', 'tva_intracommunautaire', 'numero_urssaf', 'registre_vtc_numero'].includes(c.nom) && !data[c.nom]);
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('div', { classe: 'carte-entete' }, el('h2', { texte: data.raison_sociale }), bouton('Modifier', modifierEntreprise, 'bouton-principal')),
    el('p', { classe: 'sous-titre', texte: 'Saisie une seule fois, reprise partout : feuilles de route, factures, bulletins de paie, contrats et pages légales.' }),
    manquants.length ? el('p', { classe: 'alerte', texte: `À compléter : ${manquants.map((c) => c.libelle).join(', ')}.` }) : null,
    el('div', { classe: 'grille-2' }, ...GROUPES_SOCIETE.map((g) => el('div', {},
      el('h3', { classe: 'sous-section', texte: g.titre }),
      el('dl', { classe: 'fiche-donnees' }, ...g.champs.flatMap((c) => [
        el('dt', { texte: c.libelle }),
        el('dd', {}, data[c.nom] === null || data[c.nom] === '' || data[c.nom] === undefined
          ? el('span', { classe: 'texte-or', texte: 'À compléter' })
          : c.format ? c.format(data[c.nom]) : String(data[c.nom]))
      ])))))));
}

async function modifierEntreprise() {
  const champs = GROUPES_SOCIETE.flatMap((g) => g.champs.map(({ format, ...c }) => c));
  const fait = await fenetreFormulaire({
    titre: 'Identité de l\'entreprise', large: true, champs, valeurs: etat.societe,
    intro: 'Vérifiez sur le Kbis et les courriers officiels. Chaque changement est inscrit au journal.',
    enregistrer: async (v) => {
      if (v.siren && v.siret && !v.siret.startsWith(v.siren)) throw new Error('Le SIRET doit commencer par les 9 chiffres du SIREN.');
      const ligne = { ...v, code_ape: v.code_ape ? v.code_ape.replace('.', '') : null };
      const { error } = await supabase.from('societe').update(ligne).eq('id', 1);
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Identité de l\'entreprise enregistrée.', 'succes'); afficherEntreprise(); }
}

// #############################################################################
// Onglet « Administrateurs »
// #############################################################################
async function afficherAdministrateurs() {
  const { data, error } = await supabase.from('profils').select('id, prenom, nom, email, telephone, statut, cree_le').eq('role', 'admin').order('prenom');
  if (error) { $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('div', { classe: 'carte-entete' }, el('h2', { texte: 'Administrateurs' }), bouton('Nommer un administrateur', nommerAdministrateur, 'bouton-principal')),
    el('p', { classe: 'sous-titre', texte: 'Un administrateur a accès à tout le bureau de l\'entreprise. À sa première entrée, il choisit un mot de passe et active la double authentification sur son téléphone.' }),
    tableau({
      colonnes: [
        { titre: 'Nom', valeur: (p) => el('span', {}, nomComplet(p.prenom, p.nom), p.id === etat.profil.id ? el('span', { classe: 'secondaire' }, badge('Vous', 'bleu')) : null) },
        { titre: 'E-mail', valeur: (p) => p.email || '—' },
        { titre: 'Téléphone', valeur: (p) => telephoneLisible(p.telephone) || '—' },
        { titre: 'Compte', valeur: (p) => (p.statut === 'actif' ? badge('Actif', 'vert') : badge('Bloqué', 'rouge')) },
        { titre: '', valeur: (p) => (p.id === etat.profil.id ? '' : bouton('Retirer le rôle', () => retirerAdministrateur(p), 'bouton-danger')) }
      ],
      lignes: data
    })));
}

async function nommerAdministrateur() {
  const recherche = el('input', { id: 'recherche-admin', classe: 'saisie', type: 'search', placeholder: 'Nom, e-mail ou téléphone', autocomplete: 'off' });
  const resultats = el('div', { classe: 'resultats-comptes', 'aria-live': 'polite' });
  const formulaire = el('form', { classe: 'barre-outils', role: 'search' },
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'recherche-admin', texte: 'Retrouver le compte' }), recherche),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Chercher' }));
  const fenetre = ouvrirFenetre({
    titre: 'Nommer un administrateur', large: true,
    contenu: [
      el('p', { classe: 'sous-titre', texte: 'La personne crée d\'abord son compte sur le site (connexion par code reçu par e-mail), puis vous la retrouvez ici.' }),
      formulaire, resultats,
      el('div', { classe: 'fenetre-actions' }, el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Fermer', onclick: () => fenetre.fermer() }))
    ]
  });
  recherche.focus();
  formulaire.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { data, error } = await supabase.rpc('admin_rechercher_comptes', { p_texte: recherche.value });
    if (error) { resultats.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
    if (!data.length) { resultats.replaceChildren(el('p', { classe: 'vide-admin', texte: 'Aucun compte trouvé.' })); return; }
    resultats.replaceChildren(el('ul', { classe: 'liste-choix' }, ...data.map((compte) => {
      const choisir = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Nommer administrateur',
        disabled: compte.role === 'admin' || compte.statut !== 'actif' || compte.role === 'chauffeur' });
      choisir.addEventListener('click', async () => {
        const ok = await confirmer({
          titre: `Nommer ${nomComplet(compte.prenom, compte.nom)} administrateur ?`,
          texte: 'Cette personne aura accès à toute l\'administration : courses, chauffeurs, tarifs, finances, paramètres.',
          libelle: 'Nommer'
        });
        if (!ok) return;
        const { error: erreur } = await supabase.rpc('admin_definir_role', { p_profil: compte.id, p_role: 'admin' });
        if (erreur) { afficherMessage(messageErreurAdmin(erreur), 'erreur'); return; }
        fenetre.fermer();
        afficherMessage(`${nomComplet(compte.prenom, compte.nom)} est administrateur.`, 'succes');
        afficherAdministrateurs();
      });
      return el('li', { classe: 'choix' },
        el('div', { classe: 'choix-identite' }, el('strong', { texte: nomComplet(compte.prenom, compte.nom) }),
          compte.role === 'admin' ? badge('Déjà administrateur', 'bleu') : null,
          compte.role === 'chauffeur' ? badge('Chauffeur', 'gris') : null,
          compte.statut !== 'actif' ? badge('Compte bloqué', 'rouge') : null),
        el('p', { classe: 'choix-details', texte: [compte.email, telephoneLisible(compte.telephone)].filter(Boolean).join(' · ') }),
        compte.role === 'chauffeur' ? el('p', { classe: 'texte-gris', texte: 'Un chauffeur garde son compte de chauffeur : utilisez un autre compte pour l\'administration.' }) : null,
        el('div', { classe: 'choix-action' }, choisir));
    })));
  });
}

async function retirerAdministrateur(p) {
  const ok = await confirmer({
    titre: `Retirer le rôle d'administrateur à ${nomComplet(p.prenom, p.nom)} ?`,
    texte: 'Son compte redevient un compte client ; il perd aussitôt l\'accès à l\'administration.', libelle: 'Retirer le rôle', danger: true
  });
  if (!ok) return;
  const { error } = await supabase.rpc('admin_definir_role', { p_profil: p.id, p_role: 'client' });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Rôle retiré.', 'succes');
  afficherAdministrateurs();
}

// #############################################################################
// Onglet « Mon compte »
// #############################################################################
async function afficherCompte() {
  const { data: facteurs } = await supabase.auth.mfa.listFactors();
  const application = ((facteurs && facteurs.totp) || [])[0];
  const p = etat.profil;
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('h2', { texte: nomComplet(p.prenom, p.nom) }),
    el('dl', { classe: 'fiche-donnees' },
      el('dt', { texte: 'E-mail de connexion' }), el('dd', { texte: p.email || '—' }),
      el('dt', { texte: 'Téléphone' }), el('dd', { texte: telephoneLisible(p.telephone) || '—' }),
      el('dt', { texte: 'Double authentification' }), el('dd', {},
        application ? badge('Activée', 'vert') : badge('Non activée', 'rouge'),
        application ? ` depuis le ${dateCourte(application.created_at)}` : '')),
    el('div', { classe: 'actions-ligne' },
      bouton('Changer mon mot de passe', changerMotDePasse, 'bouton-principal'),
      application ? bouton('Changer de téléphone (double authentification)', () => changerTelephone(application)) : null)));
}

async function changerMotDePasse() {
  let nonceDemande = false;
  const fait = await fenetreFormulaire({
    titre: 'Changer mon mot de passe',
    champs: [
      { nom: 'mdp', libelle: 'Nouveau mot de passe', type: 'texte', requis: true, longueur: 72, plein: true, aide: 'Au moins 10 caractères, avec des lettres et des chiffres.' },
      { nom: 'confirmation', libelle: 'Confirmez le mot de passe', type: 'texte', requis: true, longueur: 72, plein: true },
      { nom: 'nonce', libelle: 'Code de confirmation reçu par e-mail (si demandé)', type: 'texte', longueur: 10, plein: true }
    ],
    preparer: (champs) => {
      champs.mdp.saisie.type = 'password';
      champs.mdp.saisie.autocomplete = 'new-password';
      champs.confirmation.saisie.type = 'password';
      champs.confirmation.saisie.autocomplete = 'new-password';
      champs.nonce.saisie.inputMode = 'numeric';
      champs.nonce.saisie.closest('.champ').hidden = true;
      etat.champNonce = champs.nonce.saisie;
    },
    enregistrer: async (v) => {
      if (!(v.mdp.length >= 10 && /[a-z]/i.test(v.mdp) && /\d/.test(v.mdp))) throw new Error('Le mot de passe doit faire au moins 10 caractères et contenir des lettres et des chiffres.');
      if (v.mdp !== v.confirmation) throw new Error('Les deux mots de passe ne sont pas identiques.');
      const attributs = { password: v.mdp };
      if (nonceDemande) attributs.nonce = (v.nonce || '').trim();
      const { error } = await supabase.auth.updateUser(attributs);
      if (error && !nonceDemande && (error.code === 'reauthentication_needed' || /reauthenticat/i.test(error.message || ''))) {
        const envoi = await supabase.auth.reauthenticate();
        if (envoi.error) throw envoi.error;
        nonceDemande = true;
        etat.champNonce.closest('.champ').hidden = false;
        etat.champNonce.focus();
        throw new Error('Par sécurité, un code vient de vous être envoyé par e-mail : saisissez-le, puis enregistrez de nouveau.');
      }
      if (error && (error.code === 'same_password' || /should be different/i.test(error.message || ''))) throw new Error('C\'est déjà votre mot de passe actuel.');
      if (error) throw error;
    }
  });
  if (fait) afficherMessage('Mot de passe changé.', 'succes');
}

async function changerTelephone(application) {
  const ok = await confirmer({
    titre: 'Changer de téléphone ?',
    texte: 'La double authentification actuelle est supprimée, puis vous la configurez aussitôt sur le nouveau téléphone (QR code ou clé). Ayez le nouveau téléphone sous la main.',
    libelle: 'Continuer'
  });
  if (!ok) return;
  const { error } = await supabase.auth.mfa.unenroll({ factorId: application.id });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  // Session ramenée au niveau d'un simple code : la porte d'entrée propose
  // la configuration de la nouvelle application
  await supabase.auth.refreshSession();
  location.reload();
}

// #############################################################################
// Onglet « Journal des modifications »
// #############################################################################
const TABLES = {
  courses: 'Courses', tarifs: 'Tarifs', majorations: 'Majorations', jours_feries: 'Jours fériés', zones: 'Lieux',
  forfaits: 'Forfaits', categories: 'Catégories', codes_promo: 'Codes promo', societe: 'Entreprise', parametres: 'Réglages',
  vehicules: 'Véhicules', entretiens: 'Entretiens', chauffeurs: 'Chauffeurs', documents: 'Documents', candidatures: 'Candidatures',
  profils: 'Comptes (rôles et blocages)', comptes_pro: 'Comptes professionnels', comptes_pro_membres: 'Membres des comptes pro',
  paiements: 'Paiements', remboursements: 'Remboursements', factures: 'Factures', salaries: 'Salariés', contrats: 'Contrats',
  constantes_paie: 'Constantes de paie', parametres_paie: 'Taux de cotisation', bulletins: 'Bulletins de paie', absences: 'Absences',
  temps_travail: 'Temps de travail', releves_plateformes: 'Relevés des plateformes', campagnes: 'Campagnes'
};
const ACTIONS = {
  INSERT: 'Création', UPDATE: 'Modification', DELETE: 'Suppression',
  attribution_manuelle: 'Attribution à la main', annulation_admin: 'Annulation par l\'administration',
  retrait_chauffeur: 'Course retirée au chauffeur', relance_recherche: 'Recherche relancée',
  validation_chauffeur: 'Chauffeur validé', refus_candidature: 'Candidature refusée', affectation_vehicule: 'Véhicule affecté',
  suspension_chauffeur: 'Chauffeur suspendu', reactivation_chauffeur: 'Chauffeur réactivé', nomination_admin: 'Administrateur nommé'
};
const ROLES = { admin: 'administration', chauffeur: 'chauffeur', client: 'client' };

function valeurLisible(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (typeof v === 'object') return JSON.stringify(v);
  const texte = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(texte)) return `${dateCourte(texte)} ${heure(texte)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(texte)) return dateCourte(texte);
  return texte.length > 120 ? `${texte.slice(0, 117)}…` : texte;
}

function champLisible(cle) {
  const texte = cle.replace(/_/g, ' ');
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

function details(entree) {
  const ignorer = ['maj_le', 'cree_le'];
  if (entree.action === 'UPDATE' && entree.apres) {
    return el('div', { classe: 'diff' }, ...Object.keys(entree.apres).filter((k) => !ignorer.includes(k)).map((k) => el('span', {},
      `${champLisible(k)} : `, el('del', { texte: valeurLisible((entree.avant || {})[k]) }), ' → ', el('ins', { texte: valeurLisible(entree.apres[k]) }))));
  }
  const source = entree.action === 'DELETE' ? entree.avant : entree.apres;
  if (!source || typeof source !== 'object') return '';
  const cles = Object.keys(source).filter((k) => !ignorer.includes(k) && source[k] !== null && k !== 'id').slice(0, 8);
  return el('div', { classe: 'diff' }, ...cles.map((k) => el('span', { texte: `${champLisible(k)} : ${valeurLisible(source[k])}` })));
}

async function afficherJournal() {
  const choix = el('select', { id: 'journal-table', classe: 'saisie' },
    el('option', { value: '', texte: 'Toutes les tables' }),
    ...Object.entries(TABLES).sort((a, b) => a[1].localeCompare(b[1], 'fr')).map(([valeur, libelle]) => el('option', { value: valeur, texte: libelle })));
  choix.value = etat.tableJournal;
  choix.addEventListener('change', () => { etat.tableJournal = choix.value; chargerJournal(true); });
  const exporter = boutonExporter(() => exporterCsv(`journal-loc-reaction-${jourParis()}.csv`, [
    { titre: 'Date', csv: (j) => `${dateCourte(j.cree_le)} ${heure(j.cree_le)}` },
    { titre: 'Auteur', csv: (j) => j.acteur_nom || (j.acteur_id ? 'Compte' : 'Automatique') },
    { titre: 'Rôle', csv: (j) => j.acteur_role || '' },
    { titre: 'Action', csv: (j) => ACTIONS[j.action] || j.action },
    { titre: 'Table', csv: (j) => TABLES[j.table_cible] || j.table_cible },
    { titre: 'Ligne', csv: (j) => j.ligne_id },
    { titre: 'Avant', csv: (j) => (j.avant ? JSON.stringify(j.avant) : '') },
    { titre: 'Après', csv: (j) => (j.apres ? JSON.stringify(j.apres) : '') }
  ], etat.journal));
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('div', { classe: 'carte-entete' }, el('h2', { texte: 'Journal des modifications' }), exporter),
    el('p', { classe: 'sous-titre', texte: 'Qui a modifié quoi, et quand. Les étapes normales des courses sont dans leur fiche (rubrique « Étapes »).' }),
    el('div', { classe: 'barre-outils' }, el('div', { classe: 'champ' }, el('label', { for: 'journal-table', texte: 'Table' }), choix)),
    el('div', { id: 'journal-liste' }),
    el('div', { classe: 'pagination', id: 'journal-suite' })));
  await chargerJournal(true);
}

async function chargerJournal(depuisDebut) {
  if (depuisDebut) { etat.journal = []; etat.finJournal = false; }
  const avant = etat.journal.length ? etat.journal[etat.journal.length - 1].cree_le : null;
  const { data, error } = await supabase.rpc('journal_lister', { p_table: etat.tableJournal || null, p_ligne: null, p_limite: 50, p_avant: avant });
  if (error) { $('journal-liste').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.journal = etat.journal.concat(data);
  etat.finJournal = data.length < 50;
  $('journal-liste').replaceChildren(tableau({
    colonnes: [
      { titre: 'Date', valeur: (j) => el('span', {}, dateCourte(j.cree_le), el('span', { classe: 'secondaire', texte: heure(j.cree_le) })) },
      { titre: 'Auteur', valeur: (j) => el('span', {}, j.acteur_nom || (j.acteur_id ? 'Compte' : 'Automatique'),
        j.acteur_role ? el('span', { classe: 'secondaire', texte: ROLES[j.acteur_role] || j.acteur_role }) : null) },
      { titre: 'Action', valeur: (j) => el('span', {}, ACTIONS[j.action] || champLisible(j.action),
        el('span', { classe: 'secondaire', texte: TABLES[j.table_cible] || j.table_cible || '' })) },
      { titre: 'Détail', valeur: (j) => details(j) }
    ],
    lignes: etat.journal, vide: 'Aucune modification enregistrée.'
  }));
  const suite = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Voir les modifications plus anciennes' });
  suite.addEventListener('click', () => chargerJournal(false));
  $('journal-suite').replaceChildren(...(etat.finJournal ? [] : [suite]));
}
