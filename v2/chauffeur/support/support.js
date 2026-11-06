// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : « Mes demandes au support »
// -----------------------------------------------------------------------------
// Panneau ouvert par-dessus la page (le service continue : position,
// demandes de course), en trois vues :
//   - Mes demandes : la plus récemment active d'abord, avec son statut, la
//     course concernée et les réponses non lues (fonction mes_demandes) ;
//   - une demande : le fil des messages (les miens à droite, LOC RÉACTION à
//     gauche), pièces jointes à ouvrir, réponse avec une photo ou un PDF tant
//     que la demande est ouverte ou en cours. Les réponses de LOC RÉACTION
//     sont marquées « lues », leur notification aussi ;
//   - Nouvelle demande : de quoi il s'agit, course concernée (facultative),
//     sujet, message (fonction ouvrir_demande).
// Ouvert depuis l'onglet Compte (« Aide et support »), la fiche d'une course
// (« Signaler un problème »), une notification du support, ou l'adresse de
// l'espace chauffeur avec ?demande=… ou ?signaler=… (chauffeur.js).
// Nouvelles réponses pendant que le fil est ouvert : temps réel, et relecture
// de secours toutes les 20 secondes.
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { el, afficherMessage, dateHeure } from '../../commun/outils.js';
import { ouvrirFichier, extension } from '../commun/fichiers.js';

const STATUTS = { ouverte: 'Ouverte', en_cours: 'En cours', resolue: 'Résolue', fermee: 'Fermée' };
const TYPES = { course: 'Une course', paiement: 'Un paiement', objet_perdu: 'Un objet oublié', compte: 'Mon compte', autre: 'Autre chose' };
const TYPES_COURTS = { course: 'Course', paiement: 'Paiement', objet_perdu: 'Objet oublié', compte: 'Compte', autre: 'Autre' };
const FORMATS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const TAILLE_MAX = 10 * 1024 * 1024;          // 10 Mo, comme le dossier « support » de la base
const RELECTURE_MS = 20000;

// moi : identifiant du chauffeur connecté
export function installerSupport({ moi }) {
  const etat = { vue: 'liste', demandes: [], courant: null, messages: [], canal: null, minuteur: null, envoi: false, piece: null };

  // ---------------------------------------------------------------------------
  // Structure du panneau
  // ---------------------------------------------------------------------------
  const retour = el('button', { type: 'button', classe: 'bouton bouton-texte support-retour', id: 'support-retour', texte: '‹ Mes demandes', hidden: true });
  const fermer = el('button', { type: 'button', classe: 'bouton bouton-texte support-fermer', id: 'support-fermer', texte: 'Fermer' });
  const titre = el('h2', { id: 'support-titre', texte: 'Mes demandes au support' });
  const sousTitre = el('p', { classe: 'support-sous-titre', id: 'support-sous-titre', hidden: true });
  const erreur = el('p', { classe: 'alerte', id: 'support-erreur', role: 'alert', hidden: true });

  // Vue « Mes demandes »
  const nouvelle = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-large', id: 'support-nouvelle', texte: 'Nouvelle demande' });
  const liste = el('ul', { classe: 'support-liste', id: 'support-liste', 'aria-label': 'Mes demandes' });
  const vide = el('p', { classe: 'support-vide', id: 'support-vide', hidden: true,
    texte: 'Aucune demande pour le moment. Une question sur une course, un paiement, un objet oublié, votre compte ? Écrivez à LOC RÉACTION.' });
  const vueListe = el('div', { classe: 'support-vue', id: 'support-vue-liste' }, nouvelle, vide, liste);

  // Vue « une demande »
  const fil = el('ol', { classe: 'support-fil', id: 'support-fil', role: 'log', 'aria-live': 'polite', 'aria-labelledby': 'support-titre' });
  const vueFil = el('div', { classe: 'support-vue', id: 'support-vue-fil', hidden: true }, fil);

  // Vue « Nouvelle demande »
  const champ = (id, libelle, controle, aide = null) => el('div', { classe: 'champ' },
    el('label', { for: id, texte: libelle }), controle,
    aide ? el('p', { classe: 'aide', texte: aide }) : null,
    el('p', { classe: 'erreur-champ', id: `${id}-erreur`, hidden: true }));
  const type = el('select', { id: 'support-type', classe: 'saisie' },
    ...Object.entries(TYPES).map(([valeur, libelle]) => el('option', { value: valeur, texte: libelle })));
  const course = el('select', { id: 'support-course', classe: 'saisie' }, el('option', { value: '', texte: 'Aucune course en particulier' }));
  const sujet = el('input', { id: 'support-sujet', classe: 'saisie', type: 'text', maxlength: '200', required: true,
    placeholder: 'Ex. : client absent au rendez-vous' });
  const message = el('textarea', { id: 'support-message', classe: 'saisie', rows: '5', maxlength: '2000', required: true });
  const envoyerDemande = el('button', { type: 'submit', classe: 'bouton bouton-principal bouton-large', id: 'support-envoyer-demande', texte: 'Envoyer la demande' });
  const vueNouvelle = el('form', { classe: 'support-vue support-formulaire', id: 'support-vue-nouvelle', novalidate: true, hidden: true },
    champ('support-type', 'De quoi s\'agit-il ?', type),
    champ('support-course', 'Course concernée (facultatif)', course),
    champ('support-sujet', 'Sujet', sujet),
    champ('support-message', 'Votre message', message, 'Donnez les détails utiles : heure, lieu, montant… LOC RÉACTION vous répond ici.'),
    envoyerDemande);

  // Bas du panneau : réponse dans le fil
  const reponse = el('textarea', { id: 'support-reponse-texte', classe: 'saisie', rows: '1', maxlength: '2000',
    'aria-label': 'Votre réponse', placeholder: 'Votre réponse' });
  const fichier = el('input', { type: 'file', id: 'support-reponse-fichier', classe: 'visuellement-cache',
    accept: FORMATS.join(','), tabindex: '-1', 'aria-hidden': 'true' });
  const joindre = el('button', { type: 'button', classe: 'bouton bouton-secondaire support-joindre', id: 'support-joindre', texte: 'Photo' });
  const piece = el('p', { classe: 'support-piece-choisie', id: 'support-piece-choisie', hidden: true });
  const envoyerReponse = el('button', { type: 'submit', classe: 'bouton bouton-principal', id: 'support-reponse-envoyer', texte: 'Envoyer' });
  const formReponse = el('form', { classe: 'support-reponse', id: 'support-reponse', novalidate: true },
    piece, el('div', { classe: 'support-reponse-ligne' }, joindre, reponse, envoyerReponse), fichier);
  const fermee = el('div', { classe: 'support-fermee', id: 'support-fermee', hidden: true },
    el('p', { id: 'support-fermee-texte' }),
    el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'support-fermee-nouvelle', texte: 'Nouvelle demande',
      onclick: () => montrerNouvelle({ course: etat.courant ? etat.courant.course_id : null }) }));
  const bas = el('div', { classe: 'support-bas', id: 'support-bas', hidden: true }, formReponse, fermee);

  const panneau = el('dialog', { classe: 'support', id: 'support', 'aria-labelledby': 'support-titre' },
    el('header', { classe: 'support-entete' }, el('div', { classe: 'support-barre' }, retour, fermer), titre, sousTitre),
    el('div', { classe: 'support-corps', id: 'support-corps' }, erreur, vueListe, vueFil, vueNouvelle),
    bas);
  document.body.append(panneau);

  fermer.addEventListener('click', () => panneau.close());
  panneau.addEventListener('close', arreterSuivi);
  retour.addEventListener('click', () => montrerListe());
  nouvelle.addEventListener('click', () => montrerNouvelle());
  vueNouvelle.addEventListener('submit', (e) => { e.preventDefault(); creerDemande(); });
  vueNouvelle.addEventListener('input', (e) => { if (e.target.getAttribute('aria-invalid') === 'true') marquer(e.target.id, null); });
  formReponse.addEventListener('submit', (e) => { e.preventDefault(); repondre(); });
  joindre.addEventListener('click', () => fichier.click());
  fichier.addEventListener('change', choisirPiece);
  reponse.addEventListener('input', () => {
    reponse.style.height = 'auto';
    reponse.style.height = `${Math.min(reponse.scrollHeight, 120)}px`;
  });

  // ---------------------------------------------------------------------------
  // Ouverture : liste, une demande (id), ou nouvelle demande (course facultative)
  // ---------------------------------------------------------------------------
  async function ouvrir({ demande = null, nouvelle: creer = false, course: idCourse = null } = {}) {
    if (!panneau.open) panneau.showModal();
    montrerErreur(null);
    if (creer) {
      await montrerNouvelle({ course: idCourse });
      return;
    }
    try {
      await chargerDemandes();
    } catch (e) {
      montrerVue('liste');
      montrerErreur(e);
      return;
    }
    if (demande) {
      const d = etat.demandes.find((x) => x.id === demande);
      if (d) {
        await montrerFil(d);
        return;
      }
      afficherMessage('Cette demande est introuvable : voici toutes vos demandes.', 'erreur');
    }
    montrerVue('liste');
    afficherListe();
  }

  function montrerVue(vue) {
    etat.vue = vue;
    vueListe.hidden = vue !== 'liste';
    vueFil.hidden = vue !== 'fil';
    vueNouvelle.hidden = vue !== 'nouvelle';
    retour.hidden = vue === 'liste';
    bas.hidden = vue !== 'fil';
    if (vue !== 'fil') arreterSuivi();
    if (vue === 'liste') {
      titre.textContent = 'Mes demandes au support';
      sousTitre.hidden = true;
    }
    panneau.querySelector('.support-corps').scrollTop = 0;
  }

  function montrerErreur(e) {
    erreur.hidden = !e;
    erreur.textContent = e ? messageErreur(e) : '';
  }

  // ---------------------------------------------------------------------------
  // Mes demandes
  // ---------------------------------------------------------------------------
  async function chargerDemandes() {
    const { data, error } = await supabase.rpc('mes_demandes');
    if (error) throw error;
    etat.demandes = Array.isArray(data) ? data : [];
  }

  async function montrerListe() {
    montrerVue('liste');
    montrerErreur(null);
    try {
      await chargerDemandes();
    } catch (e) {
      montrerErreur(e);
    }
    afficherListe();
  }

  function afficherListe() {
    vide.hidden = etat.demandes.length > 0;
    liste.replaceChildren(...etat.demandes.map((d) => {
      const bouton = el('button', { type: 'button', classe: 'support-demande', dataset: { statut: d.statut, id: d.id } },
        el('span', { classe: 'support-demande-entete' },
          el('span', { classe: 'support-numero', texte: d.numero }),
          el('span', { classe: 'support-statut', dataset: { statut: d.statut }, texte: STATUTS[d.statut] || d.statut })),
        el('span', { classe: 'support-demande-sujet', texte: d.sujet }),
        el('span', { classe: 'support-demande-infos',
          texte: [TYPES_COURTS[d.type] || d.type, d.course_numero, quand(d.activite)].filter(Boolean).join(' · ') }),
        d.non_lus > 0
          ? el('span', { classe: 'support-non-lus', texte: d.non_lus > 1 ? `${d.non_lus} réponses non lues` : '1 réponse non lue' })
          : null);
      bouton.addEventListener('click', () => montrerFil(d));
      return el('li', {}, bouton);
    }));
  }

  // ---------------------------------------------------------------------------
  // Une demande : le fil
  // ---------------------------------------------------------------------------
  async function montrerFil(d) {
    etat.courant = d;
    etat.messages = [];
    montrerVue('fil');
    titre.textContent = d.sujet;
    sousTitre.hidden = false;
    sousTitre.textContent = [d.numero, STATUTS[d.statut] || d.statut, d.course_numero ? `course ${d.course_numero}` : null].filter(Boolean).join(' · ');
    const ouverte = ['ouverte', 'en_cours'].includes(d.statut);
    formReponse.hidden = !ouverte;
    fermee.hidden = ouverte;
    $id('support-fermee-texte').textContent = d.statut === 'resolue'
      ? 'Demande résolue. Pour une autre question, ouvrez une nouvelle demande.'
      : 'Demande fermée. Pour une autre question, ouvrez une nouvelle demande.';
    viderReponse();
    fil.replaceChildren();
    await relireFil({ premiere: true });
    suivre(d.id);
  }

  async function relireFil({ premiere = false } = {}) {
    const d = etat.courant;
    if (!d) return;
    const { data, error } = await supabase.from('messages').select('id, auteur_id, contenu, piece_jointe_chemin, lu_le, cree_le')
      .eq('demande_id', d.id).order('cree_le', { ascending: true }).limit(500);
    if (!etat.courant || etat.courant.id !== d.id) return;   // autre demande ouverte entre-temps
    if (error) {
      if (premiere) montrerErreur(error);
      return;
    }
    const avant = etat.messages.length;
    etat.messages = data || [];
    fil.replaceChildren(...etat.messages.map(bulle));
    if (premiere || etat.messages.length > avant) descendre();
    marquerReponsesLues(d);
  }

  function bulle(m) {
    const auteur = m.auteur_id === moi ? 'moi' : 'equipe';
    return el('li', { classe: 'support-message', dataset: { auteur } },
      auteur === 'equipe' ? el('span', { classe: 'support-auteur', texte: 'LOC RÉACTION' }) : null,
      m.contenu ? el('p', { classe: 'support-bulle', texte: m.contenu }) : null,
      m.piece_jointe_chemin ? boutonPiece(m.piece_jointe_chemin) : null,
      el('span', { classe: 'support-heure', texte: quand(m.cree_le) }));
  }

  function boutonPiece(chemin) {
    const b = el('button', { type: 'button', classe: 'bouton bouton-texte support-piece', texte: chemin.endsWith('.pdf') ? 'Ouvrir le PDF joint' : 'Ouvrir la photo jointe' });
    b.addEventListener('click', () => ouvrirFichier('support', chemin).catch((e) => afficherMessage(messageErreur(e), 'erreur')));
    return b;
  }

  // Réponses de LOC RÉACTION lues, et la notification de la demande aussi
  async function marquerReponsesLues(d) {
    if (!etat.messages.some((m) => m.auteur_id !== moi && !m.lu_le)) return;
    const maintenant = new Date().toISOString();
    const { error } = await supabase.from('messages').update({ lu_le: maintenant })
      .eq('demande_id', d.id).neq('auteur_id', moi).is('lu_le', null);
    if (error) return;
    etat.messages.forEach((m) => { if (m.auteur_id !== moi && !m.lu_le) m.lu_le = maintenant; });
    d.non_lus = 0;
    await supabase.from('notifications').update({ lu_le: maintenant })
      .eq('destinataire_id', moi).eq('lien', `/chauffeur/demandes/?id=${d.id}`).is('lu_le', null);
  }

  function descendre() {
    const corps = panneau.querySelector('.support-corps');
    corps.scrollTop = corps.scrollHeight;
  }

  // Nouvelles réponses pendant que le fil est ouvert
  function suivre(id) {
    arreterSuivi();
    etat.canal = supabase.channel(`support-${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `demande_id=eq.${id}` }, () => relireFil())
      .subscribe();
    etat.minuteur = setInterval(() => relireFil(), RELECTURE_MS);
  }

  function arreterSuivi() {
    clearInterval(etat.minuteur);
    etat.minuteur = null;
    if (etat.canal) supabase.removeChannel(etat.canal);
    etat.canal = null;
  }

  // ---------------------------------------------------------------------------
  // Répondre (texte, photo ou PDF)
  // ---------------------------------------------------------------------------
  function choisirPiece() {
    const f = fichier.files && fichier.files[0];
    fichier.value = '';
    if (!f) return;
    if (!FORMATS.includes(f.type) && !['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'].includes(extension(f))) {
      afficherMessage('Format non accepté : photo (JPEG, PNG, WebP, HEIC) ou PDF.', 'erreur');
      return;
    }
    if (f.size > TAILLE_MAX) {
      afficherMessage('Fichier trop lourd : 10 Mo au plus.', 'erreur');
      return;
    }
    etat.piece = f;
    const retirer = el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'support-piece-retirer', texte: 'Retirer' });
    retirer.addEventListener('click', () => { etat.piece = null; piece.hidden = true; piece.replaceChildren(); });
    piece.replaceChildren(el('span', { texte: `Pièce jointe : ${f.name}` }), retirer);
    piece.hidden = false;
  }

  function viderReponse() {
    reponse.value = '';
    reponse.style.height = 'auto';
    etat.piece = null;
    piece.hidden = true;
    piece.replaceChildren();
  }

  async function repondre() {
    const d = etat.courant;
    const contenu = reponse.value.trim();
    if (!d || etat.envoi) return;
    if (!contenu && !etat.piece) {
      afficherMessage('Écrivez votre réponse ou joignez une photo.', 'erreur');
      reponse.focus();
      return;
    }
    etat.envoi = true;
    envoyerReponse.disabled = true;
    joindre.disabled = true;
    let chemin = null;
    try {
      if (etat.piece) {
        chemin = `${d.id}/${crypto.randomUUID()}.${extension(etat.piece) || 'jpg'}`;
        const envoi = await supabase.storage.from('support')
          .upload(chemin, etat.piece, { contentType: etat.piece.type || undefined, upsert: false });
        if (envoi.error) throw envoi.error;
      }
      const { error } = await supabase.from('messages').insert({ demande_id: d.id, auteur_id: moi, contenu: contenu || null, piece_jointe_chemin: chemin });
      if (error) throw error;
      viderReponse();
      await relireFil();
      descendre();
    } catch (e) {
      // Pièce déposée mais message refusé : la pièce ne reste pas orpheline
      if (chemin) await supabase.storage.from('support').remove([chemin]).catch(() => {});
      afficherMessage(/row-level security/i.test(e && e.message || '')
        ? 'Réponse non envoyée : cette demande est close. Ouvrez une nouvelle demande.'
        : messageErreur(e), 'erreur');
    } finally {
      etat.envoi = false;
      envoyerReponse.disabled = false;
      joindre.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Nouvelle demande
  // ---------------------------------------------------------------------------
  async function montrerNouvelle({ course: idCourse = null } = {}) {
    montrerVue('nouvelle');
    titre.textContent = 'Nouvelle demande';
    sousTitre.hidden = true;
    for (const id of ['support-type', 'support-course', 'support-sujet', 'support-message']) marquer(id, null);
    sujet.value = '';
    message.value = '';
    type.value = 'course';
    await chargerCourses(idCourse);
    course.value = idCourse || '';
    (idCourse ? sujet : type).focus();
  }

  // Mes 20 dernières courses (et celle qui est demandée, si elle est plus ancienne)
  async function chargerCourses(idCourse) {
    const { data, error } = await supabase.from('courses').select('id, numero, prise_en_charge_le, depart_adresse, arrivee_adresse')
      .eq('chauffeur_id', moi).order('prise_en_charge_le', { ascending: false }).limit(20);
    const courses = error ? [] : (data || []);
    if (idCourse && !courses.some((c) => c.id === idCourse)) {
      const seule = await supabase.from('courses').select('id, numero, prise_en_charge_le, depart_adresse, arrivee_adresse')
        .eq('id', idCourse).maybeSingle();
      if (!seule.error && seule.data) courses.unshift(seule.data);
    }
    course.replaceChildren(el('option', { value: '', texte: 'Aucune course en particulier' }),
      ...courses.map((c) => el('option', { value: c.id,
        texte: [c.numero, c.prise_en_charge_le ? dateHeure(c.prise_en_charge_le, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null,
                c.depart_adresse].filter(Boolean).join(' · ') })));
  }

  function marquer(id, texte) {
    const champ = document.getElementById(id);
    const zone = document.getElementById(`${id}-erreur`);
    if (!champ || !zone) return;
    if (texte) champ.setAttribute('aria-invalid', 'true');
    else champ.removeAttribute('aria-invalid');
    zone.hidden = !texte;
    zone.textContent = texte || '';
  }

  async function creerDemande() {
    const s = sujet.value.trim();
    const m = message.value.trim();
    let valide = true;
    if (s.length < 3) { marquer('support-sujet', 'Indiquez le sujet (3 caractères au moins).'); valide = false; }
    if (!m) { marquer('support-message', 'Décrivez votre demande.'); valide = false; }
    if (!valide) {
      (s.length < 3 ? sujet : message).focus();
      return;
    }
    envoyerDemande.disabled = true;
    try {
      const { data, error } = await supabase.rpc('ouvrir_demande',
        { p_type: type.value, p_sujet: s, p_message: m, p_course: course.value || null });
      if (error) throw error;
      afficherMessage(`Demande ${data.numero} envoyée : LOC RÉACTION vous répond ici.`, 'succes');
      await chargerDemandes();
      const d = etat.demandes.find((x) => x.id === data.id);
      if (d) await montrerFil(d);
      else await montrerListe();
    } catch (e) {
      afficherMessage(messageErreur(e), 'erreur');
    } finally {
      envoyerDemande.disabled = false;
    }
  }

  return { ouvrir, fermer: () => { if (panneau.open) panneau.close(); } };
}

const $id = (id) => document.getElementById(id);

// « Aujourd'hui, 13:20 », « Hier, 18:02 », « 3 nov., 09:14 »
function quand(instant) {
  const jour = (d) => dateHeure(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const heure = dateHeure(instant, { hour: '2-digit', minute: '2-digit' });
  const aujourdhui = new Date();
  if (jour(instant) === jour(aujourdhui)) return `Aujourd'hui, ${heure}`;
  if (jour(instant) === jour(new Date(aujourdhui.getTime() - 86400000))) return `Hier, ${heure}`;
  return dateHeure(instant, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
