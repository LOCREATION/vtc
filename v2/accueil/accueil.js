// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Page d'accueil : estimation du prix en direct et passage à la commande
// -----------------------------------------------------------------------------
// 1. Lit dans la base les lieux desservis, le délai de réservation et
//    l'identité de la société (pied de page).
// 2. Quand le départ et l'arrivée sont choisis, demande le prix à la base
//    (fonction estimer_course) : distance, durée, majoration, forfait.
// 3. « Commander » mène à la commande (après connexion si besoin), avec le
//    trajet et le prix annoncé ; la base recalculera le prix et refusera la
//    commande s'il a changé entre-temps.
// =============================================================================
import { supabase, profilConnecte, messageErreur } from '../commun/supabase.js';
import { CATEGORIE_PAR_DEFAUT } from '../commun/config.js';
import { t, appliquerTraductions, langueActive, adopterLangueProfil, lienAvecLangue } from '../commun/i18n.js';
import { euros, nombre, el, afficherMessage, valeurDateHeureLocale } from '../commun/outils.js';
import { ChampAdresse, adresseDepuisPosition } from '../commun/adresse.js';
import '../commun/pwa.js';

// Noms courts des aéroports pour les raccourcis (sinon : nom complet de la base)
const NOMS_COURTS = {
  aeroport_cdg: 'Roissy-CDG',
  aeroport_orly: 'Orly',
  aeroport_beauvais: 'Beauvais',
  aeroport_le_bourget: 'Le Bourget'
};

const etat = {
  depart: null,          // { adresse, lat, lng }
  arrivee: null,
  estimation: null,      // réponse de estimer_course
  numeroEstimation: 0,   // ignore les réponses arrivées dans le désordre
  delaiMinutes: 60,      // délai minimal d'une réservation (paramètres)
  societe: null,
  session: null
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
appliquerTraductions();
demarrer().catch((erreur) => afficherMessage(messageErreur(erreur, langueActive()), 'erreur'));

async function demarrer() {
  // Session et profil : en-tête personnalisé et langue du profil
  const { data: { session } } = await supabase.auth.getSession();
  etat.session = session;
  if (session) {
    const profil = await profilConnecte();
    if (profil) {
      adopterLangueProfil(profil.langue);
      $('lien-connexion').hidden = true;
      $('salutation').hidden = false;
      $('salutation').textContent = profil.prenom ? t('nav.bonjour', { prenom: profil.prenom }) : (profil.email || '');
      $('deconnexion').hidden = false;
      // Chauffeur connecté : accès direct à son espace
      if (profil.role === 'chauffeur') $('lien-espace').hidden = false;
    }
  } else {
    // Après connexion, retour sur cette page
    $('lien-connexion').href = lienAvecLangue('connexion/');
  }

  // Lieux desservis, paramètres et identité, en parallèle
  const [zones, parametres, societe] = await Promise.all([
    supabase.from('zones').select('code, nom, type, latitude, longitude').eq('active', true).order('nom'),
    supabase.from('parametres').select('delai_min_planification_min').maybeSingle(),
    supabase.from('societe').select('*').maybeSingle()
  ]);
  if (zones.error) throw zones.error;
  if (parametres.data) etat.delaiMinutes = parametres.data.delai_min_planification_min;
  etat.societe = societe.data;

  preparerChamps(zones.data || []);
  preparerRaccourcis((zones.data || []).filter((z) => z.type === 'aeroport'));
  preparerQuand();
  remplirPied();
}

// ---------------------------------------------------------------------------
// Départ et arrivée
// ---------------------------------------------------------------------------
let champDepart;
let champArrivee;

function preparerChamps(zones) {
  // Les adresses sont cherchées près du départ s'il est connu
  const centre = () => (etat.depart ? { lat: etat.depart.lat, lng: etat.depart.lng } : undefined) || { lat: 48.8566, lng: 2.3522 };

  champDepart = new ChampAdresse({
    champ: $('depart'), zones, centre,
    onChoix: (valeur) => { etat.depart = valeur; estimer(); }
  });
  champArrivee = new ChampAdresse({
    champ: $('arrivee'), zones, centre,
    onChoix: (valeur) => { etat.arrivee = valeur; estimer(); }
  });

  // Position actuelle comme départ
  $('ma-position').addEventListener('click', () => {
    if (!navigator.geolocation) { afficherMessage(t('trajet.position_refusee'), 'erreur'); return; }
    $('ma-position').disabled = true;
    navigator.geolocation.getCurrentPosition(async (position) => {
      const { latitude, longitude } = position.coords;
      const adresse = await adresseDepuisPosition(latitude, longitude);
      champDepart.definir({ adresse, lat: latitude, lng: longitude });
      $('ma-position').disabled = false;
    }, () => {
      afficherMessage(t('trajet.position_refusee'), 'erreur');
      $('ma-position').disabled = false;
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });

  // Inverser le départ et l'arrivée
  $('inverser').addEventListener('click', () => {
    const ancienDepart = etat.depart;
    const ancienneArrivee = etat.arrivee;
    champDepart.definir(ancienneArrivee);
    champArrivee.definir(ancienDepart);
  });
}

// Raccourcis : remplit l'arrivée, ou le départ si l'arrivée est déjà choisie
function preparerRaccourcis(aeroports) {
  if (!aeroports.length) return;
  const conteneur = $('raccourcis');
  aeroports
    .sort((a, b) => Object.keys(NOMS_COURTS).indexOf(a.code) - Object.keys(NOMS_COURTS).indexOf(b.code))
    .forEach((zone) => {
      const lieu = { adresse: zone.nom, lat: Number(zone.latitude), lng: Number(zone.longitude) };
      conteneur.append(el('button', {
        type: 'button', classe: 'pastille', title: zone.nom,
        onclick: () => {
          if (!etat.arrivee || etat.depart) champArrivee.definir(lieu);
          else champDepart.definir(lieu);
        }
      }, iconeAvion(), NOMS_COURTS[zone.code] || zone.nom));
    });
  $('bloc-raccourcis').hidden = false;
}

function iconeAvion() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'currentColor');
  const chemin = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chemin.setAttribute('d', 'M10.5 3.5c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5V9l7.5 4.5V16l-7.5-2.3V18l2.2 1.6V21L12 20l-3.7 1v-1.4l2.2-1.6v-4.3L3 16v-2.5L10.5 9z');
  svg.append(chemin);
  return svg;
}

// ---------------------------------------------------------------------------
// Maintenant ou plus tard
// ---------------------------------------------------------------------------
function preparerQuand() {
  const champDate = $('date-heure');
  const majBornes = () => {
    // Au plus tôt : maintenant + délai minimal, arrondi aux 5 minutes suivantes
    const auPlusTot = new Date(Date.now() + etat.delaiMinutes * 60000);
    auPlusTot.setMinutes(Math.ceil(auPlusTot.getMinutes() / 5) * 5, 0, 0);
    champDate.min = valeurDateHeureLocale(auPlusTot);
    champDate.max = valeurDateHeureLocale(new Date(Date.now() + 90 * 86400000));
    if (!champDate.value || new Date(champDate.value) < auPlusTot) champDate.value = valeurDateHeureLocale(auPlusTot);
    $('aide-date').textContent = t('trajet.delai_min', { min: etat.delaiMinutes });
  };
  document.querySelectorAll('input[name="quand"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const plusTard = radio.value === 'plus_tard' && radio.checked;
      $('bloc-date').hidden = !plusTard;
      if (plusTard) majBornes();
      majBoutonCommande();
      estimer();
    });
  });
  champDate.addEventListener('change', estimer);
  $('chauffeuse').addEventListener('change', estimer);
}

function quandChoisi() {
  const plusTard = document.querySelector('input[name="quand"]:checked').value === 'plus_tard';
  if (!plusTard) return { type: 'immediate', instant: null, valide: true };
  const valeur = $('date-heure').value;
  const instant = valeur ? new Date(valeur) : null;
  const valide = !!instant && instant.getTime() >= Date.now() + etat.delaiMinutes * 60000 - 60000
                 && instant.getTime() <= Date.now() + 90 * 86400000;
  $('date-heure').setAttribute('aria-invalid', String(!valide));
  return { type: 'planifiee', instant, valide };
}

// ---------------------------------------------------------------------------
// Prix
// ---------------------------------------------------------------------------
async function estimer() {
  const plaque = $('plaque');
  etat.estimation = null;
  $('hors-zone').hidden = true;
  majBoutonCommande();

  if (!etat.depart || !etat.arrivee) {
    afficherPrix('—', null, [t('prix.attente')]);
    return;
  }
  const quand = quandChoisi();
  if (!quand.valide) {
    afficherPrix('—', null, [t('trajet.delai_min', { min: etat.delaiMinutes })]);
    return;
  }

  const numero = ++etat.numeroEstimation;
  plaque.dataset.etat = 'calcul';
  $('prix-detail').replaceChildren(el('span', { texte: t('prix.calcul') }));

  const { data, error } = await supabase.rpc('estimer_course', {
    p_categorie: CATEGORIE_PAR_DEFAUT,
    p_depart_lat: etat.depart.lat, p_depart_lng: etat.depart.lng,
    p_arrivee_lat: etat.arrivee.lat, p_arrivee_lng: etat.arrivee.lng,
    p_quand: quand.instant ? quand.instant.toISOString() : null,
    p_type: quand.type,
    p_option_chauffeuse: $('chauffeuse').checked
  });
  if (numero !== etat.numeroEstimation) return;          // une estimation plus récente est en cours
  delete plaque.dataset.etat;

  if (error) {
    afficherPrix('—', null, [t('prix.erreur')]);
    afficherMessage(messageErreur(error, langueActive()), 'erreur');
    return;
  }
  if (data.hors_zone) {
    afficherPrix('—', null, []);
    $('hors-zone').hidden = false;
    $('lien-devis').href = lienDevis(quand);
    return;
  }

  etat.estimation = data;
  const details = [
    t('prix.distance', { km: nombre(data.distance_km, 1) }),
    t('prix.duree', { min: data.duree_min })
  ];
  if (data.forfait_id) details.unshift(t('prix.forfait'));
  if (Number(data.majoration_pourcentage) > 0) {
    const cle = { nuit: 'prix.majoration', dimanche: 'prix.majoration_dimanche', ferie: 'prix.majoration_ferie' }[data.majoration_type] || 'prix.majoration';
    details.push(t(cle, { pct: nombre(data.majoration_pourcentage, 0) }));
  }
  afficherPrix(euros(data.prix_total), t('prix.fixe'), details);
  majBoutonCommande();
}

function afficherPrix(prix, libelle, details) {
  $('prix').textContent = prix;
  $('prix').setAttribute('aria-hidden', prix === '—' ? 'true' : 'false');
  $('prix-libelle').hidden = !libelle;
  $('prix-detail').replaceChildren(...details.map((texte) => el('span', { texte })));
}

function majBoutonCommande() {
  const plusTard = document.querySelector('input[name="quand"]:checked').value === 'plus_tard';
  const bouton = $('commander');
  bouton.textContent = t(plusTard ? 'action.reserver' : 'action.commander');
  bouton.disabled = !etat.estimation;
}

// Demande de devis par e-mail (trajet hors zone), pré-remplie
function lienDevis(quand) {
  const adresse = etat.societe?.email || '';
  const sujet = langueActive() === 'en' ? 'Quote request' : 'Demande de devis';
  const corps = [
    `${t('trajet.depart')} : ${etat.depart?.adresse || ''}`,
    `${t('trajet.arrivee')} : ${etat.arrivee?.adresse || ''}`,
    quand.instant ? `${t('trajet.date_heure')} : ${quand.instant.toLocaleString(langueActive() === 'en' ? 'en-GB' : 'fr-FR', { timeZone: 'Europe/Paris' })}` : ''
  ].filter(Boolean).join('\n');
  return `mailto:${adresse}?subject=${encodeURIComponent(sujet)}&body=${encodeURIComponent(corps)}`;
}

// ---------------------------------------------------------------------------
// Commander : vers la commande, avec le trajet et le prix annoncé
// ---------------------------------------------------------------------------
$('trajet').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!etat.estimation) return;
  const quand = quandChoisi();
  const parametres = new URLSearchParams({
    d: etat.depart.adresse, dlat: etat.depart.lat, dlng: etat.depart.lng,
    a: etat.arrivee.adresse, alat: etat.arrivee.lat, alng: etat.arrivee.lng,
    ch: $('chauffeuse').checked ? '1' : '0',
    p: etat.estimation.prix_total
  });
  if (quand.instant) parametres.set('q', quand.instant.toISOString());
  const commande = `client/commande/?${parametres}`;
  location.href = etat.session
    ? lienAvecLangue(commande)
    : lienAvecLangue(`connexion/?suite=${encodeURIComponent(commande)}`);
});

// Déconnexion
$('deconnexion').addEventListener('click', async () => {
  await supabase.auth.signOut();
  location.reload();
});

// ---------------------------------------------------------------------------
// Pied de page : identité légale lue dans la base
// ---------------------------------------------------------------------------
function remplirPied() {
  const s = etat.societe;
  if (!s) return;
  const capital = new Intl.NumberFormat(langueActive() === 'en' ? 'en-GB' : 'fr-FR',
    { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(s.capital || 0));
  $('pied-nom').textContent = s.raison_sociale;
  $('pied-identite').textContent = [
    [s.forme_juridique, s.capital ? t('pied.capital', { capital }) : null].filter(Boolean).join(' '),
    s.rcs,
    [s.adresse, [s.code_postal, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  ].filter(Boolean).join('. ') + '.';
  if (s.email) {
    $('pied-contact').href = `mailto:${s.email}`;
    $('pied-contact').hidden = false;
  }
}
