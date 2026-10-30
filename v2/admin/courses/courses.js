// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : courses
// -----------------------------------------------------------------------------
// Deux vues dans la même page :
//   - la liste (sans paramètre) : onglets de statut, recherche libre, période,
//     pagination par 50, export CSV ; les filtres sont gardés dans l'adresse
//     de la page (retour arrière et rechargement les conservent) ;
//   - la fiche (?id=…) : tout sur une course, en une lecture
//     (admin_fiche_course), mise à jour en temps réel, avec les actions de
//     correction : attribuer, relancer, retirer le chauffeur, faire avancer
//     une étape (téléphone du chauffeur en panne), modifier, annuler,
//     confirmer un encaissement, rembourser.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, afficherMessage, apresPause } from '../../commun/outils.js';
import { ouvrirAdministration, lienAdmin } from '../commun/admin.js';
import {
  badgeCourse, badge, dateCourte, heure, jourHeure, dateHeureComplete, valeurParis, instantParis,
  MODES_PAIEMENT, TYPES_COURSE, tableau, exporterCsv, nombreCsv, boutonExporter, fenetreFormulaire,
  confirmer, messageErreurAdmin, jourParis, nomComplet, lienTelephone, telephoneLisible
} from '../commun/composants.js';
import { fenetreAttribution, relancerRecherche, retirerChauffeur, annulerCourse } from '../commun/actions-course.js';

const $ = (id) => document.getElementById(id);
const PAR_PAGE = 50;
const ONGLETS = [
  { code: 'toutes', libelle: 'Toutes', statuts: null },
  { code: 'actives', libelle: 'À venir et en cours', statuts: ['planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours'] },
  { code: 'a_attribuer', libelle: 'À attribuer', statuts: ['a_attribuer'] },
  { code: 'terminees', libelle: 'Terminées', statuts: ['terminee'] },
  { code: 'annulees', libelle: 'Annulées', statuts: ['annulee'] }
];
const filtres = { onglet: 'toutes', texte: '', du: '', au: '', page: 0 };
const etat = { rechercheAvantMin: 45, carte: null };

ouvrirAdministration({ module: 'courses' }).then(async () => {
  const { data } = await supabase.from('parametres').select('recherche_planifiee_avant_min').maybeSingle();
  if (data) etat.rechercheAvantMin = data.recherche_planifiee_avant_min;
  const id = new URLSearchParams(location.search).get('id');
  if (id) await ouvrirFiche(id); else ouvrirListe();
});

// Montant à retenir pour une course : payé (terminée), frais (annulée), annoncé (sinon)
function montant(c) {
  if (c.statut === 'terminee') return Number(c.prix_total) + Number(c.frais_attente || 0);
  if (c.statut === 'annulee') return Number(c.frais_annulation || 0);
  return Number(c.prix_total);
}

// #############################################################################
// LISTE
// #############################################################################
const COLONNES = [
  { titre: 'Course', valeur: (c) => el('span', {}, el('a', { href: lienAdmin(`courses/?id=${c.id}`), texte: c.numero }), el('span', { classe: 'secondaire' }, badgeCourse(c.statut))) },
  { titre: 'Prise en charge', valeur: (c) => el('span', {}, jourHeure(c.prise_en_charge_le), el('span', { classe: 'secondaire', texte: TYPES_COURSE[c.type] || c.type })) },
  { titre: 'Trajet', valeur: (c) => el('span', { classe: 'trajet-court' }, el('span', { texte: c.depart_adresse }), el('span', { classe: 'secondaire', texte: `→ ${c.arrivee_adresse}` })) },
  { titre: 'Client', valeur: (c) => el('span', {}, c.client_nom || c.client_email || '—',
    el('span', { classe: 'secondaire', texte: c.pour_proche ? `pour ${c.beneficiaire_nom}` : telephoneLisible(c.client_telephone) })) },
  { titre: 'Chauffeur', valeur: (c) => (c.chauffeur_nom ? el('span', {}, c.chauffeur_nom, el('span', { classe: 'secondaire', texte: c.vehicule_immatriculation || '' })) : '—') },
  { titre: 'Montant', droite: true, valeur: (c) => (c.statut === 'annulee' && !Number(c.frais_annulation) ? '—'
    : el('span', {}, euros(montant(c)), Number(c.pourboire) > 0 ? el('span', { classe: 'secondaire', texte: `+ ${euros(c.pourboire)} pourboire` }) : null)) },
  { titre: 'Paiement', valeur: (c) => MODES_PAIEMENT[c.mode_paiement] || c.mode_paiement }
];

const COLONNES_CSV = [
  { titre: 'Numéro', csv: (c) => c.numero },
  { titre: 'Statut', csv: (c) => c.statut },
  { titre: 'Type', csv: (c) => TYPES_COURSE[c.type] || c.type },
  { titre: 'Prise en charge (heure de Paris)', csv: (c) => `${dateCourte(c.prise_en_charge_le)} ${heure(c.prise_en_charge_le)}` },
  { titre: 'Départ', csv: (c) => c.depart_adresse },
  { titre: 'Arrivée', csv: (c) => c.arrivee_adresse },
  { titre: 'Distance (km)', csv: (c) => nombreCsv(c.distance_km) },
  { titre: 'Client', csv: (c) => c.client_nom },
  { titre: 'E-mail du client', csv: (c) => c.client_email },
  { titre: 'Téléphone du client', csv: (c) => c.client_telephone },
  { titre: 'Personne transportée', csv: (c) => (c.pour_proche ? c.beneficiaire_nom : '') },
  { titre: 'Chauffeur', csv: (c) => c.chauffeur_nom },
  { titre: 'Immatriculation', csv: (c) => c.vehicule_immatriculation },
  { titre: 'Prix annoncé TTC', csv: (c) => nombreCsv(c.prix_total) },
  { titre: 'Attente TTC', csv: (c) => nombreCsv(c.frais_attente) },
  { titre: 'Frais d\'annulation TTC', csv: (c) => nombreCsv(c.frais_annulation) },
  { titre: 'Remise', csv: (c) => nombreCsv(c.remise) },
  { titre: 'Pourboire', csv: (c) => nombreCsv(c.pourboire) },
  { titre: 'Mode de paiement', csv: (c) => MODES_PAIEMENT[c.mode_paiement] || c.mode_paiement },
  { titre: 'Annulée par', csv: (c) => c.annulee_par || '' },
  { titre: 'Commandée le', csv: (c) => `${dateCourte(c.cree_le)} ${heure(c.cree_le)}` }
];

function lireFiltresUrl() {
  const p = new URLSearchParams(location.search);
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
  filtres.onglet = ONGLETS.some((o) => o.code === p.get('statut')) ? p.get('statut') : 'toutes';
  filtres.texte = (p.get('q') || '').slice(0, 100);
  filtres.du = date(p.get('du'));
  filtres.au = date(p.get('au'));
  filtres.page = Math.max(0, parseInt(p.get('page') || '0', 10) || 0);
}

function ecrireFiltresUrl() {
  const p = new URLSearchParams();
  if (filtres.onglet !== 'toutes') p.set('statut', filtres.onglet);
  if (filtres.texte) p.set('q', filtres.texte);
  if (filtres.du) p.set('du', filtres.du);
  if (filtres.au) p.set('au', filtres.au);
  if (filtres.page) p.set('page', String(filtres.page));
  const requete = p.toString();
  history.replaceState(null, '', `${location.pathname}${requete ? `?${requete}` : ''}`);
}

function ouvrirListe() {
  $('vue-liste').hidden = false;
  lireFiltresUrl();
  $('filtre-texte').value = filtres.texte;
  $('filtre-du').value = filtres.du;
  $('filtre-au').value = filtres.au;
  $('entete-actions').replaceChildren(boutonExporter(exporter));
  $('filtres').addEventListener('submit', (e) => {
    e.preventDefault();
    filtres.texte = $('filtre-texte').value.trim();
    filtres.du = $('filtre-du').value;
    filtres.au = $('filtre-au').value;
    if (filtres.du && filtres.au && filtres.au < filtres.du) {
      afficherMessage('La date de fin est avant la date de début.', 'erreur');
      return;
    }
    filtres.page = 0;
    chargerListe();
  });
  $('effacer').addEventListener('click', () => {
    Object.assign(filtres, { onglet: 'toutes', texte: '', du: '', au: '', page: 0 });
    $('filtre-texte').value = ''; $('filtre-du').value = ''; $('filtre-au').value = '';
    chargerListe();
  });
  chargerListe();
}

function dessinerOnglets() {
  $('onglets').replaceChildren(...ONGLETS.map((o) => {
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(o.code === filtres.onglet), texte: o.libelle });
    b.addEventListener('click', () => { filtres.onglet = o.code; filtres.page = 0; chargerListe(); });
    return b;
  }));
}

function parametresRpc(limite, decalage) {
  const onglet = ONGLETS.find((o) => o.code === filtres.onglet);
  return {
    p_statuts: onglet.statuts, p_debut: filtres.du || null, p_fin: filtres.au || null,
    p_texte: filtres.texte || null, p_limite: limite, p_decalage: decalage
  };
}

async function chargerListe() {
  ecrireFiltresUrl();
  dessinerOnglets();
  $('resultats').classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_courses', parametresRpc(PAR_PAGE, filtres.page * PAR_PAGE));
  $('resultats').classList.remove('rechargement');
  if (error) { $('resultats').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  const total = data.total;
  $('nb-resultats').textContent = `${total} course${total > 1 ? 's' : ''}`;
  $('resultats').replaceChildren(tableau({
    colonnes: COLONNES, lignes: data.lignes, vide: 'Aucune course ne correspond à ces critères.',
    clicLigne: (c) => { location.href = lienAdmin(`courses/?id=${c.id}`); },
    libelleLigne: (c) => `Ouvrir la course ${c.numero}`
  }));
  const pages = Math.max(1, Math.ceil(total / PAR_PAGE));
  const precedent = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Précédent', disabled: filtres.page === 0 });
  const suivant = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Suivant', disabled: filtres.page >= pages - 1 });
  precedent.addEventListener('click', () => { filtres.page -= 1; chargerListe(); window.scrollTo(0, 0); });
  suivant.addEventListener('click', () => { filtres.page += 1; chargerListe(); window.scrollTo(0, 0); });
  $('pagination').replaceChildren(...(total > PAR_PAGE
    ? [precedent, el('span', { texte: `Page ${filtres.page + 1} sur ${pages}` }), suivant] : []));
}

async function exporter() {
  const { data, error } = await supabase.rpc('admin_lister_courses', parametresRpc(5000, 0));
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  if (data.total > 5000) afficherMessage('Plus de 5 000 courses : seules les 5 000 plus récentes sont exportées. Réduisez la période.');
  exporterCsv(`courses-loc-reaction-${jourParis()}.csv`, COLONNES_CSV, data.lignes);
}

// #############################################################################
// FICHE D'UNE COURSE
// #############################################################################
const ETAPES = {
  commande: 'Commande du client',
  proposee: 'Demande envoyée à un chauffeur',
  demande_expiree: 'Demande sans réponse dans le délai',
  refusee: 'Demande refusée par le chauffeur',
  acceptee: 'Acceptée par le chauffeur',
  aucun_chauffeur_disponible: 'Aucun chauffeur disponible : à attribuer',
  recherche_automatique: 'Recherche automatique lancée (réservation)',
  prise_par_chauffeur: 'Réservation prise par un chauffeur',
  attribution_manuelle: 'Attribuée à la main',
  en_route: 'Chauffeur en route',
  arrivee: 'Chauffeur arrivé',
  a_bord: 'Client à bord',
  terminee: 'Course terminée',
  annulee: 'Course annulée',
  desistement_chauffeur: 'Désistement du chauffeur',
  chauffeur_retire: 'Chauffeur retiré par l\'administration',
  paiement_encaisse: 'Paiement encaissé',
  pourboire: 'Pourboire laissé par le client'
};
const ROLES = { admin: 'administration', chauffeur: 'chauffeur', client: 'client' };
// Étapes produites par la recherche automatique (même déclenchées par l'action d'une personne)
const AUTOMATIQUES = ['proposee', 'aucun_chauffeur_disponible', 'demande_expiree', 'recherche_automatique'];
const ANNULEE_PAR = { client: 'le client', chauffeur: 'le chauffeur', admin: 'l\'administration', systeme: 'le système' };
const ATTRIBUTION = { automatique: 'Recherche automatique', manuelle: 'À la main', prise_directe: 'Prise par le chauffeur (réservations libres)' };
const STATUTS_PAIEMENT = {
  a_encaisser: { libelle: 'À encaisser', ton: 'or' }, encaisse: { libelle: 'Encaissé', ton: 'vert' },
  echoue: { libelle: 'Échoué', ton: 'rouge' }, rembourse: { libelle: 'Remboursé', ton: 'gris' }, annule: { libelle: 'Annulé', ton: 'gris' }
};
const NATURES = { course: 'Course', pourboire: 'Pourboire', frais_annulation: 'Frais d\'annulation' };
const PROPOSITIONS = {
  envoyee: { libelle: 'En attente', ton: 'or' }, acceptee: { libelle: 'Acceptée', ton: 'vert' },
  refusee: { libelle: 'Refusée', ton: 'rouge' }, expiree: { libelle: 'Sans réponse', ton: 'gris' }, annulee: { libelle: 'Retirée', ton: 'gris' }
};

async function ouvrirFiche(id) {
  $('vue-fiche').hidden = false;
  $('entete-actions').replaceChildren(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin('courses/'), texte: 'Toutes les courses' }));
  if (!/^[0-9a-f-]{36}$/i.test(id)) { introuvable(); return; }
  const ok = await chargerFiche(id);
  if (!ok) return;
  const recharger = apresPause(() => chargerFiche(id), 600);
  supabase.channel(`admin-course-${id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'courses', filter: `id=eq.${id}` }, recharger)
    .subscribe();
}

function introuvable() {
  $('vue-fiche').replaceChildren(el('section', { classe: 'carte-admin' },
    el('p', { texte: 'Course introuvable.' }),
    el('a', { href: lienAdmin('courses/'), texte: 'Retour à la liste des courses' })));
}

async function chargerFiche(id) {
  const { data, error } = await supabase.rpc('admin_fiche_course', { p_course: id });
  if (error) {
    if (/introuvable/i.test(error.message || '')) introuvable();
    else afficherMessage(messageErreurAdmin(error), 'erreur');
    return false;
  }
  afficherFiche(data);
  return true;
}

function ligne(libelle, valeur) {
  if (valeur === null || valeur === undefined || valeur === '' || valeur === false) return [];
  return [el('dt', { texte: libelle }), el('dd', {}, valeur)];
}

function afficherFiche(f) {
  const c = f.course;
  document.title = `Course ${c.numero}, administration LOC RÉACTION`;
  $('titre-page').textContent = `Course ${c.numero}`;
  const recharger = () => chargerFiche(c.id);

  // En-tête : statut, moment, actions
  const annulation = c.statut === 'annulee'
    ? el('p', { classe: 'alerte' }, `Annulée le ${dateHeureComplete(c.annulee_le)} par ${ANNULEE_PAR[c.annulee_par] || c.annulee_par || '—'}`
      + `${c.motif_annulation ? ` : « ${c.motif_annulation} »` : ''}`
      + `${Number(c.frais_annulation) > 0 ? ` · frais d'annulation ${euros(c.frais_annulation)}` : ' · sans frais'}.`)
    : null;
  const entete = el('section', { classe: 'carte-admin' },
    el('div', { classe: 'carte-entete' },
      badgeCourse(c.statut),
      el('span', { classe: 'sous-titre', texte: `${TYPES_COURSE[c.type] || c.type} · commandée le ${dateHeureComplete(c.cree_le)}` })),
    el('p', { classe: 'fiche-moment', texte: `Prise en charge le ${dateHeureComplete(c.prise_en_charge_le)}` }),
    annulation,
    actionsFiche(f, recharger));

  // Trajet
  const trajet = el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-trajet' },
    el('h2', { id: 'titre-trajet', texte: 'Trajet' }),
    el('ol', { classe: 'trajet-admin' },
      el('li', { texte: c.depart_adresse + (c.depart_precision ? ` (${c.depart_precision})` : '') }),
      ...f.arrets.map((a) => el('li', { classe: 'arret', texte: `Arrêt ${a.ordre} : ${a.adresse}` })),
      el('li', { texte: c.arrivee_adresse })),
    el('dl', { classe: 'fiche-donnees' },
      ...ligne('Distance estimée', `${nombre(c.distance_km, 1)} km, environ ${c.duree_min} min`),
      ...ligne('Mise à disposition', c.duree_mad_heures ? `${nombre(c.duree_mad_heures, 1)} h` : null),
      ...ligne('Vol', c.numero_vol ? `${c.numero_vol}${c.terminal ? `, ${c.terminal}` : ''}` : null),
      ...ligne('Terminal', !c.numero_vol && c.terminal ? c.terminal : null),
      ...ligne('Option', c.option_chauffeuse ? 'Chauffeuse demandée' : null)),
    el('div', { classe: 'carte-admin-map carte-fiche', id: 'carte-fiche', role: 'img', 'aria-label': 'Carte du trajet' }));

  // Personnes
  const client = f.client || {};
  const personnes = el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-personnes' },
    el('h2', { id: 'titre-personnes', texte: 'Client et chauffeur' }),
    el('dl', { classe: 'fiche-donnees' },
      ...ligne('Client', el('span', {},
        client.id ? el('a', { href: lienAdmin(`clients/?id=${client.id}`), texte: nomComplet(client.prenom, client.nom) }) : nomComplet(client.prenom, client.nom),
        client.statut === 'bloque' ? ' ' : null,
        client.statut === 'bloque' ? badge('Compte bloqué', 'rouge') : null)),
      ...ligne('E-mail', client.email ? el('a', { href: `mailto:${client.email}`, texte: client.email }) : null),
      ...ligne('Téléphone', lienTelephone(client.telephone)),
      ...ligne('Personne transportée', c.pour_proche ? el('span', {}, `${c.beneficiaire_nom} `, lienTelephone(c.beneficiaire_telephone)) : null),
      ...ligne('Compte professionnel', f.compte_pro && c.compte_pro_id
        ? el('a', { href: lienAdmin(`clients/?entreprise=${c.compte_pro_id}`), texte: f.compte_pro }) : f.compte_pro),
      ...ligne('Chauffeur', f.chauffeur ? nomComplet(f.chauffeur.prenom, f.chauffeur.nom) : 'Aucun pour le moment'),
      ...ligne('Téléphone du chauffeur', f.chauffeur ? lienTelephone(f.chauffeur.telephone) : null),
      ...ligne('Véhicule', c.vehicule_libelle ? `${c.vehicule_libelle}${c.vehicule_couleur ? `, ${c.vehicule_couleur}` : ''} · ${c.vehicule_immatriculation}` : null),
      ...ligne('Attribution', c.attribution ? `${ATTRIBUTION[c.attribution] || c.attribution}${f.attribuee_par ? ` par ${f.attribuee_par}` : ''}` : null)));

  // Prix
  const totalPaye = c.statut === 'terminee' ? Number(c.prix_total) + Number(c.frais_attente) : null;
  const prix = el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-prix' },
    el('h2', { id: 'titre-prix', texte: 'Prix' }),
    el('dl', { classe: 'fiche-donnees' },
      ...ligne('Catégorie', f.categorie),
      ...ligne('Base', `${euros(c.prix_base)} · ${f.forfait ? `forfait ${f.forfait.zone_a} ↔ ${f.forfait.zone_b}`
        : f.tarif ? `tarif du ${dateCourte(f.tarif.valide_du)} (${euros(f.tarif.prise_en_charge)} + ${euros(f.tarif.prix_km)}/km + ${euros(f.tarif.prix_minute)}/min, minimum ${euros(f.tarif.minimum)})` : 'tarif'}`),
      ...ligne('Majoration', c.majoration_type ? `${{ nuit: 'Nuit', dimanche: 'Dimanche', ferie: 'Jour férié' }[c.majoration_type] || c.majoration_type} +${nombre(c.majoration_pourcentage, 2)} %` : null),
      ...ligne('Option chauffeuse', Number(c.supplement) > 0 ? euros(c.supplement) : null),
      ...ligne('Remise', Number(c.remise) > 0 ? `− ${euros(c.remise)}${f.code_promo ? ` (code ${f.code_promo})` : ''}` : null),
      ...ligne('Prix annoncé', el('strong', { texte: euros(c.prix_total) })),
      ...ligne('Attente facturée', Number(c.attente_min) > 0 ? `${c.attente_min} min · ${euros(c.frais_attente)}` : null),
      ...ligne('Total de la course', totalPaye !== null ? el('strong', { texte: euros(totalPaye) }) : null),
      ...ligne('Frais d\'annulation', Number(c.frais_annulation) > 0 ? euros(c.frais_annulation) : null),
      ...ligne('Pourboire', Number(c.pourboire) > 0 ? euros(c.pourboire) : null),
      ...ligne('Paiement', MODES_PAIEMENT[c.mode_paiement] || c.mode_paiement)));

  // Paiements et factures
  const paiements = el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-paiements' },
    el('h2', { id: 'titre-paiements', texte: 'Paiements' }),
    tableau({
      colonnes: [
        { titre: 'Nature', valeur: (p) => NATURES[p.nature] || p.nature },
        { titre: 'Montant', droite: true, valeur: (p) => el('span', {}, euros(p.montant), Number(p.rembourse) > 0 ? el('span', { classe: 'secondaire', texte: `dont ${euros(p.rembourse)} remboursé` }) : null) },
        { titre: 'Mode', valeur: (p) => MODES_PAIEMENT[p.mode] || p.mode },
        { titre: 'Statut', valeur: (p) => { const s = STATUTS_PAIEMENT[p.statut] || { libelle: p.statut, ton: 'gris' }; return badge(s.libelle, s.ton); } },
        { titre: 'Encaissé', valeur: (p) => (p.encaisse_le ? `${jourHeure(p.encaisse_le)}${p.encaisse_par ? ` par ${p.encaisse_par}` : ''}` : '—') },
        { titre: '', valeur: (p) => actionsPaiement(p, recharger) }
      ],
      lignes: f.paiements, vide: c.statut === 'terminee' ? 'Aucun paiement (course gratuite).' : 'Le paiement est créé à la fin de la course.'
    }),
    f.remboursements.length ? el('div', {}, el('h3', { classe: 'sous-section', texte: 'Remboursements' }),
      el('ul', { classe: 'liste-simple' }, ...f.remboursements.map((r) => el('li', {},
        el('strong', { texte: euros(r.montant) }), ` le ${dateHeureComplete(r.cree_le)}${r.cree_par ? ` par ${r.cree_par}` : ''} : ${r.motif}`)))) : null,
    el('h3', { classe: 'sous-section', texte: 'Factures' }),
    tableau({
      colonnes: [
        { titre: 'Numéro', valeur: (x) => x.numero },
        { titre: 'Nature', valeur: (x) => (x.nature === 'course' ? 'Course' : 'Frais d\'annulation') },
        { titre: 'Date', valeur: (x) => dateCourte(x.date_emission) },
        { titre: 'HT', droite: true, valeur: (x) => euros(x.montant_ht) },
        { titre: `TVA`, droite: true, valeur: (x) => `${euros(x.montant_tva)} (${nombre(x.taux_tva, 2)} %)` },
        { titre: 'TTC', droite: true, valeur: (x) => euros(x.montant_ttc) },
        { titre: 'Statut', valeur: (x) => (x.statut === 'emise' ? badge('Émise', 'vert') : badge('Annulée', 'gris')) }
      ],
      lignes: f.factures, vide: 'Aucune facture : elle est émise automatiquement à la fin de la course (ou pour des frais d\'annulation).'
    }));

  // Étapes horodatées
  const etapes = el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-etapes' },
    el('h2', { id: 'titre-etapes', texte: 'Étapes' }),
    f.evenements.length
      ? el('ol', { classe: 'chronologie' }, ...f.evenements.map((e) => el('li', {},
        el('time', { datetime: e.cree_le, texte: `${dateCourte(e.cree_le)} ${heure(e.cree_le)}` }),
        el('div', {},
          el('strong', { texte: ETAPES[e.type] || e.type }),
          detailEtape(e) ? el('span', { texte: ` · ${detailEtape(e)}` }) : null,
          el('span', { classe: 'qui', texte: e.acteur_nom && !AUTOMATIQUES.includes(e.type)
            ? ` — ${e.acteur_nom} (${ROLES[e.acteur_role] || e.acteur_role || 'compte'})` : ' — automatique' })))))
      : el('p', { classe: 'vide-admin', texte: 'Aucune étape enregistrée.' }));

  // Demandes envoyées aux chauffeurs
  const demandes = el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-demandes' },
    el('h2', { id: 'titre-demandes', texte: 'Demandes aux chauffeurs' }),
    tableau({
      colonnes: [
        { titre: 'Chauffeur', valeur: (p) => p.chauffeur_nom || '—' },
        { titre: 'Réponse', valeur: (p) => { const s = PROPOSITIONS[p.statut] || { libelle: p.statut, ton: 'gris' }; return badge(s.libelle, s.ton); } },
        { titre: 'Distance', droite: true, valeur: (p) => (p.distance_km !== null ? `${nombre(p.distance_km, 1)} km` : '—') },
        { titre: 'Envoyée', valeur: (p) => heure(p.envoyee_le) },
        { titre: 'Réponse à', valeur: (p) => (p.repondue_le ? heure(p.repondue_le) : '—') }
      ],
      lignes: f.propositions, vide: 'Aucune demande envoyée (réservation prise directement ou attribuée à la main).'
    }));

  // Notes
  const notes = el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-notes' },
    el('h2', { id: 'titre-notes', texte: 'Notes' }),
    f.evaluations.length
      ? el('ul', { classe: 'liste-simple' }, ...f.evaluations.map((e) => el('li', {},
        el('strong', { texte: e.sens === 'client_vers_chauffeur' ? 'Le client au chauffeur : ' : 'Le chauffeur au client (visible de l\'administration seulement) : ' }),
        el('span', { classe: 'etoiles', 'aria-label': `${e.note} sur 5`, texte: '★'.repeat(e.note) + '☆'.repeat(5 - e.note) }),
        e.commentaire ? el('span', { texte: ` « ${e.commentaire} »` }) : null)))
      : el('p', { classe: 'vide-admin', texte: c.statut === 'terminee' ? 'Pas encore de note.' : 'Les notes sont données à la fin de la course.' }));

  $('vue-fiche').replaceChildren(entete, el('div', { classe: 'grille-2' }, trajet, el('div', { classe: 'pile' }, personnes, prix)),
    paiements, el('div', { classe: 'grille-2' }, etapes, el('div', { classe: 'pile' }, demandes, notes)));
  dessinerCarte(c, f.arrets);
}

function detailEtape(e) {
  const d = e.details || {};
  if (e.type === 'proposee' && d.distance_km !== undefined) return `chauffeur à ${nombre(d.distance_km, 1)} km`;
  if (e.type === 'annulee') return `par ${ANNULEE_PAR[d.par] || d.par || '—'}${Number(d.frais) > 0 ? `, frais ${euros(d.frais)}` : ''}`;
  if ((e.type === 'desistement_chauffeur' || e.type === 'chauffeur_retire') && d.motif) return `motif : ${d.motif}`;
  if (e.type === 'paiement_encaisse') return `${euros(d.montant)} · ${MODES_PAIEMENT[d.mode] || d.mode || ''}`;
  if (e.type === 'pourboire') return euros(d.montant);
  if (e.type === 'commande' && d.prix_total !== undefined) return `prix annoncé ${euros(d.prix_total)}`;
  return '';
}

// ---------------------------------------------------------------------------
// Actions de la fiche
// ---------------------------------------------------------------------------
function boutonAction(texte, action, classe = 'bouton-secondaire') {
  const b = el('button', { type: 'button', classe: `bouton ${classe} bouton-petit`, texte });
  b.addEventListener('click', async () => { b.disabled = true; try { await action(); } finally { b.disabled = false; } });
  return b;
}

function actionsFiche(f, recharger) {
  const c = f.course;
  const pour = { ...c, chauffeur_nom: f.chauffeur ? nomComplet(f.chauffeur.prenom, f.chauffeur.nom) : null };
  const liste = [];
  if (['planifiee', 'recherche', 'a_attribuer'].includes(c.statut)) {
    liste.push(boutonAction(c.chauffeur_id ? 'Changer de chauffeur' : 'Attribuer', () => fenetreAttribution(pour, recharger), 'bouton-principal'));
  }
  if (c.statut === 'a_attribuer') liste.push(boutonAction('Relancer la recherche', () => relancerRecherche(pour, recharger)));
  if (c.chauffeur_id && ['planifiee', 'acceptee', 'arrivee'].includes(c.statut)) {
    liste.push(boutonAction('Retirer le chauffeur', () => retirerChauffeur(pour, recharger, etat.rechercheAvantMin)));
  }
  // Étape suivante à la place du chauffeur (téléphone en panne, oubli)
  const suivante = c.chauffeur_id && {
    planifiee: { etape: 'en_route', libelle: 'Chauffeur en route' },
    acceptee: { etape: 'arrivee', libelle: 'Chauffeur arrivé' },
    arrivee: { etape: 'a_bord', libelle: 'Client à bord' },
    en_cours: { etape: 'terminee', libelle: 'Terminer la course' }
  }[c.statut];
  if (suivante) liste.push(boutonAction(suivante.libelle, () => avancer(c, suivante, recharger)));
  if (!['terminee', 'annulee', 'en_cours'].includes(c.statut)) liste.push(boutonAction('Modifier', () => modifier(c, recharger)));
  if (!['terminee', 'annulee', 'en_cours'].includes(c.statut)) liste.push(boutonAction('Annuler la course', () => annulerCourse(pour, recharger), 'bouton-danger'));
  return liste.length ? el('div', { classe: 'actions-ligne' }, ...liste) : null;
}

async function avancer(c, suivante, recharger) {
  const reponse = await confirmer({
    titre: `${suivante.libelle} ?`,
    texte: suivante.etape === 'terminee'
      ? 'À utiliser si le chauffeur n\'a pas pu terminer depuis son téléphone. Le paiement à encaisser et la facture sont créés, et le client est prévenu. Cette étape est enregistrée à votre nom.'
      : 'À utiliser si le chauffeur n\'a pas pu le faire depuis son téléphone. Le client est prévenu, et cette étape est enregistrée à votre nom.',
    libelle: suivante.libelle
  });
  if (!reponse) return;
  const { error } = await supabase.rpc('avancer_course', { p_course: c.id, p_etape: suivante.etape });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(`${c.numero} : étape enregistrée.`, 'succes');
  await recharger();
}

async function modifier(c, recharger) {
  const reservation = c.statut === 'planifiee' && c.type !== 'immediate';
  const champs = [
    ...(reservation ? [{ nom: 'prise_en_charge', libelle: 'Prise en charge (heure de Paris)', type: 'dateheure', requis: true, plein: true }] : []),
    { nom: 'depart_precision', libelle: 'Précision du départ (terminal, porte, sortie)', type: 'texte', longueur: 200, plein: true },
    { nom: 'numero_vol', libelle: 'Numéro de vol', type: 'texte', majuscules: true, longueur: 8,
      motif: /^[A-Z0-9]{2,3}[0-9]{1,4}[A-Z]?$/, messageMotif: 'Format : AF1234, EZY4521…' },
    { nom: 'terminal', libelle: 'Terminal', type: 'texte', longueur: 40 },
    { nom: 'mode_paiement', libelle: 'Mode de paiement', type: 'choix', requis: true,
      options: [{ valeur: 'especes', libelle: 'Espèces' }, { valeur: 'carte', libelle: 'Carte au terminal' },
        ...(c.mode_paiement === 'facture_mensuelle' ? [{ valeur: 'facture_mensuelle', libelle: 'Facture mensuelle' }] : [])] },
    { nom: 'prix_total', libelle: 'Prix annoncé TTC (€)', type: 'nombre', requis: true, min: 0, pas: '0.01', plein: true,
      aide: 'À changer seulement en accord avec le client : la modification est inscrite au journal.' }
  ];
  const valeurs = {
    prise_en_charge: valeurParis(c.prise_en_charge_le), depart_precision: c.depart_precision, numero_vol: c.numero_vol,
    terminal: c.terminal, mode_paiement: c.mode_paiement, prix_total: Number(c.prix_total)
  };
  const fait = await fenetreFormulaire({
    titre: `Modifier ${c.numero}`, champs, valeurs,
    enregistrer: async (v) => {
      const modifs = {};
      if (reservation) {
        const instant = instantParis(v.prise_en_charge);
        if (instant.getTime() < Date.now() + 5 * 60000) throw new Error('La nouvelle heure de prise en charge doit être dans le futur.');
        if (instant.getTime() !== new Date(c.prise_en_charge_le).getTime()) modifs.prise_en_charge_le = instant.toISOString();
      }
      for (const cle of ['depart_precision', 'numero_vol', 'terminal', 'mode_paiement']) {
        if ((v[cle] || null) !== (c[cle] || null)) modifs[cle] = v[cle] || null;
      }
      if (Math.round(v.prix_total * 100) !== Math.round(Number(c.prix_total) * 100)) modifs.prix_total = Math.round(v.prix_total * 100) / 100;
      if (!Object.keys(modifs).length) return 'rien';
      const { error } = await supabase.from('courses').update(modifs).eq('id', c.id);
      if (error) throw error;
      return 'modifiee';
    }
  });
  if (fait === 'modifiee') { afficherMessage(`${c.numero} modifiée.`, 'succes'); await recharger(); }
}

function actionsPaiement(p, recharger) {
  const actions = [];
  if (p.statut === 'a_encaisser') {
    actions.push(boutonAction('Confirmer l\'encaissement', async () => {
      const ok = await confirmer({
        titre: `Confirmer l'encaissement de ${euros(p.montant)} ?`,
        texte: `${MODES_PAIEMENT[p.mode] || p.mode} : confirmez seulement si l'argent a bien été reçu.`, libelle: 'Confirmer'
      });
      if (!ok) return;
      const { error } = await supabase.rpc('confirmer_encaissement', { p_paiement: p.id });
      if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
      afficherMessage('Encaissement confirmé.', 'succes');
      await recharger();
    }));
  }
  const reste = Math.round((Number(p.montant) - Number(p.rembourse)) * 100) / 100;
  if (['encaisse', 'rembourse'].includes(p.statut) && reste > 0) {
    actions.push(boutonAction('Rembourser', async () => {
      const fait = await fenetreFormulaire({
        titre: 'Rembourser le client',
        intro: `Paiement de ${euros(p.montant)} (${NATURES[p.nature] || p.nature}) : au plus ${euros(reste)} à rembourser.`,
        champs: [
          { nom: 'montant', libelle: 'Montant à rembourser (€)', type: 'nombre', requis: true, min: 0.01, max: reste, pas: '0.01', plein: true },
          { nom: 'motif', libelle: 'Motif, transmis au client', type: 'zone', requis: true, longueur: 500, plein: true }
        ],
        valeurs: { montant: reste },
        libelle: 'Rembourser',
        enregistrer: async (v) => {
          const { error } = await supabase.rpc('rembourser', { p_paiement: p.id, p_montant: v.montant, p_motif: v.motif });
          if (error) throw error;
        }
      });
      if (fait) { afficherMessage('Remboursement enregistré. Le client est prévenu.', 'succes'); await recharger(); }
    }));
  }
  return actions.length ? el('div', { classe: 'actions-ligne' }, ...actions) : '';
}

// ---------------------------------------------------------------------------
// Carte du trajet
// ---------------------------------------------------------------------------
function dessinerCarte(c, arrets) {
  const zone = $('carte-fiche');
  if (!zone || !window.L) { if (zone) zone.hidden = true; return; }
  if (etat.carte) { etat.carte.remove(); etat.carte = null; }
  etat.carte = window.L.map(zone, { scrollWheelZoom: false });
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(etat.carte);
  const points = [[c.depart_lat, c.depart_lng], ...arrets.map((a) => [a.latitude, a.longitude]), [c.arrivee_lat, c.arrivee_lng]];
  const repere = (classe) => window.L.divIcon({ className: '', html: `<div class="${classe}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  window.L.marker(points[0], { icon: repere('repere-depart'), title: 'Départ' }).addTo(etat.carte);
  arrets.forEach((a) => window.L.marker([a.latitude, a.longitude], { icon: repere('repere-arret'), title: `Arrêt ${a.ordre}` }).addTo(etat.carte));
  window.L.marker(points[points.length - 1], { icon: repere('repere-arrivee'), title: 'Arrivée' }).addTo(etat.carte);
  window.L.polyline(points, { color: '#1B3A6B', weight: 2, dashArray: '6 6' }).addTo(etat.carte);
  etat.carte.fitBounds(points, { padding: [30, 30], maxZoom: 14 });
}
