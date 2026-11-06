// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client, onglet Compte : section « Mes proches »
// -----------------------------------------------------------------------------
// Les personnes pour qui le client commande des courses (un parent, un
// enfant, un collègue…) : nom, téléphone (le chauffeur les appelle à ce
// numéro), lien (facultatif). Pour chacun :
//   - « Commander » : la commande s'ouvre avec ce proche déjà choisi
//     (client/commande/?proche=<id>) ;
//   - « Modifier », « Retirer ».
// « Ajouter » ouvre le même formulaire, sous la liste (la liste est redessinée
// après chaque enregistrement ; le formulaire, lui, reste en place).
// Un proche peut aussi être enregistré au moment de commander (case « Enregistrer
// ce proche »).
// Règles de la base (table proches) : chacun ne lit et n'écrit que les siens ;
// nom de 1 à 120 caractères, téléphone au format international, lien de
// 40 caractères au plus.
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { t, langueActive, lienAvecLangue } from '../../commun/i18n.js';
import { el, afficherMessage, telephoneInternational, telephoneLisible } from '../../commun/outils.js';

const $ = (id) => document.getElementById(id);
const erreurLisible = (e) => messageErreur(e, langueActive());

// contexte : celui de l'espace client (profil de la personne connectée)
export function creerSectionProches({ contexte }) {
  const etat = { proches: [], edite: null };

  const champ = (id, libelle, attributs = {}, aide = null) => el('div', { classe: 'champ' },
    el('label', { for: id, texte: libelle }),
    el('input', { id, classe: 'saisie', type: 'text', ...attributs }),
    aide ? el('p', { classe: 'aide', texte: aide }) : null,
    el('p', { classe: 'erreur-champ', id: `${id}-erreur`, hidden: true }));

  const formulaire = el('form', { classe: 'formulaire-client formulaire-lieu', id: 'proche-formulaire', novalidate: true, hidden: true,
    'aria-labelledby': 'proche-formulaire-titre' },
    el('h3', { id: 'proche-formulaire-titre' }),
    champ('proche-nom-compte', t('proches.nom'), { autocomplete: 'off', maxlength: '120' }),
    champ('proche-telephone-compte', t('profil.telephone'), { type: 'tel', autocomplete: 'off', inputmode: 'tel', maxlength: '20' },
      t('proches.telephone_aide')),
    champ('proche-relation-compte', t('proches.relation'), { autocomplete: 'off', maxlength: '40' }, t('proches.relation_aide')),
    el('div', { classe: 'actions-client' },
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'proche-annuler', texte: t('compte.annuler'), onclick: fermer }),
      el('button', { type: 'submit', classe: 'bouton bouton-principal', id: 'proche-enregistrer', texte: t('profil.enregistrer') })));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); enregistrer(); });
  formulaire.addEventListener('input', (e) => { if (e.target.getAttribute('aria-invalid') === 'true') marquer(e.target.id, null); });

  const section = el('section', { classe: 'bloc-client', id: 'compte-proches', 'aria-labelledby': 'compte-titre-proches' },
    el('div', { classe: 'entete-bloc' },
      el('h2', { id: 'compte-titre-proches', texte: t('proches.titre') }),
      el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'proche-ajouter', texte: t('proches.ajouter'), onclick: () => ouvrir(null) })),
    el('p', { classe: 'aide-client', texte: t('proches.aide') }),
    el('p', { classe: 'aide-client', id: 'compte-proches-vide', hidden: true, texte: t('proches.vide') }),
    el('ul', { classe: 'lieux-client proches-client', id: 'compte-liste-proches' }),
    formulaire);

  // ---------------------------------------------------------------------------
  // Lecture et liste
  // ---------------------------------------------------------------------------
  async function charger() {
    const { data, error } = await supabase.from('proches').select('id, nom, telephone, relation')
      .eq('client_id', contexte.profil.id).order('nom');
    if (error) throw error;
    etat.proches = data || [];
    afficher();
  }

  function afficher() {
    $('compte-proches-vide').hidden = etat.proches.length > 0;
    $('compte-liste-proches').replaceChildren(...etat.proches.map((p) => el('li', { classe: 'lieu-client proche-client', id: `proche-${p.id}`, dataset: { id: p.id } },
      el('div', { classe: 'lieu-texte' },
        el('span', { classe: 'lieu-type', texte: p.nom }),
        el('span', { classe: 'lieu-adresse', texte: telephoneLisible(p.telephone) }),
        p.relation ? el('span', { classe: 'lieu-precision', texte: p.relation }) : null),
      el('div', { classe: 'lieu-actions' },
        el('a', { classe: 'bouton bouton-texte', id: `proche-${p.id}-commander`, href: lienAvecLangue(`commande/?proche=${encodeURIComponent(p.id)}`),
          texte: t('proches.commander'), 'aria-label': t('proches.commander_pour', { nom: p.nom }) }),
        el('button', { type: 'button', classe: 'bouton bouton-texte', id: `proche-${p.id}-modifier`, texte: t('compte.lieu_modifier'),
          'aria-label': t('proches.modifier_aria', { nom: p.nom }), onclick: () => ouvrir(p) }),
        el('button', { type: 'button', classe: 'bouton bouton-texte bouton-retirer', id: `proche-${p.id}-retirer`, texte: t('compte.lieu_retirer'),
          'aria-label': t('proches.retirer_aria', { nom: p.nom }), onclick: () => retirer(p) })))));
  }

  // ---------------------------------------------------------------------------
  // Formulaire : ajouter (proche = null) ou modifier
  // ---------------------------------------------------------------------------
  function ouvrir(proche) {
    etat.edite = proche;
    $('proche-formulaire-titre').textContent = proche ? t('proches.modifier_titre', { nom: proche.nom }) : t('proches.ajouter_titre');
    $('proche-nom-compte').value = proche ? proche.nom : '';
    $('proche-telephone-compte').value = proche ? telephoneLisible(proche.telephone) : '';
    $('proche-relation-compte').value = proche ? (proche.relation || '') : '';
    for (const id of ['proche-nom-compte', 'proche-telephone-compte', 'proche-relation-compte']) marquer(id, null);
    formulaire.hidden = false;
    $('proche-nom-compte').focus();
  }

  function fermer() {
    formulaire.hidden = true;
    etat.edite = null;
  }

  async function enregistrer() {
    const nom = $('proche-nom-compte').value.trim();
    const telephone = telephoneInternational($('proche-telephone-compte').value);
    const relation = $('proche-relation-compte').value.trim();
    const doublon = telephone && etat.proches.find((p) => p.telephone === telephone && (!etat.edite || p.id !== etat.edite.id));
    marquer('proche-nom-compte', nom ? null : t('proches.nom_requis'));
    marquer('proche-telephone-compte', !telephone ? t('profil.telephone_invalide')
      : doublon ? t('proches.doublon', { nom: doublon.nom }) : null);
    if (!nom || !telephone || doublon) {
      $(!nom ? 'proche-nom-compte' : 'proche-telephone-compte').focus();
      return;
    }
    const valeurs = { nom: nom.slice(0, 120), telephone, relation: relation.slice(0, 40) || null };
    $('proche-enregistrer').disabled = true;
    try {
      const requete = etat.edite
        ? supabase.from('proches').update(valeurs).eq('id', etat.edite.id)
        : supabase.from('proches').insert({ ...valeurs, client_id: contexte.profil.id });
      const { error } = await requete;
      if (error) throw error;
      fermer();
      await charger();
      afficherMessage(t('proches.enregistre', { nom: valeurs.nom }), 'succes');
    } catch (e) {
      afficherMessage(erreurLisible(e), 'erreur');
    } finally {
      $('proche-enregistrer').disabled = false;
    }
  }

  async function retirer(proche) {
    try {
      const { error } = await supabase.from('proches').delete().eq('id', proche.id);
      if (error) throw error;
      if (etat.edite && etat.edite.id === proche.id) fermer();
      await charger();
      afficherMessage(t('proches.retire', { nom: proche.nom }), 'succes');
    } catch (e) {
      afficherMessage(erreurLisible(e), 'erreur');
    }
  }

  function marquer(id, texte) {
    const controle = $(id);
    const zone = $(`${id}-erreur`);
    if (!controle || !zone) return;
    if (texte) controle.setAttribute('aria-invalid', 'true');
    else controle.removeAttribute('aria-invalid');
    zone.hidden = !texte;
    zone.textContent = texte || '';
  }

  return { section, charger, fermer };
}
