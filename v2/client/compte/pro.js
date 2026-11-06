// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client, onglet Compte : section « Compte professionnel »
// -----------------------------------------------------------------------------
// Lecture seule : les comptes professionnels sont ouverts et réglés par LOC
// RÉACTION (administration, module Entreprises).
//   - Client rattaché à un compte : raison sociale, statut, son rôle
//     (gestionnaire ou membre), comment s'en servir (« Facture mensuelle » à
//     la commande), SIRET, plafond mensuel, et ce mois-ci : les courses du
//     compte (gestionnaire : il les voit toutes) ou les siennes (membre) ;
//     au gestionnaire, l'adresse de facturation et les dernières courses du
//     mois (date, numéro, montant, facture à ouvrir quand son PDF existe) ;
//   - client sans compte : ce qu'apporte un compte professionnel et
//     « Demander un compte professionnel » (nouvelle demande au support,
//     type « Mon compte », sujet déjà écrit).
// Montant du mois : même calcul que le plafond de la base (courses sur
// facture mensuelle commandées depuis le 1er, heure de Paris ; une course
// annulée compte pour ses seuls frais d'annulation).
// Lectures (règles d'accès de la base) : comptes_pro_membres (les siens),
// comptes_pro (ceux dont il est membre), courses et factures (les siennes ;
// toutes celles du compte pour un gestionnaire).
// Ancre : #compte-pro.
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { t, langueActive } from '../../commun/i18n.js';
import { el, euros, dateHeure, afficherMessage } from '../../commun/outils.js';
import { ouvrirFichier } from '../../commun/fichiers.js';

const $ = (id) => document.getElementById(id);
const DERNIERES = 10;           // courses du mois montrées au gestionnaire
const PARIS = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' });

export function creerSectionPro({ contexte }) {
  const section = el('section', { classe: 'bloc-client', id: 'compte-pro', 'aria-labelledby': 'compte-titre-pro' },
    el('h2', { id: 'compte-titre-pro', texte: t('pro.titre') }),
    el('div', { classe: 'comptes-pro-client', id: 'compte-pro-liste' }),
    el('div', { classe: 'pro-sans-compte', id: 'compte-pro-aucun', hidden: true },
      el('p', { classe: 'aide-client', texte: t('pro.aucun') }),
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'compte-pro-demander', texte: t('pro.demander'),
        onclick: () => contexte.ouvrirSupport({ nouvelle: true, type: 'compte', sujet: t('pro.sujet_demande') }) })));

  async function charger() {
    const moi = contexte.profil.id;
    const membres = await supabase.from('comptes_pro_membres').select('compte_pro_id, role').eq('profil_id', moi);
    if (membres.error) throw membres.error;
    const adhesions = membres.data || [];
    $('compte-pro-aucun').hidden = adhesions.length > 0;
    if (!adhesions.length) {
      $('compte-pro-liste').replaceChildren();
      return;
    }
    const ids = adhesions.map((m) => m.compte_pro_id);
    // Courses sur facture mensuelle des 32 derniers jours : le mois en cours (heure de Paris) est retenu ensuite
    const depuis = new Date(Date.now() - 32 * 86400000).toISOString();
    const [comptes, courses] = await Promise.all([
      supabase.from('comptes_pro').select('id, raison_sociale, siret, adresse, code_postal, ville, email_facturation, plafond_mensuel, statut')
        .in('id', ids).order('raison_sociale'),
      supabase.from('courses').select('id, numero, client_id, compte_pro_id, statut, prix_total, frais_attente, frais_annulation, cree_le')
        .in('compte_pro_id', ids).eq('mode_paiement', 'facture_mensuelle').gte('cree_le', depuis)
        .order('cree_le', { ascending: false }).limit(1000)
    ]);
    for (const r of [comptes, courses]) if (r.error) throw r.error;
    const moisCourant = PARIS.format(new Date());
    const duMois = (courses.data || []).filter((c) => PARIS.format(new Date(c.cree_le)) === moisCourant);

    // Gestionnaire : factures des dernières courses montrées (une seule lecture)
    const comptesGeres = adhesions.filter((m) => m.role === 'gestionnaire').map((m) => m.compte_pro_id);
    const montrees = comptesGeres.flatMap((id) => duMois.filter((c) => c.compte_pro_id === id).slice(0, DERNIERES));
    const factures = {};
    if (montrees.length) {
      const { data } = await supabase.from('factures').select('id, numero, course_id, pdf_chemin, nature')
        .in('course_id', montrees.map((c) => c.id));
      (data || []).forEach((f) => { (factures[f.course_id] = factures[f.course_id] || []).push(f); });
    }

    $('compte-pro-liste').replaceChildren(...(comptes.data || []).map((compte) => {
      const role = (adhesions.find((m) => m.compte_pro_id === compte.id) || {}).role;
      const gestionnaire = role === 'gestionnaire';
      // Gestionnaire : toutes les courses du compte ; membre : les siennes
      const retenues = duMois.filter((c) => c.compte_pro_id === compte.id && (gestionnaire || c.client_id === moi));
      const montant = retenues.reduce((total, c) => total + (c.statut === 'annulee'
        ? Number(c.frais_annulation) || 0
        : (Number(c.prix_total) || 0) + (Number(c.frais_attente) || 0)), 0);
      const n = retenues.length;
      const cle = gestionnaire ? 'pro.mois_compte' : 'pro.mois_moi';
      const ceMois = n === 0 ? t(`${cle}_zero`) : t(n === 1 ? `${cle}_un` : `${cle}_n`, { n, montant: euros(montant) });
      const actif = compte.statut === 'actif';
      const lignes = [
        compte.siret ? [t('pro.siret'), compte.siret.replace(/^(\d{3})(\d{3})(\d{3})(\d{5})$/, '$1 $2 $3 $4')] : null,
        [t('pro.plafond'), compte.plafond_mensuel !== null && compte.plafond_mensuel !== undefined ? euros(compte.plafond_mensuel) : t('pro.sans_plafond')],
        [t('pro.ce_mois'), ceMois],
        gestionnaire ? [t('pro.facturation'), [compte.email_facturation,
          [compte.adresse, [compte.code_postal, compte.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(' · ')] : null
      ].filter(Boolean);
      return el('article', { classe: 'compte-pro-client', id: `compte-pro-${compte.id}`, dataset: { statut: compte.statut, role: role || '' } },
        el('div', { classe: 'entete-bloc' },
          el('h3', { classe: 'compte-pro-nom', texte: compte.raison_sociale }),
          el('span', { classe: 'pastille-statut-pro', dataset: { statut: compte.statut }, texte: t(actif ? 'pro.actif' : 'pro.suspendu') })),
        el('p', { classe: 'aide-client', texte: t(gestionnaire ? 'pro.role_gestionnaire' : 'pro.role_membre') }),
        el('p', { classe: actif ? 'pro-utiliser' : 'alerte', texte: actif ? t('pro.utiliser', { raison: compte.raison_sociale }) : t('pro.suspendu_texte') }),
        el('dl', { classe: 'lignes-client' }, ...lignes.flatMap(([libelle, valeur]) => [el('dt', { texte: libelle }), el('dd', { texte: valeur })])),
        gestionnaire && retenues.length ? listeGestionnaire(retenues, factures) : null);
    }));
  }

  // Les dernières courses du mois du compte, pour son gestionnaire
  function listeGestionnaire(courses, factures) {
    const montrees = courses.slice(0, DERNIERES);
    return el('div', { classe: 'pro-courses' },
      el('h4', { classe: 'pro-courses-titre', texte: t('pro.dernieres') }),
      el('ul', { classe: 'mouvements-client' }, ...montrees.map((c) => {
        const montant = c.statut === 'annulee' ? Number(c.frais_annulation) || 0 : (Number(c.prix_total) || 0) + (Number(c.frais_attente) || 0);
        return el('li', { classe: 'mouvement-client', dataset: { statut: c.statut } },
          el('span', { classe: 'mouvement-texte' },
            el('span', { classe: 'mouvement-motif', texte: c.numero }),
            el('span', { classe: 'mouvement-date', texte: [dateHeure(c.cree_le, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
              c.statut === 'annulee' ? t('pro.annulee') : null].filter(Boolean).join(' · ') }),
            ...(factures[c.id] || []).map((f) => (f.pdf_chemin
              ? el('button', { type: 'button', classe: 'bouton bouton-texte mouvement-course', texte: t('pro.facture', { numero: f.numero }),
                onclick: () => ouvrirFichier('factures', f.pdf_chemin).catch((e) => afficherMessage(messageErreur(e, langueActive()), 'erreur')) })
              : el('span', { classe: 'mouvement-date', texte: t('pro.facture', { numero: f.numero }) })))),
          el('span', { classe: 'mouvement-montant', texte: euros(montant) }));
      })),
      courses.length > DERNIERES ? el('p', { classe: 'aide-client', texte: t('pro.et_autres', { n: courses.length - DERNIERES }) }) : null);
  }

  return { section, charger };
}
