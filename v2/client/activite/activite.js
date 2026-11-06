// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client : onglet Activité
// -----------------------------------------------------------------------------
//   - En cours : la course qui se déroule (recherche, chauffeur en route,
//     arrivé, à bord) ;
//   - À venir : les réservations ;
//   - Historique : courses terminées et annulées, regroupées par jour
//     (« Aujourd'hui », « Hier », « lundi 3 novembre 2026 »).
// Chaque course ouvre son suivi (client/course/) : carte, chauffeur, facture,
// note, « Commander à nouveau ».
// Lecture : courses (les siennes, règles d'accès de la base), 200 au plus.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { t, lienAvecLangue } from '../../commun/i18n.js';
import { el, euros, dateHeure } from '../../commun/outils.js';
import { enCours, aVenir, terminee, etatCourse } from './etats.js';

const COLONNES = 'id, numero, type, statut, prise_en_charge_le, cree_le, terminee_le, annulee_le, '
  + 'depart_adresse, arrivee_adresse, prix_total, frais_annulation, chauffeur_prenom';

export async function afficher(conteneur, contexte) {
  const { data, error } = await supabase.from('courses').select(COLONNES)
    .eq('client_id', contexte.profil.id).order('prise_en_charge_le', { ascending: false }).limit(200);
  if (error) throw error;
  const courses = data || [];
  const parDate = (a, b) => instant(a) - instant(b);
  const enCoursListe = courses.filter(enCours).sort(parDate);
  const aVenirListe = courses.filter(aVenir).sort(parDate);
  const historique = courses.filter(terminee).sort((a, b) => parDate(b, a));

  const vide = !courses.length;
  // Les blocs absents (null) sont écartés : replaceChildren(null) écrirait « null »
  conteneur.replaceChildren(...[
    el('h1', { id: 'activite-titre', texte: t('activite.titre') }),
    vide ? el('div', { classe: 'bloc-client', id: 'activite-vide' },
      el('p', { classe: 'aide-client', texte: t('activite.vide') }),
      el('a', { classe: 'bouton bouton-principal', href: lienAvecLangue('commande/'), texte: t('activite.commander') })) : null,
    enCoursListe.length ? section('activite-en-cours', t('activite.en_cours'), [liste(enCoursListe, true)]) : null,
    aVenirListe.length ? section('activite-a-venir', t('activite.a_venir'), [liste(aVenirListe, true)]) : null,
    historique.length ? section('activite-historique', t('activite.historique'), parJour(historique)) : null].filter(Boolean));
}

// Moment qui range une course : fin, annulation, sinon prise en charge prévue
function instant(c) {
  return new Date(c.terminee_le || c.annulee_le || c.prise_en_charge_le || c.cree_le).getTime();
}

function section(id, titre, contenu) {
  return el('section', { classe: 'activite-section', id, 'aria-labelledby': `${id}-titre` },
    el('h2', { id: `${id}-titre`, texte: titre }),
    ...contenu);
}

function liste(courses, avecDate) {
  return el('ul', { classe: 'activite-liste' }, ...courses.map((c) => el('li', {}, carte(c, avecDate))));
}

// Historique regroupé par jour
function parJour(courses) {
  const blocs = [];
  let jourCourant = null;
  let groupe = null;
  for (const c of courses) {
    const jour = dateHeure(instant(c), { year: 'numeric', month: '2-digit', day: '2-digit' });
    if (jour !== jourCourant) {
      jourCourant = jour;
      groupe = el('ul', { classe: 'activite-liste' });
      blocs.push(el('h3', { classe: 'activite-jour', texte: libelleJour(instant(c)) }), groupe);
    }
    groupe.append(el('li', {}, carte(c, false)));
  }
  return blocs;
}

function libelleJour(moment) {
  const jour = (d) => dateHeure(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const maintenant = new Date();
  if (jour(moment) === jour(maintenant)) return t('activite.aujourdhui');
  if (jour(moment) === jour(new Date(maintenant.getTime() - 86400000))) return t('activite.hier');
  const texte = dateHeure(moment, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

// Une course : l'heure (avec la date si elle n'est pas dans l'historique),
// l'état, le trajet, le prix ou les frais, le chauffeur ; toute la carte
// ouvre le suivi de la course
function carte(c, avecDate) {
  const moment = c.statut === 'terminee' || c.statut === 'annulee' ? instant(c) : (c.prise_en_charge_le || c.cree_le);
  const quand = avecDate
    ? dateHeure(moment, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : dateHeure(moment, { hour: '2-digit', minute: '2-digit' });
  const montant = c.statut === 'annulee'
    ? (Number(c.frais_annulation) > 0 ? t('activite.frais', { montant: euros(c.frais_annulation) }) : null)
    : (c.prix_total !== null && c.prix_total !== undefined ? euros(c.prix_total) : null);
  const infos = [montant, c.chauffeur_prenom ? t('activite.avec', { prenom: c.chauffeur_prenom }) : null].filter(Boolean).join(' · ');
  const lien = el('a', { classe: 'course-client', href: lienAvecLangue(`course/?id=${encodeURIComponent(c.id)}`),
    dataset: { statut: c.statut, id: c.id }, 'aria-label': `${t('activite.course', { numero: c.numero })}, ${etatCourse(c)}` },
    el('span', { classe: 'course-client-entete' },
      el('span', { classe: 'course-client-heure', texte: quand }),
      el('span', { classe: 'course-client-etat', dataset: { statut: c.statut }, texte: etatCourse(c) })),
    el('span', { classe: 'course-client-trajet' },
      el('span', { texte: c.depart_adresse }), el('span', { classe: 'fleche', 'aria-hidden': 'true', texte: ' → ' }),
      el('span', { texte: c.arrivee_adresse })),
    infos ? el('span', { classe: 'course-client-infos', texte: infos }) : null);
  return lien;
}
