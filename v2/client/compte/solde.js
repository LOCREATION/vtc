// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client, onglet Compte : section « Mon solde »
// -----------------------------------------------------------------------------
// Le solde du client (crédits de parrainage, gestes commerciaux de LOC
// RÉACTION) et ses 10 derniers mouvements : date, motif, montant (+ crédit,
// − débit), course concernée.
// Le paiement des courses avec le solde arrive dans une prochaine version :
// la section le dit, pour qu'aucun client ne s'attende à payer ainsi.
// Lectures (règles d'accès de la base : chacun voit les siens) : soldes,
// ecritures_solde, courses (numéro de la course d'un mouvement).
// Ancre : #compte-solde (lien des notifications « Parrainage validé »).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { t, lienAvecLangue } from '../../commun/i18n.js';
import { el, euros, dateHeure } from '../../commun/outils.js';

const $ = (id) => document.getElementById(id);
const MOUVEMENTS = 10;

// Motifs écrits par la base : traduits quand on les connaît, sinon tels quels
const MOTIFS = {
  'Parrainage validé': 'solde.motif_parrainage',
  'Bienvenue : parrainage': 'solde.motif_bienvenue'
};

export function creerSectionSolde({ contexte }) {
  const section = el('section', { classe: 'bloc-client', id: 'compte-solde', 'aria-labelledby': 'compte-titre-solde' },
    el('h2', { id: 'compte-titre-solde', texte: t('solde.titre') }),
    el('p', { classe: 'solde-montant', id: 'compte-solde-montant' }),
    el('p', { classe: 'aide-client', texte: t('solde.aide') }),
    el('h3', { classe: 'sous-titre-compte', id: 'compte-titre-mouvements', texte: t('solde.mouvements') }),
    el('p', { classe: 'aide-client', id: 'compte-mouvements-vide', hidden: true, texte: t('solde.aucun_mouvement') }),
    el('ul', { classe: 'mouvements-client', id: 'compte-mouvements', 'aria-labelledby': 'compte-titre-mouvements' }));

  async function charger() {
    const moi = contexte.profil.id;
    const [solde, ecritures] = await Promise.all([
      supabase.from('soldes').select('montant').eq('profil_id', moi).maybeSingle(),
      supabase.from('ecritures_solde').select('id, montant, motif, course_id, cree_le')
        .eq('profil_id', moi).order('cree_le', { ascending: false }).limit(MOUVEMENTS)
    ]);
    for (const r of [solde, ecritures]) if (r.error) throw r.error;
    const mouvements = ecritures.data || [];

    // Numéros des courses concernées (une seule lecture)
    const idsCourses = [...new Set(mouvements.map((m) => m.course_id).filter(Boolean))];
    const numeros = {};
    if (idsCourses.length) {
      const { data } = await supabase.from('courses').select('id, numero').in('id', idsCourses);
      (data || []).forEach((c) => { numeros[c.id] = c.numero; });
    }

    $('compte-solde-montant').textContent = euros(solde.data ? solde.data.montant : 0);
    $('compte-mouvements-vide').hidden = mouvements.length > 0;
    $('compte-mouvements').replaceChildren(...mouvements.map((m) => {
      const montant = Number(m.montant);
      const motif = MOTIFS[m.motif] ? t(MOTIFS[m.motif]) : m.motif;
      return el('li', { classe: 'mouvement-client', dataset: { sens: montant >= 0 ? 'credit' : 'debit' } },
        el('span', { classe: 'mouvement-texte' },
          el('span', { classe: 'mouvement-motif', texte: motif }),
          el('span', { classe: 'mouvement-date', texte: dateHeure(m.cree_le, { day: 'numeric', month: 'short', year: 'numeric' }) }),
          m.course_id && numeros[m.course_id]
            ? el('a', { classe: 'mouvement-course', href: lienAvecLangue(`course/?id=${encodeURIComponent(m.course_id)}`),
              texte: t('solde.course', { numero: numeros[m.course_id] }) })
            : null),
        el('span', { classe: 'mouvement-montant', texte: `${montant >= 0 ? '+' : '−'}${euros(Math.abs(montant))}` }));
    }));
  }

  return { section, charger };
}
