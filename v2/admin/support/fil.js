// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : support — fil d'une demande
// -----------------------------------------------------------------------------
//   - la demande : sujet, type, statut, dates, personne chargée (choix parmi
//     les administrateurs, qui est prévenu) ; résoudre, fermer sans suite
//     (motif envoyé à l'auteur), rouvrir ;
//   - l'auteur : coordonnées, e-mail prêt à envoyer (objet rempli), appel ;
//   - la course concernée, et la conversation entre le client et le
//     chauffeur pendant la course (lecture) ;
//   - les messages : ceux de l'auteur passent « lus » à l'ouverture ; réponse
//     avec pièce jointe facultative (photo ou PDF, rangée dans le dossier
//     privé « support »), et « résolue » d'un coup si c'est réglé ;
//   - objets trouvés de la course (déclaration rattachée à la demande) ;
//   - autres demandes de la même personne.
// Lecture : admin_fil_demande ; actions : admin_repondre_demande,
// admin_statut_demande, admin_attribuer_demande, admin_enregistrer_objet.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  badge, boutonAction, ligne, confirmer, messageErreurAdmin, ouvrirPiece, jourHeure, dateCourte, lienTelephone,
  badgeCourse, pluriel
} from '../commun/composants.js';
import { nomFichier } from '../commun/listes.js';
import { TYPES_DEMANDE, STATUTS_DEMANDE, STATUTS_OBJET, ROLES, pastille, lienEmail, formulaireObjet } from './commun-support.js';

const $ = (id) => document.getElementById(id);
const FORMATS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const TAILLE_MAX = 10 * 1024 * 1024;

export async function ouvrirFil(id) {
  $('onglets').hidden = true;
  $('entete-actions').replaceChildren(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin('support/'), texte: 'Toutes les demandes' }));
  if (!/^[0-9a-f-]{36}$/i.test(id)) { introuvable(); return; }
  const { data, error } = await supabase.rpc('admin_fil_demande', { p_demande: id });
  if (error) {
    if (/introuvable/i.test(error.message || '')) introuvable();
    else $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) }));
    return;
  }
  afficherFil(data);
}

function introuvable() {
  $('titre-page').textContent = 'Support';
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('p', { texte: 'Demande introuvable.' }),
    el('a', { href: lienAdmin('support/'), texte: 'Retour aux demandes' })));
}

function afficherFil(f) {
  const d = f.demande;
  const recharger = () => ouvrirFil(d.id);
  document.title = `${d.numero}, support, administration LOC RÉACTION`;
  $('titre-page').textContent = d.numero;
  // (sections absentes filtrées : replaceChildren écrirait « null »)
  $('contenu').replaceChildren(...[
    sectionDemande(f, recharger),
    sectionMessages(f, recharger),
    sectionAuteur(f),
    f.course ? sectionCourse(f) : null,
    sectionObjets(f, recharger),
    f.autres.length ? sectionAutres(f) : null].filter(Boolean));
}

// ---------------------------------------------------------------------------
// La demande : statut, personne chargée, actions
// ---------------------------------------------------------------------------
function sectionDemande(f, recharger) {
  const d = f.demande;
  const ouverte = d.statut === 'ouverte' || d.statut === 'en_cours';
  const choix = el('select', { id: 'demande-assignee', classe: 'saisie' }, el('option', { value: '', texte: 'Personne' }),
    ...f.administrateurs.map((a) => el('option', { value: a.id, texte: a.nom })));
  choix.value = d.assignee_a || '';
  choix.addEventListener('change', async () => {
    choix.disabled = true;
    const { data, error } = await supabase.rpc('admin_attribuer_demande', { p_demande: d.id, p_admin: choix.value || null });
    choix.disabled = false;
    if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); choix.value = d.assignee_a || ''; return; }
    afficherMessage(data.assignee_nom ? `Demande attribuée à ${data.assignee_nom}.` : 'Plus personne n\'est chargé de la demande.', 'succes');
    await recharger();
  });

  const actions = el('div', { classe: 'actions-ligne' });
  if (ouverte) {
    actions.append(
      boutonAction('Marquer résolue', async () => {
        const r = await confirmer({
          titre: `Résoudre ${d.numero} ?`, texte: 'La personne est prévenue que sa demande est résolue.', libelle: 'Marquer résolue',
          motif: { libelle: 'Message de conclusion', obligatoire: false, aide: 'Ajouté au fil et envoyé avec l\'avis de résolution.' }
        });
        if (r) await changerStatut(d, 'resolue', r.motif, recharger);
      }, 'bouton-principal'),
      boutonAction('Fermer sans suite', async () => {
        const r = await confirmer({
          titre: `Fermer ${d.numero} sans suite ?`, texte: 'Pour un doublon, une demande sans objet ou restée sans réponse.', libelle: 'Fermer la demande', danger: true,
          motif: { libelle: 'Motif (envoyé à la personne)', obligatoire: true }
        });
        if (r) await changerStatut(d, 'fermee', r.motif, recharger);
      }, 'bouton-danger'));
  } else {
    actions.append(boutonAction('Rouvrir la demande', () => changerStatut(d, 'en_cours', null, recharger)));
  }

  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-demande' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-demande', texte: d.sujet }), pastille(STATUTS_DEMANDE, d.statut)),
    el('dl', { classe: 'fiche-donnees' },
      ...ligne('Type', TYPES_DEMANDE[d.type] || d.type),
      ...ligne('Ouverte le', jourHeure(d.cree_le)),
      ...ligne(d.statut === 'resolue' ? 'Résolue le' : 'Fermée le', d.cloturee_le ? jourHeure(d.cloturee_le) : null)),
    el('div', { classe: 'champ champ-assignee' }, el('label', { for: 'demande-assignee', texte: 'Personne chargée' }), choix),
    actions);
}

async function changerStatut(d, statut, motif, recharger) {
  const { error } = await supabase.rpc('admin_statut_demande', { p_demande: d.id, p_statut: statut, p_motif: motif });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage({ resolue: `${d.numero} est résolue.`, fermee: `${d.numero} est fermée.`, en_cours: `${d.numero} est rouverte.` }[statut], 'succes');
  await recharger();
}

// ---------------------------------------------------------------------------
// Messages et réponse
// ---------------------------------------------------------------------------
function sectionMessages(f, recharger) {
  const d = f.demande;
  // Demande résolue ou fermée : y répondre la rouvre (« en cours »), sauf
  // si « C'est réglé » est coché
  const close = d.statut === 'resolue' || d.statut === 'fermee';
  const liste = el('ol', { classe: 'fil-messages', 'aria-label': 'Messages de la demande' }, ...f.messages.map((m) =>
    el('li', { classe: `fil-message${m.de_l_administration ? ' fil-message-admin' : ''}` },
      el('div', { classe: 'fil-entete' },
        el('strong', { texte: m.de_l_administration ? `${m.auteur_nom} · administration` : m.auteur_nom }),
        el('span', { classe: 'fil-date', texte: jourHeure(m.cree_le) })),
      m.contenu ? el('p', { classe: 'fil-texte', texte: m.contenu }) : null,
      m.piece_jointe_chemin ? el('button', { type: 'button', classe: 'bouton bouton-texte fil-piece', texte: 'Ouvrir la pièce jointe',
        onclick: () => ouvrirPiece('support', m.piece_jointe_chemin).catch((e) => afficherMessage(messageErreurAdmin(e), 'erreur')) }) : null,
      m.de_l_administration ? el('span', { classe: 'fil-lu', texte: m.lu_le ? `Lu le ${jourHeure(m.lu_le)}` : 'Pas encore lu' }) : null)));

  const texte = el('textarea', { id: 'reponse-texte', classe: 'saisie saisie-zone', maxlength: '2000', rows: '5' });
  const fichier = el('input', { id: 'reponse-fichier', classe: 'saisie', type: 'file', accept: '.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif' });
  const cloturer = el('input', { id: 'reponse-cloturer', type: 'checkbox' });
  const erreur = el('p', { classe: 'alerte', role: 'alert', hidden: true });
  const envoyer = el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Envoyer la réponse' });
  const formulaire = el('form', { classe: 'grille-champs reponse-support', id: 'reponse-demande', novalidate: true },
    el('div', { classe: 'champ champ-plein' }, el('label', { for: 'reponse-texte', texte: 'Votre réponse' }), texte,
      el('p', { classe: 'aide', texte: [
        'La personne est prévenue dans l\'application.',
        close ? 'Répondre rouvre la demande, sauf si vous cochez « C\'est réglé ».' : null,
        f.auteur && f.auteur.email ? 'Pour répondre aussi par e-mail, utilisez le lien de l\'adresse ci-dessous.' : null
      ].filter(Boolean).join(' ') })),
    el('div', { classe: 'champ' }, el('label', { for: 'reponse-fichier', texte: 'Pièce jointe (facultatif) : photo ou PDF, 10 Mo au plus' }), fichier),
    el('label', { classe: 'case champ-plein', for: 'reponse-cloturer' }, cloturer, el('span', { texte: 'C\'est réglé : marquer la demande résolue avec cette réponse' })),
    erreur,
    el('div', { classe: 'actions-ligne' }, envoyer));
  formulaire.addEventListener('submit', async (e) => {
    e.preventDefault();
    erreur.hidden = true;
    const contenu = texte.value.trim();
    const choisi = fichier.files[0] || null;
    if (!contenu && !choisi) { erreur.textContent = 'Écrivez la réponse (ou joignez un fichier).'; erreur.hidden = false; texte.focus(); return; }
    if (choisi && choisi.size > TAILLE_MAX) { erreur.textContent = 'Fichier trop lourd : 10 Mo au plus.'; erreur.hidden = false; return; }
    if (choisi && choisi.type && !FORMATS.includes(choisi.type)) { erreur.textContent = 'Format refusé : photo (JPEG, PNG, WebP, HEIC) ou PDF.'; erreur.hidden = false; return; }
    envoyer.disabled = true;
    try {
      let chemin = null;
      if (choisi) {
        const morceaux = choisi.name.split('.');
        const extension = (morceaux.length > 1 ? morceaux.pop() : 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'pdf';
        chemin = `${d.id}/${Date.now()}-${nomFichier(morceaux.join('.') || 'piece').slice(0, 60)}.${extension}`;
        const envoi = await supabase.storage.from('support').upload(chemin, choisi, { contentType: choisi.type || undefined, upsert: false });
        if (envoi.error) throw envoi.error;
      }
      const { data, error } = await supabase.rpc('admin_repondre_demande', {
        p_demande: d.id, p_message: contenu || null, p_cloturer: cloturer.checked, p_piece_jointe: chemin
      });
      if (error) {
        if (chemin) await supabase.storage.from('support').remove([chemin]);
        throw error;
      }
      afficherMessage(data.statut === 'resolue' ? 'Réponse envoyée, demande résolue.'
        : (close ? 'Réponse envoyée : la demande est rouverte.' : 'Réponse envoyée.'), 'succes');
      await recharger();
    } catch (probleme) {
      erreur.textContent = messageErreurAdmin(probleme);
      erreur.hidden = false;
      envoyer.disabled = false;
    }
  });

  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-messages' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-messages', texte: 'Messages' }),
      el('span', { classe: 'sous-titre', texte: pluriel(f.messages.length, 'message', 'messages') })),
    liste, formulaire);
}

// ---------------------------------------------------------------------------
// Auteur, course, objets trouvés, autres demandes
// ---------------------------------------------------------------------------
function sectionAuteur(f) {
  const a = f.auteur;
  const d = f.demande;
  const nom = [a.prenom, a.nom].filter(Boolean).join(' ') || a.email || 'Sans nom';
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-auteur' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-auteur', texte: nom }), badge(ROLES[a.role] || a.role, 'gris'),
      a.statut !== 'actif' ? badge('Compte bloqué', 'rouge') : null),
    el('dl', { classe: 'fiche-donnees' },
      ...ligne('E-mail', lienEmail(a.email, `${d.numero} · ${d.sujet}`)),
      ...ligne('Téléphone', a.telephone ? lienTelephone(a.telephone) : null),
      ...ligne('Inscrit(e) le', dateCourte(a.cree_le))),
    a.role === 'client' ? el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`clients/?id=${a.id}`), texte: 'Fiche du client' })
      : a.role === 'chauffeur' ? el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin('chauffeurs/'), texte: 'Chauffeurs' }) : null);
}

function sectionCourse(f) {
  const c = f.course;
  const conversation = f.conversation.length
    ? el('details', { classe: 'conversation-course' },
        el('summary', { texte: `Conversation pendant la course (${pluriel(f.conversation.length, 'message', 'messages')})` }),
        el('ol', { classe: 'fil-messages fil-conversation' }, ...f.conversation.map((m) =>
          el('li', { classe: `fil-message fil-message-${m.auteur_role}` },
            el('div', { classe: 'fil-entete' },
              el('strong', { texte: `${m.auteur_nom} · ${m.auteur_role === 'client' ? 'client' : m.auteur_role === 'chauffeur' ? 'chauffeur' : 'administration'}` }),
              el('span', { classe: 'fil-date', texte: jourHeure(m.cree_le) })),
            m.contenu ? el('p', { classe: 'fil-texte', texte: m.contenu }) : null,
            m.piece_jointe ? el('span', { classe: 'texte-gris', texte: 'Pièce jointe envoyée (visible dans l\'application)' }) : null))))
    : el('p', { classe: 'texte-gris', texte: 'Aucun message échangé entre le client et le chauffeur pendant la course.' });
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-course' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-course', texte: `Course ${c.numero}` }), badgeCourse(c.statut)),
    el('dl', { classe: 'fiche-donnees' },
      ...ligne('Prise en charge', c.prise_en_charge_le ? jourHeure(c.prise_en_charge_le) : null),
      ...ligne('Départ', c.depart_adresse),
      ...ligne('Arrivée', c.arrivee_adresse),
      ...ligne('Client', c.client),
      ...ligne('Chauffeur', c.chauffeur || 'Pas encore attribuée'),
      ...ligne('Prix', c.prix_total !== null && c.prix_total !== undefined ? euros(c.prix_total) : null)),
    el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`courses/?id=${c.id}`), texte: 'Fiche de la course' }),
    conversation);
}

function sectionObjets(f, recharger) {
  const d = f.demande;
  const declarer = boutonAction('Déclarer un objet trouvé', async () => {
    const fait = await formulaireObjet({ course: f.course ? f.course.numero : '', demande: d, demandes: [d] });
    if (fait) { afficherMessage(`Objet ${fait.numero} enregistré au registre.`, 'succes'); await recharger(); }
  });
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-objets-demande' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-objets-demande', texte: 'Objets trouvés' })),
    f.objets.length
      ? el('ul', { classe: 'liste-simple' }, ...f.objets.map((o) => el('li', {},
          el('a', { href: lienAdmin(`support/?vue=objets&q=${encodeURIComponent(o.numero)}`), texte: o.numero }), ' · ', o.description, ' ',
          pastille(STATUTS_OBJET, o.statut), o.rattache ? badge('Rattaché à cette demande', 'bleu') : null)))
      : el('p', { classe: 'texte-gris', texte: f.course ? 'Aucun objet trouvé après cette course.' : 'Aucun objet rattaché à cette demande.' }),
    el('div', { classe: 'actions-ligne' }, declarer));
}

function sectionAutres(f) {
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-autres' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-autres', texte: 'Autres demandes de la même personne' })),
    el('ul', { classe: 'liste-simple' }, ...f.autres.map((x) => el('li', {},
      el('a', { href: lienAdmin(`support/?demande=${x.id}`), texte: x.numero }), ` · ${x.sujet} · ${dateCourte(x.cree_le)} `,
      pastille(STATUTS_DEMANDE, x.statut)))));
}
