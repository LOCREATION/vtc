// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur, onglet Compte : heures et absences (salarié)
// -----------------------------------------------------------------------------
//   - heures de travail du mois en cours, saisies par l'administration ;
//   - absences : congés payés, congés sans solde, autres absences demandées,
//     et celles enregistrées par l'administration (maladie…) ; état de la
//     demande et réponse de l'administration ;
//   - « Demander une absence » : type, du, au, commentaire. La base compte
//     les jours (congés payés : jours ouvrables, hors jours fériés) et
//     refuse une période sans jour à décompter. L'administration accepte ou
//     refuse (module RH et paie) ; le salarié est prévenu ;
//   - « Retirer » une demande encore sans réponse.
// Section cachée pour un chauffeur sans fiche salarié.
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { el, afficherMessage, nombre } from '../../commun/outils.js';
import { jourParis, ajouterJours, bornesPeriode, dateCourte, heuresLisibles, libellePeriode } from '../commun/periodes.js';
import { TYPES_ABSENCE, ABSENCES_DEMANDABLES, STATUTS_ABSENCE } from '../commun/libelles.js';

export function creerSectionPlanning() {
  const $ = (id) => document.getElementById(id);
  let salarieCourant = null;
  const champ = (id, libelle, saisie) => el('div', { classe: 'champ' },
    el('label', { for: id, texte: libelle }), saisie,
    el('p', { classe: 'erreur-champ', id: `${id}-erreur`, hidden: true }));

  const type = el('select', { id: 'absence-type', classe: 'saisie' },
    ...ABSENCES_DEMANDABLES.map((code) => el('option', { value: code, texte: TYPES_ABSENCE[code] })));
  const debut = el('input', { id: 'absence-debut', classe: 'saisie', type: 'date' });
  const fin = el('input', { id: 'absence-fin', classe: 'saisie', type: 'date' });
  const commentaire = el('textarea', { id: 'absence-commentaire', classe: 'saisie', rows: '3', maxlength: '500' });
  debut.addEventListener('change', () => { if (debut.value && (!fin.value || fin.value < debut.value)) fin.value = debut.value; });

  const formulaire = el('form', { classe: 'compte-formulaire', id: 'absence-formulaire', novalidate: true, hidden: true },
    champ('absence-type', 'Type', type),
    el('div', { classe: 'champs-cote' }, champ('absence-debut', 'Du', debut), champ('absence-fin', 'Au (inclus)', fin)),
    champ('absence-commentaire', 'Commentaire (facultatif)', commentaire),
    el('p', { classe: 'aide', texte: 'Les congés payés se décomptent en jours ouvrables (du lundi au samedi, hors jours fériés). Pour un arrêt maladie, transmettez l\'avis d\'arrêt à LOC RÉACTION.' }),
    el('div', { classe: 'actions-compte' },
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Annuler', onclick: () => fermer() }),
      el('button', { type: 'submit', classe: 'bouton bouton-principal', id: 'absence-envoyer', texte: 'Envoyer la demande' })));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); envoyer(); });
  // Un champ corrigé perd son message d'erreur
  const corrige = (e) => { if (e.target.getAttribute('aria-invalid') === 'true') marquer(e.target.id, null); };
  formulaire.addEventListener('input', corrige);
  formulaire.addEventListener('change', corrige);

  const demander = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-large', id: 'absence-demander', texte: 'Demander une absence' });
  demander.addEventListener('click', ouvrir);

  const section = el('section', { classe: 'panneau', id: 'compte-planning', 'aria-labelledby': 'planning-titre', hidden: true },
    el('h2', { id: 'planning-titre', texte: 'Heures et absences' }),
    el('dl', { classe: 'chiffres', id: 'planning-chiffres' }),
    demander,
    formulaire,
    el('ul', { classe: 'liste-pieces', id: 'absences-liste' }),
    el('p', { classe: 'vide', id: 'absences-vide', hidden: true, texte: 'Aucune absence enregistrée.' }));

  function marquer(id, message) {
    $(id).setAttribute('aria-invalid', message ? 'true' : 'false');
    $(`${id}-erreur`).hidden = !message;
    $(`${id}-erreur`).textContent = message || '';
  }

  function ouvrir() {
    formulaire.reset();
    ['absence-type', 'absence-debut', 'absence-fin', 'absence-commentaire'].forEach((id) => marquer(id, null));
    debut.min = jourParis();
    fin.min = jourParis();
    formulaire.hidden = false;
    demander.hidden = true;
    type.focus();
  }

  function fermer() {
    formulaire.hidden = true;
    demander.hidden = false;
  }

  async function envoyer() {
    const aujourdhui = jourParis();
    marquer('absence-debut', !debut.value ? 'Indiquez le premier jour.' : (debut.value < aujourdhui ? 'Le premier jour est déjà passé : contactez LOC RÉACTION.' : null));
    marquer('absence-fin', !fin.value ? 'Indiquez le dernier jour.' : (debut.value && fin.value < debut.value ? 'Le dernier jour est avant le premier.'
      : (debut.value && fin.value > ajouterJours(debut.value, 366) ? 'Une demande couvre au plus un an.' : null)));
    marquer('absence-commentaire', commentaire.value.length <= 500 ? null : 'Commentaire trop long : 500 caractères au plus.');
    const premier = ['absence-debut', 'absence-fin', 'absence-commentaire'].find((id) => $(id).getAttribute('aria-invalid') === 'true');
    if (premier) { $(premier).focus(); return; }

    // La base contrôle la demande (contrat, autre absence sur ces jours, mois
    // déjà payé) et compte les jours : son message est affiché tel quel
    const bouton = $('absence-envoyer');
    bouton.disabled = true;
    try {
      const { error } = await supabase.from('absences').insert({
        salarie_id: salarieCourant.id, type: type.value, debut: debut.value, fin: fin.value,
        commentaire: commentaire.value.trim() || null
      });
      if (error) throw error;
      fermer();
      afficherMessage('Demande envoyée : LOC RÉACTION vous répond dans l\'application.', 'succes');
      await charger(salarieCourant);
    } catch (erreur) {
      afficherMessage(messageErreur(erreur), 'erreur');
    } finally {
      bouton.disabled = false;
    }
  }

  async function retirer(a) {
    try {
      // Seule une demande encore sans réponse se retire (règle d'accès) :
      // aucune ligne retirée = l'administration a déjà répondu
      const { data, error } = await supabase.from('absences').delete().eq('id', a.id).select('id');
      if (error) throw error;
      if (data && data.length) afficherMessage('Demande retirée.', 'succes');
      else afficherMessage('LOC RÉACTION a déjà répondu à cette demande : elle ne peut plus être retirée.', 'erreur');
      await charger(salarieCourant);
    } catch (erreur) {
      afficherMessage(messageErreur(erreur), 'erreur');
    }
  }

  function carte(a) {
    const periode = a.debut === a.fin ? `le ${dateCourte(a.debut)}` : `du ${dateCourte(a.debut)} au ${dateCourte(a.fin)}`;
    const jours = `${nombre(a.jours, 1)} jour${Number(a.jours) > 1 ? 's' : ''}`;
    const actions = [];
    if (a.statut === 'demandee') {
      const bouton = el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'Retirer la demande' });
      bouton.addEventListener('click', () => { bouton.disabled = true; retirer(a).finally(() => { bouton.disabled = false; }); });
      actions.push(bouton);
    }
    return el('li', { classe: 'piece' },
      el('div', { classe: 'piece-entete' },
        el('strong', { texte: TYPES_ABSENCE[a.type] || a.type }),
        el('span', { classe: 'etat-piece', dataset: { statut: { demandee: 'en_attente', validee: 'valide', refusee: 'refuse' }[a.statut] }, texte: STATUTS_ABSENCE[a.statut] || a.statut })),
      el('span', { classe: 'piece-details', texte: `${periode} · ${jours}` }),
      a.commentaire ? el('span', { classe: 'piece-details', texte: `Commentaire : ${a.commentaire}` }) : null,
      a.decision_note ? el('p', { classe: a.statut === 'refusee' ? 'piece-motif' : 'piece-details', texte: `Réponse : ${a.decision_note}` }) : null,
      actions.length ? el('div', { classe: 'actions-compte' }, ...actions) : null);
  }

  // salarie : fiche salarié du chauffeur ({ id }), ou null
  async function charger(salarie) {
    salarieCourant = salarie;
    section.hidden = !salarie;
    if (!salarie) return;
    const aujourdhui = jourParis();
    const mois = bornesPeriode('mois', aujourdhui);
    const [temps, absences] = await Promise.all([
      supabase.from('temps_travail').select('heures').eq('salarie_id', salarie.id).gte('jour', mois.du).lte('jour', mois.au),
      supabase.from('absences').select('id, type, debut, fin, jours, statut, commentaire, decision_note')
        .eq('salarie_id', salarie.id).order('debut', { ascending: false }).limit(50)
    ]);
    if (temps.error) throw temps.error;
    if (absences.error) throw absences.error;
    const heures = (temps.data || []).reduce((s, t) => s + Number(t.heures || 0), 0);
    const liste = absences.data || [];
    const enAttente = liste.filter((a) => a.statut === 'demandee').length;
    // « Heures de novembre », « Heures d'octobre »
    const nomMois = libellePeriode('mois', mois.du, mois.au).split(' ')[0].toLowerCase();
    $('planning-chiffres').replaceChildren(
      el('div', {}, el('dt', { texte: `Heures ${/^[aeiouyàâéèêîôû]/.test(nomMois) ? 'd\'' : 'de '}${nomMois}` }),
        el('dd', { texte: heures ? heuresLisibles(heures) : '—' })),
      el('div', {}, el('dt', { texte: 'Demandes en attente' }), el('dd', { texte: String(enAttente) })));
    $('absences-vide').hidden = liste.length > 0;
    $('absences-liste').replaceChildren(...liste.map(carte));
  }

  return { section, charger, fermer };
}
