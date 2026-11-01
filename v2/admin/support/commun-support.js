// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : support — éléments communs aux vues
// -----------------------------------------------------------------------------
// Libellés (types et statuts des demandes, objets trouvés, devis), pastilles,
// et les deux formulaires appelés depuis plusieurs pages (support et fiche
// d'une course) :
//   - enregistrer une demande pour le compte d'un client ou d'un chauffeur ;
//   - déclarer (ou corriger) un objet trouvé.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el } from '../../commun/outils.js';
import { badge, fenetreFormulaire, jourParis, nomComplet, telephoneLisible, messageErreurAdmin } from '../commun/composants.js';

export const TYPES_DEMANDE = { course: 'Course', paiement: 'Paiement', objet_perdu: 'Objet perdu', compte: 'Compte', autre: 'Autre' };
export const STATUTS_DEMANDE = {
  ouverte: { libelle: 'Ouverte', ton: 'or' }, en_cours: { libelle: 'En cours', ton: 'bleu' },
  resolue: { libelle: 'Résolue', ton: 'vert' }, fermee: { libelle: 'Fermée', ton: 'gris' }
};
export const ROLES = { client: 'Client', chauffeur: 'Chauffeur', admin: 'Administration' };
export const STATUTS_OBJET = {
  trouve: { libelle: 'À rendre · propriétaire à prévenir', ton: 'or' }, signale: { libelle: 'Propriétaire prévenu', ton: 'bleu' },
  rendu: { libelle: 'Rendu', ton: 'vert' }, detruit: { libelle: 'Clos sans restitution', ton: 'gris' }
};
export const SERVICES_DEVIS = {
  longue_distance: 'Transport longue distance', mise_a_disposition: 'Mise à disposition', amo: 'Assistance à maîtrise d\'ouvrage',
  sous_traitance_batiment: 'Sous-traitance bâtiment', jardinage: 'Jardinage', architecture_interieure: 'Architecture intérieure',
  nettoyage: 'Nettoyage', autre: 'Autre'
};
export const STATUTS_DEVIS = {
  nouvelle: { libelle: 'Nouvelle', ton: 'or' }, devis_envoye: { libelle: 'Devis envoyé', ton: 'bleu' },
  acceptee: { libelle: 'Acceptée', ton: 'vert' }, refusee: { libelle: 'Refusée', ton: 'gris' }
};

export function pastille(table, code) {
  const s = table[code] || { libelle: code, ton: 'gris' };
  return badge(s.libelle, s.ton);
}

// Lien « e-mail » prêt à envoyer (objet rempli) ; l'application de messagerie
// de l'appareil s'ouvre
export function lienEmail(adresse, objet) {
  if (!adresse) return null;
  return el('a', { href: `mailto:${adresse}?subject=${encodeURIComponent(objet)}`, texte: adresse });
}

// ---------------------------------------------------------------------------
// Demande enregistrée pour le compte d'un client ou d'un chauffeur
// ---------------------------------------------------------------------------
// auteur : { id, nom } déjà connu (fiche d'une course) ; sinon une recherche
// (nom, e-mail, téléphone) permet de le choisir. course : numéro facultatif.
export function formulaireDemandePourCompte({ auteur = null, course = null } = {}) {
  const choisi = { id: auteur ? auteur.id : null };
  const zoneAuteur = el('div', { classe: 'grille-champs' });
  if (auteur) {
    zoneAuteur.append(el('p', {}, 'Pour : ', el('strong', { texte: auteur.nom })));
  } else {
    // Recherche dans la fenêtre (pas de formulaire imbriqué : Entrée lance la recherche)
    const saisie = el('input', { id: 'recherche-auteur', classe: 'saisie', type: 'search', autocomplete: 'off', placeholder: 'Nom, e-mail ou téléphone' });
    const resultats = el('div', { id: 'resultats-auteur', 'aria-live': 'polite' });
    const chercher = el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Chercher' });
    const lancer = async () => {
      resultats.replaceChildren(el('p', { classe: 'chargement', texte: 'Recherche…' }));
      const { data, error } = await supabase.rpc('admin_rechercher_comptes', { p_texte: saisie.value });
      if (error) { resultats.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
      const comptes = (data || []).filter((c) => c.role === 'client' || c.role === 'chauffeur');
      if (!comptes.length) { resultats.replaceChildren(el('p', { classe: 'vide-admin', texte: 'Aucun client ni chauffeur trouvé.' })); return; }
      resultats.replaceChildren(el('ul', { classe: 'liste-choix' }, ...comptes.map((c) => {
        const nom = nomComplet(c.prenom, c.nom) || c.email || 'Sans nom';
        const bouton = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Choisir' });
        bouton.addEventListener('click', () => {
          choisi.id = c.id;
          resultats.replaceChildren(el('ul', { classe: 'liste-choix' }, el('li', { classe: 'choix' },
            el('div', { classe: 'choix-identite' }, el('strong', { texte: nom }), badge(ROLES[c.role] || c.role, 'gris'), badge('Retenu', 'bleu')),
            el('p', { classe: 'choix-details', texte: [c.email, telephoneLisible(c.telephone)].filter(Boolean).join(' · ') }))));
        });
        return el('li', { classe: 'choix' },
          el('div', { classe: 'choix-identite' }, el('strong', { texte: nom }), badge(ROLES[c.role] || c.role, 'gris'),
            c.statut !== 'actif' ? badge('Compte bloqué', 'rouge') : null),
          el('p', { classe: 'choix-details', texte: [c.email, telephoneLisible(c.telephone)].filter(Boolean).join(' · ') }),
          el('div', { classe: 'choix-action' }, bouton));
      })));
    };
    chercher.addEventListener('click', lancer);
    saisie.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lancer(); } });
    zoneAuteur.append(
      el('div', { classe: 'barre-outils' },
        el('div', { classe: 'champ champ-large' }, el('label', { for: 'recherche-auteur', texte: 'Client ou chauffeur concerné' }), saisie),
        chercher),
      resultats);
  }
  return fenetreFormulaire({
    titre: 'Enregistrer une demande',
    intro: 'Pour une demande reçue par téléphone ou ailleurs : elle rejoint la file, « en cours » et à votre nom. La personne est prévenue dans l\'application.',
    avant: [zoneAuteur],
    champs: [
      { nom: 'type', libelle: 'Type', type: 'choix', requis: true, options: Object.entries(TYPES_DEMANDE).map(([valeur, libelle]) => ({ valeur, libelle })) },
      { nom: 'course', libelle: 'Course concernée (numéro)', type: 'texte', longueur: 20, majuscules: true, placeholder: 'C-2026-000014',
        aide: 'Facultatif. Une course de cette personne (cliente ou chauffeur).' },
      { nom: 'sujet', libelle: 'Sujet', type: 'texte', requis: true, longueur: 200, plein: true },
      { nom: 'message', libelle: 'Ce qui a été dit', type: 'zone', requis: true, longueur: 2000, plein: true,
        aide: 'Première note du fil, écrite au nom de l\'administration (visible par la personne).' }
    ],
    valeurs: { type: 'course', course: course || '' },
    libelle: 'Enregistrer la demande',
    enregistrer: async (v) => {
      if (!choisi.id) throw new Error('Choisissez d\'abord le client ou le chauffeur concerné.');
      const { data, error } = await supabase.rpc('admin_creer_demande', {
        p_auteur: choisi.id, p_type: v.type, p_sujet: v.sujet, p_message: v.message, p_course: v.course || null
      });
      if (error) throw error;
      return data;
    }
  });
}

// ---------------------------------------------------------------------------
// Objet trouvé : déclaration ou correction
// ---------------------------------------------------------------------------
// objet : ligne existante (correction) ; sinon valeurs de départ (course,
// demande rattachée).
export function formulaireObjet({ objet = null, course = null, demande = null, demandes = [] } = {}) {
  const options = demandes.map((d) => ({ valeur: d.id, libelle: `${d.numero} · ${d.sujet}` }));
  if (demande && !options.some((o) => o.valeur === demande.id)) options.push({ valeur: demande.id, libelle: `${demande.numero} · ${demande.sujet || ''}` });
  return fenetreFormulaire({
    titre: objet ? `Objet ${objet.numero}` : 'Déclarer un objet trouvé',
    intro: objet ? null : 'Il reçoit un numéro du registre (OT-…). Prévenez ensuite le client de la course depuis le registre.',
    champs: [
      { nom: 'description', libelle: 'Description', type: 'zone', requis: true, longueur: 1000, plein: true,
        aide: 'Nature, couleur, marque, signe distinctif : de quoi le reconnaître sans erreur.' },
      { nom: 'course', libelle: 'Course (numéro)', type: 'texte', longueur: 20, majuscules: true, placeholder: 'C-2026-000014',
        aide: 'Facultatif : le client de cette course sera prévenu.' },
      { nom: 'trouve_le', libelle: 'Trouvé le', type: 'date', requis: true, max: jourParis() },
      { nom: 'lieu_stockage', libelle: 'Où il est gardé', type: 'texte', longueur: 200, placeholder: 'Bureau, armoire des objets trouvés' },
      ...(options.length ? [{ nom: 'demande', libelle: 'Demande « objet perdu » rattachée', type: 'choix', options, vide: 'Aucune', plein: true }] : [])
    ],
    valeurs: {
      description: objet ? objet.description : '',
      course: objet ? (objet.course ? objet.course.numero : '') : (course || ''),
      trouve_le: objet ? objet.trouve_le : jourParis(),
      lieu_stockage: objet ? objet.lieu_stockage : '',
      demande: objet ? (objet.demande ? objet.demande.id : '') : (demande ? demande.id : '')
    },
    libelle: objet ? 'Enregistrer' : 'Déclarer l\'objet',
    enregistrer: async (v) => {
      const { data, error } = await supabase.rpc('admin_enregistrer_objet', {
        p_objet: objet ? objet.id : null, p_course: v.course || null, p_description: v.description,
        p_lieu_stockage: v.lieu_stockage || null, p_trouve_le: v.trouve_le, p_demande: v.demande || null
      });
      if (error) throw error;
      return data;
    }
  });
}
