// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : onglet Courses (historique)
// -----------------------------------------------------------------------------
// Courses terminées et annulées d'un mois (heure de Paris), groupées par jour,
// de la plus récente à la plus ancienne ; filtre Terminées, Annulées, Toutes.
// Une course s'ouvre sur sa fiche : trajet, horaires, prix détaillé,
// paiement, note du client, et sa feuille de route en PDF (document/, nouvel
// onglet : le service continue dans celui-ci).
// Les courses à venir ou en cours restent sur l'accueil (« Mes courses »).
// Lectures directes, limitées par les règles d'accès à ses propres courses :
// courses, course_arrets, paiements, evaluations (note donnée par le client).
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { euros, nombre, el, afficherMessage, dateHeure } from '../../commun/outils.js';
import { jourParis, bornesPeriode, deplacerPeriode, libellePeriode, dateLongue, majuscule } from '../commun/periodes.js';
import { lireHistorique, instantFin } from '../commun/historique.js';
import {
  STATUTS_COURSE, TYPES_COURSE, MODES_PAIEMENT, STATUTS_PAIEMENT, ANNULEE_PAR, MAJORATIONS,
  arrondi, majorationDe, chiffreCourse
} from '../commun/libelles.js';

const FILTRES = [
  { code: 'terminee', libelle: 'Terminées' },
  { code: 'annulee', libelle: 'Annulées' },
  { code: 'toutes', libelle: 'Toutes' }
];
const COLONNES = 'id, numero, statut, type, prise_en_charge_le, terminee_le, annulee_le, depart_adresse, arrivee_adresse, '
  + 'prix_total, frais_attente, frais_annulation, pourboire';
const etat = { filtre: 'terminee', jour: null, demande: 0, contexte: null };
const $ = (id) => document.getElementById(id);

export async function afficher(conteneur, contexte) {
  etat.contexte = contexte;
  if (!conteneur.dataset.pret) {
    construire(conteneur);
    conteneur.dataset.pret = 'oui';
    etat.jour = jourParis();
  }
  montrerListe();                                  // onglet rouvert : la liste, relue
  await charger();
}

// ---------------------------------------------------------------------------
// Structure de l'onglet (une seule fois)
// ---------------------------------------------------------------------------
function construire(conteneur) {
  const bascule = el('div', { classe: 'bascule bascule-large', role: 'radiogroup', 'aria-label': 'Courses affichées' },
    ...FILTRES.map((f) => {
      const choix = el('input', { type: 'radio', name: 'courses-filtre', value: f.code, id: `courses-filtre-${f.code}` });
      choix.checked = f.code === etat.filtre;
      choix.addEventListener('change', () => { etat.filtre = f.code; relire(); });
      return el('label', { for: `courses-filtre-${f.code}` }, choix, el('span', { texte: f.libelle }));
    }));
  const precedent = el('button', { type: 'button', classe: 'bouton bouton-icone', id: 'courses-precedent', 'aria-label': 'Mois précédent' }, '‹');
  const suivant = el('button', { type: 'button', classe: 'bouton bouton-icone', id: 'courses-suivant', 'aria-label': 'Mois suivant' }, '›');
  precedent.addEventListener('click', () => deplacer(-1));
  suivant.addEventListener('click', () => deplacer(1));

  conteneur.replaceChildren(
    el('h1', { classe: 'vue-titre', id: 'titre-courses', texte: 'Courses' }),
    el('div', { id: 'courses-zone-liste', classe: 'vue-onglet-bloc' },
      bascule,
      el('div', { classe: 'periode' }, precedent, el('p', { classe: 'periode-libelle', id: 'courses-mois', 'aria-live': 'polite' }), suivant),
      el('p', { classe: 'courses-resume', id: 'courses-resume' }),
      el('div', { id: 'courses-liste', classe: 'courses-liste' }),
      el('p', { classe: 'vide', id: 'courses-vide', hidden: true })),
    el('div', { id: 'courses-zone-fiche', classe: 'vue-onglet-bloc', hidden: true }));
}

function deplacer(sens) {
  const { du } = bornesPeriode('mois', etat.jour);
  const cible = deplacerPeriode('mois', du, sens);
  if (cible > jourParis()) return;
  etat.jour = cible;
  relire();
}

function relire() {
  charger().catch((erreur) => afficherMessage(messageErreur(erreur), 'erreur'));
}

function montrerListe() {
  if (!$('courses-zone-liste')) return;
  $('courses-zone-fiche').hidden = true;
  $('courses-zone-liste').hidden = false;
}

// Jour (à Paris) où la course s'est terminée ou a été annulée
function jourEvenement(c) {
  return jourParis(instantFin(c));
}

// ---------------------------------------------------------------------------
// Liste du mois
// ---------------------------------------------------------------------------
async function charger() {
  const moi = etat.contexte.profil.id;
  const { du, au } = bornesPeriode('mois', etat.jour);
  const numero = ++etat.demande;
  $('courses-mois').textContent = libellePeriode('mois', du, au);
  $('courses-suivant').disabled = au >= jourParis();

  const courses = await lireHistorique({
    chauffeur: moi, du, au, colonnes: COLONNES,
    statuts: etat.filtre === 'toutes' ? ['terminee', 'annulee'] : [etat.filtre]
  });

  // Notes données par les clients (règle d'accès : celles qui me concernent)
  const notes = new Map();
  const terminees = courses.filter((c) => c.statut === 'terminee').map((c) => c.id);
  if (terminees.length) {
    const lecture = await supabase.from('evaluations').select('course_id, note')
      .eq('sens', 'client_vers_chauffeur').in('course_id', terminees);
    if (lecture.error) throw lecture.error;
    (lecture.data || []).forEach((n) => notes.set(n.course_id, n.note));
  }
  if (numero !== etat.demande) return;

  afficherResume(courses);
  $('courses-vide').hidden = courses.length > 0;
  $('courses-vide').textContent = {
    terminee: 'Aucune course terminée ce mois-ci.', annulee: 'Aucune course annulée ce mois-ci.', toutes: 'Aucune course ce mois-ci.'
  }[etat.filtre];

  // Groupes par jour
  const groupes = new Map();
  courses.forEach((c) => {
    const j = jourEvenement(c);
    if (!groupes.has(j)) groupes.set(j, []);
    groupes.get(j).push(c);
  });
  $('courses-liste').replaceChildren(...[...groupes.entries()].map(([jour, liste]) => el('section', { classe: 'courses-jour', 'aria-label': dateLongue(jour) },
    el('h2', { classe: 'courses-jour-titre', texte: majuscule(dateLongue(jour, { annee: false })) }),
    el('ul', { classe: 'liste-courses' }, ...liste.map((c) => el('li', {}, carte(c, notes.get(c.id))))))));
}

function afficherResume(courses) {
  const terminees = courses.filter((c) => c.statut === 'terminee');
  const annulees = courses.length - terminees.length;
  const montant = arrondi(terminees.reduce((s, c) => s + chiffreCourse(c), 0));
  const parties = [];
  if (etat.filtre !== 'annulee') parties.push(`${terminees.length} ${terminees.length > 1 ? 'courses terminées' : 'course terminée'} · ${euros(montant)}`);
  if (etat.filtre !== 'terminee') parties.push(`${annulees} ${annulees > 1 ? 'annulées' : 'annulée'}`);
  $('courses-resume').textContent = parties.join(' · ');
}

function carte(c, note) {
  const heure = dateHeure(instantFin(c), { hour: '2-digit', minute: '2-digit' });
  const montant = c.statut === 'terminee' ? euros(chiffreCourse(c)) : (Number(c.frais_annulation) > 0 ? euros(c.frais_annulation) : '');
  const bouton = el('button', { type: 'button', classe: 'course-carte course-historique', 'aria-label': `Course ${c.numero}, ${STATUTS_COURSE[c.statut]}` },
    el('span', { classe: 'entete-course' },
      el('span', { classe: 'moment', texte: `${heure} · ${c.numero}` }),
      montant ? el('span', { classe: 'montant', texte: montant }) : null),
    el('span', { classe: 'adresses', texte: `${c.depart_adresse} → ${c.arrivee_adresse}` }),
    el('span', { classe: 'pied-course' },
      el('span', { classe: 'etat-course', dataset: { statut: c.statut }, texte: STATUTS_COURSE[c.statut] }),
      note ? el('span', { classe: 'note-recue', texte: `★ ${note}/5` }) : null,
      Number(c.pourboire) > 0 ? el('span', { classe: 'note-recue', texte: `Pourboire ${euros(c.pourboire)}` }) : null));
  bouton.addEventListener('click', () => ouvrirFiche(c.id).catch((erreur) => afficherMessage(messageErreur(erreur), 'erreur')));
  return bouton;
}

// ---------------------------------------------------------------------------
// Fiche d'une course
// ---------------------------------------------------------------------------
async function ouvrirFiche(id) {
  const [course, arrets, paiements, note] = await Promise.all([
    supabase.from('courses').select('*').eq('id', id).maybeSingle(),
    supabase.from('course_arrets').select('ordre, adresse').eq('course_id', id).order('ordre'),
    supabase.from('paiements').select('nature, mode, montant, statut').eq('course_id', id).order('cree_le'),
    supabase.from('evaluations').select('note, commentaire').eq('course_id', id).eq('sens', 'client_vers_chauffeur').maybeSingle()
  ]);
  for (const r of [course, arrets, paiements, note]) if (r.error) throw r.error;
  if (!course.data) throw new Error('Cette course n\'est plus visible : elle a peut-être été retirée par l\'administration.');
  const c = course.data;

  const retour = el('button', { type: 'button', classe: 'bouton bouton-texte courses-retour', id: 'courses-retour', texte: '‹ Toutes mes courses' });
  retour.addEventListener('click', () => { montrerListe(); window.scrollTo(0, 0); });

  $('courses-zone-fiche').replaceChildren(
    retour,
    el('section', { classe: 'panneau', 'aria-labelledby': 'fiche-titre' },
      el('div', { classe: 'fiche-entete' },
        el('h2', { id: 'fiche-titre', texte: `Course ${c.numero}` }),
        el('span', { classe: 'etat-course', dataset: { statut: c.statut }, texte: STATUTS_COURSE[c.statut] || c.statut })),
      el('p', { classe: 'aide', texte: c.statut === 'terminee'
        ? `Terminée le ${dateHeure(c.terminee_le, { dateStyle: 'full', timeStyle: 'short' })}`
        : ['Annulée', ANNULEE_PAR[c.annulee_par], 'le', dateHeure(c.annulee_le, { dateStyle: 'full', timeStyle: 'short' })].filter(Boolean).join(' ') }),
      c.statut === 'annulee' && c.motif_annulation ? el('p', { classe: 'aide', texte: `Motif : ${c.motif_annulation}` }) : null,
      el('ol', { classe: 'trajet-fiche' },
        el('li', { texte: c.depart_adresse + (c.depart_precision ? ` (${c.depart_precision})` : '') }),
        ...(arrets.data || []).map((a) => el('li', { classe: 'arret', texte: a.adresse })),
        el('li', { texte: c.arrivee_adresse })),
      lignes([
        ['Type', TYPES_COURSE[c.type] || c.type],
        ['Distance', `${nombre(c.distance_km, 1)} km, environ ${c.duree_min} min`],
        c.numero_vol ? ['Vol', [c.numero_vol, c.terminal ? `terminal ${c.terminal}` : null].filter(Boolean).join(', ')] : null,
        c.option_chauffeuse ? ['Option', 'Chauffeuse demandée'] : null,
        ['Véhicule', [c.vehicule_libelle, c.vehicule_immatriculation].filter(Boolean).join(', ') || '—']
      ])),
    el('section', { classe: 'panneau', 'aria-labelledby': 'fiche-horaires' },
      el('h2', { id: 'fiche-horaires', texte: 'Horaires' }),
      lignes([
        ['Réservée le', moment(c.cree_le)],
        ['Prise en charge prévue', moment(c.prise_en_charge_le)],
        c.acceptee_le ? ['Acceptée', moment(c.acceptee_le)] : null,
        c.arrivee_le ? ['Arrivée au point de prise en charge', moment(c.arrivee_le)] : null,
        c.demarree_le ? ['Client à bord', moment(c.demarree_le)] : null,
        c.terminee_le ? ['Arrivée à destination', moment(c.terminee_le)] : null,
        c.annulee_le ? ['Annulation', moment(c.annulee_le)] : null
      ])),
    el('section', { classe: 'panneau', 'aria-labelledby': 'fiche-prix' },
      el('h2', { id: 'fiche-prix', texte: 'Prix et paiement' }),
      lignes(lignesPrix(c, paiements.data || []))),
    el('section', { classe: 'panneau', 'aria-labelledby': 'fiche-client' },
      el('h2', { id: 'fiche-client', texte: 'Client' }),
      lignes([
        c.pour_proche ? ['Passager', c.beneficiaire_nom || '—'] : null,
        [c.pour_proche ? 'Commandée par' : 'Client', c.client_prenom || '—'],
        ['Note du client', note.data ? `${'★'.repeat(note.data.note)}${'☆'.repeat(5 - note.data.note)} ${note.data.note}/5` : 'Pas de note'],
        note.data && note.data.commentaire ? ['Commentaire', `« ${note.data.commentaire} »`, 'libre'] : null
      ])),
    el('a', { classe: 'bouton bouton-principal bouton-large', id: 'fiche-feuille', target: '_blank', rel: 'noopener',
      href: `document/?type=feuille&course=${c.id}`, texte: 'Feuille de route (PDF)' }),
    el('p', { classe: 'aide', texte: 'La feuille de route s\'ouvre dans un nouvel onglet : imprimez-la ou enregistrez-la en PDF.' }),
    // Problème sur cette course (client absent, paiement, objet oublié…) :
    // nouvelle demande au support, la course déjà choisie
    el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-large', id: 'fiche-signaler',
      texte: 'Signaler un problème sur cette course', onclick: () => etat.contexte.ouvrirSupport({ nouvelle: true, course: c.id }) }));

  $('courses-zone-liste').hidden = true;
  $('courses-zone-fiche').hidden = false;
  window.scrollTo(0, 0);
  $('courses-retour').focus();
}

function moment(instant) {
  return dateHeure(instant, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Lignes « libellé … valeur » ; [libellé, valeur, 'libre'] : valeur sur toute la largeur
function lignes(liste) {
  return el('dl', { classe: 'lignes-valeurs' }, ...liste.filter(Boolean).flatMap(([dt, dd, style]) => (style === 'libre'
    ? [el('dt', { texte: dt }), el('dd', { classe: 'libre', texte: dd })]
    : [el('dt', { classe: style || null, texte: dt }), el('dd', { classe: style || null, texte: dd })])));
}

// Prix détaillé tel que la base l'a calculé, puis l'état du paiement.
// Course annulée : le prix qui était prévu et les frais d'annulation.
function lignesPrix(c, paiements) {
  const l = [];
  if (c.statut === 'annulee') {
    l.push(['Prix prévu', euros(c.prix_total)]);
    l.push(['Frais d\'annulation', euros(c.frais_annulation), 'total']);
  } else {
    // Le prix de base n'est détaillé que s'il a été ajusté (majoration,
    // supplément, remise) ; le total n'est ajouté que s'il y a de l'attente
    const majoration = majorationDe(c);
    const ajuste = majoration || Number(c.supplement) > 0 || Number(c.remise) > 0;
    const attente = Number(c.frais_attente) > 0;
    if (ajuste) {
      l.push([c.forfait_id ? 'Forfait' : 'Prix de base', euros(c.prix_base)]);
      if (majoration) {
        const libelle = ['Majoration', MAJORATIONS[c.majoration_type]].filter(Boolean).join(' ');
        l.push([`${libelle} (${nombre(c.majoration_pourcentage, 0)} %)`, euros(majoration), 'retrait']);
      }
      if (Number(c.supplement) > 0) l.push(['Supplément chauffeuse', euros(c.supplement), 'retrait']);
      if (Number(c.remise) > 0) l.push(['Remise (code promo)', `− ${euros(c.remise)}`, 'retrait']);
    }
    l.push([c.forfait_id && !ajuste ? 'Prix fixe (forfait)' : 'Prix fixe', euros(c.prix_total), attente ? null : 'total']);
    if (attente) {
      l.push([`Attente facturée (${c.attente_min} min)`, euros(c.frais_attente)]);
      l.push(['Total de la course', euros(chiffreCourse(c)), 'total']);
    }
    if (Number(c.pourboire) > 0) l.push(['Pourboire', euros(c.pourboire)]);
  }
  l.push(['Mode de paiement', MODES_PAIEMENT[c.mode_paiement] || c.mode_paiement]);
  const paiement = paiements.find((p) => p.nature === (c.statut === 'annulee' ? 'frais_annulation' : 'course'));
  if (paiement) l.push(['Paiement', STATUTS_PAIEMENT[paiement.statut] || paiement.statut]);
  return l;
}
