// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Français et anglais (site public et espace client)
// -----------------------------------------------------------------------------
// - La langue vient, dans l'ordre : du lien (?lang=en), du profil de la
//   personne connectée, puis de la langue du navigateur. Rien n'est gardé dans
//   le navigateur : le choix voyage dans les liens du site.
// - Dans les pages : data-i18n="cle" remplace le texte, data-i18n-placeholder
//   le texte d'aide d'un champ, data-i18n-aria l'intitulé lu par les lecteurs
//   d'écran, data-i18n-title l'infobulle. Le texte n'est jamais injecté comme
//   du HTML.
// =============================================================================

const TEXTES = {
  fr: {
    // En-tête et pied de page
    'nav.accueil': 'Accueil LOC RÉACTION',
    'nav.connexion': 'Se connecter',
    'nav.deconnexion': 'Se déconnecter',
    'nav.bonjour': 'Bonjour {prenom}',
    'nav.compte': 'Mon compte',
    'langue.autre': 'English',
    'langue.autre_aria': 'Read this page in English',
    'pied.contact': 'Écrire à LOC RÉACTION',
    'pied.capital': 'au capital de {capital}',

    // Page d'accueil
    'accueil.titre': 'Votre trajet, au prix fixé avant le départ.',
    'accueil.sous_titre': 'Berline hybride avec chauffeur en Île-de-France et vers les aéroports de Roissy, Orly et Beauvais, maintenant ou à l\'avance.',
    'trajet.titre': 'Estimer et commander',
    'trajet.depart': 'Départ',
    'trajet.arrivee': 'Arrivée',
    'trajet.depart_aide': 'Adresse de départ',
    'trajet.arrivee_aide': 'Où allez-vous ?',
    'trajet.ma_position': 'Utiliser ma position',
    'trajet.position_refusee': 'Position indisponible : autorisez la localisation ou saisissez l\'adresse.',
    'trajet.inverser': 'Inverser le départ et l\'arrivée',
    'trajet.aeroports': 'Aéroports',
    'trajet.quand': 'Quand ?',
    'trajet.maintenant': 'Maintenant',
    'trajet.plus_tard': 'Plus tard',
    'trajet.date_heure': 'Date et heure de prise en charge',
    'trajet.delai_min': 'Réservation au moins {min} minutes à l\'avance.',
    'trajet.chauffeuse': 'Je souhaite être conduite par une chauffeuse',
    'adresse.aucune': 'Aucune adresse trouvée : précisez le numéro et la ville.',
    'adresse.indisponible': 'Suggestions indisponibles pour le moment : réessayez dans un instant.',
    'adresse.zone': 'Lieu desservi',
    'prix.attente': 'Indiquez le départ et l\'arrivée pour voir le prix.',
    'prix.calcul': 'Calcul du prix…',
    'prix.fixe': 'Prix fixe, TTC',
    'prix.distance': '{km} km',
    'prix.duree': 'environ {min} min',
    'prix.majoration': 'Tarif de nuit inclus (+{pct} %)',
    'prix.majoration_dimanche': 'Tarif du dimanche inclus (+{pct} %)',
    'prix.majoration_ferie': 'Tarif des jours fériés inclus (+{pct} %)',
    'prix.forfait': 'Forfait',
    'prix.hors_zone': 'Ce trajet sort de notre zone ou dépasse la distance maximale : demandez-nous un devis.',
    'prix.devis': 'Demander un devis par e-mail',
    'prix.erreur': 'Le prix n\'a pas pu être calculé. Vérifiez les adresses et réessayez.',
    'action.commander': 'Commander',
    'action.reserver': 'Réserver',
    'atouts.titre': 'Un chauffeur, un prix, pas de surprise',
    'atouts.prix': 'Prix fixe',
    'atouts.prix_texte': 'Le prix affiché avant de commander est celui que vous payez, même dans les bouchons.',
    'atouts.hybride': 'Berline hybride',
    'atouts.hybride_texte': 'Une Toyota Auris hybride, silencieuse, pour quatre passagers et leurs bagages.',
    'atouts.chauffeuse': 'Chauffeuse pour les clientes',
    'atouts.chauffeuse_texte': 'Vous préférez être conduite par une femme ? Cochez l\'option au moment de commander.',
    'atouts.aeroports': 'Aéroports et gares',
    'atouts.aeroports_texte': 'Indiquez votre numéro de vol : votre chauffeur vérifie l\'heure d\'arrivée avant de partir.',

    // Connexion
    'connexion.titre': 'Se connecter ou créer un compte',
    'connexion.intro': 'Pas de mot de passe : nous vous envoyons un code de connexion par e-mail.',
    'connexion.email': 'Adresse e-mail',
    'connexion.recevoir': 'Recevoir mon code',
    'connexion.envoi': 'Envoi…',
    'connexion.code_titre': 'Saisissez le code reçu',
    'connexion.code_envoye': 'Code envoyé à {email}. Regardez aussi dans les courriers indésirables.',
    'connexion.code': 'Code reçu par e-mail',
    'connexion.valider': 'Valider',
    'connexion.verification': 'Vérification…',
    'connexion.renvoyer': 'Renvoyer le code',
    'connexion.renvoyer_dans': 'Renvoyer le code dans {s} s',
    'connexion.code_renvoye': 'Nouveau code envoyé.',
    'connexion.changer': 'Changer d\'adresse',
    'connexion.code_invalide': 'Ce code est incorrect ou a expiré. Vérifiez-le ou demandez-en un nouveau.',
    'connexion.email_invalide': 'Saisissez une adresse e-mail valide, par exemple nom@exemple.fr.',
    'connexion.trop': 'Trop de demandes : patientez une minute avant de redemander un code.',
    'connexion.compte_bloque': 'Ce compte est suspendu. Contactez LOC RÉACTION.',
    'profil.titre': 'Complétez votre profil',
    'profil.intro': 'Votre chauffeur a besoin de votre prénom et d\'un numéro pour vous joindre.',
    'profil.prenom': 'Prénom',
    'profil.nom': 'Nom',
    'profil.telephone': 'Téléphone mobile',
    'profil.telephone_aide': 'Avec l\'indicatif, par exemple +33 6 12 34 56 78',
    'profil.telephone_invalide': 'Numéro invalide : indiquez l\'indicatif, par exemple +33 6 12 34 56 78.',
    'profil.prenom_requis': 'Indiquez votre prénom.',
    'profil.enregistrer': 'Enregistrer',
    'profil.enregistrement': 'Enregistrement…',

    // Commande
    'commande.titre': 'Votre course',
    'commande.retour': 'Retour à l\'accueil',
    'commande.ajouter_arret': 'Ajouter un arrêt',
    'commande.arret': 'Arrêt {n}',
    'commande.arret_aide': 'Adresse de l\'arrêt',
    'commande.retirer_arret': 'Retirer l\'arrêt {n}',
    'commande.precision': 'Précision pour le chauffeur',
    'commande.precision_aide': 'Porte, sortie, bâtiment… (facultatif)',
    'commande.vol': 'Numéro de vol',
    'commande.vol_aide': 'Par exemple AF1234 : votre chauffeur suit l\'heure d\'arrivée.',
    'commande.vol_invalide': 'Numéro de vol non reconnu : 2 ou 3 caractères puis 1 à 4 chiffres, par exemple AF1234.',
    'commande.terminal': 'Terminal',
    'commande.pour_qui': 'Pour qui ?',
    'commande.pour_moi': 'Pour moi',
    'commande.pour_proche': 'Pour un proche',
    'commande.proche_choisir': 'Personne transportée',
    'commande.proche_nouveau': 'Nouvelle personne',
    'commande.proche_nom': 'Nom de la personne transportée',
    'commande.proche_telephone': 'Son téléphone mobile',
    'commande.proche_enregistrer': 'Enregistrer dans mes proches',
    'commande.proche_requis': 'Indiquez le nom de la personne transportée.',
    'commande.paiement': 'Paiement',
    'commande.especes': 'Espèces',
    'commande.carte': 'Carte bancaire, au terminal du chauffeur',
    'commande.facture_mensuelle': 'Facture mensuelle ({compte})',
    'commande.code_promo': 'Code promo',
    'commande.appliquer': 'Appliquer',
    'commande.retirer_code': 'Retirer le code',
    'commande.remise': 'Remise de {montant} incluse',
    'commande.envoi': 'Commande en cours…',
    'commande.profil_incomplet': 'Ajoutez votre prénom et votre numéro de téléphone avant de commander : votre chauffeur doit pouvoir vous joindre.',
    'commande.completer_profil': 'Compléter mon profil',
    // Suivi de course
    'suivi.titre': 'Suivi de votre course',
    'suivi.statut.planifiee': 'Réservation enregistrée',
    'suivi.statut.planifiee_attribuee': 'Réservation confirmée',
    'suivi.statut.recherche': 'Recherche d\'un chauffeur',
    'suivi.statut.a_attribuer': 'Nous cherchons un chauffeur pour vous',
    'suivi.statut.acceptee': 'Votre chauffeur arrive',
    'suivi.statut.arrivee': 'Votre chauffeur est arrivé',
    'suivi.statut.en_cours': 'Bonne route',
    'suivi.statut.terminee': 'Course terminée',
    'suivi.statut.annulee': 'Course annulée',
    'suivi.texte.planifiee': 'Prise en charge le {date}. Vous êtes prévenu dès qu\'un chauffeur est attribué.',
    'suivi.texte.planifiee_attribuee': 'Prise en charge le {date} par {prenom}.',
    'suivi.texte.recherche': 'Votre demande part au chauffeur disponible le plus proche.',
    'suivi.texte.a_attribuer': 'Aucun chauffeur n\'est libre à l\'instant : notre équipe s\'occupe de votre course et vous prévient dès qu\'elle est attribuée.',
    'suivi.texte.acceptee': 'Arrivée au point de prise en charge dans environ {min} min.',
    'suivi.texte.acceptee_sans_position': 'En route vers le point de prise en charge.',
    'suivi.texte.arrivee': 'Retrouvez votre chauffeur au point de prise en charge.',
    'suivi.texte.en_cours': 'Arrivée prévue vers {heure}.',
    'suivi.texte.en_cours_sans_position': 'Vous êtes en route.',
    'suivi.texte.terminee': 'Merci d\'avoir voyagé avec LOC RÉACTION.',
    'suivi.texte.annulee': 'Cette course a été annulée.',
    'suivi.frais': 'Frais d\'annulation : {montant}',
    'suivi.plaque': 'Plaque',
    'suivi.appeler': 'Appeler {prenom}',
    'suivi.partager': 'Partager le trajet',
    'suivi.partage_texte': 'Je suis en course avec LOC RÉACTION : {depart} → {arrivee}. Chauffeur : {prenom}, {vehicule}, plaque {plaque}.',
    'suivi.partage_copie': 'Détails du trajet copiés.',
    'suivi.annuler': 'Annuler la course',
    'suivi.annuler_titre': 'Annuler cette course ?',
    'suivi.annuler_gratuit': 'L\'annulation est gratuite.',
    'suivi.annuler_frais': 'Des frais d\'annulation de {montant} s\'appliquent : votre chauffeur est déjà en route.',
    'suivi.annuler_frais_planifiee': 'Des frais d\'annulation de {montant} s\'appliquent : la prise en charge est dans moins de {heures} h.',
    'suivi.motif': 'Motif (facultatif)',
    'suivi.confirmer_annulation': 'Confirmer l\'annulation',
    'suivi.garder': 'Garder la course',
    'suivi.annulee_ok': 'Course annulée.',
    'suivi.trajet': 'Trajet',
    'suivi.prix': 'Prix fixe',
    'suivi.paiement': 'Paiement',
    'suivi.mode.especes': 'Espèces',
    'suivi.mode.carte': 'Carte bancaire, au terminal du chauffeur',
    'suivi.mode.facture_mensuelle': 'Facture mensuelle',
    'suivi.mode.solde': 'Solde',
    'suivi.attente': 'Attente facturée : {min} min, {montant}',
    'suivi.noter': 'Notez votre chauffeur',
    'suivi.note_aria': '{n} sur 5',
    'suivi.commentaire': 'Un mot pour votre chauffeur (facultatif)',
    'suivi.envoyer_note': 'Envoyer ma note',
    'suivi.note_choisir': 'Choisissez de 1 à 5 étoiles.',
    'suivi.note_merci': 'Merci pour votre note.',
    'suivi.note_donnee': 'Votre note : {n} sur 5',
    'suivi.facture': 'Facture {numero}',
    'suivi.facture_detail': '{ht} HT + TVA {taux} % ({tva}) = {ttc} TTC',
    'suivi.recommander': 'Commander à nouveau ce trajet',
    'suivi.introuvable': 'Cette course est introuvable ou ne vous concerne pas.',
    'suivi.carte': 'Carte du trajet',
    // Erreurs générales
    'erreur.reseau': 'Pas de connexion. Vérifiez votre réseau et réessayez.'
  },

  en: {
    'nav.accueil': 'LOC RÉACTION home',
    'nav.connexion': 'Sign in',
    'nav.deconnexion': 'Sign out',
    'nav.bonjour': 'Hello {prenom}',
    'nav.compte': 'My account',
    'langue.autre': 'Français',
    'langue.autre_aria': 'Lire cette page en français',
    'pied.contact': 'Email LOC RÉACTION',
    'pied.capital': 'share capital {capital}',

    'accueil.titre': 'Your ride, at a price set before you leave.',
    'accueil.sous_titre': 'Hybrid sedan with a driver across Île-de-France and to Roissy, Orly and Beauvais airports, now or in advance.',
    'trajet.titre': 'Get a price and book',
    'trajet.depart': 'Pick-up',
    'trajet.arrivee': 'Drop-off',
    'trajet.depart_aide': 'Pick-up address',
    'trajet.arrivee_aide': 'Where to?',
    'trajet.ma_position': 'Use my location',
    'trajet.position_refusee': 'Location unavailable: allow location access or type the address.',
    'trajet.inverser': 'Swap pick-up and drop-off',
    'trajet.aeroports': 'Airports',
    'trajet.quand': 'When?',
    'trajet.maintenant': 'Now',
    'trajet.plus_tard': 'Later',
    'trajet.date_heure': 'Pick-up date and time',
    'trajet.delai_min': 'Book at least {min} minutes ahead.',
    'trajet.chauffeuse': 'I would like a female driver',
    'adresse.aucune': 'No address found: add the street number and town.',
    'adresse.indisponible': 'Suggestions are unavailable right now: try again in a moment.',
    'adresse.zone': 'Served location',
    'prix.attente': 'Enter pick-up and drop-off to see the price.',
    'prix.calcul': 'Calculating the price…',
    'prix.fixe': 'Fixed price, VAT included',
    'prix.distance': '{km} km',
    'prix.duree': 'about {min} min',
    'prix.majoration': 'Night rate included (+{pct}%)',
    'prix.majoration_dimanche': 'Sunday rate included (+{pct}%)',
    'prix.majoration_ferie': 'Bank holiday rate included (+{pct}%)',
    'prix.forfait': 'Flat rate',
    'prix.hors_zone': 'This trip is outside our area or over the maximum distance: ask us for a quote.',
    'prix.devis': 'Request a quote by email',
    'prix.erreur': 'The price could not be calculated. Check the addresses and try again.',
    'action.commander': 'Book now',
    'action.reserver': 'Book',
    'atouts.titre': 'One driver, one price, no surprises',
    'atouts.prix': 'Fixed price',
    'atouts.prix_texte': 'The price shown before you book is the price you pay, even in traffic.',
    'atouts.hybride': 'Hybrid sedan',
    'atouts.hybride_texte': 'A quiet Toyota Auris hybrid for four passengers and their luggage.',
    'atouts.chauffeuse': 'Female drivers for women',
    'atouts.chauffeuse_texte': 'Prefer to be driven by a woman? Tick the option when you book.',
    'atouts.aeroports': 'Airports and stations',
    'atouts.aeroports_texte': 'Add your flight number: your driver checks the arrival time before setting off.',

    'connexion.titre': 'Sign in or create an account',
    'connexion.intro': 'No password: we email you a sign-in code.',
    'connexion.email': 'Email address',
    'connexion.recevoir': 'Get my code',
    'connexion.envoi': 'Sending…',
    'connexion.code_titre': 'Enter the code you received',
    'connexion.code_envoye': 'Code sent to {email}. Check your spam folder too.',
    'connexion.code': 'Code from the email',
    'connexion.valider': 'Confirm',
    'connexion.verification': 'Checking…',
    'connexion.renvoyer': 'Resend the code',
    'connexion.renvoyer_dans': 'Resend the code in {s}s',
    'connexion.code_renvoye': 'New code sent.',
    'connexion.changer': 'Use another email',
    'connexion.code_invalide': 'This code is wrong or has expired. Check it or request a new one.',
    'connexion.email_invalide': 'Enter a valid email address, for example name@example.com.',
    'connexion.trop': 'Too many requests: wait a minute before requesting a new code.',
    'connexion.compte_bloque': 'This account is suspended. Contact LOC RÉACTION.',
    'profil.titre': 'Complete your profile',
    'profil.intro': 'Your driver needs your first name and a number to reach you.',
    'profil.prenom': 'First name',
    'profil.nom': 'Last name',
    'profil.telephone': 'Mobile phone',
    'profil.telephone_aide': 'With the country code, for example +33 6 12 34 56 78',
    'profil.telephone_invalide': 'Invalid number: include the country code, for example +33 6 12 34 56 78.',
    'profil.prenom_requis': 'Enter your first name.',
    'profil.enregistrer': 'Save',
    'profil.enregistrement': 'Saving…',

    'commande.titre': 'Your ride',
    'commande.retour': 'Back to home',
    'commande.ajouter_arret': 'Add a stop',
    'commande.arret': 'Stop {n}',
    'commande.arret_aide': 'Stop address',
    'commande.retirer_arret': 'Remove stop {n}',
    'commande.precision': 'Note for your driver',
    'commande.precision_aide': 'Door, exit, building… (optional)',
    'commande.vol': 'Flight number',
    'commande.vol_aide': 'For example AF1234: your driver follows the arrival time.',
    'commande.vol_invalide': 'Flight number not recognised: 2 or 3 characters then 1 to 4 digits, for example AF1234.',
    'commande.terminal': 'Terminal',
    'commande.pour_qui': 'Who is riding?',
    'commande.pour_moi': 'Me',
    'commande.pour_proche': 'Someone else',
    'commande.proche_choisir': 'Passenger',
    'commande.proche_nouveau': 'New person',
    'commande.proche_nom': 'Passenger name',
    'commande.proche_telephone': 'Their mobile phone',
    'commande.proche_enregistrer': 'Save to my contacts',
    'commande.proche_requis': 'Enter the passenger\'s name.',
    'commande.paiement': 'Payment',
    'commande.especes': 'Cash',
    'commande.carte': 'Card, on the driver\'s terminal',
    'commande.facture_mensuelle': 'Monthly invoice ({compte})',
    'commande.code_promo': 'Promo code',
    'commande.appliquer': 'Apply',
    'commande.retirer_code': 'Remove the code',
    'commande.remise': 'Discount of {montant} included',
    'commande.envoi': 'Booking…',
    'commande.profil_incomplet': 'Add your first name and phone number before booking: your driver needs to be able to reach you.',
    'commande.completer_profil': 'Complete my profile',
    'suivi.titre': 'Track your ride',
    'suivi.statut.planifiee': 'Booking received',
    'suivi.statut.planifiee_attribuee': 'Booking confirmed',
    'suivi.statut.recherche': 'Finding a driver',
    'suivi.statut.a_attribuer': 'We are finding a driver for you',
    'suivi.statut.acceptee': 'Your driver is on the way',
    'suivi.statut.arrivee': 'Your driver has arrived',
    'suivi.statut.en_cours': 'Enjoy your ride',
    'suivi.statut.terminee': 'Ride completed',
    'suivi.statut.annulee': 'Ride cancelled',
    'suivi.texte.planifiee': 'Pick-up on {date}. We will let you know as soon as a driver is assigned.',
    'suivi.texte.planifiee_attribuee': 'Pick-up on {date} by {prenom}.',
    'suivi.texte.recherche': 'Your request goes to the nearest available driver.',
    'suivi.texte.a_attribuer': 'No driver is free right now: our team is handling your ride and will let you know as soon as it is assigned.',
    'suivi.texte.acceptee': 'Arriving at the pick-up point in about {min} min.',
    'suivi.texte.acceptee_sans_position': 'On the way to the pick-up point.',
    'suivi.texte.arrivee': 'Meet your driver at the pick-up point.',
    'suivi.texte.en_cours': 'Expected arrival around {heure}.',
    'suivi.texte.en_cours_sans_position': 'You are on your way.',
    'suivi.texte.terminee': 'Thank you for riding with LOC RÉACTION.',
    'suivi.texte.annulee': 'This ride was cancelled.',
    'suivi.frais': 'Cancellation fee: {montant}',
    'suivi.plaque': 'Plate',
    'suivi.appeler': 'Call {prenom}',
    'suivi.partager': 'Share my trip',
    'suivi.partage_texte': 'I am riding with LOC RÉACTION: {depart} → {arrivee}. Driver: {prenom}, {vehicule}, plate {plaque}.',
    'suivi.partage_copie': 'Trip details copied.',
    'suivi.annuler': 'Cancel the ride',
    'suivi.annuler_titre': 'Cancel this ride?',
    'suivi.annuler_gratuit': 'Cancellation is free.',
    'suivi.annuler_frais': 'A cancellation fee of {montant} applies: your driver is already on the way.',
    'suivi.annuler_frais_planifiee': 'A cancellation fee of {montant} applies: pick-up is less than {heures} h away.',
    'suivi.motif': 'Reason (optional)',
    'suivi.confirmer_annulation': 'Confirm cancellation',
    'suivi.garder': 'Keep the ride',
    'suivi.annulee_ok': 'Ride cancelled.',
    'suivi.trajet': 'Trip',
    'suivi.prix': 'Fixed price',
    'suivi.paiement': 'Payment',
    'suivi.mode.especes': 'Cash',
    'suivi.mode.carte': 'Card, on the driver\'s terminal',
    'suivi.mode.facture_mensuelle': 'Monthly invoice',
    'suivi.mode.solde': 'Balance',
    'suivi.attente': 'Waiting time charged: {min} min, {montant}',
    'suivi.noter': 'Rate your driver',
    'suivi.note_aria': '{n} out of 5',
    'suivi.commentaire': 'A word for your driver (optional)',
    'suivi.envoyer_note': 'Send my rating',
    'suivi.note_choisir': 'Choose from 1 to 5 stars.',
    'suivi.note_merci': 'Thank you for your rating.',
    'suivi.note_donnee': 'Your rating: {n} out of 5',
    'suivi.facture': 'Invoice {numero}',
    'suivi.facture_detail': '{ht} excl. VAT + VAT {taux}% ({tva}) = {ttc} incl. VAT',
    'suivi.recommander': 'Book this trip again',
    'suivi.introuvable': 'This ride cannot be found or is not yours.',
    'suivi.carte': 'Trip map',
    'erreur.reseau': 'No connection. Check your network and try again.'
  }
};

let langue = choisirLangue();

// Langue de départ : lien, puis navigateur (le profil l'affine après connexion)
function choisirLangue() {
  const demandee = new URLSearchParams(location.search).get('lang');
  if (demandee === 'en' || demandee === 'fr') return demandee;
  return (navigator.language || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr';
}

export function langueActive() {
  return langue;
}

// Espaces en français seulement (chauffeur, administration) : la langue est imposée
export function imposerLangue(langueImposee) {
  langue = langueImposee;
  document.documentElement.lang = langue;
}

// Langue du profil (après connexion), sauf si le lien en impose une autre
export function adopterLangueProfil(langueProfil) {
  if (new URLSearchParams(location.search).get('lang')) return;
  if (langueProfil === 'fr' || langueProfil === 'en') {
    langue = langueProfil;
    appliquerTraductions();
  }
}

// Texte traduit, avec remplacement des {variables}
export function t(cle, variables = {}) {
  const modele = (TEXTES[langue] && TEXTES[langue][cle]) ?? TEXTES.fr[cle] ?? cle;
  return modele.replace(/\{(\w+)\}/g, (_, nom) => (variables[nom] ?? ''));
}

// Lien interne qui garde la langue choisie
export function lienAvecLangue(url) {
  const cible = new URL(url, location.href);
  if (cible.origin !== location.origin) return url;
  if (langue === 'en') cible.searchParams.set('lang', 'en'); else cible.searchParams.delete('lang');
  return cible.pathname + cible.search + cible.hash;
}

// Applique les traductions à la page (ou à une partie de la page)
export function appliquerTraductions(racine = document) {
  document.documentElement.lang = langue;
  racine.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  racine.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  racine.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  racine.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  // Liens internes : la langue suit
  racine.querySelectorAll('a[data-interne]').forEach((a) => { a.href = lienAvecLangue(a.dataset.interne); });
  // Lien de changement de langue : même page, autre langue
  racine.querySelectorAll('[data-changer-langue]').forEach((a) => {
    const cible = new URL(location.href);
    cible.searchParams.set('lang', langue === 'en' ? 'fr' : 'en');
    a.href = cible.pathname + cible.search + cible.hash;
    a.hreflang = langue === 'en' ? 'fr' : 'en';
  });
}
