// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : documents imprimables
// -----------------------------------------------------------------------------
// 1. Feuille de route d'une course (?type=feuille&course=…) : en-tête à
//    l'identité de l'entreprise (dont le n° d'inscription au registre des
//    exploitants VTC), puis les mentions de la course (commun/feuille-route.js,
//    les mêmes que sur l'écran de course) et le chauffeur avec sa carte VTC.
// 2. Relevé d'activité d'une période (?type=releve&du=…&au=…) : totaux (comme
//    l'onglet Revenus), tableau jour par jour, détail des courses terminées
//    et annulées.
// Le chauffeur ne lit que ses propres courses (règles d'accès de la base).
// Une mention manquante dans les paramètres de l'entreprise est signalée à
// l'écran seulement (jamais imprimée).
// =============================================================================
import { supabase, profilConnecte, messageErreur } from '../../commun/supabase.js';
import { RACINE } from '../../commun/config.js';
import { imposerLangue } from '../../commun/i18n.js';
import { el, euros, dateHeure } from '../../commun/outils.js';
import { enteteDocument, barreDocument, blocTotaux, enteteTableau, tableauDefilant } from '../../admin/commun/documents.js';
import { mentionsCourse } from '../commun/feuille-route.js';
import { lireHistorique, instantFin } from '../commun/historique.js';
import { jourParis, ajouterJours, dateCourte, dateLongue, dureeLisible, heuresLisibles } from '../commun/periodes.js';
import { STATUTS_COURSE, arrondi, majorationDe } from '../commun/libelles.js';

imposerLangue('fr');                 // espace chauffeur en français

const $ = (id) => document.getElementById(id);
const COLONNES_SOCIETE = 'raison_sociale, forme_juridique, capital, siren, siret, rcs, code_ape, tva_intracommunautaire, '
  + 'registre_vtc_numero, adresse, code_postal, ville, telephone, email';

demarrer().catch((erreur) => {
  $('chargement').hidden = true;
  $('erreur').hidden = false;
  $('erreur').replaceChildren(
    el('p', { classe: 'alerte', role: 'alert', texte: messageErreur(erreur) }),
    el('p', {}, el('a', { href: '../', texte: 'Retour à l\'espace chauffeur' })));
});

async function demarrer() {
  const { data: { session } } = await supabase.auth.getSession();
  const profil = session ? await profilConnecte() : null;
  if (!profil) {
    location.replace(`${RACINE}connexion/?suite=${encodeURIComponent(location.pathname.slice(RACINE.length) + location.search)}`);
    return;
  }
  if (profil.role !== 'chauffeur' || profil.statut !== 'actif') throw new Error('Ces documents sont réservés aux chauffeurs de LOC RÉACTION.');

  const parametres = new URLSearchParams(location.search);
  const societe = (await lire(supabase.from('societe').select(COLONNES_SOCIETE).maybeSingle())) || {};
  const type = parametres.get('type');
  if (type === 'feuille') await feuilleDeRoute(parametres.get('course'), societe, profil);
  else if (type === 'releve') await releve(parametres.get('du'), parametres.get('au'), societe, profil);
  else throw new Error('Document inconnu : ouvrez-le depuis votre espace chauffeur.');
  $('chargement').hidden = true;
}

async function lire(requete) {
  const { data, error } = await requete;
  if (error) throw error;
  return data;
}

// « Fermer » : ferme l'onglet ouvert depuis l'espace chauffeur ; sinon (lien
// ouvert autrement), retour à l'onglet d'où vient le document
function boutonFermer(onglet) {
  const bouton = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Fermer' });
  bouton.addEventListener('click', () => {
    window.close();
    setTimeout(() => { location.href = `../?onglet=${onglet}`; }, 300);
  });
  return bouton;
}

// Mentions de l'entreprise qui manquent pour ce document (écran seulement)
function avertissement(manquants, nomDocument) {
  if (!manquants.length) return null;
  const plusieurs = manquants.length > 1;
  return el('p', { classe: 'alerte non-imprimable', role: 'status',
    texte: `Il manque ${manquants.join(' et ')} : LOC RÉACTION doit ${plusieurs ? 'les' : 'le'} saisir dans l'administration (Paramètres, Entreprise) pour ${plusieurs ? 'qu\'ils figurent' : 'qu\'il figure'} sur ${nomDocument}.` });
}

function nomComplet(profil) {
  return [profil.prenom, profil.nom].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// 1. Feuille de route
// ---------------------------------------------------------------------------
async function feuilleDeRoute(id, societe, profil) {
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) throw new Error('Course introuvable : ouvrez la feuille de route depuis l\'onglet Courses.');
  const [c, arrets, fiche] = await Promise.all([
    lire(supabase.from('courses').select('*').eq('id', id).maybeSingle()),
    lire(supabase.from('course_arrets').select('ordre, adresse').eq('course_id', id).order('ordre')),
    lire(supabase.from('chauffeurs').select('carte_vtc_numero').eq('id', profil.id).maybeSingle())
  ]);
  if (!c || c.chauffeur_id !== profil.id) throw new Error('Cette course est introuvable ou ne vous est pas attribuée.');
  document.title = `Feuille de route ${c.numero}, LOC RÉACTION`;

  const chauffeur = [nomComplet(profil), fiche && fiche.carte_vtc_numero ? `carte VTC n° ${fiche.carte_vtc_numero}` : null].filter(Boolean).join(', ');
  const manquants = [
    societe.registre_vtc_numero ? null : 'le n° d\'inscription au registre des exploitants VTC',
    societe.siret ? null : 'le SIRET'
  ].filter(Boolean);
  const court = { dateStyle: 'short', timeStyle: 'short' };

  $('document').replaceChildren(
    barreDocument(boutonFermer('courses')),
    avertissement(manquants, 'la feuille de route'),
    el('article', { classe: 'doc', 'aria-label': `Feuille de route ${c.numero}` },
      enteteDocument({
        societe, titre: 'Feuille de route', sousTitre: c.numero,
        mention: c.statut === 'annulee' ? 'Course annulée' : null,
        dates: [['Réservée le', dateHeure(c.cree_le, court)], ['Prise en charge', dateHeure(c.prise_en_charge_le, court)]]
      }),
      el('p', { classe: 'doc-objet', texte: 'Justificatif de la réservation préalable, à présenter en cas de contrôle.' }),
      el('section', { classe: 'doc-bloc', 'aria-label': 'Mentions de la course' },
        el('dl', { classe: 'doc-mentions-course' },
          ...mentionsCourse(c, { arrets: arrets || [], chauffeur }).flatMap(([dt, dd]) => [el('dt', { texte: dt }), el('dd', { texte: dd || '—' })]))),
      el('p', { classe: 'doc-note', texte: `Document édité le ${dateHeure(new Date(), { dateStyle: 'long', timeStyle: 'short' })} depuis l'espace chauffeur.` })));
}

// ---------------------------------------------------------------------------
// 2. Relevé d'activité
// ---------------------------------------------------------------------------
async function releve(du, au, societe, profil) {
  const format = /^\d{4}-\d{2}-\d{2}$/;
  if (!format.test(du || '') || !format.test(au || '') || du > au) throw new Error('Période invalide : ouvrez le relevé depuis l\'onglet Revenus.');
  if (au > ajouterJours(du, 366)) throw new Error('Période trop longue : un relevé couvre au plus un an.');

  // Totaux par jour (base), courses de la période (de la plus ancienne à la
  // plus récente dans le tableau), contrat de travail
  const [jours, lues, salarie] = await Promise.all([
    lire(supabase.rpc('revenus_chauffeur', { p_debut: du, p_fin: au })),
    lireHistorique({
      chauffeur: profil.id, du, au, limite: 5000,
      colonnes: 'id, numero, statut, terminee_le, annulee_le, depart_adresse, arrivee_adresse, '
        + 'prix_base, majoration_pourcentage, forfait_id, prix_total, frais_attente, pourboire, frais_annulation'
    }),
    lire(supabase.from('salaries').select('id').eq('profil_id', profil.id).maybeSingle())
  ]);
  let heures = null;
  if (salarie) {
    const temps = await lire(supabase.from('temps_travail').select('heures').eq('salarie_id', salarie.id).gte('jour', du).lte('jour', au));
    heures = (temps || []).reduce((s, t) => s + Number(t.heures || 0), 0);
  }

  const instant = instantFin;
  const courses = lues.slice().reverse();
  const lignesJours = jours || [];
  const somme = (champ) => arrondi(lignesJours.reduce((s, j) => s + Number(j[champ] || 0), 0));
  const t = {
    courses: lignesJours.reduce((s, j) => s + Number(j.courses || 0), 0),
    trajets: somme('chiffre_affaires'), attente: somme('attente'), pourboires: somme('pourboires'),
    annulations: somme('frais_annulation'), remboursements: somme('remboursements'), minutes: somme('minutes_en_course'),
    majorations: arrondi(courses.filter((c) => c.statut === 'terminee').reduce((s, c) => s + majorationDe(c), 0))
  };
  const chiffre = arrondi(t.trajets + t.attente);
  const periode = du === au ? `Le ${dateLongue(du)}` : `Du ${dateCourte(du)} au ${dateCourte(au)}`;
  document.title = `Relevé d'activité, ${periode.toLowerCase()}, LOC RÉACTION`;

  // Tableau jour par jour
  const tableJours = el('table', { classe: 'doc-table' },
    enteteTableau(['Date', 'Courses', 'Trajets', 'Attente', 'Frais d\'annulation', 'Remboursements', 'Pourboires', 'Temps en course'], [1, 2, 3, 4, 5, 6, 7]),
    el('tbody', {}, ...lignesJours.map((j) => el('tr', {},
      el('td', { texte: dateCourte(j.jour) }),
      el('td', { classe: 'droite', texte: String(j.courses) }),
      el('td', { classe: 'droite', texte: euros(j.chiffre_affaires) }),
      el('td', { classe: 'droite', texte: euros(j.attente) }),
      el('td', { classe: 'droite', texte: euros(j.frais_annulation) }),
      el('td', { classe: 'droite', texte: Number(j.remboursements) ? `− ${euros(j.remboursements)}` : euros(0) }),
      el('td', { classe: 'droite', texte: euros(j.pourboires) }),
      el('td', { classe: 'droite', texte: dureeLisible(j.minutes_en_course) })))),
    el('tfoot', {}, el('tr', {},
      el('td', { texte: 'Total' }),
      el('td', { classe: 'droite', texte: String(t.courses) }),
      el('td', { classe: 'droite', texte: euros(t.trajets) }),
      el('td', { classe: 'droite', texte: euros(t.attente) }),
      el('td', { classe: 'droite', texte: euros(t.annulations) }),
      el('td', { classe: 'droite', texte: t.remboursements ? `− ${euros(t.remboursements)}` : euros(0) }),
      el('td', { classe: 'droite', texte: euros(t.pourboires) }),
      el('td', { classe: 'droite', texte: dureeLisible(t.minutes) }))));

  // Détail des courses
  const tableCourses = el('table', { classe: 'doc-table' },
    enteteTableau(['N°', 'Date', 'Trajet', 'État', 'Prix fixe', 'Attente', 'Pourboire', 'Frais d\'annulation'], [4, 5, 6, 7]),
    el('tbody', {}, ...courses.map((c) => el('tr', {},
      el('td', { classe: 'doc-numero', texte: c.numero }),
      el('td', { texte: dateHeure(instant(c), { dateStyle: 'short', timeStyle: 'short' }) }),
      el('td', { classe: 'doc-trajet', texte: `${c.depart_adresse} → ${c.arrivee_adresse}` }),
      el('td', { texte: STATUTS_COURSE[c.statut] || c.statut }),
      el('td', { classe: 'droite', texte: c.statut === 'terminee' ? euros(c.prix_total) : '—' }),
      el('td', { classe: 'droite', texte: c.statut === 'terminee' ? euros(c.frais_attente) : '—' }),
      el('td', { classe: 'droite', texte: euros(c.pourboire) }),
      el('td', { classe: 'droite', texte: c.statut === 'annulee' ? euros(c.frais_annulation) : '—' })))));

  const totaux = [
    ['Courses terminées', String(t.courses)],
    ['Trajets (prix fixes)', euros(t.trajets)],
    ['dont majorations (nuit, dimanche, jours fériés)', euros(t.majorations)],
    ['Attente facturée', euros(t.attente)],
    'trait',
    ['Chiffre d\'affaires des courses', euros(chiffre), true],
    ['Frais d\'annulation', euros(t.annulations)],
    ['Remboursements aux clients', t.remboursements ? `− ${euros(t.remboursements)}` : euros(0)],
    ['Pourboires', euros(t.pourboires)],
    ['Temps en course', dureeLisible(t.minutes)],
    heures === null ? null : ['Heures de travail saisies', heures ? heuresLisibles(heures) : 'aucune']
  ];

  $('document').replaceChildren(
    barreDocument(boutonFermer('revenus')),
    el('article', { classe: 'doc', 'aria-label': `Relevé d'activité, ${periode}` },
      enteteDocument({
        societe, titre: 'Relevé d\'activité', sousTitre: periode,
        dates: [['Chauffeur', nomComplet(profil)], ['Édité le', dateCourte(jourParis())]]
      }),
      blocTotaux(totaux, 'Totaux de la période'),
      salarie ? el('p', { classe: 'doc-note', texte: 'Chiffre d\'affaires des courses réalisées pour LOC RÉACTION S.A.S. La rémunération figure sur le bulletin de paie.' }) : null,
      el('section', { classe: 'doc-bloc', 'aria-label': 'Jour par jour' },
        el('h3', { texte: 'Jour par jour' }),
        lignesJours.length ? tableauDefilant(tableJours) : el('p', { texte: 'Aucune course terminée ou annulée sur cette période.' })),
      courses.length ? el('section', { classe: 'doc-bloc', 'aria-label': 'Détail des courses' },
        el('h3', { texte: 'Détail des courses' }),
        tableauDefilant(tableCourses)) : null));
}
