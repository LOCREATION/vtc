// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : composants communs à tous les modules
// -----------------------------------------------------------------------------
//   - fenêtres (formulaire, confirmation avec motif) sur l'élément <dialog>
//     du navigateur : clavier, touche Échap et lecteurs d'écran gérés ;
//   - formulaires décrits par une liste de champs (lecture et contrôle) ;
//   - tableaux qui deviennent des fiches sur téléphone ;
//   - export CSV lisible directement par Excel en français ;
//   - pastilles de statut, dates à l'heure de Paris, ouverture des pièces.
// Aucun texte n'est jamais injecté comme du HTML (tout passe par « el »).
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { el, euros } from '../../commun/outils.js';

// ---------------------------------------------------------------------------
// Dates et nombres (heure de Paris, quel que soit l'appareil)
// ---------------------------------------------------------------------------
const PARIS = 'Europe/Paris';

// « 2026-10-30 » : jour de Paris d'un instant (format des champs date)
export function jourParis(instant = new Date()) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: PARIS }).format(new Date(instant));
}

// Ajoute des jours à un jour « AAAA-MM-JJ » (calcul en UTC : pas d'effet d'heure d'été)
export function ajouterJours(jour, n) {
  const d = new Date(`${jour}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// « 30/10/2026 » à partir d'un jour « AAAA-MM-JJ » ou d'un instant
export function dateCourte(valeur) {
  if (!valeur) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(valeur)) {
    const [a, m, j] = valeur.split('-');
    return `${j}/${m}/${a}`;
  }
  return new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, dateStyle: 'short' }).format(new Date(valeur));
}

// « 14:05 »
export function heure(instant) {
  if (!instant) return '—';
  return new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit' }).format(new Date(instant));
}

// « 30/10 14:05 »
export function jourHeure(instant) {
  if (!instant) return '—';
  return new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date(instant)).replace(',', '');
}

// « 30/10/2026 à 14:05 »
export function dateHeureComplete(instant) {
  if (!instant) return '—';
  return `${dateCourte(instant)} à ${heure(instant)}`;
}

// « Aujourd'hui », « Demain » ou « samedi 31 octobre »
export function libelleJour(instant) {
  const jour = jourParis(instant);
  const aujourdhui = jourParis();
  if (jour === aujourdhui) return 'Aujourd\'hui';
  if (jour === ajouterJours(aujourdhui, 1)) return 'Demain';
  if (jour === ajouterJours(aujourdhui, -1)) return 'Hier';
  return new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(instant));
}

// Durée depuis un instant : « 3 min », « 2 h 05 », « 4 j »
export function depuis(instant) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(instant).getTime()) / 60000));
  if (minutes < 1) return 'moins d\'1 min';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
  return `${Math.floor(minutes / 1440)} j`;
}

// Nombre de jours avant une date (négatif si dépassée)
export function joursAvant(jour) {
  if (!jour) return null;
  const debut = new Date(`${jourParis()}T12:00:00Z`).getTime();
  const fin = new Date(`${jour}T12:00:00Z`).getTime();
  return Math.round((fin - debut) / 86400000);
}

// Échéance colorée : rouge si dépassée, or sous 30 jours
export function echeance(jour) {
  if (!jour) return el('span', { classe: 'texte-gris', texte: 'date non renseignée' });
  const n = joursAvant(jour);
  if (n < 0) return el('span', { classe: 'texte-rouge', texte: `Expirée le ${dateCourte(jour)}` });
  if (n <= 30) return el('span', { classe: 'texte-or', texte: `${dateCourte(jour)} (dans ${n} j)` });
  return el('span', { texte: dateCourte(jour) });
}

// « 2026-10-31T14:30 » : date et heure de Paris d'un instant (champ date-heure)
export function valeurParis(instant) {
  const parties = new Intl.DateTimeFormat('en-GB', {
    timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(instant));
  const v = Object.fromEntries(parties.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}`;
}

// Instant exact d'une date et heure saisie « à l'heure de Paris », quel que
// soit le fuseau de l'appareil (un administrateur à Cotonou saisit l'heure
// de prise en charge à Paris) ; heure d'été comprise.
export function instantParis(valeur) {
  const [jour, horaire] = String(valeur).split('T');
  const [a, m, j] = jour.split('-').map(Number);
  const [h, min] = horaire.split(':').map(Number);
  const voulu = Date.UTC(a, m - 1, j, h, min);
  let essai = voulu;
  for (let i = 0; i < 3; i++) {
    const affiche = valeurParis(essai);
    const [ja, ma, ja2] = affiche.slice(0, 10).split('-').map(Number);
    const [ha, mina] = affiche.slice(11).split(':').map(Number);
    const ecart = Date.UTC(ja, ma - 1, ja2, ha, mina) - voulu;
    if (!ecart) break;
    essai -= ecart;
  }
  return new Date(essai);
}

export { euros };

// Numéro lisible : « +33612345678 » → « +33 6 12 34 56 78 » ; autres pays :
// indicatif (1, 2 ou 3 chiffres selon le plan de numérotation international)
// puis groupes de 2 chiffres (« +229 97 00 00 00 », « +44 79 11 12 34 56 »).
const INDICATIFS_DEUX_CHIFFRES = new Set(['20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46',
  '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84',
  '86', '90', '91', '92', '93', '94', '95', '98']);

export function telephoneLisible(numero) {
  const n = String(numero || '');
  const francais = n.match(/^\+33([1-9])(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (francais) return `+33 ${francais.slice(1).join(' ')}`;
  if (!/^\+\d{7,15}$/.test(n)) return n;
  const chiffres = n.slice(1);
  const longueur = /^[17]/.test(chiffres) ? 1 : INDICATIFS_DEUX_CHIFFRES.has(chiffres.slice(0, 2)) ? 2 : 3;
  return `+${chiffres.slice(0, longueur)} ${chiffres.slice(longueur).replace(/(\d{2})(?=\d)/g, '$1 ')}`;
}

// Lien d'appel : le numéro complet dans le lien, lisible à l'écran
export function lienTelephone(numero) {
  return numero ? el('a', { href: `tel:${numero}`, texte: telephoneLisible(numero) }) : null;
}

// Nom affiché d'une personne
export function nomComplet(prenom, nom) {
  return [prenom, nom].filter(Boolean).join(' ').trim() || 'Sans nom';
}

// ---------------------------------------------------------------------------
// Pastilles de statut
// ---------------------------------------------------------------------------
export const STATUTS_COURSE = {
  planifiee:   { libelle: 'Réservation', ton: 'bleu' },
  recherche:   { libelle: 'Recherche en cours', ton: 'or' },
  a_attribuer: { libelle: 'À attribuer', ton: 'rouge' },
  acceptee:    { libelle: 'En approche', ton: 'vert' },
  arrivee:     { libelle: 'Chauffeur arrivé', ton: 'vert' },
  en_cours:    { libelle: 'Client à bord', ton: 'vert' },
  terminee:    { libelle: 'Terminée', ton: 'gris' },
  annulee:     { libelle: 'Annulée', ton: 'gris' }
};

export const MODES_PAIEMENT = {
  especes: 'Espèces', carte: 'Carte au terminal', solde: 'Solde', facture_mensuelle: 'Facture mensuelle'
};

// Paiements : statut, nature ; moyens de remboursement
export const STATUTS_PAIEMENT = {
  a_encaisser: { libelle: 'À encaisser', ton: 'or' }, encaisse: { libelle: 'Encaissé', ton: 'vert' },
  echoue: { libelle: 'Impayé', ton: 'rouge' }, rembourse: { libelle: 'Remboursé', ton: 'gris' }, annule: { libelle: 'Annulé', ton: 'gris' }
};
export const NATURES_PAIEMENT = { course: 'Course', pourboire: 'Pourboire', frais_annulation: 'Frais d\'annulation' };
export const MODES_REMBOURSEMENT = { virement: 'Virement', carte: 'Sur la carte', especes: 'Espèces' };
export const ORIGINES_AVOIR = { remboursement: 'Remboursement', annulation: 'Somme annulée' };

export const TYPES_COURSE = { immediate: 'Immédiate', planifiee: 'Réservation', mise_a_disposition: 'Mise à disposition' };

// Pièces des chauffeurs et des véhicules
export const TYPES_DOCUMENT = {
  permis: 'Permis de conduire', carte_vtc: 'Carte VTC', registre_vtc: 'Attestation d\'inscription au registre VTC',
  piece_identite: 'Pièce d\'identité', justificatif_domicile: 'Justificatif de domicile',
  assurance: 'Attestation d\'assurance', carte_grise: 'Carte grise', controle_technique: 'Contrôle technique',
  vignette_vtc: 'Vignette VTC', autre: 'Autre document'
};
export const STATUTS_DOCUMENT = {
  en_attente: { libelle: 'À vérifier', ton: 'or' }, valide: { libelle: 'Validé', ton: 'vert' }, refuse: { libelle: 'Refusé', ton: 'rouge' }
};
// Pièces qui portent une date d'expiration (reportée sur la fiche à la validation)
export const DOCUMENTS_DATES = ['permis', 'carte_vtc', 'piece_identite', 'assurance', 'controle_technique', 'vignette_vtc'];

export function badge(texte, ton = 'gris') {
  return el('span', { classe: `badge badge-${ton}`, texte });
}

export function badgeCourse(statut) {
  const s = STATUTS_COURSE[statut] || { libelle: statut, ton: 'gris' };
  return badge(s.libelle, s.ton);
}

export function badgePaiement(statut) {
  const s = STATUTS_PAIEMENT[statut] || { libelle: statut, ton: 'gris' };
  return badge(s.libelle, s.ton);
}

// ---------------------------------------------------------------------------
// Petits éléments des pages : bouton d'action, case de chiffre, ligne de
// fiche, pluriel, mois en toutes lettres
// ---------------------------------------------------------------------------
// Bouton qui se désactive le temps de l'action (pas de double envoi)
export function boutonAction(texte, action, classe = 'bouton-secondaire') {
  const b = el('button', { type: 'button', classe: `bouton ${classe} bouton-petit`, texte });
  b.addEventListener('click', async () => { b.disabled = true; try { await action(); } finally { b.disabled = false; } });
  return b;
}

// Case de chiffre clé : libellé, valeur, détail ; ton : rouge (retard,
// impayé) ou or (à encaisser, à remettre)
export function tuile(libelle, valeur, detail = null, ton = null) {
  return el('div', { classe: `chiffre-cle${ton ? ` chiffre-${ton}` : ''}` },
    el('span', { classe: 'libelle', texte: libelle }),
    el('span', { classe: 'valeur', texte: valeur }),
    detail ? el('span', { classe: 'detail', texte: detail }) : null);
}

// Ligne de fiche (terme, valeur) ; rien si la valeur est vide
export function ligne(libelle, valeur) {
  if (valeur === null || valeur === undefined || valeur === '' || valeur === false) return [];
  return [el('dt', { texte: libelle }), el('dd', {}, valeur)];
}

// « 1 course », « 3 courses »
export function pluriel(n, un, plusieurs) {
  return `${n} ${Number(n) > 1 ? plusieurs : un}`;
}

// « 2026-10 » → « octobre 2026 »
export function moisLisible(mois) {
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${mois}-15T12:00:00Z`));
}

// ---------------------------------------------------------------------------
// Fenêtres
// ---------------------------------------------------------------------------
// Ouvre une fenêtre modale. « contenu » : nœuds à afficher. Renvoie la fenêtre
// et une fonction « fermer ». La fenêtre est retirée de la page à la fermeture.
export function ouvrirFenetre({ titre, contenu = [], large = false, onFermer = null }) {
  const dialogue = el('dialog', { classe: `fenetre${large ? ' fenetre-large' : ''}`, 'aria-labelledby': 'fenetre-titre' });
  const corps = el('div', { classe: 'fenetre-corps' }, el('h2', { id: 'fenetre-titre', texte: titre }), ...contenu);
  dialogue.append(corps);
  document.body.append(dialogue);
  dialogue.addEventListener('close', () => {
    dialogue.remove();
    if (onFermer) onFermer();
  });
  dialogue.showModal();
  return { dialogue, corps, fermer: () => dialogue.close() };
}

// Confirmation, avec ou sans motif à saisir. Renvoie une promesse :
// null si annulé, sinon { motif }.
//   motif : { libelle, obligatoire, aide } ou null
export function confirmer({ titre, texte, libelle = 'Confirmer', danger = false, motif = null }) {
  return new Promise((resoudre) => {
    let resultat = null;
    const zoneMotif = motif ? el('textarea', { classe: 'saisie saisie-zone', id: 'fenetre-motif', maxlength: '500' }) : null;
    const erreur = el('p', { classe: 'alerte', role: 'alert', hidden: true });
    const formulaire = el('form', { method: 'dialog' },
      el('h2', { id: 'fenetre-titre', texte: titre }),
      texte ? el('p', { texte }) : null,
      motif ? el('div', { classe: 'champ' },
        el('label', { for: 'fenetre-motif', texte: motif.libelle + (motif.obligatoire ? '' : ' (facultatif)') }),
        zoneMotif,
        motif.aide ? el('p', { classe: 'aide', texte: motif.aide }) : null) : null,
      erreur,
      el('div', { classe: 'fenetre-actions' },
        el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Annuler', onclick: () => dialogue.close() }),
        el('button', { type: 'submit', classe: `bouton ${danger ? 'bouton-danger' : 'bouton-principal'}`, texte: libelle })));
    const dialogue = el('dialog', { classe: 'fenetre', 'aria-labelledby': 'fenetre-titre' }, formulaire);
    formulaire.addEventListener('submit', (e) => {
      const valeur = zoneMotif ? zoneMotif.value.trim() : '';
      if (motif && motif.obligatoire && !valeur) {
        e.preventDefault();
        erreur.textContent = 'Indiquez le motif : il est conservé dans le journal et transmis à la personne concernée.';
        erreur.hidden = false;
        zoneMotif.focus();
        return;
      }
      resultat = { motif: valeur || null };
    });
    dialogue.addEventListener('close', () => { dialogue.remove(); resoudre(resultat); });
    document.body.append(dialogue);
    dialogue.showModal();
    (zoneMotif || formulaire.querySelector('[type=submit]')).focus();
  });
}

// ---------------------------------------------------------------------------
// Formulaires décrits par une liste de champs
// ---------------------------------------------------------------------------
// Champ : { nom, libelle, type, requis, min, max, pas, options, aide, plein,
//           majuscules, motif, messageMotif, placeholder, longueur,
//           normaliser, controle }
//   type : texte | nombre | date | heure | dateheure | case | choix | zone | email | tel
//   (« dateheure » : valeur « AAAA-MM-JJTHH:MM », lue telle quelle)
//   normaliser(valeur) : nettoie la saisie avant contrôle (ex. retirer les
//   espaces d'un SIRET) ; controle(valeur) : renvoie un message d'erreur
//   précis, ou null (ex. clé de contrôle d'un SIRET ou d'un IBAN).
// La valeur lue est typée : nombre → Number, case → booléen, champ vide → null.
let compteurChamps = 0;

export function construireChamps(champs, valeurs = {}) {
  const grille = el('div', { classe: 'grille-champs' });
  const elements = {};
  for (const champ of champs) {
    const id = `champ-${++compteurChamps}`;
    const valeur = valeurs[champ.nom];
    let saisie;
    if (champ.type === 'case') {
      saisie = el('input', { type: 'checkbox', id, name: champ.nom });
      saisie.checked = !!valeur;
      const bloc = el('label', { classe: `case${champ.plein !== false ? ' champ-plein' : ''}`, for: id },
        saisie, el('span', { texte: champ.libelle }));
      grille.append(bloc);
      elements[champ.nom] = { champ, saisie };
      continue;
    }
    if (champ.type === 'choix') {
      saisie = el('select', { classe: 'saisie', id, name: champ.nom },
        ...(champ.requis ? [] : [el('option', { value: '', texte: champ.vide || '—' })]),
        ...champ.options.map((o) => el('option', { value: o.valeur, texte: o.libelle })));
      saisie.value = valeur === null || valeur === undefined ? '' : String(valeur);
    } else if (champ.type === 'zone') {
      saisie = el('textarea', { classe: 'saisie saisie-zone', id, name: champ.nom, maxlength: champ.longueur || null });
      saisie.value = valeur ?? '';
    } else {
      // Nombres : champ texte avec clavier numérique, virgule ou point acceptés
      // (le champ « number » des navigateurs refuse la virgule française)
      const types = { texte: 'text', nombre: 'text', date: 'date', heure: 'time', dateheure: 'datetime-local', email: 'email', tel: 'tel' };
      const nombre = champ.type === 'nombre';
      saisie = el('input', {
        classe: 'saisie', id, name: champ.nom, type: types[champ.type] || 'text',
        min: nombre ? null : champ.min ?? null, max: nombre ? null : champ.max ?? null,
        inputmode: nombre ? (champ.pas === '1' ? 'numeric' : 'decimal') : null, placeholder: champ.placeholder || null,
        maxlength: champ.longueur || null, autocomplete: 'off'
      });
      if (valeur === null || valeur === undefined) saisie.value = '';
      else if (nombre) saisie.value = String(valeur).replace('.', ',');
      else saisie.value = String(champ.type === 'heure' ? String(valeur).slice(0, 5) : valeur);
      if (champ.majuscules) saisie.addEventListener('input', () => { saisie.value = saisie.value.toUpperCase(); });
    }
    const erreur = el('p', { classe: 'erreur-champ', id: `${id}-erreur`, hidden: true });
    saisie.setAttribute('aria-describedby', `${id}-erreur`);
    grille.append(el('div', { classe: `champ${champ.plein ? ' champ-plein' : ''}` },
      el('label', { for: id, texte: champ.libelle + (champ.requis ? '' : ' (facultatif)') }),
      saisie,
      champ.aide ? el('p', { classe: 'aide', texte: champ.aide }) : null,
      erreur));
    elements[champ.nom] = { champ, saisie, erreur };
  }

  // Lit et contrôle les valeurs ; affiche les erreurs sous les champs
  function lire() {
    const resultat = {};
    let premiereErreur = null;
    for (const { champ, saisie, erreur } of Object.values(elements)) {
      if (champ.type === 'case') { resultat[champ.nom] = saisie.checked; continue; }
      let brut = saisie.value.trim();
      let message = null;
      let valeur = brut === '' ? null : brut;
      if (valeur !== null && champ.normaliser) {
        valeur = champ.normaliser(valeur) || null;
        brut = valeur ?? '';
      }
      if (valeur === null && champ.requis) message = 'Champ obligatoire.';
      if (valeur !== null && champ.type === 'nombre') {
        const nettoye = brut.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
        valeur = /^-?\d+(\.\d+)?$/.test(nettoye) ? Number(nettoye) : NaN;
        if (!Number.isFinite(valeur)) message = 'Nombre invalide (exemple : 12,50).';
        else if (champ.pas === '1' && !Number.isInteger(valeur)) message = 'Nombre entier attendu.';
        else if (champ.min !== undefined && valeur < Number(champ.min)) message = `Minimum : ${String(champ.min).replace('.', ',')}.`;
        else if (champ.max !== undefined && valeur > Number(champ.max)) message = `Maximum : ${String(champ.max).replace('.', ',')}.`;
      }
      if (valeur !== null && champ.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(valeur)) message = 'Adresse e-mail invalide.';
      if (valeur !== null && champ.motif && !champ.motif.test(valeur)) message = champ.messageMotif || 'Format invalide.';
      if (valeur !== null && !message && champ.controle) message = champ.controle(valeur);
      if (valeur !== null && champ.type === 'heure') valeur = brut.slice(0, 5);
      if (erreur) {
        erreur.textContent = message || '';
        erreur.hidden = !message;
        saisie.setAttribute('aria-invalid', String(!!message));
      }
      if (message && !premiereErreur) premiereErreur = saisie;
      resultat[champ.nom] = valeur;
    }
    if (premiereErreur) { premiereErreur.focus(); return null; }
    return resultat;
  }

  return { noeud: grille, lire, elements };
}

// Fenêtre de formulaire complète : champs, enregistrement, erreurs du serveur.
// « enregistrer(valeurs) » renvoie une promesse ; une erreur levée reste
// affichée dans la fenêtre (qui ne se ferme qu'en cas de succès).
// « preparer(elements) » : appelée une fois la fenêtre construite, avec les
// champs ({ nom: { saisie } }), pour brancher une aide à la saisie.
export function fenetreFormulaire({ titre, intro = null, champs, valeurs = {}, libelle = 'Enregistrer', large = false, enregistrer, avant = [], apres = [], preparer = null }) {
  return new Promise((resoudre) => {
    const formulaireChamps = construireChamps(champs, valeurs);
    const erreur = el('p', { classe: 'alerte', role: 'alert', hidden: true });
    const bouton = el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: libelle });
    let resultat = null;
    const formulaire = el('form', { novalidate: true },
      el('h2', { id: 'fenetre-titre', texte: titre }),
      intro ? el('p', { classe: 'sous-titre', texte: intro }) : null,
      ...avant,
      formulaireChamps.noeud,
      ...apres,
      erreur,
      el('div', { classe: 'fenetre-actions' },
        el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Annuler', onclick: () => dialogue.close() }),
        bouton));
    const dialogue = el('dialog', { classe: `fenetre${large ? ' fenetre-large' : ''}`, 'aria-labelledby': 'fenetre-titre' }, formulaire);
    formulaire.addEventListener('submit', async (e) => {
      e.preventDefault();
      const lues = formulaireChamps.lire();
      if (!lues) return;
      bouton.disabled = true;
      erreur.hidden = true;
      try {
        resultat = (await enregistrer(lues)) ?? true;
        dialogue.close();
      } catch (probleme) {
        erreur.textContent = messageErreurAdmin(probleme);
        erreur.hidden = false;
        bouton.disabled = false;
      }
    });
    dialogue.addEventListener('close', () => { dialogue.remove(); resoudre(resultat); });
    document.body.append(dialogue);
    dialogue.showModal();
    if (preparer) preparer(formulaireChamps.elements);
    const premier = formulaire.querySelector('input:not([type=checkbox]), select, textarea');
    if (premier) premier.focus();
  });
}

// Message d'erreur lisible, avec les cas propres à l'administration
// (doublon, valeur hors limites) que le message générique ne précise pas.
export function messageErreurAdmin(erreur) {
  const brut = (erreur && (erreur.message || String(erreur))) || '';
  if (/duplicate key/i.test(brut)) {
    if (/immatriculation/i.test(brut)) return 'Cette immatriculation existe déjà.';
    if (/code/i.test(brut)) return 'Ce code existe déjà : choisissez-en un autre.';
    if (/tarifs_categorie_id_valide_du_key/i.test(brut)) return 'Un tarif commence déjà à cette date pour cette catégorie.';
    if (/forfaits_paire_unique/i.test(brut)) return 'Un forfait existe déjà entre ces deux lieux pour cette catégorie.';
    if (/jours_feries/i.test(brut)) return 'Ce jour férié est déjà enregistré.';
    return 'Cet élément existe déjà.';
  }
  if (/violates check constraint/i.test(brut)) {
    if (/tarifs_periode/i.test(brut)) return 'La date de fin doit être postérieure à la date de début.';
    if (/forfaits_deux_zones/i.test(brut)) return 'Choisissez deux lieux différents.';
    if (/immatriculation/i.test(brut)) return 'Immatriculation invalide : lettres, chiffres et tirets (ex. GA-123-BC).';
    if (/parametres_zone/i.test(brut)) return 'La zone desservie est incohérente : le minimum doit rester inférieur au maximum.';
    if (/majorations_nuit/i.test(brut)) return 'Indiquez l\'heure de début et de fin de la majoration de nuit.';
    if (/siret/i.test(brut)) return 'SIRET invalide : 14 chiffres, sans espace.';
    if (/siren/i.test(brut)) return 'SIREN invalide : 9 chiffres, sans espace.';
    if (/code/i.test(brut)) return 'Code invalide : lettres minuscules, chiffres et « _ » seulement.';
    return 'Une valeur est hors des limites autorisées : vérifiez la saisie.';
  }
  if (/violates foreign key/i.test(brut)) return 'Suppression impossible : cet élément est utilisé par des courses ou d\'autres fiches. Désactivez-le plutôt.';
  if (/row-level security|permission denied/i.test(brut)) return 'Action refusée : votre session d\'administration a peut-être expiré. Rechargez la page.';
  return messageErreur(erreur);
}

// ---------------------------------------------------------------------------
// Tableaux
// ---------------------------------------------------------------------------
// colonne : { titre, valeur: (ligne) => texte | nœud, droite, csv: (ligne) => texte }
export function tableau({ colonnes, lignes, vide = 'Aucun élément.', clicLigne = null, libelleLigne = null }) {
  if (!lignes.length) return el('p', { classe: 'vide-admin', texte: vide });
  const entete = el('thead', {}, el('tr', {}, ...colonnes.map((c) => el('th', { classe: c.droite ? 'droite' : null, scope: 'col', texte: c.titre }))));
  const corps = el('tbody', {}, ...lignes.map((ligne) => {
    const tr = el('tr', {}, ...colonnes.map((c) => {
      const valeur = c.valeur(ligne);
      return el('td', { classe: c.droite ? 'droite' : null, 'data-libelle': c.titre },
        valeur === null || valeur === undefined || valeur === '' ? '—' : valeur);
    }));
    if (clicLigne) {
      tr.dataset.cliquable = 'true';
      tr.tabIndex = 0;
      if (libelleLigne) tr.setAttribute('aria-label', libelleLigne(ligne));
      tr.addEventListener('click', (e) => { if (!e.target.closest('a, button')) clicLigne(ligne); });
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') clicLigne(ligne); });
    }
    return tr;
  }));
  return el('div', { classe: 'tableau-conteneur' }, el('table', { classe: 'tableau' }, entete, corps));
}

// ---------------------------------------------------------------------------
// Export CSV (séparateur « ; », virgule décimale, BOM UTF-8 : Excel en
// français ouvre le fichier directement, accents compris)
// ---------------------------------------------------------------------------
export function nombreCsv(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return '';
  return String(valeur).replace('.', ',');
}

// Contenu d'un fichier CSV (texte, avec la marque UTF-8 en tête)
export function contenuCsv(colonnes, lignes) {
  const echapper = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [
    colonnes.map((c) => echapper(c.titre)).join(';'),
    ...lignes.map((l) => colonnes.map((c) => echapper(c.csv(l))).join(';'))
  ].join('\r\n');
}

// Fait télécharger un fichier préparé dans la page (CSV, ZIP)
export function telechargerFichier(fichier, nomFichier) {
  const lien = el('a', { href: URL.createObjectURL(fichier), download: nomFichier, hidden: true });
  document.body.append(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(lien.href), 2000);
}

export function exporterCsv(nomFichier, colonnes, lignes) {
  telechargerFichier(new Blob([contenuCsv(colonnes, lignes)], { type: 'text/csv;charset=utf-8' }), nomFichier);
}

// ---------------------------------------------------------------------------
// Pièces déposées (dossiers privés) : lien signé valable 10 minutes
// ---------------------------------------------------------------------------
// La fenêtre est ouverte tout de suite (pendant le clic, sinon le navigateur
// la bloque), puis reçoit l'adresse une fois le lien signé obtenu.
export async function ouvrirPiece(dossier, chemin) {
  const fenetre = window.open('about:blank', '_blank');
  const { data, error } = await supabase.storage.from(dossier).createSignedUrl(chemin, 600);
  if (error || !data) {
    if (fenetre) fenetre.close();
    throw error || new Error('Pièce introuvable.');
  }
  if (fenetre) {
    fenetre.opener = null;
    fenetre.location.href = data.signedUrl;
  } else {
    location.href = data.signedUrl;
  }
}

// Bouton « Exporter » standard
export function boutonExporter(action) {
  return el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Exporter (CSV)', onclick: action });
}

// ---------------------------------------------------------------------------
// Identifiants des entreprises : contrôle des clés, mise en forme
// ---------------------------------------------------------------------------
// Une faute de frappe dans un SIRET, un numéro de TVA ou un IBAN se voit
// tout de suite grâce à leur clé de contrôle : la saisie est refusée avec un
// message précis plutôt que d'imprimer un numéro faux sur une facture.

// Formule de Luhn (SIREN, SIRET)
function luhnValide(chiffres) {
  let somme = 0;
  [...chiffres].reverse().forEach((c, i) => {
    let n = Number(c);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    somme += n;
  });
  return somme % 10 === 0;
}

// Sans espaces, points ni tirets, lettres en majuscules (« 999 999 998 00019 »
// ou « fr 11 999 999 998 » saisis tels qu'ils sont imprimés)
export function sansEspaces(valeur) {
  return String(valeur || '').replace(/[\s.\-  ]/g, '').toUpperCase();
}

// Message d'erreur, ou null si le SIRET est valable. Les établissements de La
// Poste (SIREN 356 000 000) suivent une autre règle de clé.
export function erreurSiret(siret) {
  if (!/^\d{14}$/.test(siret)) return 'SIRET invalide : 14 chiffres.';
  if (siret.startsWith('356000000')) return null;
  if (!luhnValide(siret.slice(0, 9))) return 'SIRET invalide : les 9 premiers chiffres (le SIREN) ne forment pas un numéro possible. Vérifiez la saisie.';
  if (!luhnValide(siret)) return 'SIRET invalide : la clé de contrôle ne correspond pas. Vérifiez les 5 derniers chiffres.';
  return null;
}

export function erreurSiren(siren) {
  if (!/^\d{9}$/.test(siren)) return 'SIREN invalide : 9 chiffres.';
  if (siren !== '356000000' && !luhnValide(siren)) return 'SIREN invalide : la clé de contrôle ne correspond pas. Vérifiez la saisie.';
  return null;
}

// Numéro de TVA intracommunautaire : format européen ; pour la France, la
// clé (2 chiffres) se calcule à partir du SIREN.
export function erreurTva(tva, siren = null) {
  if (!/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(tva)) return 'N° de TVA invalide : 2 lettres du pays puis le numéro (ex. FR11999999998).';
  if (tva.startsWith('FR')) {
    if (!/^FR[0-9A-Z]{2}\d{9}$/.test(tva)) return 'N° de TVA français invalide : FR, 2 caractères de clé, puis les 9 chiffres du SIREN.';
    const sirenTva = tva.slice(4);
    if (siren && sirenTva !== siren) return 'Le n° de TVA ne reprend pas le SIREN du SIRET : vérifiez les deux numéros.';
    const cle = tva.slice(2, 4);
    if (/^\d{2}$/.test(cle) && Number(cle) !== (12 + 3 * (Number(sirenTva) % 97)) % 97) {
      return 'N° de TVA invalide : la clé ne correspond pas au SIREN. Vérifiez la saisie.';
    }
  }
  return null;
}

// IBAN : longueur et clé (méthode « modulo 97 » de la norme ISO 13616)
export function erreurIban(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return 'IBAN invalide : 2 lettres du pays, 2 chiffres de clé, puis le numéro du compte.';
  if (iban.startsWith('FR') && iban.length !== 27) return 'IBAN français invalide : 27 caractères (FR76 …).';
  const reordonne = iban.slice(4) + iban.slice(0, 4);
  let reste = 0;
  for (const c of reordonne) {
    const valeur = /\d/.test(c) ? c : String(c.charCodeAt(0) - 55);
    for (const chiffre of valeur) reste = (reste * 10 + Number(chiffre)) % 97;
  }
  return reste === 1 ? null : 'IBAN invalide : la clé de contrôle ne correspond pas. Vérifiez la saisie.';
}

export function erreurBic(bic) {
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic) ? null : 'BIC invalide : 8 ou 11 caractères (ex. BNPAFRPPXXX).';
}

// Mises en forme lisibles : « 999 999 998 00019 », « FR76 3000 … »
export function siretLisible(siret) {
  const s = String(siret || '');
  return /^\d{14}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6, 9)} ${s.slice(9)}` : s;
}

export function ibanLisible(iban) {
  return String(iban || '').replace(/(.{4})/g, '$1 ').trim();
}

// ---------------------------------------------------------------------------
// Journal des modifications : libellés et détail lisible d'une entrée
// ---------------------------------------------------------------------------
export const JOURNAL_TABLES = {
  courses: 'Courses', tarifs: 'Tarifs', majorations: 'Majorations', jours_feries: 'Jours fériés', zones: 'Lieux',
  forfaits: 'Forfaits', categories: 'Catégories', codes_promo: 'Codes promo', societe: 'Entreprise', parametres: 'Réglages',
  vehicules: 'Véhicules', entretiens: 'Entretiens', chauffeurs: 'Chauffeurs', documents: 'Documents', candidatures: 'Candidatures',
  profils: 'Comptes (rôles, blocages, coordonnées)', comptes_pro: 'Comptes professionnels', comptes_pro_membres: 'Membres des comptes pro',
  paiements: 'Paiements', remboursements: 'Remboursements', factures: 'Factures', salaries: 'Salariés', contrats: 'Contrats',
  constantes_paie: 'Constantes de paie', parametres_paie: 'Taux de cotisation', bulletins: 'Bulletins de paie', absences: 'Absences',
  temps_travail: 'Temps de travail', releves_plateformes: 'Relevés des plateformes', campagnes: 'Campagnes',
  avoirs: 'Avoirs', remises_especes: 'Remises d\'espèces'
};
export const JOURNAL_ACTIONS = {
  INSERT: 'Création', UPDATE: 'Modification', DELETE: 'Suppression',
  attribution_manuelle: 'Attribution à la main', annulation_admin: 'Annulation par l\'administration',
  retrait_chauffeur: 'Course retirée au chauffeur', relance_recherche: 'Recherche relancée',
  validation_chauffeur: 'Chauffeur validé', refus_candidature: 'Candidature refusée', affectation_vehicule: 'Véhicule affecté',
  suspension_chauffeur: 'Chauffeur suspendu', reactivation_chauffeur: 'Chauffeur réactivé', nomination_admin: 'Administrateur nommé',
  blocage_compte: 'Compte bloqué', deblocage_compte: 'Compte débloqué', encaissement_releve: 'Relevé mensuel encaissé'
};
export const JOURNAL_ROLES = { admin: 'administration', chauffeur: 'chauffeur', client: 'client' };

// Noms de colonnes lisibles (les plus fréquents) ; les autres : « Raison sociale »
const CHAMPS_JOURNAL = {
  tva_intracommunautaire: 'TVA intracommunautaire', email_facturation: 'E-mail de facturation', plafond_mensuel: 'Plafond mensuel',
  delai_paiement_jours: 'Délai de règlement (jours)', reservations_annulees: 'Réservations annulées', profil_id: 'Compte',
  compte_pro_id: 'Compte professionnel', telephone: 'Téléphone', prenom: 'Prénom', reference: 'Référence', siret: 'SIRET',
  iban: 'IBAN', bic: 'BIC', especes_chauffeur_id: 'Espèces chez le chauffeur', encaisse_par: 'Encaissé par',
  encaisse_le: 'Encaissé le', reference_externe: 'Référence', motif_annulation: 'Motif de l\'annulation', annulee_le: 'Annulée le',
  annulee_par: 'Annulée par', recue_par: 'Reçue par', montant_ttc: 'Montant TTC', montant_ht: 'Montant HT', montant_tva: 'TVA'
};

export function valeurJournal(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (typeof v === 'object') return JSON.stringify(v);
  const texte = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(texte)) return `${dateCourte(texte)} ${heure(texte)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(texte)) return dateCourte(texte);
  return texte.length > 120 ? `${texte.slice(0, 117)}…` : texte;
}

export function champJournal(cle) {
  if (CHAMPS_JOURNAL[cle]) return CHAMPS_JOURNAL[cle];
  const texte = cle.replace(/_/g, ' ');
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

// Détail d'une entrée : « avant → après » pour une modification, sinon les
// principales valeurs de la ligne créée, supprimée, ou de l'action nommée
export function detailsJournal(entree) {
  const ignorer = ['maj_le', 'cree_le'];
  if (entree.action === 'UPDATE' && entree.apres) {
    return el('div', { classe: 'diff' }, ...Object.keys(entree.apres).filter((k) => !ignorer.includes(k)).map((k) => el('span', {},
      `${champJournal(k)} : `, el('del', { texte: valeurJournal((entree.avant || {})[k]) }), ' → ', el('ins', { texte: valeurJournal(entree.apres[k]) }))));
  }
  const source = entree.action === 'DELETE' ? entree.avant : entree.apres;
  if (!source || typeof source !== 'object') return '';
  const cles = Object.keys(source).filter((k) => !ignorer.includes(k) && source[k] !== null && k !== 'id').slice(0, 8);
  return el('div', { classe: 'diff' }, ...cles.map((k) => el('span', { texte: `${champJournal(k)} : ${valeurJournal(source[k])}` })));
}

// Colonnes du tableau du journal (paramètres et fiches)
export const COLONNES_JOURNAL = [
  { titre: 'Date', valeur: (j) => el('span', {}, dateCourte(j.cree_le), el('span', { classe: 'secondaire', texte: heure(j.cree_le) })) },
  { titre: 'Auteur', valeur: (j) => el('span', {}, j.acteur_nom || (j.acteur_id ? 'Compte' : 'Automatique'),
    j.acteur_role ? el('span', { classe: 'secondaire', texte: JOURNAL_ROLES[j.acteur_role] || j.acteur_role }) : null) },
  { titre: 'Action', valeur: (j) => el('span', {}, JOURNAL_ACTIONS[j.action] || champJournal(j.action),
    el('span', { classe: 'secondaire', texte: JOURNAL_TABLES[j.table_cible] || j.table_cible || '' })) },
  { titre: 'Détail', valeur: (j) => detailsJournal(j) }
];
