// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : RH et paie — temps de travail
// -----------------------------------------------------------------------------
// Heures travaillées, jour par jour, des semaines (du lundi au dimanche) qui
// touchent le mois choisi :
//   - à côté de chaque jour : les heures de courses de l'application (de
//     l'acceptation à la fin de chaque course, à titre indicatif : l'attente
//     entre deux courses est du temps de travail), les absences validées et
//     les jours fériés ;
//   - chaque semaine : total et heures majorées (temps plein : 25 % de la
//     36e à la 43e heure, 50 % au-delà ; temps partiel : heures
//     complémentaires à 10 % dans la limite du dixième du contrat) ; une
//     semaine est payée avec le mois de son dimanche, et se fige quand ce
//     bulletin est validé ;
//   - les heures majorées des semaines payées ce mois-ci sont proposées à la
//     préparation du bulletin.
// Lectures et actions : admin_lister_salaries, admin_temps_travail,
// admin_enregistrer_temps.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import { tuile, badge, messageErreurAdmin, dateCourte } from '../commun/composants.js';
import { TYPES_ABSENCE, decimal, heures, debutMois, moisEnLettres, choixMois } from './commun-rh.js';

const $ = (id) => document.getElementById(id);
const JOURS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
const filtres = { salarie: '', mois: debutMois() };
const etat = { donnees: null, saisies: new Map() };

function lireNombre(saisie) {
  const brut = String(saisie.value || '').replace(/[\s  ]/g, '').replace(',', '.');
  if (brut === '') return 0;
  return /^\d+(\.\d+)?$/.test(brut) ? Number(brut) : NaN;
}

export async function afficherTemps({ parametres }) {
  filtres.salarie = parametres.get('salarie') || filtres.salarie;
  const mois = parametres.get('mois');
  if (mois && /^\d{4}-\d{2}-01$/.test(mois)) filtres.mois = mois;
  $('contenu').replaceChildren(el('p', { classe: 'chargement', texte: 'Chargement…' }));
  const { data, error } = await supabase.rpc('admin_lister_salaries');
  if (error) { $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  const salaries = data.lignes;
  if (!salaries.length) {
    $('contenu').replaceChildren(el('section', { classe: 'carte-admin' }, el('p', { texte: 'Aucun salarié : créez d\'abord sa fiche dans l\'onglet « Salariés ».' })));
    return;
  }
  if (!salaries.some((s) => s.id === filtres.salarie)) filtres.salarie = (salaries.find((s) => s.statut === 'en_poste') || salaries[0]).id;

  const choixSalarie = el('select', { id: 'temps-salarie', classe: 'saisie' },
    ...salaries.map((s) => el('option', { value: s.id, texte: `${s.nom}${s.statut === 'sorti' ? ' (sorti)' : ''}` })));
  choixSalarie.value = filtres.salarie;
  choixSalarie.addEventListener('change', () => { filtres.salarie = choixSalarie.value; charger(); });
  const formulaire = el('form', { classe: 'barre-outils' },
    el('div', { classe: 'champ' }, el('label', { for: 'temps-salarie', texte: 'Salarié' }), choixSalarie),
    el('div', { classe: 'champ' }, el('label', { for: 'temps-mois', texte: 'Mois' }),
      choixMois({ id: 'temps-mois', valeur: filtres.mois, changer: (m) => { filtres.mois = m; charger(); } })));
  formulaire.addEventListener('submit', (e) => e.preventDefault());
  const enregistrer = el('button', { type: 'button', classe: 'bouton bouton-principal', id: 'temps-enregistrer', texte: 'Enregistrer les heures', disabled: true });
  enregistrer.addEventListener('click', sauver);

  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-temps', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-temps' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-temps', texte: 'Heures travaillées' }), el('span', { classe: 'sous-titre', id: 'mois-temps' })),
      el('p', { classe: 'aide-module', texte: 'Saisissez les heures réellement travaillées (0 pour un jour non travaillé). Les heures de courses de l\'application sont indicatives : l\'attente entre deux courses et les trajets à vide sont aussi du temps de travail. Une semaine est payée avec le mois de son dimanche.' }),
      formulaire,
      el('div', { id: 'semaines', classe: 'semaines' }, el('p', { classe: 'chargement', texte: 'Chargement…' })),
      el('div', { classe: 'actions-ligne' }, enregistrer, el('a', { id: 'temps-preparer', classe: 'bouton bouton-secondaire', href: '#', texte: 'Préparer le bulletin' }))));
  charger();
}

async function charger() {
  history.replaceState(null, '', `${location.pathname}?vue=temps&salarie=${filtres.salarie}&mois=${filtres.mois}`);
  const zone = $('semaines');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_temps_travail', { p_salarie: filtres.salarie, p_mois: filtres.mois });
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.donnees = data;
  etat.saisies = new Map();
  const s = data.salarie;
  const partiel = s.temps === 'partiel';
  $('mois-temps').textContent = `${moisEnLettres(filtres.mois)} · ${partiel ? `temps partiel, ${decimal(s.heures_hebdo, 0, 2)} h par semaine` : 'temps plein, 35 h par semaine'}`;
  $('temps-preparer').href = lienAdmin(`rh/?preparer=${s.id}&periode=${filtres.mois}`);
  const payees = data.payees_ce_mois;
  const total = (cle) => payees.reduce((n, w) => n + Number(w[cle] || 0), 0);
  $('chiffres-temps').replaceChildren(
    tuile('Heures des semaines payées ce mois-ci', heures(total('heures')), `${payees.length} semaine${payees.length > 1 ? 's' : ''} (dimanche en ${moisEnLettres(filtres.mois)})`),
    partiel
      ? tuile('Complémentaires à 10 %', heures(total('comp_10')), 'dans la limite du dixième du contrat')
      : tuile('Supplémentaires à 25 %', heures(total('sup_25')), 'de la 36e à la 43e heure'),
    partiel
      ? tuile('Complémentaires à 25 %', heures(total('comp_25')), 'au-delà du dixième (si un accord le permet)', total('comp_25') > 0 ? 'or' : null)
      : tuile('Supplémentaires à 50 %', heures(total('sup_50')), 'au-delà de la 43e heure', total('sup_50') > 0 ? 'or' : null));
  zone.replaceChildren(...data.semaines.map((w) => semaine(w, partiel)));
  majBouton();
}

function semaine(w, partiel) {
  const majorees = partiel
    ? `${heures(w.comp_10)} à 10 %${Number(w.comp_25) ? `, ${heures(w.comp_25)} à 25 %` : ''}`
    : `${heures(w.sup_25)} à 25 %${Number(w.sup_50) ? `, ${heures(w.sup_50)} à 50 %` : ''}`;
  const totalNoeud = el('strong', { texte: heures(w.total) });
  const jours = w.jours.map((j, i) => {
    const id = `temps-${j.jour}`;
    const desactive = w.verrouille || !j.sous_contrat;
    const saisie = el('input', { id, classe: 'saisie saisie-heures', type: 'text', inputmode: 'decimal', autocomplete: 'off',
      value: j.heures === null ? '' : decimal(j.heures, 0, 2), disabled: desactive, 'aria-label': `Heures du ${dateCourte(j.jour)}` });
    if (!desactive) {
      saisie.addEventListener('input', () => {
        etat.saisies.set(j.jour, saisie);
        const valeurs = w.jours.map((x) => (etat.saisies.has(x.jour) ? lireNombre(etat.saisies.get(x.jour)) : Number(x.heures || 0)));
        totalNoeud.textContent = valeurs.some(Number.isNaN) ? 'saisie à corriger' : heures(valeurs.reduce((n, x) => n + x, 0));
        majBouton();
      });
    }
    const [, m, d] = j.jour.split('-');
    return el('div', { classe: `jour-temps${j.ferie ? ' jour-ferie' : ''}${j.absence ? ' jour-absence' : ''}` },
      el('label', { for: id, texte: `${JOURS[i]} ${Number(d)}/${m}` }),
      saisie,
      Number(j.courses) ? el('span', { classe: 'jour-note', texte: `courses ${decimal(j.courses, 0, 2)} h` }) : null,
      j.absence ? el('span', { classe: 'jour-note', texte: TYPES_ABSENCE[j.absence].libelle }) : null,
      j.ferie ? el('span', { classe: 'jour-note', texte: j.ferie }) : null,
      !j.sous_contrat ? el('span', { classe: 'jour-note', texte: 'hors contrat' }) : null);
  });
  return el('section', { classe: 'semaine', 'aria-label': `Semaine du ${dateCourte(w.lundi)}` },
    el('div', { classe: 'semaine-entete' },
      el('strong', { texte: `Du ${dateCourte(w.lundi)} au ${dateCourte(w.dimanche)}` }),
      el('span', { classe: 'texte-gris', texte: `payée en ${moisEnLettres(w.paye_en)}` }),
      w.verrouille ? badge('Bulletin validé : figée', 'gris') : null),
    el('div', { classe: 'jours-temps' }, ...jours),
    el('p', { classe: 'semaine-total' }, 'Total : ', totalNoeud, ` · majorées : ${majorees}`));
}

function majBouton() {
  const bouton = $('temps-enregistrer');
  if (bouton) bouton.disabled = etat.saisies.size === 0;
}

async function sauver() {
  const jours = [];
  for (const [jour, saisie] of etat.saisies) {
    const valeur = lireNombre(saisie);
    if (Number.isNaN(valeur) || valeur > 24) {
      afficherMessage(`Heures du ${dateCourte(jour)} : nombre entre 0 et 24 (exemple : 7,5).`, 'erreur');
      saisie.focus();
      return;
    }
    jours.push({ jour, heures: valeur });
  }
  if (!jours.length) return;
  const bouton = $('temps-enregistrer');
  bouton.disabled = true;
  const { error } = await supabase.rpc('admin_enregistrer_temps', { p_salarie: filtres.salarie, p_jours: jours });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); bouton.disabled = false; return; }
  afficherMessage(`${jours.length} jour${jours.length > 1 ? 's' : ''} enregistré${jours.length > 1 ? 's' : ''}.`, 'succes');
  charger();
}
