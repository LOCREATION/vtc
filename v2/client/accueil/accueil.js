// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client : onglet Accueil
// -----------------------------------------------------------------------------
//   - « Bonjour Claire » ;
//   - course en cours (recherche, chauffeur en route, arrivé, à bord) : son
//     état et « Suivre ma course » (client/course/) ;
//   - « Où allez-vous ? » : la commande (client/commande/), où se choisissent
//     départ, arrivée, heure et options, avec le prix fixe annoncé ;
//   - raccourcis : domicile et travail (lieux enregistrés dans Compte, sinon
//     « Ajouter… »), aéroports desservis : la commande s'ouvre avec
//     l'arrivée déjà choisie ;
//   - prochaine réservation.
// Lectures : lieux (les siens), zones (aéroports), courses (les siennes).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { t, lienAvecLangue } from '../../commun/i18n.js';
import { el, dateHeure } from '../../commun/outils.js';
import { etatCourse, enCours, aVenir } from '../activite/etats.js';

// Noms courts des aéroports pour les raccourcis (sinon : nom complet de la base)
const NOMS_COURTS = {
  aeroport_cdg: 'Roissy-CDG',
  aeroport_orly: 'Orly',
  aeroport_beauvais: 'Beauvais',
  aeroport_le_bourget: 'Le Bourget'
};

export async function afficher(conteneur, contexte) {
  const moi = contexte.profil.id;
  const [lieux, zones, courses] = await Promise.all([
    supabase.from('lieux').select('id, type, libelle, adresse, latitude, longitude').eq('client_id', moi),
    supabase.from('zones').select('code, nom, type, latitude, longitude').eq('active', true).eq('type', 'aeroport').order('nom'),
    supabase.from('courses').select('id, numero, type, statut, prise_en_charge_le, depart_adresse, arrivee_adresse, chauffeur_prenom')
      .eq('client_id', moi).in('statut', ['planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours'])
      .order('prise_en_charge_le', { ascending: true }).limit(20)
  ]);
  for (const r of [lieux, zones, courses]) if (r.error) throw r.error;

  const actives = courses.data || [];
  const enCoursMaintenant = actives.find(enCours) || null;
  const prochaine = actives.find(aVenir) || null;
  const domicile = (lieux.data || []).find((l) => l.type === 'domicile');
  const travail = (lieux.data || []).find((l) => l.type === 'travail');
  const prenom = (contexte.profil.prenom || '').trim();

  // Les blocs absents (null) sont écartés : replaceChildren(null) écrirait « null »
  conteneur.replaceChildren(...[
    el('h1', { id: 'accueil-client-titre', texte: prenom ? t('client.bonjour', { prenom }) : t('client.bonjour_seul') }),
    enCoursMaintenant ? carteCourse(enCoursMaintenant, 'client.course_en_cours', 'client.suivre', 'accueil-en-cours') : null,
    el('a', { classe: 'ou-allez-vous', id: 'ou-allez-vous', href: lienAvecLangue('commande/') },
      el('span', { classe: 'ou-allez-vous-icone', 'aria-hidden': 'true' }, iconeLoupe()),
      el('span', { texte: t('client.ou_allez_vous') })),
    el('p', { classe: 'aide-client', texte: t('client.ou_allez_vous_aide') }),
    el('section', { classe: 'raccourcis-client', 'aria-labelledby': 'raccourcis-client-titre' },
      el('h2', { id: 'raccourcis-client-titre', texte: t('client.raccourcis') }),
      el('div', { classe: 'raccourcis-client-liste', id: 'raccourcis-client' },
        raccourciLieu(domicile, 'domicile', contexte),
        raccourciLieu(travail, 'travail', contexte),
        ...(zones.data || []).map((z) => raccourci(NOMS_COURTS[z.code] || z.nom, { adresse: z.nom, lat: z.latitude, lng: z.longitude }, 'aeroport')))),
    prochaine ? carteCourse(prochaine, 'client.prochaine', 'client.voir', 'accueil-prochaine') : null,
    el('a', { classe: 'bouton bouton-secondaire bouton-large', id: 'accueil-toutes-courses', href: lienAvecLangue('?onglet=activite'),
      texte: t('client.toutes_courses'), onclick: (e) => { e.preventDefault(); contexte.ouvrirOnglet('activite'); } })].filter(Boolean));
}

// Carte d'une course : état, trajet, heure, lien vers son suivi
function carteCourse(c, titre, action, id) {
  return el('section', { classe: 'bloc-client carte-course-client', id, 'aria-labelledby': `${id}-titre` },
    el('h2', { id: `${id}-titre`, texte: t(titre) }),
    el('p', { classe: 'etat-course-client', dataset: { statut: c.statut }, texte: etatCourse(c) }),
    el('p', { classe: 'trajet-court' }, el('span', { texte: c.depart_adresse }), el('span', { 'aria-hidden': 'true', texte: ' → ' }),
      el('span', { texte: c.arrivee_adresse })),
    c.prise_en_charge_le ? el('p', { classe: 'aide-client', texte: dateHeure(c.prise_en_charge_le, { dateStyle: 'full', timeStyle: 'short' }) }) : null,
    el('a', { classe: 'bouton bouton-principal', href: lienAvecLangue(`course/?id=${encodeURIComponent(c.id)}`), texte: t(action) }));
}

// Raccourci : la commande s'ouvre avec l'arrivée choisie
function raccourci(libelle, point, type) {
  const parametres = new URLSearchParams({ a: point.adresse, alat: String(point.lat), alng: String(point.lng) });
  return el('a', { classe: 'pastille-raccourci', dataset: { type }, href: lienAvecLangue(`commande/?${parametres}`) },
    el('span', { classe: 'pastille-raccourci-libelle', texte: libelle }));
}

// Domicile ou travail : le raccourci, ou « Ajouter… » (onglet Compte, Mes lieux)
function raccourciLieu(lieu, type, contexte) {
  if (lieu) return raccourci(t(`client.${type}`), { adresse: lieu.adresse, lat: lieu.latitude, lng: lieu.longitude }, type);
  const bouton = el('button', { type: 'button', classe: 'pastille-raccourci pastille-ajouter', dataset: { type }, id: `ajouter-${type}` },
    el('span', { classe: 'pastille-raccourci-libelle', texte: t(`client.ajouter_${type}`) }));
  bouton.addEventListener('click', async () => {
    await contexte.ouvrirOnglet('compte');
    const section = document.getElementById('compte-lieux');
    if (section) section.scrollIntoView({ block: 'start' });
  });
  return bouton;
}

function iconeLoupe() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  const cercle = document.createElementNS(ns, 'circle');
  cercle.setAttribute('cx', '11');
  cercle.setAttribute('cy', '11');
  cercle.setAttribute('r', '7');
  const trait = document.createElementNS(ns, 'path');
  trait.setAttribute('d', 'M20 20l-4-4');
  svg.append(cercle, trait);
  return svg;
}
