// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : tarifs et zones
// -----------------------------------------------------------------------------
// Cinq onglets (gardés dans l'adresse : ?onglet=…) :
//   - Tarifs : tarifs datés par catégorie. Un nouveau tarif prend le relais à
//     sa date de début ; les courses déjà commandées gardent leur prix (il est
//     figé dans la course). Modifier le tarif en vigueur reste possible ;
//   - Lieux et forfaits : aéroports, gares et villes (cercle sur la carte),
//     forfaits entre deux lieux, dans les deux sens ;
//   - Majorations et fériés : nuit, dimanche, jours fériés (non cumulables :
//     la plus forte s'applique ; jamais sur un forfait) ;
//   - Catégories : véhicules proposés aux clients ;
//   - Réglages : calcul des distances, dispatch, annulation, attente, zone
//     desservie (rectangle sur la carte), TVA, parrainage.
// Toutes les modifications passent par les règles d'accès (administration
// avec double authentification) et sont inscrites au journal.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, afficherMessage } from '../../commun/outils.js';
import { ChampAdresse } from '../../commun/adresse.js';
import { ouvrirAdministration } from '../commun/admin.js';
import {
  badge, dateCourte, jourParis, ajouterJours, tableau, fenetreFormulaire, confirmer, messageErreurAdmin
} from '../commun/composants.js';

const $ = (id) => document.getElementById(id);
const ONGLETS = [
  { code: 'tarifs', libelle: 'Tarifs' },
  { code: 'lieux', libelle: 'Lieux et forfaits' },
  { code: 'majorations', libelle: 'Majorations et fériés' },
  { code: 'categories', libelle: 'Catégories' },
  { code: 'reglages', libelle: 'Réglages' }
];
const TYPES_ZONE = { aeroport: 'Aéroport', gare: 'Gare', ville: 'Ville', autre: 'Autre lieu' };
const MAJORATIONS = { nuit: 'Nuit', dimanche: 'Dimanche', ferie: 'Jour férié' };
const etat = { onglet: 'tarifs', categories: [], tarifs: [], zones: [], forfaits: [], majorations: [], feries: [], parametres: null, cartes: [] };

ouvrirAdministration({ module: 'tarifs' }).then(async () => {
  const demande = new URLSearchParams(location.search).get('onglet');
  if (ONGLETS.some((o) => o.code === demande)) etat.onglet = demande;
  await charger();
});

async function charger() {
  const [categories, tarifs, zones, forfaits, majorations, feries, parametres] = await Promise.all([
    supabase.from('categories').select('*').order('ordre').order('nom_fr'),
    supabase.from('tarifs').select('*').order('valide_du', { ascending: false }),
    supabase.from('zones').select('*').order('type').order('nom'),
    supabase.from('forfaits').select('*'),
    supabase.from('majorations').select('*'),
    supabase.from('jours_feries').select('*').order('jour'),
    supabase.from('parametres').select('*').maybeSingle()
  ]);
  const erreur = [categories, tarifs, zones, forfaits, majorations, feries, parametres].find((r) => r.error);
  if (erreur) { $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(erreur.error) })); return; }
  Object.assign(etat, {
    categories: categories.data, tarifs: tarifs.data, zones: zones.data, forfaits: forfaits.data,
    majorations: majorations.data, feries: feries.data, parametres: parametres.data
  });
  afficher();
}

function afficher() {
  // Les cartes de l'onglet précédent sont retirées proprement
  etat.cartes.forEach((c) => c.remove());
  etat.cartes = [];
  $('onglets').replaceChildren(...ONGLETS.map((o) => {
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(o.code === etat.onglet), texte: o.libelle });
    b.addEventListener('click', () => {
      etat.onglet = o.code;
      history.replaceState(null, '', `${location.pathname}?onglet=${o.code}`);
      afficher();
    });
    return b;
  }));
  ({ tarifs: afficherTarifs, lieux: afficherLieux, majorations: afficherMajorations, categories: afficherCategories, reglages: afficherReglages })[etat.onglet]();
}

function bouton(texte, action, classe = 'bouton-secondaire') {
  const b = el('button', { type: 'button', classe: `bouton ${classe} bouton-petit`, texte });
  b.addEventListener('click', async () => { b.disabled = true; try { await action(); } finally { b.disabled = false; } });
  return b;
}

function nomCategorie(id) {
  return (etat.categories.find((c) => c.id === id) || {}).nom_fr || '—';
}

function nomZone(id) {
  return (etat.zones.find((z) => z.id === id) || {}).nom || '—';
}

// Enregistre (ajout ou modification) dans une table ; renvoie l'erreur éventuelle
async function enregistrerLigne(table, valeurs, id, cle = 'id') {
  const requete = id === null || id === undefined
    ? supabase.from(table).insert(valeurs)
    : supabase.from(table).update(valeurs).eq(cle, id);
  const { error } = await requete;
  if (error) throw error;
}

async function supprimerLigne(table, id, message, cle = 'id') {
  const { error } = await supabase.from(table).delete().eq(cle, id);
  if (error) {
    afficherMessage(/foreign key/i.test(error.message || '') && message ? message : messageErreurAdmin(error), 'erreur');
    return false;
  }
  return true;
}

function carteLeaflet(zone) {
  if (!window.L) { zone.hidden = true; return null; }
  const carte = window.L.map(zone, { scrollWheelZoom: false }).setView([48.86, 2.35], 9);
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(carte);
  etat.cartes.push(carte);
  return carte;
}

// #############################################################################
// Onglet « Tarifs »
// #############################################################################
// État d'un tarif aujourd'hui (même règle que la base : le plus récent déjà commencé)
function etatTarif(t) {
  const aujourdhui = jourParis();
  if (t.valide_du > aujourdhui) return { code: 'a_venir', libelle: `À partir du ${dateCourte(t.valide_du)}`, ton: 'bleu' };
  const enVigueur = etat.tarifs
    .filter((x) => x.categorie_id === t.categorie_id && x.valide_du <= aujourdhui && (!x.valide_au || x.valide_au >= aujourdhui))
    .sort((a, b) => b.valide_du.localeCompare(a.valide_du))[0];
  if (enVigueur && enVigueur.id === t.id) return { code: 'en_vigueur', libelle: 'En vigueur', ton: 'vert' };
  return { code: 'termine', libelle: 'Remplacé', ton: 'gris' };
}

const CHAMPS_TARIF = (avecCategorie) => [
  ...(avecCategorie ? [{ nom: 'categorie_id', libelle: 'Catégorie', type: 'choix', requis: true, options: etat.categories.map((c) => ({ valeur: c.id, libelle: c.nom_fr })) }] : []),
  { nom: 'valide_du', libelle: 'En vigueur à partir du', type: 'date', requis: true },
  { nom: 'valide_au', libelle: 'Jusqu\'au', type: 'date', aide: 'Laissez vide : le tarif reste en vigueur jusqu\'au suivant.' },
  { nom: 'prise_en_charge', libelle: 'Prise en charge (€)', type: 'nombre', requis: true, min: 0, pas: '0.01' },
  { nom: 'prix_km', libelle: 'Prix du kilomètre (€)', type: 'nombre', requis: true, min: 0, pas: '0.01' },
  { nom: 'prix_minute', libelle: 'Prix de la minute (€)', type: 'nombre', requis: true, min: 0, pas: '0.01' },
  { nom: 'minimum', libelle: 'Course minimum (€)', type: 'nombre', requis: true, min: 0, pas: '0.01' },
  { nom: 'prix_attente_minute', libelle: 'Attente, par minute au-delà du temps gratuit (€)', type: 'nombre', requis: true, min: 0, pas: '0.01' },
  { nom: 'prix_heure_mad', libelle: 'Mise à disposition, prix de l\'heure (€)', type: 'nombre', min: 0.01, pas: '0.01',
    aide: 'Laissez vide si la mise à disposition n\'est pas proposée.' },
  { nom: 'frais_annulation', libelle: 'Frais d\'annulation (€)', type: 'nombre', requis: true, min: 0, pas: '0.01',
    aide: 'Facturés si le client annule après l\'acceptation du chauffeur, ou trop tard pour une réservation.' },
  { nom: 'supplement_chauffeuse', libelle: 'Supplément « chauffeuse » (€)', type: 'nombre', requis: true, min: 0, pas: '0.01' }
];

const CHAMPS_NUMERIQUES_TARIF = ['prise_en_charge', 'prix_km', 'prix_minute', 'minimum', 'prix_attente_minute', 'prix_heure_mad', 'frais_annulation', 'supplement_chauffeuse'];

function arrondirTarif(v) {
  const resultat = { ...v };
  for (const cle of CHAMPS_NUMERIQUES_TARIF) {
    if (resultat[cle] !== null && resultat[cle] !== undefined) resultat[cle] = Math.round(resultat[cle] * 100) / 100;
  }
  if (resultat.valide_au && resultat.valide_au < resultat.valide_du) throw new Error('La date de fin doit être postérieure à la date de début.');
  return resultat;
}

function afficherTarifs() {
  const sections = etat.categories.map((cat) => {
    const tarifs = etat.tarifs.filter((t) => t.categorie_id === cat.id);
    const actuel = tarifs.find((t) => etatTarif(t).code === 'en_vigueur');
    return el('section', { classe: 'carte-admin', 'aria-label': `Tarifs : ${cat.nom_fr}` },
      el('div', { classe: 'carte-entete' },
        el('h2', { texte: cat.nom_fr }),
        cat.active ? null : badge('Catégorie désactivée', 'gris'),
        bouton('Nouveau tarif à partir d\'une date', () => nouveauTarif(cat, actuel), 'bouton-principal')),
      actuel ? el('p', { classe: 'resume-tarif', texte: resumeTarif(actuel) }) : el('p', { classe: 'alerte', texte: 'Aucun tarif en vigueur aujourd\'hui : les clients ne peuvent pas commander dans cette catégorie.' }),
      tableau({
        colonnes: [
          { titre: 'Période', valeur: (t) => el('span', {}, `${dateCourte(t.valide_du)} → ${t.valide_au ? dateCourte(t.valide_au) : '…'}`, el('span', { classe: 'secondaire' }, badge(etatTarif(t).libelle, etatTarif(t).ton))) },
          { titre: 'Prise en charge', droite: true, valeur: (t) => euros(t.prise_en_charge) },
          { titre: 'Km', droite: true, valeur: (t) => euros(t.prix_km) },
          { titre: 'Minute', droite: true, valeur: (t) => euros(t.prix_minute) },
          { titre: 'Minimum', droite: true, valeur: (t) => euros(t.minimum) },
          { titre: 'Attente / min', droite: true, valeur: (t) => euros(t.prix_attente_minute) },
          { titre: 'Heure MAD', droite: true, valeur: (t) => (t.prix_heure_mad ? euros(t.prix_heure_mad) : 'Non proposée') },
          { titre: 'Annulation', droite: true, valeur: (t) => euros(t.frais_annulation) },
          { titre: 'Chauffeuse', droite: true, valeur: (t) => euros(t.supplement_chauffeuse) },
          { titre: '', valeur: (t) => el('div', { classe: 'actions-ligne' },
            bouton('Modifier', () => modifierTarif(t)),
            etatTarif(t).code === 'a_venir' ? bouton('Supprimer', () => supprimerTarif(t), 'bouton-danger') : null) }
        ],
        lignes: tarifs, vide: 'Aucun tarif.'
      }));
  });
  $('contenu').replaceChildren(
    el('p', { classe: 'sous-titre', texte: 'Le prix annoncé au client = prise en charge + kilomètres + minutes (au moins le minimum), sauf forfait entre deux lieux ; majoration éventuelle, puis option chauffeuse et code promo. Un nouveau tarif prend le relais à sa date de début ; les courses déjà commandées gardent leur prix.' }),
    ...sections);
}

function resumeTarif(t) {
  return `En vigueur : ${euros(t.prise_en_charge)} + ${euros(t.prix_km)}/km + ${euros(t.prix_minute)}/min, minimum ${euros(t.minimum)} · `
    + `annulation ${euros(t.frais_annulation)} · mise à disposition ${t.prix_heure_mad ? `${euros(t.prix_heure_mad)}/h` : 'non proposée'}.`;
}

async function nouveauTarif(cat, actuel) {
  const base = actuel ? { ...actuel } : { prise_en_charge: 0, prix_km: 0, prix_minute: 0, minimum: 0, prix_attente_minute: 0, frais_annulation: 0, supplement_chauffeuse: 0 };
  delete base.id;
  const fait = await fenetreFormulaire({
    titre: `Nouveau tarif : ${cat.nom_fr}`,
    intro: 'Prérempli avec le tarif en vigueur. Il s\'appliquera aux courses commandées pour une prise en charge à partir de sa date de début.',
    champs: CHAMPS_TARIF(false), large: true,
    valeurs: { ...base, valide_du: ajouterJours(jourParis(), 1), valide_au: null },
    libelle: 'Créer le tarif',
    enregistrer: async (v) => enregistrerLigne('tarifs', { ...arrondirTarif(v), categorie_id: cat.id })
  });
  if (fait) { afficherMessage('Tarif créé.', 'succes'); await charger(); }
}

async function modifierTarif(t) {
  const enVigueur = etatTarif(t).code === 'en_vigueur';
  const fait = await fenetreFormulaire({
    titre: `Tarif du ${dateCourte(t.valide_du)} : ${nomCategorie(t.categorie_id)}`,
    intro: enVigueur ? 'Tarif en vigueur : la modification s\'applique aux prochaines estimations et commandes, pas aux courses déjà commandées. Elle est inscrite au journal.' : null,
    champs: CHAMPS_TARIF(false), valeurs: t, large: true,
    enregistrer: async (v) => enregistrerLigne('tarifs', arrondirTarif(v), t.id)
  });
  if (fait) { afficherMessage('Tarif enregistré.', 'succes'); await charger(); }
}

async function supprimerTarif(t) {
  const ok = await confirmer({ titre: 'Supprimer ce tarif à venir ?', texte: `Tarif prévu à partir du ${dateCourte(t.valide_du)}.`, libelle: 'Supprimer', danger: true });
  if (!ok) return;
  if (await supprimerLigne('tarifs', t.id, 'Ce tarif a servi à des courses : il ne peut pas être supprimé. Fixez plutôt une date de fin.')) {
    afficherMessage('Tarif supprimé.', 'succes');
    await charger();
  }
}

// #############################################################################
// Onglet « Lieux et forfaits »
// #############################################################################
function afficherLieux() {
  const zoneCarte = el('div', { classe: 'carte-admin-map', role: 'img', 'aria-label': 'Carte des lieux desservis' });
  $('contenu').replaceChildren(
    el('section', { classe: 'carte-admin' },
      el('div', { classe: 'carte-entete' }, el('h2', { texte: 'Lieux desservis' }), bouton('Ajouter un lieu', () => formulaireZone(null), 'bouton-principal')),
      el('p', { classe: 'sous-titre', texte: 'Un point appartient à un lieu s\'il est dans son cercle. Les lieux servent aux forfaits et aux raccourcis proposés aux clients ; le plus précis l\'emporte (une gare dans une ville).' }),
      zoneCarte,
      tableau({
        colonnes: [
          { titre: 'Lieu', valeur: (z) => el('span', {}, z.nom, el('span', { classe: 'secondaire', texte: z.code })) },
          { titre: 'Type', valeur: (z) => TYPES_ZONE[z.type] || z.type },
          { titre: 'Rayon', droite: true, valeur: (z) => `${nombre(z.rayon_km, 2)} km` },
          { titre: 'État', valeur: (z) => (z.active ? badge('Actif', 'vert') : badge('Désactivé', 'gris')) },
          { titre: '', valeur: (z) => bouton('Modifier', () => formulaireZone(z)) }
        ],
        lignes: etat.zones, vide: 'Aucun lieu.'
      })),
    el('section', { classe: 'carte-admin' },
      el('div', { classe: 'carte-entete' }, el('h2', { texte: 'Forfaits' }), bouton('Ajouter un forfait', () => formulaireForfait(null), 'bouton-principal')),
      el('p', { classe: 'sous-titre', texte: 'Prix fixe entre deux lieux, dans les deux sens, sans arrêt. Pas de majoration de nuit ni de dimanche sur un forfait.' }),
      tableau({
        colonnes: [
          { titre: 'Trajet', valeur: (f) => `${nomZone(f.zone_a_id)} ↔ ${nomZone(f.zone_b_id)}` },
          { titre: 'Catégorie', valeur: (f) => nomCategorie(f.categorie_id) },
          { titre: 'Prix TTC', droite: true, valeur: (f) => euros(f.prix) },
          { titre: 'État', valeur: (f) => (f.active ? badge('Actif', 'vert') : badge('Désactivé', 'gris')) },
          { titre: '', valeur: (f) => el('div', { classe: 'actions-ligne' }, bouton('Modifier', () => formulaireForfait(f)), bouton('Supprimer', () => supprimerForfait(f), 'bouton-danger')) }
        ],
        lignes: [...etat.forfaits].sort((a, b) => `${nomZone(a.zone_a_id)}${nomZone(a.zone_b_id)}`.localeCompare(`${nomZone(b.zone_a_id)}${nomZone(b.zone_b_id)}`)),
        vide: 'Aucun forfait. Exemple : un lieu « Paris » (ville, rayon 6 km) et un forfait Paris ↔ Roissy-CDG.'
      })));

  const carte = carteLeaflet(zoneCarte);
  if (!carte) return;
  const limites = [];
  for (const z of etat.zones) {
    const cercle = window.L.circle([z.latitude, z.longitude], {
      radius: Number(z.rayon_km) * 1000, color: z.active ? '#1B3A6B' : '#8A9BBA', weight: 2, fillOpacity: 0.1
    }).addTo(carte);
    cercle.bindTooltip(z.nom);
    limites.push(cercle.getBounds());
  }
  if (limites.length) carte.fitBounds(limites.reduce((a, b) => a.extend(b)), { padding: [20, 20] });
}

// Code technique à partir du nom : « Gare de Lyon » → « gare_de_lyon »
function codeDepuisNom(nom) {
  return String(nom || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

async function formulaireZone(z) {
  const recherche = el('input', { id: 'zone-recherche', classe: 'saisie', type: 'text', placeholder: 'Adresse ou nom du lieu', autocomplete: 'off' });
  const blocRecherche = el('div', { classe: 'champ' },
    el('label', { for: 'zone-recherche', texte: 'Chercher le lieu (remplit le centre du cercle)' }),
    el('div', { classe: 'point-saisie-admin' }, recherche));
  const fait = await fenetreFormulaire({
    titre: z ? `Lieu : ${z.nom}` : 'Ajouter un lieu',
    avant: [blocRecherche],
    champs: [
      { nom: 'nom', libelle: 'Nom affiché', type: 'texte', requis: true, longueur: 80, plein: true },
      { nom: 'type', libelle: 'Type', type: 'choix', requis: true, options: Object.entries(TYPES_ZONE).map(([valeur, libelle]) => ({ valeur, libelle })) },
      { nom: 'code', libelle: 'Code technique', type: 'texte', longueur: 40, motif: /^[a-z0-9_]{2,40}$/,
        messageMotif: 'Minuscules, chiffres et « _ » (ex. gare_de_lyon).', aide: z ? 'Ne changez le code que si nécessaire.' : 'Laissez vide : créé à partir du nom.' },
      { nom: 'latitude', libelle: 'Latitude du centre', type: 'nombre', requis: true, min: -90, max: 90, pas: '0.000001' },
      { nom: 'longitude', libelle: 'Longitude du centre', type: 'nombre', requis: true, min: -180, max: 180, pas: '0.000001' },
      { nom: 'rayon_km', libelle: 'Rayon (km)', type: 'nombre', requis: true, min: 0.1, max: 50, pas: '0.1',
        aide: 'Aéroport : 2 à 3 km ; gare : 0,4 à 0,8 km ; ville : selon sa taille.' },
      { nom: 'active', libelle: 'Lieu actif (forfaits et raccourcis)', type: 'case' }
    ],
    valeurs: z || { type: 'gare', rayon_km: 0.6, active: true },
    preparer: (champs) => {
      new ChampAdresse({
        champ: recherche, zones: [],
        onChoix: (valeur) => {
          if (!valeur) return;
          champs.latitude.saisie.value = Math.round(valeur.lat * 1e6) / 1e6;
          champs.longitude.saisie.value = Math.round(valeur.lng * 1e6) / 1e6;
          if (!champs.nom.saisie.value) champs.nom.saisie.value = valeur.adresse;
        }
      });
    },
    enregistrer: async (v) => {
      const base = codeDepuisNom(v.nom);
      const ligne = { ...v, code: v.code || (base.startsWith(v.type) ? base : `${v.type}_${base}`).slice(0, 40), rayon_km: Math.round(v.rayon_km * 100) / 100,
        latitude: Math.round(v.latitude * 1e6) / 1e6, longitude: Math.round(v.longitude * 1e6) / 1e6 };
      if (!/^[a-z0-9_]{2,40}$/.test(ligne.code)) throw new Error('Saisissez un code technique (minuscules, chiffres et « _ »).');
      await enregistrerLigne('zones', ligne, z ? z.id : null);
    }
  });
  if (fait) { afficherMessage('Lieu enregistré.', 'succes'); await charger(); }
}

async function formulaireForfait(f) {
  if (etat.zones.length < 2) { afficherMessage('Ajoutez d\'abord au moins deux lieux.', 'erreur'); return; }
  const optionsZones = etat.zones.map((z) => ({ valeur: z.id, libelle: `${z.nom} (${TYPES_ZONE[z.type] || z.type})` }));
  const fait = await fenetreFormulaire({
    titre: f ? 'Modifier le forfait' : 'Ajouter un forfait',
    champs: [
      { nom: 'categorie_id', libelle: 'Catégorie', type: 'choix', requis: true, options: etat.categories.map((c) => ({ valeur: c.id, libelle: c.nom_fr })), plein: true },
      { nom: 'zone_a_id', libelle: 'Entre', type: 'choix', requis: true, options: optionsZones },
      { nom: 'zone_b_id', libelle: 'et', type: 'choix', requis: true, options: optionsZones },
      { nom: 'prix', libelle: 'Prix TTC (€)', type: 'nombre', requis: true, min: 0.01, pas: '0.01' },
      { nom: 'active', libelle: 'Forfait actif', type: 'case' }
    ],
    valeurs: f || { categorie_id: (etat.categories[0] || {}).id, active: true },
    enregistrer: async (v) => {
      if (v.zone_a_id === v.zone_b_id) throw new Error('Choisissez deux lieux différents.');
      await enregistrerLigne('forfaits', { ...v, prix: Math.round(v.prix * 100) / 100 }, f ? f.id : null);
    }
  });
  if (fait) { afficherMessage('Forfait enregistré.', 'succes'); await charger(); }
}

async function supprimerForfait(f) {
  const ok = await confirmer({ titre: 'Supprimer ce forfait ?', texte: `${nomZone(f.zone_a_id)} ↔ ${nomZone(f.zone_b_id)}, ${euros(f.prix)}.`, libelle: 'Supprimer', danger: true });
  if (!ok) return;
  if (await supprimerLigne('forfaits', f.id, 'Ce forfait a servi à des courses : désactivez-le plutôt (Modifier, puis décocher « Forfait actif »).')) {
    afficherMessage('Forfait supprimé.', 'succes');
    await charger();
  }
}

// #############################################################################
// Onglet « Majorations et fériés »
// #############################################################################
function afficherMajorations() {
  const ordre = ['nuit', 'dimanche', 'ferie'];
  const majorations = [...etat.majorations].sort((a, b) => ordre.indexOf(a.type) - ordre.indexOf(b.type));
  const annees = [...new Set(etat.feries.map((j) => j.jour.slice(0, 4)))];
  $('contenu').replaceChildren(
    el('section', { classe: 'carte-admin' },
      el('h2', { texte: 'Majorations' }),
      el('p', { classe: 'sous-titre', texte: 'Non cumulables : la plus forte s\'applique. Jamais sur un forfait.' }),
      tableau({
        colonnes: [
          { titre: 'Type', valeur: (m) => MAJORATIONS[m.type] || m.type },
          { titre: 'Majoration', droite: true, valeur: (m) => `+${nombre(m.pourcentage, 2)} %` },
          { titre: 'Horaires', valeur: (m) => (m.type === 'nuit' && m.heure_debut ? `de ${m.heure_debut.slice(0, 5)} à ${m.heure_fin.slice(0, 5)}` : m.type === 'dimanche' ? 'tout le dimanche' : 'toute la journée') },
          { titre: 'État', valeur: (m) => (m.active && Number(m.pourcentage) > 0 ? badge('Appliquée', 'vert') : badge('Non appliquée', 'gris')) },
          { titre: '', valeur: (m) => bouton('Modifier', () => modifierMajoration(m)) }
        ],
        lignes: majorations
      })),
    el('section', { classe: 'carte-admin' },
      el('div', { classe: 'carte-entete' }, el('h2', { texte: 'Jours fériés' }), bouton('Ajouter un jour férié', ajouterFerie, 'bouton-principal')),
      ...(annees.length ? annees.map((annee) => el('div', { classe: 'annee-feries' },
        el('h3', { classe: 'sous-section', texte: annee }),
        el('ul', { classe: 'liste-feries' }, ...etat.feries.filter((j) => j.jour.startsWith(annee)).map((j) => el('li', {},
          el('span', {}, el('strong', { texte: dateCourte(j.jour) }), ` ${j.libelle}`),
          bouton('Supprimer', () => supprimerFerie(j), 'bouton-danger'))))))
        : [el('p', { classe: 'vide-admin', texte: 'Aucun jour férié enregistré.' })])));
}

async function modifierMajoration(m) {
  const fait = await fenetreFormulaire({
    titre: `Majoration : ${MAJORATIONS[m.type] || m.type}`,
    champs: [
      { nom: 'pourcentage', libelle: 'Majoration (%)', type: 'nombre', requis: true, min: 0, max: 200, pas: '0.01' },
      ...(m.type === 'nuit' ? [
        { nom: 'heure_debut', libelle: 'De', type: 'heure', requis: true },
        { nom: 'heure_fin', libelle: 'À (le lendemain si plus tôt)', type: 'heure', requis: true }
      ] : []),
      { nom: 'active', libelle: 'Appliquer cette majoration', type: 'case' }
    ],
    valeurs: m,
    enregistrer: async (v) => enregistrerLigne('majorations', { ...v, pourcentage: Math.round(v.pourcentage * 100) / 100 }, m.type, 'type')
  });
  if (fait) { afficherMessage('Majoration enregistrée.', 'succes'); await charger(); }
}

async function ajouterFerie() {
  const fait = await fenetreFormulaire({
    titre: 'Ajouter un jour férié',
    champs: [
      { nom: 'jour', libelle: 'Date', type: 'date', requis: true },
      { nom: 'libelle', libelle: 'Nom', type: 'texte', requis: true, longueur: 60 }
    ],
    libelle: 'Ajouter',
    enregistrer: async (v) => enregistrerLigne('jours_feries', v, null)
  });
  if (fait) { afficherMessage('Jour férié ajouté.', 'succes'); await charger(); }
}

async function supprimerFerie(j) {
  const ok = await confirmer({ titre: 'Supprimer ce jour férié ?', texte: `${dateCourte(j.jour)} : ${j.libelle}.`, libelle: 'Supprimer', danger: true });
  if (!ok) return;
  if (await supprimerLigne('jours_feries', j.jour, null, 'jour')) { afficherMessage('Jour férié supprimé.', 'succes'); await charger(); }
}

// #############################################################################
// Onglet « Catégories »
// #############################################################################
function afficherCategories() {
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('div', { classe: 'carte-entete' }, el('h2', { texte: 'Catégories de véhicules' }), bouton('Ajouter une catégorie', () => formulaireCategorie(null), 'bouton-principal')),
    el('p', { classe: 'sous-titre', texte: 'Chaque catégorie a ses tarifs et ses véhicules. Une catégorie désactivée n\'est plus proposée aux clients.' }),
    tableau({
      colonnes: [
        { titre: 'Catégorie', valeur: (c) => el('span', {}, c.nom_fr, el('span', { classe: 'secondaire', texte: `${c.nom_en} · ${c.code}` })) },
        { titre: 'Places', droite: true, valeur: (c) => String(c.places) },
        { titre: 'Bagages', droite: true, valeur: (c) => String(c.bagages) },
        { titre: 'Ordre', droite: true, valeur: (c) => String(c.ordre) },
        { titre: 'État', valeur: (c) => (c.active ? badge('Proposée', 'vert') : badge('Désactivée', 'gris')) },
        { titre: '', valeur: (c) => bouton('Modifier', () => formulaireCategorie(c)) }
      ],
      lignes: etat.categories
    })));
}

async function formulaireCategorie(c) {
  const fait = await fenetreFormulaire({
    titre: c ? `Catégorie : ${c.nom_fr}` : 'Ajouter une catégorie', large: true,
    champs: [
      ...(c ? [] : [{ nom: 'code', libelle: 'Code technique', type: 'texte', requis: true, longueur: 40, motif: /^[a-z0-9_]{2,40}$/,
        messageMotif: 'Minuscules, chiffres et « _ » (ex. van_premium).', aide: 'Ne se change plus ensuite.' }]),
      { nom: 'nom_fr', libelle: 'Nom en français', type: 'texte', requis: true, longueur: 60 },
      { nom: 'nom_en', libelle: 'Nom en anglais', type: 'texte', requis: true, longueur: 60 },
      { nom: 'description_fr', libelle: 'Description en français', type: 'zone', longueur: 300 },
      { nom: 'description_en', libelle: 'Description en anglais', type: 'zone', longueur: 300 },
      { nom: 'places', libelle: 'Places passagers', type: 'nombre', requis: true, min: 1, max: 8, pas: '1' },
      { nom: 'bagages', libelle: 'Bagages', type: 'nombre', requis: true, min: 0, max: 10, pas: '1' },
      { nom: 'ordre', libelle: 'Ordre d\'affichage', type: 'nombre', requis: true, min: 0, max: 100, pas: '1' },
      { nom: 'active', libelle: 'Proposée aux clients', type: 'case' }
    ],
    valeurs: c || { places: 4, bagages: 2, ordre: etat.categories.length, active: false },
    enregistrer: async (v) => enregistrerLigne('categories', { ...v, places: Math.round(v.places), bagages: Math.round(v.bagages), ordre: Math.round(v.ordre) }, c ? c.id : null)
  });
  if (fait) {
    afficherMessage(c ? 'Catégorie enregistrée.' : 'Catégorie ajoutée : créez son tarif dans l\'onglet « Tarifs » avant de l\'activer.', 'succes');
    await charger();
  }
}

// #############################################################################
// Onglet « Réglages »
// #############################################################################
const REGLAGES = [
  { titre: 'Calcul des prix', champs: [
    { nom: 'coefficient_detour', libelle: 'Coefficient de détour', type: 'nombre', requis: true, min: 1, max: 2, pas: '0.01',
      aide: 'La distance à vol d\'oiseau est multipliée par ce nombre pour approcher la distance par la route.', format: (v) => `× ${nombre(v, 2)}` },
    { nom: 'vitesse_moyenne_kmh', libelle: 'Vitesse moyenne (km/h)', type: 'nombre', requis: true, min: 5, max: 130, pas: '0.1', format: (v) => `${nombre(v, 1)} km/h` },
    { nom: 'distance_max_km', libelle: 'Distance maximale commandable (km)', type: 'nombre', requis: true, min: 1, pas: '0.1', aide: 'Au-delà : sur devis.', format: (v) => `${nombre(v, 1)} km` }
  ] },
  { titre: 'Dispatch et réservations', champs: [
    { nom: 'delai_reponse_chauffeur_s', libelle: 'Délai de réponse d\'un chauffeur (secondes)', type: 'nombre', requis: true, min: 10, max: 300, pas: '1', format: (v) => `${v} s` },
    { nom: 'delai_min_planification_min', libelle: 'Réservation au plus tôt (minutes avant)', type: 'nombre', requis: true, min: 0, pas: '1', format: (v) => `${v} min` },
    { nom: 'recherche_planifiee_avant_min', libelle: 'Recherche automatique d\'une réservation (minutes avant)', type: 'nombre', requis: true, min: 5, pas: '1', format: (v) => `${v} min` }
  ] },
  { titre: 'Annulation et attente', champs: [
    { nom: 'annulation_gratuite_planifiee_min', libelle: 'Annulation gratuite d\'une réservation (minutes avant)', type: 'nombre', requis: true, min: 0, pas: '1',
      format: (v) => `jusqu'à ${v} min avant` },
    { nom: 'attente_gratuite_min', libelle: 'Attente gratuite (minutes)', type: 'nombre', requis: true, min: 0, pas: '1', format: (v) => `${v} min` }
  ] },
  { titre: 'Zone desservie (rectangle)', champs: [
    { nom: 'zone_lat_min', libelle: 'Latitude sud', type: 'nombre', requis: true, min: -90, max: 90, pas: '0.00001', format: (v) => nombre(v, 5) },
    { nom: 'zone_lat_max', libelle: 'Latitude nord', type: 'nombre', requis: true, min: -90, max: 90, pas: '0.00001', format: (v) => nombre(v, 5) },
    { nom: 'zone_lng_min', libelle: 'Longitude ouest', type: 'nombre', requis: true, min: -180, max: 180, pas: '0.00001', format: (v) => nombre(v, 5) },
    { nom: 'zone_lng_max', libelle: 'Longitude est', type: 'nombre', requis: true, min: -180, max: 180, pas: '0.00001', format: (v) => nombre(v, 5) }
  ] },
  { titre: 'Fiscalité et parrainage', champs: [
    { nom: 'taux_tva_transport', libelle: 'TVA du transport de personnes (%)', type: 'nombre', requis: true, min: 0, max: 30, pas: '0.01', format: (v) => `${nombre(v, 2)} %` },
    { nom: 'recompense_parrain', libelle: 'Récompense du parrain (€)', type: 'nombre', requis: true, min: 0, pas: '0.01', aide: '0 = parrainage désactivé.', format: (v) => euros(v) },
    { nom: 'recompense_filleul', libelle: 'Récompense du filleul (€)', type: 'nombre', requis: true, min: 0, pas: '0.01', format: (v) => euros(v) }
  ] }
];

function afficherReglages() {
  const p = etat.parametres;
  const zoneCarte = el('div', { classe: 'carte-admin-map', role: 'img', 'aria-label': 'Carte de la zone desservie' });
  $('contenu').replaceChildren(
    el('section', { classe: 'carte-admin' },
      el('div', { classe: 'carte-entete' }, el('h2', { texte: 'Réglages de la plateforme' }), bouton('Modifier les réglages', modifierReglages, 'bouton-principal')),
      el('div', { classe: 'grille-2' }, ...REGLAGES.map((groupe) => el('div', {},
        el('h3', { classe: 'sous-section', texte: groupe.titre }),
        el('dl', { classe: 'fiche-donnees' }, ...groupe.champs.flatMap((c) => [el('dt', { texte: c.libelle }), el('dd', { texte: c.format(p[c.nom]) })])))))),
    el('section', { classe: 'carte-admin' },
      el('h2', { texte: 'Zone desservie' }),
      el('p', { classe: 'sous-titre', texte: 'Départ et arrivée doivent être dans ce rectangle (Île-de-France et sud de l\'Oise) ; sinon, la course se fait sur devis.' }),
      zoneCarte));
  const carte = carteLeaflet(zoneCarte);
  if (!carte) return;
  const rectangle = window.L.rectangle([[p.zone_lat_min, p.zone_lng_min], [p.zone_lat_max, p.zone_lng_max]], { color: '#1B3A6B', weight: 2, fillOpacity: 0.08 }).addTo(carte);
  carte.fitBounds(rectangle.getBounds(), { padding: [10, 10] });
}

async function modifierReglages() {
  const champs = REGLAGES.flatMap((g) => g.champs.map(({ format, ...c }) => c));
  const fait = await fenetreFormulaire({
    titre: 'Réglages de la plateforme', large: true, champs, valeurs: etat.parametres,
    intro: 'Chaque changement est inscrit au journal des modifications.',
    enregistrer: async (v) => {
      if (v.zone_lat_min >= v.zone_lat_max || v.zone_lng_min >= v.zone_lng_max) throw new Error('Zone desservie : le sud doit être sous le nord, et l\'ouest à gauche de l\'est.');
      const entiers = ['delai_reponse_chauffeur_s', 'delai_min_planification_min', 'recherche_planifiee_avant_min', 'annulation_gratuite_planifiee_min', 'attente_gratuite_min'];
      const ligne = Object.fromEntries(Object.entries(v).map(([cle, valeur]) => [cle, entiers.includes(cle) ? Math.round(valeur) : valeur]));
      await enregistrerLigne('parametres', ligne, 1);
    }
  });
  if (fait) { afficherMessage('Réglages enregistrés.', 'succes'); await charger(); }
}
