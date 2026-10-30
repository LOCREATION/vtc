// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Position du chauffeur, envoyée à la base tant qu'il est en ligne ou en course
// -----------------------------------------------------------------------------
// - Envoi dès qu'il a bougé de 25 m ou toutes les 20 s en mouvement ; un
//   « battement » toutes les 45 s même à l'arrêt : la base ne propose des
//   courses qu'aux chauffeurs dont la position a moins de 3 minutes.
// - Écran maintenu allumé (verrou d'écran) : sur téléphone, un navigateur mis
//   en veille cesse d'envoyer la position et de sonner. C'était la cause des
//   demandes perdues de la version 1.
// - Seules la latitude, la longitude, le cap et la vitesse sont envoyés ;
//   l'heure de mise à jour est posée par la base.
// =============================================================================
import { supabase } from './supabase.js';
import { distanceKm } from './outils.js';

const DISTANCE_MIN_M = 25;
const INTERVALLE_MOUVEMENT_MS = 20000;
const BATTEMENT_MS = 45000;

export class SuiviGps {
  constructor({ chauffeurId, onPosition = () => {}, onErreur = () => {} }) {
    this.chauffeurId = chauffeurId;
    this.onPosition = onPosition;
    this.onErreur = onErreur;
    this.surveillance = null;
    this.battement = null;
    this.verrou = null;
    this.derniere = null;          // dernière position connue
    this.dernierEnvoi = null;      // { lat, lng, instant }
    this.actif = false;
    this.auRetour = () => { if (document.visibilityState === 'visible' && this.actif) this.verrouillerEcran(); };
  }

  demarrer() {
    if (this.actif || !navigator.geolocation) return;
    this.actif = true;
    this.surveillance = navigator.geolocation.watchPosition(
      (position) => this.recevoir(position),
      (erreur) => this.onErreur(erreur),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    this.battement = setInterval(() => { if (this.derniere) this.envoyer(this.derniere, true); }, BATTEMENT_MS);
    this.verrouillerEcran();
    document.addEventListener('visibilitychange', this.auRetour);
  }

  arreter() {
    this.actif = false;
    if (this.surveillance !== null) navigator.geolocation.clearWatch(this.surveillance);
    clearInterval(this.battement);
    this.surveillance = null;
    document.removeEventListener('visibilitychange', this.auRetour);
    if (this.verrou) { this.verrou.release().catch(() => {}); this.verrou = null; }
  }

  async verrouillerEcran() {
    try {
      if ('wakeLock' in navigator && !this.verrou) {
        this.verrou = await navigator.wakeLock.request('screen');
        this.verrou.addEventListener('release', () => { this.verrou = null; });
      }
    } catch {
      // Verrou refusé (économie d'énergie) : l'application fonctionne, écran à garder allumé
    }
  }

  recevoir(position) {
    const { latitude, longitude, heading, speed } = position.coords;
    this.derniere = {
      lat: latitude,
      lng: longitude,
      cap: Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null,
      vitesse: Number.isFinite(speed) && speed >= 0 ? Math.round(speed * 3.6 * 10) / 10 : null
    };
    this.onPosition(this.derniere);
    const precedent = this.dernierEnvoi;
    const deplacementM = precedent ? distanceKm(precedent.lat, precedent.lng, latitude, longitude) * 1000 : Infinity;
    const ecoule = precedent ? Date.now() - precedent.instant : Infinity;
    if (deplacementM >= DISTANCE_MIN_M || ecoule >= INTERVALLE_MOUVEMENT_MS) this.envoyer(this.derniere);
  }

  async envoyer(p, battement = false) {
    // À l'arrêt, inutile d'envoyer plus souvent que le battement
    if (battement && this.dernierEnvoi && Date.now() - this.dernierEnvoi.instant < BATTEMENT_MS - 1000) return;
    this.dernierEnvoi = { lat: p.lat, lng: p.lng, instant: Date.now() };
    const { error } = await supabase.from('positions')
      .update({ latitude: round6(p.lat), longitude: round6(p.lng), cap: p.cap, vitesse_kmh: p.vitesse })
      .eq('chauffeur_id', this.chauffeurId);
    if (error) this.onErreur(error);
  }
}

function round6(valeur) {
  return Math.round(valeur * 1e6) / 1e6;
}
