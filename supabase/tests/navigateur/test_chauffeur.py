# Banc d'essai de l'espace chauffeur v2 : service, demande entrante, course
# complète, encaissement, note, feuille de route, délai dépassé, refus,
# réservation prise. Joué avec la chauffeuse des scénarios de test.
import asyncio, json, time
from playwright.async_api import async_playwright
from banc import (SITE, CAPTURES, CLIENT, CHAUFFEUSE, ADMIN, systeme, en_tant_que, appel_rpc,
                  session_injectee, routeur, serveur_local, verifier)

console = []


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

            await page.click('#bascule-en-ligne')
            await page.wait_for_function("document.getElementById('pastille-etat').textContent === 'Hors ligne'")
            verifier(valeur(f"select en_ligne from public.positions where chauffeur_id = '{CHAUFFEUSE}'") == 'f', 'passer hors ligne')
            await nav.close()
    finally:
        serveur.terminate()
    utiles = [c for c in console if 'WebSocket' not in c and 'realtime' not in c.lower() and 'ERR_FAILED' not in c]
    print('Erreurs de la console (hors temps réel, injoignable ici) :', utiles or 'aucune')

asyncio.run(main())
