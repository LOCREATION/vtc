// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : comptes professionnels (entreprises clientes)
// -----------------------------------------------------------------------------
//   - liste : activité du mois, ce qui reste à encaisser, retards ; création ;
//   - fiche : identité (SIRET et TVA contrôlés), plafond mensuel et délai de
//     règlement, membres (gestionnaire : voit toutes les courses et factures
//     du compte ; membre : commande sur facture mensuelle), relevé mensuel
//     (factures du mois, pourboires, HT, TVA, TTC, déjà réglé, reste à payer)
//     et encaissement du relevé en une fois, courses, notes internes,
//     historique ;
//   - relevé imprimable (« Imprimer ou enregistrer en PDF ») : document A4 à
//     l'identité exacte de LOC RÉACTION S.A.S, avec l'IBAN pour le virement.
// Lectures : admin_lister_comptes_pro, admin_fiche_compte_pro,
// admin_releve_compte_pro. Écritures : tables comptes_pro et
// comptes_pro_membres (règles d'accès : administration ; tout est inscrit au
// journal), admin_encaisser_releve.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  badge, badgeCourse, dateCourte, jourHeure, MODES_PAIEMENT, tableau, exporterCsv, nombreCsv,
  boutonExporter, fenetreFormulaire, confirmer, ouvrirFenetre, messageErreurAdmin, jourParis, nomComplet,
  lienTelephone, telephoneLisible, sansEspaces, erreurSiret, erreurTva, siretLisible, ibanLisible
} from '../commun/composants.js';
import {
  boutonAction, tuile, ligne, moisLisible, pluriel, montantCourse, normaliserTelephone, erreurTelephone, section,
  blocNotesInternes, blocHistorique
} from './blocs.js';
import {
  enteteDocument, blocDestinataire, lignesCompte, barreDocument, avertissementMentions, tableauDefilant, enteteTableau, blocTotaux
} from '../commun/documents.js';

const $ = (id) => document.getElementById(id);
const filtres = { texte: '', statut: '' };
const etatListe = { lignes: [] };          // lignes affichées, pour l'export CSV

// #############################################################################
// LISTE DES COMPTES PROFESSIONNELS
// #############################################################################
const COLONNES = [
  { titre: 'Entreprise', valeur: (c) => el('span', {},
    el('a', { href: lienAdmin(`clients/?entreprise=${c.id}`), texte: c.raison_sociale }),
    el('span', { classe: 'secondaire', texte: c.siret ? `SIRET ${siretLisible(c.siret)}` : 'SIRET non renseigné' })) },
  { titre: 'Contact', valeur: (c) => el('span', {}, c.contact_nom || '—', el('span', { classe: 'secondaire', texte: c.email_facturation })) },
  { titre: 'Membres', valeur: (c) => el('span', {}, String(c.nb_membres),
    el('span', { classe: 'secondaire', texte: c.nb_membres ? `dont ${pluriel(c.nb_gestionnaires, 'gestionnaire', 'gestionnaires')}` : 'personne ne peut commander' })) },
  { titre: 'Ce mois-ci', valeur: (c) => el('span', {}, pluriel(c.courses_mois, 'course', 'courses'),
    el('span', { classe: 'secondaire', texte: c.plafond_mensuel !== null
      ? `${euros(c.engage_mois)} sur ${euros(c.plafond_mensuel)}` : `${euros(c.engage_mois)} sur facture mensuelle` })) },
  { titre: 'À encaisser', droite: true, valeur: (c) => el('span', {}, euros(c.a_encaisser),
    Number(c.en_retard) > 0 ? el('span', { classe: 'secondaire texte-rouge', texte: `dont ${euros(c.en_retard)} en retard` }) : null) },
  { titre: 'Compte', valeur: (c) => (c.statut === 'actif' ? badge('Actif', 'vert') : badge('Suspendu', 'rouge')) }
];

const COLONNES_CSV = [
  { titre: 'Raison sociale', csv: (c) => c.raison_sociale }, { titre: 'SIRET', csv: (c) => c.siret },
  { titre: 'TVA intracommunautaire', csv: (c) => c.tva_intracommunautaire },
  { titre: 'Adresse', csv: (c) => c.adresse }, { titre: 'Code postal', csv: (c) => c.code_postal }, { titre: 'Ville', csv: (c) => c.ville },
  { titre: 'Contact', csv: (c) => c.contact_nom }, { titre: 'E-mail de facturation', csv: (c) => c.email_facturation },
  { titre: 'Téléphone', csv: (c) => c.telephone },
  { titre: 'Statut', csv: (c) => (c.statut === 'actif' ? 'Actif' : 'Suspendu') },
  { titre: 'Plafond mensuel', csv: (c) => nombreCsv(c.plafond_mensuel) },
  { titre: 'Délai de règlement (jours)', csv: (c) => c.delai_paiement_jours },
  { titre: 'Membres', csv: (c) => c.nb_membres },
  { titre: 'Courses du mois', csv: (c) => c.courses_mois },
  { titre: 'Engagé ce mois (facture mensuelle)', csv: (c) => nombreCsv(c.engage_mois) },
  { titre: 'À encaisser', csv: (c) => nombreCsv(c.a_encaisser) },
  { titre: 'Dont en retard', csv: (c) => nombreCsv(c.en_retard) },
  { titre: 'Client depuis', csv: (c) => dateCourte(c.cree_le) }
];

export function afficherEntreprises() {
  $('titre-page').textContent = 'Clients et entreprises';
  $('entete-actions').replaceChildren(
    boutonAction('Nouveau compte professionnel', () => formulaireCompte(null), 'bouton-principal'),
    boutonExporter(exporterComptes));

  const texte = el('input', { id: 'filtre-entreprise', classe: 'saisie', type: 'search', autocomplete: 'off',
    placeholder: 'Raison sociale, SIRET, contact, e-mail, ville' });
  texte.value = filtres.texte;
  const statut = el('select', { id: 'filtre-statut-entreprise', classe: 'saisie' },
    el('option', { value: '', texte: 'Tous' }), el('option', { value: 'actif', texte: 'Actifs' }), el('option', { value: 'suspendu', texte: 'Suspendus' }));
  statut.value = filtres.statut;
  const formulaire = el('form', { classe: 'barre-outils', role: 'search' },
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'filtre-entreprise', texte: 'Rechercher' }), texte),
    el('div', { classe: 'champ' }, el('label', { for: 'filtre-statut-entreprise', texte: 'Compte' }), statut),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Rechercher' }));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); filtres.texte = texte.value.trim(); chargerComptes(); });
  statut.addEventListener('change', () => { filtres.statut = statut.value; chargerComptes(); });

  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'resume-entreprises', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-label': 'Filtres' }, formulaire),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-comptes' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-comptes', texte: 'Comptes professionnels' }),
        el('span', { classe: 'sous-titre', id: 'nb-comptes', 'aria-live': 'polite' })),
      el('p', { classe: 'sous-titre', texte: 'Les membres d\'un compte commandent sur facture mensuelle ; chaque course a sa facture au nom de l\'entreprise, et le relevé du mois les regroupe pour un seul règlement.' }),
      el('div', { id: 'liste-comptes' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))));
  chargerComptes();
}

async function chargerComptes() {
  const { data, error } = await supabase.rpc('admin_lister_comptes_pro', { p_texte: filtres.texte || null, p_statut: filtres.statut || null });
  if (error) { $('liste-comptes').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  const r = data.resume;
  $('resume-entreprises').replaceChildren(
    tuile('Comptes actifs', String(r.actifs), `${pluriel(r.comptes, 'compte', 'comptes')} au total`),
    tuile('Courses ce mois-ci', String(r.courses_mois), 'commandées au nom d\'une entreprise'),
    tuile('À encaisser', euros(r.a_encaisser), 'sur facture mensuelle'),
    tuile('En retard', euros(r.en_retard), Number(r.en_retard) > 0 ? 'relevés échus non réglés' : 'aucun retard', Number(r.en_retard) > 0 ? 'rouge' : null));
  $('nb-comptes').textContent = pluriel(data.lignes.length, 'compte', 'comptes');
  $('liste-comptes').replaceChildren(tableau({
    colonnes: COLONNES, lignes: data.lignes,
    vide: filtres.texte || filtres.statut ? 'Aucun compte ne correspond à ces critères.'
      : 'Aucun compte professionnel pour le moment. Créez-en un avec « Nouveau compte professionnel ».',
    clicLigne: (c) => { location.href = lienAdmin(`clients/?entreprise=${c.id}`); },
    libelleLigne: (c) => `Ouvrir la fiche de ${c.raison_sociale}`
  }));
  etatListe.lignes = data.lignes;
}

function exporterComptes() {
  exporterCsv(`comptes-professionnels-loc-reaction-${jourParis()}.csv`, COLONNES_CSV, etatListe.lignes);
}

// ---------------------------------------------------------------------------
// Création et modification d'un compte
// ---------------------------------------------------------------------------
const CHAMPS_COMPTE = [
  { nom: 'raison_sociale', libelle: 'Raison sociale', type: 'texte', requis: true, longueur: 200, plein: true,
    aide: 'Exactement comme sur son Kbis : elle figure sur chaque facture.' },
  { nom: 'siret', libelle: 'SIRET', type: 'texte', longueur: 17, normaliser: sansEspaces, controle: erreurSiret, aide: 'Espaces acceptés.' },
  { nom: 'tva_intracommunautaire', libelle: 'N° de TVA intracommunautaire', type: 'texte', longueur: 20, majuscules: true,
    normaliser: sansEspaces, controle: (v) => erreurTva(v) },
  { nom: 'adresse', libelle: 'Adresse de facturation', type: 'texte', longueur: 200, plein: true },
  { nom: 'code_postal', libelle: 'Code postal', type: 'texte', longueur: 10 },
  { nom: 'ville', libelle: 'Ville', type: 'texte', longueur: 80 },
  { nom: 'email_facturation', libelle: 'E-mail de facturation', type: 'email', requis: true, longueur: 120,
    aide: 'Destinataire des factures et du relevé mensuel.' },
  { nom: 'telephone', libelle: 'Téléphone', type: 'tel', longueur: 20, normaliser: normaliserTelephone, controle: erreurTelephone },
  { nom: 'contact_nom', libelle: 'Personne à contacter', type: 'texte', longueur: 120, plein: true },
  { nom: 'plafond_mensuel', libelle: 'Plafond mensuel TTC (€)', type: 'nombre', min: 0, pas: '0.01',
    aide: 'Courses sur facture mensuelle dans le mois. Vide : sans plafond.' },
  { nom: 'delai_paiement_jours', libelle: 'Délai de règlement (jours)', type: 'nombre', requis: true, min: 0, max: 60, pas: '1',
    aide: 'Après la fin du mois du relevé ; 60 jours au plus (loi).' }
];

async function formulaireCompte(compte, recharger = null) {
  let creeId = null;
  const fait = await fenetreFormulaire({
    titre: compte ? `Modifier ${compte.raison_sociale}` : 'Nouveau compte professionnel',
    intro: compte ? 'Chaque changement est inscrit au journal. Les factures déjà émises gardent les coordonnées du jour de leur émission.'
      : 'Après la création, rattachez les salariés de l\'entreprise (leur compte client) : ils pourront commander sur facture mensuelle.',
    champs: CHAMPS_COMPTE, large: true, libelle: compte ? 'Enregistrer' : 'Créer le compte',
    valeurs: compte || { delai_paiement_jours: 30 },
    enregistrer: async (v) => {
      if (v.siret && v.tva_intracommunautaire) {
        const probleme = erreurTva(v.tva_intracommunautaire, v.siret.slice(0, 9));
        if (probleme) throw new Error(probleme);
      }
      const ligneCompte = { ...v, raison_sociale: v.raison_sociale.trim() };
      if (compte) {
        const { error } = await supabase.from('comptes_pro').update(ligneCompte).eq('id', compte.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from('comptes_pro').insert(ligneCompte).select('id').single();
        if (error) throw error;
        creeId = data.id;
      }
    }
  });
  if (!fait) return;
  if (creeId) {
    afficherMessage('Compte professionnel créé. Rattachez maintenant ses membres.', 'succes');
    location.href = lienAdmin(`clients/?entreprise=${creeId}`);
    return;
  }
  afficherMessage('Compte professionnel enregistré.', 'succes');
  if (recharger) await recharger();
}

// #############################################################################
// FICHE D'UN COMPTE PROFESSIONNEL
// #############################################################################
const etatFiche = { moi: null, mois: null };

export async function ouvrirFicheEntreprise(id, profil) {
  etatFiche.moi = profil.id;
  $('entete-actions').replaceChildren(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin('clients/?vue=entreprises'), texte: 'Toutes les entreprises' }));
  if (!/^[0-9a-f-]{36}$/i.test(id)) { introuvable(); return; }
  await chargerFiche(id);
}

function introuvable() {
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('p', { texte: 'Compte professionnel introuvable.' }),
    el('a', { href: lienAdmin('clients/?vue=entreprises'), texte: 'Retour à la liste des entreprises' })));
}

async function chargerFiche(id) {
  const { data, error } = await supabase.rpc('admin_fiche_compte_pro', { p_compte: id });
  if (error) {
    if (/introuvable/i.test(error.message || '')) introuvable();
    else $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) }));
    return;
  }
  afficherFiche(data);
}

function afficherFiche(f) {
  const c = f.compte;
  const ch = f.chiffres;
  const recharger = () => chargerFiche(c.id);
  document.title = `${c.raison_sociale}, administration LOC RÉACTION`;
  $('titre-page').textContent = c.raison_sociale;

  const adresse = [c.adresse, [c.code_postal, c.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const identite = el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-identite' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-identite', texte: 'Identité' }),
      c.statut === 'actif' ? badge('Actif', 'vert') : badge('Suspendu', 'rouge')),
    c.statut === 'suspendu' ? el('p', { classe: 'alerte', texte: 'Compte suspendu : ses membres ne peuvent plus commander sur facture mensuelle.' }) : null,
    el('dl', { classe: 'fiche-donnees' },
      ...ligne('SIRET', c.siret ? siretLisible(c.siret) : el('span', { classe: 'texte-or', texte: 'À compléter' })),
      ...ligne('TVA intracommunautaire', c.tva_intracommunautaire || el('span', { classe: 'texte-or', texte: 'À compléter' })),
      ...ligne('Adresse de facturation', adresse || el('span', { classe: 'texte-or', texte: 'À compléter : elle figure sur les factures' })),
      ...ligne('E-mail de facturation', el('a', { href: `mailto:${c.email_facturation}`, texte: c.email_facturation })),
      ...ligne('Téléphone', lienTelephone(c.telephone)),
      ...ligne('Contact', c.contact_nom),
      ...ligne('Plafond mensuel', c.plafond_mensuel !== null ? `${euros(c.plafond_mensuel)} TTC` : 'Sans plafond'),
      ...ligne('Règlement', `${pluriel(c.delai_paiement_jours, 'jour', 'jours')} après la fin du mois`),
      ...ligne('Client depuis', dateCourte(c.cree_le))),
    el('div', { classe: 'actions-ligne' },
      boutonAction('Modifier', () => formulaireCompte(c, recharger), 'bouton-principal'),
      c.statut === 'actif'
        ? boutonAction('Suspendre', () => changerStatut(c, 'suspendu', recharger), 'bouton-danger')
        : boutonAction('Réactiver', () => changerStatut(c, 'actif', recharger)),
      f.courses.length === 0 ? boutonAction('Supprimer', () => supprimerCompte(c), 'bouton-danger') : null));

  const plafondAtteint = c.plafond_mensuel !== null && Number(ch.engage_mois) >= Number(c.plafond_mensuel);
  const chiffres = el('div', { classe: 'chiffres-cles' },
    tuile('Ce mois-ci', euros(ch.engage_mois),
      `${pluriel(ch.courses_mois, 'course', 'courses')} · ${c.plafond_mensuel !== null ? `plafond ${euros(c.plafond_mensuel)}` : 'sans plafond'}`,
      plafondAtteint ? 'rouge' : null),
    tuile('À encaisser', euros(ch.a_encaisser), Number(ch.en_retard) > 0 ? `dont ${euros(ch.en_retard)} en retard` : 'aucun retard',
      Number(ch.en_retard) > 0 ? 'rouge' : null),
    tuile('Courses terminées', String(ch.courses_terminees), 'depuis l\'ouverture du compte'),
    tuile('Total facturé', euros(ch.total_facture), 'TTC, toutes factures émises, avoirs déduits'));

  const releve = el('section', { classe: 'carte-admin', id: 'releve', 'aria-labelledby': 'titre-releve' });
  $('contenu').replaceChildren(
    identite, chiffres,
    sectionMembres(f, recharger),
    releve,
    sectionCourses(f),
    blocNotesInternes({ cible: { compte_pro_id: c.id }, notes: f.notes_internes, moi: etatFiche.moi, recharger }),
    blocHistorique({
      aide: 'Identité, plafond, statut, membres rattachés ou détachés, encaissements des relevés.',
      charger: async () => {
        const [compte, membres] = await Promise.all([
          supabase.rpc('journal_lister', { p_table: 'comptes_pro', p_ligne: c.id, p_limite: 200, p_avant: null }),
          supabase.rpc('journal_lister', { p_table: 'comptes_pro_membres', p_ligne: null, p_limite: 500, p_avant: null })
        ]);
        if (compte.error) throw compte.error;
        if (membres.error) throw membres.error;
        const duCompte = (membres.data || []).filter((j) => ((j.apres || {}).compte_pro_id || (j.avant || {}).compte_pro_id) === c.id);
        return [...compte.data, ...duCompte].sort((a, b) => new Date(b.cree_le) - new Date(a.cree_le));
      }
    }));
  // Mois du relevé : celui choisi avant, sinon le plus récent
  if (!etatFiche.mois || !f.mois.includes(etatFiche.mois)) etatFiche.mois = f.mois[0];
  dessinerReleve(c, f.mois, recharger);
}

async function changerStatut(c, statut, recharger) {
  const ok = await confirmer({
    titre: statut === 'suspendu' ? `Suspendre ${c.raison_sociale} ?` : `Réactiver ${c.raison_sociale} ?`,
    texte: statut === 'suspendu'
      ? 'Ses membres ne pourront plus commander sur facture mensuelle. Les courses déjà commandées et le relevé restent inchangés.'
      : 'Ses membres pourront de nouveau commander sur facture mensuelle.',
    libelle: statut === 'suspendu' ? 'Suspendre' : 'Réactiver', danger: statut === 'suspendu'
  });
  if (!ok) return;
  const { error } = await supabase.from('comptes_pro').update({ statut }).eq('id', c.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(statut === 'suspendu' ? 'Compte suspendu.' : 'Compte réactivé.', 'succes');
  await recharger();
}

async function supprimerCompte(c) {
  const ok = await confirmer({
    titre: `Supprimer ${c.raison_sociale} ?`,
    texte: 'Possible tant qu\'aucune course n\'a été commandée à son nom. Les membres sont détachés. La suppression est inscrite au journal.',
    libelle: 'Supprimer', danger: true
  });
  if (!ok) return;
  const { error } = await supabase.from('comptes_pro').delete().eq('id', c.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Compte professionnel supprimé.', 'succes');
  location.href = lienAdmin('clients/?vue=entreprises');
}

// ---------------------------------------------------------------------------
// Membres
// ---------------------------------------------------------------------------
function sectionMembres(f, recharger) {
  const c = f.compte;
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-membres' },
    el('div', { classe: 'carte-entete' },
      el('h2', { id: 'titre-membres', texte: 'Membres' }),
      boutonAction('Rattacher un membre', () => rattacher(f, recharger), 'bouton-principal')),
    el('p', { classe: 'sous-titre', texte: 'Membre : commande sur facture mensuelle et ne voit que ses courses. Gestionnaire : voit en plus toutes les courses et factures du compte.' }),
    tableau({
      colonnes: [
        { titre: 'Membre', valeur: (m) => el('span', {},
          el('a', { href: lienAdmin(`clients/?id=${m.profil_id}`), texte: nomComplet(m.prenom, m.nom) }),
          el('span', { classe: 'secondaire', texte: m.email || '' })) },
        { titre: 'Rôle', valeur: (m) => el('span', {}, m.role === 'gestionnaire' ? badge('Gestionnaire', 'or') : badge('Membre', 'gris'),
          m.statut === 'bloque' ? ' ' : null, m.statut === 'bloque' ? badge('Compte bloqué', 'rouge') : null) },
        { titre: 'Téléphone', valeur: (m) => (m.telephone ? lienTelephone(m.telephone) : 'Sans téléphone') },
        { titre: 'Ce mois-ci', valeur: (m) => pluriel(m.courses_mois, 'course', 'courses') },
        { titre: '', valeur: (m) => el('div', { classe: 'actions-ligne' },
          boutonAction(m.role === 'gestionnaire' ? 'Passer membre' : 'Passer gestionnaire', async () => {
            const role = m.role === 'gestionnaire' ? 'membre' : 'gestionnaire';
            const { error } = await supabase.from('comptes_pro_membres').update({ role })
              .eq('compte_pro_id', c.id).eq('profil_id', m.profil_id);
            if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
            afficherMessage(`${nomComplet(m.prenom, m.nom)} : ${role}.`, 'succes');
            await recharger();
          }),
          boutonAction('Détacher', async () => {
            const ok = await confirmer({
              titre: `Détacher ${nomComplet(m.prenom, m.nom)} de ${c.raison_sociale} ?`,
              texte: 'Il ne pourra plus commander sur facture mensuelle au nom de l\'entreprise ; il est prévenu. Ses courses passées restent sur le relevé.',
              libelle: 'Détacher', danger: true
            });
            if (!ok) return;
            const { error } = await supabase.from('comptes_pro_membres').delete().eq('compte_pro_id', c.id).eq('profil_id', m.profil_id);
            if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
            afficherMessage('Membre détaché.', 'succes');
            await recharger();
          }, 'bouton-danger')) }
      ],
      lignes: f.membres, vide: 'Aucun membre : personne ne peut encore commander au nom de cette entreprise.'
    }));
}

function rattacher(f, recharger) {
  const c = f.compte;
  const dejaMembres = new Set(f.membres.map((m) => m.profil_id));
  const recherche = el('input', { id: 'recherche-membre', classe: 'saisie', type: 'search', placeholder: 'Nom, e-mail ou téléphone', autocomplete: 'off' });
  const resultats = el('div', { classe: 'resultats-comptes', 'aria-live': 'polite' });
  const formulaire = el('form', { classe: 'barre-outils', role: 'search' },
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'recherche-membre', texte: 'Retrouver le compte client' }), recherche),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Chercher' }));
  const fenetre = ouvrirFenetre({
    titre: `Rattacher un membre à ${c.raison_sociale}`, large: true,
    contenu: [
      el('p', { classe: 'sous-titre', texte: 'La personne crée d\'abord son compte client sur le site (connexion par code reçu par e-mail), puis vous la retrouvez ici. Elle est prévenue du rattachement.' }),
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
      const deja = dejaMembres.has(compte.id);
      const impossible = deja || compte.role !== 'client' || compte.statut !== 'actif';
      const ajouter = (role) => {
        const b = el('button', { type: 'button', classe: `bouton ${role === 'membre' ? 'bouton-principal' : 'bouton-secondaire'} bouton-petit`,
          texte: role === 'membre' ? 'Rattacher comme membre' : 'Rattacher comme gestionnaire', disabled: impossible });
        b.addEventListener('click', async () => {
          b.disabled = true;
          const { error: erreur } = await supabase.from('comptes_pro_membres').insert({ compte_pro_id: c.id, profil_id: compte.id, role });
          if (erreur) { b.disabled = false; afficherMessage(messageErreurAdmin(erreur), 'erreur'); return; }
          fenetre.fermer();
          afficherMessage(`${nomComplet(compte.prenom, compte.nom)} est rattaché(e) à ${c.raison_sociale}.`, 'succes');
          await recharger();
        });
        return b;
      };
      return el('li', { classe: 'choix' },
        el('div', { classe: 'choix-identite' }, el('strong', { texte: nomComplet(compte.prenom, compte.nom) }),
          deja ? badge('Déjà membre', 'bleu') : null,
          compte.role === 'chauffeur' ? badge('Chauffeur', 'gris') : null,
          compte.role === 'admin' ? badge('Administrateur', 'gris') : null,
          compte.statut !== 'actif' ? badge('Compte bloqué', 'rouge') : null),
        el('p', { classe: 'choix-details', texte: [compte.email, telephoneLisible(compte.telephone)].filter(Boolean).join(' · ') }),
        compte.role !== 'client' ? el('p', { classe: 'texte-gris', texte: 'Seul un compte client peut être rattaché à une entreprise.' }) : null,
        el('div', { classe: 'choix-action actions-ligne' }, ajouter('membre'), ajouter('gestionnaire')));
    })));
  });
}

// ---------------------------------------------------------------------------
// Relevé mensuel (dans la fiche)
// ---------------------------------------------------------------------------
const REGLEMENTS = {
  a_encaisser: { libelle: 'À payer', ton: 'or' }, encaisse: { libelle: 'Payé', ton: 'vert' },
  rembourse: { libelle: 'Remboursé', ton: 'gris' }, echoue: { libelle: 'Impayé', ton: 'rouge' }, annule: { libelle: 'Annulé', ton: 'gris' }
};
const ORIGINES_AVOIR = { remboursement: 'Remboursement', annulation: 'Somme annulée' };

// Règlement d'une ligne : sur le relevé (à payer, payé le …) ou sur place
function reglement(mode, statut, encaisseLe) {
  if (!mode) return el('span', { classe: 'texte-gris', texte: 'Rien à payer' });
  if (mode !== 'facture_mensuelle') return el('span', {}, badge('Réglé sur place', 'gris'), el('span', { classe: 'secondaire', texte: MODES_PAIEMENT[mode] || mode }));
  const s = REGLEMENTS[statut] || { libelle: statut, ton: 'gris' };
  return el('span', {}, badge(s.libelle, s.ton), statut === 'encaisse' && encaisseLe ? el('span', { classe: 'secondaire', texte: `le ${dateCourte(encaisseLe)}` }) : null);
}

// Lignes du relevé à l'écran : chaque facture, suivie de ses avoirs
function lignesReleve(r) {
  return r.lignes.flatMap((l) => [{ ...l, type: 'facture' }, ...l.avoirs.map((a) => ({ ...a, type: 'avoir', facture_numero: l.numero,
    course_id: l.course_id, course_numero: l.course_numero, prise_en_charge_le: l.prise_en_charge_le, passager: l.passager }))]);
}

async function dessinerReleve(c, mois, recharger) {
  const zone = $('releve');
  const choix = el('select', { id: 'mois-releve', classe: 'saisie' }, ...mois.map((m) => el('option', { value: m, texte: moisLisible(m) })));
  choix.value = etatFiche.mois;
  choix.addEventListener('change', () => { etatFiche.mois = choix.value; dessinerReleve(c, mois, recharger); });
  const corps = el('div', {}, el('p', { classe: 'chargement', texte: 'Chargement du relevé…' }));
  zone.replaceChildren(
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-releve', texte: 'Relevé mensuel' }),
      el('div', { classe: 'champ champ-mois' }, el('label', { for: 'mois-releve', texte: 'Mois' }), choix)),
    corps);

  const { data: r, error } = await supabase.rpc('admin_releve_compte_pro', { p_compte: c.id, p_mois: `${etatFiche.mois}-01` });
  if (error) { corps.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  const t = r.totaux;
  const reste = Number(t.reste_a_payer);
  const nbAvoirs = r.lignes.reduce((n, l) => n + l.avoirs.length, 0);
  const actions = el('div', { classe: 'actions-ligne' },
    reste > 0 ? boutonAction(`Encaisser le relevé (${euros(reste)})`, () => encaisser(c, r, recharger), 'bouton-principal') : null,
    el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`clients/?entreprise=${c.id}&releve=${r.mois}`), texte: 'Relevé imprimable (PDF)' }),
    boutonAction('Exporter (CSV)', async () => exporterReleve(c, r)));

  // (éléments absents filtrés : replaceChildren écrirait « null »)
  corps.replaceChildren(...[
    el('p', { classe: 'sous-titre', texte: r.provisoire
      ? `Relevé provisoire : le mois de ${r.mois_lisible} n'est pas terminé. Les courses à venir s'y ajouteront.`
      : `Relevé de ${r.mois_lisible}, établi le ${dateCourte(r.date_releve)} · échéance le ${dateCourte(r.echeance)}.` }),
    el('dl', { classe: 'fiche-donnees totaux-releve' },
      ...ligne('Factures du mois', `${pluriel(r.lignes.length, 'facture', 'factures')} · ${euros(t.factures_ttc)} TTC`),
      ...ligne('Avoirs', nbAvoirs ? `− ${euros(t.avoirs_ttc)} (${pluriel(nbAvoirs, 'avoir', 'avoirs')}, sous la facture qu'ils corrigent)` : null),
      ...ligne('Total des factures', `${euros(t.montant_ttc)} TTC (${euros(t.montant_ht)} HT + ${euros(t.montant_tva)} TVA)`),
      ...ligne('Pourboires', Number(t.pourboires) > 0 ? `${euros(t.pourboires)} (hors TVA, reversés aux chauffeurs)` : null),
      ...ligne('Déjà réglé', euros(t.deja_regle)),
      ...ligne('Reste à payer', el('strong', { classe: reste > 0 ? 'texte-or' : 'texte-vert', texte: euros(reste) }))),
    actions,
    tableau({
      colonnes: [
        { titre: 'Facture', valeur: (l) => (l.type === 'avoir'
          ? el('span', {}, el('a', { href: lienAdmin(`finances/?avoir=${l.avoir_id}`), texte: l.numero }),
            el('span', { classe: 'secondaire', texte: `Avoir du ${dateCourte(l.date_emission)} sur ${l.facture_numero}` }))
          : el('span', {}, el('a', { href: lienAdmin(`finances/?facture=${l.facture_id}`), texte: l.numero }),
            el('span', { classe: 'secondaire', texte: l.nature === 'course' ? dateCourte(l.date_emission) : `Frais d'annulation · ${dateCourte(l.date_emission)}` }))) },
        { titre: 'Course', valeur: (l) => el('span', {}, el('a', { href: lienAdmin(`courses/?id=${l.course_id}`), texte: l.course_numero }),
          el('span', { classe: 'secondaire', texte: jourHeure(l.prise_en_charge_le) })) },
        { titre: 'Passager', valeur: (l) => (l.type === 'avoir' ? el('span', { classe: 'texte-gris', texte: l.motif }) : l.passager) },
        { titre: 'TTC', droite: true, valeur: (l) => (l.type === 'avoir' ? el('span', { classe: 'texte-rouge', texte: `− ${euros(l.montant_ttc)}` }) : euros(l.montant_ttc)) },
        { titre: 'Règlement', valeur: (l) => (l.type === 'avoir' ? badge(ORIGINES_AVOIR[l.origine] || l.origine, 'gris')
          : reglement(l.paiement_mode, l.paiement_statut, l.encaisse_le)) }
      ],
      lignes: lignesReleve(r), vide: `Aucune facture en ${r.mois_lisible}.`
    }),
    r.pourboires.length ? el('div', {},
      el('h3', { classe: 'sous-section', texte: 'Pourboires' }),
      el('ul', { classe: 'liste-simple' }, ...r.pourboires.map((p) => el('li', {},
        el('strong', { texte: euros(p.montant) }), ' · course ', el('a', { href: lienAdmin(`courses/?id=${p.course_id}`), texte: p.course_numero }),
        ' ', reglement(p.mode, p.statut, null),
        Number(p.rembourse) > 0 ? el('span', { classe: 'secondaire', texte: `dont ${euros(p.rembourse)} remboursé` }) : null)))) : null].filter(Boolean));
}

async function encaisser(c, r, recharger) {
  const reste = Number(r.totaux.reste_a_payer);
  const fait = await fenetreFormulaire({
    titre: `Encaisser le relevé de ${r.mois_lisible}`,
    intro: `Virement de ${euros(reste)} reçu de ${c.raison_sociale} ? Les ${r.totaux.paiements_a_encaisser} paiements de ce relevé passent « encaissés », à votre nom. Les gestionnaires du compte sont prévenus.`,
    champs: [{ nom: 'reference', libelle: 'Référence du virement', type: 'texte', longueur: 120, plein: true,
      aide: 'Lue sur le relevé de banque : elle permet de retrouver le virement.' }],
    libelle: `Encaisser ${euros(reste)}`,
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('admin_encaisser_releve', {
        p_compte: c.id, p_mois: `${r.mois}-01`, p_montant: reste, p_reference: v.reference
      });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage(`Relevé de ${r.mois_lisible} encaissé : ${euros(reste)}.`, 'succes'); await recharger(); }
}

function exporterReleve(c, r) {
  const lignes = [
    ...lignesReleve(r).map((l) => (l.type === 'avoir'
      ? { ...l, type: `Avoir (${(ORIGINES_AVOIR[l.origine] || l.origine).toLowerCase()}) sur ${l.facture_numero}`,
        montant_ht: -l.montant_ht, montant_tva: -l.montant_tva, montant_ttc: -l.montant_ttc,
        depart_adresse: '', arrivee_adresse: '', passager: l.motif, paiement_mode: null, paiement_statut: null, reference: '' }
      : { ...l, type: l.nature === 'course' ? 'Course' : 'Frais d\'annulation' })),
    ...r.pourboires.map((p) => ({ numero: '', date_emission: p.cree_le, type: 'Pourboire', course_numero: p.course_numero,
      prise_en_charge_le: null, passager: '', depart_adresse: '', arrivee_adresse: '', montant_ht: null, montant_tva: null,
      montant_ttc: Number(p.montant) - Number(p.rembourse || 0), paiement_mode: p.mode, paiement_statut: p.statut, reference: '' }))
  ];
  exporterCsv(`releve-${r.mois}-${c.raison_sociale.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}.csv`, [
    { titre: 'Pièce', csv: (l) => l.numero }, { titre: 'Type', csv: (l) => l.type },
    { titre: 'Date', csv: (l) => dateCourte(l.date_emission) }, { titre: 'Course', csv: (l) => l.course_numero },
    { titre: 'Prise en charge', csv: (l) => (l.prise_en_charge_le ? jourHeure(l.prise_en_charge_le) : '') },
    { titre: 'Passager ou motif', csv: (l) => l.passager }, { titre: 'Départ', csv: (l) => l.depart_adresse }, { titre: 'Arrivée', csv: (l) => l.arrivee_adresse },
    { titre: 'HT', csv: (l) => nombreCsv(l.montant_ht) }, { titre: 'TVA', csv: (l) => nombreCsv(l.montant_tva) },
    { titre: 'TTC', csv: (l) => nombreCsv(l.montant_ttc) },
    { titre: 'Règlement', csv: (l) => (!l.paiement_mode ? '' : l.paiement_mode !== 'facture_mensuelle' ? `Sur place (${MODES_PAIEMENT[l.paiement_mode] || l.paiement_mode})`
      : (REGLEMENTS[l.paiement_statut] || { libelle: l.paiement_statut || '' }).libelle) },
    { titre: 'Référence du virement', csv: (l) => l.reference || '' }
  ], lignes);
}

// ---------------------------------------------------------------------------
// Courses du compte
// ---------------------------------------------------------------------------
function sectionCourses(f) {
  return section('Courses', 'titre-courses-compte', tableau({
    colonnes: [
      { titre: 'Course', valeur: (x) => el('span', {}, el('a', { href: lienAdmin(`courses/?id=${x.id}`), texte: x.numero }),
        el('span', { classe: 'secondaire' }, badgeCourse(x.statut))) },
      { titre: 'Prise en charge', valeur: (x) => jourHeure(x.prise_en_charge_le) },
      { titre: 'Passager', valeur: (x) => el('span', {}, el('a', { href: lienAdmin(`clients/?id=${x.client_id}`), texte: x.client_nom || 'Client' }),
        x.pour_proche ? el('span', { classe: 'secondaire', texte: `pour ${x.beneficiaire_nom}` }) : null) },
      { titre: 'Trajet', valeur: (x) => el('span', { classe: 'trajet-court' }, el('span', { texte: x.depart_adresse }),
        el('span', { classe: 'secondaire', texte: `→ ${x.arrivee_adresse}` })) },
      { titre: 'Montant', droite: true, valeur: (x) => (x.statut === 'annulee' && !Number(x.frais_annulation) ? 'sans frais' : euros(montantCourse(x))) },
      { titre: 'Paiement', valeur: (x) => MODES_PAIEMENT[x.mode_paiement] || x.mode_paiement }
    ],
    lignes: f.courses, vide: 'Aucune course commandée au nom de cette entreprise pour le moment.'
  }));
}

// #############################################################################
// RELEVÉ IMPRIMABLE
// #############################################################################
export async function ouvrirReleve(id, mois) {
  $('onglets').hidden = true;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d{4}-\d{2}$/.test(mois)) { introuvable(); return; }
  $('entete-actions').replaceChildren(
    el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`clients/?entreprise=${id}`), texte: 'Retour à la fiche' }));
  const { data: r, error } = await supabase.rpc('admin_releve_compte_pro', { p_compte: id, p_mois: `${mois}-01` });
  if (error) {
    if (/introuvable/i.test(error.message || '')) introuvable();
    else $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) }));
    return;
  }
  const c = r.compte;
  const s = r.societe || {};
  document.title = `Relevé ${r.mois_lisible} · ${c.raison_sociale}`;
  $('titre-page').textContent = `Relevé de ${r.mois_lisible}`;
  const barre = barreDocument(boutonAction('Exporter (CSV)', async () => exporterReleve(c, r)));

  // Mentions manquantes : signalées à l'écran seulement (jamais imprimées)
  const avertissement = avertissementMentions([
    !s.siret ? 'le SIRET' : null, !s.tva_intracommunautaire ? 'le n° de TVA' : null,
    !s.iban || !s.bic ? 'l\'IBAN et le BIC (règlement par virement)' : null
  ].filter(Boolean));
  const provisoire = r.provisoire
    ? el('p', { classe: 'alerte non-imprimable', texte: `Le mois de ${r.mois_lisible} n'est pas terminé : ce relevé est provisoire (il porte la mention « provisoire » une fois imprimé).` })
    : null;

  $('contenu').replaceChildren(...[barre, avertissement, provisoire, documentReleve(r)].filter(Boolean));
}

function documentReleve(r) {
  const c = r.compte;
  const s = r.societe || {};
  const t = r.totaux;
  const reste = Number(t.reste_a_payer);
  const avoirs = Number(t.avoirs_ttc) > 0;

  const entete = enteteDocument({
    societe: s, titre: 'Relevé de factures',
    sousTitre: r.mois_lisible.charAt(0).toUpperCase() + r.mois_lisible.slice(1),
    mention: r.provisoire ? 'Provisoire : mois en cours' : null,
    dates: [['Établi le', dateCourte(r.date_releve)], ['Échéance', dateCourte(r.echeance)]]
  });
  const client = blocDestinataire({ nom: c.raison_sociale, lignes: lignesCompte(c) });

  // Chaque facture, suivie de ses avoirs (montants négatifs)
  const tableLignes = el('table', { classe: 'doc-table' },
    enteteTableau(['Pièce', 'Course', 'Passager', 'HT', 'TVA', 'TTC', 'Règlement'], [3, 4, 5]),
    el('tbody', {}, ...(r.lignes.length ? r.lignes.flatMap((l) => [
      el('tr', {},
        el('td', { classe: 'doc-numero' }, l.numero,
          el('span', { classe: 'doc-detail', texte: l.nature === 'frais_annulation' ? `Frais d'annulation · ${dateCourte(l.date_emission)}` : dateCourte(l.date_emission) })),
        el('td', {}, el('span', { classe: 'doc-numero', texte: l.course_numero }),
          el('span', { classe: 'doc-detail', texte: `${jourHeure(l.prise_en_charge_le)} · ${l.depart_adresse} → ${l.arrivee_adresse}` })),
        el('td', { texte: l.passager }),
        el('td', { classe: 'droite', texte: euros(l.montant_ht) }),
        el('td', { classe: 'droite' }, euros(l.montant_tva), el('span', { classe: 'doc-detail', texte: `${nombre(l.taux_tva, 2)} %` })),
        el('td', { classe: 'droite', texte: euros(l.montant_ttc) }),
        el('td', { texte: texteReglement(l.paiement_mode, l.paiement_statut, l.encaisse_le) })),
      ...l.avoirs.map((a) => el('tr', { classe: 'doc-ligne-avoir' },
        el('td', { classe: 'doc-numero' }, a.numero, el('span', { classe: 'doc-detail', texte: `Avoir du ${dateCourte(a.date_emission)}` })),
        el('td', { colspan: '2' }, `${ORIGINES_AVOIR[a.origine] || a.origine} : ${a.motif}`),
        el('td', { classe: 'droite', texte: `− ${euros(a.montant_ht)}` }),
        el('td', { classe: 'droite', texte: `− ${euros(a.montant_tva)}` }),
        el('td', { classe: 'droite', texte: `− ${euros(a.montant_ttc)}` }),
        el('td', { texte: a.origine === 'remboursement' ? 'Remboursé' : 'Non dû' })))
    ]) : [el('tr', {}, el('td', { colspan: '7', texte: `Aucune facture en ${r.mois_lisible}.` }))])));

  const pourboires = r.pourboires.length ? el('section', { classe: 'doc-bloc' },
    el('h3', { texte: 'Pourboires (hors TVA, reversés intégralement aux chauffeurs)' }),
    el('table', { classe: 'doc-table' },
      enteteTableau(['Date', 'Course', 'Montant', 'Règlement'], [2]),
      el('tbody', {}, ...r.pourboires.map((p) => el('tr', {},
        el('td', { texte: dateCourte(p.cree_le) }), el('td', { classe: 'doc-numero', texte: p.course_numero }),
        el('td', { classe: 'droite', texte: euros(Number(p.montant) - Number(p.rembourse || 0)) }),
        el('td', { texte: texteReglement(p.mode, p.statut, null) })))))) : null;

  const totaux = blocTotaux([
    ['Total HT', euros(t.montant_ht)],
    ...r.tva_par_taux.map((x) => [`TVA ${nombre(x.taux, 2)} % sur ${euros(x.montant_ht)}`, euros(x.montant_tva)]),
    avoirs ? ['Factures TTC', euros(t.factures_ttc)] : null,
    avoirs ? ['Avoirs TTC', `− ${euros(t.avoirs_ttc)}`] : null,
    ['Total TTC des factures', euros(t.montant_ttc)],
    Number(t.pourboires) > 0 ? ['Pourboires', euros(t.pourboires)] : null,
    ['Total du mois', euros(t.total)],
    ['Déjà réglé', euros(t.deja_regle)],
    'trait',
    ['Reste à payer', euros(reste), true]
  ]);

  const reglementBloc = el('section', { classe: 'doc-bloc doc-reglement' },
    el('h3', { texte: 'Règlement' }),
    reste > 0
      ? el('p', { texte: `Merci de régler ${euros(reste)} par virement au plus tard le ${dateCourte(r.echeance)}, en indiquant la référence « ${c.raison_sociale} ${r.mois} ».` })
      : el('p', { texte: 'Ce relevé est entièrement réglé. Merci.' }),
    reste > 0 && s.iban ? el('p', { classe: 'doc-iban' }, el('strong', { texte: 'IBAN ' }), ibanLisible(s.iban),
      s.bic ? el('span', {}, el('strong', { texte: '  BIC ' }), s.bic) : null) : null,
    el('p', { classe: 'doc-detail', texte: 'Chaque course fait l\'objet d\'une facture numérotée, disponible sur demande ; ce relevé les récapitule pour un règlement unique. Un avoir corrige la facture sous laquelle il figure.' }),
    s.mentions_factures ? el('p', { classe: 'doc-mentions', texte: s.mentions_factures }) : null);

  return el('article', { classe: 'doc', 'aria-label': `Relevé de factures de ${r.mois_lisible}` },
    entete, client, ...tableauDefilant(tableLignes), pourboires, totaux, reglementBloc);
}

// Règlement en toutes lettres (document imprimé)
function texteReglement(mode, statut, encaisseLe) {
  if (!mode) return 'Rien à payer';
  if (mode !== 'facture_mensuelle') return `Réglé sur place (${(MODES_PAIEMENT[mode] || mode).toLowerCase()})`;
  if (statut === 'encaisse') return encaisseLe ? `Payé le ${dateCourte(encaisseLe)}` : 'Payé';
  if (statut === 'a_encaisser') return 'À payer';
  return (REGLEMENTS[statut] || { libelle: statut }).libelle;
}
