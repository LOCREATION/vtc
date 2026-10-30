// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Champ d'adresse avec suggestions
// -----------------------------------------------------------------------------
// Deux sources, dans cet ordre :
//   1. les lieux desservis de la base (aéroports, gares) : coordonnées exactes,
//      trouvés aussi par leurs noms usuels (« Roissy », « CDG »…) ;
//   2. le service d'adresses de l'État (Géoplateforme de l'IGN), interrogé
//      quand on s'arrête de taper, au plus près du point de recherche.
// Accessible au clavier (flèches, Entrée, Échap) et aux lecteurs d'écran
// (modèle « combobox »).
// =============================================================================
import { GEOCODAGE_URL, CENTRE_PAR_DEFAUT } from './config.js';
import { t } from './i18n.js';
import { el, apresPause, sansAccents } from './outils.js';

// Noms usuels des lieux desservis, en plus de leur nom officiel
const NOMS_USUELS = {
  aeroport_cdg: 'roissy cdg charles de gaulle terminal 1 2 3',
  aeroport_orly: 'orly terminal 1 2 3 4',
  aeroport_beauvais: 'beauvais tille',
  aeroport_le_bourget: 'le bourget',
  gare_marne_la_vallee: 'disneyland chessy marne la vallee tgv',
  gare_massy_tgv: 'massy tgv'
};

let compteurChamps = 0;

export class ChampAdresse {
  /**
   * @param {object} options
   * @param {HTMLInputElement} options.champ  champ de saisie
   * @param {Array} options.zones             lieux desservis (table « zones »)
   * @param {Function} options.onChoix        appelée avec { adresse, lat, lng } ou null
   * @param {Function} options.centre         renvoie le point près duquel chercher
   */
  constructor({ champ, zones = [], onChoix = () => {}, centre = () => CENTRE_PAR_DEFAUT }) {
    this.champ = champ;
    this.zones = zones;
    this.onChoix = onChoix;
    this.centre = centre;
    this.valeur = null;
    this.options = [];
    this.indexActif = -1;
    this.requete = null;

    // Liste des suggestions, placée juste après le champ
    compteurChamps += 1;
    this.liste = el('ul', { classe: 'suggestions', id: `suggestions-${compteurChamps}`, role: 'listbox', hidden: true });
    this.champ.after(this.liste);
    this.champ.setAttribute('role', 'combobox');
    this.champ.setAttribute('aria-autocomplete', 'list');
    this.champ.setAttribute('aria-expanded', 'false');
    this.champ.setAttribute('aria-controls', this.liste.id);
    this.champ.setAttribute('autocomplete', 'off');

    const rechercher = apresPause(() => this.rechercher(), 250);
    this.champ.addEventListener('input', () => {
      // Le texte a changé : l'adresse choisie n'est plus valable
      if (this.valeur) { this.valeur = null; this.onChoix(null); }
      rechercher();
    });
    this.champ.addEventListener('keydown', (e) => this.clavier(e));
    this.champ.addEventListener('blur', () => setTimeout(() => this.fermer(), 150));
    this.champ.addEventListener('focus', () => { if (this.champ.value.trim().length >= 2 && !this.valeur) this.rechercher(); });
  }

  // Adresse choisie de l'extérieur (raccourci aéroport, position, inversion)
  definir(valeur) {
    this.valeur = valeur;
    this.champ.value = valeur ? valeur.adresse : '';
    this.fermer();
    this.onChoix(valeur);
  }

  async rechercher() {
    const saisie = this.champ.value.trim();
    if (saisie.length < 2) { this.fermer(); return; }

    // 1. Lieux desservis qui correspondent
    const cle = sansAccents(saisie);
    const lieux = this.zones
      .filter((z) => sansAccents(`${z.nom} ${NOMS_USUELS[z.code] || ''}`).includes(cle))
      .slice(0, 3)
      .map((z) => ({ adresse: z.nom, lat: Number(z.latitude), lng: Number(z.longitude), zone: true }));
    this.afficher(lieux);
    if (saisie.length < 3) return;

    // 2. Adresses du service de l'État (la requête précédente est abandonnée)
    if (this.requete) this.requete.abort();
    this.requete = new AbortController();
    const { lat, lng } = this.centre();
    const url = `${GEOCODAGE_URL}/search?q=${encodeURIComponent(saisie)}&index=address&autocomplete=1&limit=5`
      + `&lat=${lat}&lon=${lng}`;
    try {
      const reponse = await fetch(url, { signal: this.requete.signal });
      if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
      const donnees = await reponse.json();
      const adresses = (donnees.features || []).map((f) => ({
        adresse: f.properties.label,
        detail: f.properties.context || '',
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0]
      }));
      this.afficher([...lieux, ...adresses], adresses.length || lieux.length ? null : t('adresse.aucune'));
    } catch (erreur) {
      if (erreur.name === 'AbortError') return;
      this.afficher(lieux, lieux.length ? null : t('adresse.indisponible'));
    }
  }

  afficher(options, messageVide = null) {
    this.options = options;
    this.indexActif = -1;
    this.liste.replaceChildren();
    options.forEach((option, i) => {
      const item = el('li', {
        id: `${this.liste.id}-${i}`, role: 'option', classe: 'suggestion', 'aria-selected': 'false',
        // « mousedown » plutôt que « click » : le champ garde le focus
        onmousedown: (e) => { e.preventDefault(); this.choisir(i); }
      },
      el('span', { classe: 'suggestion-libelle', texte: option.adresse }),
      option.zone ? el('span', { classe: 'suggestion-etiquette', texte: t('adresse.zone') })
                  : (option.detail ? el('span', { classe: 'suggestion-detail', texte: option.detail }) : null));
      this.liste.append(item);
    });
    if (!options.length && messageVide) {
      this.liste.append(el('li', { classe: 'suggestion suggestion-vide', role: 'option', 'aria-disabled': 'true', texte: messageVide }));
    }
    const ouvert = this.liste.children.length > 0;
    this.liste.hidden = !ouvert;
    this.champ.setAttribute('aria-expanded', String(ouvert));
    this.champ.removeAttribute('aria-activedescendant');
  }

  choisir(index) {
    const option = this.options[index];
    if (!option) return;
    this.definir({ adresse: option.adresse, lat: option.lat, lng: option.lng });
  }

  fermer() {
    this.liste.hidden = true;
    this.champ.setAttribute('aria-expanded', 'false');
    this.champ.removeAttribute('aria-activedescendant');
  }

  clavier(e) {
    if (this.liste.hidden || !this.options.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const pas = e.key === 'ArrowDown' ? 1 : -1;
      this.indexActif = (this.indexActif + pas + this.options.length) % this.options.length;
      [...this.liste.children].forEach((item, i) => item.setAttribute('aria-selected', String(i === this.indexActif)));
      this.champ.setAttribute('aria-activedescendant', `${this.liste.id}-${this.indexActif}`);
    } else if (e.key === 'Enter' && this.indexActif >= 0) {
      e.preventDefault();
      this.choisir(this.indexActif);
    } else if (e.key === 'Escape') {
      this.fermer();
    }
  }
}

// Adresse la plus proche d'une position GPS (bouton « Utiliser ma position »)
export async function adresseDepuisPosition(lat, lng) {
  try {
    const reponse = await fetch(`${GEOCODAGE_URL}/reverse?lat=${lat}&lon=${lng}&index=address&limit=1`);
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
    const donnees = await reponse.json();
    const premiere = (donnees.features || [])[0];
    if (premiere) return premiere.properties.label;
  } catch (erreur) {
    // Pas d'adresse trouvée : on garde la position, avec ses coordonnées
  }
  return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}
