// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client : onglet Compte
// -----------------------------------------------------------------------------
//   - Profil : prénom, nom, téléphone (modifiables ; transmis au chauffeur de
//     chaque course), e-mail de connexion (lecture seule) ;
//   - Mes lieux : domicile et travail (adresse cherchée comme à la commande,
//     précision pour le chauffeur) : raccourcis de l'onglet Accueil ;
//   - Langue : français ou anglais (enregistrée dans le profil, la page se
//     recharge dans la langue choisie) ;
//   - Se déconnecter.
// Une adresse avec ancre (#compte-lieux) amène directement à la section.
// Écritures : profils (prénom, nom, téléphone, langue : droits de la base),
// lieux (les siens).
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { t, langueActive } from '../../commun/i18n.js';
import { el, afficherMessage, telephoneInternational } from '../../commun/outils.js';
import { ChampAdresse } from '../../commun/adresse.js';

const TYPES_LIEUX = ['domicile', 'travail'];
const etat = { contexte: null, profil: null, lieux: [], zones: [], lieuEdite: null, choix: null, champAdresse: null };
const $ = (id) => document.getElementById(id);
const erreurLisible = (e) => messageErreur(e, langueActive());

export async function afficher(conteneur, contexte) {
  etat.contexte = contexte;
  if (!conteneur.dataset.pret) {
    construire(conteneur);
    conteneur.dataset.pret = 'oui';
  }
  fermerProfil();
  fermerLieu();
  await charger();
  const id = decodeURIComponent(location.hash.slice(1));
  const cible = id ? document.getElementById(id) : null;
  if (cible && conteneur.contains(cible)) cible.scrollIntoView({ block: 'start' });
}

// ---------------------------------------------------------------------------
// Structure de l'onglet (une seule fois)
// ---------------------------------------------------------------------------
function construire(conteneur) {
  const champ = (id, libelle, attributs = {}, aide = null) => el('div', { classe: 'champ' },
    el('label', { for: id, texte: libelle }),
    el('input', { id, classe: 'saisie', type: 'text', ...attributs }),
    aide ? el('p', { classe: 'aide', texte: aide }) : null,
    el('p', { classe: 'erreur-champ', id: `${id}-erreur`, hidden: true }));

  // Profil
  const formProfil = el('form', { classe: 'formulaire-client', id: 'compte-formulaire', novalidate: true, hidden: true },
    champ('compte-prenom', t('profil.prenom'), { autocomplete: 'given-name', maxlength: '80', required: true }),
    champ('compte-nom', t('profil.nom'), { autocomplete: 'family-name', maxlength: '80' }),
    champ('compte-telephone', t('profil.telephone'), { type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: '20', required: true },
      t('profil.telephone_aide')),
    el('div', { classe: 'actions-client' },
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'compte-annuler', texte: t('compte.annuler'), onclick: fermerProfil }),
      el('button', { type: 'submit', classe: 'bouton bouton-principal', id: 'compte-enregistrer', texte: t('profil.enregistrer') })));
  formProfil.addEventListener('submit', (e) => { e.preventDefault(); enregistrerProfil(); });
  formProfil.addEventListener('input', (e) => { if (e.target.getAttribute('aria-invalid') === 'true') marquer(e.target.id, null); });

  // Lieu (domicile ou travail) : un seul formulaire, ouvert sous le lieu choisi
  const formLieu = el('form', { classe: 'formulaire-client formulaire-lieu', id: 'lieu-formulaire', novalidate: true, hidden: true,
    'aria-labelledby': 'lieu-formulaire-titre' },
    el('h3', { id: 'lieu-formulaire-titre' }),
    champ('lieu-adresse', t('compte.lieu_adresse'), { autocomplete: 'off', maxlength: '300' }),
    champ('lieu-precision', t('compte.lieu_precision'), { maxlength: '200' }, t('compte.lieu_precision_aide')),
    el('div', { classe: 'actions-client' },
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'lieu-annuler', texte: t('compte.annuler'), onclick: fermerLieu }),
      el('button', { type: 'submit', classe: 'bouton bouton-principal', id: 'lieu-enregistrer', texte: t('profil.enregistrer') })));
  formLieu.addEventListener('submit', (e) => { e.preventDefault(); enregistrerLieu(); });

  // Langue
  const langue = el('fieldset', { classe: 'choix-langue', id: 'compte-langue' },
    el('legend', { classe: 'visuellement-cache', texte: t('compte.langue') }),
    ...[['fr', t('compte.francais')], ['en', t('compte.anglais')]].map(([valeur, libelle]) => el('label', { classe: 'case' },
      el('input', { type: 'radio', name: 'langue', value: valeur, id: `compte-langue-${valeur}` }), el('span', { texte: libelle }))));
  langue.addEventListener('change', (e) => { if (e.target.name === 'langue') changerLangue(e.target.value); });

  const deconnexion = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-large', id: 'compte-deconnexion', texte: t('nav.deconnexion') });
  deconnexion.addEventListener('click', async () => {
    deconnexion.disabled = true;
    try {
      await etat.contexte.deconnecter();
    } catch (erreur) {
      deconnexion.disabled = false;
      afficherMessage(erreurLisible(erreur), 'erreur');
    }
  });

  conteneur.replaceChildren(
    el('h1', { id: 'compte-titre', texte: t('compte.titre') }),
    el('section', { classe: 'bloc-client', id: 'compte-bloc-profil', 'aria-labelledby': 'compte-titre-profil' },
      el('div', { classe: 'entete-bloc' }, el('h2', { id: 'compte-titre-profil', texte: t('compte.profil') }),
        el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'compte-modifier', texte: t('compte.modifier'), onclick: ouvrirProfil })),
      el('dl', { classe: 'lignes-client', id: 'compte-profil' }),
      formProfil,
      el('p', { classe: 'aide-client', texte: t('compte.profil_aide') })),
    el('section', { classe: 'bloc-client', id: 'compte-lieux', 'aria-labelledby': 'compte-titre-lieux' },
      el('h2', { id: 'compte-titre-lieux', texte: t('compte.lieux') }),
      el('p', { classe: 'aide-client', texte: t('compte.lieux_aide') }),
      el('ul', { classe: 'lieux-client', id: 'compte-liste-lieux' }),
      formLieu),
    el('section', { classe: 'bloc-client', id: 'compte-bloc-langue', 'aria-labelledby': 'compte-titre-langue' },
      el('h2', { id: 'compte-titre-langue', texte: t('compte.langue') }),
      el('p', { classe: 'aide-client', texte: t('compte.langue_aide') }),
      langue),
    deconnexion,
    el('p', { classe: 'aide-client', texte: t('compte.deconnexion_aide') }));

  etat.champAdresse = new ChampAdresse({
    champ: $('lieu-adresse'), zones: [],
    onChoix: (valeur) => { etat.choix = valeur; if (valeur) marquer('lieu-adresse', null); }
  });
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------
async function charger() {
  const moi = etat.contexte.profil.id;
  const [profil, lieux] = await Promise.all([
    supabase.from('profils').select('prenom, nom, telephone, email, langue').eq('id', moi).maybeSingle(),
    supabase.from('lieux').select('id, type, libelle, adresse, latitude, longitude, precision').eq('client_id', moi)
  ]);
  for (const r of [profil, lieux]) if (r.error) throw r.error;
  etat.profil = profil.data || {};
  etat.lieux = lieux.data || [];
  afficherProfil();
  afficherLieux();
  const choix = $(`compte-langue-${etat.profil.langue === 'en' ? 'en' : 'fr'}`);
  if (choix) choix.checked = true;
}

function afficherProfil() {
  const p = etat.profil;
  const ligne = (libelle, valeur) => [el('dt', { texte: libelle }), el('dd', { texte: valeur || t('compte.non_renseigne') })];
  $('compte-profil').replaceChildren(
    ...ligne(t('profil.prenom'), p.prenom),
    ...ligne(t('profil.nom'), p.nom),
    ...ligne(t('profil.telephone'), p.telephone),
    ...ligne(t('compte.email'), p.email));
}

function afficherLieux() {
  $('compte-liste-lieux').replaceChildren(...TYPES_LIEUX.map((type) => {
    const lieu = etat.lieux.find((l) => l.type === type);
    const actions = el('div', { classe: 'lieu-actions' },
      el('button', { type: 'button', classe: 'bouton bouton-texte', id: `lieu-${type}-modifier`,
        texte: t(lieu ? 'compte.lieu_modifier' : 'compte.lieu_ajouter'), onclick: () => ouvrirLieu(type) }),
      lieu ? el('button', { type: 'button', classe: 'bouton bouton-texte bouton-retirer', id: `lieu-${type}-retirer`,
        texte: t('compte.lieu_retirer'), onclick: () => retirerLieu(lieu) }) : null);
    return el('li', { classe: 'lieu-client', id: `lieu-${type}`, dataset: { type } },
      el('div', { classe: 'lieu-texte' },
        el('span', { classe: 'lieu-type', texte: t(`client.${type}`) }),
        el('span', { classe: 'lieu-adresse', texte: lieu ? lieu.adresse : t('compte.lieu_non_defini') }),
        lieu && lieu.precision ? el('span', { classe: 'lieu-precision', texte: lieu.precision }) : null),
      actions);
  }));
}

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------
function ouvrirProfil() {
  fermerLieu();
  $('compte-prenom').value = etat.profil.prenom || '';
  $('compte-nom').value = etat.profil.nom || '';
  $('compte-telephone').value = etat.profil.telephone || '';
  for (const id of ['compte-prenom', 'compte-nom', 'compte-telephone']) marquer(id, null);
  $('compte-formulaire').hidden = false;
  $('compte-profil').hidden = true;
  $('compte-modifier').hidden = true;
  $('compte-prenom').focus();
}

function fermerProfil() {
  if (!$('compte-formulaire')) return;
  $('compte-formulaire').hidden = true;
  $('compte-profil').hidden = false;
  $('compte-modifier').hidden = false;
}

async function enregistrerProfil() {
  const prenom = $('compte-prenom').value.trim();
  const nom = $('compte-nom').value.trim();
  const telephone = telephoneInternational($('compte-telephone').value);
  marquer('compte-prenom', prenom ? null : t('profil.prenom_requis'));
  marquer('compte-telephone', telephone ? null : t('profil.telephone_invalide'));
  if (!prenom || !telephone) {
    $(prenom ? 'compte-telephone' : 'compte-prenom').focus();
    return;
  }
  $('compte-enregistrer').disabled = true;
  try {
    const { error } = await supabase.from('profils').update({ prenom, nom: nom || null, telephone }).eq('id', etat.contexte.profil.id);
    if (error) throw error;
    etat.profil = { ...etat.profil, prenom, nom: nom || null, telephone };
    etat.contexte.majProfil({ prenom, nom: nom || null, telephone });
    afficherProfil();
    fermerProfil();
    afficherMessage(t('compte.profil_enregistre'), 'succes');
  } catch (e) {
    afficherMessage(erreurLisible(e), 'erreur');
  } finally {
    $('compte-enregistrer').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Lieux
// ---------------------------------------------------------------------------
function ouvrirLieu(type) {
  fermerProfil();
  const lieu = etat.lieux.find((l) => l.type === type) || null;
  etat.lieuEdite = { type, lieu };
  etat.choix = lieu ? { adresse: lieu.adresse, lat: Number(lieu.latitude), lng: Number(lieu.longitude) } : null;
  if (etat.choix) etat.champAdresse.definir(etat.choix);
  else $('lieu-adresse').value = '';
  $('lieu-precision').value = lieu ? (lieu.precision || '') : '';
  marquer('lieu-adresse', null);
  // Le formulaire reste sous la liste (la liste est redessinée après chaque
  // enregistrement) ; son titre dit quel lieu est modifié
  $('lieu-formulaire-titre').textContent = t(`client.${type}`);
  $('lieu-formulaire').hidden = false;
  $('lieu-adresse').focus();
}

function fermerLieu() {
  if (!$('lieu-formulaire')) return;
  $('lieu-formulaire').hidden = true;
  etat.lieuEdite = null;
}

async function enregistrerLieu() {
  if (!etat.lieuEdite) return;
  if (!etat.choix) {
    marquer('lieu-adresse', t('compte.lieu_choisir'));
    $('lieu-adresse').focus();
    return;
  }
  const { type, lieu } = etat.lieuEdite;
  const valeurs = {
    adresse: etat.choix.adresse.slice(0, 300),
    latitude: Number(etat.choix.lat.toFixed(6)),
    longitude: Number(etat.choix.lng.toFixed(6)),
    precision: $('lieu-precision').value.trim() || null
  };
  $('lieu-enregistrer').disabled = true;
  try {
    const requete = lieu
      ? supabase.from('lieux').update(valeurs).eq('id', lieu.id)
      : supabase.from('lieux').insert({ ...valeurs, client_id: etat.contexte.profil.id, type });
    const { error } = await requete;
    if (error) throw error;
    fermerLieu();
    await charger();
    afficherMessage(t('compte.lieu_enregistre'), 'succes');
  } catch (e) {
    afficherMessage(erreurLisible(e), 'erreur');
  } finally {
    $('lieu-enregistrer').disabled = false;
  }
}

async function retirerLieu(lieu) {
  try {
    const { error } = await supabase.from('lieux').delete().eq('id', lieu.id);
    if (error) throw error;
    fermerLieu();
    await charger();
    afficherMessage(t('compte.lieu_retire'), 'succes');
  } catch (e) {
    afficherMessage(erreurLisible(e), 'erreur');
  }
}

// ---------------------------------------------------------------------------
// Langue
// ---------------------------------------------------------------------------
async function changerLangue(langue) {
  try {
    const { error } = await supabase.from('profils').update({ langue }).eq('id', etat.contexte.profil.id);
    if (error) throw error;
    etat.contexte.majProfil({ langue });
    etat.contexte.changerLangue(langue);
  } catch (e) {
    afficherMessage(erreurLisible(e), 'erreur');
    const actuel = $(`compte-langue-${etat.profil.langue === 'en' ? 'en' : 'fr'}`);
    if (actuel) actuel.checked = true;
  }
}

function marquer(id, texte) {
  const champ = $(id);
  const zone = $(`${id}-erreur`);
  if (!champ || !zone) return;
  if (texte) champ.setAttribute('aria-invalid', 'true');
  else champ.removeAttribute('aria-invalid');
  zone.hidden = !texte;
  zone.textContent = texte || '';
}
