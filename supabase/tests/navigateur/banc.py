# Outils communs du banc d'essai navigateur (espace client, chauffeur, administration).
# Les appels à la base sont exécutés sur la copie locale « loc_v2 », avec le
# rôle « authenticated » et l'identité de l'utilisateur simulé : les règles
# d'accès de la base s'appliquent comme en ligne.
# L'identité vient du jeton de connexion envoyé par la page (comme pour la
# vraie API) : utilisateur (« sub ») et niveau d'authentification (« aal »).
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

# Fichiers déposés pendant les essais (chemins), pour vérification
FICHIERS_DEPOSES = []
FICHIERS_RETIRES = []

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


def en_tant_que(uid, requete, aal=None):
    """Exécute « requete » comme le ferait l'API pour l'utilisateur uid. Renvoie (ok, texte).
    uid None = visiteur sans compte (anon). aal par défaut : « aal2 » pour le compte
    administrateur des essais (double authentification confirmée), « aal1 » sinon."""
    if uid is None:
        role, reglage = 'anon', json.dumps({'role': 'anon'})
    else:
        if aal is None:
            aal = 'aal2' if uid == ADMIN else 'aal1'
        role, reglage = 'authenticated', json.dumps({'sub': uid, 'role': 'authenticated', 'aal': aal})
    code, sortie, erreur = psql(f"""begin;
set local role {role};
select set_config('request.jwt.claims', $c${reglage}$c$, true) \\g /dev/null
{requete};
commit;""")
    if code != 0:
        message = erreur.split('ERROR:')[-1].strip().split('\n')[0] if 'ERROR:' in erreur else erreur
        return False, message
    return True, sortie


def appel_rpc(nom, corps, uid, aal=None):
    meta = json.loads(psql(f"""select json_build_object(
        'args', (select json_agg(json_build_object('nom', n, 'type', format_type(t, null)))
                 from unnest(p.proargnames[1:p.pronargs], p.proargtypes::oid[]) as u(n, t)),
        'retour', format_type(p.prorettype, null), 'ensemble', p.proretset)
      from pg_proc p where p.oid = 'public.{nom}'::regproc;""")[1])
    parties = []
    for arg in (meta['args'] or []):
        if arg['nom'] not in corps:
            continue
        if arg['type'] == 'jsonb':
            acces = f"j->'{arg['nom']}'"
        elif arg['type'].endswith('[]'):
            acces = (f"(case when jsonb_typeof(j->'{arg['nom']}') = 'array' then "
                     f"(select array_agg(e) from jsonb_array_elements_text(j->'{arg['nom']}') e) end)::{arg['type']}")
        else:
            acces = f"(j->>'{arg['nom']}')::{arg['type']}"
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
    return en_tant_que(uid, requete, aal)


def _q(v):
    return f'$v${v}$v$'


def _filtre(colonne, valeur):
    op, _, val = valeur.partition('.')
    if op == 'not':
        op2, _, val2 = val.partition('.')
        return f'not ({_filtre(colonne, op2 + "." + val2)})'
    if op == 'eq': return f'"{colonne}"::text = {_q(val)}'
    if op == 'neq': return f'"{colonne}"::text <> {_q(val)}'
    if op in ('gt', 'gte', 'lt', 'lte'):
        signe = {'gt': '>', 'gte': '>=', 'lt': '<', 'lte': '<='}[op]
        return f'"{colonne}" {signe} {_q(val)}'
    if op == 'in':
        elements = [e.strip().strip('"') for e in val.strip('()').split(',')]
        return f'"{colonne}"::text in ({", ".join(_q(e) for e in elements)})'
    if op == 'is' and val == 'null': return f'"{colonne}" is null'
    if op == 'is' and val in ('true', 'false'): return f'"{colonne}" is {val}'
    if op in ('ilike', 'like'):
        return f'"{colonne}"::text {op} {_q(val.replace("*", "%"))}'
    raise ValueError(f'filtre non pris en charge : {colonne}={valeur}')


def lecture_rest(url, uid, aal=None):
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
    def tri_sql(o):
        morceaux = o.split('.')
        sens = 'desc' if 'desc' in morceaux[1:] else 'asc'
        nuls = ' nulls first' if 'nullsfirst' in morceaux[1:] else ' nulls last' if 'nullslast' in morceaux[1:] else ''
        return f'"{morceaux[0]}" {sens}{nuls}'
    tri = ', '.join(tri_sql(o) for o in ordre) or '1'
    sql = (f"select coalesce(json_agg(x), '[]') from (select {cols} from public.{table} "
           f"where {' and '.join(filtres) or 'true'} order by {tri}{f' limit {limite}' if limite else ''}) x")
    return en_tant_que(uid, sql, aal)


def _b64(objet):
    return base64.urlsafe_b64encode(json.dumps(objet).encode()).decode().rstrip('=')


def jeton(uid, aal='aal1', methodes=('otp',)):
    """Jeton de connexion au format de Supabase (signature non vérifiée par le banc)."""
    corps = {'sub': uid, 'role': 'authenticated', 'aud': 'authenticated', 'exp': int(time.time()) + 3600,
             'aal': aal, 'amr': [{'method': m, 'timestamp': int(time.time())} for m in methodes],
             'session_id': 'session-essai'}
    return f"{_b64({'alg': 'HS256', 'typ': 'JWT'})}.{_b64(corps)}.c2lnbmF0dXJl"


def session_injectee(uid, email, aal='aal1', facteurs=None, methodes=('otp',)):
    session = {'access_token': jeton(uid, aal, methodes), 'token_type': 'bearer', 'expires_in': 3600,
               'expires_at': int(time.time()) + 3600, 'refresh_token': 'renouvellement',
               'user': {'id': uid, 'aud': 'authenticated', 'role': 'authenticated', 'email': email,
                        'factors': facteurs or []}}
    return f"localStorage.setItem('sb-rolfbdmrhwslwxluhfwr-auth-token', {json.dumps(json.dumps(session))});"


def identite(rq, uid_defaut):
    """Utilisateur et niveau d'authentification portés par le jeton de la requête.
    Sans jeton de session (clé publique seule) : visiteur sans compte."""
    entete = rq.headers.get('authorization') or ''
    valeur = entete.split(' ', 1)[1] if ' ' in entete else ''
    morceaux = valeur.split('.')
    if len(morceaux) == 3:
        try:
            corps = json.loads(base64.urlsafe_b64decode(morceaux[1] + '=' * (-len(morceaux[1]) % 4)))
            return corps.get('sub'), corps.get('aal', 'aal1')
        except ValueError:
            pass
    return (None, None) if uid_defaut is None else (uid_defaut, None)


class AuthSimulee:
    """Imitation du service de connexion de Supabase (GoTrue) pour un compte :
    connexion par mot de passe, changement de mot de passe, double
    authentification par application (TOTP), niveaux aal1 / aal2."""
    CODE_VALIDE = '123456'
    CLE = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'

    def __init__(self, uid, email, mot_de_passe=None, facteur_verifie=False, reauthentification=False):
        self.uid, self.email, self.mot_de_passe = uid, email, mot_de_passe
        self.facteurs = []
        self.aal, self.methodes = 'aal1', ['otp']
        self.reauthentification = reauthentification     # réglage « changement de mot de passe sécurisé »
        self.nonce_envoye = False
        self.requetes = []
        self._n = 0
        if facteur_verifie:
            self.facteurs.append(self._facteur('Administration LOC RÉACTION', 'verified'))

    def _facteur(self, nom, statut):
        self._n += 1
        maintenant = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        return {'id': f'f0000000-0000-4000-8000-00000000000{self._n}', 'friendly_name': nom, 'factor_type': 'totp',
                'status': statut, 'created_at': maintenant, 'updated_at': maintenant}

    def utilisateur(self):
        return {'id': self.uid, 'aud': 'authenticated', 'role': 'authenticated', 'email': self.email,
                'email_confirmed_at': '2026-10-30T10:00:00Z', 'factors': self.facteurs, 'app_metadata': {}, 'user_metadata': {}}

    def session(self):
        return {'access_token': jeton(self.uid, self.aal, self.methodes), 'token_type': 'bearer', 'expires_in': 3600,
                'expires_at': int(time.time()) + 3600, 'refresh_token': 'renouvellement', 'user': self.utilisateur()}

    def injection(self):
        """Session déjà ouverte dans le navigateur (connexion par code e-mail)."""
        s = self.session()
        return f"localStorage.setItem('sb-rolfbdmrhwslwxluhfwr-auth-token', {json.dumps(json.dumps(s))});"

    @staticmethod
    def _erreur(statut, code, message):
        return statut, {'error_code': code, 'msg': message}

    def repondre(self, methode, url, corps):
        u = urlparse(url)
        chemin = u.path.split('/auth/v1')[1]
        requete = dict(parse_qsl(u.query))
        self.requetes.append((methode, chemin))
        if chemin == '/token' and requete.get('grant_type') == 'password':
            if corps.get('email') == self.email and self.mot_de_passe and corps.get('password') == self.mot_de_passe:
                self.aal, self.methodes = 'aal1', ['password']
                return 200, self.session()
            return self._erreur(400, 'invalid_credentials', 'Invalid login credentials')
        if chemin == '/token' and requete.get('grant_type') == 'refresh_token':
            return 200, self.session()
        if chemin == '/user' and methode == 'GET':
            return 200, self.utilisateur()
        if chemin == '/user' and methode == 'PUT':
            if 'password' in corps:
                if self.reauthentification and not corps.get('nonce'):
                    return self._erreur(400, 'reauthentication_needed', 'Password update requires reauthentication')
                if self.reauthentification and corps.get('nonce') != '424242':
                    return self._erreur(400, 'reauthentication_not_valid', 'Verification code is invalid or expired')
                if corps['password'] == self.mot_de_passe:
                    return self._erreur(422, 'same_password', 'New password should be different from the old password.')
                self.mot_de_passe = corps['password']
            return 200, self.utilisateur()
        if chemin == '/reauthenticate':
            self.nonce_envoye = True
            return 200, {}
        if chemin == '/factors' and methode == 'POST':
            if any(f['friendly_name'] == corps.get('friendly_name') for f in self.facteurs):
                return self._erreur(422, 'mfa_factor_name_conflict', 'A factor with the friendly name already exists')
            facteur = self._facteur(corps.get('friendly_name'), 'unverified')
            self.facteurs.append(facteur)
            dessin = ('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">'
                      '<rect width="40" height="40" fill="#ffffff"/><rect x="5" y="5" width="10" height="10" fill="#000000"/></svg>')
            return 200, {'id': facteur['id'], 'type': 'totp', 'friendly_name': facteur['friendly_name'],
                         'totp': {'qr_code': dessin, 'secret': self.CLE,
                                  'uri': f'otpauth://totp/LOC%20R%C3%89ACTION:{self.email}?secret={self.CLE}&issuer=LOC%20R%C3%89ACTION'}}
        if chemin.startswith('/factors/') and methode == 'DELETE':
            identifiant = chemin.split('/')[2]
            facteur = next((f for f in self.facteurs if f['id'] == identifiant), None)
            if facteur and facteur['status'] == 'verified' and self.aal != 'aal2':
                return self._erreur(403, 'insufficient_aal', 'AAL2 required to unenroll verified factor')
            self.facteurs = [f for f in self.facteurs if f['id'] != identifiant]
            return 200, {'id': identifiant}
        if chemin.endswith('/challenge'):
            return 200, {'id': 'defi-0001', 'type': 'totp', 'expires_at': int(time.time()) + 300}
        if chemin.endswith('/verify'):
            identifiant = chemin.split('/')[2]
            facteur = next((f for f in self.facteurs if f['id'] == identifiant), None)
            if not facteur or corps.get('code') != self.CODE_VALIDE:
                return self._erreur(422, 'mfa_verification_failed', 'Invalid TOTP code entered')
            facteur['status'] = 'verified'
            self.aal = 'aal2'
            if 'totp' not in self.methodes:
                self.methodes.append('totp')
            return 200, self.session()
        if chemin.startswith('/logout'):
            self.aal, self.methodes = 'aal1', ['otp']
            return 204, None
        return self._erreur(404, 'not_found', f'Non simulé : {methode} {chemin}')


def routeur(uid, auth=None):
    """Intercepte le réseau : bibliothèques locales, base locale, services simulés.
    uid : compte par défaut ; auth : AuthSimulee (connexion, double authentification)."""
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
        if url.startswith(f'{API}/auth/v1/') and auth is not None:
            try:
                corps = json.loads(rq.post_data or '{}')
            except ValueError:
                corps = {}
            statut, reponse = auth.repondre(rq.method, url, corps)
            return await route.fulfill(status=statut, headers=entetes, body='' if reponse is None else json.dumps(reponse))
        qui, aal = identite(rq, uid)
        if url.startswith(f'{API}/storage/v1/object/') and rq.method in ('POST', 'PUT') and '/object/sign/' not in url:
            chemin = urlparse(url).path.split('/storage/v1/object/')[1]
            FICHIERS_DEPOSES.append(chemin)
            return await route.fulfill(status=200, headers=entetes, body=json.dumps({'Key': chemin, 'Id': 'b0000000-0000-4000-8000-000000000001'}))
        if url.startswith(f'{API}/storage/v1/object/') and rq.method == 'DELETE':
            # Retrait de fichiers (storage.remove) : corps { prefixes: [chemins] }
            try:
                retires = json.loads(rq.post_data or '{}').get('prefixes') or []
            except ValueError:
                retires = []
            seau = urlparse(url).path.split('/storage/v1/object/')[1].strip('/')
            FICHIERS_RETIRES.extend(f'{seau}/{c}' for c in retires)
            return await route.fulfill(status=200, headers=entetes, body=json.dumps([{'name': c} for c in retires]))
        if url.startswith(f'{API}/storage/v1/object/sign/'):
            chemin = urlparse(url).path.split('/object/sign/')[1]
            return await route.fulfill(status=200, headers=entetes, body=json.dumps({'signedURL': f'/object/sign/{chemin}?token=essai'}))
        if url.startswith(f'{API}/rest/v1/rpc/'):
            nom = urlparse(url).path.split('/rpc/')[1]
            ok, sortie = appel_rpc(nom, json.loads(rq.post_data or '{}'), qui, aal)
            if not ok:
                return await route.fulfill(status=400, headers=entetes, body=json.dumps({'code': 'P0001', 'message': sortie}))
            return await route.fulfill(status=200, headers=entetes, body=sortie or 'null')
        if url.startswith(f'{API}/rest/v1/'):
            table = urlparse(url).path.split('/rest/v1/')[1]
            filtres = [_filtre(k, v) for k, v in parse_qsl(urlparse(url).query) if k not in ('select', 'columns', 'order', 'limit', 'offset')]
            if rq.method == 'GET':
                ok, sortie = lecture_rest(url, qui, aal)
                if not ok:
                    return await route.fulfill(status=400, headers=entetes, body=json.dumps({'message': sortie}))
                lignes = json.loads(sortie)
                if 'vnd.pgrst.object' in (rq.headers.get('accept') or ''):
                    return await route.fulfill(status=200, headers=entetes, body=json.dumps(lignes[0] if lignes else None))
                return await route.fulfill(status=200, headers=entetes, body=json.dumps(lignes))
            if rq.method == 'PATCH':
                valeurs = json.loads(rq.post_data or '{}')
                affectations = ', '.join(f'"{c}" = ' + ('null' if v is None else _q(json.dumps(v) if isinstance(v, (dict, list)) else str(v).lower() if isinstance(v, bool) else v))
                                         for c, v in valeurs.items())
                ok, sortie = en_tant_que(qui, f'update public.{table} set {affectations} where {" and ".join(filtres) or "true"}', aal)
                return await route.fulfill(status=204 if ok else 400, headers=entetes, body='' if ok else json.dumps({'message': sortie}))
            if rq.method == 'POST':
                ligne = json.loads(rq.post_data or '{}')
                lignes = ligne if isinstance(ligne, list) else [ligne]
                cols = list(lignes[0].keys())
                valeurs = ', '.join('(' + ', '.join('null' if l.get(c) is None else _q(str(l[c]).lower() if isinstance(l[c], bool) else l[c]) for c in cols) + ')' for l in lignes)
                insertion = f'insert into public.{table} ({", ".join(chr(34) + c + chr(34) for c in cols)}) values {valeurs}'
                if 'return=representation' in (rq.headers.get('prefer') or ''):
                    ok, sortie = en_tant_que(qui, f"with x as ({insertion} returning *) select coalesce(json_agg(x), '[]') from x", aal)
                    if not ok:
                        return await route.fulfill(status=400, headers=entetes, body=json.dumps({'message': sortie}))
                    lignes_creees = json.loads(sortie)
                    corps = lignes_creees[0] if 'vnd.pgrst.object' in (rq.headers.get('accept') or '') else lignes_creees
                    return await route.fulfill(status=201, headers=entetes, body=json.dumps(corps))
                ok, sortie = en_tant_que(qui, insertion, aal)
                return await route.fulfill(status=201 if ok else 400, headers=entetes, body='' if ok else json.dumps({'message': sortie}))
            if rq.method == 'DELETE':
                ok, sortie = en_tant_que(qui, f'delete from public.{table} where {" and ".join(filtres) or "false"}', aal)
                return await route.fulfill(status=204 if ok else 400, headers=entetes, body='' if ok else json.dumps({'message': sortie}))
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
