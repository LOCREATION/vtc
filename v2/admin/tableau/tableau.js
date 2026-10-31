// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : tableau de bord
// -----------------------------------------------------------------------------
// Deux lectures (fonctions serveur réservées à l'administration) :
//   - admin_tableau_de_bord : chiffres, statuts, série de 14 jours, alertes ;
//   - admin_dispatch : positions des chauffeurs et courses actives (carte).
// Mise à jour à chaque changement de course ou de position (temps réel), et
// toutes les minutes au cas où le temps réel serait coupé.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, apresPause } from '../../commun/outils.js';
import { ouvrirAdministration, lienAdmin, compteurMenu } from '../commun/admin.js';
import { heure, dateCourte, messageErreurAdmin, tableau } from '../commun/composants.js';
import { afficherMessage } from '../../commun/outils.js';

const $ = (id) => document.getElementById(id);
const etat = { carte: null, calques: null, premiereVue: true, serie: [] };

// Pages vers lesquelles mènent les alertes (modules construits)
// (une alerte peut aussi porter son propre lien, vers la bonne liste)
const PAGES = {
  dispatch: 'dispatch/', courses: 'courses/', clients: 'clients/?vue=entreprises', chauffeurs: 'chauffeurs/',
  flotte: 'flotte/', tarifs: 'tarifs/', finances: 'finances/', plateformes: 'plateformes/', rh: 'rh/', parametres: 'parametres/'
};

ouvrirAdministration({ module: 'tableau' }).then(async () => {
  initialiserCarte();
  await charger();
  const rechargerBientot = apresPause(charger, 1500);
  supabase.channel('admin-tableau')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'courses' }, rechargerBientot)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, rechargerBientot)
    .subscribe();
  setInterval(charger, 60000);
  $('voir-tableau').addEventListener('click', basculerTableau);
  // Le graphique est dessiné à la largeur réelle de son cadre : redessiné
  // quand la fenêtre change de taille (rotation du téléphone)
  window.addEventListener('resize', apresPause(() => afficherGraphique(etat.serie), 200));
});

async function charger() {
  const [tdb, dispatch] = await Promise.all([
    supabase.rpc('admin_tableau_de_bord'),
    supabase.rpc('admin_dispatch')
  ]);
  if (tdb.error || dispatch.error) {
    afficherMessage(messageErreurAdmin(tdb.error || dispatch.error), 'erreur');
    return;
  }
  const d = tdb.data;
  afficherChiffres(d);
  afficherStatuts(d.statuts || {});
  afficherAlertes(d.alertes || []);
  afficherCarte(dispatch.data);
  afficherGraphique(d.serie || []);
  compteurMenu('dispatch', (d.statuts || {}).a_attribuer || 0);
  $('maj').textContent = `Mis à jour à ${heure(d.maintenant)}`;
}

// ---------------------------------------------------------------------------
// Chiffres clés
// ---------------------------------------------------------------------------
function tuile(libelle, valeur, detail) {
  return el('div', { classe: 'chiffre-cle' },
    el('dt', { texte: libelle }),
    el('dd', { texte: valeur }),
    detail ? el('dd', { classe: 'detail', texte: detail }) : null);
}

function pluriel(n, singulier, pluriel_) {
  return `${n} ${n > 1 ? pluriel_ : singulier}`;
}

function afficherChiffres(d) {
  const j = d.jour, s = d.sept_jours, m = d.mois, c = d.chauffeurs;
  $('chiffres').replaceChildren(
    tuile('Aujourd\'hui', euros(j.chiffre_affaires),
      `${pluriel(j.courses_terminees, 'course terminée', 'courses terminées')}${j.annulations ? ` · ${pluriel(j.annulations, 'annulation', 'annulations')}` : ''}`),
    tuile('7 derniers jours', euros(s.chiffre_affaires), pluriel(s.courses_terminees, 'course', 'courses')),
    tuile('Ce mois-ci', euros(m.chiffre_affaires),
      `${pluriel(m.courses_terminees, 'course', 'courses')}${Number(m.pourboires) > 0 ? ` · ${euros(m.pourboires)} de pourboires` : ''}`),
    tuile('Chauffeurs en ligne', `${c.en_ligne} / ${c.valides}`,
      c.occupes ? `${pluriel(c.occupes, 'en course', 'en course')}` : (c.valides ? 'aucun en course' : 'aucun chauffeur validé')));
}

// ---------------------------------------------------------------------------
// Courses en ce moment
// ---------------------------------------------------------------------------
const ORDRE_STATUTS = [
  { code: 'a_attribuer', libelle: 'À attribuer', ton: 'rouge' },
  { code: 'recherche', libelle: 'Recherche en cours', ton: 'or' },
  { code: 'acceptee', libelle: 'En approche', ton: 'vert' },
  { code: 'arrivee', libelle: 'Chauffeur arrivé', ton: 'vert' },
  { code: 'en_cours', libelle: 'Client à bord', ton: 'vert' },
  { code: 'planifiee', libelle: 'Réservations à venir', ton: 'bleu' }
];

function afficherStatuts(statuts) {
  $('statuts').replaceChildren(...ORDRE_STATUTS.map((s) => {
    const n = statuts[s.code] || 0;
    return el('li', { classe: 'statut', dataset: { ton: n ? s.ton : 'gris' } },
      el('a', { href: lienAdmin('dispatch/') },
        el('span', { classe: 'statut-nombre', texte: String(n) }),
        el('span', { classe: 'statut-libelle', texte: s.libelle })));
  }));
}

// ---------------------------------------------------------------------------
// Alertes
// ---------------------------------------------------------------------------
const NIVEAUX = { urgent: 'Urgent', attention: 'À surveiller', info: 'À faire' };

function afficherAlertes(alertes) {
  $('nb-alertes').textContent = alertes.length ? pluriel(alertes.length, 'point', 'points') : '';
  if (!alertes.length) {
    $('alertes').replaceChildren(el('li', { classe: 'vide-admin', texte: 'Rien à traiter pour le moment.' }));
    return;
  }
  $('alertes').replaceChildren(...alertes.map((a) => el('li', { classe: 'alerte-admin', dataset: { niveau: a.niveau } },
    el('span', { classe: 'alerte-niveau', texte: NIVEAUX[a.niveau] || a.niveau }),
    el('strong', { texte: a.titre }),
    a.lien || PAGES[a.module] ? el('a', { href: lienAdmin(a.lien || PAGES[a.module]), texte: 'Ouvrir' }) : null,
    el('p', { texte: a.detail }))));
}

// ---------------------------------------------------------------------------
// Carte des chauffeurs et des courses à attribuer
// ---------------------------------------------------------------------------
function initialiserCarte() {
  if (!window.L) { $('carte').hidden = true; return; }
  etat.carte = window.L.map('carte', { zoomControl: true, attributionControl: true }).setView([48.8566, 2.3522], 10);
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(etat.carte);
  etat.calques = window.L.layerGroup().addTo(etat.carte);
}

function initiales(nom) {
  return String(nom || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join('');
}

function afficherCarte(dispatch) {
  const enLigne = (dispatch.chauffeurs || []).filter((c) => c.en_ligne && c.latitude !== null);
  const aAttribuer = (dispatch.courses || []).filter((c) => c.statut === 'a_attribuer' || c.statut === 'recherche');
  const libres = enLigne.filter((c) => c.signal_recent && !c.course_active).length;
  $('resume-carte').textContent = enLigne.length
    ? `${pluriel(enLigne.length, 'en ligne', 'en ligne')}, ${pluriel(libres, 'libre', 'libres')}`
    : 'Aucun chauffeur en ligne';
  if (!etat.carte) return;
  etat.calques.clearLayers();
  const points = [];
  for (const c of enLigne) {
    const etatChauffeur = !c.signal_recent ? 'silence' : c.course_active ? 'occupe' : 'libre';
    const repere = window.L.marker([c.latitude, c.longitude], {
      title: c.nom,
      icon: window.L.divIcon({ className: '', html: `<div class="repere-chauffeur" data-etat="${etatChauffeur}"></div>`, iconSize: [34, 34], iconAnchor: [17, 17] })
    });
    repere.on('add', () => { const n = repere.getElement()?.querySelector('.repere-chauffeur'); if (n) n.textContent = initiales(c.nom); });
    repere.bindPopup(() => el('div', {},
      el('strong', { texte: c.nom || 'Chauffeur' }), el('br'),
      el('span', { texte: c.course_active ? `En course · ${c.course_active.numero}` : c.signal_recent ? 'Libre' : 'Sans signal depuis 3 min' }),
      c.vehicule ? el('br') : null, c.vehicule ? el('span', { texte: c.vehicule }) : null));
    repere.addTo(etat.calques);
    points.push([c.latitude, c.longitude]);
  }
  for (const course of aAttribuer) {
    const repere = window.L.marker([course.depart_lat, course.depart_lng], {
      title: course.numero,
      icon: window.L.divIcon({ className: '', html: `<div class="repere-course" data-statut="${course.statut}"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] })
    });
    repere.bindPopup(() => el('div', {},
      el('strong', { texte: course.numero }), el('br'),
      el('span', { texte: course.depart_adresse }), el('br'),
      el('a', { href: lienAdmin('dispatch/'), texte: 'Attribuer dans le dispatch' })));
    repere.addTo(etat.calques);
    points.push([course.depart_lat, course.depart_lng]);
  }
  // Cadrage automatique au premier affichage seulement (ne pas gêner la lecture)
  if (etat.premiereVue && points.length) {
    etat.carte.fitBounds(points, { padding: [40, 40], maxZoom: 13 });
    etat.premiereVue = false;
  }
}

// ---------------------------------------------------------------------------
// Graphique : chiffre d'affaires par jour (une seule série, barres fines)
// ---------------------------------------------------------------------------
// Barres de 24 px au plus, arrondi de 4 px en haut, carré à la base ; grille
// en traits fins ; seule la valeur du jour est écrite, les autres sont dans
// l'infobulle (survol et clavier) et dans le tableau « Voir les chiffres ».
function arrondiAxe(max) {
  if (max <= 0) return 50;
  const puissance = 10 ** Math.floor(Math.log10(max));
  for (const pas of [1, 2, 2.5, 5, 10]) {
    if (pas * puissance >= max) return pas * puissance;
  }
  return 10 * puissance;
}

function afficherGraphique(serie) {
  etat.serie = serie;
  const zone = $('graphique');
  // Une unité du dessin = un pixel à l'écran : textes toujours lisibles
  const L = Math.max(280, Math.round(zone.clientWidth || 640));
  const H = L < 500 ? 210 : 240, gauche = 52, droite = 6, haut = 24, bas = 30;
  const largeurUtile = L - gauche - droite, hauteurUtile = H - haut - bas;
  const max = arrondiAxe(Math.max(...serie.map((p) => Number(p.chiffre_affaires)), 0));
  const pasX = largeurUtile / Math.max(serie.length, 1);
  const largeurBarre = Math.min(24, pasX * 0.6);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${L} ${H}`);
  svg.setAttribute('class', 'graphique');
  svg.setAttribute('role', 'img');
  const total = serie.reduce((s, p) => s + Number(p.chiffre_affaires), 0);
  svg.setAttribute('aria-label', `Chiffre d'affaires des 14 derniers jours : ${euros(total)} au total.`);
  const creer = (nom, attributs) => {
    const n = document.createElementNS(ns, nom);
    for (const [cle, valeur] of Object.entries(attributs)) n.setAttribute(cle, valeur);
    return n;
  };

  // Grille et graduations : 0, moitié, maximum
  for (const fraction of [0, 0.5, 1]) {
    const y = haut + hauteurUtile * (1 - fraction);
    svg.append(creer('line', { x1: gauche, x2: L - droite, y1: y, y2: y, stroke: fraction === 0 ? '#B8C2D3' : '#E3E8EF', 'stroke-width': 1 }));
    const texte = creer('text', { x: gauche - 8, y: y + 4, 'text-anchor': 'end' });
    texte.textContent = euros(max * fraction).replace(/[,.]00\s?€/, ' €');
    svg.append(texte);
  }

  const bulle = el('div', { classe: 'bulle-graphique', role: 'tooltip', hidden: true });
  serie.forEach((p, i) => {
    const valeur = Number(p.chiffre_affaires);
    const h = max > 0 ? (valeur / max) * hauteurUtile : 0;
    const x = gauche + pasX * i + (pasX - largeurBarre) / 2;
    const y = haut + hauteurUtile - h;
    const r = Math.min(4, h, largeurBarre / 2);
    // Barre : coins arrondis en haut seulement
    const chemin = h > 0
      ? `M${x},${haut + hauteurUtile} V${y + r} Q${x},${y} ${x + r},${y} H${x + largeurBarre - r} Q${x + largeurBarre},${y} ${x + largeurBarre},${y + r} V${haut + hauteurUtile} Z`
      : '';
    const groupe = creer('g', { tabindex: '0', class: 'barre', role: 'img' });
    const libelle = `${dateCourte(p.jour)} : ${euros(valeur)}, ${p.courses} course${p.courses > 1 ? 's' : ''}`;
    groupe.setAttribute('aria-label', libelle);
    // Zone de survol plus large que la barre
    groupe.append(creer('rect', { x: gauche + pasX * i, y: haut, width: pasX, height: hauteurUtile, fill: 'transparent' }));
    if (chemin) groupe.append(creer('path', { d: chemin, fill: i === serie.length - 1 ? '#0A1A38' : '#1B3A6B' }));
    // Jour sous la barre (un sur deux sur petit écran via la taille du texte)
    const jour = creer('text', { x: gauche + pasX * i + pasX / 2, y: H - 10, 'text-anchor': 'middle' });
    jour.textContent = p.jour.slice(8, 10);
    groupe.append(jour);
    // Valeur écrite : seulement aujourd'hui
    if (i === serie.length - 1 && valeur > 0) {
      const v = creer('text', { x: gauche + pasX * i + pasX / 2, y: y - 6, 'text-anchor': 'middle', class: 'valeur-jour' });
      v.textContent = euros(valeur).replace(/[,.]00\s?€/, ' €');
      groupe.append(v);
    }
    const montrer = () => {
      bulle.replaceChildren(el('strong', { texte: euros(valeur) }), el('span', { texte: `${dateCourte(p.jour)} · ${p.courses} course${p.courses > 1 ? 's' : ''}` }));
      bulle.hidden = false;
      const boite = zone.getBoundingClientRect();
      const pourcent = (gauche + pasX * i + pasX / 2) / L;
      bulle.style.left = `${Math.min(Math.max(pourcent * boite.width, 70), boite.width - 70)}px`;
      groupe.classList.add('active');
    };
    const cacher = () => { bulle.hidden = true; groupe.classList.remove('active'); };
    groupe.addEventListener('pointerenter', montrer);
    groupe.addEventListener('pointerleave', cacher);
    groupe.addEventListener('focus', montrer);
    groupe.addEventListener('blur', cacher);
    svg.append(groupe);
  });
  zone.replaceChildren(svg, bulle);

  // Tableau des mêmes chiffres (accessible sans survol)
  $('tableau-serie').replaceChildren(tableau({
    colonnes: [
      { titre: 'Jour', valeur: (p) => dateCourte(p.jour) },
      { titre: 'Courses', valeur: (p) => String(p.courses), droite: true },
      { titre: 'Chiffre d\'affaires TTC', valeur: (p) => euros(p.chiffre_affaires), droite: true }
    ],
    lignes: [...serie].reverse()
  }));
}

function basculerTableau() {
  const zone = $('tableau-serie');
  zone.hidden = !zone.hidden;
  $('voir-tableau').setAttribute('aria-expanded', String(!zone.hidden));
  $('voir-tableau').textContent = zone.hidden ? 'Voir les chiffres' : 'Masquer les chiffres';
}
