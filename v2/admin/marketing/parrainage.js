// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : marketing — parrainage
// -----------------------------------------------------------------------------
// Chaque client a un code de parrainage. Un filleul qui le saisit à
// l'inscription est « en attente » ; à sa première course terminée, le
// parrainage est validé et les deux soldes sont crédités des récompenses en
// vigueur (fixées dans Tarifs et zones).
//   - chiffres clés : parrainages, validés, en attente, crédits versés ;
//   - récompenses en vigueur, meilleurs parrains ;
//   - liste filtrable (statut, recherche : nom, e-mail, code) ;
//   - annulation motivée d'un parrainage en attente (abus).
// Lecture : admin_lister_parrainages ; action : admin_annuler_parrainage.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import { tableau, tuile, badge, boutonAction, confirmer, messageErreurAdmin, dateCourte, pluriel } from '../commun/composants.js';
import { ecrireAdresse } from '../commun/listes.js';

const $ = (id) => document.getElementById(id);
const STATUTS = {
  en_attente: { libelle: 'En attente de la première course', ton: 'or' }, valide: { libelle: 'Validé', ton: 'vert' },
  annule: { libelle: 'Annulé', ton: 'gris' }
};
const filtres = { statut: '', texte: '' };

export function afficherParrainage({ parametres }) {
  filtres.statut = STATUTS[parametres.get('statut')] ? parametres.get('statut') : '';
  filtres.texte = (parametres.get('q') || '').slice(0, 100);
  const statut = el('select', { id: 'parrainage-statut', classe: 'saisie' }, el('option', { value: '', texte: 'Tous' }),
    ...Object.entries(STATUTS).map(([valeur, s]) => el('option', { value: valeur, texte: s.libelle })));
  statut.value = filtres.statut;
  statut.addEventListener('change', () => { filtres.statut = statut.value; charger(); });
  const texte = el('input', { id: 'parrainage-texte', classe: 'saisie', type: 'search', autocomplete: 'off', placeholder: 'Nom, e-mail, code' });
  texte.value = filtres.texte;
  const formulaire = el('form', { classe: 'barre-outils', role: 'search' },
    el('div', { classe: 'champ' }, el('label', { for: 'parrainage-statut', texte: 'Statut' }), statut),
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'parrainage-texte', texte: 'Rechercher' }), texte),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Rechercher' }));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); filtres.texte = texte.value.trim(); charger(); });

  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-parrainage', 'aria-live': 'polite' }),
    el('div', { classe: 'grille-2' },
      el('section', { classe: 'carte-admin', id: 'recompenses', 'aria-labelledby': 'titre-recompenses' }),
      el('section', { classe: 'carte-admin', id: 'meilleurs', 'aria-labelledby': 'titre-meilleurs' })),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-parrainages' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-parrainages', texte: 'Parrainages' })),
      formulaire,
      el('p', { classe: 'resume-liste', id: 'resume-parrainages', 'aria-live': 'polite' }),
      el('div', { id: 'liste-parrainages' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))));
  charger();
}

async function charger() {
  ecrireAdresse('parrainage', { statut: filtres.statut, q: filtres.texte });
  const zone = $('liste-parrainages');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_parrainages', { p_statut: filtres.statut || null, p_texte: filtres.texte || null });
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  const n = data.compteurs;
  $('chiffres-parrainage').replaceChildren(
    tuile('Parrainages', String(n.tous), `${n.annules} annulé${Number(n.annules) > 1 ? 's' : ''}`),
    tuile('Validés', String(n.valides), 'filleuls ayant terminé une course'),
    tuile('En attente', String(n.en_attente), 'première course pas encore terminée', Number(n.en_attente) ? 'or' : null),
    tuile('Crédits versés', euros(n.credits), 'aux parrains et aux filleuls'));

  const r = data.recompenses || { parrain: 0, filleul: 0 };
  const actif = Number(r.parrain) > 0 || Number(r.filleul) > 0;
  $('recompenses').replaceChildren(
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-recompenses', texte: 'Récompenses en vigueur' }),
      actif ? badge('Parrainage actif', 'vert') : badge('Parrainage désactivé', 'gris')),
    el('dl', { classe: 'fiche-donnees' },
      el('dt', { texte: 'Parrain' }), el('dd', { texte: `${euros(r.parrain)} crédités sur son solde` }),
      el('dt', { texte: 'Filleul' }), el('dd', { texte: `${euros(r.filleul)} crédités sur son solde` })),
    el('p', { classe: 'aide-module', texte: 'Versées à la première course terminée du filleul, au montant en vigueur ce jour-là. Elles se règlent dans Tarifs et zones, rubrique « Fiscalité et parrainage » (0 € : parrainage désactivé).' }),
    el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin('tarifs/'), texte: 'Régler les récompenses' }));

  $('meilleurs').replaceChildren(
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-meilleurs', texte: 'Meilleurs parrains' })),
    data.meilleurs.length
      ? el('ol', { classe: 'liste-simple' }, ...data.meilleurs.map((m) => el('li', {},
          el('a', { href: lienAdmin(`clients/?id=${m.id}`), texte: m.nom }), ' ', el('span', { classe: 'mono', texte: m.code }),
          ` · ${pluriel(m.filleuls, 'filleul', 'filleuls')}, dont ${pluriel(m.valides, 'validé', 'validés')}`)))
      : el('p', { classe: 'texte-gris', texte: 'Aucun parrainage pour l\'instant.' }));

  $('resume-parrainages').replaceChildren(el('strong', { texte: pluriel(data.lignes.length, 'parrainage', 'parrainages') }));
  zone.replaceChildren(tableau({
    colonnes: [
      { titre: 'Parrain', valeur: (p) => el('span', {}, lienClient(p.parrain), el('span', { classe: 'secondaire mono', texte: p.parrain.code })) },
      { titre: 'Filleul', valeur: (p) => el('span', {}, lienClient(p.filleul),
        el('span', { classe: 'secondaire', texte: `inscrit le ${dateCourte(p.filleul.inscrit_le)} · ${pluriel(p.filleul.courses_terminees, 'course terminée', 'courses terminées')}` })) },
      { titre: 'Statut', valeur: (p) => el('span', {}, badge((STATUTS[p.statut] || { libelle: p.statut }).libelle, (STATUTS[p.statut] || { ton: 'gris' }).ton),
        p.valide_le ? el('span', { classe: 'secondaire', texte: `le ${dateCourte(p.valide_le)}` }) : null) },
      { titre: 'Récompenses', valeur: (p) => (p.statut === 'valide'
        ? `${euros(p.recompense_parrain)} au parrain · ${euros(p.recompense_filleul)} au filleul` : el('span', { classe: 'texte-gris', texte: 'Aucune versée' })) },
      { titre: '', valeur: (p) => (p.statut === 'en_attente' ? boutonAction('Annuler', () => annuler(p), 'bouton-texte') : '') }
    ],
    lignes: data.lignes,
    vide: filtres.texte || filtres.statut ? 'Aucun parrainage ne correspond.' : 'Aucun parrainage pour l\'instant : chaque client a son code dans son espace.'
  }));
}

function lienClient(personne) {
  return el('a', { href: lienAdmin(`clients/?id=${personne.id}`), texte: personne.nom || 'Sans nom' });
}

async function annuler(p) {
  const r = await confirmer({
    titre: `Annuler le parrainage de ${p.filleul.nom} ?`,
    texte: `Parrain : ${p.parrain.nom}. Aucune récompense ne sera versée, même après la première course.`,
    libelle: 'Annuler le parrainage', danger: true,
    motif: { libelle: 'Motif', obligatoire: true, aide: 'Par exemple : même personne, compte créé pour la récompense.' }
  });
  if (!r) return;
  const { error } = await supabase.rpc('admin_annuler_parrainage', { p_parrainage: p.id, p_motif: r.motif });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(`Parrainage de ${p.filleul.nom} annulé.`, 'succes');
  await charger();
}
