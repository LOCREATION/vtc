# Banc d'essai des pages v2 dans Chromium.
# Le réseau extérieur étant fermé ici, on intercepte :
#   - la bibliothèque Supabase (CDN)      → paquet local empaqueté
#   - l'API de la base (REST, RPC)        → réponses calculées par la copie locale de la base
#   - l'authentification (code e-mail)    → réponses simulées
#   - le service d'adresses de l'État     → réponses simulées au même format
import asyncio, base64, json, os, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright

BANC = os.path.dirname(os.path.abspath(__file__))
CAPTURES = os.path.join(BANC, 'captures')
os.makedirs(CAPTURES, exist_ok=True)
SITE = 'http://localhost:8765/v2/'
API = 'https://rolfbdmrhwslwxluhfwr.supabase.co'
ID_TEST = 'e0000000-0000-4000-8000-000000000001'
erreurs_console = []

def sql(requete):
    """Exécute une requête sur la copie locale de la base et renvoie le texte du résultat."""
    with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False, encoding='utf-8') as f:
        f.write(requete)
    os.chmod(f.name, 0o644)
    sortie = subprocess.run(['su', 'postgres', '-c', f'psql -X -At -d loc_v2 -f {f.name}'],
                            capture_output=True, text=True)
    os.unlink(f.name)
    if sortie.returncode != 0 or 'ERROR' in sortie.stderr:
        raise RuntimeError(sortie.stderr)
    return sortie.stdout.strip()

def jeton():
    entete = base64.urlsafe_b64encode(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode()).decode().rstrip('=')
    corps = base64.urlsafe_b64encode(json.dumps({'sub': ID_TEST, 'role': 'authenticated', 'email': 'essai@exemple.test',
                                                 'exp': int(time.time()) + 3600, 'aud': 'authenticated'}).encode()).decode().rstrip('=')
    return f'{entete}.{corps}.signature'

profil_test = {'id': ID_TEST, 'role': 'client', 'statut': 'actif', 'prenom': '', 'nom': '', 'email': 'essai@exemple.test',
               'telephone': None, 'langue': 'fr', 'code_parrainage': 'ABCD2345'}
modifications_profil = []

async def router(route):
    requete = route.request
    url = requete.url
    if url.startswith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm'):
        return await route.fulfill(path=os.path.join(BANC, 'supabase-esm.js'), content_type='application/javascript',
                                   headers={'Access-Control-Allow-Origin': '*'})
    entetes = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*',
               'Content-Type': 'application/json'}
    if requete.method == 'OPTIONS':
        return await route.fulfill(status=204, headers=entetes)
    objet = 'vnd.pgrst.object' in (requete.headers.get('accept') or '')

    def reponse_ligne(ligne):
        return json.dumps(ligne if objet else [ligne])

    if url.startswith(f'{API}/rest/v1/zones'):
        corps = sql("select json_agg(z order by z.nom) from (select code, nom, type, latitude, longitude from public.zones where active) z;")
        return await route.fulfill(status=200, headers=entetes, body=corps)
    if url.startswith(f'{API}/rest/v1/parametres'):
        return await route.fulfill(status=200, headers=entetes, body=reponse_ligne(json.loads(sql(
            "select row_to_json(p) from (select delai_min_planification_min from public.parametres) p;"))))
    if url.startswith(f'{API}/rest/v1/societe'):
        return await route.fulfill(status=200, headers=entetes, body=reponse_ligne(json.loads(sql(
            "select row_to_json(s) from public.societe s;"))))
    if url.startswith(f'{API}/rest/v1/rpc/estimer_course'):
        corps = requete.post_data or '{}'
        resultat = sql(f"""select public.estimer_course(
              p_categorie => j->>'p_categorie',
              p_depart_lat => (j->>'p_depart_lat')::numeric, p_depart_lng => (j->>'p_depart_lng')::numeric,
              p_arrivee_lat => (j->>'p_arrivee_lat')::numeric, p_arrivee_lng => (j->>'p_arrivee_lng')::numeric,
              p_quand => (j->>'p_quand')::timestamptz, p_type => j->>'p_type',
              p_option_chauffeuse => coalesce((j->>'p_option_chauffeuse')::boolean, false))
            from (select $json${corps}$json$::jsonb as j) x;""")
        return await route.fulfill(status=200, headers=entetes, body=resultat)
    if url.startswith(f'{API}/rest/v1/profils'):
        if requete.method == 'PATCH':
            modif = json.loads(requete.post_data or '{}')
            modifications_profil.append(modif)
            profil_test.update(modif)
            return await route.fulfill(status=204, headers=entetes, body='')
        return await route.fulfill(status=200, headers=entetes, body=reponse_ligne(profil_test))
    if url.startswith(f'{API}/auth/v1/otp'):
        return await route.fulfill(status=200, headers=entetes, body='{}')
    if url.startswith(f'{API}/auth/v1/verify'):
        donnees = json.loads(requete.post_data or '{}')
        if donnees.get('token') != '123456':
            return await route.fulfill(status=403, headers=entetes, body=json.dumps(
                {'code': 403, 'error_code': 'otp_expired', 'msg': 'Token has expired or is invalid'}))
        utilisateur = {'id': ID_TEST, 'aud': 'authenticated', 'role': 'authenticated', 'email': 'essai@exemple.test',
                       'app_metadata': {}, 'user_metadata': {}, 'created_at': '2026-10-30T08:00:00Z'}
        return await route.fulfill(status=200, headers=entetes, body=json.dumps({
            'access_token': jeton(), 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': int(time.time()) + 3600,
            'refresh_token': 'jeton-de-renouvellement', 'user': utilisateur}))
    if url.startswith(f'{API}/auth/v1/user'):
        return await route.fulfill(status=200, headers=entetes, body=json.dumps({'id': ID_TEST, 'email': 'essai@exemple.test',
                                                                                  'aud': 'authenticated', 'role': 'authenticated'}))
    if url.startswith('https://data.geopf.fr/geocodage/search'):
        return await route.fulfill(status=200, headers=entetes, body=json.dumps({'type': 'FeatureCollection', 'features': [
            {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [2.36, 48.8556]},
             'properties': {'label': '10 Rue de Rivoli 75004 Paris', 'context': '75, Paris, Île-de-France'}},
            {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [2.3443, 48.8597]},
             'properties': {'label': '100 Rue de Rivoli 75001 Paris', 'context': '75, Paris, Île-de-France'}}]}))
    if url.startswith('http://localhost:8765/'):
        return await route.continue_()
    print('  (requête non prévue, bloquée) ', requete.method, url)
    return await route.abort()

def verifier(condition, libelle):
    if not condition:
        raise AssertionError('ÉCHEC : ' + libelle)
    print('  ok ·', libelle)

async def nouvelle_page(navigateur, largeur, hauteur, mobile):
    contexte = await navigateur.new_context(viewport={'width': largeur, 'height': hauteur}, is_mobile=mobile,
                                            has_touch=mobile, locale='fr-FR', timezone_id='Europe/Paris',
                                            service_workers='block')
    await contexte.route('**/*', router)
    page = await contexte.new_page()
    page.on('console', lambda m: erreurs_console.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: erreurs_console.append(f'pageerror: {e}'))
    return contexte, page

async def accueil(navigateur, largeur, hauteur, mobile, suffixe):
    contexte, page = await nouvelle_page(navigateur, largeur, hauteur, mobile)
    await page.goto(SITE)
    await page.wait_for_selector('#raccourcis .pastille')
    await page.screenshot(path=f'{CAPTURES}/accueil-{suffixe}-1-vide.png', full_page=True)
    verifier(await page.locator('#raccourcis .pastille').count() == 4, f'accueil {suffixe} : 4 raccourcis aéroports lus dans la base')
    verifier('RCS Pontoise' in await page.inner_text('#pied-identite'), f'accueil {suffixe} : identité légale lue dans la base')
    # Départ par saisie et suggestion, arrivée par raccourci Roissy
    await page.fill('#depart', '10 rue de riv')
    await page.wait_for_selector('.suggestion >> text=10 Rue de Rivoli')
    await page.screenshot(path=f'{CAPTURES}/accueil-{suffixe}-2-suggestions.png', full_page=False)
    await page.click('.suggestion >> text=10 Rue de Rivoli')
    await page.click('#raccourcis .pastille >> text=Roissy-CDG')
    await page.wait_for_function("document.getElementById('prix').textContent.includes('€')")
    prix = await page.inner_text('#prix')
    attendu = sql("""select replace(to_char((public.estimer_course('berline_hybride', 48.8556, 2.36, 49.0097, 2.5479) ->> 'prix_total')::numeric, 'FM9990.00'), '.', ',');""")
    verifier(attendu in prix.replace(' ', '').replace('\xa0', ''), f'accueil {suffixe} : prix affiché = prix de la base ({prix})')
    verifier(await page.is_enabled('#commander'), f'accueil {suffixe} : bouton Commander actif')
    await page.screenshot(path=f'{CAPTURES}/accueil-{suffixe}-3-prix.png', full_page=True)
    # Plus tard : date proposée au plus tôt, bouton « Réserver »
    await page.click('label:has(input[value="plus_tard"])')
    await page.wait_for_selector('#bloc-date:not([hidden])')
    await page.wait_for_function("document.getElementById('prix').textContent.includes('€')")
    verifier((await page.inner_text('#commander')).strip() == 'Réserver', f'accueil {suffixe} : réservation à l\'avance proposée')
    # Inversion départ / arrivée
    await page.click('#inverser')
    verifier((await page.input_value('#depart')).startswith('Aéroport Paris-Charles'), f'accueil {suffixe} : inversion départ et arrivée')
    # Commander sans être connecté → page de connexion avec la suite
    await page.click('#inverser')
    await page.wait_for_function("document.getElementById('prix').textContent.includes('€')")
    await page.click('#commander')
    await page.wait_for_url('**/v2/connexion/**')
    verifier('suite=client%2Fcommande' in page.url, f'accueil {suffixe} : Commander → connexion, puis retour à la commande')
    await contexte.close()

async def connexion(navigateur):
    contexte, page = await nouvelle_page(navigateur, 390, 844, True)
    suite = 'client/commande/?d=10+Rue+de+Rivoli&p=81.43'
    await page.goto(SITE + 'connexion/?suite=' + suite.replace('/', '%2F').replace('?', '%3F').replace('=', '%3D').replace('&', '%26'))
    await page.screenshot(path=f'{CAPTURES}/connexion-1-email.png', full_page=True)
    await page.fill('#email', 'pas-une-adresse')
    await page.click('#bouton-email')
    verifier(not await page.is_hidden('#erreur-email'), 'connexion : adresse invalide signalée')
    await page.fill('#email', 'Essai@Exemple.test')
    await page.click('#bouton-email')
    await page.wait_for_selector('#etape-code:not([hidden])')
    verifier('essai@exemple.test' in await page.inner_text('#code-envoye'), 'connexion : code envoyé, adresse rappelée')
    verifier('60' in await page.inner_text('#renvoyer') or '59' in await page.inner_text('#renvoyer'), 'connexion : renvoi possible après 60 s')
    await page.screenshot(path=f'{CAPTURES}/connexion-2-code.png', full_page=True)
    await page.fill('#code', '000000')
    await page.wait_for_selector('#erreur-code:not([hidden])')
    verifier('incorrect' in await page.inner_text('#erreur-code'), 'connexion : mauvais code refusé avec un message clair')
    await page.fill('#code', '123456')
    await page.wait_for_selector('#etape-profil:not([hidden])')
    verifier(True, 'connexion : bon code accepté → profil à compléter')
    await page.screenshot(path=f'{CAPTURES}/connexion-3-profil.png', full_page=True)
    await page.fill('#prenom', 'Claire')
    await page.fill('#telephone', '06 11 22 33 44')
    await page.click('#bouton-profil')
    await page.wait_for_url('**/v2/client/commande/**')
    verifier(modifications_profil and modifications_profil[-1].get('telephone') == '+33611223344',
             'connexion : téléphone enregistré au format international (+33611223344)')
    verifier('/v2/client/commande/' in page.url and 'p=81.43' in page.url, 'connexion : retour à la commande demandée')
    # Lien de retour vers un autre site : refusé
    await page.goto(SITE + 'connexion/?suite=https%3A%2F%2Fexemple.com%2F')
    await page.wait_for_url('**/v2/**')
    verifier(page.url.startswith('http://localhost:8765/v2/'), 'connexion : redirection vers un site extérieur refusée')
    await contexte.close()

async def anglais(navigateur):
    contexte, page = await nouvelle_page(navigateur, 1280, 900, False)
    await page.goto(SITE + '?lang=en')
    await page.wait_for_selector('#raccourcis .pastille')
    verifier((await page.inner_text('h1')).startswith('Your ride'), 'anglais : page traduite')
    verifier('lang=en' in (await page.get_attribute('#lien-connexion', 'href')), 'anglais : la langue suit dans les liens')
    await page.screenshot(path=f'{CAPTURES}/accueil-en-bureau.png', full_page=True)
    await contexte.close()

async def main():
    serveur = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '--directory', os.path.abspath(os.path.join(BANC, '..', '..', '..'))],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        async with async_playwright() as p:
            navigateur = await p.chromium.launch()
            print('Accueil, téléphone')
            await accueil(navigateur, 390, 844, True, 'mobile')
            print('Accueil, ordinateur')
            await accueil(navigateur, 1280, 900, False, 'bureau')
            print('Connexion')
            await connexion(navigateur)
            print('Anglais')
            await anglais(navigateur)
            await navigateur.close()
    finally:
        serveur.terminate()
    pertinentes = [e for e in erreurs_console if 'favicon' not in e and '404' not in e]
    print('Messages de la console :', pertinentes if pertinentes else 'aucun')

asyncio.run(main())
