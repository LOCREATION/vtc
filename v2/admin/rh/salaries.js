// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : RH et paie — salariés
// -----------------------------------------------------------------------------
//   - liste : en poste, entrées à venir, sortis ; contrat, salaire, congés au
//     dernier bulletin validé, compte de l'application rattaché ;
//   - fiche (création, modification) : contrôles de la base (n° de Sécurité
//     sociale et sa clé, salaire au moins égal au SMIC, temps partiel) ;
//   - dossier (?salarie=…) : fiche, ce qui manque pour établir un contrat,
//     contrats (établir, remettre pour signature, classer le PDF signé,
//     terminer, supprimer un contrat non signé), bulletins, congés,
//     reprise d'une paie faite ailleurs.
// Lectures et actions : admin_lister_salaries, admin_dossier_salarie,
// admin_enregistrer_salarie, admin_enregistrer_reprise, admin_statut_contrat,
// admin_classer_contrat ; suppressions directes (administration).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  tableau, tuile, boutonAction, fenetreFormulaire, confirmer, messageErreurAdmin, ouvrirPiece, dateCourte, jourParis,
  ligne, erreurIban, erreurBic, sansEspaces, ibanLisible, exporterCsv, boutonExporter
} from '../commun/composants.js';
import { nomFichier } from '../commun/listes.js';
import {
  TYPES_CONTRAT, TEMPS, STATUTS_SALARIE, STATUTS_CONTRAT, STATUTS_BULLETIN, TYPES_ABSENCE, STATUTS_ABSENCE, pastille, decimal,
  heures, joursConges, nssLisible, erreurNss, montant, debutMois, moisEnLettres, deMois, moisVoisin, tauxExact
} from './commun-rh.js';
import { formulaireContrat } from './contrat.js';

const $ = (id) => document.getElementById(id);
const etat = { donnees: null, dossier: null };

// #############################################################################
// LISTE
// #############################################################################
export async function afficherSalaries() {
  const ajouter = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Ajouter un salarié' });
  ajouter.addEventListener('click', () => formulaireFiche(null));
  $('entete-actions').replaceChildren(ajouter, boutonExporter(exporter));
  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-salaries', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-salaries' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-salaries', texte: 'Salariés' })),
      el('p', { classe: 'aide-module', texte: 'Ouvrez un salarié pour son dossier : contrat de travail établi depuis sa fiche, bulletins, congés. Un salarié payé ailleurs jusqu\'ici : saisissez une fois la reprise de ses cumuls de l\'année dans son dossier.' }),
      el('div', { id: 'liste-salaries' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))));
  await charger();
}

async function charger() {
  const zone = $('liste-salaries');
  const { data, error } = await supabase.rpc('admin_lister_salaries');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.donnees = data;
  const enPoste = data.lignes.filter((s) => s.statut === 'en_poste');
  const masse = enPoste.reduce((n, s) => n + Number(s.salaire_base_mensuel || 0), 0);
  const demandes = data.lignes.reduce((n, s) => n + Number(s.demandes || 0), 0);
  const sansContrat = enPoste.filter((s) => !s.contrat || !['signe', 'termine'].includes(s.contrat.statut));
  $('chiffres-salaries').replaceChildren(
    tuile('En poste', String(enPoste.length), `${enPoste.filter((s) => s.temps === 'partiel').length} à temps partiel · `
      + `${enPoste.filter((s) => s.type_contrat === 'CDD').length} en CDD`),
    tuile('Salaires de base', montant(masse), 'total mensuel brut des salariés en poste'),
    tuile('Contrats à faire signer', String(sansContrat.length), sansContrat.length ? sansContrat.map((s) => s.nom).join(', ') : 'tous les contrats sont classés',
      sansContrat.length ? 'or' : null),
    tuile('Demandes de congés', String(demandes), demandes ? 'à traiter dans « Congés et absences »' : 'aucune demande en attente', demandes ? 'or' : null));

  $('liste-salaries').replaceChildren(tableau({
    colonnes: [
      { titre: 'Salarié', valeur: (s) => el('span', {}, el('strong', { texte: s.nom }),
        el('span', { classe: 'secondaire', texte: `${s.matricule} · ${s.emploi}${s.cadre ? ' · cadre' : ''}` })) },
      { titre: 'Contrat', valeur: (s) => el('span', {}, `${TYPES_CONTRAT[s.type_contrat]} · ${TEMPS[s.temps].toLowerCase()}`,
        el('span', { classe: 'secondaire', texte: `${heures(s.heures_mensuelles)} par mois` })) },
      { titre: 'Dates', valeur: (s) => el('span', {}, pastille(STATUTS_SALARIE, s.statut),
        el('span', { classe: 'secondaire', texte: `entrée le ${dateCourte(s.date_entree)}${s.date_sortie ? `, sortie le ${dateCourte(s.date_sortie)}` : ''}` })) },
      { titre: 'Salaire de base', droite: true, valeur: (s) => montant(s.salaire_base_mensuel) },
      { titre: 'Contrat de travail', valeur: (s) => (s.contrat
        ? el('span', {}, pastille(STATUTS_CONTRAT, s.contrat.statut), el('span', { classe: 'secondaire', texte: TYPES_CONTRAT[s.contrat.type] }))
        : el('span', { classe: s.manquants_contrat ? 'texte-or' : 'texte-gris', texte: s.manquants_contrat ? 'À établir : fiche incomplète' : 'À établir' })) },
      { titre: 'Congés', valeur: (s) => (s.conges
        ? el('span', {}, `N-1 ${joursConges(s.conges.n1_solde)} · N ${joursConges(s.conges.n_solde)}`,
          el('span', { classe: 'secondaire', texte: `fin ${moisEnLettres(s.conges.au)}` }))
        : el('span', { classe: 'texte-gris', texte: 'aucun bulletin validé' })) },
      { titre: 'Compte', valeur: (s) => (s.compte ? s.compte.nom || 'Compte rattaché' : el('span', { classe: 'texte-gris', texte: 'aucun' })) }
    ],
    lignes: data.lignes,
    vide: 'Aucun salarié. Ajoutez le premier avec « Ajouter un salarié ».',
    clicLigne: (s) => { location.href = lienAdmin(`rh/?salarie=${s.id}`); },
    libelleLigne: (s) => `Ouvrir le dossier de ${s.nom}`
  }));
}

function exporter() {
  if (!etat.donnees || !etat.donnees.lignes.length) { afficherMessage('Aucun salarié à exporter.'); return; }
  exporterCsv(`${nomFichier('salaries', jourParis())}.csv`, [
    { titre: 'Matricule', csv: (s) => s.matricule }, { titre: 'Nom', csv: (s) => s.nom_famille }, { titre: 'Prénom', csv: (s) => s.prenom },
    { titre: 'Emploi', csv: (s) => s.emploi }, { titre: 'Cadre', csv: (s) => (s.cadre ? 'oui' : 'non') },
    { titre: 'Contrat', csv: (s) => TYPES_CONTRAT[s.type_contrat] }, { titre: 'Temps', csv: (s) => TEMPS[s.temps] },
    { titre: 'Heures par mois', csv: (s) => String(s.heures_mensuelles).replace('.', ',') },
    { titre: 'Entrée', csv: (s) => dateCourte(s.date_entree) }, { titre: 'Sortie', csv: (s) => (s.date_sortie ? dateCourte(s.date_sortie) : '') },
    { titre: 'Salaire de base', csv: (s) => String(s.salaire_base_mensuel).replace('.', ',') },
    { titre: 'Statut', csv: (s) => STATUTS_SALARIE[s.statut].libelle }
  ], etat.donnees.lignes);
}

// #############################################################################
// FICHE (création, modification)
// #############################################################################
export async function formulaireFiche(fiche, comptes = null) {
  if (!comptes) {
    const { data, error } = await supabase.rpc('admin_lister_salaries');
    if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return null; }
    comptes = data.comptes;
  }
  const s = fiche || { temps: 'plein', type_contrat: 'CDI', emploi: 'Conducteur de VTC', date_entree: jourParis() };
  const listeComptes = [...comptes];
  if (fiche && fiche.profil_id && !listeComptes.some((c) => c.id === fiche.profil_id)) {
    listeComptes.unshift({ id: fiche.profil_id, nom: 'Compte actuellement rattaché', role: '' });
  }
  const valeurs = {
    ...s, numero_securite_sociale: s.numero_securite_sociale ? nssLisible(s.numero_securite_sociale) : null,
    iban: s.iban ? ibanLisible(s.iban) : null, salaire_base_mensuel: s.salaire_base_mensuel ?? null, taux_horaire: s.taux_horaire ?? null
  };
  return fenetreFormulaire({
    titre: fiche ? `Fiche de ${s.prenom} ${s.nom}` : 'Nouveau salarié',
    intro: 'Ces informations sont reprises sur le contrat de travail et les bulletins de paie : recopiez-les depuis la pièce d\'identité, la carte Vitale et le RIB du salarié.',
    large: true,
    champs: [
      { nom: 'civilite', libelle: 'Civilité', type: 'choix', options: [{ valeur: 'Madame', libelle: 'Madame' }, { valeur: 'Monsieur', libelle: 'Monsieur' }] },
      { nom: 'prenom', libelle: 'Prénom', type: 'texte', requis: true, longueur: 80 },
      { nom: 'nom', libelle: 'Nom', type: 'texte', requis: true, longueur: 80 },
      { nom: 'date_naissance', libelle: 'Date de naissance', type: 'date' },
      { nom: 'lieu_naissance', libelle: 'Lieu de naissance', type: 'texte', longueur: 120 },
      { nom: 'nationalite', libelle: 'Nationalité', type: 'texte', longueur: 60 },
      { nom: 'numero_securite_sociale', libelle: 'N° de Sécurité sociale (avec la clé)', type: 'texte', longueur: 25,
        normaliser: (v) => v.replace(/[\s.\-]/g, ''), controle: erreurNss, aide: '15 chiffres, comme sur la carte Vitale. Espaces acceptés.' },
      { nom: 'adresse', libelle: 'Adresse', type: 'texte', longueur: 200, plein: true },
      { nom: 'code_postal', libelle: 'Code postal', type: 'texte', longueur: 10 },
      { nom: 'ville', libelle: 'Ville', type: 'texte', longueur: 80 },
      { nom: 'emploi', libelle: 'Emploi', type: 'texte', requis: true, longueur: 120 },
      { nom: 'qualification', libelle: 'Qualification (classification)', type: 'texte', longueur: 120, aide: 'Ex. employé, agent de maîtrise, cadre.' },
      { nom: 'niveau', libelle: 'Niveau', type: 'texte', longueur: 40 },
      { nom: 'coefficient', libelle: 'Coefficient', type: 'texte', longueur: 40 },
      { nom: 'cadre', libelle: 'Statut cadre (Apec, prévoyance des cadres)', type: 'case' },
      { nom: 'convention_collective', libelle: 'Convention collective propre au salarié', type: 'texte', longueur: 200, plein: true,
        aide: 'Laissez vide : celle de l\'entreprise (Paramètres, Entreprise) s\'applique.' },
      { nom: 'type_contrat', libelle: 'Contrat', type: 'choix', requis: true,
        options: ['CDI', 'CDD', 'apprentissage'].map((t) => ({ valeur: t, libelle: TYPES_CONTRAT[t] })) },
      { nom: 'temps', libelle: 'Durée du travail', type: 'choix', requis: true,
        options: [{ valeur: 'plein', libelle: 'Temps plein (35 h, 151,67 h par mois)' }, { valeur: 'partiel', libelle: 'Temps partiel' }] },
      { nom: 'heures_mensuelles', libelle: 'Heures par mois (temps partiel)', type: 'nombre', min: 1, max: 151.66,
        aide: '24 h par semaine = 104 h par mois (heures par semaine × 52 / 12).' },
      { nom: 'repartition_horaire', libelle: 'Répartition des heures (temps partiel)', type: 'zone', longueur: 500, plein: true,
        aide: 'Mention obligatoire du contrat : jours et horaires de travail (ex. « du lundi au jeudi, de 7 h à 13 h »).' },
      { nom: 'lieu_travail', libelle: 'Lieu de travail', type: 'texte', longueur: 200, plein: true,
        aide: 'Ex. « Île-de-France, au départ du dépôt de Chaumontel ».' },
      { nom: 'date_entree', libelle: 'Date d\'entrée', type: 'date', requis: true },
      { nom: 'date_sortie', libelle: 'Date de sortie', type: 'date' },
      { nom: 'motif_sortie', libelle: 'Motif de la sortie', type: 'texte', longueur: 200,
        aide: 'Fin de CDD, démission, rupture conventionnelle, licenciement, fin de période d\'essai…' },
      { nom: 'salaire_base_mensuel', libelle: 'Salaire de base mensuel brut (€)', type: 'nombre', min: 0.01,
        aide: 'Le taux horaire exact en est déduit (jamais arrondi au centime).' },
      { nom: 'taux_horaire', libelle: 'Ou taux horaire brut (€)', type: 'nombre', min: 0.01, aide: 'Seulement si le salaire n\'est pas mensualisé.' },
      { nom: 'taux_pas', libelle: 'Taux de prélèvement à la source (%)', type: 'nombre', min: 0, max: 60,
        aide: 'Taux transmis par l\'administration fiscale (compte rendu de la déclaration sociale). Vide : taux neutre.' },
      { nom: 'iban', libelle: 'IBAN du salarié', type: 'texte', longueur: 42, majuscules: true, normaliser: sansEspaces, controle: erreurIban, plein: true },
      { nom: 'bic', libelle: 'BIC', type: 'texte', longueur: 11, majuscules: true, normaliser: sansEspaces, controle: erreurBic },
      { nom: 'profil_id', libelle: 'Compte de l\'application', type: 'choix', vide: 'Aucun compte',
        options: listeComptes.map((c) => ({ valeur: c.id, libelle: `${c.nom}${c.role === 'admin' ? ' (administration)' : c.role === 'chauffeur' ? ' (chauffeur)' : ''}` })),
        aide: 'Le salarié retrouve alors ses bulletins et fait ses demandes de congés dans l\'application.' }
    ],
    valeurs,
    libelle: fiche ? 'Enregistrer' : 'Créer la fiche',
    preparer: (elements) => {
      // Champs du temps partiel et de la sortie : visibles seulement quand ils servent
      const bloc = (nom) => elements[nom].saisie.closest('.champ');
      const basculer = () => {
        const partiel = elements.temps.saisie.value === 'partiel';
        bloc('heures_mensuelles').hidden = !partiel;
        bloc('repartition_horaire').hidden = !partiel;
        bloc('motif_sortie').hidden = !elements.date_sortie.saisie.value;
      };
      elements.temps.saisie.addEventListener('change', basculer);
      elements.date_sortie.saisie.addEventListener('change', basculer);
      basculer();
    },
    enregistrer: async (v) => {
      const fichePaie = { ...v };
      if (v.temps === 'plein') { fichePaie.heures_mensuelles = 151.67; fichePaie.repartition_horaire = null; }
      if (!v.date_sortie) fichePaie.motif_sortie = null;
      const { data, error } = await supabase.rpc('admin_enregistrer_salarie', { p_salarie: fiche ? fiche.id : null, p_fiche: fichePaie });
      if (error) throw error;
      return data;
    }
  });
}

// #############################################################################
// DOSSIER D'UN SALARIÉ
// #############################################################################
export async function ouvrirDossier(id) {
  $('onglets').hidden = true;
  $('entete-actions').replaceChildren(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin('rh/'), texte: 'Salariés' }));
  if (!/^[0-9a-f-]{36}$/i.test(id)) { introuvable(); return; }
  const { data, error } = await supabase.rpc('admin_dossier_salarie', { p_salarie: id });
  if (error) {
    if (/introuvable/i.test(error.message || '')) introuvable();
    else $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) }));
    return;
  }
  etat.dossier = data;
  const s = data.salarie;
  document.title = `${s.prenom} ${s.nom}, RH et paie, LOC RÉACTION`;
  $('titre-page').textContent = `${s.prenom} ${s.nom}`;
  const modifier = boutonAction('Modifier la fiche', async () => {
    const fait = await formulaireFiche(s, data.comptes);
    if (fait) { afficherMessage('Fiche enregistrée.', 'succes'); ouvrirDossier(id); }
  }, 'bouton-principal');
  $('entete-actions').replaceChildren(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin('rh/'), texte: 'Salariés' }), modifier);

  $('contenu').replaceChildren(
    blocFiche(data),
    blocContrats(data),
    blocBulletins(data),
    blocConges(data),
    blocReprise(data));
}

function introuvable() {
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('p', { texte: 'Salarié introuvable.' }), el('a', { href: lienAdmin('rh/'), texte: 'Retour à la liste des salariés' })));
}

function blocFiche(d) {
  const s = d.salarie;
  const taux = s.salaire_base_mensuel !== null ? tauxExact(s.salaire_base_mensuel, s.heures_mensuelles) : Number(s.taux_horaire);
  const base = s.salaire_base_mensuel !== null ? Number(s.salaire_base_mensuel) : Math.round(Number(s.taux_horaire) * Number(s.heures_mensuelles) * 100) / 100;
  const convention = s.convention_collective || (d.societe && d.societe.convention_collective);
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-fiche' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-fiche', texte: 'Fiche' }), pastille(STATUTS_SALARIE,
      s.date_entree > jourParis() ? 'a_venir' : s.date_sortie && s.date_sortie < jourParis() ? 'sorti' : 'en_poste')),
    d.manquants_contrat.length ? el('p', { classe: 'alerte' }, `Pour établir un contrat sans aucun champ à compléter, renseignez : ${d.manquants_contrat.join(' ; ')}.`) : null,
    el('div', { classe: 'grille-2' },
      el('dl', { classe: 'fiche-donnees' },
        ...ligne('Matricule', s.matricule),
        ...ligne('Emploi', `${s.emploi}${s.qualification ? `, ${s.qualification}` : ''}${s.niveau ? `, niveau ${s.niveau}` : ''}${s.coefficient ? `, coefficient ${s.coefficient}` : ''}`),
        ...ligne('Statut', s.cadre ? 'Cadre' : 'Non cadre'),
        ...ligne('Contrat', `${TYPES_CONTRAT[s.type_contrat]}, ${TEMPS[s.temps].toLowerCase()} (${heures(s.heures_mensuelles)} par mois)`),
        ...ligne('Répartition', s.temps === 'partiel' ? s.repartition_horaire || el('span', { classe: 'texte-or', texte: 'À compléter' }) : null),
        ...ligne('Entrée', dateCourte(s.date_entree)),
        ...ligne('Sortie', s.date_sortie ? `${dateCourte(s.date_sortie)}${s.motif_sortie ? ` (${s.motif_sortie})` : ''}` : null),
        ...ligne('Salaire de base', `${montant(base)} brut par mois, soit ${decimal(taux, 4, 6)} € de l'heure`),
        ...ligne('Prélèvement à la source', s.taux_pas !== null ? `taux personnalisé ${decimal(s.taux_pas, 1, 2)} %` : 'taux neutre (aucun taux transmis)'),
        ...ligne('Convention', convention || el('span', { classe: 'texte-or', texte: 'À indiquer (Paramètres, Entreprise)' })),
        ...ligne('Lieu de travail', s.lieu_travail)),
      el('dl', { classe: 'fiche-donnees' },
        ...ligne('Né(e) le', s.date_naissance ? `${dateCourte(s.date_naissance)}${s.lieu_naissance ? ` à ${s.lieu_naissance}` : ''}` : null),
        ...ligne('Nationalité', s.nationalite),
        ...ligne('Sécurité sociale', s.numero_securite_sociale ? nssLisible(s.numero_securite_sociale) : el('span', { classe: 'texte-or', texte: 'À compléter' })),
        ...ligne('Adresse', [s.adresse, [s.code_postal, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ')),
        ...ligne('IBAN', s.iban ? el('span', { classe: 'mono', texte: `${ibanLisible(s.iban)}${s.bic ? ` · ${s.bic}` : ''}` }) : null),
        ...ligne('Compte', d.compte ? `${d.compte.nom || 'Sans nom'}${d.compte.email ? ` · ${d.compte.email}` : ''}` : 'aucun compte de l\'application'))));
}

// ---------------------------------------------------------------------------
// Contrats de travail
// ---------------------------------------------------------------------------
function blocContrats(d) {
  const s = d.salarie;
  const etablir = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Établir un contrat ou un avenant' });
  etablir.addEventListener('click', async () => {
    const cree = await formulaireContrat(s, d.manquants_contrat);
    if (cree) location.href = lienAdmin(`rh/?contrat=${cree.id}`);
  });
  const ailleurs = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Classer un contrat signé ailleurs' });
  ailleurs.addEventListener('click', () => classerContrat(null));
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-contrats' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-contrats', texte: 'Contrats de travail' }),
      el('div', { classe: 'actions-ligne' }, etablir, ailleurs)),
    el('p', { classe: 'aide-module', texte: 'Le contrat est établi depuis la fiche et l\'identité de l\'entreprise : imprimez-le, faites-le signer en deux exemplaires, puis classez ici le PDF signé (scanner ou application de numérisation du téléphone). Un contrat d\'apprentissage (formulaire Cerfa) ou signé avant l\'application se classe avec « Classer un contrat signé ailleurs ».' }),
    tableau({
      colonnes: [
        { titre: 'Contrat', valeur: (k) => el('span', {}, el('strong', { texte: TYPES_CONTRAT[k.type] }),
          el('span', { classe: 'secondaire', texte: k.externe ? 'signé ailleurs' : k.motif || k.objet || (k.type === 'CDI' ? 'durée indéterminée' : '') })) },
        { titre: 'Dates', valeur: (k) => el('span', {}, `${k.type === 'avenant' ? 'effet le' : 'du'} ${dateCourte(k.date_debut)}${k.date_fin ? ` au ${dateCourte(k.date_fin)}` : ''}`,
          k.essai_fin ? el('span', { classe: 'secondaire', texte: `essai jusqu'au ${dateCourte(k.essai_fin)}` }) : null) },
        { titre: 'État', valeur: (k) => el('span', {}, pastille(STATUTS_CONTRAT, k.statut),
          k.signe_le ? el('span', { classe: 'secondaire', texte: `classé le ${dateCourte(k.signe_le)}` }) : null) },
        { titre: '', valeur: (k) => actionsContrat(k) }
      ],
      lignes: d.contrats,
      vide: d.manquants_contrat.length ? 'Aucun contrat. Complétez d\'abord ce qui manque (ci-dessus), puis établissez le contrat.' : 'Aucun contrat : établissez-le avec le bouton ci-dessus.'
    }));
}

function actionsContrat(k) {
  const boutons = [];
  if (!k.externe) boutons.push(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`rh/?contrat=${k.id}`), texte: 'Voir, imprimer' }));
  if (k.statut === 'brouillon') boutons.push(boutonAction('Remis pour signature', () => statutContrat(k, 'envoye')));
  if (k.statut === 'brouillon' || k.statut === 'envoye') boutons.push(boutonAction('Classer le PDF signé', () => classerContrat(k)));
  if (k.pdf_chemin) boutons.push(boutonAction('PDF signé', () => voirPdf(k.pdf_chemin)));
  if (k.statut === 'signe') boutons.push(boutonAction('Terminer', () => statutContrat(k, 'termine')));
  if (k.statut === 'brouillon' || k.statut === 'envoye') boutons.push(boutonAction('Supprimer', () => supprimerContrat(k), 'bouton-danger'));
  return el('span', { classe: 'actions-ligne' }, ...boutons);
}

async function statutContrat(k, statut) {
  if (statut === 'termine') {
    const ok = await confirmer({ titre: 'Terminer ce contrat ?', texte: 'À faire à la sortie du salarié (ou quand un avenant le remplace). Le contrat reste classé dans le dossier.', libelle: 'Terminer' });
    if (!ok) return;
  }
  const { error } = await supabase.rpc('admin_statut_contrat', { p_contrat: k.id, p_statut: statut });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(statut === 'envoye' ? 'Contrat noté comme remis pour signature.' : 'Contrat terminé.', 'succes');
  ouvrirDossier(etat.dossier.salarie.id);
}

async function supprimerContrat(k) {
  const ok = await confirmer({ titre: 'Supprimer ce contrat non signé ?', texte: 'Il reste lisible dans le journal des modifications. Un nouveau contrat peut être établi à tout moment.', libelle: 'Supprimer', danger: true });
  if (!ok) return;
  const { error } = await supabase.from('contrats').delete().eq('id', k.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Contrat supprimé.', 'succes');
  ouvrirDossier(etat.dossier.salarie.id);
}

// Classer un PDF signé : le contrat établi ici (k), ou un contrat signé ailleurs (k = null)
async function classerContrat(k) {
  const s = etat.dossier.salarie;
  const fichier = el('input', { id: 'contrat-pdf', classe: 'saisie', type: 'file', accept: '.pdf,application/pdf', required: true });
  const fait = await fenetreFormulaire({
    titre: k ? `Contrat signé de ${s.prenom} ${s.nom}` : 'Classer un contrat signé ailleurs',
    intro: k ? 'Le PDF signé par les deux parties est rangé dans le dossier privé de la paie ; le salarié le retrouve dans son espace s\'il a un compte.'
      : 'Contrat d\'apprentissage (Cerfa), ou contrat signé avant l\'application : indiquez ses dates, puis joignez le PDF signé.',
    champs: k ? [] : [
      { nom: 'type', libelle: 'Type', type: 'choix', requis: true, options: Object.entries(TYPES_CONTRAT).map(([valeur, libelle]) => ({ valeur, libelle })) },
      { nom: 'debut', libelle: 'Début (ou date d\'effet)', type: 'date', requis: true },
      { nom: 'fin', libelle: 'Fin (CDD, apprentissage)', type: 'date' }
    ],
    valeurs: k ? {} : { type: s.type_contrat, debut: s.date_entree },
    avant: [el('div', { classe: 'champ' }, el('label', { for: 'contrat-pdf', texte: 'PDF signé (10 Mo au plus)' }), fichier)],
    libelle: 'Classer',
    enregistrer: async (v) => {
      const choisi = fichier.files[0];
      if (!choisi) throw new Error('Choisissez le PDF signé.');
      if (choisi.size > 10 * 1024 * 1024) throw new Error('Fichier trop lourd : 10 Mo au plus.');
      if (choisi.type && choisi.type !== 'application/pdf') throw new Error('Format refusé : le contrat signé se classe en PDF (scanner ou application de numérisation du téléphone).');
      const type = k ? k.type : v.type;
      const debut = k ? k.date_debut : v.debut;
      const chemin = `${s.id}/contrats/${nomFichier(type, debut)}-${Date.now()}.pdf`;
      const envoi = await supabase.storage.from('paie').upload(chemin, choisi, { contentType: 'application/pdf', upsert: false });
      if (envoi.error) throw envoi.error;
      const { data, error } = await supabase.rpc('admin_classer_contrat', k
        ? { p_contrat: k.id, p_chemin: chemin }
        : { p_contrat: null, p_chemin: chemin, p_salarie: s.id, p_type: v.type, p_date_debut: v.debut, p_date_fin: v.fin });
      if (error) { await supabase.storage.from('paie').remove([chemin]); throw error; }
      if (data) await supabase.storage.from('paie').remove([data]);
    }
  });
  if (fait) { afficherMessage('Contrat signé classé.', 'succes'); ouvrirDossier(s.id); }
}

async function voirPdf(chemin) {
  try { await ouvrirPiece('paie', chemin); } catch (erreur) { afficherMessage(messageErreurAdmin(erreur), 'erreur'); }
}

// ---------------------------------------------------------------------------
// Bulletins
// ---------------------------------------------------------------------------
function blocBulletins(d) {
  const s = d.salarie;
  const dernier = d.bulletins[0];
  const prochain = dernier ? moisVoisin(dernier.periode, 1) : (d.reprise ? moisVoisin(d.reprise.mois, 1) : debutMois(s.date_entree));
  const preparer = el('a', { classe: 'bouton bouton-principal bouton-petit', href: lienAdmin(`rh/?preparer=${s.id}&periode=${prochain}`),
    texte: `Préparer ${moisEnLettres(prochain)}` });
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-bulletins' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-bulletins', texte: 'Bulletins de paie' }),
      !s.date_sortie || prochain <= s.date_sortie ? preparer : null),
    tableau({
      colonnes: [
        { titre: 'Mois', valeur: (b) => el('strong', { texte: moisEnLettres(b.periode) }) },
        { titre: 'État', valeur: (b) => pastille(STATUTS_BULLETIN, b.statut) },
        { titre: 'Brut', droite: true, valeur: (b) => montant(b.brut) },
        { titre: 'Net à payer', droite: true, valeur: (b) => el('strong', { texte: montant(b.net_a_payer) }) },
        { titre: 'Coût employeur', droite: true, valeur: (b) => montant(b.cout_employeur) }
      ],
      lignes: d.bulletins,
      vide: 'Aucun bulletin établi ici.',
      clicLigne: (b) => { location.href = lienAdmin(b.statut === 'brouillon' ? `rh/?preparer=${s.id}&periode=${b.periode}` : `rh/?bulletin=${b.id}`); },
      libelleLigne: (b) => `Bulletin ${deMois(b.periode)}`
    }));
}

// ---------------------------------------------------------------------------
// Congés et absences
// ---------------------------------------------------------------------------
function blocConges(d) {
  const c = d.conges;
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-conges' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-conges', texte: 'Congés et absences' }),
      el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`rh/?vue=absences&salarie=${d.salarie.id}`), texte: 'Gérer les absences' })),
    c ? el('p', { classe: 'resume-liste' },
      'Au dernier bulletin (', moisEnLettres(c.au), ') : ',
      el('strong', { texte: joursConges(c.n1_solde) }), ' à prendre de la période précédente, ',
      el('strong', { texte: joursConges(c.n_solde) }), ` acquis depuis le ${dateCourte(c.reference)}`)
      : el('p', { classe: 'aide-module', texte: d.reprise ? `Soldes repris à fin ${moisEnLettres(d.reprise.mois)} : ${joursConges(d.reprise.cp_n1)} (N-1) et ${joursConges(d.reprise.cp_n)} (N).`
        : 'Les congés se calculent à chaque bulletin validé : 2,5 jours ouvrables par mois.' }),
    tableau({
      colonnes: [
        { titre: 'Absence', valeur: (a) => pastille(TYPES_ABSENCE, a.type) },
        { titre: 'Dates', valeur: (a) => `du ${dateCourte(a.debut)} au ${dateCourte(a.fin)}` },
        { titre: 'Jours', droite: true, valeur: (a) => decimal(a.jours, 0, 1) },
        { titre: 'État', valeur: (a) => pastille(STATUTS_ABSENCE, a.statut) }
      ],
      lignes: d.absences,
      vide: 'Aucune absence enregistrée.'
    }));
}

// ---------------------------------------------------------------------------
// Reprise d'une paie faite ailleurs
// ---------------------------------------------------------------------------
const CUMULS = [
  { nom: 'brut', libelle: 'Salaire brut' }, { nom: 'heures', libelle: 'Heures payées', heures: true },
  { nom: 'net_imposable', libelle: 'Net imposable' }, { nom: 'net_social', libelle: 'Montant net social' },
  { nom: 'cotisations_salariales', libelle: 'Cotisations salariales' }, { nom: 'cotisations_patronales', libelle: 'Cotisations patronales' },
  { nom: 'allegements', libelle: 'Allègements de cotisations' }, { nom: 'rgdu', libelle: 'Réduction générale appliquée' },
  { nom: 'pas', libelle: 'Impôt prélevé à la source' }, { nom: 'net_a_payer', libelle: 'Net payé' },
  { nom: 'cout_employeur', libelle: 'Coût total employeur' }, { nom: 'heures_sup', libelle: 'Heures supplémentaires', heures: true },
  { nom: 'hs_exonerees', libelle: 'Heures supplémentaires exonérées (net)' }
];

function blocReprise(d) {
  const r = d.reprise;
  const bouton = boutonAction(r ? 'Corriger la reprise' : 'Saisir la reprise', () => formulaireReprise(d));
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-reprise' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-reprise', texte: 'Reprise d\'une paie faite ailleurs' }), d.bulletins.length && !r ? null : bouton),
    el('p', { classe: 'aide-module', texte: 'Pour un salarié payé ailleurs jusqu\'ici (cabinet, autre logiciel) : recopiez une fois les cumuls de l\'année et les soldes de congés de son dernier bulletin. Ils servent aux cumuls du bulletin, à la réduction générale (calculée sur l\'année) et au plafond d\'exonération des heures supplémentaires.' }),
    r ? el('dl', { classe: 'fiche-donnees' },
      ...ligne('Dernier mois payé ailleurs', moisEnLettres(r.mois)),
      ...CUMULS.filter((c) => r.cumuls[c.nom] !== undefined).flatMap((c) => ligne(c.libelle, c.heures ? heures(r.cumuls[c.nom]) : montant(r.cumuls[c.nom]))),
      ...ligne('Congés N-1 / N', `${joursConges(r.cp_n1)} / ${joursConges(r.cp_n)}`),
      ...ligne('Note', r.note)) : null);
}

async function formulaireReprise(d) {
  const s = d.salarie;
  const r = d.reprise;
  const valeurs = { mois: r ? r.mois : null, cp_n1: r ? r.cp_n1 : 0, cp_n: r ? r.cp_n : 0, note: r ? r.note : null };
  CUMULS.forEach((c) => { valeurs[c.nom] = r && r.cumuls[c.nom] !== undefined ? r.cumuls[c.nom] : null; });
  const fait = await fenetreFormulaire({
    titre: `Reprise de la paie de ${s.prenom} ${s.nom}`,
    intro: 'Recopiez la colonne « cumul » (de janvier au mois indiqué) du dernier bulletin fait ailleurs. Les mois repris ne s\'établissent pas ici.',
    large: true,
    champs: [
      { nom: 'mois', libelle: 'Dernier mois payé ailleurs (n\'importe quel jour du mois)', type: 'date', requis: true, plein: true },
      ...CUMULS.map((c) => ({ nom: c.nom, libelle: `${c.libelle}${c.heures ? ' (h)' : ' (€)'}`, type: 'nombre', min: 0,
        requis: ['brut', 'heures'].includes(c.nom) })),
      { nom: 'cp_n1', libelle: 'Congés N-1 restant à prendre (jours ouvrables)', type: 'nombre', requis: true, min: -60, max: 120 },
      { nom: 'cp_n', libelle: 'Congés N acquis restant (jours ouvrables)', type: 'nombre', requis: true, min: -60, max: 120 },
      { nom: 'note', libelle: 'Note', type: 'texte', longueur: 500, plein: true, aide: 'Ex. « Bulletin d\'août 2026 du cabinet X ».' }
    ],
    valeurs,
    libelle: 'Enregistrer la reprise',
    enregistrer: async (v) => {
      const cumuls = {};
      CUMULS.forEach((c) => { if (v[c.nom] !== null) cumuls[c.nom] = v[c.nom]; });
      const { error } = await supabase.rpc('admin_enregistrer_reprise', {
        p_salarie: s.id, p_mois: debutMois(v.mois), p_cumuls: cumuls, p_cp_n1: v.cp_n1, p_cp_n: v.cp_n, p_note: v.note
      });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Reprise enregistrée.', 'succes'); ouvrirDossier(s.id); }
}

