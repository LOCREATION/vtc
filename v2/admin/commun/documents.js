// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : éléments communs des documents imprimables
// -----------------------------------------------------------------------------
// Relevé mensuel d'une entreprise, facture, avoir : même en-tête à l'identité
// exacte de l'entreprise (lue dans Paramètres, Entreprise), même cadre du
// destinataire, mêmes totaux, même barre d'outils (jamais imprimée). Les
// mentions qui manquent dans Paramètres sont signalées à l'écran seulement.
// Mise en page (écran et A4) : document.css. Aucun texte n'est injecté comme
// du HTML (tout passe par « el »).
// =============================================================================
import { el } from '../../commun/outils.js';
import { RACINE } from '../../commun/config.js';
import { lienAdmin } from './admin.js';
import { siretLisible, telephoneLisible } from './composants.js';

// Lignes d'identité sous la raison sociale : forme et capital, adresse,
// RCS et SIRET, TVA et APE, registre des exploitants VTC, contact.
export function identiteSociete(s) {
  const capital = s.capital !== null && s.capital !== undefined
    ? `au capital de ${new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(s.capital)}` : null;
  return [
    [s.forme_juridique, capital].filter(Boolean).join(' '),
    s.adresse,
    [s.code_postal, s.ville].filter(Boolean).join(' '),
    [s.rcs, s.siret ? `SIRET ${siretLisible(s.siret)}` : null].filter(Boolean).join(' · '),
    [s.tva_intracommunautaire ? `TVA intracommunautaire ${s.tva_intracommunautaire}` : null,
      s.code_ape ? `APE ${s.code_ape}` : null].filter(Boolean).join(' · '),
    s.registre_vtc_numero ? `Registre des exploitants VTC n° ${s.registre_vtc_numero}` : null,
    [s.telephone ? telephoneLisible(s.telephone) : null, s.email].filter(Boolean).join(' · ')
  ].filter(Boolean);
}

// En-tête : émetteur à gauche ; titre, sous-titre, mention forte (en rouge)
// et dates à droite. dates : [[libellé, valeur], …]
export function enteteDocument({ societe, titre, sousTitre = null, mention = null, dates = [] }) {
  const s = societe || {};
  return el('header', { classe: 'doc-entete' },
    el('div', { classe: 'doc-emetteur' },
      el('img', { src: `${RACINE}commun/img/logo.svg`, alt: '', width: '72', height: '36', classe: 'doc-logo' }),
      el('strong', { classe: 'doc-raison', texte: s.raison_sociale || 'LOC RÉACTION S.A.S' }),
      ...identiteSociete(s).map((l) => el('span', { texte: l }))),
    el('div', { classe: 'doc-titre' },
      el('h2', { texte: titre }),
      sousTitre ? el('p', { classe: 'doc-sous-titre', texte: sousTitre }) : null,
      mention ? el('p', { classe: 'doc-mention', texte: mention }) : null,
      dates.length ? el('dl', {}, ...dates.flatMap(([dt, dd]) => [el('dt', { texte: dt }), el('dd', { texte: dd })])) : null));
}

// Cadre du destinataire
export function blocDestinataire({ etiquette = 'Client', nom, lignes = [] }) {
  return el('section', { classe: 'doc-client', 'aria-label': etiquette },
    el('span', { classe: 'doc-etiquette', texte: etiquette }),
    el('strong', { texte: nom }),
    ...lignes.filter(Boolean).map((l) => el('span', { texte: l })));
}

// Coordonnées d'une entreprise cliente : adresse, SIRET, TVA, contact
export function lignesCompte(c) {
  if (!c) return [];
  return [
    c.adresse,
    [c.code_postal, c.ville].filter(Boolean).join(' '),
    c.siret ? `SIRET ${siretLisible(c.siret)}` : null,
    c.tva_intracommunautaire ? `TVA intracommunautaire ${c.tva_intracommunautaire}` : null,
    c.contact_nom ? `À l'attention de ${c.contact_nom}` : null
  ].filter(Boolean);
}

// Barre d'outils du document (jamais imprimée) : imprimer, puis les autres boutons
export function barreDocument(...autres) {
  const imprimer = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Imprimer ou enregistrer en PDF' });
  imprimer.addEventListener('click', () => window.print());
  return el('div', { classe: 'actions-ligne non-imprimable barre-document' }, imprimer, ...autres.filter(Boolean));
}

// Mentions manquantes dans Paramètres : signalées à l'écran, jamais imprimées
export function avertissementMentions(manquants) {
  if (!manquants.length) return null;
  return el('p', { classe: 'alerte non-imprimable' },
    `À compléter dans Paramètres, Entreprise, pour qu'ils figurent sur le document : ${manquants.join(', ')}. `,
    el('a', { href: lienAdmin('parametres/'), texte: 'Ouvrir les paramètres' }));
}

// Tableau qui défile dans son cadre sur téléphone (la page, elle, ne défile pas)
export function tableauDefilant(table) {
  return [
    el('p', { classe: 'doc-glisser non-imprimable', texte: 'Faites glisser le tableau vers la gauche pour voir les montants.' }),
    el('div', { classe: 'doc-defilement' }, table)
  ];
}

// En-tête de tableau ; « droite » : indices des colonnes de montants
export function enteteTableau(titres, droite = []) {
  return el('thead', {}, el('tr', {}, ...titres.map((t, i) => el('th', { scope: 'col', classe: droite.includes(i) ? 'droite' : null, texte: t }))));
}

// Totaux alignés à droite. lignes : [libellé, valeur] ; [libellé, valeur, true]
// pour le total final (en gras) ; 'trait' pour un filet.
export function blocTotaux(lignes, libelle = 'Totaux') {
  return el('section', { classe: 'doc-totaux', 'aria-label': libelle },
    el('dl', {}, ...lignes.filter(Boolean).flatMap((l) => (l === 'trait'
      ? [el('div', { classe: 'doc-trait', 'aria-hidden': 'true' })]
      : [el('dt', { classe: l[2] ? 'doc-total-fort' : null, texte: l[0] }), el('dd', { classe: l[2] ? 'doc-total-fort' : null, texte: l[1] })]))));
}
