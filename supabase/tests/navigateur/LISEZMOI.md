# Banc d'essai des pages v2 (navigateur)

Joue les pages du site v2 dans Chromium, sans réseau extérieur :

- la bibliothèque Supabase et la carte (Leaflet) sont servies depuis `node_modules` ;
- les lectures, les fonctions et les écritures de la base sont exécutées sur la
  copie locale `loc_v2` (créée par `../lancer_tests_locaux.sh`), avec le rôle
  « authenticated » et l'identité du compte de test : les règles d'accès
  s'appliquent comme en ligne ;
- le service d'adresses, l'authentification (code, mot de passe, double
  authentification), le dépôt de fichiers, les fonds de carte, la fonction du
  serveur « mollie » et la page de paiement de Mollie sont simulés au même
  format que les vrais services (l'essai choisit la réponse de Mollie :
  payé, annulé…).

Préparation (une fois) puis lancement, dans cet ordre (chaque fichier part
de l'état laissé par le précédent) :

```
npm install && npm run preparer
bash ../lancer_tests_locaux.sh     # base locale neuve + 1197 vérifications
python3 test_pages.py              # accueil, connexion, invitation de parrainage, les trois entrées, devenir chauffeur (44 vérifications)
python3 test_client.py             # commande, suivi et messages avec le chauffeur (31 vérifications)
python3 test_espace_client.py      # espace client : accueil, activité, compte (proches, portefeuille, parrainage, compte pro, sécurité, notifications, données personnelles), cloche, support, pourboire, recharge par Mollie, courses payées par le portefeuille ou par virement (148 vérifications)
python3 test_chauffeur.py          # espace chauffeur, gains du jour, messages, pourboire, course payée par le portefeuille, notifications, support, nouveau chauffeur (140 vérifications)
python3 test_admin.py              # administration, dont les comptes clients supprimés, les boutons « Supprimer », les paiements et portefeuilles (338 vérifications)
```

`test_admin.py` accepte le nom d'une étape pour n'en jouer qu'une partie :
`porte`, `tableau`, `dispatch`, `courses`, `clients`, `entreprises`, `finances`,
`portefeuilles`, `plateformes`, `rh`, `support`, `marketing`, `chauffeurs`,
`flotte`, `tarifs`, `parametres`, `suppressions`
(ex. `python3 test_admin.py porte dispatch`).

Administration : le service de connexion de Supabase est imité
(`AuthSimulee` dans `banc.py`) — mot de passe, double authentification par
application (code `123456`), niveaux « aal1 » et « aal2 » du jeton. La base
locale refuse toute action d'administration sans « aal2 », comme en ligne.

Messages entre le client et le chauffeur : le temps réel de Supabase n'est
pas joignable ici, la page les reçoit par sa relecture de secours (toutes les
10 secondes) ; ces essais attendent donc jusqu'à 15 secondes à trois reprises.

Fonction du serveur « mollie » (`supabase/functions/mollie/`) : essayée
hors ligne avec Deno, la base et Mollie simulées (11 essais) :
`deno test --allow-env ../fonctions/mollie_test.ts`.

Les captures d'écran sont enregistrées dans `captures/`.
