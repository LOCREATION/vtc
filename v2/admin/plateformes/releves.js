// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : plateformes — relevés
// -----------------------------------------------------------------------------
// Relevés des plateformes de réservation (Bolt, Uber, Heetch), chauffeur par
// chauffeur, sur une période (un relevé compte dans la période où il se
// termine) :
//   - chiffres clés : trajets, frais de service et leur taux, net, montants
//     virés et espèces collectées par les chauffeurs ;
//   - saisie et correction d'un relevé tel qu'imprimé par la plateforme : le
//     net et le montant viré sont recalculés en direct pendant la saisie,
//     pour comparer avec ceux du relevé ;
//   - PDF du relevé, rangé dans le dossier privé « administration » ;
//   - suppression d'un relevé saisi par erreur (gardée au journal) ;
//   - export CSV pour l'expert-comptable.
// Lectures et actions : admin_lister_releves, admin_enregistrer_releve,
// admin_fichier_releve ; suppression directe dans la table (administration).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, afficherMessage } from '../../commun/outils.js';
import {
  tableau, tuile, badge, boutonAction, boutonExporter, exporterCsv, fenetreFormulaire, confirmer,
  messageErreurAdmin, ouvrirPiece, dateCourte, jourParis, ajouterJours, pluriel
} from '../commun/composants.js';
import { champsPeriode, bornes, periodeValable, periodeLisible, periodeCourte } from '../commun/periode.js';
import { ecrireAdresse, lireDate, nomFichier } from '../commun/listes.js';
import { PLATEFORMES, COLONNES_RELEVES, relevesChronologiques } from '../commun/releves-plateformes.js';

const $ = (id) => document.getElementById(id);
const TONS = { bolt: 'vert', uber: 'gris', heetch: 'or', autre: 'bleu' };
const FORMATS = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const filtres = { du: '', au: '', chauffeur: '', plateforme: '' };
const etat = { donnees: null };

export function badgePlateforme(code) {
  return badge(PLATEFORMES[code] || code, TONS[code] || 'gris');
}

export function afficherReleves({ parametres }) {
  const defaut = bornes('trimestre');
  filtres.du = lireDate(parametres, 'du') || defaut.du;
  filtres.au = lireDate(parametres, 'au') || defaut.au;
  if (!periodeValable(filtres.du, filtres.au)) Object.assign(filtres, defaut);
  filtres.chauffeur = parametres.get('chauffeur') || '';
  filtres.plateforme = PLATEFORMES[parametres.get('plateforme')] ? parametres.get('plateforme') : '';

  const ajouter = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Ajouter un relevé' });
  ajouter.addEventListener('click', () => formulaireReleve(null));
  $('entete-actions').replaceChildren(ajouter, boutonExporter(exporter));

  const choixChauffeur = el('select', { id: 'releves-chauffeur', classe: 'saisie' }, el('option', { value: '', texte: 'Tous' }));
  const choixPlateforme = el('select', { id: 'releves-plateforme', classe: 'saisie' },
    el('option', { value: '', texte: 'Toutes' }),
    ...Object.entries(PLATEFORMES).map(([valeur, texte]) => el('option', { value: valeur, texte })));
  choixPlateforme.value = filtres.plateforme;
  choixChauffeur.addEventListener('change', () => { filtres.chauffeur = choixChauffeur.value; charger(); });
  choixPlateforme.addEventListener('change', () => { filtres.plateforme = choixPlateforme.value; charger(); });
  const formulaire = el('form', { classe: 'barre-outils' },
    ...champsPeriode({ prefixe: 'releves', du: filtres.du, au: filtres.au, changer: ({ du, au }) => { filtres.du = du; filtres.au = au; charger(); } }),
    el('div', { classe: 'champ' }, el('label', { for: 'releves-chauffeur', texte: 'Chauffeur' }), choixChauffeur),
    el('div', { classe: 'champ' }, el('label', { for: 'releves-plateforme', texte: 'Plateforme' }), choixPlateforme));
  formulaire.addEventListener('submit', (e) => e.preventDefault());

  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-releves', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-releves' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-releves', texte: 'Relevés des plateformes' }),
        el('span', { classe: 'sous-titre', id: 'periode-releves' })),
      el('p', { classe: 'aide-module', texte: 'Saisissez chaque relevé tel que la plateforme l\'imprime, un par chauffeur et par semaine (ou par mois). Le net et le montant viré se recalculent pendant la saisie : comparez-les à ceux du relevé pour repérer une faute de frappe. Un relevé compte dans la période où il se termine.' }),
      formulaire,
      el('p', { classe: 'resume-liste', id: 'resume-releves' }),
      el('div', { id: 'liste-releves' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))));
  charger();
}

async function charger() {
  ecrireAdresse('releves', { du: filtres.du, au: filtres.au, chauffeur: filtres.chauffeur, plateforme: filtres.plateforme });
  const zone = $('liste-releves');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_releves', {
    p_debut: filtres.du, p_fin: filtres.au, p_chauffeur: filtres.chauffeur || null, p_plateforme: filtres.plateforme || null
  });
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.donnees = data;

  // Liste des chauffeurs du filtre (le choix courant est conservé)
  const choix = $('releves-chauffeur');
  choix.replaceChildren(el('option', { value: '', texte: 'Tous' }),
    ...data.chauffeurs.map((c) => el('option', { value: c.id, texte: c.nom + (c.statut === 'suspendu' ? ' (suspendu)' : '') })));
  choix.value = data.chauffeurs.some((c) => c.id === filtres.chauffeur) ? filtres.chauffeur : '';

  const t = data.totaux;
  const periode = periodeCourte(filtres.du, filtres.au);
  $('chiffres-releves').replaceChildren(
    tuile('Trajets', euros(t.trajets), `${pluriel(data.total, 'relevé', 'relevés')} · ${pluriel(t.nb_courses, 'course', 'courses')} · ${periode}`),
    tuile('Frais de service', euros(t.frais), t.taux_frais !== null ? `${nombre(t.taux_frais, 1)} % des trajets` : 'aucun trajet', Number(t.frais) > 0 ? 'or' : null),
    tuile('Net', euros(t.net), 'après frais, pourboires et ajustements'),
    tuile('Viré par les plateformes', euros(t.virement), Number(t.especes) > 0 ? `${euros(t.especes)} d'espèces gardées par les chauffeurs` : 'aucune espèce collectée'));
  $('periode-releves').textContent = `Période : ${periodeLisible(filtres.du, filtres.au)}`;
  $('resume-releves').replaceChildren(...(data.par_plateforme.length
    ? data.par_plateforme.flatMap((p, i) => [i ? ' · ' : '', el('strong', { texte: PLATEFORMES[p.plateforme] }),
      ` ${euros(p.trajets)} de trajets, frais ${p.taux_frais !== null ? `${nombre(p.taux_frais, 1)} %` : '—'}`])
    : []));

  zone.replaceChildren(tableau({
    colonnes: [
      { titre: 'Période', valeur: (r) => el('span', {}, el('strong', { texte: `${dateCourte(r.debut)} au ${dateCourte(r.fin)}` }),
        el('span', { classe: 'secondaire' }, badgePlateforme(r.plateforme), r.reference ? ` ${r.reference}` : '')) },
      { titre: 'Chauffeur', valeur: (r) => el('span', {}, r.chauffeur_nom,
        el('span', { classe: 'secondaire', texte: r.nb_courses !== null ? pluriel(r.nb_courses, 'course', 'courses') : 'courses non indiquées' })) },
      { titre: 'Trajets', droite: true, valeur: (r) => el('span', {}, euros(r.montant_trajets),
        el('span', { classe: 'secondaire', texte: `frais ${euros(r.frais_service)}${r.taux_frais !== null ? ` (${nombre(r.taux_frais, 1)} %)` : ''}` })) },
      { titre: 'Net', droite: true, valeur: (r) => el('span', {}, el('strong', { texte: euros(r.montant_net) }),
        detailNet(r) ? el('span', { classe: 'secondaire', texte: detailNet(r) }) : null) },
      { titre: 'Viré', droite: true, valeur: (r) => el('span', { classe: Number(r.virement) < 0 ? 'texte-rouge' : null }, euros(r.virement),
        Number(r.especes) > 0 ? el('span', { classe: 'secondaire', texte: `espèces ${euros(r.especes)}` }) : null) },
      { titre: 'Relevé PDF', valeur: (r) => (r.fichier_chemin
        ? el('span', { classe: 'actions-ligne' }, boutonAction('Voir', () => voirPdf(r)), boutonAction('Remplacer', () => joindrePdf(r)))
        : boutonAction('Joindre', () => joindrePdf(r))) },
      { titre: '', valeur: (r) => el('span', { classe: 'actions-ligne' },
        boutonAction('Corriger', () => formulaireReleve(r)),
        boutonAction('Supprimer', () => supprimer(r), 'bouton-danger')) }
    ],
    lignes: data.lignes,
    vide: filtres.chauffeur || filtres.plateforme
      ? 'Aucun relevé ne correspond à ces filtres sur cette période.'
      : 'Aucun relevé sur cette période. Ajoutez-en un avec le bouton « Ajouter un relevé ».'
  }));
}

// « pourboires 12,00 € · ajustements +25,00 € » (seulement ce qui existe)
function detailNet(r) {
  const parties = [];
  if (Number(r.pourboires)) parties.push(`pourboires ${euros(r.pourboires)}`);
  if (Number(r.ajustements)) parties.push(`ajustements ${Number(r.ajustements) > 0 ? '+' : ''}${euros(r.ajustements)}`);
  return parties.join(' · ');
}

// Lundi et dimanche de la semaine dernière (jours de Paris)
function semaineDerniere() {
  const aujourdhui = jourParis();
  const jour = new Date(`${aujourdhui}T12:00:00Z`).getUTCDay();             // 0 = dimanche
  const lundi = ajouterJours(aujourdhui, -((jour + 6) % 7));
  return { debut: ajouterJours(lundi, -7), fin: ajouterJours(lundi, -1) };
}

// Nombre lu dans un champ de saisie (virgule ou point), 0 si vide ou invalide
function lireNombre(saisie) {
  const v = Number(String(saisie.value || '').replace(/[\s  ]/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// Saisie et correction
// ---------------------------------------------------------------------------
async function formulaireReleve(r) {
  const chauffeurs = (etat.donnees && etat.donnees.chauffeurs) || [];
  if (!chauffeurs.length) { afficherMessage('Aucun chauffeur validé : validez d\'abord un chauffeur dans le module Chauffeurs.', 'erreur'); return; }
  const semaine = semaineDerniere();
  const valeurs = r
    ? { plateforme: r.plateforme, chauffeur: r.chauffeur_id, debut: r.debut, fin: r.fin, nb_courses: r.nb_courses,
        trajets: r.montant_trajets, frais: r.frais_service, pourboires: r.pourboires, ajustements: r.ajustements,
        especes: r.especes, reference: r.reference, note: r.note }
    : { plateforme: filtres.plateforme || 'bolt', chauffeur: filtres.chauffeur || (chauffeurs.length === 1 ? chauffeurs[0].id : ''),
        debut: semaine.debut, fin: semaine.fin };
  const apercu = el('p', { classe: 'apercu-calcul', 'aria-live': 'polite' });
  const fichier = el('input', { id: 'releve-fichier', classe: 'saisie', type: 'file', accept: '.pdf,image/jpeg,image/png,image/webp' });
  const blocFichier = el('div', { classe: 'champ' },
    el('label', { for: 'releve-fichier', texte: r && r.fichier_chemin ? 'Remplacer le PDF du relevé (facultatif)' : 'PDF du relevé (facultatif, 20 Mo au plus)' }),
    fichier);
  let alerteFichier = null;

  const fait = await fenetreFormulaire({
    titre: r ? `Corriger le relevé du ${dateCourte(r.debut)} au ${dateCourte(r.fin)}` : 'Ajouter un relevé',
    intro: 'Recopiez les montants du relevé de la plateforme. Les ajustements regroupent bonus, compensations et péages (montant négatif pour une retenue).',
    large: true,
    champs: [
      { nom: 'plateforme', libelle: 'Plateforme', type: 'choix', requis: true, options: Object.entries(PLATEFORMES).map(([valeur, libelle]) => ({ valeur, libelle })) },
      { nom: 'chauffeur', libelle: 'Chauffeur', type: 'choix', requis: true, vide: 'Choisir…',
        options: chauffeurs.map((c) => ({ valeur: c.id, libelle: c.nom })) },
      { nom: 'debut', libelle: 'Du', type: 'date', requis: true },
      { nom: 'fin', libelle: 'Au', type: 'date', requis: true },
      { nom: 'trajets', libelle: 'Montant des trajets (TTC)', type: 'nombre', requis: true, min: 0,
        aide: 'Payé par les passagers, frais d\'annulation compris, hors pourboires.' },
      { nom: 'frais', libelle: 'Frais de service de la plateforme', type: 'nombre', requis: true, min: 0 },
      { nom: 'pourboires', libelle: 'Pourboires', type: 'nombre', min: 0 },
      { nom: 'ajustements', libelle: 'Ajustements (+ ou −)', type: 'nombre' },
      { nom: 'especes', libelle: 'Espèces collectées par le chauffeur', type: 'nombre', min: 0,
        aide: 'Déjà déduites du virement de la plateforme : le chauffeur doit les remettre au bureau.' },
      { nom: 'nb_courses', libelle: 'Nombre de courses', type: 'nombre', min: 0, pas: '1' },
      { nom: 'reference', libelle: 'Référence du relevé', type: 'texte', longueur: 80 },
      { nom: 'note', libelle: 'Note', type: 'zone', longueur: 500, plein: true }
    ],
    valeurs,
    apres: [apercu, blocFichier],
    libelle: r ? 'Enregistrer' : 'Ajouter le relevé',
    preparer: (elements) => {
      // Net et montant viré recalculés à chaque frappe
      const calculer = () => {
        const trajets = lireNombre(elements.trajets.saisie);
        const frais = lireNombre(elements.frais.saisie);
        const net = trajets - frais + lireNombre(elements.pourboires.saisie) + lireNombre(elements.ajustements.saisie);
        const vire = net - lireNombre(elements.especes.saisie);
        apercu.replaceChildren('Net calculé : ', el('strong', { texte: euros(net) }), ' · viré : ', el('strong', { texte: euros(vire) }),
          trajets > 0 ? ` · frais ${nombre(100 * frais / trajets, 1)} % des trajets` : '');
      };
      ['trajets', 'frais', 'pourboires', 'ajustements', 'especes'].forEach((nom) => elements[nom].saisie.addEventListener('input', calculer));
      calculer();
    },
    enregistrer: async (lues) => {
      const choisi = fichier.files[0] || null;
      if (choisi && choisi.size > 20 * 1024 * 1024) throw new Error('Fichier trop lourd : 20 Mo au plus.');
      if (choisi && choisi.type && !FORMATS.includes(choisi.type)) throw new Error('Format refusé : PDF, JPEG, PNG ou WebP.');
      const { data, error } = await supabase.rpc('admin_enregistrer_releve', {
        p_releve: r ? r.id : null, p_plateforme: lues.plateforme, p_chauffeur: lues.chauffeur, p_debut: lues.debut, p_fin: lues.fin,
        p_nb_courses: lues.nb_courses === null ? null : Math.round(lues.nb_courses),
        p_trajets: lues.trajets, p_frais: lues.frais, p_pourboires: lues.pourboires ?? 0, p_ajustements: lues.ajustements ?? 0,
        p_especes: lues.especes ?? 0, p_reference: lues.reference, p_note: lues.note
      });
      if (error) throw error;
      // Le relevé est enregistré : un échec du dépôt du PDF ne doit pas le
      // faire saisir une seconde fois (il est signalé après la fermeture)
      if (choisi) {
        try { await deposerPdf(data, choisi); }
        catch (probleme) { alerteFichier = `Relevé enregistré, mais le PDF n'a pas pu être joint : ${messageErreurAdmin(probleme)} Réessayez avec « Joindre ».`; }
      }
    }
  });
  if (!fait) return;
  if (alerteFichier) afficherMessage(alerteFichier, 'erreur');
  else afficherMessage(r ? 'Relevé corrigé.' : 'Relevé ajouté.', 'succes');
  await charger();
}

// ---------------------------------------------------------------------------
// PDF du relevé (dossier privé « administration », sous releves/{relevé}/)
// ---------------------------------------------------------------------------
async function deposerPdf(releve, choisi) {
  const extension = (choisi.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'pdf';
  const chemin = `releves/${releve.id}/${nomFichier(releve.plateforme, releve.debut, releve.fin)}-${Date.now()}.${extension}`;
  const envoi = await supabase.storage.from('administration').upload(chemin, choisi, { contentType: choisi.type || undefined, upsert: false });
  if (envoi.error) throw envoi.error;
  const { data: ancien, error } = await supabase.rpc('admin_fichier_releve', { p_releve: releve.id, p_chemin: chemin });
  if (error) throw error;
  if (ancien) await supabase.storage.from('administration').remove([ancien]);
}

async function joindrePdf(r) {
  const fichier = el('input', { id: 'releve-pdf', classe: 'saisie', type: 'file', accept: '.pdf,image/jpeg,image/png,image/webp', required: true });
  const fait = await fenetreFormulaire({
    titre: `PDF du relevé ${PLATEFORMES[r.plateforme]} de ${r.chauffeur_nom}`,
    intro: `Du ${dateCourte(r.debut)} au ${dateCourte(r.fin)}. Le fichier est rangé dans le dossier privé de l'administration${r.fichier_chemin ? ' et remplace le précédent' : ''}.`,
    champs: [],
    avant: [el('div', { classe: 'champ' }, el('label', { for: 'releve-pdf', texte: 'Fichier (PDF ou photo, 20 Mo au plus)' }), fichier)],
    libelle: 'Joindre',
    enregistrer: async () => {
      const choisi = fichier.files[0];
      if (!choisi) throw new Error('Choisissez le fichier du relevé.');
      if (choisi.size > 20 * 1024 * 1024) throw new Error('Fichier trop lourd : 20 Mo au plus.');
      if (choisi.type && !FORMATS.includes(choisi.type)) throw new Error('Format refusé : PDF, JPEG, PNG ou WebP.');
      await deposerPdf(r, choisi);
    }
  });
  if (fait) { afficherMessage('PDF du relevé joint.', 'succes'); await charger(); }
}

async function voirPdf(r) {
  try { await ouvrirPiece('administration', r.fichier_chemin); }
  catch (erreur) { afficherMessage(messageErreurAdmin(erreur), 'erreur'); }
}

// ---------------------------------------------------------------------------
// Suppression d'un relevé saisi par erreur
// ---------------------------------------------------------------------------
async function supprimer(r) {
  const ok = await confirmer({
    titre: 'Supprimer ce relevé ?',
    texte: `Relevé ${PLATEFORMES[r.plateforme]} de ${r.chauffeur_nom}, du ${dateCourte(r.debut)} au ${dateCourte(r.fin)} : ${euros(r.montant_trajets)} de trajets. Il reste lisible dans le journal des modifications${r.fichier_chemin ? ' ; son PDF est retiré du dossier' : ''}.`,
    libelle: 'Supprimer', danger: true
  });
  if (!ok) return;
  // Suppression directe : la règle d'accès de la table la réserve à
  // l'administration, et le journal des modifications garde le relevé complet
  const { error } = await supabase.from('releves_plateformes').delete().eq('id', r.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  if (r.fichier_chemin) await supabase.storage.from('administration').remove([r.fichier_chemin]);
  afficherMessage('Relevé supprimé.', 'succes');
  await charger();
}

// ---------------------------------------------------------------------------
// Export pour l'expert-comptable (colonnes communes avec le dossier de Finances)
// ---------------------------------------------------------------------------
function exporter() {
  if (!etat.donnees || !etat.donnees.lignes.length) { afficherMessage('Aucun relevé à exporter sur cette période.'); return; }
  exporterCsv(`${nomFichier('releves-plateformes', filtres.du, filtres.au)}.csv`, COLONNES_RELEVES, relevesChronologiques(etat.donnees.lignes));
}
