// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : plateformes — rentabilité par chauffeur
// -----------------------------------------------------------------------------
// Pour une période, chauffeur par chauffeur :
//   - en direct : chiffre d'affaires HT des courses terminées et des frais
//     d'annulation (factures, avoirs déduits) ;
//   - plateformes : trajets des relevés qui se terminent dans la période,
//     leur HT (TVA du transport) et les frais de service retenus ;
//   - coût salarial : bulletins validés des mois de la période ;
//   - marge après salaire (hors véhicule et frais généraux) ;
//   - commission évitée : ce que les courses en direct auraient coûté en
//     frais de service, au taux moyen constaté sur les relevés.
// Lecture : admin_rentabilite_chauffeurs.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, afficherMessage } from '../../commun/outils.js';
import {
  tableau, tuile, badge, boutonExporter, exporterCsv, nombreCsv, messageErreurAdmin, pluriel
} from '../commun/composants.js';
import { lienAdmin } from '../commun/admin.js';
import { champsPeriode, bornes, periodeValable, periodeLisible, periodeCourte } from '../commun/periode.js';
import { ecrireAdresse, lireDate, nomFichier } from '../commun/listes.js';

const $ = (id) => document.getElementById(id);
const filtres = { du: '', au: '' };
const etat = { donnees: null };

export function afficherRentabilite({ parametres }) {
  const defaut = bornes('trimestre');
  filtres.du = lireDate(parametres, 'du') || defaut.du;
  filtres.au = lireDate(parametres, 'au') || defaut.au;
  if (!periodeValable(filtres.du, filtres.au)) Object.assign(filtres, defaut);
  $('entete-actions').replaceChildren(boutonExporter(exporter));

  const formulaire = el('form', { classe: 'barre-outils' },
    ...champsPeriode({ prefixe: 'rentabilite', du: filtres.du, au: filtres.au, changer: ({ du, au }) => { filtres.du = du; filtres.au = au; charger(); } }));
  formulaire.addEventListener('submit', (e) => e.preventDefault());

  $('contenu').replaceChildren(
    el('section', { classe: 'carte-admin', 'aria-label': 'Période' }, formulaire),
    el('div', { classe: 'chiffres-cles', id: 'chiffres-rentabilite', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-rentabilite' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-rentabilite', texte: 'Par chauffeur' }),
        el('span', { classe: 'sous-titre', id: 'periode-rentabilite' })),
      el('div', { id: 'liste-rentabilite' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-calcul' },
      el('h2', { id: 'titre-calcul', texte: 'Comment ces chiffres sont calculés' }),
      el('div', { classe: 'explication' },
        el('p', {}, el('strong', { texte: 'En direct' }), ' : les factures des courses terminées dans la période et des frais d\'annulation, avoirs déduits. Les pourboires vont au chauffeur : ils ne comptent pas dans le chiffre d\'affaires.'),
        el('p', {}, el('strong', { texte: 'Plateformes' }), ' : les relevés qui se terminent dans la période. Le hors taxes des trajets suit la TVA du transport (',
          el('span', { id: 'taux-tva' }), ').'),
        el('p', {}, el('strong', { texte: 'Coût salarial' }), ' : le coût total employeur des bulletins validés des mois qui commencent dans la période (module RH et paie).'),
        el('p', {}, el('strong', { texte: 'Marge après salaire' }), ' : chiffre d\'affaires HT, moins les frais de service des plateformes et le coût salarial. Hors véhicule (voir le module ',
          el('a', { href: lienAdmin('flotte/'), texte: 'Flotte' }), ') et frais généraux.'),
        el('p', {}, el('strong', { texte: 'Commission évitée' }), ' : ce qu\'auraient coûté les courses en direct en frais de service, au taux moyen constaté sur les relevés de la période. Une course commandée en direct garde cette part dans l\'entreprise, hors frais de paiement par carte.'))));
  charger();
}

async function charger() {
  ecrireAdresse('rentabilite', { du: filtres.du, au: filtres.au });
  const zone = $('liste-rentabilite');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_rentabilite_chauffeurs', { p_debut: filtres.du, p_fin: filtres.au });
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.donnees = data;
  const t = data.totaux;
  const periode = periodeCourte(filtres.du, filtres.au);

  $('chiffres-rentabilite').replaceChildren(
    tuile('Chiffre d\'affaires HT', euros(t.ca_ht),
      t.part_direct !== null ? `${nombre(t.part_direct, 1)} % en direct · ${periode}` : `aucune course · ${periode}`),
    tuile('Frais des plateformes', euros(t.plateformes.frais),
      data.taux_frais_moyen !== null ? `${nombre(data.taux_frais_moyen, 1)} % des trajets` : 'aucun relevé', Number(t.plateformes.frais) > 0 ? 'or' : null),
    tuile('Coût salarial', euros(t.cout_salarial.montant),
      Number(t.cout_salarial.bulletins) ? pluriel(t.cout_salarial.bulletins, 'bulletin validé', 'bulletins validés') : 'aucun bulletin validé'),
    tuile('Marge après salaire', euros(t.marge), 'hors véhicule et frais généraux', Number(t.marge) < 0 ? 'rouge' : null),
    tuile('Commission évitée en direct', t.commission_evitee !== null ? euros(t.commission_evitee) : '—',
      t.commission_evitee !== null ? `${euros(t.direct.ttc)} de courses en direct` : 'pas de relevé pour en mesurer le taux'));
  $('periode-rentabilite').textContent = `Période : ${periodeLisible(filtres.du, filtres.au)}`;
  $('taux-tva').textContent = `${nombre(data.taux_tva, 2)} %`;

  zone.replaceChildren(tableau({
    colonnes: [
      { titre: 'Chauffeur', valeur: (c) => el('span', {}, el('strong', { texte: c.nom }),
        el('span', { classe: 'secondaire' }, c.salarie ? 'salarié' : 'indépendant', c.statut === 'suspendu' ? [' ', badge('Suspendu', 'rouge')] : null)) },
      { titre: 'En direct (HT)', droite: true, valeur: (c) => el('span', {}, euros(c.direct.ht),
        el('span', { classe: 'secondaire', texte: (c.direct.courses || !Number(c.direct.ht) ? pluriel(c.direct.courses, 'course', 'courses') : 'frais d\'annulation')
          + (c.part_direct !== null ? ` · ${nombre(c.part_direct, 1)} % du chiffre d'affaires` : '') })) },
      { titre: 'Plateformes (HT)', droite: true, valeur: (c) => el('span', {}, euros(c.plateformes.ht),
        el('span', { classe: 'secondaire', texte: c.plateformes.releves
          ? `${pluriel(c.plateformes.releves, 'relevé', 'relevés')} · ${euros(c.plateformes.trajets)} TTC` : 'aucun relevé' })) },
      { titre: 'Frais des plateformes', droite: true, valeur: (c) => el('span', {}, euros(c.plateformes.frais),
        c.plateformes.taux_frais !== null ? el('span', { classe: 'secondaire', texte: `${nombre(c.plateformes.taux_frais, 1)} % des trajets` }) : null) },
      { titre: 'Coût salarial', droite: true, valeur: (c) => el('span', {}, euros(c.cout_salarial.montant),
        el('span', { classe: 'secondaire', texte: Number(c.cout_salarial.bulletins) ? pluriel(c.cout_salarial.bulletins, 'bulletin', 'bulletins') : 'aucun bulletin' })) },
      { titre: 'Marge après salaire', droite: true, valeur: (c) => el('span', {},
        el('strong', { classe: Number(c.marge) < 0 ? 'texte-rouge' : null, texte: euros(c.marge) }),
        Number(c.commission_evitee) > 0 ? el('span', { classe: 'secondaire', texte: `commission évitée ${euros(c.commission_evitee)}` }) : null) }
    ],
    lignes: data.chauffeurs,
    vide: 'Aucun chauffeur validé ni aucune activité sur cette période.'
  }));
}

function exporter() {
  if (!etat.donnees || !etat.donnees.chauffeurs.length) { afficherMessage('Rien à exporter sur cette période.'); return; }
  const colonnes = [
    { titre: 'Chauffeur', csv: (c) => c.nom },
    { titre: 'Statut', csv: (c) => (c.salarie ? 'salarié' : 'indépendant') + (c.statut === 'suspendu' ? ', suspendu' : '') },
    { titre: 'Courses en direct', csv: (c) => c.direct.courses },
    { titre: 'Direct HT', csv: (c) => nombreCsv(c.direct.ht) },
    { titre: 'Direct TTC', csv: (c) => nombreCsv(c.direct.ttc) },
    { titre: 'Pourboires en direct', csv: (c) => nombreCsv(c.direct.pourboires) },
    { titre: 'Relevés plateformes', csv: (c) => c.plateformes.releves },
    { titre: 'Courses plateformes', csv: (c) => c.plateformes.courses },
    { titre: 'Trajets plateformes TTC', csv: (c) => nombreCsv(c.plateformes.trajets) },
    { titre: 'Plateformes HT', csv: (c) => nombreCsv(c.plateformes.ht) },
    { titre: 'Frais de service', csv: (c) => nombreCsv(c.plateformes.frais) },
    { titre: 'Taux des frais (%)', csv: (c) => nombreCsv(c.plateformes.taux_frais) },
    { titre: 'Coût salarial', csv: (c) => nombreCsv(c.cout_salarial.montant) },
    { titre: 'Chiffre d\'affaires HT', csv: (c) => nombreCsv(c.ca_ht) },
    { titre: 'Marge après salaire', csv: (c) => nombreCsv(c.marge) },
    { titre: 'Part du direct (%)', csv: (c) => nombreCsv(c.part_direct) },
    { titre: 'Commission évitée', csv: (c) => nombreCsv(c.commission_evitee) }
  ];
  exporterCsv(`${nomFichier('rentabilite-chauffeurs', filtres.du, filtres.au)}.csv`, colonnes, etat.donnees.chauffeurs);
}
