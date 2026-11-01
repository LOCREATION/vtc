// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : support — messages du site
// -----------------------------------------------------------------------------
// Ce que les visiteurs envoient depuis le site, avec ou sans compte :
//   - formulaire de contact : à traiter ou traité (par qui, quand, note
//     interne) ; réponse par e-mail (objet rempli) ou par téléphone ;
//   - demandes de devis (longues distances, mise à disposition, autres
//     activités) : nouvelle, devis envoyé (montant TTC, date d'envoi),
//     acceptée, refusée ; note interne.
// Listes : à traiter, en attente (devis envoyés), traités, tous ; recherche
// (nom, e-mail, téléphone, texte). Un message indésirable se supprime.
// Lecture : admin_lister_messages_site ; actions : admin_traiter_contact,
// admin_suivre_devis ; suppression directe dans la table (administration).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';
import { badge, boutonAction, confirmer, fenetreFormulaire, messageErreurAdmin, jourHeure, dateCourte, lienTelephone, pluriel } from '../commun/composants.js';
import { ecrireAdresse } from '../commun/listes.js';
import { SERVICES_DEVIS, STATUTS_DEVIS, pastille, lienEmail } from './commun-support.js';

const $ = (id) => document.getElementById(id);
const VUES = [
  { code: 'a_traiter', libelle: 'À traiter' },
  { code: 'en_attente', libelle: 'Devis en attente de réponse' },
  { code: 'traites', libelle: 'Traités' },
  { code: 'tous', libelle: 'Tous' }
];
const filtres = { vue: 'a_traiter', texte: '' };

export function afficherSite({ parametres }) {
  filtres.vue = VUES.some((v) => v.code === parametres.get('liste')) ? parametres.get('liste') : 'a_traiter';
  filtres.texte = (parametres.get('q') || '').slice(0, 100);
  const texte = el('input', { id: 'site-texte', classe: 'saisie', type: 'search', autocomplete: 'off', placeholder: 'Nom, e-mail, téléphone, texte' });
  texte.value = filtres.texte;
  const formulaire = el('form', { classe: 'barre-outils', role: 'search' },
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'site-texte', texte: 'Rechercher' }), texte),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Rechercher' }),
    el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'Effacer', onclick: () => { texte.value = ''; filtres.texte = ''; charger(); } }));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); filtres.texte = texte.value.trim(); charger(); });

  $('contenu').replaceChildren(
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-site' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-site', texte: 'Messages du site' })),
      el('p', { classe: 'aide-module', texte: 'Formulaire de contact et demandes de devis envoyés depuis le site, souvent par des visiteurs sans compte : répondez par e-mail ou par téléphone, puis notez-le ici.' }),
      el('div', { classe: 'sous-onglets', role: 'tablist', 'aria-label': 'Messages du site', id: 'vues-site' }),
      formulaire),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-contacts' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-contacts', texte: 'Formulaire de contact' }), el('span', { classe: 'sous-titre', id: 'nombre-contacts' })),
      el('div', { id: 'liste-contacts' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-devis' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-devis', texte: 'Demandes de devis' }), el('span', { classe: 'sous-titre', id: 'nombre-devis' })),
      el('div', { id: 'liste-devis' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))));
  charger();
}

async function charger() {
  ecrireAdresse('site', { liste: filtres.vue === 'a_traiter' ? '' : filtres.vue, q: filtres.texte });
  const { data, error } = await supabase.rpc('admin_lister_messages_site', { p_vue: filtres.vue, p_texte: filtres.texte || null });
  if (error) { $('liste-contacts').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  const n = data.compteurs;
  const comptes = { a_traiter: Number(n.contacts_a_traiter) + Number(n.devis_nouveaux), en_attente: Number(n.devis_envoyes) };
  $('vues-site').replaceChildren(...VUES.map((v) => {
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(v.code === filtres.vue) },
      el('span', { texte: v.libelle }), comptes[v.code] ? el('span', { classe: 'compte', texte: String(comptes[v.code]) }) : null);
    b.addEventListener('click', () => { if (v.code !== filtres.vue) { filtres.vue = v.code; charger(); } });
    return b;
  }));
  $('nombre-contacts').textContent = pluriel(data.contacts.length, 'message', 'messages');
  $('nombre-devis').textContent = pluriel(data.devis.length, 'demande', 'demandes');
  $('liste-contacts').replaceChildren(data.contacts.length
    ? el('ul', { classe: 'liste-cartes' }, ...data.contacts.map(carteContact))
    : el('p', { classe: 'vide-admin', texte: filtres.vue === 'en_attente' ? 'Les messages de contact n\'attendent pas de réponse du client.' : 'Aucun message.' }));
  $('liste-devis').replaceChildren(data.devis.length
    ? el('ul', { classe: 'liste-cartes' }, ...data.devis.map(carteDevis))
    : el('p', { classe: 'vide-admin', texte: 'Aucune demande de devis.' }));
}

// ---------------------------------------------------------------------------
// Formulaire de contact
// ---------------------------------------------------------------------------
function carteContact(m) {
  const actions = el('div', { classe: 'actions-ligne' });
  if (!m.traite) {
    actions.append(boutonAction('Marquer traité', async () => {
      const r = await confirmer({ titre: 'Message traité', texte: `${m.nom} · ${m.sujet}`, libelle: 'Marquer traité',
        motif: { libelle: 'Note interne', obligatoire: false, aide: 'Réponse donnée, par quel moyen, suite à prévoir.' } });
      if (r) await traiter(m, true, r.motif);
    }, 'bouton-principal'));
  } else {
    actions.append(boutonAction('À reprendre', () => traiter(m, false, null)));
  }
  actions.append(boutonSupprimer('messages_contact', m.id, `le message de ${m.nom}`));
  return el('li', { classe: `carte-message${m.traite ? ' carte-traitee' : ''}` },
    el('div', { classe: 'carte-message-entete' },
      el('strong', { texte: m.nom }), m.traite ? badge('Traité', 'vert') : badge('À traiter', 'or'),
      el('span', { classe: 'fil-date', texte: jourHeure(m.cree_le) })),
    el('p', { classe: 'carte-message-sujet', texte: m.sujet }),
    el('p', { classe: 'fil-texte', texte: m.message }),
    el('p', { classe: 'carte-message-contact' }, lienEmail(m.email, `Re : ${m.sujet}`), m.telephone ? ' · ' : null, m.telephone ? lienTelephone(m.telephone) : null),
    m.traite ? el('p', { classe: 'texte-gris', texte: `Traité${m.traite_par_nom ? ` par ${m.traite_par_nom}` : ''}${m.traite_le ? ` le ${jourHeure(m.traite_le)}` : ''}.` }) : null,
    m.note ? el('p', { classe: 'note-interne', texte: m.note }) : null,
    actions);
}

async function traiter(m, traite, note) {
  const { error } = await supabase.rpc('admin_traiter_contact', { p_message: m.id, p_traite: traite, p_note: note });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(traite ? `Message de ${m.nom} traité.` : `Message de ${m.nom} à reprendre.`, 'succes');
  await charger();
}

// ---------------------------------------------------------------------------
// Demandes de devis
// ---------------------------------------------------------------------------
function carteDevis(v) {
  const actions = el('div', { classe: 'actions-ligne' });
  if (v.statut === 'nouvelle') {
    actions.append(boutonAction('Devis envoyé', () => devisEnvoye(v), 'bouton-principal'));
  } else if (v.statut === 'devis_envoye') {
    actions.append(
      boutonAction('Acceptée', () => suivre(v, 'acceptee', null, null), 'bouton-principal'),
      boutonAction('Refusée', async () => {
        const r = await confirmer({ titre: 'Devis refusé', texte: `${v.nom} · ${euros(v.montant)}`, libelle: 'Enregistrer',
          motif: { libelle: 'Note interne', obligatoire: false, aide: 'Raison donnée par le client, s\'il l\'a dite.' } });
        if (r) await suivre(v, 'refusee', null, r.motif);
      }),
      boutonAction('Modifier le montant', () => devisEnvoye(v)));
  }
  if (v.statut !== 'nouvelle') actions.append(boutonAction('Revenir à « nouvelle »', () => suivre(v, 'nouvelle', null, null), 'bouton-texte'));
  actions.append(boutonSupprimer('demandes_devis', v.id, `la demande de devis de ${v.nom}`));
  return el('li', { classe: `carte-message${['acceptee', 'refusee'].includes(v.statut) ? ' carte-traitee' : ''}` },
    el('div', { classe: 'carte-message-entete' },
      el('strong', { texte: v.nom }), pastille(STATUTS_DEVIS, v.statut),
      el('span', { classe: 'fil-date', texte: jourHeure(v.cree_le) })),
    el('p', { classe: 'carte-message-sujet', texte: SERVICES_DEVIS[v.service] || v.service }),
    el('p', { classe: 'fil-texte', texte: v.description }),
    el('dl', { classe: 'fiche-donnees' },
      ...(v.adresse ? [el('dt', { texte: 'Adresse' }), el('dd', { texte: v.adresse })] : []),
      ...(v.date_souhaitee ? [el('dt', { texte: 'Date souhaitée' }), el('dd', { texte: dateCourte(v.date_souhaitee) })] : []),
      ...(v.montant !== null && v.montant !== undefined ? [el('dt', { texte: 'Devis' }),
        el('dd', { texte: `${euros(v.montant)} TTC${v.devis_envoye_le ? `, envoyé le ${dateCourte(v.devis_envoye_le)}` : ''}` })] : [])),
    el('p', { classe: 'carte-message-contact' }, lienEmail(v.email, `Votre demande de devis : ${SERVICES_DEVIS[v.service] || v.service}`),
      v.telephone ? ' · ' : null, v.telephone ? lienTelephone(v.telephone) : null),
    v.traite_par_nom ? el('p', { classe: 'texte-gris', texte: `Suivi par ${v.traite_par_nom}.` }) : null,
    v.note ? el('p', { classe: 'note-interne', texte: v.note }) : null,
    actions);
}

async function devisEnvoye(v) {
  const fait = await fenetreFormulaire({
    titre: `Devis pour ${v.nom}`,
    intro: `${SERVICES_DEVIS[v.service] || v.service}. Envoyez le devis au client (e-mail ou courrier), puis notez ici son montant.`,
    champs: [
      { nom: 'montant', libelle: 'Montant du devis (€ TTC)', type: 'nombre', requis: true, min: 0.01, max: 1000000, pas: '0.01' },
      { nom: 'note', libelle: 'Note interne', type: 'zone', longueur: 2000, plein: true }
    ],
    valeurs: { montant: v.montant, note: v.note },
    libelle: 'Enregistrer',
    enregistrer: async (x) => {
      const { error } = await supabase.rpc('admin_suivre_devis', { p_devis: v.id, p_statut: 'devis_envoye', p_montant: x.montant, p_note: x.note || '' });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage(`Devis de ${v.nom} noté : en attente de sa réponse.`, 'succes'); await charger(); }
}

async function suivre(v, statut, montant, note) {
  const { error } = await supabase.rpc('admin_suivre_devis', { p_devis: v.id, p_statut: statut, p_montant: montant, p_note: note });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage({ acceptee: `Devis de ${v.nom} accepté.`, refusee: `Devis de ${v.nom} refusé.`, nouvelle: `Demande de ${v.nom} revenue à « nouvelle ».` }[statut], 'succes');
  await charger();
}

function boutonSupprimer(table, id, quoi) {
  return boutonAction('Supprimer', async () => {
    const r = await confirmer({ titre: `Supprimer ${quoi} ?`, texte: 'Pour un message indésirable : la suppression est gardée au journal.', libelle: 'Supprimer', danger: true });
    if (!r) return;
    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
    afficherMessage('Supprimé.', 'succes');
    await charger();
  }, 'bouton-texte');
}
