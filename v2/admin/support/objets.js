// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : support — objets trouvés
// -----------------------------------------------------------------------------
// Registre des objets trouvés dans les véhicules (OT-2026-000001) :
//   - en cours (à rendre : propriétaire à prévenir, ou prévenu), clos (rendu,
//     ou clos sans restitution), tous ; recherche (numéro, description, lieu,
//     course, client), gardée dans l'adresse ;
//   - déclaration rattachée à une course (par son numéro) et, s'il y en a
//     une, à la demande « objet perdu » du client ;
//   - « Prévenir le client » : avis dans l'application (et réponse dans le
//     fil de sa demande) ; « Rendu » ou « Clos sans restitution » : comment,
//     ou pourquoi, est obligatoire ; « Rouvrir » pour corriger ;
//   - les demandes « objet perdu » encore sans objet rattaché sont listées
//     à côté, pour faire le rapprochement ;
//   - suppression d'une erreur de saisie (gardée au journal).
// Lecture : admin_lister_objets ; actions : admin_enregistrer_objet,
// admin_statut_objet ; suppression directe dans la table (administration).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  tableau, boutonAction, confirmer, messageErreurAdmin, dateCourte, jourHeure, lienTelephone, pluriel
} from '../commun/composants.js';
import { ecrireAdresse } from '../commun/listes.js';
import { STATUTS_OBJET, pastille, formulaireObjet } from './commun-support.js';

const $ = (id) => document.getElementById(id);
const VUES = [
  { code: 'en_cours', libelle: 'En cours' },
  { code: 'clos', libelle: 'Clos' },
  { code: 'tous', libelle: 'Tous' }
];
const filtres = { vue: 'en_cours', texte: '' };
const etat = { donnees: null };

export function afficherObjets({ parametres }) {
  filtres.vue = VUES.some((v) => v.code === parametres.get('liste')) ? parametres.get('liste') : 'en_cours';
  filtres.texte = (parametres.get('q') || '').slice(0, 100);
  // Recherche d'un numéro précis (lien depuis un fil) : dans tout le registre
  if (filtres.texte && !parametres.get('liste')) filtres.vue = 'tous';

  const declarer = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Déclarer un objet trouvé' });
  declarer.addEventListener('click', async () => {
    const fait = await formulaireObjet({ demandes: etat.donnees ? etat.donnees.demandes_objet_perdu : [] });
    if (fait) { afficherMessage(`Objet ${fait.numero} enregistré au registre.`, 'succes'); await charger(); }
  });
  $('entete-actions').replaceChildren(declarer);

  const texte = el('input', { id: 'objets-texte', classe: 'saisie', type: 'search', autocomplete: 'off', placeholder: 'Numéro, description, lieu, course, client' });
  texte.value = filtres.texte;
  const formulaire = el('form', { classe: 'barre-outils', role: 'search' },
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'objets-texte', texte: 'Rechercher' }), texte),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Rechercher' }),
    el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'Effacer', onclick: () => { texte.value = ''; filtres.texte = ''; charger(); } }));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); filtres.texte = texte.value.trim(); charger(); });

  $('contenu').replaceChildren(
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-objets' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-objets', texte: 'Registre des objets trouvés' })),
      el('p', { classe: 'aide-module', texte: 'Chaque objet trouvé dans un véhicule reçoit un numéro. Rattachez-le à la course : son client est prévenu dans l\'application d\'un clic. Notez ensuite comment il a été rendu, ou pourquoi il ne l\'a pas été.' }),
      el('div', { classe: 'sous-onglets', role: 'tablist', 'aria-label': 'Objets', id: 'vues-objets' }),
      formulaire,
      el('p', { classe: 'resume-liste', id: 'resume-objets', 'aria-live': 'polite' }),
      el('div', { id: 'liste-objets' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))),
    el('section', { classe: 'carte-admin', id: 'demandes-objets', 'aria-labelledby': 'titre-demandes-objets' }));
  charger();
}

async function charger() {
  ecrireAdresse('objets', { liste: filtres.vue === 'en_cours' ? '' : filtres.vue, q: filtres.texte });
  const zone = $('liste-objets');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_objets', { p_vue: filtres.vue, p_texte: filtres.texte || null });
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.donnees = data;
  const n = data.compteurs;
  $('vues-objets').replaceChildren(...VUES.map((v) => {
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(v.code === filtres.vue) },
      el('span', { texte: v.libelle }), n[v.code] ? el('span', { classe: 'compte', texte: String(n[v.code]) }) : null);
    b.addEventListener('click', () => { if (v.code !== filtres.vue) { filtres.vue = v.code; charger(); } });
    return b;
  }));
  $('resume-objets').replaceChildren(...[
    el('strong', { texte: pluriel(data.lignes.length, 'objet', 'objets') }),
    n.a_prevenir ? el('span', { classe: 'texte-or', texte: `${n.a_prevenir} dont le propriétaire n'est pas encore prévenu` }) : null].filter(Boolean));
  zone.replaceChildren(tableau({
    colonnes: [
      { titre: 'Objet', valeur: (o) => el('span', {}, el('strong', { texte: o.numero }), el('span', { classe: 'secondaire', texte: o.description })) },
      { titre: 'Course', valeur: (o) => (o.course
        ? el('span', {}, el('a', { href: lienAdmin(`courses/?id=${o.course.id}`), texte: o.course.numero }),
            el('span', { classe: 'secondaire', texte: [o.course.client, o.course.date_course ? dateCourte(o.course.date_course) : null].filter(Boolean).join(' · ') }),
            o.course.client_telephone ? el('span', { classe: 'secondaire' }, lienTelephone(o.course.client_telephone)) : null)
        : el('span', { classe: 'texte-gris', texte: 'Course inconnue' })) },
      { titre: 'Trouvé le', valeur: (o) => el('span', {}, dateCourte(o.trouve_le), o.lieu_stockage ? el('span', { classe: 'secondaire', texte: o.lieu_stockage }) : null) },
      { titre: 'Statut', valeur: (o) => el('span', {}, pastille(STATUTS_OBJET, o.statut),
        o.client_prevenu_le ? el('span', { classe: 'secondaire', texte: `Prévenu le ${jourHeure(o.client_prevenu_le)}` }) : null,
        o.restitution ? el('span', { classe: 'secondaire', texte: o.restitution }) : null,
        o.demande ? el('a', { classe: 'secondaire', href: lienAdmin(`support/?demande=${o.demande.id}`), texte: `Demande ${o.demande.numero}` }) : null) },
      { titre: 'Actions', valeur: (o) => actionsObjet(o) }
    ],
    lignes: data.lignes,
    vide: filtres.texte ? 'Aucun objet ne correspond à la recherche.'
      : { en_cours: 'Aucun objet en attente de restitution.', clos: 'Aucun objet clos.', tous: 'Le registre est vide.' }[filtres.vue]
  }));
  dessinerDemandes(data.demandes_objet_perdu);
}

function actionsObjet(o) {
  const actions = el('div', { classe: 'actions-ligne' });
  if (o.statut === 'trouve') {
    const prevenir = boutonAction('Prévenir le client', () => statut(o, 'signale', null), 'bouton-principal');
    if (!o.course && !o.demande) { prevenir.disabled = true; prevenir.title = 'Rattachez la course ou la demande pour prévenir son client.'; }
    actions.append(prevenir);
  }
  if (o.statut === 'trouve' || o.statut === 'signale') {
    actions.append(
      boutonAction('Rendu', async () => {
        const r = await confirmer({ titre: `Objet ${o.numero} rendu`, texte: o.description, libelle: 'Enregistrer',
          motif: { libelle: 'Comment il a été rendu', obligatoire: true, aide: 'En main propre, par envoi, à qui, quand.' } });
        if (r) await statut(o, 'rendu', r.motif);
      }),
      boutonAction('Clos sans restitution', async () => {
        const r = await confirmer({ titre: `Clore ${o.numero} sans restitution ?`, texte: o.description, libelle: 'Clore', danger: true,
          motif: { libelle: 'Pourquoi, et quand', obligatoire: true, aide: 'Remis au service des objets trouvés de la mairie, détruit (denrée périssable)…' } });
        if (r) await statut(o, 'detruit', r.motif);
      }, 'bouton-danger'));
  } else {
    actions.append(boutonAction('Rouvrir', () => statut(o, 'trouve', null)));
  }
  actions.append(
    boutonAction('Modifier', async () => {
      const fait = await formulaireObjet({ objet: o, demandes: etat.donnees.demandes_objet_perdu });
      if (fait) { afficherMessage(`Objet ${o.numero} corrigé.`, 'succes'); await charger(); }
    }),
    boutonAction('Supprimer', async () => {
      const r = await confirmer({ titre: `Supprimer ${o.numero} ?`, texte: 'Seulement pour une erreur de saisie : la suppression est gardée au journal.', libelle: 'Supprimer', danger: true });
      if (!r) return;
      const { error } = await supabase.from('objets_trouves').delete().eq('id', o.id);
      if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
      afficherMessage(`Objet ${o.numero} supprimé.`, 'succes');
      await charger();
    }, 'bouton-texte'));
  return actions;
}

async function statut(o, nouveau, restitution) {
  const { error } = await supabase.rpc('admin_statut_objet', { p_objet: o.id, p_statut: nouveau, p_restitution: restitution });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage({
    signale: `Le client est prévenu : ${o.numero} l'attend.`, rendu: `${o.numero} est rendu.`,
    detruit: `${o.numero} est clos sans restitution.`, trouve: `${o.numero} est rouvert.`
  }[nouveau], 'succes');
  await charger();
}

function dessinerDemandes(demandes) {
  const zone = $('demandes-objets');
  zone.replaceChildren(
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-demandes-objets', texte: 'Objets perdus signalés' }),
      el('span', { classe: 'sous-titre', texte: 'Demandes ouvertes, sans objet rattaché' })),
    demandes.length
      ? el('ul', { classe: 'liste-simple' }, ...demandes.map((d) => el('li', {},
          el('a', { href: lienAdmin(`support/?demande=${d.id}`), texte: d.numero }), ` · ${d.sujet} · ${d.auteur}`,
          d.course ? ` · course ${d.course.numero}` : '', ` · ${dateCourte(d.cree_le)} `,
          boutonAction('Objet retrouvé', async () => {
            const fait = await formulaireObjet({ course: d.course ? d.course.numero : '', demande: d, demandes });
            if (fait) { afficherMessage(`Objet ${fait.numero} enregistré et rattaché à ${d.numero}.`, 'succes'); await charger(); }
          }))))
      : el('p', { classe: 'texte-gris', texte: 'Aucun objet perdu en attente : chaque signalement a son objet, ou a été traité.' }));
}
