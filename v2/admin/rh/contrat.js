// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : RH et paie — contrat de travail
// -----------------------------------------------------------------------------
//   - formulaire d'établissement (CDI, CDD, avenant) : période d'essai
//     proposée à sa durée légale maximale (la base la contrôle), motif et
//     terme du CDD, objet de l'avenant ;
//   - document imprimable (?contrat=…) : contrat complet rédigé à partir des
//     identités recopiées à l'établissement (le contrat se réimprime à
//     l'identique, même si la fiche change ensuite), sans aucun champ « à
//     compléter » ; clauses propres à la conduite de VTC pour un emploi de
//     conducteur.
// Lectures et actions : admin_generer_contrat, admin_document_contrat.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import { RACINE } from '../../commun/config.js';
import { lienAdmin } from '../commun/admin.js';
import { fenetreFormulaire, messageErreurAdmin, dateCourte, jourParis, ajouterJours, siretLisible } from '../commun/composants.js';
import { barreDocument } from '../commun/documents.js';
import { TYPES_CONTRAT, MOTIFS_CDD, STATUTS_CONTRAT, pastille, decimal, finApresMois, montant, nssLisible } from './commun-rh.js';

const $ = (id) => document.getElementById(id);

// Durée maximale de la période d'essai d'un CDI (article L. 1221-19)
function moisEssaiMax(s) {
  if (s.cadre) return 4;
  if (/ma[iî]trise|technicien/i.test(s.qualification || '')) return 3;
  return 2;
}

// Fin maximale de l'essai d'un CDD : 1 jour par semaine, 2 semaines au plus
// (contrat de 6 mois au plus), 1 mois au plus au-delà (article L. 1242-10)
function finEssaiCdd(debut, fin) {
  if (!debut || !fin || fin < debut) return null;
  const jours = Math.floor((Date.parse(`${fin}T12:00:00Z`) - Date.parse(`${debut}T12:00:00Z`)) / 86400000) + 1;
  const semaines = Math.floor(jours / 7);
  if (semaines < 1) return null;
  const sixMois = finApresMois(debut, 6);
  if (fin <= sixMois) return ajouterJours(debut, Math.min(semaines, 14) - 1);
  const unMois = finApresMois(debut, 1);
  const parSemaines = ajouterJours(debut, semaines - 1);
  return parSemaines < unMois ? parSemaines : unMois;
}

// #############################################################################
// ÉTABLIR UN CONTRAT
// #############################################################################
export async function formulaireContrat(s, manquants) {
  if (manquants && manquants.length) {
    afficherMessage(`Pour établir le contrat, renseignez d'abord : ${manquants.join(' ; ')}.`, 'erreur');
    return null;
  }
  const essaiCdi = finApresMois(s.date_entree, moisEssaiMax(s));
  return fenetreFormulaire({
    titre: `Contrat de ${s.prenom} ${s.nom}`,
    intro: 'Le contrat reprend la fiche du salarié et l\'identité de l\'entreprise : vérifiez-les avant de l\'établir. Il s\'imprime ensuite en deux exemplaires à signer.',
    large: true,
    champs: [
      { nom: 'type', libelle: 'Type', type: 'choix', requis: true, options: [
        { valeur: 'CDI', libelle: 'Contrat à durée indéterminée (CDI)' }, { valeur: 'CDD', libelle: 'Contrat à durée déterminée (CDD)' },
        { valeur: 'avenant', libelle: 'Avenant (modification du contrat)' }] },
      { nom: 'debut', libelle: 'Début (ou date d\'effet de l\'avenant)', type: 'date', requis: true },
      { nom: 'fin', libelle: 'Fin du CDD (terme précis)', type: 'date' },
      { nom: 'motif', libelle: 'Motif du CDD', type: 'choix', vide: 'Choisir…', options: Object.entries(MOTIFS_CDD).map(([valeur, libelle]) => ({ valeur, libelle })) },
      { nom: 'essai', libelle: 'Fin de la période d\'essai', type: 'date',
        aide: `Proposée à sa durée maximale (CDI : ${moisEssaiMax(s)} mois pour ce poste ; CDD : 1 jour par semaine). Videz le champ pour un contrat sans période d'essai.` },
      { nom: 'detail', libelle: 'Détail', type: 'zone', longueur: 2000, plein: true }
    ],
    valeurs: { type: s.type_contrat === 'CDD' ? 'CDD' : 'CDI', debut: s.date_entree, essai: essaiCdi },
    libelle: 'Établir le contrat',
    preparer: (elements) => {
      const bloc = (nom) => elements[nom].saisie.closest('.champ');
      const etiquette = (nom) => bloc(nom).querySelector('label');
      let typePrecedent = elements.type.saisie.value;
      const proposerEssai = () => {
        const type = elements.type.saisie.value;
        const debut = elements.debut.saisie.value;
        if (type === 'CDI' && debut) elements.essai.saisie.value = finApresMois(debut, moisEssaiMax(s));
        else if (type === 'CDD') elements.essai.saisie.value = finEssaiCdd(debut, elements.fin.saisie.value) || '';
        else elements.essai.saisie.value = '';
      };
      const basculer = () => {
        const type = elements.type.saisie.value;
        bloc('fin').hidden = type !== 'CDD';
        bloc('motif').hidden = type !== 'CDD';
        bloc('essai').hidden = type === 'avenant';
        const remplacement = type === 'CDD' && elements.motif.saisie.value === 'remplacement';
        bloc('detail').hidden = !(type === 'avenant' || remplacement);
        etiquette('detail').textContent = type === 'avenant' ? 'Ce qui change (objet de l\'avenant)' : 'Salarié remplacé : nom et qualification';
        if (type === 'avenant' && typePrecedent !== 'avenant') elements.debut.saisie.value = jourParis();
        if (type !== typePrecedent) proposerEssai();
        typePrecedent = type;
      };
      elements.type.saisie.addEventListener('change', basculer);
      elements.motif.saisie.addEventListener('change', basculer);
      elements.debut.saisie.addEventListener('change', proposerEssai);
      elements.fin.saisie.addEventListener('change', proposerEssai);
      basculer();
    },
    enregistrer: async (v) => {
      const { data, error } = await supabase.rpc('admin_generer_contrat', {
        p_salarie: s.id, p_type: v.type, p_date_debut: v.debut,
        p_date_fin: v.type === 'CDD' ? v.fin : null,
        p_essai_fin: v.type === 'avenant' ? null : v.essai,
        p_motif: v.type === 'CDD' ? v.motif : null,
        p_detail: v.type === 'avenant' || (v.type === 'CDD' && v.motif === 'remplacement') ? v.detail : null
      });
      if (error) throw error;
      return data;
    }
  });
}

// #############################################################################
// DOCUMENT IMPRIMABLE
// #############################################################################
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// « 6 juillet 2026 »
function dateLongue(jour) {
  if (!jour) return '';
  const [a, m, j] = String(jour).slice(0, 10).split('-').map(Number);
  return `${j === 1 ? '1er' : j} ${MOIS[m - 1]} ${a}`;
}

// Durée de l'essai en toutes lettres : « deux mois », « 14 jours »
const NOMBRES = ['zéro', 'un', 'deux', 'trois', 'quatre'];
function dureeEssai(debut, fin) {
  for (let mois = 1; mois <= 4; mois += 1) {
    if (finApresMois(debut, mois) === fin) return `${NOMBRES[mois]} mois`;
  }
  const jours = Math.round((Date.parse(`${fin}T12:00:00Z`) - Date.parse(`${debut}T12:00:00Z`)) / 86400000) + 1;
  return `${jours} jour${jours > 1 ? 's' : ''} calendaires`;
}

// « Conducteur de VTC » → « conducteur de VTC » au milieu d'une phrase (les
// sigles gardent leurs majuscules)
function minusculeInitiale(texte) {
  const t = String(texte || '');
  return /^[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

// Le salarié / la salariée selon la civilité
function accords(civilite) {
  const f = civilite === 'Madame';
  return { le: f ? 'la salariée' : 'le salarié', Le: f ? 'La salariée' : 'Le salarié', ne: f ? 'née' : 'né', il: f ? 'elle' : 'il', Il: f ? 'Elle' : 'Il',
    engage: f ? 'engagée' : 'engagé', affilie: f ? 'affiliée' : 'affilié', titulaire: 'titulaire' };
}

function article(numero, titre, ...paragraphes) {
  return el('section', { classe: 'contrat-article' },
    el('h3', { texte: `Article ${numero} · ${titre}` }),
    ...paragraphes.filter(Boolean).map((p) => (p instanceof Node ? p : el('p', { texte: p }))));
}

export async function ouvrirContrat(id) {
  $('onglets').hidden = true;
  if (!/^[0-9a-f-]{36}$/i.test(id)) { introuvable(); return; }
  const { data: k, error } = await supabase.rpc('admin_document_contrat', { p_contrat: id });
  if (error) {
    if (/introuvable/i.test(error.message || '')) introuvable();
    else $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) }));
    return;
  }
  $('entete-actions').replaceChildren(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`rh/?salarie=${k.salarie_id}`), texte: 'Dossier du salarié' }));
  const c = k.champs || {};
  if (c.externe || !c.salarie) {
    $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
      el('p', { texte: 'Ce contrat a été signé ailleurs : seul son PDF signé est classé (dossier du salarié).' })));
    return;
  }
  const s = c.salarie;
  const titre = { CDI: 'Contrat de travail à durée indéterminée', CDD: 'Contrat de travail à durée déterminée', avenant: 'Avenant au contrat de travail' }[k.type];
  document.title = `${titre}, ${s.prenom} ${s.nom}, LOC RÉACTION`;
  $('titre-page').textContent = `${TYPES_CONTRAT[k.type]} de ${s.prenom} ${s.nom}`;

  const infos = el('section', { classe: 'carte-admin non-imprimable', 'aria-label': 'Suivi du contrat' },
    el('p', {}, 'État : ', pastille(STATUTS_CONTRAT, k.statut), ' · établi le ', dateCourte(c.etabli_le), c.etabli_par ? ` par ${c.etabli_par}` : ''),
    el('p', { classe: 'aide-module', texte: k.statut === 'brouillon'
      ? 'Imprimez le contrat en deux exemplaires, faites parapher chaque page et signer la dernière par les deux parties (mention manuscrite « Lu et approuvé »), puis notez-le comme remis pour signature dans le dossier du salarié.'
      : 'Une fois signé, classez le PDF scanné dans le dossier du salarié (« Classer le PDF signé »).' }));

  $('contenu').replaceChildren(barreDocument(), infos, k.type === 'avenant' ? documentAvenant(k, c) : documentContrat(k, c));
}

function introuvable() {
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('p', { texte: 'Contrat introuvable.' }), el('a', { href: lienAdmin('rh/'), texte: 'Retour aux salariés' })));
}

// Parties au contrat : l'employeur et le salarié, tels que recopiés
function parties(c) {
  const so = c.societe;
  const s = c.salarie;
  const a = accords(s.civilite);
  return el('section', { classe: 'contrat-parties' },
    el('p', { texte: 'Entre les soussignés :' }),
    el('p', {}, el('strong', { texte: so.raison_sociale }),
      `, ${so.forme_juridique} au capital de ${montant(so.capital)}, dont le siège est situé ${so.adresse}, ${so.code_postal} ${so.ville}, `
      + `immatriculée au ${so.rcs}, SIRET ${siretLisible(so.siret)}${so.numero_urssaf ? `, n° URSSAF ${so.numero_urssaf}` : ''}, `
      + `représentée par ${so.representant_nom}, en qualité de ${so.representant_qualite},`),
    el('p', { classe: 'contrat-designation', texte: 'ci-après « l\'employeur »,' }),
    el('p', { texte: 'et' }),
    el('p', {}, el('strong', { texte: `${s.civilite} ${s.prenom} ${s.nom}` }),
      `, ${a.ne} le ${dateLongue(s.date_naissance)} à ${s.lieu_naissance}, de nationalité ${s.nationalite.toLowerCase()}, demeurant ${s.adresse}, `
      + `${s.code_postal} ${s.ville}, n° de Sécurité sociale ${nssLisible(s.numero_securite_sociale)},`),
    el('p', { classe: 'contrat-designation', texte: `ci-après « ${a.le} »,` }),
    el('p', { texte: 'il a été convenu ce qui suit.' }));
}

function signatures(c) {
  const so = c.societe;
  const a = accords(c.salarie.civilite);
  return el('section', { classe: 'contrat-signatures' },
    el('p', { texte: `Fait à ${so.ville}, le ${dateLongue(String(c.etabli_le).slice(0, 10))}, en deux exemplaires originaux, dont un remis à ${a.le}.` }),
    el('div', { classe: 'contrat-signataires' },
      el('div', {}, el('strong', { texte: 'L\'employeur' }), el('span', { texte: `${so.representant_nom}, ${so.representant_qualite}` }),
        el('span', { classe: 'contrat-mention', texte: 'Signature précédée de la mention « Lu et approuvé »' })),
      el('div', {}, el('strong', { texte: a.Le }), el('span', { texte: `${c.salarie.prenom} ${c.salarie.nom}` }),
        el('span', { classe: 'contrat-mention', texte: 'Signature précédée de la mention « Lu et approuvé »' }))));
}

function entete(titre, sousTitre) {
  return el('header', { classe: 'contrat-entete' },
    el('img', { src: `${RACINE}commun/img/logo.svg`, alt: '', width: '72', height: '36', classe: 'doc-logo' }),
    el('h2', { texte: titre }),
    sousTitre ? el('p', { classe: 'doc-sous-titre', texte: sousTitre }) : null);
}

function documentContrat(k, c) {
  const so = c.societe;
  const s = c.salarie;
  const a = accords(s.civilite);
  const conducteur = /conduct|chauffeur|vtc/i.test(s.emploi || '');
  const sansConvention = /^aucune/i.test(String(c.convention_collective || '').trim());
  const partiel = s.temps === 'partiel';
  let n = 0;
  const art = (titre, ...p) => { n += 1; return article(n, titre, ...p); };
  const essai = c.essai_fin
    ? `Le contrat ne devient définitif qu'à l'issue d'une période d'essai de ${dureeEssai(c.date_debut, c.essai_fin)}, soit jusqu'au ${dateLongue(c.essai_fin)} inclus. `
      + 'Pendant cette période, chacune des parties peut rompre le contrat en respectant le délai de prévenance prévu aux articles L. 1221-25 et L. 1221-26 du Code du travail.'
    : 'Le contrat est conclu sans période d\'essai.';
  const classification = [s.qualification, s.niveau ? `niveau ${s.niveau}` : null, s.coefficient ? `coefficient ${s.coefficient}` : null].filter(Boolean).join(', ');

  return el('article', { classe: 'doc contrat' },
    entete(k.type === 'CDI' ? 'Contrat de travail à durée indéterminée' : 'Contrat de travail à durée déterminée',
      `${partiel ? 'À temps partiel' : 'À temps plein'}${k.type === 'CDD' ? ` · du ${dateCourte(c.date_debut)} au ${dateCourte(c.date_fin)}` : ''}`),
    parties(c),
    art('Engagement',
      `${so.raison_sociale} engage ${a.le} ${k.type === 'CDI' ? 'pour une durée indéterminée' : 'pour une durée déterminée'} à compter du ${dateLongue(c.date_debut)}.`
      + (k.type === 'CDD' ? ` Le contrat prend fin le ${dateLongue(c.date_fin)} (terme précis).` : ''),
      'La déclaration préalable à l\'embauche est effectuée par l\'employeur auprès de l\'Urssaf ; '
      + `${a.le} peut en obtenir la copie sur simple demande.`),
    k.type === 'CDD' ? art('Motif du recours au contrat à durée déterminée',
      `Le présent contrat est conclu pour le motif suivant : ${c.motif_libelle} (article L. 1242-2 du Code du travail).`) : null,
    art('Convention collective',
      sansConvention
        ? 'Aucune convention collective n\'est applicable à l\'entreprise à la date de signature : le contrat est régi par les dispositions du Code du travail.'
        : `Le contrat est régi par les dispositions du Code du travail et par la convention collective suivante : ${c.convention_collective}.`),
    art('Fonctions',
      `${a.Le} est ${a.engage} en qualité de ${minusculeInitiale(s.emploi)}${classification ? ` (${classification})` : ''}, statut ${s.cadre ? 'cadre' : 'non cadre'}.`,
      conducteur ? `${a.Il} assure le transport de personnes à bord des véhicules de l'entreprise, dans le respect de la réglementation des voitures de transport avec chauffeur (VTC), des réservations confiées par l'employeur et de ses consignes d'exploitation.` : null),
    art('Période d\'essai', essai),
    art('Durée du travail',
      partiel
        ? `La durée du travail est de ${decimal(s.heures_hebdo, 0, 2)} heures par semaine, soit ${decimal(s.heures_mensuelles, 0, 2)} heures par mois, réparties comme suit : ${s.repartition_horaire}.`
        : 'La durée du travail est de 35 heures par semaine, soit 151,67 heures par mois. Les horaires sont fixés par l\'employeur selon les réservations et communiqués à l\'avance par le planning de l\'entreprise.',
      partiel
        ? 'Cette répartition peut être modifiée en cas d\'accroissement ou de baisse d\'activité, d\'absence d\'un salarié ou de réorganisation du service, en respectant un délai de prévenance de sept jours ouvrés (article L. 3123-11 du Code du travail). '
          + `${a.Le} peut accomplir des heures complémentaires dans la limite du dixième de la durée prévue au contrat ; chacune est majorée de 10 % (article L. 3123-8 du Code du travail).`
        : 'Les heures supplémentaires accomplies à la demande de l\'employeur sont majorées de 25 % de la 36e à la 43e heure de la semaine et de 50 % au-delà (article L. 3121-36 du Code du travail).'),
    art('Lieu de travail',
      `${a.Le} exerce ses fonctions : ${s.lieu_travail}.`
      + (conducteur ? ' Compte tenu de la nature de l\'activité de transport de personnes, les courses le conduisent à se déplacer dans toute la zone desservie par l\'entreprise.' : '')),
    art('Rémunération',
      `En contrepartie de son travail, ${a.le} perçoit une rémunération mensuelle brute de ${montant(s.salaire_base_mensuel)} pour ${decimal(s.heures_mensuelles, 0, 2)} heures de travail par mois, soit un taux horaire brut de ${decimal(s.taux_horaire, 4, 6)} €.`,
      'Elle est versée chaque mois par virement, avec la remise d\'un bulletin de paie.'),
    art('Congés payés',
      `${a.Le} acquiert 2,5 jours ouvrables de congés payés par mois de travail effectif, soit 30 jours ouvrables par an (article L. 3141-3 du Code du travail). Les dates de congés sont fixées par l'employeur après demande ${a.il === 'elle' ? 'de la salariée' : 'du salarié'}, dans le respect de l'ordre des départs.`),
    art('Protection sociale',
      `${a.Le} est ${a.affilie} à la caisse de retraite complémentaire ${so.caisse_retraite} et bénéficie de la complémentaire santé obligatoire de l'entreprise auprès de ${so.organisme_sante}`
      + (so.organisme_prevoyance ? `, ainsi que du régime de prévoyance auprès de ${so.organisme_prevoyance}` : '') + '.',
      `Le suivi de son état de santé est assuré par ${so.service_sante_travail}.`),
    conducteur ? art('Permis, carte professionnelle et véhicules',
      `${a.Le} doit être titulaire, pendant toute la durée du contrat, d'un permis de conduire en cours de validité et de la carte professionnelle de conducteur de VTC. ${a.Il} informe l'employeur sans délai de toute suspension, de tout retrait ou de toute perte de points susceptible d'affecter son droit de conduire.`,
      `${a.Il} conduit les véhicules mis à sa disposition par l'employeur exclusivement pour les besoins du service, en prend soin, respecte le Code de la route et signale sans délai tout incident, dommage ou anomalie.`,
      'En cas d\'infraction au Code de la route commise avec un véhicule de l\'entreprise, l\'employeur est tenu de désigner le conducteur (article L. 121-6 du Code de la route). Aucune sanction pécuniaire ne peut être retenue sur le salaire (article L. 1331-2 du Code du travail).') : null,
    art('Obligations professionnelles',
      `${a.Le} observe une tenue correcte et une attitude courtoise envers la clientèle, respecte le règlement et les consignes de l'entreprise et garde une stricte discrétion sur les informations dont ${a.il} a connaissance dans ses fonctions${conducteur ? ', notamment sur les déplacements et les échanges des passagers' : ''}.`),
    art('Fin du contrat',
      k.type === 'CDI'
        ? `Chacune des parties peut mettre fin au contrat dans les conditions prévues par le Code du travail${sansConvention ? '' : ' et la convention collective'}, en respectant le préavis applicable.`
        : `Le contrat prend fin le ${dateLongue(c.date_fin)}. Il ne peut être rompu avant son terme que dans les cas prévus à l'article L. 1243-1 du Code du travail. À son terme, ${a.le} perçoit une indemnité de fin de contrat égale à 10 % de la rémunération totale brute versée, sauf dans les cas prévus par la loi (article L. 1243-8 du Code du travail), et l'indemnité compensatrice des congés payés non pris.`),
    art('Données personnelles',
      `Les données personnelles ${a.il === 'elle' ? 'de la salariée' : 'du salarié'} sont traitées par l'employeur pour la gestion du personnel et de la paie, et transmises aux seuls organismes sociaux et fiscaux qui y ont droit. ${a.Le} dispose d'un droit d'accès, de rectification et d'effacement dans les conditions prévues par le règlement européen sur la protection des données.`),
    signatures(c));
}

function documentAvenant(k, c) {
  const so = c.societe;
  const s = c.salarie;
  const a = accords(s.civilite);
  return el('article', { classe: 'doc contrat' },
    entete('Avenant au contrat de travail', `${s.prenom} ${s.nom} · effet le ${dateCourte(c.date_debut)}`),
    parties(c),
    article(1, 'Objet',
      `${a.Le}, ${a.engage} le ${dateLongue(s.date_entree)} en qualité de ${minusculeInitiale(s.emploi)}, et ${so.raison_sociale} conviennent de modifier son contrat de travail comme suit :`,
      el('p', { classe: 'contrat-objet', texte: c.detail })),
    article(2, 'Prise d\'effet', `Le présent avenant prend effet le ${dateLongue(c.date_debut)}.`),
    article(3, 'Autres clauses', 'Toutes les autres clauses du contrat de travail demeurent inchangées.'),
    signatures(c));
}
