// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : clients et entreprises
// -----------------------------------------------------------------------------
// Point d'entrée de la page : choisit la vue d'après l'adresse.
//   ?vue=entreprises            liste des comptes professionnels (entreprises.js)
//   ?entreprise=…               fiche d'un compte professionnel (entreprises.js)
//   ?entreprise=…&releve=AAAA-MM relevé mensuel imprimable (entreprises.js)
//   ?id=…                       fiche d'un client (ce fichier)
//   sans paramètre              liste des clients (ce fichier)
// Lectures : admin_lister_clients, admin_fiche_client (une seule demande par
// écran). Écritures : coordonnées du client (règles d'accès : administration,
// modification inscrite au journal), blocage (admin_statut_client), solde
// (ajuster_solde), notes internes.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, afficherMessage } from '../../commun/outils.js';
import { ouvrirAdministration, lienAdmin } from '../commun/admin.js';
import {
  badge, badgeCourse, dateCourte, jourHeure, dateHeureComplete, MODES_PAIEMENT, TYPES_COURSE, tableau, exporterCsv,
  nombreCsv, boutonExporter, fenetreFormulaire, confirmer, messageErreurAdmin, jourParis, nomComplet, lienTelephone,
  telephoneLisible
} from '../commun/composants.js';
import { afficherEntreprises, ouvrirFicheEntreprise, ouvrirReleve } from './entreprises.js';
import {
  boutonAction, tuile, etoiles, ligne, pluriel, montantCourse, normaliserTelephone, erreurTelephone, section,
  tableauRepliable, blocNotesInternes, blocHistorique
} from './blocs.js';

const $ = (id) => document.getElementById(id);
const PAR_PAGE = 50;
const VUES = [{ code: 'clients', libelle: 'Clients' }, { code: 'entreprises', libelle: 'Entreprises' }];
const TRIS = [
  { valeur: 'recents', libelle: 'Inscription récente' }, { valeur: 'nom', libelle: 'Nom' },
  { valeur: 'depense', libelle: 'Dépense' }, { valeur: 'courses', libelle: 'Nombre de courses' },
  { valeur: 'derniere', libelle: 'Dernière course' }
];
const filtres = { texte: '', statut: '', tri: 'recents', page: 0 };
const etat = { profil: null };

ouvrirAdministration({ module: 'clients' }).then(async (profil) => {
  etat.profil = profil;
  const p = new URLSearchParams(location.search);
  if (p.get('entreprise') && p.get('releve')) await ouvrirReleve(p.get('entreprise'), p.get('releve'));
  else if (p.get('entreprise')) await ouvrirFicheEntreprise(p.get('entreprise'), profil);
  else if (p.get('id')) await ouvrirFicheClient(p.get('id'));
  else afficherVue(p.get('vue') === 'entreprises' ? 'entreprises' : 'clients');
});

// Onglets « Clients » / « Entreprises » (gardés dans l'adresse)
function afficherVue(vue) {
  $('onglets').hidden = false;
  $('onglets').replaceChildren(...VUES.map((v) => {
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(v.code === vue), texte: v.libelle });
    b.addEventListener('click', () => {
      if (v.code === vue) return;
      history.replaceState(null, '', `${location.pathname}${v.code === 'entreprises' ? '?vue=entreprises' : ''}`);
      afficherVue(v.code);
    });
    return b;
  }));
  if (vue === 'entreprises') afficherEntreprises();
  else afficherClients();
}

// #############################################################################
// LISTE DES CLIENTS
// #############################################################################
const COLONNES = [
  { titre: 'Client', valeur: (c) => el('span', {},
    el('a', { href: lienAdmin(`clients/?id=${c.id}`), texte: nomComplet(c.prenom, c.nom) }),
    (c.statut === 'bloque' || c.candidat || c.entreprises.length)
      ? el('span', { classe: 'secondaire badges-ligne' },
        c.statut === 'bloque' ? badge('Bloqué', 'rouge') : null,
        c.candidat ? badge('Candidat chauffeur', 'or') : null,
        ...c.entreprises.map((e) => badge(e, 'bleu')))
      : null) },
  { titre: 'Contact', valeur: (c) => el('span', {}, c.telephone ? telephoneLisible(c.telephone) : 'Sans téléphone',
    el('span', { classe: 'secondaire', texte: c.email || '' })) },
  { titre: 'Courses', droite: true, valeur: (c) => el('span', {}, String(c.courses_terminees),
    el('span', { classe: 'secondaire', texte: c.a_venir ? `${c.a_venir} à venir` : c.derniere_course_le ? `dernière le ${dateCourte(c.derniere_course_le)}` : '' })) },
  { titre: 'Dépense', droite: true, valeur: (c) => el('span', {}, euros(c.depense),
    Number(c.solde) > 0 ? el('span', { classe: 'secondaire', texte: `solde ${euros(c.solde)}` }) : null) },
  { titre: 'Note reçue', valeur: (c) => (c.note_moyenne ? `★ ${nombre(c.note_moyenne, 1)} (${c.nb_notes})` : '—') },
  { titre: 'Inscription', valeur: (c) => dateCourte(c.cree_le) }
];

const COLONNES_CSV = [
  { titre: 'Prénom', csv: (c) => c.prenom }, { titre: 'Nom', csv: (c) => c.nom },
  { titre: 'E-mail', csv: (c) => c.email }, { titre: 'Téléphone', csv: (c) => c.telephone },
  { titre: 'Statut', csv: (c) => (c.statut === 'bloque' ? 'Bloqué' : 'Actif') },
  { titre: 'Langue', csv: (c) => (c.langue === 'en' ? 'Anglais' : 'Français') },
  { titre: 'Inscription', csv: (c) => dateCourte(c.cree_le) },
  { titre: 'Courses terminées', csv: (c) => c.courses_terminees },
  { titre: 'Annulations du client', csv: (c) => c.annulations },
  { titre: 'Courses à venir', csv: (c) => c.a_venir },
  { titre: 'Dépense TTC', csv: (c) => nombreCsv(c.depense) },
  { titre: 'Dernière course', csv: (c) => (c.derniere_course_le ? dateCourte(c.derniere_course_le) : '') },
  { titre: 'Note reçue des chauffeurs', csv: (c) => nombreCsv(c.note_moyenne) },
  { titre: 'Nombre de notes', csv: (c) => c.nb_notes },
  { titre: 'Solde', csv: (c) => nombreCsv(c.solde) },
  { titre: 'Entreprises', csv: (c) => c.entreprises.join(', ') }
];

function lireFiltresUrl() {
  const p = new URLSearchParams(location.search);
  filtres.texte = (p.get('q') || '').slice(0, 100);
  filtres.statut = ['actif', 'bloque'].includes(p.get('statut')) ? p.get('statut') : '';
  filtres.tri = TRIS.some((t) => t.valeur === p.get('tri')) ? p.get('tri') : 'recents';
  filtres.page = Math.max(0, parseInt(p.get('page') || '0', 10) || 0);
}

function ecrireFiltresUrl() {
  const p = new URLSearchParams();
  if (filtres.texte) p.set('q', filtres.texte);
  if (filtres.statut) p.set('statut', filtres.statut);
  if (filtres.tri !== 'recents') p.set('tri', filtres.tri);
  if (filtres.page) p.set('page', String(filtres.page));
  const requete = p.toString();
  history.replaceState(null, '', `${location.pathname}${requete ? `?${requete}` : ''}`);
}

function afficherClients() {
  lireFiltresUrl();
  $('titre-page').textContent = 'Clients et entreprises';
  $('entete-actions').replaceChildren(boutonExporter(exporterClients));

  const texte = el('input', { id: 'filtre-texte', classe: 'saisie', type: 'search', autocomplete: 'off',
    placeholder: 'Nom, e-mail, téléphone ou code' });
  texte.value = filtres.texte;
  const statut = el('select', { id: 'filtre-statut', classe: 'saisie' },
    el('option', { value: '', texte: 'Tous' }), el('option', { value: 'actif', texte: 'Actifs' }), el('option', { value: 'bloque', texte: 'Bloqués' }));
  statut.value = filtres.statut;
  const tri = el('select', { id: 'filtre-tri', classe: 'saisie' }, ...TRIS.map((t) => el('option', { value: t.valeur, texte: t.libelle })));
  tri.value = filtres.tri;
  const effacer = el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'Effacer' });
  const formulaire = el('form', { classe: 'barre-outils', id: 'filtres', role: 'search' },
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'filtre-texte', texte: 'Rechercher' }), texte),
    el('div', { classe: 'champ' }, el('label', { for: 'filtre-statut', texte: 'Compte' }), statut),
    el('div', { classe: 'champ' }, el('label', { for: 'filtre-tri', texte: 'Trier par' }), tri),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Rechercher' }),
    effacer);
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); filtres.texte = texte.value.trim(); filtres.page = 0; chargerClients(); });
  statut.addEventListener('change', () => { filtres.statut = statut.value; filtres.page = 0; chargerClients(); });
  tri.addEventListener('change', () => { filtres.tri = tri.value; filtres.page = 0; chargerClients(); });
  effacer.addEventListener('click', () => {
    Object.assign(filtres, { texte: '', statut: '', tri: 'recents', page: 0 });
    texte.value = ''; statut.value = ''; tri.value = 'recents';
    chargerClients();
  });

  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'resume-clients', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-label': 'Filtres' }, formulaire),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-resultats' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-resultats', texte: 'Clients' }),
        el('span', { classe: 'sous-titre', id: 'nb-resultats', 'aria-live': 'polite' })),
      el('div', { id: 'resultats' }, el('p', { classe: 'chargement', texte: 'Chargement…' })),
      el('div', { classe: 'pagination', id: 'pagination' })));
  chargerClients();
}

function parametresListe(limite, decalage) {
  return { p_texte: filtres.texte || null, p_statut: filtres.statut || null, p_tri: filtres.tri, p_limite: limite, p_decalage: decalage };
}

async function chargerClients() {
  ecrireFiltresUrl();
  $('resultats').classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_clients', parametresListe(PAR_PAGE, filtres.page * PAR_PAGE));
  $('resultats').classList.remove('rechargement');
  if (error) { $('resultats').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }

  const r = data.resume;
  $('resume-clients').replaceChildren(
    tuile('Clients', String(r.clients), pluriel(r.nouveaux_30_jours, 'nouveau en 30 jours', 'nouveaux en 30 jours')),
    tuile('Actifs (30 j)', String(r.actifs_30_jours), 'au moins une course terminée'),
    tuile('Rattachés', String(r.avec_entreprise), 'à une entreprise (facture mensuelle)'),
    tuile('Bloqués', String(r.bloques), r.bloques ? 'ne peuvent plus commander' : 'aucun compte', r.bloques ? 'rouge' : null));

  const total = data.total;
  $('nb-resultats').textContent = pluriel(total, 'client', 'clients');
  $('resultats').replaceChildren(tableau({
    colonnes: COLONNES, lignes: data.lignes,
    vide: filtres.texte || filtres.statut ? 'Aucun client ne correspond à ces critères.' : 'Aucun client inscrit pour le moment.',
    clicLigne: (c) => { location.href = lienAdmin(`clients/?id=${c.id}`); },
    libelleLigne: (c) => `Ouvrir la fiche de ${nomComplet(c.prenom, c.nom)}`
  }));
  const pages = Math.max(1, Math.ceil(total / PAR_PAGE));
  const precedent = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Précédent', disabled: filtres.page === 0 });
  const suivant = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Suivant', disabled: filtres.page >= pages - 1 });
  precedent.addEventListener('click', () => { filtres.page -= 1; chargerClients(); window.scrollTo(0, 0); });
  suivant.addEventListener('click', () => { filtres.page += 1; chargerClients(); window.scrollTo(0, 0); });
  $('pagination').replaceChildren(...(total > PAR_PAGE ? [precedent, el('span', { texte: `Page ${filtres.page + 1} sur ${pages}` }), suivant] : []));
}

async function exporterClients() {
  const { data, error } = await supabase.rpc('admin_lister_clients', parametresListe(5000, 0));
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  if (data.total > 5000) afficherMessage('Plus de 5 000 clients : seuls les 5 000 premiers sont exportés. Affinez la recherche.');
  exporterCsv(`clients-loc-reaction-${jourParis()}.csv`, COLONNES_CSV, data.lignes);
}

// #############################################################################
// FICHE D'UN CLIENT
// #############################################################################
const NATURES = { course: 'Course', pourboire: 'Pourboire', frais_annulation: 'Frais d\'annulation' };
const STATUTS_PARRAINAGE = { en_attente: { libelle: 'En attente de sa 1re course', ton: 'or' }, valide: { libelle: 'Validé', ton: 'vert' }, annule: { libelle: 'Annulé', ton: 'gris' } };
const STATUTS_DEMANDE = { ouverte: { libelle: 'Ouverte', ton: 'or' }, en_cours: { libelle: 'En cours', ton: 'bleu' }, resolue: { libelle: 'Résolue', ton: 'vert' }, fermee: { libelle: 'Fermée', ton: 'gris' } };
const TYPES_LIEU = { domicile: 'Domicile', travail: 'Travail', favori: 'Favori' };
const ANNULABLES = ['planifiee', 'recherche', 'a_attribuer'];

async function ouvrirFicheClient(id) {
  $('entete-actions').replaceChildren(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin('clients/'), texte: 'Tous les clients' }));
  if (!/^[0-9a-f-]{36}$/i.test(id)) { introuvable(); return; }
  await chargerFicheClient(id);
}

function introuvable() {
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('p', { texte: 'Client introuvable.' }),
    el('a', { href: lienAdmin('clients/'), texte: 'Retour à la liste des clients' })));
}

async function chargerFicheClient(id) {
  const { data, error } = await supabase.rpc('admin_fiche_client', { p_profil: id });
  if (error) {
    if (/introuvable/i.test(error.message || '')) introuvable();
    else $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) }));
    return;
  }
  afficherFicheClient(data);
}

function afficherFicheClient(f) {
  const p = f.profil;
  const ch = f.chiffres;
  const nom = nomComplet(p.prenom, p.nom);
  const recharger = () => chargerFicheClient(p.id);
  document.title = `${nom}, administration LOC RÉACTION`;
  $('titre-page').textContent = nom;

  // Identité, contact, actions
  const badges = [p.statut === 'bloque' ? badge('Compte bloqué', 'rouge') : badge('Actif', 'vert')];
  if (p.role === 'chauffeur') badges.push(badge('Chauffeur', 'bleu'));
  if (p.role === 'admin') badges.push(badge('Administrateur', 'bleu'));
  if (f.chauffeur && f.chauffeur.statut === 'candidat') badges.push(badge('Candidat chauffeur', 'or'));
  const notifications = [p.notif_email && 'e-mail', p.notif_whatsapp && 'WhatsApp', p.notif_push && 'application'].filter(Boolean);
  const identite = el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-identite' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-identite', texte: 'Coordonnées' }), ...badges),
    el('dl', { classe: 'fiche-donnees' },
      ...ligne('Téléphone', p.telephone ? lienTelephone(p.telephone)
        : el('span', { classe: 'texte-or', texte: 'Non renseigné : ce client ne peut pas commander' })),
      ...ligne('E-mail', p.email ? el('a', { href: `mailto:${p.email}`, texte: p.email }) : null),
      ...ligne('Inscription', dateHeureComplete(p.cree_le)),
      ...ligne('Dernière connexion', f.connexion && f.connexion.derniere_connexion ? dateHeureComplete(f.connexion.derniere_connexion) : 'Non connue'),
      ...ligne('Langue', p.langue === 'en' ? 'Anglais' : 'Français'),
      ...ligne('Code de parrainage', el('span', { classe: 'mono', texte: p.code_parrainage })),
      ...ligne('Notifications', notifications.length ? notifications.join(', ') : 'Toutes désactivées')),
    actionsClient(f, recharger));

  // Chiffres
  const chiffres = el('div', { classe: 'chiffres-cles' },
    tuile('Courses terminées', String(ch.courses_terminees),
      [ch.a_venir ? `${ch.a_venir} à venir` : null,
        ch.annulations_client ? pluriel(ch.annulations_client, 'annulation du client', 'annulations du client') : null]
        .filter(Boolean).join(' · ') || 'rien à venir'),
    tuile('Dépense totale', euros(ch.depense), ch.panier_moyen !== null ? `panier moyen ${euros(ch.panier_moyen)}` : 'aucune course terminée'),
    tuile('Note des chauffeurs', ch.note_recue !== null ? `★ ${nombre(ch.note_recue, 1)}` : '—',
      ch.nb_notes_recues ? `${pluriel(ch.nb_notes_recues, 'note', 'notes')}, visibles de l'administration seulement` : 'aucune note pour le moment'),
    tuile('À encaisser', euros(ch.a_encaisser),
      f.paiements_a_encaisser.length ? pluriel(f.paiements_a_encaisser.length, 'paiement en attente', 'paiements en attente') : 'rien en attente',
      Number(ch.a_encaisser) > 0 ? 'or' : null));

  const blocs = [identite, chiffres];
  if (p.statut === 'bloque') {
    blocs.splice(1, 0, el('p', { classe: 'alerte', texte: 'Compte bloqué : ce client ne peut plus commander. Le motif figure dans l\'historique des modifications, en bas de la fiche.' }));
  }
  if (f.paiements_a_encaisser.length) blocs.push(sectionAEncaisser(f));
  blocs.push(sectionCourses(f));
  blocs.push(sectionFactures(f));
  blocs.push(el('div', { classe: 'grille-2' }, sectionSolde(f, recharger), sectionNotes(f)));
  blocs.push(el('div', { classe: 'grille-2' },
    el('div', { classe: 'pile' }, sectionParrainage(f), sectionPromos(f)),
    el('div', { classe: 'pile' }, sectionEntreprises(f), sectionLieux(f), sectionDemandes(f))));
  blocs.push(blocNotesInternes({ cible: { profil_id: p.id }, notes: f.notes_internes, moi: etat.profil.id, recharger }));
  blocs.push(blocHistorique({
    aide: 'Blocages et déblocages (avec leur motif), corrections de coordonnées par l\'administration, changements de rôle.',
    charger: async () => {
      const { data, error } = await supabase.rpc('journal_lister', { p_table: 'profils', p_ligne: p.id, p_limite: 200, p_avant: null });
      if (error) throw error;
      return data;
    }
  }));
  $('contenu').replaceChildren(...blocs);
}

// ---------------------------------------------------------------------------
// Actions sur le compte
// ---------------------------------------------------------------------------
function actionsClient(f, recharger) {
  const p = f.profil;
  const liste = [boutonAction('Modifier', () => modifierClient(p, recharger), 'bouton-principal')];
  if (p.role === 'client') {
    liste.push(p.statut === 'bloque'
      ? boutonAction('Débloquer le compte', () => debloquer(p, recharger))
      : boutonAction('Bloquer le compte', () => bloquer(f, recharger), 'bouton-danger'));
  } else if (p.role === 'chauffeur') {
    liste.push(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin('chauffeurs/'), texte: 'Module Chauffeurs' }));
  }
  liste.push(boutonAction('Créditer ou débiter le solde', () => ajusterSolde(p, f.solde, recharger)));
  const recherche = p.email || p.telephone;
  if (recherche && f.chiffres.courses_total > 0) {
    liste.push(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`courses/?q=${encodeURIComponent(recherche)}`), texte: 'Ses courses dans le module Courses' }));
  }
  return el('div', { classe: 'actions-ligne' }, ...liste);
}

async function modifierClient(p, recharger) {
  const fait = await fenetreFormulaire({
    titre: `Modifier ${nomComplet(p.prenom, p.nom)}`,
    intro: 'Chaque correction est inscrite au journal. L\'adresse e-mail de connexion ne se change que par le client lui-même.',
    champs: [
      { nom: 'prenom', libelle: 'Prénom', type: 'texte', longueur: 80 },
      { nom: 'nom', libelle: 'Nom', type: 'texte', longueur: 80 },
      { nom: 'telephone', libelle: 'Téléphone', type: 'tel', longueur: 20, normaliser: normaliserTelephone, controle: erreurTelephone,
        aide: 'Numéro auquel le chauffeur appelle le client (indispensable pour commander).' },
      { nom: 'langue', libelle: 'Langue des messages', type: 'choix', requis: true,
        options: [{ valeur: 'fr', libelle: 'Français' }, { valeur: 'en', libelle: 'Anglais' }] }
    ],
    valeurs: { prenom: p.prenom, nom: p.nom, telephone: p.telephone, langue: p.langue },
    enregistrer: async (v) => {
      const modifs = {};
      for (const cle of ['prenom', 'nom', 'telephone', 'langue']) {
        const nouvelle = cle === 'prenom' || cle === 'nom' ? (v[cle] || '') : (v[cle] || null);
        const ancienne = cle === 'prenom' || cle === 'nom' ? (p[cle] || '') : (p[cle] || null);
        if (nouvelle !== ancienne) modifs[cle] = nouvelle;
      }
      if (!Object.keys(modifs).length) return 'rien';
      const { error } = await supabase.from('profils').update(modifs).eq('id', p.id);
      if (error) throw error;
      return 'modifie';
    }
  });
  if (fait === 'modifie') { afficherMessage('Fiche du client enregistrée.', 'succes'); await recharger(); }
}

async function bloquer(f, recharger) {
  const p = f.profil;
  const annulables = f.courses.filter((c) => ANNULABLES.includes(c.statut)).length;
  const champs = [
    { nom: 'motif', libelle: 'Motif du blocage (conservé dans le journal, jamais montré au client)', type: 'zone', requis: true, longueur: 500, plein: true }
  ];
  if (annulables) {
    champs.push({ nom: 'annuler', type: 'case', plein: true,
      libelle: `Annuler aussi ${annulables > 1 ? `ses ${annulables} réservations` : 'sa réservation'} pas encore prise${annulables > 1 ? 's' : ''} en charge (sans frais ; client et chauffeur prévenus)` });
  }
  let resultat = null;
  const fait = await fenetreFormulaire({
    titre: `Bloquer le compte de ${nomComplet(p.prenom, p.nom)} ?`,
    intro: 'Le client ne pourra plus commander de course ; il est prévenu dans l\'application. Vous pourrez débloquer le compte à tout moment.',
    champs, valeurs: { annuler: true }, libelle: 'Bloquer le compte',
    enregistrer: async (v) => {
      const { data, error } = await supabase.rpc('admin_statut_client', {
        p_profil: p.id, p_statut: 'bloque', p_motif: v.motif, p_annuler_reservations: !!v.annuler
      });
      if (error) throw error;
      resultat = data;
    }
  });
  if (!fait) return;
  const n = resultat ? Number(resultat.reservations_annulees) : 0;
  afficherMessage(`Compte bloqué${n ? `, ${pluriel(n, 'réservation annulée', 'réservations annulées')}` : ''}.`, 'succes');
  await recharger();
}

async function debloquer(p, recharger) {
  const ok = await confirmer({
    titre: `Débloquer le compte de ${nomComplet(p.prenom, p.nom)} ?`,
    texte: 'Le client pourra de nouveau commander ; il est prévenu dans l\'application.', libelle: 'Débloquer'
  });
  if (!ok) return;
  const { error } = await supabase.rpc('admin_statut_client', { p_profil: p.id, p_statut: 'actif' });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Compte débloqué.', 'succes');
  await recharger();
}

async function ajusterSolde(p, solde, recharger) {
  const fait = await fenetreFormulaire({
    titre: 'Créditer ou débiter le solde',
    intro: `Solde actuel : ${euros(solde)}. Geste commercial, correction : le mouvement est daté et signé à votre nom ; le solde ne peut pas devenir négatif.`,
    champs: [
      { nom: 'sens', libelle: 'Mouvement', type: 'choix', requis: true,
        options: [{ valeur: 'credit', libelle: 'Créditer (ajouter)' }, { valeur: 'debit', libelle: 'Débiter (retirer)' }] },
      { nom: 'montant', libelle: 'Montant (€)', type: 'nombre', requis: true, min: 0.01, max: 1000, pas: '0.01' },
      { nom: 'motif', libelle: 'Motif, visible par le client', type: 'zone', requis: true, longueur: 300, plein: true }
    ],
    valeurs: { sens: 'credit' }, libelle: 'Enregistrer le mouvement',
    enregistrer: async (v) => {
      const montant = Math.round(v.montant * 100) / 100 * (v.sens === 'debit' ? -1 : 1);
      const { error } = await supabase.rpc('ajuster_solde', { p_profil: p.id, p_montant: montant, p_motif: v.motif });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Mouvement enregistré sur le solde.', 'succes'); await recharger(); }
}

// ---------------------------------------------------------------------------
// Rubriques de la fiche
// ---------------------------------------------------------------------------
function lienCourse(id, numero) {
  return el('a', { href: lienAdmin(`courses/?id=${id}`), texte: numero });
}

function sectionAEncaisser(f) {
  return el('section', { classe: 'carte-admin carte-attention', 'aria-labelledby': 'titre-a-encaisser' },
    el('h2', { id: 'titre-a-encaisser', texte: 'Paiements à encaisser' }),
    el('p', { classe: 'sous-titre', texte: 'Confirmez chaque encaissement dans la fiche de la course, une fois l\'argent reçu.' }),
    tableau({
      colonnes: [
        { titre: 'Course', valeur: (x) => lienCourse(x.course_id, x.course_numero) },
        { titre: 'Nature', valeur: (x) => NATURES[x.nature] || x.nature },
        { titre: 'Mode', valeur: (x) => MODES_PAIEMENT[x.mode] || x.mode },
        { titre: 'Montant', droite: true, valeur: (x) => euros(x.montant) },
        { titre: 'Depuis', valeur: (x) => dateCourte(x.cree_le) }
      ],
      lignes: f.paiements_a_encaisser
    }));
}

function sectionCourses(f) {
  const total = f.chiffres.courses_total;
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-courses' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-courses', texte: 'Courses' }),
      el('span', { classe: 'sous-titre', texte: total > f.courses.length ? `les ${f.courses.length} plus récentes sur ${total}` : pluriel(total, 'course', 'courses') })),
    tableauRepliable({
      libelleSuite: (n) => `Afficher ${n > 1 ? `les ${n} autres courses` : 'l\'autre course'}`,
      colonnes: [
        { titre: 'Course', valeur: (c) => el('span', {}, lienCourse(c.id, c.numero), el('span', { classe: 'secondaire' }, badgeCourse(c.statut))) },
        { titre: 'Prise en charge', valeur: (c) => el('span', {}, jourHeure(c.prise_en_charge_le), el('span', { classe: 'secondaire', texte: TYPES_COURSE[c.type] || c.type })) },
        { titre: 'Trajet', valeur: (c) => el('span', { classe: 'trajet-court' }, el('span', { texte: c.depart_adresse }),
          el('span', { classe: 'secondaire', texte: `→ ${c.arrivee_adresse}` })) },
        { titre: 'Montant', droite: true, valeur: (c) => (c.statut === 'annulee' && !Number(c.frais_annulation) ? 'sans frais' : euros(montantCourse(c))) },
        { titre: 'Paiement', valeur: (c) => el('span', {}, MODES_PAIEMENT[c.mode_paiement] || c.mode_paiement,
          el('span', { classe: 'secondaire', texte: [c.compte_pro, c.pour_proche ? `pour ${c.beneficiaire_nom}` : null, c.chauffeur_nom].filter(Boolean).join(' · ') })) }
      ],
      lignes: f.courses, vide: 'Aucune course pour le moment.',
      clicLigne: (c) => { location.href = lienAdmin(`courses/?id=${c.id}`); },
      libelleLigne: (c) => `Ouvrir la course ${c.numero}`
    }));
}

function sectionFactures(f) {
  return section('Factures', 'titre-factures', tableauRepliable({
    libelleSuite: (n) => `Afficher ${n > 1 ? `les ${n} autres factures` : 'l\'autre facture'}`,
    colonnes: [
      { titre: 'Numéro', valeur: (x) => el('span', {}, x.numero, el('span', { classe: 'secondaire', texte: x.nature === 'course' ? 'Course' : 'Frais d\'annulation' })) },
      { titre: 'Date', valeur: (x) => dateCourte(x.date_emission) },
      { titre: 'TTC', droite: true, valeur: (x) => euros(x.montant_ttc) },
      { titre: 'Course', valeur: (x) => el('span', {}, lienCourse(x.course_id, x.course_numero),
        x.compte_pro_id ? el('span', { classe: 'secondaire', texte: x.destinataire_nom }) : null) },
      { titre: 'Statut', valeur: (x) => (x.statut === 'emise' ? badge('Émise', 'vert') : badge('Annulée', 'gris')) }
    ],
    lignes: f.factures, vide: 'Aucune facture : elle est émise à la fin de chaque course.'
  }));
}

function sectionSolde(f, recharger) {
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-solde' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-solde', texte: 'Solde' }),
      el('strong', { classe: 'montant-solde', texte: euros(f.solde) })),
    el('p', { classe: 'sous-titre', texte: 'Crédits de parrainage et gestes commerciaux. Le paiement des courses par le solde arrive dans une prochaine version.' }),
    f.ecritures.length
      ? el('ul', { classe: 'liste-simple liste-mouvements' }, ...f.ecritures.map((e) => el('li', {},
        el('strong', { classe: Number(e.montant) >= 0 ? 'texte-vert' : 'texte-rouge', texte: `${Number(e.montant) >= 0 ? '+' : '−'} ${euros(Math.abs(e.montant))}` }),
        ` ${e.motif}`,
        el('span', { classe: 'secondaire', texte: [dateCourte(e.cree_le),
          e.course_numero ? `automatique, course ${e.course_numero}` : e.auteur ? `par ${e.auteur}` : null].filter(Boolean).join(' · ') }))))
      : el('p', { classe: 'vide-admin', texte: 'Aucun mouvement.' }),
    el('div', { classe: 'actions-ligne' }, boutonAction('Créditer ou débiter', () => ajusterSolde(f.profil, f.solde, recharger))));
}

function sectionNotes(f) {
  const recues = f.notes_recues.length
    ? el('ul', { classe: 'liste-simple' }, ...f.notes_recues.map((n) => el('li', {},
      etoiles(n.note), n.commentaire ? el('span', { texte: ` « ${n.commentaire} »` }) : null,
      el('span', { classe: 'secondaire' }, `${n.auteur || 'Chauffeur'} · ${dateCourte(n.cree_le)} · course `, lienCourse(n.course_id, n.course_numero)))))
    : el('p', { classe: 'vide-admin', texte: 'Aucun chauffeur n\'a encore noté ce client.' });
  const donnees = f.notes_donnees.length
    ? el('details', { classe: 'repli' },
      el('summary', {}, `Notes données par le client (${f.notes_donnees.length}${f.chiffres.note_donnee !== null ? `, moyenne ${nombre(f.chiffres.note_donnee, 1)}` : ''})`),
      el('ul', { classe: 'liste-simple' }, ...f.notes_donnees.map((n) => el('li', {},
        etoiles(n.note), n.commentaire ? el('span', { texte: ` « ${n.commentaire} »` }) : null,
        el('span', { classe: 'secondaire' }, `à ${n.chauffeur || 'son chauffeur'} · ${dateCourte(n.cree_le)} · course `, lienCourse(n.course_id, n.course_numero))))))
    : null;
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-notes' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-notes', texte: 'Notes des chauffeurs' }),
      el('span', { classe: 'sous-titre', texte: 'Jamais montrées au client' })),
    recues, donnees);
}

function sectionParrainage(f) {
  const s = (statut) => { const x = STATUTS_PARRAINAGE[statut] || { libelle: statut, ton: 'gris' }; return badge(x.libelle, x.ton); };
  return section('Parrainage', 'titre-parrainage',
    el('dl', { classe: 'fiche-donnees' },
      ...ligne('Son code', el('span', { classe: 'mono', texte: f.profil.code_parrainage })),
      ...ligne('Parrainé par', f.parrain ? el('span', {}, el('a', { href: lienAdmin(`clients/?id=${f.parrain.id}`), texte: f.parrain.nom }), ' ', s(f.parrain.statut)) : 'Personne')),
    f.filleuls.length
      ? el('ul', { classe: 'liste-simple' }, ...f.filleuls.map((x) => el('li', {},
        el('a', { href: lienAdmin(`clients/?id=${x.id}`), texte: x.nom }), ' ', s(x.statut),
        el('span', { classe: 'secondaire', texte: x.statut === 'valide' && Number(x.recompense) > 0
          ? `validé le ${dateCourte(x.valide_le)} · ${euros(x.recompense)} crédités` : `inscrit le ${dateCourte(x.cree_le)}` }))))
      : el('p', { classe: 'vide-admin', texte: 'Aucun filleul.' }));
}

function sectionPromos(f) {
  return section('Codes promo utilisés', 'titre-promos', f.promos.length
    ? el('ul', { classe: 'liste-simple' }, ...f.promos.map((x) => el('li', {},
      el('span', { classe: 'mono', texte: x.code }), ` · ${euros(x.remise)} de remise · course `, lienCourse(x.course_id, x.course_numero),
      el('span', { classe: 'secondaire', texte: dateCourte(x.cree_le) }))))
    : el('p', { classe: 'vide-admin', texte: 'Aucun code promo utilisé.' }));
}

function sectionEntreprises(f) {
  return section('Entreprises', 'titre-entreprises', f.entreprises.length
    ? el('ul', { classe: 'liste-simple' }, ...f.entreprises.map((x) => el('li', {},
      el('a', { href: lienAdmin(`clients/?entreprise=${x.id}`), texte: x.raison_sociale }), ' ',
      x.role === 'gestionnaire' ? badge('Gestionnaire', 'or') : badge('Membre', 'gris'),
      x.statut === 'suspendu' ? badge('Compte suspendu', 'rouge') : null,
      el('span', { classe: 'secondaire', texte: `rattaché le ${dateCourte(x.ajoute_le)}` }))))
    : el('p', { classe: 'vide-admin', texte: 'Rattaché à aucun compte professionnel. Pour la facture mensuelle, rattachez-le depuis la fiche de l\'entreprise.' }));
}

function sectionLieux(f) {
  return section('Lieux et proches', 'titre-lieux',
    f.lieux.length
      ? el('ul', { classe: 'liste-simple' }, ...f.lieux.map((l) => el('li', {},
        el('strong', { texte: `${l.libelle || TYPES_LIEU[l.type] || l.type} : ` }), l.adresse,
        l.precision ? el('span', { classe: 'secondaire', texte: l.precision }) : null)))
      : el('p', { classe: 'vide-admin', texte: 'Aucun lieu enregistré.' }),
    f.proches.length
      ? el('ul', { classe: 'liste-simple' }, ...f.proches.map((x) => el('li', {},
        el('strong', { texte: x.nom }), x.relation ? ` (${x.relation}) ` : ' ', lienTelephone(x.telephone))))
      : el('p', { classe: 'vide-admin', texte: 'Aucun proche enregistré.' }));
}

function sectionDemandes(f) {
  return section('Demandes au support', 'titre-demandes', f.demandes.length
    ? el('ul', { classe: 'liste-simple' }, ...f.demandes.map((d) => {
      const s = STATUTS_DEMANDE[d.statut] || { libelle: d.statut, ton: 'gris' };
      return el('li', {}, el('strong', { texte: `${d.numero} ` }), badge(s.libelle, s.ton), ` ${d.sujet}`,
        el('span', { classe: 'secondaire', texte: dateCourte(d.cree_le) }));
    }))
    : el('p', { classe: 'vide-admin', texte: 'Aucune demande.' }));
}
