// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : accueil
// -----------------------------------------------------------------------------
// Les demandes arrivent par deux chemins, pour ne jamais en perdre une :
//   1. le temps réel (insertion dans « propositions » pour ce chauffeur) ;
//   2. une vérification toutes les 8 secondes (réseau coupé, appareil lent).
// Une demande non traitée dans le délai se ferme et la relance du dispatch
// est déclenchée tout de suite (en plus de la planification côté base).
// =============================================================================
import { supabase, profilConnecte, messageErreur } from '../commun/supabase.js';
import { RACINE } from '../commun/config.js';
import { imposerLangue, appliquerTraductions } from '../commun/i18n.js';
import { euros, nombre, el, afficherMessage, dateHeure } from '../commun/outils.js';
import { ChampAdresse, adresseDepuisPosition } from '../commun/adresse.js';
import { SuiviGps } from '../commun/gps-chauffeur.js';
import '../commun/pwa.js';

imposerLangue('fr');                 // espace chauffeur en français
appliquerTraductions();

const $ = (id) => document.getElementById(id);
const ETATS = { planifiee: 'Réservation', acceptee: 'En route vers le client', arrivee: 'Arrivé au point de prise en charge', en_cours: 'Client à bord' };
const MODES = { especes: 'Espèces', carte: 'Carte au terminal', facture_mensuelle: 'Facture mensuelle', solde: 'Solde' };
const etat = {
  profil: null, fiche: null, enLigne: false, gps: null,
  carte: null, repere: null, audio: null,
  demande: null,               // demande affichée : { id, echeance, duree, son, minuteur }
  delaiReponseMs: 30000,
  filtre: null,                // destination du filtre { adresse, lat, lng }
  attributionsVues: new Set()
};

demarrer().catch((erreur) => afficherMessage(messageErreur(erreur), 'erreur'));

async function demarrer() {
  const { data: { session } } = await supabase.auth.getSession();
  etat.profil = session ? await profilConnecte() : null;
  if (!etat.profil) {
    location.replace(`${RACINE}connexion/?suite=${encodeURIComponent('chauffeur/')}`);
    return;
  }
  if (etat.profil.role !== 'chauffeur' || etat.profil.statut !== 'actif') { $('acces-refuse').hidden = false; return; }

  const [fiche, position, parametres] = await Promise.all([
    supabase.from('chauffeurs').select('statut, note_moyenne, nb_notes, courses_proposees, courses_acceptees, '
      + 'filtre_destination_actif, filtre_destination_lat, filtre_destination_lng').eq('id', etat.profil.id).maybeSingle(),
    supabase.from('positions').select('en_ligne, latitude, longitude').eq('chauffeur_id', etat.profil.id).maybeSingle(),
    supabase.from('parametres').select('delai_reponse_chauffeur_s').maybeSingle()
  ]);
  if (!fiche.data || fiche.data.statut !== 'valide') { $('acces-refuse').hidden = false; return; }
  etat.fiche = fiche.data;
  if (parametres.data) etat.delaiReponseMs = parametres.data.delai_reponse_chauffeur_s * 1000;

  $('espace').hidden = false;
  initialiserCarte(position.data);
  afficherFiche();
  await preparerFiltre();
  etat.gps = new SuiviGps({ chauffeurId: etat.profil.id, onPosition: majMaPosition, onErreur: erreurGps });

  // Déjà en ligne (page rechargée) : la position reprend ; le son attend un toucher
  if (position.data && position.data.en_ligne) {
    etat.enLigne = true;
    etat.gps.demarrer();
    $('activer-son').hidden = false;
  }
  majBascule();

  await Promise.all([chargerJour(), chargerMesCourses(), chargerReservations()]);
  abonner();
  verifierDemandes();
  setInterval(verifierDemandes, 8000);
  setInterval(() => { chargerReservations(); chargerJour(); }, 30000);
}

// ---------------------------------------------------------------------------
// En ligne / hors ligne
// ---------------------------------------------------------------------------
function positionActuelle() {
  return new Promise((resoudre, rejeter) => {
    if (!navigator.geolocation) { rejeter(new Error('Ce téléphone ne donne pas sa position.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resoudre({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (erreur) => rejeter(erreur),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );
  });
}

function messageGps(erreur) {
  if (erreur && erreur.code === 1) return 'Autorisez la localisation pour ce site dans les réglages du téléphone : sans position, aucune demande ne peut vous être envoyée.';
  if (erreur && (erreur.code === 2 || erreur.code === 3)) return 'Position introuvable pour le moment : vérifiez que la localisation est activée, puis réessayez.';
  return messageErreur(erreur);
}

function erreurGps(erreur) {
  // Erreur de position pendant le service : prévenir sans couper le service
  if (erreur && 'code' in erreur && erreur.code === 1) {
    $('erreur-en-ligne').textContent = messageGps(erreur);
    $('erreur-en-ligne').hidden = false;
  }
}

$('bascule-en-ligne').addEventListener('click', async () => {
  debloquerSon();
  const bouton = $('bascule-en-ligne');
  $('erreur-en-ligne').hidden = true;
  bouton.disabled = true;
  try {
    if (!etat.enLigne) {
      demanderNotifications();
      const p = await positionActuelle();
      const { error } = await supabase.rpc('mettre_en_ligne', { p_en_ligne: true, p_lat: p.lat, p_lng: p.lng });
      if (error) throw error;
      etat.enLigne = true;
      etat.gps.demarrer();
      majMaPosition(p);
      verifierDemandes();
    } else {
      const { error } = await supabase.rpc('mettre_en_ligne', { p_en_ligne: false });
      if (error) throw error;
      etat.enLigne = false;
      etat.gps.arreter();
    }
  } catch (erreur) {
    $('erreur-en-ligne').textContent = 'code' in (erreur || {}) && typeof erreur.code === 'number' ? messageGps(erreur) : messageErreur(erreur);
    $('erreur-en-ligne').hidden = false;
  } finally {
    bouton.disabled = false;
    majBascule();
  }
});

function majBascule() {
  const bouton = $('bascule-en-ligne');
  bouton.dataset.enLigne = String(etat.enLigne);
  bouton.textContent = etat.enLigne ? 'Passer hors ligne' : 'Passer en ligne';
  $('pastille-etat').dataset.enLigne = String(etat.enLigne);
  $('pastille-etat').textContent = etat.enLigne ? 'En ligne' : 'Hors ligne';
  $('aide-en-ligne').textContent = etat.enLigne
    ? 'Vous recevez les demandes. Gardez l\'application ouverte, écran allumé.'
    : 'Gardez l\'application ouverte, écran allumé : les demandes arrivent ici avec un son et une vibration.';
}

// ---------------------------------------------------------------------------
// Son, vibration et notification
// ---------------------------------------------------------------------------
// Les navigateurs n'autorisent le son qu'après un geste : le bouton « Passer
// en ligne » (ou « Activer le son ») sert de geste.
function debloquerSon() {
  try {
    etat.audio = etat.audio || new (window.AudioContext || window.webkitAudioContext)();
    etat.audio.resume();
    $('activer-son').hidden = true;
  } catch {
    // Pas de son sur cet appareil : la vibration et l'écran restent
  }
}
$('activer-son').addEventListener('click', debloquerSon);

function bip() {
  if (navigator.vibrate) navigator.vibrate([300, 120, 300]);
  if (!etat.audio || etat.audio.state !== 'running') return;
  const debut = etat.audio.currentTime;
  [[0, 880], [0.25, 1046.5]].forEach(([decalage, frequence]) => {
    const oscillateur = etat.audio.createOscillator();
    const volume = etat.audio.createGain();
    oscillateur.type = 'sine';
    oscillateur.frequency.value = frequence;
    volume.gain.setValueAtTime(0.0001, debut + decalage);
    volume.gain.exponentialRampToValueAtTime(0.45, debut + decalage + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.0001, debut + decalage + 0.22);
    oscillateur.connect(volume).connect(etat.audio.destination);
    oscillateur.start(debut + decalage);
    oscillateur.stop(debut + decalage + 0.25);
  });
}

function demanderNotifications() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

async function notifierSiCache(texte) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const enregistrement = await navigator.serviceWorker?.getRegistration();
    if (enregistrement) {
      enregistrement.showNotification('Nouvelle demande LOC RÉACTION', {
        body: texte, tag: 'demande', renotify: true, requireInteraction: true, vibrate: [300, 120, 300]
      });
    }
  } catch {
    // Notification impossible : le son et l'écran restent
  }
}

// ---------------------------------------------------------------------------
// Demande entrante
// ---------------------------------------------------------------------------
async function verifierDemandes() {
  if (!etat.enLigne || etat.demande) return;
  const { data } = await supabase.from('propositions').select('id, expire_le')
    .eq('statut', 'envoyee').gt('expire_le', new Date().toISOString())
    .order('envoyee_le', { ascending: false }).limit(1);
  if (data && data.length) afficherDemande(data[0]);
}

async function afficherDemande(proposition) {
  if (etat.demande) return;
  etat.demande = { id: proposition.id };
  const { data, error } = await supabase.rpc('demande_recue', { p_proposition: proposition.id });
  if (error || !data || data.statut !== 'envoyee') { etat.demande = null; return; }

  // Temps restant : celui de la base, borné par le délai de réponse (l'horloge
  // du téléphone peut avancer ou retarder un peu)
  const restant = Math.min(Math.max(new Date(data.expire_le).getTime() - Date.now(), 0), etat.delaiReponseMs);
  if (restant < 2000) { etat.demande = null; return; }
  etat.demande.duree = restant;
  etat.demande.echeance = Date.now() + restant;

  $('demande-prix').textContent = euros(data.prix_total);
  $('demande-approche').textContent = data.distance_approche_km !== null
    ? `Client à ${nombre(data.distance_approche_km, 1)} km de vous` : '';
  $('demande-trajet').replaceChildren(
    el('li', { texte: data.depart_adresse + (data.depart_precision ? ` (${data.depart_precision})` : '') }),
    ...(data.arrets || []).map((a) => el('li', { texte: a.adresse })),
    el('li', { texte: data.arrivee_adresse })
  );
  const infos = [
    data.type === 'immediate' ? 'Maintenant' : `Le ${dateHeure(data.prise_en_charge_le, { dateStyle: 'medium', timeStyle: 'short' })}`,
    `${nombre(data.distance_km, 1)} km, environ ${data.duree_min} min`,
    MODES[data.mode_paiement] || data.mode_paiement
  ];
  if (data.option_chauffeuse) infos.push('Chauffeuse demandée');
  if (data.numero_vol) infos.push(`Vol ${data.numero_vol}`);
  $('demande-infos').replaceChildren(...infos.map((texte) => el('span', { texte })));

  $('demande').hidden = false;
  $('accepter').disabled = false;
  $('refuser').disabled = false;
  $('accepter').focus();
  bip();
  etat.demande.son = setInterval(bip, 2000);
  etat.demande.minuteur = setInterval(majDecompte, 200);
  majDecompte();
  notifierSiCache(`${euros(data.prix_total)} · ${data.depart_adresse}`);
}

function majDecompte() {
  if (!etat.demande) return;
  const reste = etat.demande.echeance - Date.now();
  $('decompte-barre').style.transform = `scaleX(${Math.max(0, reste / etat.demande.duree)})`;
  $('demande-titre').textContent = `Nouvelle demande · ${Math.max(0, Math.ceil(reste / 1000))} s`;
  if (reste <= 0) expirer();
}

function fermerDemande() {
  if (!etat.demande) return;
  clearInterval(etat.demande.son);
  clearInterval(etat.demande.minuteur);
  if (navigator.vibrate) navigator.vibrate(0);
  $('demande').hidden = true;
  etat.demande = null;
}

async function expirer() {
  fermerDemande();
  afficherMessage('Délai dépassé : la demande passe au chauffeur suivant.');
  // La requête ne part que si l'on attend sa réponse (bibliothèque Supabase) :
  // sans « await », la relance ne serait jamais envoyée
  await supabase.rpc('relancer_dispatch');
}

$('accepter').addEventListener('click', async () => {
  if (!etat.demande) return;
  $('accepter').disabled = true;
  $('refuser').disabled = true;
  const id = etat.demande.id;
  const { data, error } = await supabase.rpc('accepter_proposition', { p_proposition: id });
  fermerDemande();
  if (error) { afficherMessage(messageErreur(error), 'erreur'); return; }
  location.href = `course/?id=${data.id}`;
});

$('refuser').addEventListener('click', async () => {
  if (!etat.demande) return;
  $('accepter').disabled = true;
  $('refuser').disabled = true;
  const id = etat.demande.id;
  fermerDemande();
  const { error } = await supabase.rpc('refuser_proposition', { p_proposition: id });
  if (error) afficherMessage(messageErreur(error), 'erreur');
  chargerFiche();
});

// ---------------------------------------------------------------------------
// Chiffres du jour, note, acceptation
// ---------------------------------------------------------------------------
async function chargerFiche() {
  const { data } = await supabase.from('chauffeurs').select('statut, note_moyenne, nb_notes, courses_proposees, courses_acceptees, '
    + 'filtre_destination_actif, filtre_destination_lat, filtre_destination_lng').eq('id', etat.profil.id).maybeSingle();
  if (data) { etat.fiche = data; afficherFiche(); }
}

function afficherFiche() {
  const f = etat.fiche;
  $('note').textContent = f.note_moyenne !== null ? `${nombre(f.note_moyenne, 2)} / 5` : '—';
  $('acceptation').textContent = f.courses_proposees > 0
    ? `${Math.round((f.courses_acceptees / f.courses_proposees) * 100)} %` : '—';
}

async function chargerJour() {
  const jour = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date());   // AAAA-MM-JJ
  const { data } = await supabase.rpc('revenus_chauffeur', { p_debut: jour, p_fin: jour });
  const ligne = (data || [])[0];
  $('courses-jour').textContent = ligne ? ligne.courses : 0;
  $('ca-jour').textContent = euros(ligne ? Number(ligne.chiffre_affaires) + Number(ligne.attente) : 0);
  chargerFiche();
}

// ---------------------------------------------------------------------------
// Mes courses (attribuées) et réservations disponibles
// ---------------------------------------------------------------------------
function carteCourse(c, action) {
  const moment = c.statut === 'planifiee'
    ? dateHeure(c.prise_en_charge_le, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : ETATS[c.statut];
  return el('li', { classe: 'course-carte' },
    el('div', { classe: 'entete-course' }, el('span', { classe: 'moment', texte: moment }), el('span', { classe: 'montant', texte: euros(c.prix_total) })),
    el('p', { classe: 'adresses', texte: `${c.depart_adresse} → ${c.arrivee_adresse}` }),
    action);
}

async function chargerMesCourses() {
  const { data } = await supabase.from('courses')
    .select('id, numero, statut, prise_en_charge_le, depart_adresse, arrivee_adresse, prix_total')
    .eq('chauffeur_id', etat.profil.id).in('statut', ['planifiee', 'acceptee', 'arrivee', 'en_cours'])
    .order('prise_en_charge_le');
  const courses = data || [];
  $('bloc-mes-courses').hidden = !courses.length;
  $('mes-courses').replaceChildren(...courses.map((c) =>
    carteCourse(c, el('a', { classe: 'bouton bouton-principal', href: `course/?id=${c.id}`, texte: 'Ouvrir la course' }))));
}

async function chargerReservations() {
  const { data, error } = await supabase.rpc('reservations_disponibles');
  if (error) return;
  const liste = data || [];
  $('aucune-reservation').hidden = liste.length > 0;
  $('reservations').replaceChildren(...liste.map((r) => {
    const bouton = el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Prendre cette course' });
    bouton.addEventListener('click', async () => {
      bouton.disabled = true;
      const { error: erreur } = await supabase.rpc('prendre_course_planifiee', { p_course: r.course_id });
      if (erreur) { afficherMessage(messageErreur(erreur), 'erreur'); bouton.disabled = false; return; }
      afficherMessage('Réservation prise : elle apparaît dans « Mes courses ».', 'succes');
      chargerReservations();
      chargerMesCourses();
    });
    return carteCourse({ ...r, statut: 'planifiee' }, bouton);
  }));
}

// ---------------------------------------------------------------------------
// Filtre de destination
// ---------------------------------------------------------------------------
async function preparerFiltre() {
  const f = etat.fiche;
  $('filtre-actif').checked = !!f.filtre_destination_actif;
  if (f.filtre_destination_lat !== null && f.filtre_destination_lng !== null) {
    etat.filtre = { lat: Number(f.filtre_destination_lat), lng: Number(f.filtre_destination_lng) };
    etat.filtre.adresse = await adresseDepuisPosition(etat.filtre.lat, etat.filtre.lng);
  }
  const champ = new ChampAdresse({
    champ: $('filtre-adresse'), zones: [],
    onChoix: (valeur) => { if (valeur) { etat.filtre = valeur; enregistrerFiltre(); } }
  });
  if (etat.filtre) champ.definir(etat.filtre);
  $('filtre-actif').addEventListener('change', () => {
    if ($('filtre-actif').checked && !etat.filtre) {
      $('filtre-actif').checked = false;
      afficherMessage('Choisissez d\'abord l\'adresse vers laquelle vous voulez aller.', 'erreur');
      $('filtre-adresse').focus();
      return;
    }
    enregistrerFiltre();
  });
}

async function enregistrerFiltre() {
  const { error } = await supabase.from('chauffeurs').update({
    filtre_destination_actif: $('filtre-actif').checked,
    filtre_destination_lat: etat.filtre ? Math.round(etat.filtre.lat * 1e6) / 1e6 : null,
    filtre_destination_lng: etat.filtre ? Math.round(etat.filtre.lng * 1e6) / 1e6 : null
  }).eq('id', etat.profil.id);
  if (error) { afficherMessage(messageErreur(error), 'erreur'); return; }
  afficherMessage($('filtre-actif').checked ? 'Filtre de destination activé.' : 'Filtre de destination désactivé.', 'succes');
}

// ---------------------------------------------------------------------------
// Carte
// ---------------------------------------------------------------------------
function initialiserCarte(position) {
  if (!window.L) { $('carte').hidden = true; return; }
  const depart = position && position.latitude !== null ? [position.latitude, position.longitude] : [48.8566, 2.3522];
  etat.carte = window.L.map('carte', { zoomControl: false }).setView(depart, 14);
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(etat.carte);
  if (position && position.latitude !== null) majMaPosition({ lat: position.latitude, lng: position.longitude });
}

function majMaPosition(p) {
  if (!etat.carte) return;
  if (!etat.repere) {
    etat.repere = window.L.marker([p.lat, p.lng], {
      keyboard: false,
      icon: window.L.divIcon({ className: '', html: '<div class="repere-moi"></div>', iconSize: [20, 20], iconAnchor: [10, 10] })
    }).addTo(etat.carte);
  } else {
    etat.repere.setLatLng([p.lat, p.lng]);
  }
  etat.carte.panTo([p.lat, p.lng]);
}

// ---------------------------------------------------------------------------
// Temps réel : nouvelles demandes et courses attribuées
// ---------------------------------------------------------------------------
function abonner() {
  const moi = etat.profil.id;
  supabase.channel(`chauffeur-${moi}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'propositions', filter: `chauffeur_id=eq.${moi}` },
      (charge) => { if (etat.enLigne) afficherDemande(charge.new); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'courses', filter: `chauffeur_id=eq.${moi}` },
      (charge) => {
        chargerMesCourses();
        const c = charge.new || {};
        // Course attribuée à la main par l'administration : prévenir une fois
        if (c.attribution === 'manuelle' && ['acceptee', 'planifiee'].includes(c.statut) && !etat.attributionsVues.has(c.id)) {
          etat.attributionsVues.add(c.id);
          bip();
          afficherMessage('L\'administration vous a attribué une course : ouvrez-la dans « Mes courses ».', 'succes');
        }
      })
    .subscribe();
}
