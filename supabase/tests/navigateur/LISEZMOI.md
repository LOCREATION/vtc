# Banc d'essai des pages v2 (navigateur)

Joue les pages du site v2 dans Chromium, sans réseau extérieur :

- la bibliothèque Supabase et la carte (Leaflet) sont servies depuis `node_modules` ;
- les lectures, les fonctions et les écritures de la base sont exécutées sur la
  copie locale `loc_v2` (créée par `../lancer_tests_locaux.sh`), avec le rôle
  « authenticated » et l'identité du compte de test : les règles d'accès
  s'appliquent comme en ligne ;
- le service d'adresses, l'authentification par code et les fonds de carte
  sont simulés au même format que les vrais services.

Préparation (une fois) puis lancement :

```
npm install && npm run preparer
bash ../lancer_tests_locaux.sh     # base locale neuve + 174 vérifications
python3 test_pages.py              # accueil et connexion (24 vérifications)
python3 test_client.py             # commande et suivi (18 vérifications)
```

Les captures d'écran sont enregistrées dans `captures/`.
