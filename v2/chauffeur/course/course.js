// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : course en cours
// -----------------------------------------------------------------------------
// Étapes, dans l'ordre (la base refuse toute étape dans le désordre) :
//   réservation → « Partir maintenant » → « Je suis arrivé » → « Client à bord »
//   → « Terminer la course » → encaissement et note du client.
// La position est envoyée pendant toute la course : le client suit la voiture.
// Si le client annule, l'écran le montre en temps réel (relecture de secours
// toutes les 15 s).
// =============================================================================
import { supabase, profilConnecte, messageErreur } from '../../commun/supabase.js';
import { RACINE } from '../../commun/config.js';
import { imposerLangue, appliquerTraductions } from '../../commun/i18n.js';
import { euros, nombre, el, afficherMessage, dateHeure } from '../../commun/outils.js';
import { SuiviGps } from '../../commun/gps-chauffeur.js';
import '../../commun/pwa.js';

imposerLangue('fr');
appliquerTraductions();

const $ = (id) => document.getElementById(id);
const idCourse = new URLSearchParams(location.search).get('id');
const MODES = { especes: 'Espèces', carte: 'Carte bancaire, au terminal', facture_mensuelle: 'Facture mensuelle du compte professionnel', solde: 'Solde' };
// Étape suivante selon le statut : [titre, texte, bouton, étape envoyée à la base]
const ETAPES = {
  planifiee: ['Réservation à venir', 'Prise en charge le {date}.', 'Partir maintenant', 'en_route'],
  acceptee: ['En route vers le client', 'Rendez-vous au point de prise en charge.', 'Je suis arrivé', 'arrivee'],
  arrivee: ['Arrivé : le client est prévenu', 'Attendez le client au point de prise en charge.', 'Client à bord', 'a_bord'],
  en_cours: ['Client à bord', 'Conduisez le client à destination.', 'Terminer la course', 'terminee'],
  terminee: ['Course terminée', 'Encaissez le paiement puis notez le client.', null, null],
  annulee: ['Course annulée', 'Cette course a été annulée.', null, null]
};
const etat = {
  profil: null, course: null, arrets: [], societe: null, paiements: [], noteDonnee: false,
  attenteGratuiteMin: 5, gps: null, carte: null, reperes: {}, minuteurAttente: null, noteChoisie: 0,
  confirmation: null
};

demarrer().catch((erreur) => afficherMessage(messageErreur(erreur), 'erreur'));

async function demarrer() {
  const { data: { session } } = await supabase.auth.getSession();
  etat.profil = session ? await profilConnecte() : null;
  if (!etat.profil) {
    location.replace(`${RACINE}connexion/?suite=${encodeURIComponent(location.pathname.slice(RACINE.length) + location.search)}`);
    return;
  }
  if (!/^[0-9a-f-]{36}$/i.test(idCourse || '')) { $('introuvable').hidden = false; return; }
  await chargerCourse();
  if (!etat.course || etat.course.chauffeur_id !== etat.profil.id) { $('introuvable').hidden = false; return; }

  const [arrets, societe, parametres] = await Promise.all([
    supabase.from('course_arrets').select('ordre, adresse, latitude, longitude').eq('course_id', idCourse).order('ordre'),
    supabase.from('societe').select('raison_sociale, siren, registre_vtc_numero, adresse, code_postal, ville, telephone').maybeSingle(),
    supabase.from('parametres').select('attente_gratuite_min').maybeSingle()
  ]);
  etat.arrets = arrets.data || [];
  etat.societe = societe.data;
  if (parametres.data) etat.attenteGratuiteMin = parametres.data.attente_gratuite_min;
  await chargerFin();

  $('espace').hidden = false;
  etat.gps = new SuiviGps({ chauffeurId: etat.profil.id, onPosition: majMaPosition });
  initialiserCarte();
  preparerNote();
  afficher();
  abonner();
}

async function chargerCourse() {
  const { data, error } = await supabase.from('courses').select('*').eq('id', idCourse).maybeSingle();
  if (error) throw error;
  etat.course = data;
}

// Paiements et note déjà donnée (après la fin de course)
async function chargerFin() {
  if (etat.course.statut !== 'terminee') return;
  const [paiements, note] = await Promise.all([
    supabase.from('paiements').select('id, nature, mode, montant, statut').eq('course_id', idCourse).order('cree_le'),
    supabase.from('evaluations').select('id').eq('course_id', idCourse).eq('sens', 'chauffeur_vers_client').maybeSingle()
  ]);
  etat.paiements = paiements.data || [];
  etat.noteDonnee = !!note.data;
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------
function cible() {
  const c = etat.course;
  return c.statut === 'en_cours' ? { lat: c.arrivee_lat, lng: c.arrivee_lng } : { lat: c.depart_lat, lng: c.depart_lng };
}

function liensNavigation(lat, lng) {
  return {
    waze: `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
    maps: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`
  };
}

function afficher() {
  const c = etat.course;
  const [titre, texte, bouton] = ETAPES[c.statut] || ['', '', null];
  $('numero-course').textContent = c.numero;
  $('etape-titre').textContent = titre;
  $('etape-texte').textContent = texte.replace('{date}', dateHeure(c.prise_en_charge_le, { dateStyle: 'full', timeStyle: 'short' }));
  const vol = [c.numero_vol ? `Vol ${c.numero_vol}` : null, c.terminal ? `terminal ${c.terminal}` : null].filter(Boolean).join(', ');
  $('etape-vol').hidden = !vol;
  $('etape-vol').textContent = vol;

  const active = ['planifiee', 'acceptee', 'arrivee', 'en_cours'].includes(c.statut);
  $('navigation').hidden = !active;
  if (active) {
    const liens = liensNavigation(cible().lat, cible().lng);
    $('nav-waze').href = liens.waze;
    $('nav-maps').href = liens.maps;
  }
  $('bloc-client').hidden = !(active && c.client_telephone);
  $('client-prenom').textContent = c.client_prenom || '';
  $('appeler-client').href = c.client_telephone ? `tel:${c.client_telephone}` : '#';
  $('action-etape').hidden = !bouton;
  $('action-etape').textContent = bouton || '';
  $('desister').hidden = !['planifiee', 'acceptee', 'arrivee'].includes(c.statut);

  afficherAttente();
  afficherPaiement();
  afficherTrajet();
  afficherFeuilleDeRoute();
  $('bloc-note').hidden = !(c.statut === 'terminee' && !etat.noteDonnee);

  // Position envoyée pendant la course, arrêtée ensuite
  if (['acceptee', 'arrivee', 'en_cours'].includes(c.statut)) etat.gps.demarrer(); else etat.gps.arreter();
  majCarte();
}

// Attente au point de prise en charge : minutes gratuites, puis facturées
function afficherAttente() {
  clearInterval(etat.minuteurAttente);
  const c = etat.course;
  if (c.statut !== 'arrivee' || !c.arrivee_le) { $('attente').hidden = true; return; }
  const majAttente = () => {
    const depuis = Math.max(new Date(c.arrivee_le).getTime(), new Date(c.prise_en_charge_le).getTime());
    const minutes = Math.max(0, Math.floor((Date.now() - depuis) / 60000));
    const payante = minutes > etat.attenteGratuiteMin;
    $('attente').hidden = false;
    $('attente').dataset.payante = String(payante);
    $('attente').textContent = payante
      ? `Attente : ${minutes} min (au-delà de ${etat.attenteGratuiteMin} min gratuites)`
      : `Attente : ${minutes} min sur ${etat.attenteGratuiteMin} gratuites`;
  };
  majAttente();
  etat.minuteurAttente = setInterval(majAttente, 15000);
}

function afficherPaiement() {
  const c = etat.course;
  const paiement = etat.paiements.find((p) => p.nature === 'course');
  $('bloc-paiement').hidden = !(c.statut === 'terminee' && paiement);
  if (!paiement) return;
  $('montant-encaisser').textContent = euros(paiement.montant);
  $('mode-encaisser').textContent = MODES[paiement.mode] || paiement.mode;
  const aEncaisser = paiement.statut === 'a_encaisser' && paiement.mode !== 'facture_mensuelle';
  $('confirmer-encaissement').hidden = !aEncaisser;
  $('confirmer-encaissement').dataset.paiement = paiement.id;
  $('encaisse').hidden = paiement.statut !== 'encaisse';
}

function afficherTrajet() {
  const c = etat.course;
  const point = (adresse, lat, lng, precision) => {
    const liens = liensNavigation(lat, lng);
    return el('li', {},
      el('span', { texte: adresse + (precision ? ` (${precision})` : '') }),
      el('span', { classe: 'liens-nav' },
        el('a', { href: liens.waze, target: '_blank', rel: 'noopener', texte: 'Waze' }),
        el('a', { href: liens.maps, target: '_blank', rel: 'noopener', texte: 'Google Maps' })));
  };
  $('trajet').replaceChildren(
    point(c.depart_adresse, c.depart_lat, c.depart_lng, c.depart_precision),
    ...etat.arrets.map((a) => point(a.adresse, a.latitude, a.longitude)),
    point(c.arrivee_adresse, c.arrivee_lat, c.arrivee_lng)
  );
  const lignes = [
    ['Prix fixe', euros(c.prix_total)],
    ['Paiement', MODES[c.mode_paiement] || c.mode_paiement],
    ['Distance', `${nombre(c.distance_km, 1)} km, environ ${c.duree_min} min`]
  ];
  if (c.option_chauffeuse) lignes.push(['Option', 'Chauffeuse demandée']);
  if (Number(c.frais_attente) > 0) lignes.push(['Attente facturée', `${c.attente_min} min, ${euros(c.frais_attente)}`]);
  $('infos-course').replaceChildren(...lignes.map(([cle, valeur]) => el('div', {}, el('dt', { texte: cle }), el('dd', { texte: valeur }))));
}

// Feuille de route : coordonnées de l'entreprise, identité et téléphone du
// client, date et heure de la réservation, date, heure et lieu de prise en charge
function afficherFeuilleDeRoute() {
  const c = etat.course;
  const s = etat.societe || {};
  const lignes = [
    ['Exploitant', [s.raison_sociale, s.siren ? `SIREN ${s.siren}` : null].filter(Boolean).join(', ')],
    ['Adresse', [s.adresse, [s.code_postal, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ')],
    ['Registre VTC', s.registre_vtc_numero || 'n° à compléter dans l\'administration'],
    ['Course', c.numero],
    ['Client', [c.client_prenom, c.client_telephone].filter(Boolean).join(', ')],
    ['Réservée le', dateHeure(c.cree_le, { dateStyle: 'long', timeStyle: 'short' })],
    ['Prise en charge', `${dateHeure(c.prise_en_charge_le, { dateStyle: 'long', timeStyle: 'short' })}, ${c.depart_adresse}`],
    ['Véhicule', [c.vehicule_libelle, c.vehicule_immatriculation].filter(Boolean).join(', ')]
  ];
  $('feuille').replaceChildren(...lignes.map(([cle, valeur]) => el('div', {}, el('dt', { texte: cle }), el('dd', { texte: valeur || '—' }))));
}

// ---------------------------------------------------------------------------
// Étapes
// ---------------------------------------------------------------------------
$('action-etape').addEventListener('click', () => {
  const etape = (ETAPES[etat.course.statut] || [])[3];
  if (!etape) return;
  if (etape === 'terminee') {
    confirmer('Terminer la course ?', 'Le paiement sera à encaisser et le client recevra sa facture.', 'Terminer', () => avancer(etape));
    return;
  }
  avancer(etape);
});

async function avancer(etape) {
  const bouton = $('action-etape');
  bouton.disabled = true;
  const { data, error } = await supabase.rpc('avancer_course', { p_course: idCourse, p_etape: etape });
  bouton.disabled = false;
  if (error) { afficherMessage(messageErreur(error), 'erreur'); await chargerCourse(); afficher(); return; }
  etat.course = data;
  await chargerFin();
  afficher();
}

$('confirmer-encaissement').addEventListener('click', async () => {
  const bouton = $('confirmer-encaissement');
  bouton.disabled = true;
  const { error } = await supabase.rpc('confirmer_encaissement', { p_paiement: bouton.dataset.paiement });
  bouton.disabled = false;
  if (error) { afficherMessage(messageErreur(error), 'erreur'); return; }
  await chargerFin();
  afficher();
  afficherMessage('Paiement encaissé.', 'succes');
});

$('desister').addEventListener('click', () => {
  confirmer('Vous désister de cette course ?', 'La course repart vers un autre chauffeur et l\'administration est prévenue.',
    'Me désister', async (motif) => {
      const { error } = await supabase.rpc('annuler_course', { p_course: idCourse, p_motif: motif || null });
      if (error) { afficherMessage(messageErreur(error), 'erreur'); return; }
      etat.gps.arreter();
      location.replace('../');
    }, true);
});

// Boîte de confirmation (avec motif facultatif)
function confirmer(titre, texte, libelle, action, avecMotif = false) {
  $('dialogue-titre').textContent = titre;
  $('dialogue-texte').textContent = texte;
  $('dialogue-confirmer').textContent = libelle;
  $('bloc-motif').hidden = !avecMotif;
  $('motif').value = '';
  etat.confirmation = action;
  $('dialogue').showModal();
}
$('dialogue-annuler').addEventListener('click', () => $('dialogue').close());
$('dialogue-confirmer').addEventListener('click', async () => {
  const action = etat.confirmation;
  $('dialogue').close();
  if (action) await action($('motif').value.trim());
});

// ---------------------------------------------------------------------------
// Note du client (visible de l'administration seulement)
// ---------------------------------------------------------------------------
function preparerNote() {
  for (let n = 1; n <= 5; n += 1) {
    const bouton = el('button', { type: 'button', classe: 'etoile', 'aria-pressed': 'false', 'aria-label': `${n} sur 5` });
    bouton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';
    bouton.addEventListener('click', () => {
      etat.noteChoisie = n;
      [...$('etoiles').children].forEach((b, i) => b.setAttribute('aria-pressed', String(i < n)));
    });
    $('etoiles').append(bouton);
  }
  $('bloc-note').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!etat.noteChoisie) { afficherMessage('Choisissez de 1 à 5 étoiles.', 'erreur'); return; }
    const { error } = await supabase.rpc('noter_course', { p_course: idCourse, p_note: etat.noteChoisie, p_commentaire: null });
    if (error) { afficherMessage(messageErreur(error), 'erreur'); return; }
    etat.noteDonnee = true;
    afficher();
    afficherMessage('Note enregistrée.', 'succes');
  });
}

// ---------------------------------------------------------------------------
// Carte
// ---------------------------------------------------------------------------
function initialiserCarte() {
  if (!window.L) { $('carte').hidden = true; return; }
  const L = window.L;
  const c = etat.course;
  const icone = (classe) => L.divIcon({ className: '', html: `<div class="${classe}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  etat.carte = L.map('carte', { zoomControl: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(etat.carte);
  L.marker([c.depart_lat, c.depart_lng], { icon: icone('repere'), keyboard: false }).addTo(etat.carte);
  etat.arrets.forEach((a) => L.marker([a.latitude, a.longitude], { icon: icone('repere'), keyboard: false }).addTo(etat.carte));
  L.marker([c.arrivee_lat, c.arrivee_lng], { icon: icone('repere repere-arrivee'), keyboard: false }).addTo(etat.carte);
  majCarte();
}

function majMaPosition(p) {
  etat.moi = p;
  if (!etat.carte) return;
  if (!etat.reperes.moi) {
    etat.reperes.moi = window.L.marker([p.lat, p.lng], {
      keyboard: false,
      icon: window.L.divIcon({ className: '', html: '<div class="repere-moi"></div>', iconSize: [20, 20], iconAnchor: [10, 10] })
    }).addTo(etat.carte);
  } else {
    etat.reperes.moi.setLatLng([p.lat, p.lng]);
  }
}

function majCarte() {
  if (!etat.carte) return;
  const c = etat.course;
  const points = [[cible().lat, cible().lng]];
  if (etat.moi) points.push([etat.moi.lat, etat.moi.lng]);
  if (c.statut === 'en_cours' || c.statut === 'terminee') {
    points.push([c.depart_lat, c.depart_lng]);
    etat.arrets.forEach((a) => points.push([a.latitude, a.longitude]));
  }
  etat.carte.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
}

// ---------------------------------------------------------------------------
// Temps réel : annulation par le client, changement par l'administration
// ---------------------------------------------------------------------------
function abonner() {
  supabase.channel(`course-chauffeur-${idCourse}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'courses', filter: `id=eq.${idCourse}` },
      (charge) => majDepuisBase({ ...etat.course, ...charge.new }))
    .subscribe();
  setInterval(async () => {
    try {
      const { data, error } = await supabase.from('courses').select('*').eq('id', idCourse).maybeSingle();
      if (error) return;                         // réseau coupé : nouvel essai au prochain tour
      // Course devenue invisible pour ce chauffeur : l'administration la lui a
      // retirée (le temps réel ne prévient pas d'une ligne qu'on ne voit plus)
      if (!data) { majDepuisBase({ ...etat.course, chauffeur_id: null }); return; }
      majDepuisBase(data);
    } catch {
      // Réseau coupé : nouvel essai au prochain tour
    }
  }, 15000);
}

async function majDepuisBase(course) {
  const avant = etat.course.statut;
  // Plus attribuée à ce chauffeur (désistement, réattribution) : retour à l'accueil
  if (course.chauffeur_id !== etat.profil.id) {
    etat.gps.arreter();
    afficherMessage('Cette course ne vous est plus attribuée.', 'erreur');
    setTimeout(() => location.replace('../'), 2500);
    return;
  }
  etat.course = course;
  if (course.statut !== avant) {
    if (course.statut === 'annulee') {
      afficherMessage(course.annulee_par === 'admin' ? 'LOC RÉACTION a annulé la course.' : 'Le client a annulé la course.', 'erreur');
    }
    await chargerFin();
    afficher();
  }
}
