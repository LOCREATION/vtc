// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : lecture de l'historique des courses
// -----------------------------------------------------------------------------
// Courses terminées et/ou annulées du chauffeur connecté dont la fin (ou
// l'annulation) tombe entre deux jours de Paris, de la plus récente à la plus
// ancienne. Une lecture par statut, sur une journée de marge de chaque côté
// (heure de Paris ≠ heure universelle), puis tri selon le jour à Paris.
// Les règles d'accès de la base ne laissent lire que ses propres courses.
// Utilisé par les onglets Revenus et Courses, et par le relevé (PDF).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { jourParis, ajouterJours } from './periodes.js';

// Instant de fin d'une course de l'historique : arrivée ou annulation
export function instantFin(course) {
  return course.statut === 'terminee' ? course.terminee_le : course.annulee_le;
}

// colonnes : doivent comprendre « statut, terminee_le, annulee_le »
export async function lireHistorique({ chauffeur, du, au, statuts = ['terminee', 'annulee'], colonnes, limite = 2000 }) {
  const debut = `${ajouterJours(du, -1)}T00:00:00Z`;
  const fin = `${ajouterJours(au, 2)}T00:00:00Z`;
  const reponses = await Promise.all(statuts.map((statut) => {
    const champ = statut === 'terminee' ? 'terminee_le' : 'annulee_le';
    return supabase.from('courses').select(colonnes)
      .eq('chauffeur_id', chauffeur).eq('statut', statut)
      .gte(champ, debut).lt(champ, fin)
      .order(champ, { ascending: false }).limit(limite);
  }));
  for (const reponse of reponses) if (reponse.error) throw reponse.error;
  return reponses.flatMap((reponse) => reponse.data || [])
    .filter((c) => { const jour = jourParis(instantFin(c)); return jour >= du && jour <= au; })
    .sort((a, b) => new Date(instantFin(b)) - new Date(instantFin(a)));
}
