# Banc d'essai des pages v2 (navigateur)

Joue les pages du site v2 dans Chromium, sans réseau extérieur :

- la bibliothèque Supabase et la carte (Leaflet) sont servies depuis `node_modules` ;
- les lectures, les fonctions et les écritures de la base sont exécutées sur la
  copie locale `loc_v2` (créée par `../lancer_tests_locaux.sh`), avec le rôle
  « authenticated » et l'identité du compte de test : les règles d'accès
  s'appliquent comme en ligne ;
- le service d'adresses, l'authentification (code, mot de passe, double
  authentification), le dépôt de fichiers et les fonds de carte sont simulés
  au même format que les vrais services.

Préparation (une fois) puis lancement, dans cet ordre (chaque fichier part
de l'état laissé par le précédent) :

```
npm install && npm run preparer
bash ../lancer_tests_locaux.sh     # base locale neuve + 503 vérifications
python3 test_pages.py              # accueil et connexion (25 vérifications)
python3 test_client.py             # commande et suivi (18 vérifications)
python3 test_chauffeur.py          # espace chauffeur (20 vérifications)
python3 test_admin.py              # administration (195 vérifications)
```

`test_admin.py` accepte le nom d'une étape pour n'en jouer qu'une partie :
`porte`, `tableau`, `dispatch`, `courses`, `clients`, `entreprises`, `finances`,
`chauffeurs`, `flotte`, `tarifs`, `parametres` (ex. `python3 test_admin.py porte dispatch`).

Administration : le service de connexion de Supabase est imité
(`AuthSimulee` dans `banc.py`) — mot de passe, double authentification par
application (code `123456`), niveaux « aal1 » et « aal2 » du jeton. La base
locale refuse toute action d'administration sans « aal2 », comme en ligne.

Les captures d'écran sont enregistrées dans `captures/`.
