// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : marketing — codes promo
// -----------------------------------------------------------------------------
// Le client saisit un code à la commande ; la remise s'applique au prix
// annoncé (après majoration et option chauffeuse).
//   - chiffres clés : codes actifs, utilisations, remises accordées ;
//   - liste : remise, validité (dates de Paris, bornes comprises), plafonds,
//     utilisations, remises accordées, chiffre d'affaires des courses
//     terminées, statut (actif, à venir, expiré, épuisé, désactivé) ;
//   - création, modification, activation, désactivation ; utilisations d'un
//     code (client, course, remise) ; suppression d'un code jamais utilisé.
// Lectures et actions : admin_lister_codes_promo, admin_enregistrer_code_promo,
// admin_activer_code_promo, admin_utilisations_code ; suppression directe.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  tableau, tuile, badge, boutonAction, fenetreFormulaire, confirmer, ouvrirFenetre, messageErreurAdmin, dateCourte,
  jourParis, ajouterJours, pluriel, badgeCourse, jourHeure
} from '../commun/composants.js';

const $ = (id) => document.getElementById(id);
const STATUTS = {
  actif: { libelle: 'Actif', ton: 'vert' }, a_venir: { libelle: 'À venir', ton: 'bleu' }, expire: { libelle: 'Expiré', ton: 'gris' },
  epuise: { libelle: 'Épuisé', ton: 'or' }, desactive: { libelle: 'Désactivé', ton: 'gris' }
};

export function afficherCodes() {
  const nouveau = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Nouveau code promo' });
  nouveau.addEventListener('click', () => formulaireCode(null));
  $('entete-actions').replaceChildren(nouveau);
  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-codes', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-codes' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-codes', texte: 'Codes promo' })),
      el('p', { classe: 'aide-module', texte: 'Le client saisit le code à la commande : la remise s\'applique au prix annoncé. Une course annulée sans frais rend l\'utilisation. Un code qui a déjà servi ne se supprime pas : désactivez-le.' }),
      el('div', { id: 'liste-codes' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))));
  charger();
}

async function charger() {
  const zone = $('liste-codes');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_codes_promo');
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  const actifs = data.lignes.filter((c) => c.statut === 'actif').length;
  $('chiffres-codes').replaceChildren(
    tuile('Codes actifs', String(actifs), `${pluriel(data.lignes.length, 'code', 'codes')} en tout`),
    tuile('Utilisations', String(data.totaux.utilisations), pluriel(data.totaux.clients, 'client', 'clients')),
    tuile('Remises accordées', euros(data.totaux.remises), 'sur les courses commandées avec un code'));
  zone.replaceChildren(tableau({
    colonnes: [
      { titre: 'Code', valeur: (c) => el('span', {}, el('strong', { classe: 'mono', texte: c.code }), c.libelle ? el('span', { classe: 'secondaire', texte: c.libelle }) : null) },
      { titre: 'Remise', valeur: (c) => el('span', {}, remise(c),
        Number(c.minimum_course) > 0 ? el('span', { classe: 'secondaire', texte: `dès ${euros(c.minimum_course)}` }) : null) },
      { titre: 'Validité', valeur: (c) => validite(c) },
      { titre: 'Utilisations', valeur: (c) => el('span', {}, c.utilisations_max ? `${c.utilisations} / ${c.utilisations_max}` : String(c.utilisations),
        el('span', { classe: 'secondaire', texte: `${pluriel(c.utilisations_par_client, 'fois', 'fois')} par client` })) },
      { titre: 'Remises', droite: true, valeur: (c) => euros(c.remises) },
      { titre: 'Courses terminées', droite: true, valeur: (c) => el('span', {}, String(c.courses_terminees),
        Number(c.chiffre_affaires) > 0 ? el('span', { classe: 'secondaire', texte: euros(c.chiffre_affaires) }) : null) },
      { titre: 'Statut', valeur: (c) => { const s = STATUTS[c.statut] || { libelle: c.statut, ton: 'gris' }; return badge(s.libelle, s.ton); } },
      { titre: 'Actions', valeur: (c) => actions(c) }
    ],
    lignes: data.lignes,
    vide: 'Aucun code promo : créez le premier (par exemple BIENVENUE10, 10 % sur la première course).'
  }));
}

function remise(c) {
  return c.type === 'pourcentage' ? `− ${nombre(c.valeur, 2).replace(/,00$/, '')} %` : `− ${euros(c.valeur)}`;
}

// Dates de Paris : la fin est enregistrée au début du jour suivant (exclue)
function dateDebut(c) { return c.debut ? jourParis(new Date(c.debut)) : ''; }
function dateFin(c) { return c.fin ? ajouterJours(jourParis(new Date(c.fin)), -1) : ''; }

function validite(c) {
  const du = dateDebut(c);
  const au = dateFin(c);
  if (!du && !au) return 'Sans limite';
  if (du && au) return `du ${dateCourte(du)} au ${dateCourte(au)}`;
  return du ? `à partir du ${dateCourte(du)}` : `jusqu'au ${dateCourte(au)}`;
}

function actions(c) {
  const liste = el('div', { classe: 'actions-ligne' },
    boutonAction('Modifier', () => formulaireCode(c)),
    boutonAction(c.actif ? 'Désactiver' : 'Activer', async () => {
      const { error } = await supabase.rpc('admin_activer_code_promo', { p_code: c.id, p_actif: !c.actif });
      if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
      afficherMessage(c.actif ? `Code ${c.code} désactivé : il n'est plus accepté à la commande.` : `Code ${c.code} activé.`, 'succes');
      await charger();
    }));
  if (c.utilisations > 0) {
    liste.append(boutonAction('Utilisations', () => utilisations(c)));
  } else {
    liste.append(boutonAction('Supprimer', async () => {
      const r = await confirmer({ titre: `Supprimer le code ${c.code} ?`, texte: 'Il n\'a jamais servi. La suppression est gardée au journal.', libelle: 'Supprimer', danger: true });
      if (!r) return;
      const { error } = await supabase.from('codes_promo').delete().eq('id', c.id);
      if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
      afficherMessage(`Code ${c.code} supprimé.`, 'succes');
      await charger();
    }, 'bouton-texte'));
  }
  return liste;
}

async function formulaireCode(c) {
  const fait = await fenetreFormulaire({
    titre: c ? `Code ${c.code}` : 'Nouveau code promo',
    intro: c && c.utilisations > 0 ? `Déjà utilisé ${pluriel(c.utilisations, 'fois', 'fois')} : son nom ne change plus. Les courses déjà commandées gardent leur remise.` : null,
    champs: [
      { nom: 'code', libelle: 'Code', type: 'texte', requis: true, longueur: 20, majuscules: true, placeholder: 'BIENVENUE10',
        motif: /^[A-Z0-9_-]{3,20}$/, messageMotif: 'De 3 à 20 lettres, chiffres, « - » ou « _ », sans espace.' },
      { nom: 'libelle', libelle: 'Libellé (pour vous)', type: 'texte', longueur: 120, placeholder: 'Offre de bienvenue' },
      { nom: 'type', libelle: 'Type de remise', type: 'choix', requis: true,
        options: [{ valeur: 'pourcentage', libelle: 'Pourcentage du prix' }, { valeur: 'montant', libelle: 'Montant en euros' }] },
      { nom: 'valeur', libelle: 'Remise (% ou €)', type: 'nombre', requis: true, min: 0.01, max: 1000, pas: '0.01' },
      { nom: 'debut', libelle: 'Valable à partir du', type: 'date', aide: 'Vide : dès maintenant.' },
      { nom: 'fin', libelle: 'Valable jusqu\'au (compris)', type: 'date', aide: 'Vide : sans date de fin.' },
      { nom: 'utilisations_max', libelle: 'Utilisations au total', type: 'nombre', min: 1, pas: '1', aide: 'Vide : sans limite.' },
      { nom: 'utilisations_par_client', libelle: 'Utilisations par client', type: 'nombre', requis: true, min: 1, pas: '1' },
      { nom: 'minimum_course', libelle: 'Course d\'au moins (€)', type: 'nombre', min: 0, pas: '0.01', aide: '0 : sans minimum.' },
      { nom: 'actif', libelle: 'Accepté à la commande', type: 'case' }
    ],
    valeurs: c ? {
      code: c.code, libelle: c.libelle, type: c.type, valeur: c.valeur, debut: dateDebut(c), fin: dateFin(c),
      utilisations_max: c.utilisations_max, utilisations_par_client: c.utilisations_par_client, minimum_course: c.minimum_course, actif: c.actif
    } : { type: 'pourcentage', utilisations_par_client: 1, minimum_course: 0, actif: true },
    libelle: c ? 'Enregistrer' : 'Créer le code',
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('admin_enregistrer_code_promo', { p_code: c ? c.id : null, p_donnees: { ...v, minimum_course: v.minimum_course ?? 0 } });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage(c ? 'Code promo enregistré.' : 'Code promo créé.', 'succes'); await charger(); }
}

async function utilisations(c) {
  const { data, error } = await supabase.rpc('admin_utilisations_code', { p_code: c.id });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  const fenetre = ouvrirFenetre({
    titre: `Utilisations du code ${c.code}`, large: true,
    contenu: [
      el('p', { classe: 'sous-titre', texte: `${pluriel(data.length, 'utilisation', 'utilisations')} · ${euros(c.remises)} de remises accordées` }),
      tableau({
        colonnes: [
          { titre: 'Le', valeur: (u) => jourHeure(u.cree_le) },
          { titre: 'Client', valeur: (u) => el('a', { href: lienAdmin(`clients/?id=${u.client_id}`), texte: u.client }) },
          { titre: 'Course', valeur: (u) => el('span', {}, el('a', { href: lienAdmin(`courses/?id=${u.course_id}`), texte: u.course_numero }), ' ', badgeCourse(u.course_statut)) },
          { titre: 'Prix', droite: true, valeur: (u) => euros(u.prix_total) },
          { titre: 'Remise', droite: true, valeur: (u) => `− ${euros(u.remise)}` }
        ],
        lignes: data, vide: 'Aucune utilisation.'
      }),
      el('div', { classe: 'fenetre-actions' }, el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Fermer', onclick: () => fenetre.fermer() }))
    ]
  });
}
