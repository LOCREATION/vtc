// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : RH et paie — préparation d'un bulletin
// -----------------------------------------------------------------------------
// (?preparer=salarié&periode=AAAA-MM-01)
//   - variables du mois : heures supplémentaires (temps plein) ou
//     complémentaires (temps partiel), absences non rémunérées, primes et
//     indemnités soumises, avantages en nature, indemnités non soumises
//     (transport, frais), acompte, date de paiement ;
//   - suggestions reprises en un clic : heures majorées du relevé de temps
//     (semaines payées ce mois-ci), absences validées du mois, primes et
//     indemnités du mois précédent ;
//   - aperçu recalculé par la base à chaque modification (rien n'est calculé
//     dans la page) : brut, nets, prélèvement à la source, coût employeur,
//     congés, contrôles ;
//   - enregistrement du brouillon, ou enregistrement et validation.
// Lectures et actions : admin_preparer_bulletin, admin_calculer_bulletin,
// admin_enregistrer_bulletin, admin_valider_bulletin.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage, apresPause } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import { tuile, messageErreurAdmin, confirmer, dateCourte } from '../commun/composants.js';
import { montant, decimal, heures, joursConges, moisEnLettres, deMois, finMois, debutMois } from './commun-rh.js';

const $ = (id) => document.getElementById(id);
let compteur = 0;

// Nombre saisi (virgule ou point), null si vide, NaN si invalide
function lireNombre(saisie) {
  const brut = String(saisie.value || '').replace(/[\s  ]/g, '').replace(',', '.');
  if (brut === '') return null;
  return /^-?\d+(\.\d+)?$/.test(brut) ? Number(brut) : NaN;
}

function texteNombre(v) {
  return v === null || v === undefined || v === '' ? '' : String(v).replace('.', ',');
}

function champNombre({ id, libelle, valeur, aide = null, unite = '' }) {
  const saisie = el('input', { id, classe: 'saisie', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: texteNombre(valeur) });
  return {
    saisie,
    noeud: el('div', { classe: 'champ' }, el('label', { for: id, texte: `${libelle}${unite ? ` (${unite})` : ''}` }), saisie,
      aide ? el('p', { classe: 'aide', texte: aide }) : null)
  };
}

// Liste de lignes { libelle, heures | montant } : ajout, retrait, lecture
function listeLignes({ titre, champ, unite, aide, changer }) {
  const corps = el('div', { classe: 'lignes-variables' });
  const ajouter = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Ajouter une ligne' });
  const ligneSaisie = (valeur = {}) => {
    const n = ++compteur;
    const libelle = el('input', { id: `variable-libelle-${n}`, classe: 'saisie', type: 'text', maxlength: '120', autocomplete: 'off',
      value: valeur.libelle || '', 'aria-label': `${titre} : libellé` });
    const nombre = el('input', { id: `variable-nombre-${n}`, classe: 'saisie saisie-nombre', type: 'text', inputmode: 'decimal', autocomplete: 'off',
      value: texteNombre(valeur[champ]), 'aria-label': `${titre} : ${unite}` });
    const retirer = el('button', { type: 'button', classe: 'bouton bouton-danger bouton-petit', texte: 'Retirer', 'aria-label': `Retirer cette ligne (${titre})` });
    const rangee = el('div', { classe: 'ligne-variable' }, libelle, el('span', { classe: 'ligne-variable-nombre' }, nombre, el('span', { texte: unite })), retirer);
    retirer.addEventListener('click', () => { rangee.remove(); changer(); });
    libelle.addEventListener('input', changer);
    nombre.addEventListener('input', changer);
    corps.append(rangee);
    return libelle;
  };
  ajouter.addEventListener('click', () => { ligneSaisie().focus(); });
  return {
    noeud: el('fieldset', { classe: 'bloc-variables' }, el('legend', { texte: titre }), aide ? el('p', { classe: 'aide', texte: aide }) : null, corps, ajouter),
    remplir(lignes) { corps.replaceChildren(); (lignes || []).forEach((l) => ligneSaisie(l)); },
    ajouterLignes(lignes) { (lignes || []).forEach((l) => ligneSaisie(l)); },
    // Lignes complètes seulement ; une ligne à moitié remplie est signalée
    lire() {
      const resultat = [];
      for (const rangee of corps.querySelectorAll('.ligne-variable')) {
        const [libelle, nombre] = rangee.querySelectorAll('input');
        const texte = libelle.value.trim();
        const valeur = lireNombre(nombre);
        if (!texte && valeur === null) continue;
        if (!texte) throw new Error(`${titre} : indiquez le libellé de chaque ligne.`);
        if (valeur === null || Number.isNaN(valeur) || valeur <= 0) throw new Error(`${titre} (« ${texte} ») : ${unite === 'h' ? 'nombre d\'heures' : 'montant'} invalide.`);
        resultat.push({ libelle: texte, [champ]: valeur });
      }
      return resultat;
    },
    vide() { return !corps.querySelector('.ligne-variable'); }
  };
}

export async function ouvrirPreparation(salarie, periode) {
  $('onglets').hidden = true;
  const mois = /^\d{4}-\d{2}-\d{2}$/.test(periode || '') ? debutMois(periode) : debutMois();
  const retour = el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`rh/?vue=bulletins&periode=${mois}`), texte: `Bulletins ${deMois(mois)}` });
  $('entete-actions').replaceChildren(retour);
  if (!/^[0-9a-f-]{36}$/i.test(salarie || '')) { $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: 'Salarié introuvable.' })); return; }
  const { data: p, error } = await supabase.rpc('admin_preparer_bulletin', { p_salarie: salarie, p_periode: mois });
  if (error) { $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  const s = p.salarie;
  if (p.existant && p.existant.statut !== 'brouillon') { location.replace(lienAdmin(`rh/?bulletin=${p.existant.id}`)); return; }
  document.title = `Bulletin ${deMois(mois)}, ${s.nom}, LOC RÉACTION`;
  $('titre-page').textContent = `${s.nom} · ${moisEnLettres(mois)}`;
  $('entete-actions').replaceChildren(retour, el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`rh/?salarie=${s.id}`), texte: 'Dossier' }));

  const partiel = s.temps === 'partiel';
  const v = (p.existant && p.existant.variables) || {};
  const sug = p.suggestion;
  let idBrouillon = p.existant ? p.existant.id : null;
  let dernierCalcul = null;
  let numeroCalcul = 0;

  const recalculer = apresPause(calculer, 400);
  const changer = () => { zoneApercu.classList.add('rechargement'); recalculer(); };

  // --- Heures majorées ---
  const h1 = champNombre({ id: 'var-h1', libelle: partiel ? 'Heures complémentaires à 10 %' : 'Heures supplémentaires à 25 %', unite: 'h',
    valeur: partiel ? v.heures_comp_10 : v.heures_sup_25 });
  const h2 = champNombre({ id: 'var-h2', libelle: partiel ? 'Heures complémentaires à 25 %' : 'Heures supplémentaires à 50 %', unite: 'h',
    valeur: partiel ? v.heures_comp_25 : v.heures_sup_50,
    aide: partiel ? 'Au-delà du dixième de la durée du contrat : seulement si une convention ou un accord le permet.' : null });
  [h1, h2].forEach((c) => c.saisie.addEventListener('input', changer));
  const sugH1 = partiel ? sug.heures_comp_10 : sug.heures_sup_25;
  const sugH2 = partiel ? sug.heures_comp_25 : sug.heures_sup_50;
  const reprendreHeures = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Reprendre ces heures' });
  reprendreHeures.addEventListener('click', () => { h1.saisie.value = texteNombre(sugH1); h2.saisie.value = texteNombre(sugH2); changer(); });
  const semaines = p.semaines || [];
  const resumeTemps = semaines.some((w) => Number(w.jours_saisis) > 0)
    ? el('div', { classe: 'suggestion' },
      el('p', {}, `Relevé de temps (semaines payées en ${moisEnLettres(mois)}) : `,
        el('strong', { texte: `${decimal(sugH1, 0, 2)} h à ${partiel ? '10' : '25'} %, ${decimal(sugH2, 0, 2)} h à ${partiel ? '25' : '50'} %` })),
      el('ul', { classe: 'liste-semaines' }, ...semaines.map((w) => el('li', { texte: `Semaine du ${dateCourte(w.lundi)} : ${heures(w.heures)}` }))),
      reprendreHeures)
    : el('p', { classe: 'aide-module' }, 'Aucune heure saisie dans le relevé de temps de ce mois. ',
      el('a', { href: lienAdmin(`rh/?vue=temps&salarie=${s.id}&mois=${mois}`), texte: 'Ouvrir le temps de travail' }));

  // --- Listes ---
  const absences = listeLignes({ titre: 'Absences non rémunérées', champ: 'heures', unite: 'h', changer,
    aide: 'Heures non payées (sans solde, maladie sans maintien du salaire…). Les congés payés ne se déduisent pas : ils sont comptés dans les congés. Une grève s\'inscrit « Absence non rémunérée », sans en donner le motif.' });
  const primes = listeLignes({ titre: 'Primes et indemnités soumises à cotisations', champ: 'montant', unite: '€', changer,
    aide: 'Prime exceptionnelle, prime de qualité, maintien de salaire pendant un arrêt, indemnité compensatrice de congés à la sortie…' });
  const avantages = listeLignes({ titre: 'Avantages en nature', champ: 'montant', unite: '€', changer,
    aide: 'Ajoutés au brut (cotisations), puis retirés du net : ils ne sont pas versés en argent.' });
  const nonSoumis = listeLignes({ titre: 'Indemnités non soumises', champ: 'montant', unite: '€', changer,
    aide: 'Remboursement de 50 % du titre de transport, frais professionnels remboursés…' });
  absences.remplir(v.absences || (p.existant ? [] : sug.absences));
  primes.remplir(v.primes);
  avantages.remplir(v.avantages);
  nonSoumis.remplir(v.non_soumis);

  const reprises = [];
  if (sug.absences.length && p.existant) {
    const b = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Reprendre les absences validées du mois' });
    b.addEventListener('click', () => { absences.remplir(sug.absences); changer(); });
    reprises.push(b);
  }
  if (p.precedent && (p.precedent.primes.length || p.precedent.non_soumis.length || p.precedent.avantages.length)) {
    const b = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Reprendre les primes et indemnités du mois précédent' });
    b.addEventListener('click', () => {
      primes.ajouterLignes(p.precedent.primes); avantages.ajouterLignes(p.precedent.avantages); nonSoumis.ajouterLignes(p.precedent.non_soumis);
      changer();
    });
    reprises.push(b);
  }

  const acompte = champNombre({ id: 'var-acompte', libelle: 'Acompte déjà versé', unite: '€', valeur: v.acompte || null });
  acompte.saisie.addEventListener('input', changer);
  const paiement = el('input', { id: 'var-paiement', classe: 'saisie', type: 'date', value: v.date_paiement || sug.date_paiement });
  paiement.addEventListener('change', changer);

  // --- Aperçu ---
  const zoneApercu = el('div', { classe: 'apercu-bulletin', 'aria-live': 'polite' }, el('p', { classe: 'chargement', texte: 'Calcul…' }));
  const enregistrer = el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Enregistrer le brouillon' });
  const valider = el('button', { type: 'button', classe: 'bouton bouton-principal', texte: 'Enregistrer et valider' });
  const voir = el('a', { classe: 'bouton bouton-secondaire', href: '#', texte: 'Voir le bulletin complet', hidden: !idBrouillon });
  if (idBrouillon) voir.href = lienAdmin(`rh/?bulletin=${idBrouillon}`);

  function lireVariables() {
    const nombres = { h1: lireNombre(h1.saisie), h2: lireNombre(h2.saisie), acompte: lireNombre(acompte.saisie) };
    for (const [cle, valeur] of Object.entries(nombres)) {
      if (Number.isNaN(valeur) || (valeur !== null && valeur < 0)) {
        throw new Error(cle === 'acompte' ? 'Acompte : montant invalide.' : 'Heures majorées : nombre invalide (exemple : 6,5).');
      }
    }
    return {
      [partiel ? 'heures_comp_10' : 'heures_sup_25']: nombres.h1 || 0,
      [partiel ? 'heures_comp_25' : 'heures_sup_50']: nombres.h2 || 0,
      absences: absences.lire(), primes: primes.lire(), avantages: avantages.lire(), non_soumis: nonSoumis.lire(),
      acompte: nombres.acompte || 0, date_paiement: paiement.value || finMois(mois)
    };
  }

  async function calculer() {
    const numero = ++numeroCalcul;
    let variables;
    try { variables = lireVariables(); } catch (probleme) {
      zoneApercu.classList.remove('rechargement');
      zoneApercu.replaceChildren(el('p', { classe: 'alerte', texte: probleme.message }));
      dernierCalcul = null; boutons(); return;
    }
    const { data, error } = await supabase.rpc('admin_calculer_bulletin', { p_salarie: s.id, p_periode: mois, p_variables: variables });
    if (numero !== numeroCalcul) return;                  // un calcul plus récent est en cours
    zoneApercu.classList.remove('rechargement');
    if (error) { zoneApercu.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); dernierCalcul = null; boutons(); return; }
    dernierCalcul = { variables, calcul: data };
    afficherApercu(data);
    boutons();
  }

  function boutons() {
    const bloquants = dernierCalcul ? dernierCalcul.calcul.controles.filter((c) => c.niveau === 'bloquant') : [];
    enregistrer.disabled = !dernierCalcul;
    valider.disabled = !dernierCalcul || bloquants.length > 0;
    valider.title = bloquants.length ? 'Réglez d\'abord les points bloquants.' : '';
  }

  function afficherApercu(c) {
    const ordre = { bloquant: 0, attention: 1, info: 2 };
    const controles = [...c.controles].sort((a, b) => ordre[a.niveau] - ordre[b.niveau]);
    const cg = c.conges;
    zoneApercu.replaceChildren(
      el('div', { classe: 'chiffres-cles' },
        tuile('Brut', montant(c.brut), `${heures(c.heures.payees)} payées`),
        tuile('Net à payer', montant(c.net_a_payer), `le ${dateCourte(c.date_paiement)}`),
        tuile('Coût employeur', montant(c.cout_employeur), `allègements ${montant(c.totaux.allegements)}`)),
      el('dl', { classe: 'fiche-donnees' },
        el('dt', { texte: 'Cotisations salariales' }), el('dd', { texte: montant(c.totaux.cotisations_salariales) }),
        el('dt', { texte: 'Net avant impôt' }), el('dd', { texte: montant(c.net_avant_impot) }),
        el('dt', { texte: 'Net imposable' }), el('dd', { texte: montant(c.net_imposable) }),
        el('dt', { texte: 'Prélèvement à la source' }), el('dd', { texte: `${montant(c.pas.montant)} (${decimal(c.pas.taux, 1, 2)} %, ${c.pas.type === 'personnalise' ? 'taux personnalisé' : 'taux neutre'})` }),
        el('dt', { texte: 'Montant net social' }), el('dd', { texte: montant(c.net_social) }),
        el('dt', { texte: 'Réduction générale' }), el('dd', { texte: `${montant(c.rgdu.reduction_mois)} (coefficient ${decimal(c.rgdu.coefficient, 4, 4)})` }),
        Number(c.heures_sup.montant) ? el('dt', { texte: 'Heures majorées' }) : null,
        Number(c.heures_sup.montant) ? el('dd', { texte: `${montant(c.heures_sup.montant)}, dont ${montant(c.heures_sup.exoneration_impot)} exonérés d'impôt` }) : null,
        el('dt', { texte: 'Congés payés' }),
        el('dd', { texte: `+${joursConges(cg.acquis_mois)} acquis, ${joursConges(cg.pris_mois)} pris · soldes : N-1 ${joursConges(cg.n1_solde)}, N ${joursConges(cg.n_solde)}` })),
      controles.length ? el('ul', { classe: 'liste-controles' }, ...controles.map((x) => el('li', { dataset: { niveau: x.niveau } },
        el('span', { classe: 'controle-niveau', texte: { bloquant: 'Bloquant', attention: 'Attention', info: 'Info' }[x.niveau] }),
        el('span', { texte: x.message })))) : el('p', { classe: 'texte-vert', texte: 'Aucun point à régler.' }));
  }

  async function sauver() {
    const { data, error } = await supabase.rpc('admin_enregistrer_bulletin', { p_salarie: s.id, p_periode: mois, p_variables: dernierCalcul.variables });
    if (error) throw error;
    idBrouillon = data.id;
    voir.href = lienAdmin(`rh/?bulletin=${idBrouillon}`);
    voir.hidden = false;
    return data;
  }

  enregistrer.addEventListener('click', async () => {
    if (!dernierCalcul) return;
    enregistrer.disabled = true;
    try { await sauver(); afficherMessage('Brouillon enregistré.', 'succes'); } catch (probleme) { afficherMessage(messageErreurAdmin(probleme), 'erreur'); }
    boutons();
  });
  valider.addEventListener('click', async () => {
    if (!dernierCalcul) return;
    const ok = await confirmer({
      titre: `Valider le bulletin ${deMois(mois)} ?`,
      texte: `Net à payer ${montant(dernierCalcul.calcul.net_a_payer)}. Le bulletin est figé : une erreur se corrigera sur le bulletin du mois suivant.`,
      libelle: 'Valider'
    });
    if (!ok) return;
    valider.disabled = true;
    try {
      const brouillon = await sauver();
      const { error } = await supabase.rpc('admin_valider_bulletin', { p_bulletin: brouillon.id });
      if (error) throw error;
      afficherMessage('Bulletin validé.', 'succes');
      location.href = lienAdmin(`rh/?bulletin=${brouillon.id}`);
    } catch (probleme) {
      afficherMessage(messageErreurAdmin(probleme), 'erreur');
      boutons();
    }
  });

  const salaire = s.salaire_base_mensuel !== null ? `${montant(s.salaire_base_mensuel)} par mois` : `${decimal(s.taux_horaire, 2, 4)} € de l'heure`;
  $('contenu').replaceChildren(el('div', { classe: 'preparation' },
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-variables' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-variables', texte: 'Variables du mois' })),
      el('p', { classe: 'aide-module', texte: `${s.matricule} · ${s.emploi} · ${partiel ? `temps partiel, ${heures(s.heures_mensuelles)} par mois` : 'temps plein'} · ${salaire} · prélèvement à la source : ${s.taux_pas !== null ? `taux personnalisé ${decimal(s.taux_pas, 1, 2)} %` : 'taux neutre'}.` }),
      el('fieldset', { classe: 'bloc-variables' }, el('legend', { texte: partiel ? 'Heures complémentaires' : 'Heures supplémentaires' }),
        resumeTemps, el('div', { classe: 'grille-champs grille-champs-2' }, h1.noeud, h2.noeud)),
      absences.noeud, primes.noeud, avantages.noeud, nonSoumis.noeud,
      reprises.length ? el('div', { classe: 'actions-ligne' }, ...reprises) : null,
      el('div', { classe: 'grille-champs grille-champs-2' }, acompte.noeud,
        el('div', { classe: 'champ' }, el('label', { for: 'var-paiement', texte: 'Date de paiement' }), paiement))),
    el('section', { classe: 'carte-admin apercu-colonne', 'aria-labelledby': 'titre-apercu' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-apercu', texte: 'Aperçu calculé par la base' })),
      zoneApercu,
      el('div', { classe: 'actions-ligne' }, enregistrer, valider, voir))));
  calculer();
}
