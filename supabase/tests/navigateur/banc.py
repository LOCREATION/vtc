# Outils communs du banc d'essai navigateur (espace client et espace chauffeur).
# Les appels à la base sont exécutés sur la copie locale « loc_v2 », avec le
# rôle « authenticated » et l'identité de l'utilisateur simulé : les règles
# d'accès de la base s'appliquent comme en ligne.
import base64, json, os, subprocess, sys, tempfile, time
from urllib.parse import urlparse, parse_qsl

BANC = os.path.dirname(os.path.abspath(__file__))
RACINE_DEPOT = os.path.abspath(os.path.join(BANC, '..', '..', '..'))
CAPTURES = os.path.join(BANC, 'captures')
os.makedirs(CAPTURES, exist_ok=True)
SITE = 'http://localhost:8765/v2/'
API = 'https://rolfbdmrhwslwxluhfwr.supabase.co'
LEAFLET = os.path.join(BANC, 'node_modules', 'leaflet', 'dist')
PNG_GRIS = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+e1/PQAI8ANuuwhpHAAAAABJRU5ErkJggg==')

# Comptes des scénarios de test (11_scenarios.sql)
ADMIN = 'a0000000-0000-4000-8000-000000000001'
CLIENT = 'c0000000-0000-4000-8000-000000000001'
CHAUFFEUR = 'd0000000-0000-4000-8000-000000000001'
CHAUFFEUSE = 'd0000000-0000-4000-8000-000000000002'


def psql(script):
    with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False, encoding='utf-8') as f:
        f.write('\\set ON_ERROR_STOP on\n' + script)
    os.chmod(f.name, 0o644)
    r = subprocess.run(['su', 'postgres', '-c', f'psql -X -q -At -d loc_v2 -f {f.name}'], capture_output=True, text=True)
    os.unlink(f.name)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def systeme(requete):
    """Requête exécutée par la base elle-même (préparation des essais)."""
    code, sortie, erreur = psql(requete)
    assert code == 0, erreur
    return sortie


def en_tant_que(uid, requete):
    """Exécute « requete » comme le ferait l'API pour l'utilisateur uid. Renvoie (ok, texte)."""
    reglage = json.dumps({'sub': uid, 'role': 'authenticated'})
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
        'retour', format_type(p.prorettype, null), 'ensemble', p.proretset)
      from pg_proc p where p.oid = 'public.{nom}'::regproc;""")[1])
    parties = []
    for arg in (meta['args'] or []):
        if arg['nom'] not in corps:
            continue
        acces = f"j->'{arg['nom']}'" if arg['type'] == 'jsonb' else f"(j->>'{arg['nom']}')::{arg['type']}"
        parties.append(f"{arg['nom']} => {acces}")
    appel = f"public.{nom}({', '.join(parties)})"
    source = f"(select $j${json.dumps(corps)}$j$::jsonb as j) x"
    if meta['ensemble']:
        requete = f"select coalesce(json_agg(r), '[]') from {source}, lateral {appel} r"
    elif meta['retour'] == 'void':
        requete = f"select {appel} from {source} \\g /dev/null\nselect 'null'"
    elif meta['retour'] == 'jsonb':
        requete = f"select {appel} from {source}"
    else:
        requete = f"select to_jsonb({appel}) from {source}"
    return en_tant_que(uid, requete)


def _filtre(colonne, valeur):
    op, _, val = valeur.partition('.')
    q = lambda v: f'$v${v}$v$'
    if op == 'eq': return f'"{colonne}"::text = {q(val)}'
    if op == 'neq': return f'"{colonne}"::text <> {q(val)}'
    if op in ('gt', 'gte', 'lt', 'lte'):
        signe = {'gt': '>', 'gte': '>=', 'lt': '<', 'lte': '<='}[op]
        return f'"{colonne}" {signe} {q(val)}'
    if op == 'in':
        elements = [e.strip().strip('"') for e in val.strip('()').split(',')]
        return f'"{colonne}"::text in ({", ".join(q(e) for e in elements)})'
    if op == 'is' and val == 'null': return f'"{colonne}" is null'
    raise ValueError(f'filtre non pris en charge : {colonne}={valeur}')


def lecture_rest(url, uid):
    """Lecture PostgREST simple (select, filtres, order, limit) traduite en SQL, règles d'accès comprises."""
    u = urlparse(url)
    table = u.path.split('/rest/v1/')[1]
    colonnes, filtres, ordre, limite = '*', [], [], None
    for cle, valeur in parse_qsl(u.query, keep_blank_values=True):
        if cle == 'select': colonnes = valeur
        elif cle == 'order': ordre = valeur.split(',')
        elif cle == 'limit': limite = int(valeur)
        elif cle == 'offset': continue
        else: filtres.append(_filtre(cle, valeur))
    if '(' in colonnes:
        return True, '[]'                      # sélection imbriquée (comptes pro) : aucun dans ces essais
    cols = '*' if colonnes == '*' else ', '.join(f'"{c.strip()}"' for c in colonnes.split(','))
    tri = ', '.join(f'"{o.split(".")[0]}" {"desc" if ".desc" in o else "asc"}' for o in ordre) or '1'
    sql = (f"select coalesce(json_agg(x), '[]') from (select {cols} from public.{table} "
           f"where {' and '.join(filtres) or 'true'} order by {tri}{f' limit {limite}' if limite else ''}) x")
    return en_tant_que(uid, sql)


def session_injectee(uid, email):
    entete = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip('=')
    corps = base64.urlsafe_b64encode(json.dumps({'sub': uid, 'role': 'authenticated', 'aud': 'authenticated',
                                                 'exp': int(time.time()) + 3600}).encode()).decode().rstrip('=')
    session = {'access_token': f'{entete}.{corps}.signature', 'token_type': 'bearer', 'expires_in': 3600,
               'expires_at': int(time.time()) + 3600, 'refresh_token': 'renouvellement',
               'user': {'id': uid, 'aud': 'authenticated', 'role': 'authenticated', 'email': email}}
    return f"localStorage.setItem('sb-rolfbdmrhwslwxluhfwr-auth-token', {json.dumps(json.dumps(session))});"


def routeur(uid):
    """Intercepte le réseau : bibliothèques locales, base locale, services simulés."""
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
        if url.startswith('https://data.geopf.fr/geocodage/reverse'):
            return await route.fulfill(status=200, headers=entetes, body=json.dumps({'type': 'FeatureCollection', 'features': [
                {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [2.4303, 49.1253]},
                 'properties': {'label': '1 Allée de la Poire Bezy de Chaumontel 95270 Chaumontel'}}]}))
        if url.startswith('https://data.geopf.fr/geocodage/search'):
            return await route.fulfill(status=200, headers=entetes, body=json.dumps({'type': 'FeatureCollection', 'features': [
                {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [2.4303, 49.1253]},
                 'properties': {'label': '1 Allée de la Poire Bezy de Chaumontel 95270 Chaumontel', 'context': '95, Val-d\'Oise'}}]}))
        if url.startswith(f'{API}/rest/v1/rpc/'):
            nom = urlparse(url).path.split('/rpc/')[1]
            ok, sortie = appel_rpc(nom, json.loads(rq.post_data or '{}'), uid)
            if not ok:
                return await route.fulfill(status=400, headers=entetes, body=json.dumps({'code': 'P0001', 'message': sortie}))
            return await route.fulfill(status=200, headers=entetes, body=sortie or 'null')
        if url.startswith(f'{API}/rest/v1/'):
            table = urlparse(url).path.split('/rest/v1/')[1]
            if rq.method == 'GET':
                ok, sortie = lecture_rest(url, uid)
                if not ok:
                    return await route.fulfill(status=400, headers=entetes, body=json.dumps({'message': sortie}))
                lignes = json.loads(sortie)
                if 'vnd.pgrst.object' in (rq.headers.get('accept') or ''):
                    return await route.fulfill(status=200, headers=entetes, body=json.dumps(lignes[0] if lignes else None))
                return await route.fulfill(status=200, headers=entetes, body=json.dumps(lignes))
            if rq.method == 'PATCH':
                valeurs = json.loads(rq.post_data or '{}')
                filtres = [_filtre(k, v) for k, v in parse_qsl(urlparse(url).query) if k not in ('select',)]
                affectations = ', '.join(f'"{c}" = ' + ('null' if v is None else f'$v${v}$v$') for c, v in valeurs.items())
                ok, sortie = en_tant_que(uid, f'update public.{table} set {affectations} where {" and ".join(filtres) or "true"}')
                return await route.fulfill(status=204 if ok else 400, headers=entetes, body='' if ok else json.dumps({'message': sortie}))
            if rq.method == 'POST':
                ligne = json.loads(rq.post_data or '{}')
                cols = ', '.join(f'"{c}"' for c in ligne)
                vals = ', '.join('null' if v is None else f'$v${v}$v$' for v in ligne.values())
                ok, sortie = en_tant_que(uid, f'insert into public.{table} ({cols}) values ({vals})')
                return await route.fulfill(status=201 if ok else 400, headers=entetes, body='' if ok else json.dumps({'message': sortie}))
        if url.startswith(f'{API}/auth/v1/user'):
            return await route.fulfill(status=200, headers=entetes, body=json.dumps({'id': uid, 'aud': 'authenticated', 'role': 'authenticated'}))
        if url.startswith('http://localhost:8765/'):
            return await route.continue_()
        return await route.abort()
    return router


def serveur_local():
    return subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '--directory', RACINE_DEPOT],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def verifier(condition, libelle):
    if not condition:
        raise AssertionError('ÉCHEC : ' + libelle)
    print('  ok ·', libelle)
