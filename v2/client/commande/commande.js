// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client : commande d'une course
// -----------------------------------------------------------------------------
// - Réservé aux clients connectés ; sinon, connexion puis retour ici.
// - Le trajet arrive de l'accueil par le lien (départ, arrivée, date, option) :
//   tout reste modifiable, avec jusqu'à 5 arrêts.
// - Le prix est recalculé par la base à chaque changement (arrêts, date, code
//   promo). À la confirmation, la base le recalcule encore et refuse la
//   commande s'il ne correspond plus au prix affiché.
// =============================================================================
import { supabase, profilConnecte, messageErreur } from '../../commun/supabase.js';
import { CATEGORIE_PAR_DEFAUT, RACINE } from '../../commun/config.js';
import { t, appliquerTraductions, langueActive, adopterLangueProfil, lienAvecLangue } from '../../commun/i18n.js';
import { euros, nombre, el, afficherMessage, valeurDateHeureLocale, telephoneInternational, zoneDuPoint } from '../../commun/outils.js';
import { ChampAdresse, adresseDepuisPosition } from '../../commun/adresse.js';
import '../../commun/pwa.js';

const MAX_ARRETS = 5;
const $ = (id) => document.getElementById(id);
const etat = {
  depart: null, arrivee: null,
  arrets: [],                 // [{ bloc, champ, valeur }]
  estimation: null, numeroEstimation: 0,
  delaiMinutes: 60, zones: [], profil: null, proches: [], comptesPro: [],
  codePromo: null,            // code en cours d'application
  initialisation: true        // pas d'estimation pendant le remplissage initial
};
let champDepart;
let champArrivee;

appliquerTraductions();
demarrer().catch((erreur) => afficherMessage(messageErreur(erreur, langueActive()), 'erreur'));

// Chemin de cette page relatif à la racine du site (pour revenir après connexion)
function cheminRelatif() {
  return location.pathname.slice(RACINE.length) + location.search;
}

async function demarrer() {
  const { data: { session } } = await supabase.auth.getSession();
  etat.profil = session ? await profilConnecte() : null;
  if (!etat.profil) {
    location.replace(lienAvecLangue(`${RACINE}connexion/?suite=${encodeURIComponent(cheminRelatif())}`));
    return;
  }
  adopterLangueProfil(etat.profil.langue);
  if (!etat.profil.prenom || !etat.profil.telephone) {
    $('profil-incomplet').hidden = false;
    $('lien-profil').href = lienAvecLangue(`${RACINE}connexion/?suite=${encodeURIComponent(cheminRelatif())}`);
  }

  const [zones, parametres, proches, comptes] = await Promise.all([
    supabase.from('zones').select('code, nom, type, latitude, longitude, rayon_km').eq('active', true).order('nom'),
    supabase.from('parametres').select('delai_min_planification_min').maybeSingle(),
    supabase.from('proches').select('id, nom, telephone').order('nom'),
    supabase.from('comptes_pro_membres').select('compte_pro_id, comptes_pro(raison_sociale, statut)')
  ]);
  if (zones.error) throw zones.error;
  etat.zones = zones.data || [];
  if (parametres.data) etat.delaiMinutes = parametres.data.delai_min_planification_min;
  etat.proches = proches.data || [];
  etat.comptesPro = (comptes.data || []).filter((m) => m.comptes_pro && m.comptes_pro.statut === 'actif');

  preparerTrajet();
  preparerQuand();
  preparerProche();
  preparerPaiement();
  preparerCodePromo();
  lireLien();
  etat.initialisation = false;
  estimer();
}

// ---------------------------------------------------------------------------
// Trajet : départ, arrêts, arrivée
// ---------------------------------------------------------------------------
function centre() {
  return etat.depart ? { lat: etat.depart.lat, lng: etat.depart.lng } : { lat: 48.8566, lng: 2.3522 };
}

function preparerTrajet() {
  champDepart = new ChampAdresse({
    champ: $('depart'), zones: etat.zones, centre,
    onChoix: (valeur) => { etat.depart = valeur; majVol(); estimer(); }
  });
  champArrivee = new ChampAdresse({
    champ: $('arrivee'), zones: etat.zones, centre,
    onChoix: (valeur) => { etat.arrivee = valeur; estimer(); }
  });

  $('ma-position').addEventListener('click', () => {
    if (!navigator.geolocation) { afficherMessage(t('trajet.position_refusee'), 'erreur'); return; }
    $('ma-position').disabled = true;
    navigator.geolocation.getCurrentPosition(async (position) => {
      const { latitude, longitude } = position.coords;
      champDepart.definir({ adresse: await adresseDepuisPosition(latitude, longitude), lat: latitude, lng: longitude });
      $('ma-position').disabled = false;
    }, () => {
      afficherMessage(t('trajet.position_refusee'), 'erreur');
      $('ma-position').disabled = false;
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });

  $('inverser').addEventListener('click', () => {
    const ancienDepart = etat.depart;
    champDepart.definir(etat.arrivee);
    champArrivee.definir(ancienDepart);
  });

  $('ajouter-arret').addEventListener('click', () => ajouterArret());
}

function ajouterArret(valeur = null) {
  if (etat.arrets.length >= MAX_ARRETS) return;
  const id = `arret-${etat.arrets.length + 1}-${Date.now()}`;
  const champ = el('input', { id, classe: 'saisie', type: 'text', placeholder: t('commande.arret_aide') });
  const retirer = el('button', { type: 'button', classe: 'retirer-arret', texte: '×' });
  const etiquette = el('label', { for: id });
  const bloc = el('div', { classe: 'point point-arret' }, etiquette, el('div', { classe: 'point-saisie' }, champ, retirer));
  $('points').insertBefore(bloc, $('point-arrivee'));

  const arret = { bloc, valeur: null, etiquette, retirer };
  arret.champ = new ChampAdresse({
    champ, zones: etat.zones, centre,
    onChoix: (v) => { arret.valeur = v; estimer(); }
  });
  retirer.addEventListener('click', () => {
    bloc.remove();
    etat.arrets = etat.arrets.filter((a) => a !== arret);
    renumeroterArrets();
    estimer();
  });
  etat.arrets.push(arret);
  renumeroterArrets();
  if (valeur) arret.champ.definir(valeur); else champ.focus();
}

function renumeroterArrets() {
  etat.arrets.forEach((arret, i) => {
    arret.etiquette.textContent = t('commande.arret', { n: i + 1 });
    arret.retirer.setAttribute('aria-label', t('commande.retirer_arret', { n: i + 1 }));
  });
  $('ajouter-arret').hidden = etat.arrets.length >= MAX_ARRETS;
  // Avec des arrêts, l'inversion n'a plus de sens simple : le bouton disparaît
  $('inverser').hidden = etat.arrets.length > 0;
  estimerSiPret();
}

// Départ dans un aéroport : numéro de vol et terminal proposés
function majVol() {
  const aeroports = etat.zones.filter((z) => z.type === 'aeroport');
  const zone = etat.depart ? zoneDuPoint(aeroports, etat.depart.lat, etat.depart.lng) : null;
  $('bloc-vol').hidden = !zone;
}

// Trajet transmis par l'accueil dans le lien
function lireLien() {
  const lien = new URLSearchParams(location.search);
  const point = (prefixe, nom) => {
    const lat = Number(lien.get(`${prefixe}lat`));
    const lng = Number(lien.get(`${prefixe}lng`));
    return lien.get(nom) && Number.isFinite(lat) && Number.isFinite(lng) && lat && lng
      ? { adresse: lien.get(nom), lat, lng } : null;
  };
  const depart = point('d', 'd');
  const arrivee = point('a', 'a');
  if (depart) champDepart.definir(depart);
  if (arrivee) champArrivee.definir(arrivee);
  if (lien.get('ch') === '1') $('chauffeuse').checked = true;
  const quand = lien.get('q');
  if (quand && !Number.isNaN(Date.parse(quand))) {
    document.querySelector('input[name="quand"][value="plus_tard"]').checked = true;
    $('bloc-date').hidden = false;
    bornesDate();
    $('date-heure').value = valeurDateHeureLocale(new Date(quand));
  }
  majBoutonCommande();
}

// ---------------------------------------------------------------------------
// Maintenant ou plus tard
// ---------------------------------------------------------------------------
function bornesDate() {
  const champDate = $('date-heure');
  const auPlusTot = new Date(Date.now() + etat.delaiMinutes * 60000);
  auPlusTot.setMinutes(Math.ceil(auPlusTot.getMinutes() / 5) * 5, 0, 0);
  champDate.min = valeurDateHeureLocale(auPlusTot);
  champDate.max = valeurDateHeureLocale(new Date(Date.now() + 90 * 86400000));
  if (!champDate.value || new Date(champDate.value) < auPlusTot) champDate.value = valeurDateHeureLocale(auPlusTot);
  $('aide-date').textContent = t('trajet.delai_min', { min: etat.delaiMinutes });
}

function preparerQuand() {
  document.querySelectorAll('input[name="quand"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const plusTard = radio.value === 'plus_tard' && radio.checked;
      $('bloc-date').hidden = !plusTard;
      if (plusTard) bornesDate();
      majBoutonCommande();
      estimer();
    });
  });
  $('date-heure').addEventListener('change', estimer);
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

function majBoutonCommande() {
  const plusTard = document.querySelector('input[name="quand"]:checked').value === 'plus_tard';
  $('commander').textContent = t(plusTard ? 'action.reserver' : 'action.commander');
  $('commander').disabled = !etat.estimation || !etat.profil?.telephone || !etat.profil?.prenom;
}

// ---------------------------------------------------------------------------
// Pour un proche
// ---------------------------------------------------------------------------
function preparerProche() {
  const liste = $('proche-enregistre');
  if (etat.proches.length) {
    liste.append(el('option', { value: '', texte: t('commande.proche_nouveau') }));
    etat.proches.forEach((p) => liste.append(el('option', { value: p.id, texte: `${p.nom} (${p.telephone})` })));
    $('bloc-proches-enregistres').hidden = false;
    liste.addEventListener('change', () => {
      const proche = etat.proches.find((p) => p.id === liste.value);
      $('proche-nom').value = proche ? proche.nom : '';
      $('proche-telephone').value = proche ? proche.telephone : '';
      $('case-enregistrer-proche').hidden = !!proche;
    });
  }
  document.querySelectorAll('input[name="pour"]').forEach((radio) => {
    radio.addEventListener('change', () => { $('bloc-proche').hidden = !(radio.value === 'proche' && radio.checked); });
  });
}

// ---------------------------------------------------------------------------
// Paiement : espèces, carte au terminal, facture mensuelle (comptes pro)
// ---------------------------------------------------------------------------
function preparerPaiement() {
  etat.comptesPro.forEach((membre) => {
    $('choix-comptes-pro').append(el('label', { classe: 'case' },
      el('input', { type: 'radio', name: 'paiement', value: 'facture_mensuelle', dataset: { compte: membre.compte_pro_id } }),
      el('span', { texte: t('commande.facture_mensuelle', { compte: membre.comptes_pro.raison_sociale }) })));
  });
}

// ---------------------------------------------------------------------------
// Code promo : vérifié par la base, appliqué au prix
// ---------------------------------------------------------------------------
function preparerCodePromo() {
  $('appliquer-code').addEventListener('click', () => {
    if (etat.codePromo) {                       // « Retirer le code »
      etat.codePromo = null;
      $('code-promo').value = '';
      $('code-promo').disabled = false;
      $('appliquer-code').textContent = t('commande.appliquer');
      messageCode(null);
      estimer();
      return;
    }
    const code = $('code-promo').value.trim().toUpperCase();
    if (!code) return;
    etat.codePromo = code;
    estimer();
  });
}

function messageCode(texte, erreur = false) {
  const zone = $('message-code');
  zone.hidden = !texte;
  zone.textContent = texte || '';
  zone.className = erreur ? 'erreur-champ' : 'aide';
}

// ---------------------------------------------------------------------------
// Prix
// ---------------------------------------------------------------------------
function estimerSiPret() {
  if (!etat.initialisation) estimer();
}

async function estimer() {
  if (etat.initialisation) return;
  etat.estimation = null;
  $('hors-zone').hidden = true;
  $('erreur-commande').hidden = true;
  majBoutonCommande();

  const arretsIncomplets = etat.arrets.some((a) => !a.valeur);
  if (!etat.depart || !etat.arrivee || arretsIncomplets) { afficherPrix('—', null, [t('prix.attente')]); return; }
  const quand = quandChoisi();
  if (!quand.valide) { afficherPrix('—', null, [t('trajet.delai_min', { min: etat.delaiMinutes })]); return; }

  const numero = ++etat.numeroEstimation;
  $('plaque').dataset.etat = 'calcul';
  $('prix-detail').replaceChildren(el('span', { texte: t('prix.calcul') }));
  const { data, error } = await supabase.rpc('estimer_course', {
    p_categorie: CATEGORIE_PAR_DEFAUT,
    p_depart_lat: etat.depart.lat, p_depart_lng: etat.depart.lng,
    p_arrivee_lat: etat.arrivee.lat, p_arrivee_lng: etat.arrivee.lng,
    p_arrets: etat.arrets.map((a) => ({ adresse: a.valeur.adresse, lat: a.valeur.lat, lng: a.valeur.lng })),
    p_quand: quand.instant ? quand.instant.toISOString() : null,
    p_type: quand.type,
    p_option_chauffeuse: $('chauffeuse').checked,
    p_code_promo: etat.codePromo
  });
  if (numero !== etat.numeroEstimation) return;
  delete $('plaque').dataset.etat;
  if (error) {
    afficherPrix('—', null, [t('prix.erreur')]);
    afficherMessage(messageErreur(error, langueActive()), 'erreur');
    return;
  }
  if (data.hors_zone) { afficherPrix('—', null, []); $('hors-zone').hidden = false; return; }

  // Code promo : accepté (remise) ou refusé (motif de la base)
  if (etat.codePromo) {
    if (data.code_promo_id) {
      $('code-promo').disabled = true;
      $('appliquer-code').textContent = t('commande.retirer_code');
      messageCode(t('commande.remise', { montant: euros(data.remise) }));
    } else {
      messageCode(data.message_promo, true);
      etat.codePromo = null;
    }
  }

  etat.estimation = data;
  const details = [t('prix.distance', { km: nombre(data.distance_km, 1) }), t('prix.duree', { min: data.duree_min })];
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

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------
function erreurChamp(champ, message) {
  const zone = $(`erreur-${champ}`);
  zone.hidden = !message;
  zone.textContent = message || '';
  $(champ).setAttribute('aria-invalid', String(!!message));
}

$('commande').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!etat.estimation) return;
  $('erreur-commande').hidden = true;

  // Numéro de vol (facultatif) : même règle que la base
  const vol = $('vol').value.replace(/\s/g, '').toUpperCase();
  const volValide = !vol || /^[A-Z0-9]{2,3}[0-9]{1,4}[A-Z]?$/.test(vol);
  erreurChamp('vol', volValide ? null : t('commande.vol_invalide'));

  // Personne transportée
  const pourProche = document.querySelector('input[name="pour"]:checked').value === 'proche';
  let nomProche = null;
  let telephoneProche = null;
  if (pourProche) {
    nomProche = $('proche-nom').value.trim();
    telephoneProche = telephoneInternational($('proche-telephone').value);
    erreurChamp('proche-nom', nomProche ? null : t('commande.proche_requis'));
    erreurChamp('proche-telephone', telephoneProche ? null : t('profil.telephone_invalide'));
  }
  if (!volValide || (pourProche && (!nomProche || !telephoneProche))) return;

  const paiement = document.querySelector('input[name="paiement"]:checked');
  const quand = quandChoisi();
  const bouton = $('commander');
  const libelle = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = t('commande.envoi');

  // Nouveau proche : enregistré pour les prochaines fois (sans bloquer la commande)
  if (pourProche && !$('proche-enregistre').value && $('enregistrer-proche').checked) {
    await supabase.from('proches').insert({ client_id: etat.profil.id, nom: nomProche, telephone: telephoneProche });
  }

  const { data, error } = await supabase.rpc('commander_course', {
    p_categorie: CATEGORIE_PAR_DEFAUT,
    p_depart_adresse: etat.depart.adresse, p_depart_lat: etat.depart.lat, p_depart_lng: etat.depart.lng,
    p_arrivee_adresse: etat.arrivee.adresse, p_arrivee_lat: etat.arrivee.lat, p_arrivee_lng: etat.arrivee.lng,
    p_arrets: etat.arrets.map((a) => ({ adresse: a.valeur.adresse, lat: a.valeur.lat, lng: a.valeur.lng })),
    p_type: quand.type,
    p_quand: quand.instant ? quand.instant.toISOString() : null,
    p_depart_precision: $('precision').value.trim() || null,
    p_numero_vol: $('bloc-vol').hidden ? null : (vol || null),
    p_terminal: $('bloc-vol').hidden ? null : ($('terminal').value.trim() || null),
    p_pour_proche: pourProche,
    p_beneficiaire_nom: nomProche,
    p_beneficiaire_telephone: telephoneProche,
    p_option_chauffeuse: $('chauffeuse').checked,
    p_mode_paiement: paiement.value,
    p_code_promo: etat.codePromo,
    p_compte_pro: paiement.dataset.compte || null,
    p_prix_annonce: etat.estimation.prix_total
  });

  if (error) {
    bouton.disabled = false;
    bouton.textContent = libelle;
    const message = messageErreur(error, langueActive());
    $('erreur-commande').textContent = message;
    $('erreur-commande').hidden = false;
    // Prix changé entre-temps : on affiche le nouveau prix
    if (/prix a changé/i.test(message)) estimer();
    return;
  }
  // Suivi de la course
  location.replace(lienAvecLangue(`${RACINE}client/course/?id=${data.id}`));
});
