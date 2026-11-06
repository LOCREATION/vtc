# Banc d'essai de l'espace client v2 (client/) : onglets Accueil, Activité,
# Compte, cloche des notifications, lien « Mon compte » de l'accueil public.
# Joué avec la cliente des scénarios de test (Claire) ; ce qui est créé ici
# (courses, lieux, notifications) est retiré, le profil remis comme avant.
import asyncio, json, re, time
from playwright.async_api import async_playwright
from banc import (SITE, CAPTURES, CLIENT, CHAUFFEUSE, ADMIN, systeme, en_tant_que, appel_rpc,
                  session_injectee, routeur, serveur_local, verifier)

console = []


def valeur(requete):
    return systeme(requete)


def commander(**autres):
    corps = {'p_categorie': 'berline_hybride', 'p_depart_adresse': '10 Rue de Rivoli 75004 Paris',
             'p_depart_lat': 48.8556, 'p_depart_lng': 2.36, 'p_arrivee_adresse': 'Gare de Lyon',
             'p_arrivee_lat': 48.8443, 'p_arrivee_lng': 2.3743, **autres}
    ok, sortie = appel_rpc('commander_course', corps, CLIENT)
    assert ok, sortie
    return json.loads(sortie)


def preparer():
    # Aucune course active pour Claire, aucun lieu enregistré
    systeme(f"""update public.courses set statut = 'annulee', annulee_par = 'admin', annulee_le = now()
                 where client_id = '{CLIENT}' and statut not in ('terminee', 'annulee');
               delete from public.lieux where client_id = '{CLIENT}';""")


async def nouveau_contexte(nav, session=True):
    ctx = await nav.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                locale='fr-FR', timezone_id='Europe/Paris', service_workers='block')
    if session:
        await ctx.add_init_script(session_injectee(CLIENT, 'client1@exemple.test'))
    await ctx.route('**/*', routeur(CLIENT if session else None))
    page = await ctx.new_page()
    page.on('console', lambda m: console.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))
    return ctx, page


async def main():
    preparer()
    debut = valeur("select now()")
    telephone = valeur(f"select coalesce(telephone, '') from public.profils where id = '{CLIENT}'")
    langue = valeur(f"select langue from public.profils where id = '{CLIENT}'")
    # Une course en cours (chauffeuse attribuée) et une réservation pour demain
    en_cours = commander()
    ok, sortie = appel_rpc('attribuer_course', {'p_course': en_cours['id'], 'p_chauffeur': CHAUFFEUSE}, ADMIN)
    assert ok, sortie
    demain = valeur("select ((now() + interval '1 day') at time zone 'Europe/Paris')::date || 'T09:30:00+01:00'")
    reservation = commander(p_type='planifiee', p_quand=demain)
    serveur = serveur_local()
    time.sleep(1)
    try:
        async with async_playwright() as p:
            nav = await p.chromium.launch()

            print('Sans session')
            ctx, page = await nouveau_contexte(nav, session=False)
            await page.goto(SITE + 'client/?onglet=activite')
            await page.wait_for_url(re.compile(r'/connexion/\?suite='))
            verifier('suite=client%2F%3Fonglet%3Dactivite' in page.url, 'sans session : connexion, puis retour à l\'onglet demandé')
            await ctx.close()

            ctx, page = await nouveau_contexte(nav)
            print('Accueil public : « Mon compte »')
            await page.goto(SITE)
            await page.wait_for_selector('#lien-client:not([hidden])')
            verifier(await page.evaluate("document.getElementById('lien-client').href") == SITE + 'client/',
                     'accueil public, cliente connectée : « Mon compte » mène à son espace')

            print('Onglet Accueil')
            await page.goto(SITE + 'client/')
            await page.wait_for_selector('#accueil-client-titre')
            verifier(await page.inner_text('#accueil-client-titre') == 'Bonjour Claire', 'accueil : « Bonjour Claire »')
            await page.wait_for_selector('#accueil-en-cours')
            verifier('Chauffeur en route' in await page.inner_text('#accueil-en-cours')
                     and await page.evaluate("document.querySelector('#accueil-en-cours a').href") == SITE + f'client/course/?id={en_cours["id"]}',
                     'accueil : course en cours, « Suivre ma course » vers son suivi')
            verifier(await page.evaluate("document.getElementById('ou-allez-vous').href") == SITE + 'client/commande/',
                     'accueil : « Où allez-vous ? » ouvre la commande')
            aeroports = int(valeur("select count(*) from public.zones where active and type = 'aeroport'"))
            verifier(await page.locator('#raccourcis-client a[data-type="aeroport"]').count() == aeroports
                     and 'commande/?a=' in await page.get_attribute('#raccourcis-client a[data-type="aeroport"]', 'href'),
                     f'accueil : {aeroports} raccourcis aéroports, la commande s\'ouvre avec l\'arrivée choisie')
            verifier(await page.is_visible('#ajouter-domicile') and await page.is_visible('#ajouter-travail'),
                     'accueil : « Ajouter mon domicile », « Ajouter mon travail » (aucun lieu enregistré)')
            verifier(await page.evaluate("document.querySelector('#accueil-prochaine a').href") == SITE + f'client/course/?id={reservation["id"]}',
                     'accueil : prochaine réservation (demain)')
            verifier('null' not in await page.inner_text('#vue-accueil'), 'accueil : aucun texte « null »')
            await page.screenshot(path=f'{CAPTURES}/client-accueil.png', full_page=True)

            print('Onglet Compte : lieux, profil')
            await page.click('#ajouter-domicile')
            await page.wait_for_selector('#vue-compte:not([hidden]) #compte-lieux')
            verifier(page.url.endswith('client/?onglet=compte'), '« Ajouter mon domicile » : onglet Compte, section Mes lieux')
            await page.click('#lieu-domicile-modifier')
            await page.click('#lieu-enregistrer')
            verifier(await page.is_visible('#lieu-adresse-erreur'), 'lieu sans adresse choisie dans la liste : refusé avant l\'envoi')
            await page.fill('#lieu-adresse', '1 allée de la poire')
            await page.click('.suggestion >> text=1 Allée de la Poire Bezy de Chaumontel')
            await page.fill('#lieu-precision', 'Portail vert')
            await page.click('#lieu-enregistrer')
            await page.wait_for_selector('#lieu-domicile-retirer')
            verifier(valeur(f"select adresse || '|' || precision from public.lieux where client_id = '{CLIENT}' and type = 'domicile'")
                     == '1 Allée de la Poire Bezy de Chaumontel 95270 Chaumontel|Portail vert',
                     'domicile enregistré dans la base (adresse, précision)')
            await page.click('#lieu-travail-modifier')
            await page.wait_for_selector('#lieu-formulaire:not([hidden])')
            verifier(await page.inner_text('#lieu-formulaire-titre') == 'Travail' and await page.input_value('#lieu-adresse') == '',
                     'après un enregistrement, le formulaire s\'ouvre encore pour le travail')
            await page.click('#lieu-annuler')
            await page.click('#compte-modifier')
            await page.fill('#compte-telephone', '12')
            await page.click('#compte-enregistrer')
            verifier(await page.is_visible('#compte-telephone-erreur'), 'profil : numéro invalide refusé avant l\'envoi')
            await page.fill('#compte-telephone', '06 12 34 56 78')
            await page.click('#compte-enregistrer')
            await page.wait_for_selector('#compte-formulaire', state='hidden')
            verifier(valeur(f"select telephone from public.profils where id = '{CLIENT}'") == '+33612345678',
                     'profil : téléphone enregistré au format international')
            await page.screenshot(path=f'{CAPTURES}/client-compte.png', full_page=True)
            await page.click('#onglets [data-onglet="accueil"]')
            await page.wait_for_selector('#raccourcis-client a[data-type="domicile"]')
            verifier('alat=49.12' in await page.get_attribute('#raccourcis-client a[data-type="domicile"]', 'href'),
                     'accueil : raccourci « Domicile », la commande s\'ouvre vers le domicile')

            print('Onglet Activité')
            await page.click('#onglets [data-onglet="activite"]')
            await page.wait_for_selector('#activite-en-cours')
            verifier(en_cours['numero'] in (await page.get_attribute('#activite-en-cours a.course-client', 'aria-label'))
                     and reservation['numero'] in (await page.get_attribute('#activite-a-venir a.course-client', 'aria-label')),
                     'activité : la course en cours, la réservation à venir')
            historique = int(valeur(f"select count(*) from public.courses where client_id = '{CLIENT}' and statut in ('terminee', 'annulee')"))
            verifier(await page.locator('#activite-historique a.course-client').count() == min(historique, 198)
                     and await page.locator('#activite-historique .activite-jour').count() >= 1,
                     f'activité : historique ({historique} courses) regroupé par jour')
            verifier('null' not in await page.inner_text('#vue-activite'), 'activité : aucun texte « null »')
            await page.screenshot(path=f'{CAPTURES}/client-activite.png', full_page=True)
            await page.click('#activite-en-cours a.course-client')
            await page.wait_for_url(re.compile(r'/client/course/\?id='))
            verifier(en_cours['id'] in page.url, 'activité : une course ouvre son suivi')
            await page.go_back()
            await page.wait_for_selector('#vue-activite:not([hidden]) #activite-en-cours')
            verifier(True, 'bouton Retour du téléphone : de retour sur l\'onglet Activité')

            print('Cloche des notifications')
            systeme(f"""insert into public.notifications (destinataire_id, type, titre, message, lien) values
              ('{CLIENT}', 'course', 'Réservation confirmée', 'Votre réservation de demain est confirmée.', '/client/activite/');""")
            non_lues = int(valeur(f"select count(*) from public.notifications where destinataire_id = '{CLIENT}' and lu_le is null"))
            await page.goto(SITE + 'client/?onglet=compte')
            await page.wait_for_selector('#cloche-non-lues:not([hidden])')
            verifier(await page.inner_text('#cloche-non-lues') == str(min(non_lues, 99)), f'cloche : {non_lues} notifications non lues')
            await page.click('#cloche')
            await page.wait_for_selector('dialog#notifs[open] #notifs-liste li')
            await page.locator('#notifs-liste .notif', has_text='Votre réservation de demain est confirmée.').click()
            await page.wait_for_selector('#vue-activite:not([hidden]) #activite-a-venir')
            verifier(await page.is_hidden('dialog#notifs') and page.url.endswith('client/?onglet=activite'),
                     'notification « Réservation confirmée » : onglet Activité, sans quitter la page')

            print('Langue')
            await page.click('#onglets [data-onglet="compte"]')
            await page.wait_for_selector('#compte-langue-en')
            await page.check('#compte-langue-en')
            await page.wait_for_url(re.compile(r'lang=en'))
            await page.wait_for_selector('#compte-titre')
            verifier(await page.inner_text('#compte-titre') == 'Account' and await page.inner_text('#onglets [data-onglet="activite"]') == 'Activity'
                     and valeur(f"select langue from public.profils where id = '{CLIENT}'") == 'en',
                     'langue : anglais enregistré, l\'espace s\'affiche en anglais')
            verifier('lang=en' in await page.get_attribute('#onglets [data-onglet="activite"]', 'href'), 'langue : elle suit dans les onglets')
            await page.check('#compte-langue-fr')
            await page.wait_for_url(re.compile(r'lang=fr'))
            await page.wait_for_selector('#compte-titre')
            verifier(await page.inner_text('#compte-titre') == 'Compte', 'langue : retour au français')

            print('Adresse /client/activite/ et déconnexion')
            await page.goto(SITE + 'client/activite/')
            await page.wait_for_selector('#vue-activite:not([hidden]) #activite-titre')
            verifier(page.url.endswith('client/?onglet=activite'), 'adresse /client/activite/ : onglet Activité')
            await page.click('#onglets [data-onglet="compte"]')
            await page.click('#compte-deconnexion')
            await page.wait_for_url(re.compile(r'/v2/(\?lang=fr)?$'))
            verifier(True, 'déconnexion : retour à l\'accueil')
            await ctx.close()

            print('Nouveau client : aucune course')
            nouveau = systeme(f"""set role supabase_auth_admin;
insert into auth.users (email, raw_user_meta_data) values ('nouveau{int(time.time())}@exemple.test', '{{"prenom":"Inès","nom":"Martin"}}') returning id;""").splitlines()[-1]
            try:
                ctx = await nav.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                            locale='fr-FR', timezone_id='Europe/Paris', service_workers='block')
                await ctx.add_init_script(session_injectee(nouveau, 'nouveau@exemple.test'))
                await ctx.route('**/*', routeur(nouveau))
                page = await ctx.new_page()
                page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))
                await page.goto(SITE + 'client/')
                await page.wait_for_selector('#ou-allez-vous')
                verifier(await page.inner_text('#accueil-client-titre') == 'Bonjour Inès' and await page.is_hidden('#accueil-en-cours')
                         and 'null' not in await page.inner_text('#vue-accueil'),
                         'nouveau client : accueil sans course en cours ni réservation, aucun « null »')
                await page.click('#onglets [data-onglet="activite"]')
                await page.wait_for_selector('#activite-vide')
                verifier('Aucune course pour le moment.' in await page.inner_text('#activite-vide')
                         and 'null' not in await page.inner_text('#vue-activite')
                         and await page.evaluate("document.querySelector('#activite-vide a').href") == SITE + 'client/commande/',
                         'nouveau client : « Aucune course pour le moment. » et « Commander une course »')
                await page.screenshot(path=f'{CAPTURES}/client-activite-vide.png')
                await ctx.close()
            finally:
                systeme(f"delete from auth.users where id = '{nouveau}';")
            await nav.close()
    finally:
        serveur.terminate()
        # Retour à l'état de départ
        for c in (en_cours, reservation):
            appel_rpc('annuler_course', {'p_course': c['id'], 'p_motif': 'Fin de l\'essai'}, ADMIN)
        systeme(f"""delete from public.lieux where client_id = '{CLIENT}';
                   update public.profils set telephone = nullif($t${telephone}$t$, ''), langue = '{langue}' where id = '{CLIENT}';
                   delete from public.notifications where destinataire_id = '{CLIENT}' and cree_le >= '{debut}';""")
    utiles = [c for c in console if 'WebSocket' not in c and 'realtime' not in c.lower() and 'ERR_FAILED' not in c]
    print('Erreurs de la console (hors temps réel, injoignable ici) :', utiles or 'aucune')


asyncio.run(main())
