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
    'connexion.intro': 'Pas de mot de passe : nous vous envoyons un code à 6 chiffres par e-mail.',
    'connexion.email': 'Adresse e-mail',
    'connexion.recevoir': 'Recevoir mon code',
    'connexion.envoi': 'Envoi…',
    'connexion.code_titre': 'Saisissez le code reçu',
    'connexion.code_envoye': 'Code envoyé à {email}. Regardez aussi dans les courriers indésirables.',
    'connexion.code': 'Code à 6 chiffres',
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
    'connexion.intro': 'No password: we email you a 6-digit code.',
    'connexion.email': 'Email address',
    'connexion.recevoir': 'Get my code',
    'connexion.envoi': 'Sending…',
    'connexion.code_titre': 'Enter the code you received',
    'connexion.code_envoye': 'Code sent to {email}. Check your spam folder too.',
    'connexion.code': '6-digit code',
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
