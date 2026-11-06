// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client, onglet Compte : section « Parrainage et codes promo »
// -----------------------------------------------------------------------------
//   - Mon code de parrainage, « Partager mon lien » (feuille de partage du
//     téléphone : WhatsApp, SMS… ; sinon le lien est copié) et « Copier le
//     code ». Le lien mène à la création de compte avec le code
//     (connexion/?parrain=CODE) ;
//   - mes filleuls : combien se sont inscrits avec mon code, combien de
//     parrainages sont validés (première course terminée du filleul) et ce
//     qu'ils m'ont rapporté ;
//   - si j'ai été parrainé : où en est mon parrainage ;
//   - « Vous avez un code de parrainage ? » : tant que je n'ai ni parrain ni
//     course terminée (fonction appliquer_code_parrain) ;
//   - codes promo : où les saisir (à la commande) et ceux déjà utilisés.
// Montants des récompenses : réglages de LOC RÉACTION (parametres).
// Lectures (règles d'accès de la base) : parametres, parrainages (les miens,
// comme parrain ou filleul), courses (en ai-je une terminée ? numéros),
// utilisations_promo (les miennes).
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { RACINE } from '../../commun/config.js';
import { t, langueActive, lienAvecLangue } from '../../commun/i18n.js';
import { el, euros, dateHeure, afficherMessage } from '../../commun/outils.js';

const $ = (id) => document.getElementById(id);
const erreurLisible = (e) => messageErreur(e, langueActive());
const jour = (instant) => dateHeure(instant, { day: 'numeric', month: 'long', year: 'numeric' });

export function creerSectionParrainage({ contexte }) {
  const etat = { recompenses: { parrain: 0, filleul: 0 } };

  const formulaireCode = el('form', { classe: 'code-parrain-client', id: 'compte-code-parrain-formulaire', novalidate: true, hidden: true },
    el('label', { for: 'compte-code-parrain', texte: t('parrainage.saisir') }),
    el('div', { classe: 'ligne-code' },
      el('input', { id: 'compte-code-parrain', classe: 'saisie', type: 'text', autocomplete: 'off', autocapitalize: 'characters',
        spellcheck: 'false', maxlength: '24', placeholder: 'K7M2Q9XA', 'aria-describedby': 'compte-code-parrain-erreur' }),
      el('button', { type: 'submit', classe: 'bouton bouton-secondaire', id: 'compte-code-parrain-valider', texte: t('parrainage.valider') })),
    el('p', { classe: 'erreur-champ', id: 'compte-code-parrain-erreur', hidden: true }));
  formulaireCode.addEventListener('submit', (e) => { e.preventDefault(); appliquerCode(); });
  formulaireCode.addEventListener('input', () => marquerCode(null));

  const section = el('section', { classe: 'bloc-client', id: 'compte-parrainage', 'aria-labelledby': 'compte-titre-parrainage' },
    el('h2', { id: 'compte-titre-parrainage', texte: t('parrainage.titre') }),
    el('p', { classe: 'aide-client', id: 'compte-parrainage-offre' }),
    el('div', { classe: 'code-parrainage' },
      el('span', { classe: 'code-parrainage-libelle', id: 'compte-code-libelle', texte: t('parrainage.mon_code') }),
      el('strong', { classe: 'code-parrainage-valeur', id: 'compte-code-parrainage', 'aria-labelledby': 'compte-code-libelle' })),
    el('div', { classe: 'actions-client actions-larges' },
      el('button', { type: 'button', classe: 'bouton bouton-principal', id: 'compte-partager', texte: t('parrainage.partager'), onclick: partager }),
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'compte-copier-code', texte: t('parrainage.copier'), onclick: copierCode })),
    el('p', { classe: 'aide-client', id: 'compte-filleuls', role: 'status' }),
    el('p', { classe: 'alerte alerte-info', id: 'compte-mon-parrainage', hidden: true }),
    formulaireCode,
    el('h3', { classe: 'sous-titre-compte', id: 'compte-titre-promos', texte: t('parrainage.codes_promo') }),
    el('p', { classe: 'aide-client', texte: t('parrainage.promo_aide') }),
    el('p', { classe: 'aide-client', id: 'compte-promos-vide', hidden: true, texte: t('parrainage.promo_aucun') }),
    el('ul', { classe: 'mouvements-client', id: 'compte-promos', 'aria-labelledby': 'compte-titre-promos' }));

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------
  async function charger() {
    const moi = contexte.profil.id;
    const [reglages, parrainages, terminee, promos] = await Promise.all([
      supabase.from('parametres').select('recompense_parrain, recompense_filleul').maybeSingle(),
      supabase.from('parrainages').select('id, parrain_id, filleul_id, statut, recompense_parrain, recompense_filleul, valide_le, cree_le')
        .order('cree_le', { ascending: false }),
      supabase.from('courses').select('id').eq('client_id', moi).eq('statut', 'terminee').limit(1),
      supabase.from('utilisations_promo').select('id, remise, course_id, cree_le').eq('client_id', moi)
        .order('cree_le', { ascending: false }).limit(20)
    ]);
    for (const r of [reglages, parrainages, terminee, promos]) if (r.error) throw r.error;
    etat.recompenses = {
      parrain: Number(reglages.data ? reglages.data.recompense_parrain : 0) || 0,
      filleul: Number(reglages.data ? reglages.data.recompense_filleul : 0) || 0
    };
    const lignes = parrainages.data || [];
    const mesFilleuls = lignes.filter((p) => p.parrain_id === moi);
    const monParrainage = lignes.find((p) => p.filleul_id === moi) || null;

    // Numéros des courses des codes promo (une seule lecture)
    const utilisations = promos.data || [];
    const ids = [...new Set(utilisations.map((u) => u.course_id).filter(Boolean))];
    const numeros = {};
    if (ids.length) {
      const { data } = await supabase.from('courses').select('id, numero').in('id', ids);
      (data || []).forEach((c) => { numeros[c.id] = c.numero; });
    }

    afficherOffre();
    $('compte-code-parrainage').textContent = contexte.profil.code_parrainage || '';
    afficherFilleuls(mesFilleuls);
    afficherMonParrainage(monParrainage);
    formulaireCode.hidden = !!monParrainage || (terminee.data || []).length > 0;
    afficherPromos(utilisations, numeros);
  }

  function afficherOffre() {
    const { parrain, filleul } = etat.recompenses;
    $('compte-parrainage-offre').textContent = parrain > 0 && filleul > 0
      ? t('parrainage.offre', { filleul: euros(filleul), parrain: euros(parrain) })
      : parrain > 0 ? t('parrainage.offre_parrain', { parrain: euros(parrain) })
        : filleul > 0 ? t('parrainage.offre_filleul', { filleul: euros(filleul) })
          : t('parrainage.offre_sans');
  }

  function afficherFilleuls(filleuls) {
    const inscrits = filleuls.filter((p) => p.statut !== 'annule');
    const valides = filleuls.filter((p) => p.statut === 'valide');
    const gagne = valides.reduce((total, p) => total + (Number(p.recompense_parrain) || 0), 0);
    let texte;
    if (!inscrits.length) texte = t('parrainage.aucun_filleul');
    else {
      texte = inscrits.length > 1 ? t('parrainage.filleuls', { n: inscrits.length }) : t('parrainage.filleul');
      texte += ' ' + (!valides.length ? t('parrainage.aucun_valide')
        : valides.length > 1 ? t('parrainage.valides', { n: valides.length, montant: euros(gagne) })
          : t('parrainage.valide', { montant: euros(gagne) }));
    }
    $('compte-filleuls').textContent = texte;
  }

  function afficherMonParrainage(p) {
    const zone = $('compte-mon-parrainage');
    zone.hidden = !p;
    if (!p) return;
    zone.textContent = p.statut === 'valide'
      ? t('parrainage.moi_valide', { date: jour(p.valide_le), montant: euros(p.recompense_filleul) })
      : p.statut === 'annule'
        ? t('parrainage.moi_annule')
        : etat.recompenses.filleul > 0
          ? t('parrainage.moi_attente', { montant: euros(etat.recompenses.filleul) })
          : t('parrainage.moi_attente_sans');
  }

  function afficherPromos(utilisations, numeros) {
    $('compte-promos-vide').hidden = utilisations.length > 0;
    $('compte-promos').replaceChildren(...utilisations.map((u) => el('li', { classe: 'mouvement-client', dataset: { sens: 'remise' } },
      el('span', { classe: 'mouvement-texte' },
        el('span', { classe: 'mouvement-motif', texte: t('parrainage.promo_remise') }),
        el('span', { classe: 'mouvement-date', texte: dateHeure(u.cree_le, { day: 'numeric', month: 'short', year: 'numeric' }) }),
        u.course_id && numeros[u.course_id]
          ? el('a', { classe: 'mouvement-course', href: lienAvecLangue(`course/?id=${encodeURIComponent(u.course_id)}`),
            texte: t('solde.course', { numero: numeros[u.course_id] }) })
          : null),
      el('span', { classe: 'mouvement-montant', texte: `−${euros(u.remise)}` }))));
  }

  // ---------------------------------------------------------------------------
  // Partager le lien, copier le code
  // ---------------------------------------------------------------------------
  function lienInvitation() {
    const code = contexte.profil.code_parrainage || '';
    const adresse = new URL(`${RACINE}connexion/`, location.origin);
    adresse.searchParams.set('parrain', code);
    if (langueActive() === 'en') adresse.searchParams.set('lang', 'en');
    return adresse.href;
  }

  async function partager() {
    const url = lienInvitation();
    const texte = etat.recompenses.filleul > 0
      ? t('parrainage.message', { montant: euros(etat.recompenses.filleul) })
      : t('parrainage.message_sans');
    if (navigator.share) {
      try {
        await navigator.share({ title: 'LOC RÉACTION', text: texte, url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;      // partage fermé par la personne
      }
    }
    await copier(`${texte} ${url}`, t('parrainage.lien_copie'));
  }

  function copierCode() {
    return copier(contexte.profil.code_parrainage || '', t('parrainage.code_copie'));
  }

  async function copier(texte, confirmation) {
    try {
      await navigator.clipboard.writeText(texte);
      afficherMessage(confirmation, 'succes');
    } catch {
      afficherMessage(t('parrainage.copie_impossible', { texte }), 'info');
    }
  }

  // ---------------------------------------------------------------------------
  // « Vous avez un code de parrainage ? »
  // ---------------------------------------------------------------------------
  async function appliquerCode() {
    const code = $('compte-code-parrain').value.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z0-9]{4,20}$/.test(code)) {
      marquerCode(t('parrainage.code_format'));
      $('compte-code-parrain').focus();
      return;
    }
    $('compte-code-parrain-valider').disabled = true;
    try {
      const { error } = await supabase.rpc('appliquer_code_parrain', { p_code: code });
      if (error) throw error;
      $('compte-code-parrain').value = '';
      await charger();
      afficherMessage(t('parrainage.code_enregistre'), 'succes');
    } catch (e) {
      marquerCode(erreurCode(e));
      $('compte-code-parrain').focus();
    } finally {
      $('compte-code-parrain-valider').disabled = false;
    }
  }

  // Refus de la base (messages en français) : le texte de la langue choisie
  function erreurCode(e) {
    const brut = (e && e.message) || '';
    const connus = [
      [/introuvable/i, 'parrainage.erreur_introuvable'],
      [/propre code/i, 'parrainage.erreur_propre'],
      [/déjà un parrain/i, 'parrainage.erreur_deja'],
      [/première course terminée/i, 'parrainage.erreur_course'],
      [/déjà votre filleul/i, 'parrainage.erreur_croise'],
      [/invalide/i, 'parrainage.code_format']
    ];
    const trouve = connus.find(([motif]) => motif.test(brut));
    return trouve ? t(trouve[1]) : erreurLisible(e);
  }

  function marquerCode(texte) {
    const champ = $('compte-code-parrain');
    const zone = $('compte-code-parrain-erreur');
    if (texte) champ.setAttribute('aria-invalid', 'true');
    else champ.removeAttribute('aria-invalid');
    zone.hidden = !texte;
    zone.textContent = texte || '';
  }

  return { section, charger };
}
