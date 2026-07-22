// ============================================================
// LOC RÉACTION S.A.S — shared/cities-data.js
// Villes réelles (France, principalement Nord + Île-de-France)
// avec coordonnées, pour la sélection de destination par proximité.
// Rayon d'usage prévu : 300 km autour de la position du client.
// ============================================================

export const FRENCH_CITIES = [
  { name: "Paris", lat: 48.8566, lng: 2.3522 },
  { name: "Cergy", lat: 49.0367, lng: 2.0783 },
  { name: "Pontoise", lat: 49.0508, lng: 2.1017 },
  { name: "Argenteuil", lat: 48.9479, lng: 2.2469 },
  { name: "Saint-Denis", lat: 48.9362, lng: 2.3574 },
  { name: "Versailles", lat: 48.8049, lng: 2.1204 },
  { name: "Melun", lat: 48.5387, lng: 2.6597 },
  { name: "Meaux", lat: 48.9602, lng: 2.8886 },
  { name: "Senlis", lat: 49.2072, lng: 2.5814 },
  { name: "Creil", lat: 49.2593, lng: 2.4839 },
  { name: "Chantilly", lat: 49.1937, lng: 2.4694 },
  { name: "Fontainebleau", lat: 48.4084, lng: 2.7016 },
  { name: "Provins", lat: 48.5556, lng: 3.2986 },
  { name: "Mantes-la-Jolie", lat: 48.9910, lng: 1.7167 },
  { name: "Chartres", lat: 48.4439, lng: 1.4894 },
  { name: "Orléans", lat: 47.9029, lng: 1.9093 },
  { name: "Évreux", lat: 49.0270, lng: 1.1510 },
  { name: "Vernon", lat: 49.0920, lng: 1.4836 },
  { name: "Rouen", lat: 49.4431, lng: 1.0993 },
  { name: "Le Havre", lat: 49.4944, lng: 0.1079 },
  { name: "Dieppe", lat: 49.9219, lng: 1.0791 },
  { name: "Caen", lat: 49.1829, lng: -0.3707 },
  { name: "Beauvais", lat: 49.4295, lng: 2.0807 },
  { name: "Compiègne", lat: 49.4180, lng: 2.8260 },
  { name: "Amiens", lat: 49.8942, lng: 2.2957 },
  { name: "Abbeville", lat: 50.1058, lng: 1.8347 },
  { name: "Saint-Quentin", lat: 49.8489, lng: 3.2870 },
  { name: "Laon", lat: 49.5642, lng: 3.6208 },
  { name: "Soissons", lat: 49.3808, lng: 3.3238 },
  { name: "Château-Thierry", lat: 49.0378, lng: 3.4008 },
  { name: "Reims", lat: 49.2583, lng: 4.0317 },
  { name: "Troyes", lat: 48.2973, lng: 4.0744 },
  { name: "Charleville-Mézières", lat: 49.7723, lng: 4.7196 },
  { name: "Arras", lat: 50.2910, lng: 2.7770 },
  { name: "Lille", lat: 50.6292, lng: 3.0573 },
  { name: "Cambrai", lat: 50.1667, lng: 3.2333 },
  { name: "Calais", lat: 50.9513, lng: 1.8587 },
  { name: "Boulogne-sur-Mer", lat: 50.7264, lng: 1.6147 },
  { name: "Dunkerque", lat: 51.0344, lng: 2.3768 },
]

// Formule de Haversine — distance réelle en km entre deux points GPS
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371 // rayon de la Terre en km
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Retourne les N villes les plus proches d'une position, dans un rayon maximal donné
export function getNearestCities(userLat, userLng, maxRadiusKm = 300, limit = 10) {
  return FRENCH_CITIES
    .map(city => ({ ...city, distance: haversineDistance(userLat, userLng, city.lat, city.lng) }))
    .filter(city => city.distance <= maxRadiusKm)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
}
