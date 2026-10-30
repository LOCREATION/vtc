# Banc d'essai de l'espace client v2 (commande et suivi), de bout en bout.
# Les appels à la base sont exécutés sur la copie locale (loc_v2), avec le rôle
# « authenticated » et l'identité du client de test : règles d'accès comprises.
import asyncio, base64, json, os, subprocess, sys, tempfile, time
from urllib.parse import urlparse, parse_qsl
from playwright.async_api import async_playwright

BANC = os.path.dirname(os.path.abspath(__file__))
CAPTURES = os.path.join(BANC, 'captures')
SITE = 'http://localhost:8765/v2/'
API = 'https://rolfbdmrhwslwxluhfwr.supabase.co'
CLIENT = 'c0000000-0000-4000-8000-000000000001'      # « Claire », cliente des scénarios de test
ADMIN = 'a0000000-0000-4000-8000-000000000001'
CHAUFFEUSE = 'd0000000-0000-4000-8000-000000000002'
LEAFLET = os.path.join(BANC, 'node_modules', 'leaflet', 'dist')
console = []

def psql(script):
    with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False, encoding='utf-8') as f:
        f.write('\\set ON_ERROR_STOP on\n' + script)
    os.chmod(f.name, 0o644)
    r = subprocess.run(['su', 'postgres', '-c', f'psql -X -q -At -d loc_v2 -f {f.name}'], capture_output=True, text=True)
    os.unlink(f.name)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

def en_tant_que(uid, requete):
    """Exécute « requete » comme le ferait l'API pour l'utilisateur uid. Renvoie (ok, texte).
    Le compte administrateur des essais agit avec la double authentification
    confirmée (niveau « aal2 »), exigée par la base depuis la migration 10."""
    reglage = json.dumps({'sub': uid, 'role': 'authenticated', 'aal': 'aal2' if uid == ADMIN else 'aal1'})
    code, sortie, erreur = psql(f"""begin;
set local role authenticated;
select set_config('request.jwt.claims', $c${reglage}$c$, true) \\g /dev/null
{requete};
commit;""")
    if code != 0:
        message = erreur.split('ERROR:')[-1].strip().split('\n')[0] if 'ERROR:' in erreur else erreur
        return False, message
    return True, sortie

def appel_rpc(nom, corps, uid):
    meta = json.loads(psql(f"""select json_build_object(
        'args', (select json_agg(json_build_object('nom', n, 'type', format_type(t, null)))
                 from unnest(p.proargnames[1:p.pronargs], p.proargtypes::oid[]) as u(n, t)),
        'retour', format_type(p.prorettype, null))
      from pg_proc p where p.oid = 'public.{nom}'::regproc;""")[1])
    parties = []
    for arg in meta['args']:
        if arg['nom'] not in corps:
            continue
        acces = f"j->'{arg['nom']}'" if arg['type'] == 'jsonb' else f"(j->>'{arg['nom']}')::{arg['type']}"
        parties.append(f"{arg['nom']} => {acces}")
    appel = f"public.{nom}({', '.join(parties)})"
    expression = 'null::jsonb' if meta['retour'] == 'void' else (appel if meta['retour'] == 'jsonb' else f'to_jsonb({appel})')
    if meta['retour'] == 'void':
        requete = f"select {appel} from (select $j${json.dumps(corps)}$j$::jsonb as j) x \\g /dev/null\nselect 'null'"
    else:
        requete = f"select {expression} from (select $j${json.dumps(corps)}$j$::jsonb as j) x"
    return en_tant_que(uid, requete)

def lecture_rest(url, uid):
    """Traduit une lecture PostgREST simple (select, filtres eq., order) en SQL, avec les règles d'accès."""
    u = urlparse(url)
    table = u.path.split('/rest/v1/')[1]
    colonnes, filtres, ordre = '*', [], []
    for cle, valeur in parse_qsl(u.query, keep_blank_values=True):
        if cle == 'select': colonnes = valeur
        elif cle == 'order': ordre = valeur.split(',')
        elif valeur.startswith('eq.'): filtres.append((cle, valeur[3:]))
    if '(' in colonnes:
        return True, '[]'                       # sélection imbriquée (comptes pro) : aucun dans ces essais
    cols = '*' if colonnes == '*' else ', '.join(f'"{c.strip()}"' for c in colonnes.split(','))
    where = ' and '.join(f'"{k}"::text = $v${v}$v$' for k, v in filtres) or 'true'
    tri = ', '.join(f'"{o.split(".")[0]}" {"desc" if ".desc" in o else "asc"}' for o in ordre) or '1'
    return en_tant_que(uid, f"select coalesce(json_agg(x), '[]') from (select {cols} from public.{table} where {where} order by {tri}) x")

def session_injectee():
    entete = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip('=')
    corps = base64.urlsafe_b64encode(json.dumps({'sub': CLIENT, 'role': 'authenticated', 'aud': 'authenticated',
                                                 'exp': int(time.time()) + 3600}).encode()).decode().rstrip('=')
    session = {'access_token': f'{entete}.{corps}.signature', 'token_type': 'bearer', 'expires_in': 3600,
               'expires_at': int(time.time()) + 3600, 'refresh_token': 'renouvellement',
               'user': {'id': CLIENT, 'aud': 'authenticated', 'role': 'authenticated', 'email': 'client1@exemple.test'}}
    return f"localStorage.setItem('sb-rolfbdmrhwslwxluhfwr-auth-token', {json.dumps(json.dumps(session))});"

PNG_GRIS = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+e1/PQAI8ANuuwhpHAAAAABJRU5ErkJggg==')

async def router(route):
    rq = route.request
    url = rq.url
    entetes = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
               'Access-Control-Allow-Methods': '*', 'Content-Type': 'application/json'}
    if rq.method == 'OPTIONS':
        return await route.fulfill(status=204, headers=entetes)
    if url.startswith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm'):
        return await route.fulfill(path=os.path.join(BANC, 'supabase-esm.js'), content_type='application/javascript')
    if url.startswith('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css'):
        return await route.fulfill(path=os.path.join(LEAFLET, 'leaflet.css'), content_type='text/css')
    if url.startswith('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js'):
        return await route.fulfill(path=os.path.join(LEAFLET, 'leaflet.js'), content_type='application/javascript')
    if url.startswith('https://tile.openstreetmap.org/'):
        return await route.fulfill(status=200, body=PNG_GRIS, content_type='image/png')
    if url.startswith('https://data.geopf.fr/geocodage/search'):
        return await route.fulfill(status=200, headers=entetes, body=json.dumps({'type': 'FeatureCollection', 'features': [
            {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [2.3443, 48.8597]},
             'properties': {'label': '100 Rue de Rivoli 75001 Paris', 'context': '75, Paris, Île-de-France'}}]}))
    if url.startswith(f'{API}/rest/v1/rpc/'):
        nom = urlparse(url).path.split('/rpc/')[1]
        ok, sortie = appel_rpc(nom, json.loads(rq.post_data or '{}'), CLIENT)
        if not ok:
            return await route.fulfill(status=400, headers=entetes, body=json.dumps({'code': 'P0001', 'message': sortie}))
        return await route.fulfill(status=200, headers=entetes, body=sortie or 'null')
    if url.startswith(f'{API}/rest/v1/'):
        if rq.method == 'GET':
            ok, sortie = lecture_rest(url, CLIENT)
            if not ok:
                return await route.fulfill(status=400, headers=entetes, body=json.dumps({'message': sortie}))
            lignes = json.loads(sortie)
            if 'vnd.pgrst.object' in (rq.headers.get('accept') or ''):
                return await route.fulfill(status=200, headers=entetes, body=json.dumps(lignes[0] if lignes else None))
            return await route.fulfill(status=200, headers=entetes, body=json.dumps(lignes))
        if rq.method == 'POST':                      # insertion (proche enregistré)
            table = urlparse(url).path.split('/rest/v1/')[1]
            ligne = json.loads(rq.post_data or '{}')
            cols = ', '.join(f'"{c}"' for c in ligne)
            vals = ', '.join(f'$v${v}$v$' for v in ligne.values())
            ok, sortie = en_tant_que(CLIENT, f'insert into public.{table} ({cols}) values ({vals})')
            return await route.fulfill(status=201 if ok else 400, headers=entetes, body='' if ok else json.dumps({'message': sortie}))
    if url.startswith(f'{API}/auth/v1/user'):
        return await route.fulfill(status=200, headers=entetes, body=json.dumps({'id': CLIENT, 'aud': 'authenticated', 'role': 'authenticated'}))
    if url.startswith('http://localhost:8765/'):
        return await route.continue_()
    return await route.abort()

def verifier(condition, libelle):
    if not condition:
        raise AssertionError('ÉCHEC : ' + libelle)
    print('  ok ·', libelle)

def sql_admin(requete):
    ok, sortie = en_tant_que(ADMIN, requete)
    assert ok, sortie
    return sortie

def sql_chauffeuse(requete):
    ok, sortie = en_tant_que(CHAUFFEUSE, requete)
    assert ok, sortie
    return sortie

def remise_a_zero():
    # État connu avant chaque essai : code promo de nouveau utilisable, aucune
    # course en cours pour la cliente de test (essai rejouable)
    code, _, erreur = psql(f"""delete from public.utilisations_promo where client_id = '{CLIENT}';
update public.courses set statut = 'annulee', annulee_par = 'admin', annulee_le = now()
 where client_id = '{CLIENT}' and statut not in ('terminee', 'annulee');""")
    assert code == 0, erreur

async def main():
    remise_a_zero()
    serveur = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '--directory', os.path.abspath(os.path.join(BANC, '..', '..', '..'))],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        async with async_playwright() as p:
            nav = await p.chromium.launch()
            ctx = await nav.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                        locale='fr-FR', timezone_id='Europe/Paris', service_workers='block')
            await ctx.add_init_script(session_injectee())
            await ctx.route('**/*', router)
            page = await ctx.new_page()
            page.on('console', lambda m: console.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
            page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))

            print('Commande')
            lien = ('client/commande/?d=10+Rue+de+Rivoli+75004+Paris&dlat=48.8556&dlng=2.36'
                    '&a=Gare+de+Lyon&alat=48.8443&alng=2.3743&ch=0')
            await page.goto(SITE + lien)
            await page.wait_for_function("document.getElementById('prix').textContent.includes('€')")
            verifier((await page.input_value('#depart')).startswith('10 Rue de Rivoli'), 'trajet repris du lien de l\'accueil')
            await page.click('#ajouter-arret')
            arret = page.locator('.point-arret input')
            await arret.fill('100 rue de rivoli')
            await page.click('.point-arret .suggestion >> text=100 Rue de Rivoli')
            await page.wait_for_function("document.getElementById('prix').textContent.includes('€')")
            attendu = json.loads(appel_rpc('estimer_course', {'p_categorie': 'berline_hybride', 'p_depart_lat': 48.8556, 'p_depart_lng': 2.36,
                                                              'p_arrivee_lat': 48.8443, 'p_arrivee_lng': 2.3743,
                                                              'p_arrets': [{'lat': 48.8597, 'lng': 2.3443}]}, CLIENT)[1])
            prix = (await page.inner_text('#prix')).replace(' ', '').replace('\xa0', '')
            verifier(f"{attendu['prix_total']:.2f}".replace('.', ',') in prix, f'prix avec un arrêt = prix de la base ({prix})')
            await page.click('label:has(input[value="proche"])')
            await page.select_option('#proche-enregistre', label='Mamie Durand (+33677777777)')
            verifier(await page.input_value('#proche-telephone') == '+33677777777', 'proche enregistré : nom et téléphone repris')
            await page.click('label:has(input[value="carte"])')
            await page.fill('#code-promo', 'bienvenue10')
            await page.click('#appliquer-code')
            await page.wait_for_selector('#message-code:not([hidden])')
            verifier('Remise' in await page.inner_text('#message-code'), 'code promo accepté, remise annoncée')
            await page.wait_for_function("document.getElementById('prix').textContent.includes('€')")
            await page.screenshot(path=f'{CAPTURES}/commande-mobile.png', full_page=True)
            await page.click('#commander')
            await page.wait_for_url('**/v2/client/course/?id=*')
            id_course = page.url.split('id=')[1].split('&')[0]
            ligne = json.loads(sql_admin(f"select to_jsonb(c) from public.courses c where id = '{id_course}'"))
            verifier(ligne['pour_proche'] and ligne['beneficiaire_nom'] == 'Mamie Durand' and ligne['mode_paiement'] == 'carte'
                     and float(ligne['remise']) > 0, 'commande enregistrée : proche, carte, remise')
            nb_arrets = sql_admin(f"select count(*) from public.course_arrets where course_id = '{id_course}'")
            verifier(nb_arrets == '1', 'arrêt enregistré avec la course')

            print('Suivi')
            await page.wait_for_selector('#suivi:not([hidden])')
            titre = await page.inner_text('#etat-titre')
            verifier(titre in ('Nous cherchons un chauffeur pour vous', 'Recherche d\'un chauffeur'), f'suivi : « {titre} »')
            await page.screenshot(path=f'{CAPTURES}/suivi-recherche.png', full_page=True)
            sql_admin(f"select public.attribuer_course('{id_course}', '{CHAUFFEUSE}') \\g /dev/null\nselect 1")
            sql_chauffeuse("update public.positions set latitude = 48.850000, longitude = 2.350000 where chauffeur_id = auth.uid()")
            await page.reload()
            await page.wait_for_selector('#bloc-chauffeur:not([hidden])')
            verifier(await page.inner_text('#etat-titre') == 'Votre chauffeur arrive', 'suivi : chauffeur attribué')
            verifier(await page.inner_text('#immatriculation') == 'GB-456-CD', 'suivi : plaque du véhicule affichée')
            verifier('min' in await page.inner_text('#etat-texte'), f'suivi : heure d\'arrivée estimée ({await page.inner_text("#etat-texte")})')
            verifier((await page.get_attribute('#appeler', 'href')) == 'tel:+33644444444', 'suivi : appel direct de la chauffeuse')
            verifier(await page.locator('.repere-voiture').count() == 1, 'suivi : voiture sur la carte')
            await page.screenshot(path=f'{CAPTURES}/suivi-acceptee.png', full_page=True)
            await page.click('#annuler')
            texte_frais = await page.inner_text('#annulation-frais')
            verifier('5,00' in texte_frais.replace(' ', '').replace('\xa0', ''), f'annulation : frais annoncés ({texte_frais})')
            await page.screenshot(path=f'{CAPTURES}/suivi-annulation.png')
            await page.click('#confirmer-annulation')
            await page.wait_for_function("document.getElementById('etat-titre').textContent === 'Course annulée'")
            await page.wait_for_selector('#recap-factures .facture')
            verifier('Facture FA-' in await page.inner_text('#recap-factures'), 'annulation : facture des frais affichée')
            await page.screenshot(path=f'{CAPTURES}/suivi-annulee.png', full_page=True)

            print('Fin de course et note')
            ok, sortie = appel_rpc('commander_course', {'p_categorie': 'berline_hybride', 'p_depart_adresse': '10 Rue de Rivoli 75004 Paris',
                                                        'p_depart_lat': 48.8556, 'p_depart_lng': 2.36, 'p_arrivee_adresse': 'Gare Montparnasse',
                                                        'p_arrivee_lat': 48.8409, 'p_arrivee_lng': 2.3206}, CLIENT)
            assert ok, sortie
            id2 = json.loads(sortie)['id']
            sql_admin(f"select public.attribuer_course('{id2}', '{CHAUFFEUSE}') \\g /dev/null\nselect 1")
            for etape in ('arrivee', 'a_bord', 'terminee'):
                sql_chauffeuse(f"select public.avancer_course('{id2}', '{etape}') \\g /dev/null\nselect 1")
            await page.goto(SITE + f'client/course/?id={id2}')
            await page.wait_for_selector('#bloc-note:not([hidden])')
            verifier(await page.inner_text('#etat-titre') == 'Course terminée', 'course terminée affichée')
            await page.click('#etoiles .etoile:nth-child(4)')
            await page.fill('#commentaire', 'Très agréable')
            await page.click('#envoyer-note')
            await page.wait_for_selector('#note-donnee:not([hidden])')
            note = sql_admin(f"select note from public.evaluations where course_id = '{id2}' and sens = 'client_vers_chauffeur'")
            verifier(note == '4', 'note enregistrée (4 sur 5)')
            verifier('Facture FA-' in await page.inner_text('#recap-factures'), 'facture de la course affichée (HT, TVA, TTC)')
            verifier(not await page.is_hidden('#recommander'), '« Commander à nouveau » proposé')
            await page.screenshot(path=f'{CAPTURES}/suivi-terminee.png', full_page=True)
            await nav.close()
    finally:
        serveur.terminate()
    utiles = [c for c in console if 'WebSocket' not in c and 'realtime' not in c.lower() and 'ERR_FAILED' not in c]
    print('Erreurs de la console (hors temps réel, injoignable ici) :', utiles or 'aucune')

asyncio.run(main())
