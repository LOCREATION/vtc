// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Fonction du serveur « mollie » (Supabase Edge Function) : point d'entrée.
// Tout le traitement est dans traitement.ts (essayé hors ligne par
// supabase/tests/fonctions/mollie_test.ts).
// Déploiement : vérification du jeton par la plateforme désactivée
// (verify_jwt = false) : l'avis de Mollie arrive sans jeton, et la recharge
// passe le jeton du client à la base, qui le vérifie elle-même.
// Secret à saisir dans Supabase (Edge Functions > Secrets) : MOLLIE_API_KEY.
// =============================================================================
import { traiter } from './traitement.ts';

Deno.serve((req: Request) => traiter(req, Deno.env));
