// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : flotte
// -----------------------------------------------------------------------------
// Une fiche par véhicule : identité, échéances (assurance, contrôle technique,
// vignette VTC) colorées à l'approche de la date, kilométrage, chauffeurs qui
// l'utilisent ; entretiens (le kilométrage du véhicule suit le dernier relevé)
// et pièces du véhicule (déposées par l'administration dans le dossier privé
// « documents », validées aussitôt : leur date d'expiration est reportée sur
// la fiche). Un véhicule utilisé par des courses ne se supprime pas : on le
// désactive. Tout est inscrit au journal des modifications.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, afficherMessage } from '../../commun/outils.js';
import { ouvrirAdministration } from '../commun/admin.js';
import {
  badge, dateCourte, echeance, jourParis, tableau, exporterCsv, nombreCsv, boutonExporter, fenetreFormulaire,
  confirmer, messageErreurAdmin, nomComplet, ouvrirPiece, TYPES_DOCUMENT, STATUTS_DOCUMENT, DOCUMENTS_DATES
} from '../commun/composants.js';

const $ = (id) => document.getElementById(id);
const ENERGIES = { hybride: 'Hybride', electrique: 'Électrique', essence: 'Essence', diesel: 'Diesel', autre: 'Autre' };
const TYPES_ENTRETIEN = {
  vidange: 'Vidange', pneus: 'Pneus', revision: 'Révision', freins: 'Freins', reparation: 'Réparation',
  controle_technique: 'Contrôle technique', autre: 'Autre'
};
const PIECES_VEHICULE = ['assurance', 'carte_grise', 'controle_technique', 'vignette_vtc', 'autre'];
const FORMATS = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const etat = { vehicules: [], categories: [], chauffeurs: [], entretiens: [], documents: [] };

ouvrirAdministration({ module: 'flotte' }).then(async () => {
  $('ajouter-vehicule').addEventListener('click', () => formulaireVehicule(null));
  $('entete-actions').append(boutonExporter(exporter));
  await charger();
});

async function charger() {
  const [vehicules, categories, chauffeurs, entretiens, documents] = await Promise.all([
    supabase.from('vehicules').select('*').order('actif', { ascending: false }).order('immatriculation'),
    supabase.from('categories').select('id, nom_fr, active').order('ordre'),
    supabase.from('chauffeurs').select('id, vehicule_id, statut'),
    supabase.from('entretiens').select('*').order('jour', { ascending: false }),
    supabase.from('documents').select('*').not('vehicule_id', 'is', null).order('cree_le', { ascending: false })
  ]);
  const erreur = vehicules.error || categories.error || chauffeurs.error || entretiens.error || documents.error;
  if (erreur) { $('vehicules').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(erreur) })); return; }
  etat.vehicules = vehicules.data;
  etat.categories = categories.data;
  etat.entretiens = entretiens.data;
  etat.documents = documents.data;
  // Noms des chauffeurs qui ont un véhicule
  const avecVehicule = chauffeurs.data.filter((c) => c.vehicule_id);
  let noms = [];
  if (avecVehicule.length) {
    const { data } = await supabase.from('profils').select('id, prenom, nom').in('id', avecVehicule.map((c) => c.id));
    noms = data || [];
  }
  etat.chauffeurs = avecVehicule.map((c) => ({ ...c, ...(noms.find((n) => n.id === c.id) || {}) }));
  afficher();
}

function afficher() {
  const actifs = etat.vehicules.filter((v) => v.actif).length;
  $('resume-flotte').textContent = etat.vehicules.length
    ? `${etat.vehicules.length} véhicule${etat.vehicules.length > 1 ? 's' : ''}, dont ${actifs} en service.` : '';
  $('vehicules').replaceChildren(...(etat.vehicules.length
    ? etat.vehicules.map(ficheVehicule)
    : [el('section', { classe: 'carte-admin' }, el('p', { classe: 'vide-admin', texte: 'Aucun véhicule. Ajoutez le premier avec le bouton « Ajouter un véhicule ».' }))]));
}

function bouton(texte, action, classe = 'bouton-secondaire') {
  const b = el('button', { type: 'button', classe: `bouton ${classe} bouton-petit`, texte });
  b.addEventListener('click', async () => { b.disabled = true; try { await action(); } finally { b.disabled = false; } });
  return b;
}

function categorie(id) {
  return (etat.categories.find((c) => c.id === id) || {}).nom_fr || '—';
}

function ficheVehicule(v) {
  const conducteurs = etat.chauffeurs.filter((c) => c.vehicule_id === v.id);
  const entretiens = etat.entretiens.filter((e) => e.vehicule_id === v.id);
  const pieces = etat.documents.filter((d) => d.vehicule_id === v.id);
  const identite = [v.couleur, ENERGIES[v.energie], `${v.places} places`, v.annee ? String(v.annee) : null,
    v.mise_en_circulation ? `1re mise en circulation le ${dateCourte(v.mise_en_circulation)}` : null].filter(Boolean).join(' · ');
  return el('section', { classe: `carte-admin fiche-vehicule${v.actif ? '' : ' inactif'}`, 'aria-label': `${v.marque} ${v.modele} ${v.immatriculation}` },
    el('div', { classe: 'carte-entete' },
      el('h2', {}, `${v.marque} ${v.modele} `, el('span', { classe: 'plaque', texte: v.immatriculation })),
      v.actif ? badge('En service', 'vert') : badge('Désactivé', 'gris'),
      badge(categorie(v.categorie_id), 'bleu')),
    el('p', { classe: 'sous-titre', texte: identite }),
    el('dl', { classe: 'fiche-donnees' },
      el('dt', { texte: 'Kilométrage' }), el('dd', { texte: `${nombre(v.kilometrage, 0)} km` }),
      el('dt', { texte: 'Assurance' }), el('dd', {}, echeance(v.assurance_expiration)),
      el('dt', { texte: 'Contrôle technique' }), el('dd', {}, echeance(v.controle_technique_expiration)),
      el('dt', { texte: 'Vignette VTC' }), el('dd', {}, v.vignette_vtc_numero ? `n° ${v.vignette_vtc_numero} · ` : '', echeance(v.vignette_vtc_expiration)),
      el('dt', { texte: 'Chauffeur' }), el('dd', { texte: conducteurs.length ? conducteurs.map((c) => nomComplet(c.prenom, c.nom)).join(', ') : 'Aucun' }),
      ...(v.notes ? [el('dt', { texte: 'Notes' }), el('dd', { classe: 'texte-long', texte: v.notes })] : [])),
    el('details', { classe: 'repli' },
      el('summary', { texte: `Entretiens (${entretiens.length})` }),
      tableau({
        colonnes: [
          { titre: 'Date', valeur: (e) => dateCourte(e.jour) },
          { titre: 'Type', valeur: (e) => TYPES_ENTRETIEN[e.type] || e.type },
          { titre: 'Kilométrage', droite: true, valeur: (e) => (e.kilometrage !== null ? `${nombre(e.kilometrage, 0)} km` : '—') },
          { titre: 'Montant TTC', droite: true, valeur: (e) => (e.montant !== null ? euros(e.montant) : '—') },
          { titre: 'Détail', valeur: (e) => e.description || '—' },
          { titre: '', valeur: (e) => bouton('Supprimer', () => supprimerEntretien(e), 'bouton-danger') }
        ],
        lignes: entretiens, vide: 'Aucun entretien enregistré.'
      }),
      el('div', { classe: 'actions-ligne' }, bouton('Ajouter un entretien', () => ajouterEntretien(v)))),
    el('details', { classe: 'repli' },
      el('summary', { texte: `Pièces du véhicule (${pieces.length})` }),
      pieces.length ? el('ul', { classe: 'documents' }, ...pieces.map((d) => el('li', {},
        el('div', {}, el('strong', { texte: TYPES_DOCUMENT[d.type] || d.type }), ' ',
          badge((STATUTS_DOCUMENT[d.statut] || {}).libelle || d.statut, (STATUTS_DOCUMENT[d.statut] || {}).ton || 'gris'),
          el('span', { classe: 'secondaire', texte: [d.numero ? `n° ${d.numero}` : null, d.expire_le ? `jusqu'au ${dateCourte(d.expire_le)}` : null,
            `ajoutée le ${dateCourte(d.cree_le)}`].filter(Boolean).join(' · ') })),
        el('div', { classe: 'actions-ligne' }, bouton('Voir la pièce', () => voirPiece(d))))))
        : el('p', { classe: 'texte-gris', texte: 'Aucune pièce. Ajoutez la carte grise, l\'attestation d\'assurance, le contrôle technique…' }),
      el('div', { classe: 'actions-ligne' }, bouton('Ajouter une pièce', () => ajouterPiece(v)))),
    el('div', { classe: 'actions-ligne' },
      bouton('Modifier', () => formulaireVehicule(v)),
      v.actif ? bouton('Désactiver', () => basculerActif(v, conducteurs), 'bouton-danger') : bouton('Remettre en service', () => basculerActif(v, conducteurs), 'bouton-principal')));
}

async function voirPiece(d) {
  try { await ouvrirPiece('documents', d.fichier_chemin); }
  catch (erreur) { afficherMessage(messageErreurAdmin(erreur), 'erreur'); }
}

// ---------------------------------------------------------------------------
// Véhicule : ajout et modification
// ---------------------------------------------------------------------------
async function formulaireVehicule(v) {
  const nouveau = !v;
  const champs = [
    { nom: 'immatriculation', libelle: 'Immatriculation', type: 'texte', requis: true, majuscules: true, longueur: 12,
      motif: /^[A-Z0-9-]{4,12}$/, messageMotif: 'Lettres, chiffres et tirets, sans espace (ex. GA-123-BC).' },
    { nom: 'categorie_id', libelle: 'Catégorie', type: 'choix', requis: true,
      options: etat.categories.map((c) => ({ valeur: c.id, libelle: c.nom_fr + (c.active ? '' : ' (désactivée)') })) },
    { nom: 'marque', libelle: 'Marque', type: 'texte', requis: true, longueur: 40 },
    { nom: 'modele', libelle: 'Modèle', type: 'texte', requis: true, longueur: 60 },
    { nom: 'couleur', libelle: 'Couleur (affichée au client)', type: 'texte', longueur: 30 },
    { nom: 'energie', libelle: 'Énergie', type: 'choix', requis: true, options: Object.entries(ENERGIES).map(([valeur, libelle]) => ({ valeur, libelle })) },
    { nom: 'places', libelle: 'Places passagers', type: 'nombre', requis: true, min: 1, max: 8, pas: '1' },
    { nom: 'annee', libelle: 'Année', type: 'nombre', min: 1990, max: 2100, pas: '1' },
    { nom: 'mise_en_circulation', libelle: '1re mise en circulation', type: 'date' },
    { nom: 'kilometrage', libelle: 'Kilométrage', type: 'nombre', requis: true, min: 0, pas: '1' },
    { nom: 'assurance_expiration', libelle: 'Assurance valable jusqu\'au', type: 'date',
      aide: 'Sans assurance à jour, aucun chauffeur ne peut passer en ligne avec ce véhicule.' },
    { nom: 'controle_technique_expiration', libelle: 'Contrôle technique valable jusqu\'au', type: 'date' },
    { nom: 'vignette_vtc_numero', libelle: 'N° de vignette VTC', type: 'texte', longueur: 40 },
    { nom: 'vignette_vtc_expiration', libelle: 'Vignette VTC valable jusqu\'au', type: 'date' },
    { nom: 'notes', libelle: 'Notes', type: 'zone', longueur: 1000, plein: true }
  ];
  const valeurs = v || { energie: 'hybride', places: 4, kilometrage: 0, categorie_id: (etat.categories.find((c) => c.active) || {}).id };
  const fait = await fenetreFormulaire({
    titre: nouveau ? 'Ajouter un véhicule' : `Modifier ${v.immatriculation}`, champs, valeurs, large: true,
    libelle: nouveau ? 'Ajouter' : 'Enregistrer',
    enregistrer: async (lues) => {
      const ligne = { ...lues, places: Math.round(lues.places), kilometrage: Math.round(lues.kilometrage), annee: lues.annee ? Math.round(lues.annee) : null };
      const { error } = nouveau
        ? await supabase.from('vehicules').insert(ligne)
        : await supabase.from('vehicules').update(ligne).eq('id', v.id);
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage(nouveau ? 'Véhicule ajouté.' : 'Véhicule enregistré.', 'succes'); await charger(); }
}

async function basculerActif(v, conducteurs) {
  if (v.actif) {
    const ok = await confirmer({
      titre: `Désactiver ${v.immatriculation} ?`,
      texte: conducteurs.length
        ? `${conducteurs.map((c) => nomComplet(c.prenom, c.nom)).join(', ')} ne pourr${conducteurs.length > 1 ? 'ont' : 'a'} plus passer en ligne avec ce véhicule : affectez-${conducteurs.length > 1 ? 'leur' : 'lui'} un autre véhicule dans le module Chauffeurs.`
        : 'Le véhicule ne pourra plus être affecté à un chauffeur. Son historique est conservé.',
      libelle: 'Désactiver', danger: true
    });
    if (!ok) return;
  }
  const { error } = await supabase.from('vehicules').update({ actif: !v.actif }).eq('id', v.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(v.actif ? 'Véhicule désactivé.' : 'Véhicule remis en service.', 'succes');
  await charger();
}

// ---------------------------------------------------------------------------
// Entretiens
// ---------------------------------------------------------------------------
async function ajouterEntretien(v) {
  const fait = await fenetreFormulaire({
    titre: `Entretien de ${v.immatriculation}`,
    champs: [
      { nom: 'jour', libelle: 'Date', type: 'date', requis: true, max: jourParis() },
      { nom: 'type', libelle: 'Type', type: 'choix', requis: true, options: Object.entries(TYPES_ENTRETIEN).map(([valeur, libelle]) => ({ valeur, libelle })) },
      { nom: 'kilometrage', libelle: 'Kilométrage relevé', type: 'nombre', min: 0, pas: '1' },
      { nom: 'montant', libelle: 'Montant TTC (€)', type: 'nombre', min: 0, pas: '0.01' },
      { nom: 'description', libelle: 'Détail', type: 'zone', longueur: 1000, plein: true }
    ],
    valeurs: { jour: jourParis(), type: 'revision', kilometrage: v.kilometrage },
    libelle: 'Ajouter',
    enregistrer: async (lues) => {
      const km = lues.kilometrage !== null ? Math.round(lues.kilometrage) : null;
      const { error } = await supabase.from('entretiens').insert({ ...lues, kilometrage: km, vehicule_id: v.id });
      if (error) throw error;
      // Le kilométrage du véhicule suit le relevé le plus élevé
      if (km !== null && km > v.kilometrage) {
        const { error: erreurKm } = await supabase.from('vehicules').update({ kilometrage: km }).eq('id', v.id);
        if (erreurKm) throw erreurKm;
      }
    }
  });
  if (fait) { afficherMessage('Entretien enregistré.', 'succes'); await charger(); }
}

async function supprimerEntretien(e) {
  const ok = await confirmer({ titre: 'Supprimer cet entretien ?', texte: `${TYPES_ENTRETIEN[e.type] || e.type} du ${dateCourte(e.jour)}.`, libelle: 'Supprimer', danger: true });
  if (!ok) return;
  const { error } = await supabase.from('entretiens').delete().eq('id', e.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Entretien supprimé.', 'succes');
  await charger();
}

// ---------------------------------------------------------------------------
// Pièces du véhicule
// ---------------------------------------------------------------------------
async function ajouterPiece(v) {
  const fichier = el('input', { id: 'piece-fichier', classe: 'saisie', type: 'file', accept: '.pdf,image/*', required: true });
  const blocFichier = el('div', { classe: 'champ' },
    el('label', { for: 'piece-fichier', texte: 'Fichier (PDF ou photo, 10 Mo au plus)' }), fichier);
  const fait = await fenetreFormulaire({
    titre: `Pièce de ${v.immatriculation}`,
    intro: 'La pièce est rangée dans le dossier privé des documents et validée aussitôt : sa date d\'expiration est reportée sur la fiche du véhicule.',
    avant: [blocFichier],
    champs: [
      { nom: 'type', libelle: 'Pièce', type: 'choix', requis: true, options: PIECES_VEHICULE.map((t) => ({ valeur: t, libelle: TYPES_DOCUMENT[t] })) },
      { nom: 'numero', libelle: 'Numéro (police, vignette…)', type: 'texte', longueur: 60 },
      { nom: 'expire_le', libelle: 'Valable jusqu\'au', type: 'date', aide: 'Obligatoire pour l\'assurance, le contrôle technique et la vignette VTC.' }
    ],
    valeurs: { type: 'assurance' },
    libelle: 'Ajouter la pièce',
    enregistrer: async (lues) => {
      const choisi = fichier.files[0];
      if (!choisi) throw new Error('Choisissez le fichier de la pièce.');
      if (choisi.size > 10 * 1024 * 1024) throw new Error('Fichier trop lourd : 10 Mo au plus.');
      if (choisi.type && !FORMATS.includes(choisi.type)) throw new Error('Format refusé : PDF, JPEG, PNG, WebP ou HEIC.');
      if (DOCUMENTS_DATES.includes(lues.type) && !lues.expire_le) throw new Error('Indiquez la date de fin de validité de cette pièce.');
      const extension = (choisi.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'pdf';
      const chemin = `vehicules/${v.id}/${lues.type}-${Date.now()}.${extension}`;
      const envoi = await supabase.storage.from('documents').upload(chemin, choisi, { contentType: choisi.type || undefined, upsert: false });
      if (envoi.error) throw envoi.error;
      const { data, error } = await supabase.from('documents')
        .insert({ vehicule_id: v.id, type: lues.type, fichier_chemin: chemin, numero: lues.numero, expire_le: lues.expire_le })
        .select('id').single();
      if (error) throw error;
      const validation = await supabase.rpc('admin_verifier_document', {
        p_document: data.id, p_statut: 'valide', p_commentaire: null, p_numero: lues.numero, p_expire_le: lues.expire_le
      });
      if (validation.error) throw validation.error;
    }
  });
  if (fait) { afficherMessage('Pièce ajoutée.', 'succes'); await charger(); }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function exporter() {
  const colonnes = [
    { titre: 'Immatriculation', csv: (v) => v.immatriculation },
    { titre: 'Marque', csv: (v) => v.marque },
    { titre: 'Modèle', csv: (v) => v.modele },
    { titre: 'Couleur', csv: (v) => v.couleur },
    { titre: 'Catégorie', csv: (v) => categorie(v.categorie_id) },
    { titre: 'Énergie', csv: (v) => ENERGIES[v.energie] || v.energie },
    { titre: 'Places', csv: (v) => v.places },
    { titre: 'Année', csv: (v) => v.annee },
    { titre: 'Kilométrage', csv: (v) => v.kilometrage },
    { titre: 'Assurance jusqu\'au', csv: (v) => (v.assurance_expiration ? dateCourte(v.assurance_expiration) : '') },
    { titre: 'Contrôle technique jusqu\'au', csv: (v) => (v.controle_technique_expiration ? dateCourte(v.controle_technique_expiration) : '') },
    { titre: 'Vignette VTC', csv: (v) => v.vignette_vtc_numero },
    { titre: 'Vignette VTC jusqu\'au', csv: (v) => (v.vignette_vtc_expiration ? dateCourte(v.vignette_vtc_expiration) : '') },
    { titre: 'En service', csv: (v) => (v.actif ? 'oui' : 'non') },
    { titre: 'Chauffeur', csv: (v) => etat.chauffeurs.filter((c) => c.vehicule_id === v.id).map((c) => nomComplet(c.prenom, c.nom)).join(', ') },
    { titre: 'Entretiens (total TTC)', csv: (v) => nombreCsv(etat.entretiens.filter((e) => e.vehicule_id === v.id).reduce((s, e) => s + Number(e.montant || 0), 0).toFixed(2)) }
  ];
  exporterCsv(`flotte-loc-reaction-${jourParis()}.csv`, colonnes, etat.vehicules);
}
