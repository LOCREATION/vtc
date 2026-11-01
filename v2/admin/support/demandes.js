// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : support — file des demandes
// -----------------------------------------------------------------------------
// Demandes des clients et des chauffeurs, liées ou non à une course :
//   - files : à traiter, attribuées à moi, non attribuées, clôturées, toutes ;
//     dans les files ouvertes, la personne qui attend une réponse passe en
//     tête, de la plus ancienne à la plus récente ;
//   - filtres : type, recherche (numéro, sujet, nom, e-mail, téléphone saisi
//     avec ou sans espaces, numéro de course), gardés dans l'adresse ;
//   - une ligne ouvre le fil de la demande (fil.js) ;
//   - « Enregistrer une demande » : reçue par téléphone ou ailleurs.
// Lecture : admin_lister_demandes ; création : admin_creer_demande.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el } from '../../commun/outils.js';
import { lienAdmin, compteurMenu } from '../commun/admin.js';
import { tableau, badge, messageErreurAdmin, depuis, jourHeure, pluriel } from '../commun/composants.js';
import { ecrireAdresse, lirePage, pagination } from '../commun/listes.js';
import { TYPES_DEMANDE, STATUTS_DEMANDE, ROLES, pastille, formulaireDemandePourCompte } from './commun-support.js';

const $ = (id) => document.getElementById(id);
const PAR_PAGE = 50;
const FILES = [
  { code: 'a_traiter', libelle: 'À traiter' },
  { code: 'a_moi', libelle: 'Attribuées à moi' },
  { code: 'non_attribuees', libelle: 'Non attribuées' },
  { code: 'cloturees', libelle: 'Clôturées' },
  { code: 'toutes', libelle: 'Toutes' }
];
const filtres = { file: 'a_traiter', type: '', texte: '', page: 0 };

export function afficherDemandes({ parametres }) {
  filtres.file = FILES.some((f) => f.code === parametres.get('file')) ? parametres.get('file') : 'a_traiter';
  filtres.type = TYPES_DEMANDE[parametres.get('type')] ? parametres.get('type') : '';
  filtres.texte = (parametres.get('q') || '').slice(0, 100);
  filtres.page = lirePage(parametres);

  const nouvelle = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Enregistrer une demande' });
  nouvelle.addEventListener('click', async () => {
    const creee = await formulaireDemandePourCompte();
    if (creee) location.href = lienAdmin(`support/?demande=${creee.id}`);
  });
  $('entete-actions').replaceChildren(nouvelle);

  $('contenu').replaceChildren(
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-demandes' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-demandes', texte: 'Demandes au support' })),
      el('p', { classe: 'aide-module', texte: 'Les clients et les chauffeurs écrivent depuis l\'application, au sujet d\'une course ou non. Répondez dans le fil : la personne est prévenue dans l\'application. Celle qui attend une réponse passe en tête de file.' }),
      el('div', { classe: 'sous-onglets', role: 'tablist', 'aria-label': 'Files de demandes', id: 'files-demandes' }),
      el('form', { classe: 'barre-outils', id: 'filtres-demandes', role: 'search' }),
      el('p', { classe: 'resume-liste', id: 'resume-demandes', 'aria-live': 'polite' }),
      el('div', { id: 'liste-demandes' }, el('p', { classe: 'chargement', texte: 'Chargement…' })),
      el('div', { classe: 'pagination', id: 'pagination-demandes' })));
  dessinerFiltres();
  charger();
}

function dessinerFiltres() {
  const formulaire = $('filtres-demandes');
  const type = el('select', { id: 'demandes-type', classe: 'saisie' }, el('option', { value: '', texte: 'Tous' }),
    ...Object.entries(TYPES_DEMANDE).map(([valeur, texte]) => el('option', { value: valeur, texte })));
  type.value = filtres.type;
  const texte = el('input', { id: 'demandes-texte', classe: 'saisie', type: 'search', autocomplete: 'off',
    placeholder: 'Numéro, sujet, nom, téléphone, course' });
  texte.value = filtres.texte;
  const effacer = el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'Effacer' });
  formulaire.replaceChildren(
    el('div', { classe: 'champ' }, el('label', { for: 'demandes-type', texte: 'Type' }), type),
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'demandes-texte', texte: 'Rechercher' }), texte),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Rechercher' }),
    effacer);
  formulaire.onsubmit = (e) => { e.preventDefault(); filtres.texte = texte.value.trim(); filtres.page = 0; charger(); };
  type.addEventListener('change', () => { filtres.type = type.value; filtres.page = 0; charger(); });
  effacer.addEventListener('click', () => { Object.assign(filtres, { type: '', texte: '', page: 0 }); dessinerFiltres(); charger(); });
}

async function charger() {
  ecrireAdresse('demandes', { file: filtres.file === 'a_traiter' ? '' : filtres.file, type: filtres.type, q: filtres.texte, page: filtres.page });
  const zone = $('liste-demandes');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_demandes', {
    p_vue: filtres.file, p_type: filtres.type || null, p_texte: filtres.texte || null,
    p_limite: PAR_PAGE, p_decalage: filtres.page * PAR_PAGE
  });
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  dessinerFiles(data.compteurs);
  compteurMenu('support', data.compteurs.a_traiter);
  const attente = data.lignes.filter((l) => l.attente).length;
  $('resume-demandes').replaceChildren(...[
    el('strong', { texte: pluriel(data.total, 'demande', 'demandes') }),
    attente ? el('span', { classe: 'texte-or', texte: `${attente} attend${attente > 1 ? 'ent' : ''} une réponse sur cette page` }) : null].filter(Boolean));
  zone.replaceChildren(tableau({
    colonnes: [
      { titre: 'Demande', valeur: (d) => el('span', {}, el('a', { href: lienAdmin(`support/?demande=${d.id}`), texte: d.numero }),
        el('span', { classe: 'secondaire', texte: d.sujet })) },
      { titre: 'De', valeur: (d) => el('span', {}, d.auteur.nom, el('span', { classe: 'secondaire', texte: ROLES[d.auteur.role] || d.auteur.role })) },
      { titre: 'Type', valeur: (d) => el('span', {}, TYPES_DEMANDE[d.type] || d.type,
        d.course ? el('a', { classe: 'secondaire', href: lienAdmin(`courses/?id=${d.course.id}`), texte: d.course.numero }) : null) },
      { titre: 'Statut', valeur: (d) => el('span', { classe: 'pastilles' }, pastille(STATUTS_DEMANDE, d.statut),
        d.attente ? badge('Attend une réponse', 'rouge') : null,
        d.non_lus ? badge(pluriel(d.non_lus, 'message non lu', 'messages non lus'), 'or') : null) },
      { titre: 'Chargé(e)', valeur: (d) => (d.assignee ? d.assignee.nom : el('span', { classe: 'texte-gris', texte: 'Personne' })) },
      { titre: 'Dernier message', valeur: (d) => (d.dernier_le ? el('span', { title: jourHeure(d.dernier_le), texte: depuis(d.dernier_le) }) : '') }
    ],
    lignes: data.lignes,
    vide: filtres.texte || filtres.type ? 'Aucune demande ne correspond à la recherche.' : videFile(),
    clicLigne: (d) => { location.href = lienAdmin(`support/?demande=${d.id}`); },
    libelleLigne: (d) => `Ouvrir la demande ${d.numero}`
  }));
  pagination($('pagination-demandes'), { total: data.total, page: filtres.page, parPage: PAR_PAGE, aller: (p) => { filtres.page = p; charger(); } });
}

function videFile() {
  return {
    a_traiter: 'Aucune demande à traiter : tout le monde a sa réponse.',
    a_moi: 'Aucune demande ouverte ne vous est attribuée.',
    non_attribuees: 'Toutes les demandes ouvertes ont une personne chargée.',
    cloturees: 'Aucune demande clôturée.',
    toutes: 'Aucune demande pour l\'instant.'
  }[filtres.file];
}

function dessinerFiles(compteurs) {
  $('files-demandes').replaceChildren(...FILES.map((f) => {
    const n = compteurs[f.code];
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(f.code === filtres.file) },
      el('span', { texte: f.libelle }), n ? el('span', { classe: 'compte', texte: String(n) }) : null);
    b.addEventListener('click', () => {
      if (f.code === filtres.file) return;
      filtres.file = f.code;
      filtres.page = 0;
      charger();
    });
    return b;
  }));
}
