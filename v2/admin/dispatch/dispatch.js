// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : dispatch
// -----------------------------------------------------------------------------
// Une lecture complète (admin_dispatch) à l'ouverture, puis à chaque changement
// d'une course, d'une demande ou d'une position (temps réel, regroupé sur
// 0,7 s), et toutes les 20 secondes au cas où le temps réel serait coupé.
// Les comptes à rebours des demandes avancent chaque seconde, recalés sur
// l'horloge de la base (celle du téléphone peut avancer ou retarder).
// Actions : attribuer à la main (liste des chauffeurs avec distance, état,
// conflits et avertissements), relancer la recherche, retirer le chauffeur,
// annuler. Chaque action passe par une fonction serveur journalisée.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, apresPause, afficherMessage } from '../../commun/outils.js';
import { ouvrirAdministration, lienAdmin, compteurMenu } from '../commun/admin.js';
import { badgeCourse, badge, heure, libelleJour, depuis, MODES_PAIEMENT, messageErreurAdmin, lienTelephone } from '../commun/composants.js';
import { quandCourse, fenetreAttribution, relancerRecherche, retirerChauffeur, annulerCourse } from '../commun/actions-course.js';

const $ = (id) => document.getElementById(id);
const etat = { donnees: null, carte: null, calques: null, cadree: false, ecartHorloge: 0, reperes: {} };

ouvrirAdministration({ module: 'dispatch' }).then(async () => {
  initialiserCarte();
  await charger();
  const bientot = apresPause(charger, 700);
  supabase.channel('admin-dispatch')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'courses' }, bientot)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'propositions' }, bientot)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, bientot)
    .subscribe();
  setInterval(charger, 20000);
  setInterval(majMinuteurs, 1000);
});

async function charger() {
  const { data, error } = await supabase.rpc('admin_dispatch');
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  etat.donnees = data;
  etat.ecartHorloge = new Date(data.maintenant).getTime() - Date.now();
  afficher();
}

const maintenant = () => Date.now() + etat.ecartHorloge;

// ---------------------------------------------------------------------------
// Affichage des quatre listes
// ---------------------------------------------------------------------------
function afficher() {
  const courses = etat.donnees.courses || [];
  const aAttribuer = courses.filter((c) => c.statut === 'a_attribuer');
  const recherche = courses.filter((c) => c.statut === 'recherche');
  const enCours = courses.filter((c) => ['acceptee', 'arrivee', 'en_cours'].includes(c.statut));
  const aVenir = courses.filter((c) => c.statut === 'planifiee').sort((a, b) => a.prise_en_charge_le.localeCompare(b.prise_en_charge_le));

  remplir('liste-a-attribuer', aAttribuer, 'Aucune course en attente d\'attribution.');
  remplir('liste-recherche', recherche, 'Aucune recherche en cours.');
  remplir('liste-en-cours', enCours, 'Aucune course en route.');
  $('nb-a-attribuer').textContent = aAttribuer.length;
  $('nb-recherche').textContent = recherche.length;
  $('nb-en-cours').textContent = enCours.length;
  $('nb-a-venir').textContent = aVenir.length;
  $('bloc-a-attribuer').dataset.urgent = String(aAttribuer.length > 0);

  // Réservations, regroupées par jour
  const jours = new Map();
  for (const c of aVenir) {
    const jour = libelleJour(c.prise_en_charge_le);
    if (!jours.has(jour)) jours.set(jour, []);
    jours.get(jour).push(c);
  }
  $('liste-a-venir').replaceChildren(...(aVenir.length
    ? [...jours].map(([jour, liste]) => el('div', { classe: 'groupe-jour' },
      el('h3', { texte: jour.charAt(0).toUpperCase() + jour.slice(1) }),
      el('div', { classe: 'liste-courses-admin' }, ...liste.map(carteCourse))))
    : [el('p', { classe: 'vide-admin', texte: 'Aucune réservation à venir.' })]));
  const sansChauffeur = aVenir.filter((c) => !c.chauffeur_id).length;
  $('aide-a-venir').textContent = `${sansChauffeur ? `${sansChauffeur} sans chauffeur. ` : ''}`
    + `La recherche automatique démarre ${etat.donnees.recherche_avant_min} min avant l'heure prévue pour une réservation sans chauffeur.`;

  const chauffeurs = etat.donnees.chauffeurs || [];
  const enLigne = chauffeurs.filter((c) => c.en_ligne && c.signal_recent);
  $('resume').textContent = [
    aAttribuer.length ? `${aAttribuer.length} à attribuer` : null,
    recherche.length ? `${recherche.length} en recherche` : null,
    `${enLigne.length} chauffeur${enLigne.length > 1 ? 's' : ''} en ligne`
  ].filter(Boolean).join(' · ');
  compteurMenu('dispatch', aAttribuer.length);
  afficherChauffeurs(chauffeurs);
  afficherCarte(chauffeurs, [...aAttribuer, ...recherche]);
  majMinuteurs();
}

function remplir(id, courses, vide) {
  $(id).replaceChildren(...(courses.length ? courses.map(carteCourse) : [el('p', { classe: 'vide-admin', texte: vide })]));
}

// ---------------------------------------------------------------------------
// Carte d'une course
// ---------------------------------------------------------------------------
function telephone(numero) {
  return lienTelephone(numero);
}

function carteCourse(c) {
  const infos = [
    euros(c.prix_total), MODES_PAIEMENT[c.mode_paiement] || c.mode_paiement,
    `${nombre(c.distance_km, 1)} km, ${c.duree_min} min`,
    c.nb_arrets ? `${c.nb_arrets} arrêt${c.nb_arrets > 1 ? 's' : ''}` : null,
    c.duree_mad_heures ? `${nombre(c.duree_mad_heures, 1)} h` : null,
    c.numero_vol ? `Vol ${c.numero_vol}${c.terminal ? `, ${c.terminal}` : ''}` : null
  ].filter(Boolean);

  const carte = el('article', { classe: 'course-admin', dataset: { statut: c.statut, id: c.id } },
    el('header', { classe: 'course-admin-entete' },
      badgeCourse(c.statut),
      el('a', { classe: 'course-numero', href: lienAdmin(`courses/?id=${c.id}`), texte: c.numero }),
      c.option_chauffeuse ? badge('Chauffeuse demandée', 'or') : null,
      el('span', { classe: 'course-quand', texte: quandCourse(c) })),
    el('ol', { classe: 'trajet-admin' },
      el('li', { texte: c.depart_adresse + (c.depart_precision ? ` (${c.depart_precision})` : '') }),
      el('li', { texte: c.arrivee_adresse })),
    el('p', { classe: 'course-infos', texte: infos.join(' · ') }),
    el('p', { classe: 'course-client' },
      el('span', { texte: `Client : ${c.client_nom || c.client_email || 'sans nom'}` }), ' ', telephone(c.client_telephone),
      c.pour_proche ? el('span', { classe: 'secondaire', texte: ` · pour ${c.beneficiaire_nom}` }) : null,
      c.pour_proche ? ' ' : null, c.pour_proche ? telephone(c.beneficiaire_telephone) : null),
    ligneEtat(c),
    actions(c));
  return carte;
}

function ligneEtat(c) {
  if (c.statut === 'recherche') {
    if (c.demande) {
      return el('p', { classe: 'course-etat' },
        el('span', { texte: `Demande chez ${c.demande.chauffeur_nom || 'un chauffeur'}${c.demande.distance_km !== null ? ` (à ${nombre(c.demande.distance_km, 1)} km)` : ''} · ` }),
        el('strong', { classe: 'minuteur', dataset: { expire: c.demande.expire_le }, texte: '' }),
        c.nb_sans_reponse ? el('span', { texte: ` · ${c.nb_sans_reponse} sans réponse avant` }) : null);
    }
    return el('p', { classe: 'course-etat', texte: 'Recherche du chauffeur suivant…' });
  }
  if (c.statut === 'a_attribuer') {
    return el('p', { classe: 'course-etat texte-rouge',
      texte: c.nb_demandes ? `${c.nb_demandes} chauffeur${c.nb_demandes > 1 ? 's' : ''} sollicité${c.nb_demandes > 1 ? 's' : ''}, sans réponse favorable.`
        : 'Aucun chauffeur disponible au moment de la commande.' });
  }
  if (c.chauffeur_id) {
    const etapes = [];
    if (c.statut === 'acceptee' && c.acceptee_le) etapes.push(`en route depuis ${heure(c.acceptee_le)}`);
    if (c.statut === 'arrivee' && c.arrivee_le) etapes.push(`arrivé à ${heure(c.arrivee_le)}, attend depuis ${depuis(c.arrivee_le)}`);
    if (c.statut === 'en_cours' && c.demarree_le) etapes.push(`client à bord depuis ${heure(c.demarree_le)}`);
    if (c.attribution === 'manuelle') etapes.push('attribuée à la main');
    return el('p', { classe: 'course-etat' },
      el('span', { texte: `Chauffeur : ${c.chauffeur_nom || 'sans nom'}` }), ' ', telephone(c.chauffeur_telephone),
      el('span', { texte: `${c.vehicule_immatriculation ? ` · ${c.vehicule_immatriculation}` : ''}${etapes.length ? ` · ${etapes.join(' · ')}` : ''}` }));
  }
  return el('p', { classe: 'course-etat texte-or', texte: 'Sans chauffeur pour le moment.' });
}

function bouton(texte, action, classe = 'bouton-secondaire') {
  const b = el('button', { type: 'button', classe: `bouton ${classe} bouton-petit`, texte });
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await action(); } finally { b.disabled = false; }
  });
  return b;
}

function actions(c) {
  const liste = [];
  const attribuable = ['planifiee', 'recherche', 'a_attribuer'].includes(c.statut);
  if (attribuable) {
    const libelle = c.statut === 'recherche' ? 'Attribuer à la main' : c.chauffeur_id ? 'Changer de chauffeur' : 'Attribuer';
    liste.push(bouton(libelle, () => fenetreAttribution(c, charger), 'bouton-principal'));
  }
  if (c.statut === 'a_attribuer') liste.push(bouton('Relancer la recherche', () => relancerRecherche(c, charger)));
  if (c.chauffeur_id && ['planifiee', 'acceptee', 'arrivee'].includes(c.statut)) {
    liste.push(bouton('Retirer le chauffeur', () => retirerChauffeur(c, charger, etat.donnees.recherche_avant_min)));
  }
  if (c.statut !== 'en_cours') liste.push(bouton('Annuler la course', () => annulerCourse(c, charger), 'bouton-danger'));
  liste.push(el('a', { classe: 'bouton bouton-texte bouton-petit', href: lienAdmin(`courses/?id=${c.id}`), texte: 'Fiche' }));
  return el('div', { classe: 'actions-ligne' }, ...liste);
}

// Comptes à rebours des demandes en attente
function majMinuteurs() {
  document.querySelectorAll('.minuteur[data-expire]').forEach((n) => {
    const reste = Math.ceil((new Date(n.dataset.expire).getTime() - maintenant()) / 1000);
    n.textContent = reste > 0 ? `${reste} s pour répondre` : 'délai écoulé, chauffeur suivant…';
  });
}

// ---------------------------------------------------------------------------
// Chauffeurs : liste et carte
// ---------------------------------------------------------------------------
function etatChauffeur(c) {
  if (!c.en_ligne) return { code: 'hors', libelle: 'Hors ligne', ton: 'gris' };
  if (!c.signal_recent) return { code: 'silence', libelle: `Sans signal depuis ${depuis(c.position_le)}`, ton: 'gris' };
  if (c.course_active) return { code: 'occupe', libelle: `En course · ${c.course_active.numero}`, ton: 'bleu' };
  if (c.demande_en_attente) return { code: 'libre', libelle: 'Demande en cours', ton: 'or' };
  return { code: 'libre', libelle: 'Libre', ton: 'vert' };
}

function afficherChauffeurs(chauffeurs) {
  const enLigne = chauffeurs.filter((c) => c.en_ligne);
  $('resume-chauffeurs').textContent = chauffeurs.length
    ? `${enLigne.length} en ligne sur ${chauffeurs.length}` : 'Aucun chauffeur validé';
  $('liste-chauffeurs').replaceChildren(...chauffeurs.map((c) => {
    const e = etatChauffeur(c);
    const ligne = el('li', { classe: 'chauffeur-ligne' },
      el('div', {},
        el('strong', { texte: c.nom || 'Sans nom' }), ' ', badge(e.libelle, e.ton),
        el('span', { classe: 'secondaire', texte: c.vehicule || 'Aucun véhicule affecté' })),
      telephone(c.telephone));
    if (c.en_ligne && c.latitude !== null) {
      ligne.dataset.cliquable = 'true';
      ligne.title = 'Voir sur la carte';
      ligne.addEventListener('click', (ev) => {
        if (ev.target.closest('a') || !etat.carte) return;
        etat.carte.setView([c.latitude, c.longitude], 14);
        const repere = etat.reperes[c.id];
        if (repere) repere.openPopup();
      });
    }
    return ligne;
  }));
}

function initialiserCarte() {
  if (!window.L) { $('carte').hidden = true; return; }
  etat.carte = window.L.map('carte').setView([48.8566, 2.3522], 10);
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(etat.carte);
  etat.calques = window.L.layerGroup().addTo(etat.carte);
}

function initiales(nom) {
  return String(nom || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join('');
}

function afficherCarte(chauffeurs, courses) {
  if (!etat.carte) return;
  etat.calques.clearLayers();
  etat.reperes = {};
  const points = [];
  for (const c of chauffeurs.filter((x) => x.en_ligne && x.latitude !== null)) {
    const e = etatChauffeur(c);
    const repere = window.L.marker([c.latitude, c.longitude], {
      title: c.nom,
      icon: window.L.divIcon({ className: '', html: `<div class="repere-chauffeur" data-etat="${e.code}"></div>`, iconSize: [34, 34], iconAnchor: [17, 17] })
    });
    repere.on('add', () => { const n = repere.getElement()?.querySelector('.repere-chauffeur'); if (n) n.textContent = initiales(c.nom); });
    repere.bindPopup(() => el('div', {}, el('strong', { texte: c.nom || 'Chauffeur' }), el('br'), el('span', { texte: e.libelle })));
    repere.addTo(etat.calques);
    etat.reperes[c.id] = repere;
    points.push([c.latitude, c.longitude]);
  }
  for (const c of courses) {
    const repere = window.L.marker([c.depart_lat, c.depart_lng], {
      title: c.numero,
      icon: window.L.divIcon({ className: '', html: `<div class="repere-course" data-statut="${c.statut}"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] })
    });
    repere.bindPopup(() => el('div', {}, el('strong', { texte: c.numero }), el('br'), el('span', { texte: c.depart_adresse })));
    repere.on('click', () => {
      const carte = document.querySelector(`.course-admin[data-id="${c.id}"]`);
      if (carte) carte.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    repere.addTo(etat.calques);
    points.push([c.depart_lat, c.depart_lng]);
  }
  if (!etat.cadree && points.length) {
    etat.carte.fitBounds(points, { padding: [40, 40], maxZoom: 13 });
    etat.cadree = true;
  }
}
