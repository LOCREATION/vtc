// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : clients et entreprises — éléments communs aux deux fiches
// -----------------------------------------------------------------------------
//   - boutons d'action (désactivés pendant l'opération) ;
//   - cases de chiffres, étoiles, lignes de fiche, mois en toutes lettres ;
//   - montant à retenir pour une course ;
//   - téléphone saisi « à la française » converti au format international ;
//   - notes internes (lecture, ajout, retrait des siennes) ;
//   - historique des modifications, chargé à l'ouverture de la rubrique.
// Aucun texte n'est jamais injecté comme du HTML (tout passe par « el »).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage, telephoneInternational } from '../../commun/outils.js';
import { dateCourte, heure, tableau, confirmer, messageErreurAdmin, COLONNES_JOURNAL } from '../commun/composants.js';

// Bouton qui se désactive le temps de l'action (pas de double envoi)
export function boutonAction(texte, action, classe = 'bouton-secondaire') {
  const b = el('button', { type: 'button', classe: `bouton ${classe} bouton-petit`, texte });
  b.addEventListener('click', async () => { b.disabled = true; try { await action(); } finally { b.disabled = false; } });
  return b;
}

// Case de chiffre clé : libellé, valeur, détail
export function tuile(libelle, valeur, detail = null, ton = null) {
  return el('div', { classe: `chiffre-cle${ton ? ` chiffre-${ton}` : ''}` },
    el('span', { classe: 'libelle', texte: libelle }),
    el('span', { classe: 'valeur', texte: valeur }),
    detail ? el('span', { classe: 'detail', texte: detail }) : null);
}

// « ★★★★☆ » lisible par les lecteurs d'écran (« 4 sur 5 »)
export function etoiles(note) {
  const n = Math.round(Number(note) || 0);
  return el('span', { classe: 'etoiles', 'aria-label': `${n} sur 5`, texte: '★'.repeat(n) + '☆'.repeat(5 - n) });
}

// Ligne de fiche (terme, valeur) ; rien si la valeur est vide
export function ligne(libelle, valeur) {
  if (valeur === null || valeur === undefined || valeur === '' || valeur === false) return [];
  return [el('dt', { texte: libelle }), el('dd', {}, valeur)];
}

// « 2026-10 » → « octobre 2026 »
export function moisLisible(mois) {
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${mois}-15T12:00:00Z`));
}

// « 1 course », « 3 courses »
export function pluriel(n, un, plusieurs) {
  return `${n} ${Number(n) > 1 ? plusieurs : un}`;
}

// Montant à retenir pour une course : payé (terminée), frais (annulée), annoncé (sinon)
export function montantCourse(c) {
  if (c.statut === 'terminee') return Number(c.prix_total) + Number(c.frais_attente || 0);
  if (c.statut === 'annulee') return Number(c.frais_annulation || 0);
  return Number(c.prix_total);
}

// Téléphone saisi « 06 12 34 56 78 » ou « +229 97… » : format international
export function normaliserTelephone(valeur) {
  return telephoneInternational(valeur) || String(valeur).replace(/[\s.\-()]/g, '');
}
export function erreurTelephone(valeur) {
  return /^\+[1-9]\d{6,14}$/.test(valeur)
    ? null : 'Numéro invalide : numéro français à 10 chiffres, ou format international (ex. +33 6 12 34 56 78).';
}

// Section avec titre
export function section(titre, idTitre, ...contenu) {
  return el('section', { classe: 'carte-admin', 'aria-labelledby': idTitre },
    el('h2', { id: idTitre, texte: titre }), ...contenu);
}

// Tableau des premières lignes seulement (les plus récentes), avec un bouton
// « Afficher les N autres » : une fiche reste courte, sur téléphone surtout.
export function tableauRepliable({ premiers = 10, libelleSuite, ...options }) {
  const zone = el('div', { classe: 'tableau-repliable' });
  const dessiner = (tout) => {
    const lignes = tout ? options.lignes : options.lignes.slice(0, premiers);
    const reste = options.lignes.length - lignes.length;
    const suite = reste > 0
      ? el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: libelleSuite(reste), onclick: () => dessiner(true) })
      : null;
    zone.replaceChildren(tableau({ ...options, lignes }), ...(suite ? [el('div', { classe: 'actions-ligne' }, suite)] : []));
  };
  dessiner(false);
  return zone;
}

// ---------------------------------------------------------------------------
// Notes internes
// ---------------------------------------------------------------------------
// cible : { profil_id } ou { compte_pro_id } ; notes : lues avec la fiche ;
// moi : identifiant de l'administrateur connecté (il ne retire que les siennes).
export function blocNotesInternes({ cible, notes, moi, recharger }) {
  const zone = el('textarea', { id: 'nouvelle-note', classe: 'saisie saisie-zone', maxlength: '2000',
    placeholder: 'Ex. préfère être appelé ; relevé à adresser au service comptable…' });
  const erreur = el('p', { classe: 'alerte', role: 'alert', hidden: true });
  const ajouter = el('button', { type: 'submit', classe: 'bouton bouton-principal bouton-petit', texte: 'Ajouter la note' });
  const formulaire = el('form', { classe: 'formulaire-note', novalidate: true },
    el('label', { for: 'nouvelle-note', texte: 'Nouvelle note' }), zone, erreur, el('div', { classe: 'actions-ligne' }, ajouter));
  formulaire.addEventListener('submit', async (e) => {
    e.preventDefault();
    const texte = zone.value.trim();
    erreur.hidden = true;
    if (!texte) { erreur.textContent = 'Écrivez la note avant de l\'ajouter.'; erreur.hidden = false; zone.focus(); return; }
    ajouter.disabled = true;
    const { error } = await supabase.from('notes_internes').insert({ ...cible, texte });
    ajouter.disabled = false;
    if (error) { erreur.textContent = messageErreurAdmin(error); erreur.hidden = false; return; }
    afficherMessage('Note ajoutée.', 'succes');
    await recharger();
  });

  const liste = notes.length
    ? el('ul', { classe: 'liste-notes' }, ...notes.map((n) => el('li', {},
      el('p', { classe: 'texte-long', texte: n.texte }),
      el('div', { classe: 'note-pied' },
        el('span', { classe: 'secondaire', texte: `${n.auteur || 'Administrateur retiré'} · ${dateCourte(n.cree_le)} à ${heure(n.cree_le)}` }),
        n.auteur_id === moi ? boutonAction('Retirer', async () => {
          const ok = await confirmer({ titre: 'Retirer cette note ?', texte: n.texte.length > 140 ? `${n.texte.slice(0, 137)}…` : n.texte, libelle: 'Retirer', danger: true });
          if (!ok) return;
          const { error } = await supabase.from('notes_internes').delete().eq('id', n.id);
          if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
          afficherMessage('Note retirée.', 'succes');
          await recharger();
        }, 'bouton-texte') : null))))
    : el('p', { classe: 'vide-admin', texte: 'Aucune note pour le moment.' });

  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-notes-internes' },
    el('div', { classe: 'carte-entete' },
      el('h2', { id: 'titre-notes-internes', texte: 'Notes internes' }),
      el('span', { classe: 'sous-titre', texte: 'Visibles de l\'administration seulement' })),
    liste, formulaire);
}

// ---------------------------------------------------------------------------
// Historique des modifications (journal), chargé à l'ouverture
// ---------------------------------------------------------------------------
// charger() renvoie la liste des entrées du journal, déjà triées.
export function blocHistorique({ charger, aide }) {
  const zone = el('div', {}, el('p', { classe: 'chargement', texte: 'Chargement…' }));
  const bloc = el('details', { classe: 'carte-admin repli-historique' },
    el('summary', {}, el('span', { texte: 'Historique des modifications' })),
    aide ? el('p', { classe: 'sous-titre', texte: aide }) : null,
    zone);
  let charge = false;
  bloc.addEventListener('toggle', async () => {
    if (!bloc.open || charge) return;
    charge = true;
    try {
      const entrees = await charger();
      zone.replaceChildren(tableau({ colonnes: COLONNES_JOURNAL, lignes: entrees, vide: 'Aucune modification enregistrée.' }));
    } catch (erreur) {
      charge = false;
      zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(erreur) }));
    }
  });
  return bloc;
}
