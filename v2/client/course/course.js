// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client : suivi d'une course
// -----------------------------------------------------------------------------
// - La course et la position du chauffeur arrivent en temps réel (Supabase
//   Realtime). Une relecture toutes les 15 secondes prend le relais si la
//   connexion temps réel se coupe (tunnel, changement de réseau).
// - Les règles d'accès de la base ne laissent voir la position du chauffeur
//   qu'entre l'acceptation et la fin de la course.
// - L'annulation annonce les frais avant de confirmer, selon les mêmes règles
//   que la base (qui reste seule juge du montant).
// =============================================================================
import { supabase, profilConnecte, messageErreur } from '../../commun/supabase.js';
import { RACINE } from '../../commun/config.js';
import { t, appliquerTraductions, langueActive, adopterLangueProfil, lienAvecLangue } from '../../commun/i18n.js';
import { euros, nombre, el, afficherMessage, dateHeure, distanceKm } from '../../commun/outils.js';
import '../../commun/pwa.js';

const $ = (id) => document.getElementById(id);
const idCourse = new URLSearchParams(location.search).get('id');
const STATUTS_ACTIFS = ['acceptee', 'arrivee', 'en_cours'];
const etat = {
  course: null, arrets: [], position: null, tarif: null, factures: [], noteDonnee: null,
  parametres: { coefficient_detour: 1.3, vitesse_moyenne_kmh: 27.3, annulation_gratuite_planifiee_min: 120 },
  carte: null, reperes: {}, canalCourse: null, canalPosition: null, minuteur: null, noteChoisie: 0
};

appliquerTraductions();
demarrer().catch((erreur) => afficherMessage(messageErreur(erreur, langueActive()), 'erreur'));

async function demarrer() {
  const { data: { session } } = await supabase.auth.getSession();
  const profil = session ? await profilConnecte() : null;
  if (!profil) {
    const suite = location.pathname.slice(RACINE.length) + location.search;
    location.replace(lienAvecLangue(`${RACINE}connexion/?suite=${encodeURIComponent(suite)}`));
    return;
  }
  adopterLangueProfil(profil.langue);
  if (!/^[0-9a-f-]{36}$/i.test(idCourse || '')) { $('introuvable').hidden = false; return; }

  const { data: parametres } = await supabase.from('parametres')
    .select('coefficient_detour, vitesse_moyenne_kmh, annulation_gratuite_planifiee_min').maybeSingle();
  if (parametres) etat.parametres = parametres;

  await chargerCourse();
  if (!etat.course) { $('introuvable').hidden = false; return; }
  const [arrets, tarif] = await Promise.all([
    supabase.from('course_arrets').select('ordre, adresse, latitude, longitude').eq('course_id', idCourse).order('ordre'),
    etat.course.tarif_id ? supabase.from('tarifs').select('frais_annulation').eq('id', etat.course.tarif_id).maybeSingle() : { data: null }
  ]);
  etat.arrets = arrets.data || [];
  etat.tarif = tarif.data;
  await chargerAnnexes();

  $('suivi').hidden = false;
  initialiserCarte();
  preparerNote();
  preparerAnnulation();
  afficher();
  await suivrePosition();
  // Course déjà finie : rien à suivre en temps réel
  if (!['terminee', 'annulee'].includes(etat.course.statut)) abonner();
}

async function chargerCourse() {
  const { data, error } = await supabase.from('courses').select('*').eq('id', idCourse).maybeSingle();
  if (error) throw error;
  etat.course = data;
}

// Factures et note déjà donnée (fin de course ou frais d'annulation)
async function chargerAnnexes() {
  if (!['terminee', 'annulee'].includes(etat.course.statut)) return;
  const [factures, note] = await Promise.all([
    supabase.from('factures').select('numero, nature, montant_ht, taux_tva, montant_tva, montant_ttc').eq('course_id', idCourse).order('numero'),
    supabase.from('evaluations').select('note').eq('course_id', idCourse).eq('sens', 'client_vers_chauffeur').maybeSingle()
  ]);
  etat.factures = factures.data || [];
  etat.noteDonnee = note.data ? note.data.note : null;
}

// ---------------------------------------------------------------------------
// Temps réel et relecture de secours
// ---------------------------------------------------------------------------
function abonner() {
  etat.canalCourse = supabase.channel(`course-${idCourse}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'courses', filter: `id=eq.${idCourse}` },
      (charge) => miseAJour({ ...etat.course, ...charge.new }))
    .subscribe();
  etat.minuteur = setInterval(async () => {
    const avant = etat.course;
    try { await chargerCourse(); } catch { return; }
    if (etat.course) miseAJour(etat.course, avant);
  }, 15000);
}

async function miseAJour(course, avant = etat.course) {
  const chauffeurChange = course.chauffeur_id !== avant?.chauffeur_id;
  const statutChange = course.statut !== avant?.statut;
  etat.course = course;
  if (statutChange) await chargerAnnexes();
  if (chauffeurChange || (statutChange && STATUTS_ACTIFS.includes(course.statut))) await suivrePosition();
  afficher();
  // Course finie : plus besoin de suivre
  if (['terminee', 'annulee'].includes(course.statut)) arreterSuivi();
}

function arreterSuivi() {
  clearInterval(etat.minuteur);
  if (etat.canalCourse) supabase.removeChannel(etat.canalCourse);
  if (etat.canalPosition) supabase.removeChannel(etat.canalPosition);
  etat.canalCourse = null;
  etat.canalPosition = null;
}

async function suivrePosition() {
  if (etat.canalPosition) { supabase.removeChannel(etat.canalPosition); etat.canalPosition = null; }
  etat.position = null;
  const chauffeur = etat.course.chauffeur_id;
  if (!chauffeur || !STATUTS_ACTIFS.includes(etat.course.statut)) { majCarte(); return; }
  const { data } = await supabase.from('positions').select('latitude, longitude, maj_le').eq('chauffeur_id', chauffeur).maybeSingle();
  etat.position = data && data.latitude !== null ? data : null;
  etat.canalPosition = supabase.channel(`position-${chauffeur}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'positions', filter: `chauffeur_id=eq.${chauffeur}` },
      (charge) => {
        if (charge.new.latitude === null) return;
        etat.position = charge.new;
        majCarte();
        afficherEtat();
      })
    .subscribe();
  // La position vient d'arriver : carte et heure d'arrivée estimée à jour
  majCarte();
  afficherEtat();
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------
function cleStatut(c) {
  return c.statut === 'planifiee' && c.chauffeur_id ? 'planifiee_attribuee' : c.statut;
}

// Minutes de route estimées entre deux points (mêmes réglages que le prix)
function minutesDeRoute(lat1, lng1, lat2, lng2) {
  const km = distanceKm(lat1, lng1, lat2, lng2) * Number(etat.parametres.coefficient_detour);
  return Math.max(1, Math.round((km / Number(etat.parametres.vitesse_moyenne_kmh)) * 60));
}

function afficher() {
  afficherEtat();
  afficherChauffeur();
  afficherRecapitulatif();
  afficherNote();
  majCarte();
}

function afficherEtat() {
  const c = etat.course;
  const cle = cleStatut(c);
  document.querySelector('.etat-course').dataset.statut = c.statut;
  $('etat-titre').textContent = t(`suivi.statut.${cle}`);
  let texte;
  const p = etat.position;
  if (cle === 'planifiee') texte = t('suivi.texte.planifiee', { date: dateHeure(c.prise_en_charge_le) });
  else if (cle === 'planifiee_attribuee') texte = t('suivi.texte.planifiee_attribuee', { date: dateHeure(c.prise_en_charge_le), prenom: c.chauffeur_prenom || '' });
  else if (cle === 'acceptee') texte = p
    ? t('suivi.texte.acceptee', { min: minutesDeRoute(p.latitude, p.longitude, c.depart_lat, c.depart_lng) })
    : t('suivi.texte.acceptee_sans_position');
  else if (cle === 'en_cours') texte = p
    ? t('suivi.texte.en_cours', { heure: dateHeure(Date.now() + minutesDeRoute(p.latitude, p.longitude, c.arrivee_lat, c.arrivee_lng) * 60000, { timeStyle: 'short' }) })
    : t('suivi.texte.en_cours_sans_position');
  else texte = t(`suivi.texte.${cle}`);
  $('etat-texte').textContent = texte;
}

function afficherChauffeur() {
  const c = etat.course;
  const visible = !!c.chauffeur_id && ['planifiee', 'acceptee', 'arrivee', 'en_cours', 'terminee'].includes(c.statut);
  $('bloc-chauffeur').hidden = !visible;
  if (visible) {
    $('chauffeur-prenom').textContent = c.chauffeur_prenom || '';
    $('chauffeur-vehicule').textContent = [c.vehicule_libelle, c.vehicule_couleur].filter(Boolean).join(', ');
    $('immatriculation').textContent = c.vehicule_immatriculation || '';
  }
  const enRoute = STATUTS_ACTIFS.includes(c.statut) || cleStatut(c) === 'planifiee_attribuee';
  $('appeler').hidden = !(enRoute && c.chauffeur_telephone);
  if (!$('appeler').hidden) {
    $('appeler').href = `tel:${c.chauffeur_telephone}`;
    $('appeler').textContent = t('suivi.appeler', { prenom: c.chauffeur_prenom || '' });
  }
  $('partager').hidden = !STATUTS_ACTIFS.includes(c.statut);
}

function afficherRecapitulatif() {
  const c = etat.course;
  $('recap-trajet').replaceChildren(
    el('li', { texte: c.depart_adresse + (c.depart_precision ? ` (${c.depart_precision})` : '') }),
    ...etat.arrets.map((a) => el('li', { texte: a.adresse })),
    el('li', { texte: c.arrivee_adresse })
  );
  $('recap-prix').textContent = euros(c.prix_total);
  $('recap-paiement').textContent = t(`suivi.mode.${c.mode_paiement}`);
  $('recap-attente').hidden = !(Number(c.frais_attente) > 0);
  $('recap-attente').textContent = t('suivi.attente', { min: c.attente_min, montant: euros(c.frais_attente) });
  $('recap-frais').hidden = !(Number(c.frais_annulation) > 0);
  $('recap-frais').textContent = t('suivi.frais', { montant: euros(c.frais_annulation) });
  $('recap-factures').replaceChildren(...etat.factures.map((f) => el('p', { classe: 'facture' },
    el('strong', { texte: t('suivi.facture', { numero: f.numero }) }),
    el('span', { texte: t('suivi.facture_detail', {
      ht: euros(f.montant_ht), taux: nombre(f.taux_tva, 2), tva: euros(f.montant_tva), ttc: euros(f.montant_ttc) }) }))));

  $('annuler').hidden = !['planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee'].includes(c.statut);
  const fini = ['terminee', 'annulee'].includes(c.statut);
  $('recommander').hidden = !fini;
  if (fini) {
    const lien = new URLSearchParams({
      d: c.depart_adresse, dlat: c.depart_lat, dlng: c.depart_lng,
      a: c.arrivee_adresse, alat: c.arrivee_lat, alng: c.arrivee_lng,
      ch: c.option_chauffeuse ? '1' : '0'
    });
    $('recommander').href = lienAvecLangue(`${RACINE}client/commande/?${lien}`);
  }
}

// ---------------------------------------------------------------------------
// Carte
// ---------------------------------------------------------------------------
function repere(classe) {
  return window.L.divIcon({ className: '', html: `<div class="${classe}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
}

function initialiserCarte() {
  if (!window.L) { $('carte').hidden = true; return; }       // carte indisponible : le suivi reste lisible
  const L = window.L;
  const c = etat.course;
  etat.carte = L.map('carte', { zoomControl: false, scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(etat.carte);
  etat.reperes.depart = L.marker([c.depart_lat, c.depart_lng], { icon: repere('repere'), keyboard: false }).addTo(etat.carte);
  etat.reperes.arrivee = L.marker([c.arrivee_lat, c.arrivee_lng], { icon: repere('repere repere-arrivee'), keyboard: false }).addTo(etat.carte);
  etat.arrets.forEach((a) => L.marker([a.latitude, a.longitude], { icon: repere('repere'), keyboard: false }).addTo(etat.carte));
  cadrer();
}

function majCarte() {
  if (!etat.carte) return;
  const L = window.L;
  const p = etat.position;
  if (p && STATUTS_ACTIFS.includes(etat.course.statut)) {
    if (!etat.reperes.voiture) {
      etat.reperes.voiture = L.marker([p.latitude, p.longitude], {
        keyboard: false,
        icon: L.divIcon({
          className: '', iconSize: [34, 34], iconAnchor: [17, 17],
          html: '<div class="repere-voiture"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11v6.5h-2v1.5h-2v-1.5H9v1.5H7v-1.5H5z"/></svg></div>'
        })
      }).addTo(etat.carte);
    } else {
      etat.reperes.voiture.setLatLng([p.latitude, p.longitude]);
    }
  } else if (etat.reperes.voiture) {
    etat.reperes.voiture.remove();
    etat.reperes.voiture = null;
  }
  cadrer();
}

// Cadre la carte sur ce qui compte maintenant : la voiture et le prochain point
function cadrer() {
  if (!etat.carte) return;
  const c = etat.course;
  const points = [];
  const p = etat.reperes.voiture ? etat.position : null;
  if (p) points.push([p.latitude, p.longitude]);
  if (!p || ['acceptee', 'arrivee'].includes(c.statut)) points.push([c.depart_lat, c.depart_lng]);
  if (!p || c.statut === 'en_cours') {
    points.push([c.arrivee_lat, c.arrivee_lng]);
    etat.arrets.forEach((a) => points.push([a.latitude, a.longitude]));
  }
  etat.carte.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
}

// ---------------------------------------------------------------------------
// Partage du trajet
// ---------------------------------------------------------------------------
$('partager').addEventListener('click', async () => {
  const c = etat.course;
  const texte = t('suivi.partage_texte', {
    depart: c.depart_adresse, arrivee: c.arrivee_adresse, prenom: c.chauffeur_prenom || '',
    vehicule: [c.vehicule_libelle, c.vehicule_couleur].filter(Boolean).join(' '), plaque: c.vehicule_immatriculation || ''
  });
  try {
    if (navigator.share) { await navigator.share({ title: 'LOC RÉACTION', text: texte }); return; }
    await navigator.clipboard.writeText(texte);
    afficherMessage(t('suivi.partage_copie'), 'succes');
  } catch {
    // Partage refermé par la personne : rien à signaler
  }
});

// ---------------------------------------------------------------------------
// Annulation : frais annoncés avant de confirmer
// ---------------------------------------------------------------------------
function preparerAnnulation() {
  const dialogue = $('dialogue-annulation');
  $('annuler').addEventListener('click', () => {
    const c = etat.course;
    const frais = Number(etat.tarif?.frais_annulation || 0);
    const delai = Number(etat.parametres.annulation_gratuite_planifiee_min);
    let texte = t('suivi.annuler_gratuit');
    if (frais > 0 && ['acceptee', 'arrivee'].includes(c.statut)) {
      texte = t('suivi.annuler_frais', { montant: euros(frais) });
    } else if (frais > 0 && c.statut === 'planifiee' && c.chauffeur_id
               && new Date(c.prise_en_charge_le).getTime() < Date.now() + delai * 60000) {
      texte = t('suivi.annuler_frais_planifiee', { montant: euros(frais), heures: nombre(delai / 60, 1) });
    }
    $('annulation-frais').textContent = texte;
    $('motif').value = '';
    dialogue.showModal();
  });
  $('garder').addEventListener('click', () => dialogue.close());
  $('confirmer-annulation').addEventListener('click', async () => {
    $('confirmer-annulation').disabled = true;
    const { data, error } = await supabase.rpc('annuler_course', { p_course: idCourse, p_motif: $('motif').value.trim() || null });
    $('confirmer-annulation').disabled = false;
    if (error) { afficherMessage(messageErreur(error, langueActive()), 'erreur'); return; }
    dialogue.close();
    afficherMessage(t('suivi.annulee_ok'), 'succes');
    await miseAJour(data);
  });
}

// ---------------------------------------------------------------------------
// Note du chauffeur (fin de course)
// ---------------------------------------------------------------------------
function preparerNote() {
  const etoiles = $('etoiles');
  for (let n = 1; n <= 5; n += 1) {
    const bouton = el('button', { type: 'button', classe: 'etoile', 'aria-pressed': 'false', 'aria-label': t('suivi.note_aria', { n }) });
    bouton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';
    bouton.addEventListener('click', () => {
      etat.noteChoisie = n;
      [...etoiles.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i < n)));
      $('erreur-note').hidden = true;
    });
    etoiles.append(bouton);
  }
  $('bloc-note').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!etat.noteChoisie) { $('erreur-note').textContent = t('suivi.note_choisir'); $('erreur-note').hidden = false; return; }
    $('envoyer-note').disabled = true;
    const { error } = await supabase.rpc('noter_course', {
      p_course: idCourse, p_note: etat.noteChoisie, p_commentaire: $('commentaire').value.trim() || null
    });
    $('envoyer-note').disabled = false;
    if (error) { afficherMessage(messageErreur(error, langueActive()), 'erreur'); return; }
    etat.noteDonnee = etat.noteChoisie;
    afficherMessage(t('suivi.note_merci'), 'succes');
    afficherNote();
  });
}

function afficherNote() {
  const terminee = etat.course.statut === 'terminee' && !!etat.course.chauffeur_id;
  $('bloc-note').hidden = !(terminee && etat.noteDonnee === null);
  $('note-donnee').hidden = !(terminee && etat.noteDonnee !== null);
  if (etat.noteDonnee !== null) $('note-donnee').textContent = t('suivi.note_donnee', { n: etat.noteDonnee });
}
