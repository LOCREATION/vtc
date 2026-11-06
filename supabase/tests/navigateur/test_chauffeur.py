# Banc d'essai de l'espace chauffeur v2 : service, demande entrante, course
# complète, encaissement, note, feuille de route, délai dépassé, refus,
# réservation prise ; onglets Revenus, Courses et Compte, demande reçue sur
# un autre onglet, feuille de route et relevé en PDF, déconnexion.
# Joué avec la chauffeuse des scénarios de test.
import asyncio, json, re, time
from decimal import Decimal
from playwright.async_api import async_playwright
from banc import (SITE, CAPTURES, CLIENT, CHAUFFEUSE, ADMIN, systeme, en_tant_que, appel_rpc,
                  session_injectee, routeur, serveur_local, verifier)

console = []


def normaliser(texte):
    """Texte sans aucun espace (les montants français contiennent des espaces insécables)."""
    return re.sub(r'\s', '', texte)


def montant_fr(valeur_sql):
    """« 85.4 » (base) → « 85,40€ » (affichage français, sans espace)."""
    return f"{Decimal(valeur_sql):.2f}".replace('.', ',') + '€'


def chiffre_attendu(depuis_sql):
    """Chiffre d'affaires des courses terminées de la chauffeuse depuis un jour de Paris (prix fixe + attente)."""
    return valeur(f"""select coalesce(sum(prix_total + frais_attente), 0) from public.courses
                       where chauffeur_id = '{CHAUFFEUSE}' and statut = 'terminee'
                         and (terminee_le at time zone 'Europe/Paris')::date
                             between {depuis_sql} and (now() at time zone 'Europe/Paris')::date""")


async def capture_complete(page, chemin):
    """Capture de toute la page, la barre d'onglets à sa vraie place (en bas de l'écran)."""
    await page.evaluate('window.scrollTo(0, 0)')
    hauteur = 844
    for _ in range(3):                     # la hauteur peut encore changer une fois agrandie
        mesure = await page.evaluate('document.documentElement.scrollHeight')
        if mesure <= hauteur:
            break
        hauteur = mesure
        await page.set_viewport_size({'width': 390, 'height': hauteur})
        await page.wait_for_timeout(150)
    await page.screenshot(path=chemin)
    await page.set_viewport_size({'width': 390, 'height': 844})


async def onglets_chauffeur(ctx, page, course, reservation):
    """Onglets Revenus, Courses, Compte ; la chauffeuse est en ligne au départ."""
    print('Onglets')
    verifier(await page.locator('#onglets .onglet-bas').count() == 4 and await page.is_visible('#onglets'),
             'barre d\'onglets : Accueil, Revenus, Courses, Compte')
    verifier(await page.get_attribute('#onglets [data-onglet="accueil"]', 'aria-current') == 'page', 'onglet Accueil ouvert au départ')
    await page.wait_for_timeout(4200)      # le message de l'étape précédente s'efface
    await page.evaluate('window.scrollTo(0, 0)')
    await page.screenshot(path=f'{CAPTURES}/chauffeur-accueil-telephone.png')
    await page.click('#onglets [data-onglet="revenus"]')
    await page.wait_for_selector('#vue-revenus:not([hidden]) #revenus-ca')
    verifier(page.url.endswith('chauffeur/?onglet=revenus'), 'onglet Revenus : gardé dans l\'adresse')
    verifier(await page.is_hidden('#vue-accueil') and await page.inner_text('#pastille-etat') == 'En ligne',
             'onglet Revenus : sans rechargement, toujours en ligne')

    print('Demande reçue sur un autre onglet')
    autre = commander()
    await page.wait_for_selector('#demande:not([hidden])', timeout=15000)
    verifier('10 Rue de Rivoli' in await page.inner_text('#demande'), 'demande entrante en plein écran depuis l\'onglet Revenus')
    await page.click('#refuser')
    await page.wait_for_selector('#demande[hidden]', state='attached')
    annuler_par_admin(autre['id'])

    print('Revenus')
    jour = chiffre_attendu("(now() at time zone 'Europe/Paris')::date")
    nb = valeur(f"""select count(*) from public.courses where chauffeur_id = '{CHAUFFEUSE}' and statut = 'terminee'
                     and (terminee_le at time zone 'Europe/Paris')::date = (now() at time zone 'Europe/Paris')::date""")
    await page.wait_for_function(f"(document.getElementById('revenus-ca')?.textContent || '').replace(/\\s/g, '') === '{montant_fr(jour)}'", timeout=8000)
    verifier(await page.inner_text('#revenus-libelle') == 'Aujourd\'hui', f'revenus du jour : {montant_fr(jour)} comme dans la base')
    verifier(await page.inner_text('#revenus-chiffres div:first-child dd') == nb, f'revenus du jour : {nb} course(s) terminée(s)')
    verifier('Trajets (prix fixes)' in await page.inner_text('#revenus-detail'), 'revenus : détail des trajets, majorations, attente, pourboires')
    await capture_complete(page, f'{CAPTURES}/chauffeur-revenus-telephone.png')
    for code, debut in (('semaine', "date_trunc('week', now() at time zone 'Europe/Paris')::date"),
                        ('mois', "date_trunc('month', now() at time zone 'Europe/Paris')::date")):
        await page.click(f'label[for="revenus-type-{code}"]')
        attendu = chiffre_attendu(debut)
        await page.wait_for_function(f"(document.getElementById('revenus-ca')?.textContent || '').replace(/\\s/g, '') === '{montant_fr(attendu)}'", timeout=8000)
        libelle = await page.inner_text('#revenus-libelle')
        verifier(libelle.startswith('Semaine du') if code == 'semaine' else re.match(r'^[A-ZÉÛ][a-zéû]+ \d{4}$', libelle) is not None,
                 f'revenus {code} : {libelle}, {montant_fr(attendu)} comme dans la base')
    verifier(await page.is_disabled('#revenus-suivante'), 'revenus : pas de période à venir')
    await page.click('#revenus-precedente')
    await page.wait_for_function("!document.getElementById('revenus-suivante').disabled")
    verifier(True, 'revenus : mois précédent consultable')
    await page.click('#revenus-suivante')
    await page.wait_for_function("document.getElementById('revenus-suivante').disabled")
    mois = chiffre_attendu("date_trunc('month', now() at time zone 'Europe/Paris')::date")
    releve = await page.get_attribute('#revenus-releve', 'href')
    verifier(re.match(r'^document/\?type=releve&du=\d{4}-\d{2}-01&au=\d{4}-\d{2}-\d{2}$', releve or '') is not None,
             'revenus : relevé du mois en PDF')

    print('Courses')
    await page.click('#onglets [data-onglet="courses"]')
    await page.wait_for_function(f"(document.getElementById('courses-liste')?.textContent || '').includes('{course['numero']}')", timeout=8000)
    verifier(page.url.endswith('chauffeur/?onglet=courses'), f'onglet Courses : la course {course["numero"]} est dans l\'historique')
    await page.click('label[for="courses-filtre-annulee"]')
    await page.wait_for_function(f"(document.getElementById('courses-liste')?.textContent || '').includes('{reservation['numero']}')", timeout=8000)
    verifier(course['numero'] not in await page.inner_text('#courses-liste'),
             'filtre Annulées : la réservation annulée par l\'administration, sans les courses terminées')
    await page.click('label[for="courses-filtre-terminee"]')
    await page.wait_for_function(f"(document.getElementById('courses-liste')?.textContent || '').includes('{course['numero']}')", timeout=8000)
    await capture_complete(page, f'{CAPTURES}/chauffeur-courses-telephone.png')
    await page.click(f'#courses-liste button[aria-label^="Course {course["numero"]}"]')
    await page.wait_for_selector('#courses-zone-fiche:not([hidden]) #fiche-titre')
    fiche = await page.inner_text('#courses-zone-fiche')
    verifier(f'Course {course["numero"]}' in fiche and 'Prix fixe' in fiche and 'Encaissé' in fiche and 'Note du client' in fiche,
             'fiche : trajet, horaires, prix détaillé, paiement encaissé, note du client')
    feuille = await page.get_attribute('#fiche-feuille', 'href')
    verifier(feuille == f'document/?type=feuille&course={course["id"]}', 'fiche : feuille de route en PDF')
    await capture_complete(page, f'{CAPTURES}/chauffeur-courses-fiche-telephone.png')
    await page.click('#courses-retour')
    await page.wait_for_selector('#courses-zone-liste:not([hidden])')

    print('Documents')
    doc = await ctx.new_page()
    doc.on('pageerror', lambda e: console.append(f'pageerror (document) : {e}'))
    await doc.goto(SITE + 'chauffeur/' + feuille)
    await doc.wait_for_selector('#document .doc')
    texte = await doc.inner_text('#document')
    verifier('FEUILLE DE ROUTE' in texte.upper() and course['numero'] in texte and 'Claire' in texte and 'LOC RÉACTION S.A.S' in texte,
             'feuille de route PDF : entreprise, course, client')
    verifier('Justificatif de la réservation préalable' in texte and 'Prise en charge' in texte and 'Réservée le' in texte,
             'feuille de route PDF : réservation préalable, date et lieu de prise en charge')
    registre = valeur("select coalesce(registre_vtc_numero, '') from public.societe where id = 1")
    if registre:
        verifier(f'Registre des exploitants VTC n° {registre}' in texte, 'feuille de route PDF : n° du registre VTC')
    else:
        verifier(await doc.is_visible('#document .alerte'), 'feuille de route PDF : n° du registre VTC manquant signalé à l\'écran')
    await doc.screenshot(path=f'{CAPTURES}/chauffeur-feuille-de-route-telephone.png', full_page=True)
    await doc.emulate_media(media='print')
    verifier(await doc.is_hidden('.barre-document') and await doc.is_visible('#document .doc'), 'impression : le document seul, sans la barre d\'outils')
    await doc.emulate_media(media='screen')
    await doc.goto(SITE + 'chauffeur/' + releve)
    await doc.wait_for_selector('#document .doc')
    texte = await doc.inner_text('#document')
    verifier(f'Chiffred\'affairesdescourses{montant_fr(mois)}' in normaliser(texte) and course['numero'] in texte,
             f'relevé du mois PDF : chiffre d\'affaires {montant_fr(mois)}, détail des courses')
    await doc.screenshot(path=f'{CAPTURES}/chauffeur-releve-telephone.png', full_page=True)
    await doc.close()

    print('Compte')
    await page.click('#onglets [data-onglet="compte"]')
    await page.wait_for_selector('#vue-compte:not([hidden]) #compte-profil dd')
    prenom = valeur(f"select prenom from public.profils where id = '{CHAUFFEUSE}'")
    verifier(prenom in await page.inner_text('#compte-profil'), 'compte : profil de la chauffeuse')
    immat = valeur(f"""select coalesce(v.immatriculation, '') from public.chauffeurs c
                        left join public.vehicules v on v.id = c.vehicule_id where c.id = '{CHAUFFEUSE}'""")
    fiche = await page.inner_text('#compte-fiche')
    verifier('Validée' in fiche and (immat in fiche if immat else 'Aucun véhicule affecté' in fiche), 'compte : fiche chauffeur, véhicule affecté')
    await capture_complete(page, f'{CAPTURES}/chauffeur-compte-telephone.png')
    telephone = valeur(f"select coalesce(telephone, '') from public.profils where id = '{CHAUFFEUSE}'")
    await page.click('#compte-modifier')
    await page.fill('#compte-telephone', '12')
    await page.click('#compte-enregistrer')
    verifier(await page.is_visible('#compte-telephone-erreur'), 'compte : numéro de téléphone invalide refusé avant l\'envoi')
    await page.fill('#compte-telephone', '06 99 88 77 66')
    await page.click('#compte-enregistrer')
    await page.wait_for_selector('#compte-formulaire', state='hidden')
    verifier(valeur(f"select telephone from public.profils where id = '{CHAUFFEUSE}'") == '+33699887766',
             'compte : téléphone enregistré dans la base')
    systeme(f"update public.profils set telephone = nullif($t${telephone}$t$, '') where id = '{CHAUFFEUSE}';")
    await page.click('#onglets [data-onglet="accueil"]')
    await page.wait_for_selector('#vue-accueil:not([hidden])')
    verifier(page.url.endswith('/chauffeur/'), 'retour à l\'accueil : adresse sans onglet')
    await page.go_back()
    await page.wait_for_selector('#vue-compte:not([hidden])')
    verifier(True, 'bouton Retour du téléphone : onglet précédent (Compte)')
    await page.click('#onglets [data-onglet="accueil"]')
    await page.wait_for_selector('#vue-accueil:not([hidden])')


def preparer():
    # État connu : aucune course en cours, personne en ligne, délai de réponse de 30 s
    systeme("""update public.courses set statut = 'annulee', annulee_par = 'admin', annulee_le = now()
                 where statut not in ('terminee', 'annulee');
               update public.propositions set statut = 'annulee', repondue_le = now() where statut = 'envoyee';
               update public.positions set en_ligne = false;
               delete from public.utilisations_promo;
               update public.parametres set delai_reponse_chauffeur_s = 30;""")


def commander(**autres):
    corps = {'p_categorie': 'berline_hybride', 'p_depart_adresse': '10 Rue de Rivoli 75004 Paris',
             'p_depart_lat': 48.8556, 'p_depart_lng': 2.36, 'p_arrivee_adresse': 'Gare de Lyon',
             'p_arrivee_lat': 48.8443, 'p_arrivee_lng': 2.3743, **autres}
    ok, sortie = appel_rpc('commander_course', corps, CLIENT)
    assert ok, sortie
    return json.loads(sortie)


def annuler_par_admin(id_course):
    ok, sortie = appel_rpc('annuler_course', {'p_course': id_course, 'p_motif': 'Fin de l\'essai'}, ADMIN)
    assert ok, sortie


def valeur(requete):
    return systeme(requete)


async def main():
    preparer()
    serveur = serveur_local()
    time.sleep(1)
    try:
        async with async_playwright() as p:
            nav = await p.chromium.launch()
            ctx = await nav.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                        locale='fr-FR', timezone_id='Europe/Paris', service_workers='block',
                                        geolocation={'latitude': 48.8530, 'longitude': 2.3500}, permissions=['geolocation'])
            await ctx.add_init_script(session_injectee(CHAUFFEUSE, 'chauffeuse@exemple.test'))
            await ctx.route('**/*', routeur(CHAUFFEUSE))
            page = await ctx.new_page()
            page.on('console', lambda m: console.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
            page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))

            print('Service')
            await page.goto(SITE + 'chauffeur/')
            await page.wait_for_selector('#espace:not([hidden])')
            verifier(await page.inner_text('#pastille-etat') == 'Hors ligne', 'accueil chauffeur : hors ligne au départ')
            await page.click('#bascule-en-ligne')
            await page.wait_for_function("document.getElementById('pastille-etat').textContent === 'En ligne'")
            verifier(valeur(f"select en_ligne from public.positions where chauffeur_id = '{CHAUFFEUSE}'") == 't',
                     'passer en ligne : position et état enregistrés dans la base')
            await page.screenshot(path=f'{CAPTURES}/chauffeur-en-ligne.png', full_page=True)

            print('Demande acceptée et course complète')
            course = commander()
            verifier(valeur(f"select chauffeur_id from public.propositions where course_id = '{course['id']}' and statut = 'envoyee'") == CHAUFFEUSE,
                     'commande d\'un client : demande envoyée à la chauffeuse en ligne')
            await page.wait_for_selector('#demande:not([hidden])', timeout=15000)
            texte = await page.inner_text('#demande')
            verifier('10 Rue de Rivoli' in texte and '€' in texte, 'demande en plein écran : adresses et prix')
            verifier('+3361' not in texte and 'Claire' not in texte, 'demande : aucune coordonnée du client avant acceptation')
            await page.screenshot(path=f'{CAPTURES}/chauffeur-demande.png')
            await page.click('#accepter')
            await page.wait_for_url('**/chauffeur/course/?id=*')
            await page.wait_for_selector('#espace:not([hidden])')
            verifier(await page.inner_text('#etape-titre') == 'En route vers le client', 'course acceptée : en route vers le client')
            verifier(await page.get_attribute('#appeler-client', 'href') == 'tel:+33611111111', 'téléphone du client visible après acceptation')
            verifier('ll=48.8556,2.36' in (await page.get_attribute('#nav-waze', 'href')), 'navigation Waze vers le point de prise en charge')
            await page.screenshot(path=f'{CAPTURES}/chauffeur-course-en-route.png', full_page=True)
            await page.click('#action-etape')
            await page.wait_for_function("document.getElementById('etape-titre').textContent.startsWith('Arrivé')")
            verifier(not await page.is_hidden('#attente'), 'arrivé : compteur d\'attente affiché')
            await page.click('#action-etape')
            await page.wait_for_function("document.getElementById('etape-titre').textContent === 'Client à bord'")
            verifier('ll=48.8443,2.3743' in (await page.get_attribute('#nav-waze', 'href')), 'client à bord : navigation vers la destination')
            await page.click('#action-etape')
            await page.click('#dialogue-confirmer')
            await page.wait_for_function("document.getElementById('etape-titre').textContent === 'Course terminée'")
            await page.wait_for_selector('#confirmer-encaissement:not([hidden])')
            verifier('€' in await page.inner_text('#montant-encaisser'), 'fin de course : montant à encaisser affiché')
            await page.click('#confirmer-encaissement')
            await page.wait_for_selector('#encaisse:not([hidden])')
            verifier(valeur(f"select statut from public.paiements where course_id = '{course['id']}' and nature = 'course'") == 'encaisse',
                     'encaissement enregistré dans la base')
            await page.click('#etoiles .etoile:nth-child(5)')
            await page.click('#envoyer-note')
            await page.wait_for_selector('#bloc-note[hidden]', state='attached')
            verifier(valeur(f"select note from public.evaluations where course_id = '{course['id']}' and sens = 'chauffeur_vers_client'") == '5',
                     'note du client enregistrée (visible de l\'administration seulement)')
            await page.click('#feuille-de-route summary')
            feuille = await page.inner_text('#feuille')
            verifier('LOC RÉACTION S.A.S' in feuille and 'SIREN 100052570' in feuille and 'Claire' in feuille and course['numero'] in feuille,
                     'feuille de route : exploitant, client, réservation, prise en charge')
            await page.screenshot(path=f'{CAPTURES}/chauffeur-course-terminee.png', full_page=True)

            print('Délai dépassé')
            systeme("update public.parametres set delai_reponse_chauffeur_s = 10;")
            await page.goto(SITE + 'chauffeur/')
            await page.wait_for_selector('#espace:not([hidden])')
            verifier(await page.inner_text('#courses-jour') != '0', 'accueil : course du jour comptée')
            course2 = commander()
            await page.reload()
            await page.wait_for_selector('#demande:not([hidden])', timeout=12000)
            await page.wait_for_selector('#demande[hidden]', state='attached', timeout=16000)
            time.sleep(1)
            verifier(valeur(f"select statut from public.propositions where course_id = '{course2['id']}'") == 'expiree',
                     'délai dépassé : demande expirée, relance déclenchée par l\'application')
            verifier(valeur(f"select statut from public.courses where id = '{course2['id']}'") == 'a_attribuer',
                     'aucun autre chauffeur : course « à attribuer » pour l\'administration')
            annuler_par_admin(course2['id'])
            systeme("update public.parametres set delai_reponse_chauffeur_s = 30;")

            print('Refus')
            course3 = commander()
            await page.reload()
            await page.wait_for_selector('#demande:not([hidden])', timeout=12000)
            await page.click('#refuser')
            await page.wait_for_selector('#demande[hidden]', state='attached')
            time.sleep(1)
            verifier(valeur(f"select statut from public.propositions where course_id = '{course3['id']}'") == 'refusee',
                     'refus enregistré : la demande passe au chauffeur suivant')
            annuler_par_admin(course3['id'])

            print('Réservation prise')
            demain = valeur("select (now() + interval '1 day')::text")
            course4 = commander(p_type='planifiee', p_quand=demain)
            await page.reload()
            await page.wait_for_selector('#reservations .course-carte')
            await page.click('#reservations .course-carte button')
            await page.wait_for_selector('#mes-courses .course-carte')
            verifier(valeur(f"select chauffeur_id from public.courses where id = '{course4['id']}'") == CHAUFFEUSE,
                     'réservation prise : attribuée à la chauffeuse, visible dans « Mes courses »')
            await page.screenshot(path=f'{CAPTURES}/chauffeur-reservation-prise.png', full_page=True)
            annuler_par_admin(course4['id'])

            await onglets_chauffeur(ctx, page, course, course4)

            await page.click('#bascule-en-ligne')
            await page.wait_for_function("document.getElementById('pastille-etat').textContent === 'Hors ligne'")
            verifier(valeur(f"select en_ligne from public.positions where chauffeur_id = '{CHAUFFEUSE}'") == 'f', 'passer hors ligne')

            print('Déconnexion en ligne')
            await page.click('#bascule-en-ligne')
            await page.wait_for_function("document.getElementById('pastille-etat').textContent === 'En ligne'")
            await page.click('#onglets [data-onglet="compte"]')
            await page.wait_for_selector('#vue-compte:not([hidden]) #compte-deconnexion')
            await page.click('#compte-deconnexion')
            await page.wait_for_url('**/connexion/**')
            verifier(valeur(f"select en_ligne from public.positions where chauffeur_id = '{CHAUFFEUSE}'") == 'f',
                     'déconnexion : hors ligne d\'abord, puis page de connexion')
            await nav.close()
    finally:
        serveur.terminate()
    utiles = [c for c in console if 'WebSocket' not in c and 'realtime' not in c.lower() and 'ERR_FAILED' not in c]
    print('Erreurs de la console (hors temps réel, injoignable ici) :', utiles or 'aucune')

asyncio.run(main())
