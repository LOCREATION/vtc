// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Pied de page des pages publiques : identité légale de l'entreprise
// -----------------------------------------------------------------------------
// Lue dans la base (table « societe »), jamais recopiée à la main : raison
// sociale, forme juridique et capital, RCS, adresse du siège, e-mail de
// contact. Éléments attendus dans la page : #pied-nom, #pied-identite et,
// facultatif, #pied-contact (lien « Écrire à LOC RÉACTION », caché tant que
// l'e-mail n'est pas connu).
// Un visiteur ne lit jamais les coordonnées bancaires de l'entreprise.
// =============================================================================
import { supabase } from './supabase.js';
import { t, langueActive } from './i18n.js';

export async function remplirPiedDePage() {
  const { data: s, error } = await supabase.from('societe')
    .select('raison_sociale, forme_juridique, capital, rcs, adresse, code_postal, ville, email').maybeSingle();
  if (error || !s) return;               // pied par défaut (« LOC RÉACTION S.A.S ») si la base ne répond pas
  const capital = new Intl.NumberFormat(langueActive() === 'en' ? 'en-GB' : 'fr-FR',
    { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(s.capital || 0));
  const nom = document.getElementById('pied-nom');
  const identite = document.getElementById('pied-identite');
  const contact = document.getElementById('pied-contact');
  if (nom && s.raison_sociale) nom.textContent = s.raison_sociale;
  if (identite) {
    identite.textContent = [
      [s.forme_juridique, s.capital ? t('pied.capital', { capital }) : null].filter(Boolean).join(' '),
      s.rcs,
      [s.adresse, [s.code_postal, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    ].filter(Boolean).join('. ') + '.';
  }
  if (contact && s.email) {
    contact.href = `mailto:${s.email}`;
    contact.hidden = false;
  }
}
