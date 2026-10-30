// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : archive ZIP préparée dans la page
// -----------------------------------------------------------------------------
// Rassemble plusieurs fichiers (CSV, texte) en une seule archive ZIP, sans
// bibliothèque externe et sans rien envoyer à un serveur : le dossier pour
// l'expert-comptable se télécharge d'un clic.
// Format ZIP standard (APPNOTE de PKWARE), fichiers « stockés » sans
// compression (les CSV restent petits), noms en UTF-8 (accents compris),
// contrôle CRC-32 de chaque fichier : l'archive s'ouvre avec l'explorateur
// de Windows, le Finder du Mac et tout logiciel d'archives.
// =============================================================================

// Table du CRC-32 (polynôme 0xEDB88320), calculée une fois
const TABLE_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(octets) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < octets.length; i++) c = TABLE_CRC[(c ^ octets[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Date et heure au format MS-DOS (heure locale de l'appareil, comme le fait
// tout logiciel d'archives)
function dateDos(d) {
  return {
    heure: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    jour: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// fichiers : [{ nom: 'dossier/fichier.csv', contenu: texte ou Uint8Array }]
// Renvoie un Blob « application/zip ».
export function creerZip(fichiers) {
  const encodeur = new TextEncoder();
  const { heure, jour } = dateDos(new Date());
  const locaux = [];
  const central = [];
  let decalage = 0;

  for (const f of fichiers) {
    const nom = encodeur.encode(f.nom);
    const donnees = typeof f.contenu === 'string' ? encodeur.encode(f.contenu) : f.contenu;
    const crc = crc32(donnees);

    // En-tête local
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);       // signature
    local.setUint16(4, 20, true);               // version nécessaire (2.0)
    local.setUint16(6, 0x0800, true);           // noms en UTF-8
    local.setUint16(8, 0, true);                // stocké, sans compression
    local.setUint16(10, heure, true);
    local.setUint16(12, jour, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, donnees.length, true);  // taille compressée
    local.setUint32(22, donnees.length, true);  // taille réelle
    local.setUint16(26, nom.length, true);
    local.setUint16(28, 0, true);               // pas de champ supplémentaire
    locaux.push(new Uint8Array(local.buffer), nom, donnees);

    // Entrée du répertoire central
    const entree = new DataView(new ArrayBuffer(46));
    entree.setUint32(0, 0x02014b50, true);
    entree.setUint16(4, 20, true);              // créé par (2.0)
    entree.setUint16(6, 20, true);              // version nécessaire
    entree.setUint16(8, 0x0800, true);
    entree.setUint16(10, 0, true);
    entree.setUint16(12, heure, true);
    entree.setUint16(14, jour, true);
    entree.setUint32(16, crc, true);
    entree.setUint32(20, donnees.length, true);
    entree.setUint32(24, donnees.length, true);
    entree.setUint16(28, nom.length, true);
    entree.setUint16(30, 0, true);              // champ supplémentaire
    entree.setUint16(32, 0, true);              // commentaire
    entree.setUint16(34, 0, true);              // disque
    entree.setUint16(36, 0, true);              // attributs internes
    entree.setUint32(38, 0, true);              // attributs externes
    entree.setUint32(42, decalage, true);       // position de l'en-tête local
    central.push(new Uint8Array(entree.buffer), nom);

    decalage += 30 + nom.length + donnees.length;
  }

  const tailleCentral = central.reduce((total, morceau) => total + morceau.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(4, 0, true);
  fin.setUint16(6, 0, true);
  fin.setUint16(8, fichiers.length, true);
  fin.setUint16(10, fichiers.length, true);
  fin.setUint32(12, tailleCentral, true);
  fin.setUint32(16, decalage, true);
  fin.setUint16(20, 0, true);
  return new Blob([...locaux, ...central, new Uint8Array(fin.buffer)], { type: 'application/zip' });
}
