// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client, onglet Compte : section « Mon portefeuille »
// -----------------------------------------------------------------------------
// - Le solde, ce qui est disponible pour les courses (solde moins les courses
//   à venir payées avec le portefeuille), le reste dû s'il y en a un.
// - « Recharger » : montant au choix (10, 20, 50, 100 € ou autre, de 5 € à
//   500 €), puis « Payer … avec Mollie » : la fonction du serveur « mollie »
//   enregistre la recharge et crée le paiement chez Mollie ; le client part
//   sur la page sécurisée de Mollie (carte, Apple Pay…), puis revient ici
//   (?recharge=<id>, lu par client.js) : l'état est relu chez Mollie et
//   affiché (payée : nouveau solde ; annulée, échouée, expirée : rien n'a été
//   prélevé ; en attente : le client sera prévenu). Le portefeuille n'est
//   crédité que par la base, sur l'état lu chez Mollie : jamais par la page.
// - « Mes recharges » : les 10 dernières, avec leur état.
// - Derniers mouvements : recharges, courses, pourboires, frais, rembourse-
//   ments, parrainage, gestes de LOC RÉACTION (motifs traduits).
// Le bouton « Recharger » de l'accueil ouvre directement le formulaire
// (contexte.recharge.ouvrir).
// Lectures : mon_portefeuille, ecritures_solde, courses (numéros), et la
// fonction du serveur « mollie » (créer, vérifier) ; ma_recharge en secours.
// Ancres : #compte-solde (notifications), #compte-recharger (formulaire).
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { t, lienAvecLangue, langueActive } from '../../commun/i18n.js';
import { el, euros, dateHeure } from '../../commun/outils.js';

const $ = (id) => document.getElementById(id);
const MOUVEMENTS = 10;
const MONTANTS = [10, 20, 50, 100];
const ETATS_FINIS = ['payee', 'echouee', 'annulee', 'expiree'];
let ancreLue = false;            // #compte-recharger : formulaire ouvert une fois

// Motifs écrits par la base : traduits quand on les reconnaît, sinon tels quels
const MOTIFS = {
  'Parrainage validé': 'solde.motif_parrainage',
  'Bienvenue : parrainage': 'solde.motif_bienvenue'
};
const MOTIFS_NUMEROTES = [
  [/^Recharge (R-\d{4}-\d{6})$/, 'solde.motif_recharge'],
  [/^Course (C-\d{4}-\d{6}) \(reste dû\)$/, 'solde.motif_course_reste'],
  [/^Course (C-\d{4}-\d{6})$/, 'solde.motif_course'],
  [/^Pourboire (C-\d{4}-\d{6})(?: \(reste dû\))?$/, 'solde.motif_pourboire'],
  [/^Frais d'annulation (C-\d{4}-\d{6})(?: \(reste dû\))?$/, 'solde.motif_frais'],
  [/^Remboursement (C-\d{4}-\d{6})$/, 'solde.motif_remboursement']
];

function motifLisible(motif) {
  if (MOTIFS[motif]) return t(MOTIFS[motif]);
  for (const [motifBase, cle] of MOTIFS_NUMEROTES) {
    const m = motifBase.exec(motif);
    if (m) return t(cle, { numero: m[1] });
  }
  return motif;
}

// Montant saisi (« 25 », « 25,50 », « 25.5 ») en nombre, sinon null
function lireMontant(texte) {
  const brut = String(texte || '').trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(brut)) return null;
  return Number(brut);
}

const attendre = (ms) => new Promise((resoudre) => { setTimeout(resoudre, ms); });

// Montant rond sans centimes (« 100 € », « €100 ») pour les pastilles
function eurosRonds(montant) {
  return new Intl.NumberFormat(langueActive() === 'en' ? 'en-GB' : 'fr-FR',
    { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(montant);
}

// Fonction du serveur « mollie » : réponse, ou message d'erreur lisible
async function appelMollie(corps) {
  const { data, error } = await supabase.functions.invoke('mollie', { body: corps });
  if (!error) return { donnees: data };
  let message = null;
  try {
    const reponse = error.context && typeof error.context.json === 'function' ? await error.context.json() : null;
    message = reponse && reponse.erreur ? reponse.erreur : null;
  } catch (_) { /* réponse illisible */ }
  return { erreur: message || messageErreur(error, langueActive()) };
}

export function creerSectionSolde({ contexte }) {
  const etat = { portefeuille: null, montant: 20, envoi: false };

  // --- Montants proposés et montant libre ---------------------------------
  const pastilles = MONTANTS.map((m) => {
    const b = el('button', { type: 'button', classe: 'pastille-montant', dataset: { montant: String(m) },
      'aria-pressed': String(m === etat.montant), texte: eurosRonds(m) });
    b.addEventListener('click', () => { $('recharge-autre').value = ''; choisirMontant(m); });
    return b;
  });
  const autre = el('input', { id: 'recharge-autre', classe: 'saisie', type: 'text', inputmode: 'decimal', autocomplete: 'off',
    maxlength: '6', 'aria-describedby': 'recharge-bornes recharge-erreur' });
  autre.addEventListener('input', () => {
    $('recharge-erreur').hidden = true;
    const m = lireMontant(autre.value);
    choisirMontant(autre.value.trim() ? m : 20, autre.value.trim() !== '');
  });

  const formulaire = el('form', { classe: 'recharge-formulaire', id: 'compte-recharge', novalidate: true, hidden: true,
    'aria-labelledby': 'compte-titre-recharge' },
    el('h3', { classe: 'sous-titre-compte', id: 'compte-titre-recharge', texte: t('recharge.titre') }),
    el('fieldset', { classe: 'recharge-montants' },
      el('legend', { classe: 'etiquette', texte: t('recharge.montant') }),
      el('div', { classe: 'pastilles-montant' }, ...pastilles),
      el('div', { classe: 'champ' },
        el('label', { for: 'recharge-autre', texte: t('recharge.autre') }), autre,
        el('p', { classe: 'aide', id: 'recharge-bornes' }))),
    el('div', { classe: 'recharge-securite' },
      iconeCadenas(),
      el('div', {},
        el('p', { classe: 'recharge-securite-titre', texte: t('recharge.securite_titre') }),
        el('ul', {}, ...['recharge.securite_1', 'recharge.securite_2', 'recharge.securite_3'].map((cle) => el('li', { texte: t(cle) }))))),
    el('p', { classe: 'erreur-champ', id: 'recharge-erreur', role: 'alert', hidden: true }),
    el('div', { classe: 'recharge-actions' },
      el('button', { type: 'submit', classe: 'bouton bouton-principal bouton-large', id: 'recharge-payer' }),
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'recharge-fermer', texte: t('recharge.fermer'),
        onclick: () => fermerFormulaire() })));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); payer(); });

  const section = el('section', { classe: 'bloc-client', id: 'compte-solde', 'aria-labelledby': 'compte-titre-solde' },
    el('h2', { id: 'compte-titre-solde', texte: t('solde.titre') }),
    el('div', { classe: 'portefeuille-resume' },
      el('p', { classe: 'solde-montant', id: 'compte-solde-montant' }),
      el('p', { classe: 'aide-client', id: 'compte-solde-detail' }),
      el('p', { classe: 'alerte', id: 'compte-solde-du', hidden: true })),
    el('div', { classe: 'recharge-etat', id: 'compte-recharge-etat', role: 'status', 'aria-live': 'polite', hidden: true }),
    el('div', { id: 'compte-recharger' },
      el('button', { type: 'button', classe: 'bouton bouton-principal', id: 'compte-ouvrir-recharge', texte: t('portefeuille.recharger'),
        onclick: () => ouvrirFormulaire() }),
      formulaire),
    el('p', { classe: 'aide-client', texte: t('solde.aide') }),
    el('h3', { classe: 'sous-titre-compte', id: 'compte-titre-recharges', hidden: true, texte: t('recharge.mes_recharges') }),
    el('ul', { classe: 'mouvements-client', id: 'compte-recharges', hidden: true, 'aria-labelledby': 'compte-titre-recharges' }),
    el('h3', { classe: 'sous-titre-compte', id: 'compte-titre-mouvements', texte: t('solde.mouvements') }),
    el('p', { classe: 'aide-client', id: 'compte-mouvements-vide', hidden: true, texte: t('solde.aucun_mouvement') }),
    el('ul', { classe: 'mouvements-client', id: 'compte-mouvements', 'aria-labelledby': 'compte-titre-mouvements' }));

  function bornes() {
    const pf = etat.portefeuille || { recharge_min: 5, recharge_max: 500 };
    return { min: Number(pf.recharge_min) || 5, max: Number(pf.recharge_max) || 500 };
  }

  function choisirMontant(montant, libre = false) {
    etat.montant = montant;
    pastilles.forEach((b) => b.setAttribute('aria-pressed', String(!libre && Number(b.dataset.montant) === montant)));
    $('recharge-payer').textContent = montant ? t('recharge.payer', { montant: euros(montant) }) : t('recharge.choisir');
  }

  function ouvrirFormulaire() {
    $('compte-ouvrir-recharge').hidden = true;
    formulaire.hidden = false;
    $('recharge-erreur').hidden = true;
    const { min, max } = bornes();
    $('recharge-bornes').textContent = t('recharge.bornes', { min: euros(min), max: euros(max) });
    choisirMontant(lireMontant(autre.value) || etat.montant || 20, !!autre.value.trim());
    $('compte-recharger').scrollIntoView({ block: 'start' });
    pastilles.find((b) => b.getAttribute('aria-pressed') === 'true')?.focus();
  }

  function fermerFormulaire() {
    formulaire.hidden = true;
    $('compte-ouvrir-recharge').hidden = false;
  }

  async function payer() {
    if (etat.envoi) return;
    const { min, max } = bornes();
    const montant = etat.montant;
    if (!montant || montant < min || montant > max) {
      $('recharge-erreur').textContent = t('recharge.montant_invalide', { min: euros(min), max: euros(max) });
      $('recharge-erreur').hidden = false;
      autre.focus();
      return;
    }
    etat.envoi = true;
    const bouton = $('recharge-payer');
    bouton.disabled = true;
    bouton.textContent = t('recharge.envoi');
    const { donnees, erreur } = await appelMollie({ action: 'creer', montant, langue: langueActive() });
    if (erreur || !donnees || !/^https:\/\//.test(donnees.lien || '')) {
      etat.envoi = false;
      bouton.disabled = false;
      choisirMontant(montant, !!autre.value.trim());
      $('recharge-erreur').textContent = erreur || messageErreur(null, langueActive());
      $('recharge-erreur').hidden = false;
      return;
    }
    // Page de paiement de Mollie ; retour ici à la fin (?recharge=…)
    location.assign(donnees.lien);
  }

  // Retour de Mollie : l'état est relu chez Mollie (fonction du serveur), à
  // défaut dans la base, jusqu'à ce qu'il soit connu (16 secondes au plus)
  async function verifierRecharge(id) {
    afficherEtat('attente', t('recharge.verification'));
    let recharge = null;
    for (let essai = 0; essai < 8; essai += 1) {
      const { donnees } = await appelMollie({ action: 'verifier', recharge: id });
      recharge = donnees || null;
      if (!recharge) {
        const { data } = await supabase.rpc('ma_recharge', { p_recharge: id });
        recharge = data || null;
      }
      if (recharge && ETATS_FINIS.includes(recharge.statut)) break;
      await attendre(2000);
    }
    if (!recharge) { afficherEtat('erreur', t('recharge.echouee')); return; }
    // Solde et listes relus d'abord : le message arrive avec les bons montants
    try { await charger({ verifier: false }); } catch (_) { /* le message suffit */ }
    if (recharge.statut === 'payee') {
      afficherEtat('succes', t('recharge.payee', { montant: euros(recharge.montant), solde: euros(recharge.solde) }));
    } else if (['echouee', 'annulee', 'expiree'].includes(recharge.statut)) {
      afficherEtat(recharge.statut === 'echouee' ? 'erreur' : 'info', t(`recharge.${recharge.statut}`));
    } else {
      afficherEtat('info', t('recharge.attente'));
    }
  }

  function afficherEtat(ton, texte) {
    const zone = $('compte-recharge-etat');
    zone.hidden = false;
    zone.dataset.ton = ton;
    // (pas de null passé : replaceChildren(null) écrirait « null »)
    zone.replaceChildren(...[ton === 'attente' ? el('span', { classe: 'roue', 'aria-hidden': 'true' }) : null,
      el('span', { texte })].filter(Boolean));
  }

  async function charger({ verifier = true } = {}) {
    const moi = contexte.profil.id;
    const [portefeuille, ecritures] = await Promise.all([
      supabase.rpc('mon_portefeuille'),
      supabase.from('ecritures_solde').select('id, montant, motif, course_id, cree_le')
        .eq('profil_id', moi).order('cree_le', { ascending: false }).limit(MOUVEMENTS)
    ]);
    for (const r of [portefeuille, ecritures]) if (r.error) throw r.error;
    const pf = portefeuille.data;
    etat.portefeuille = pf;
    const mouvements = ecritures.data || [];

    // Numéros des courses concernées (une seule lecture)
    const idsCourses = [...new Set(mouvements.map((m) => m.course_id).filter(Boolean))];
    const numeros = {};
    if (idsCourses.length) {
      const { data } = await supabase.from('courses').select('id, numero').in('id', idsCourses);
      (data || []).forEach((c) => { numeros[c.id] = c.numero; });
    }

    const solde = Number(pf.solde) || 0;
    const engage = Number(pf.engage) || 0;
    const du = Number(pf.du) || 0;
    $('compte-solde-montant').textContent = euros(solde);
    $('compte-solde-detail').textContent = engage > 0
      ? `${t('solde.disponible', { montant: euros(pf.disponible) })} · ${t('solde.reserve', { montant: euros(engage) })}`
      : t('solde.disponible', { montant: euros(pf.disponible) });
    $('compte-solde-du').hidden = du <= 0;
    $('compte-solde-du').textContent = du > 0 ? t('solde.du', { montant: euros(du) }) : '';

    const recharges = pf.recharges || [];
    $('compte-titre-recharges').hidden = !recharges.length;
    $('compte-recharges').hidden = !recharges.length;
    $('compte-recharges').replaceChildren(...recharges.map((r) => el('li', { classe: 'mouvement-client', dataset: { statut: r.statut } },
      el('span', { classe: 'mouvement-texte' },
        el('span', { classe: 'mouvement-motif', texte: t('recharge.ligne', { numero: r.numero }) }),
        el('span', { classe: 'mouvement-date', texte: dateHeure(r.payee_le || r.cree_le, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }),
        el('span', { classe: 'etat-recharge', dataset: { statut: r.statut }, texte: t(`recharge.statut.${r.statut}`) })),
      el('span', { classe: 'mouvement-montant', texte: euros(r.montant) }))));

    $('compte-mouvements-vide').hidden = mouvements.length > 0;
    $('compte-mouvements').replaceChildren(...mouvements.map((m) => {
      const montant = Number(m.montant);
      return el('li', { classe: 'mouvement-client', dataset: { sens: montant >= 0 ? 'credit' : 'debit' } },
        el('span', { classe: 'mouvement-texte' },
          el('span', { classe: 'mouvement-motif', texte: motifLisible(m.motif) }),
          el('span', { classe: 'mouvement-date', texte: dateHeure(m.cree_le, { day: 'numeric', month: 'short', year: 'numeric' }) }),
          m.course_id && numeros[m.course_id]
            ? el('a', { classe: 'mouvement-course', href: lienAvecLangue(`course/?id=${encodeURIComponent(m.course_id)}`),
              texte: t('solde.course', { numero: numeros[m.course_id] }) })
            : null),
        el('span', { classe: 'mouvement-montant', texte: `${montant >= 0 ? '+' : '−'}${euros(Math.abs(montant))}` }));
    }));

    // Demandes venues d'ailleurs, prises une seule fois : retour de Mollie
    // (client.js), bouton « Recharger » de l'accueil
    const demande = contexte.recharge || {};
    if (!ancreLue) {
      ancreLue = true;
      if (location.hash === '#compte-recharger') demande.ouvrir = true;
    }
    if (verifier && demande.verifier) {
      const id = demande.verifier;
      demande.verifier = null;
      verifierRecharge(id);
    }
    if (demande.ouvrir) {
      demande.ouvrir = false;
      ouvrirFormulaire();
    }
  }

  return { section, charger };
}

function iconeCadenas() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '26');
  svg.setAttribute('height', '26');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const corps = document.createElementNS(ns, 'rect');
  corps.setAttribute('x', '4');
  corps.setAttribute('y', '10');
  corps.setAttribute('width', '16');
  corps.setAttribute('height', '11');
  corps.setAttribute('rx', '2');
  const anse = document.createElementNS(ns, 'path');
  anse.setAttribute('d', 'M8 10V7a4 4 0 0 1 8 0v3');
  svg.append(corps, anse);
  svg.classList.add('recharge-cadenas');
  return svg;
}
