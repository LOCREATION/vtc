# Banc d'essai de l'administration v2 : porte d'entrée (mot de passe, double
# authentification), tableau de bord, et chaque module. Joué dans Chromium sur
# la base locale « loc_v2 » (après ../lancer_tests_locaux.sh), avec le compte
# administrateur des scénarios de test. Le service de connexion de Supabase est
# imité (AuthSimulee) : le niveau « aal2 » du jeton n'est accordé qu'après le
# bon code à 6 chiffres, et la base refuse tout le reste.
import asyncio, json, re, sys, time
from playwright.async_api import async_playwright
from banc import (SITE, CAPTURES, ADMIN, CLIENT, CHAUFFEUR, CHAUFFEUSE, AuthSimulee, systeme, en_tant_que,
                  appel_rpc, session_injectee, routeur, serveur_local, verifier)

EMAIL_ADMIN = 'admin@exemple.test'
console = []


async def nouvelle_page(nav, auth=None, session=None, uid=ADMIN, mobile=True):
    """Contexte neuf : téléphone (390 px) ou ordinateur (1280 px)."""
    taille = {'width': 390, 'height': 844} if mobile else {'width': 1280, 'height': 860}
    ctx = await nav.new_context(viewport=taille, is_mobile=mobile, has_touch=mobile, locale='fr-FR',
                                timezone_id='Europe/Paris', service_workers='block')
    if session:
        await ctx.add_init_script(session)
    await ctx.route('**/*', routeur(uid, auth))
    page = await ctx.new_page()
    page.on('console', lambda m: console.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))
    return ctx, page


async def entrer(nav, mobile=True):
    """Administrateur déjà configuré, connecté par mot de passe puis code : page prête."""
    auth = AuthSimulee(ADMIN, EMAIL_ADMIN, mot_de_passe='Chaumontel2026', facteur_verifie=True)
    auth.aal, auth.methodes = 'aal2', ['password', 'totp']
    ctx, page = await nouvelle_page(nav, auth, auth.injection(), mobile=mobile)
    return ctx, page, auth


async def porte(nav):
    print('Porte d\'entrée')
    # 1. Sans session : connexion par mot de passe
    auth = AuthSimulee(ADMIN, EMAIL_ADMIN, mot_de_passe='Chaumontel2026', facteur_verifie=True)
    ctx, page = await nouvelle_page(nav, auth)
    await page.goto(SITE + 'admin/')
    await page.wait_for_selector('#porte-email')
    verifier(await page.is_hidden('#admin-cadre'), 'sans session : rien de l\'administration n\'est affiché')
    await page.fill('#porte-email', EMAIL_ADMIN)
    await page.fill('#porte-mdp', 'mauvais-mot-de-passe1')
    await page.click('text=Se connecter')
    await page.wait_for_selector('.porte .alerte:not([hidden])')
    verifier('incorrect' in await page.inner_text('.porte .alerte'), 'mauvais mot de passe : message exact, lien vers le code e-mail')
    verifier(await page.get_attribute('a[href*="connexion/?suite="]', 'href') == '/v2/connexion/?suite=admin%2F',
             'lien de connexion par code e-mail, retour à l\'administration')
    await page.fill('#porte-mdp', 'Chaumontel2026')
    await page.click('text=Se connecter')
    await page.wait_for_selector('#porte-code')
    verifier('Double authentification' in await page.inner_text('.porte h1'), 'bon mot de passe : code de l\'application demandé')
    await page.fill('#porte-code', '000000')
    await page.wait_for_selector('.porte .alerte:not([hidden])')
    verifier('Code incorrect' in await page.inner_text('.porte .alerte'), 'mauvais code : refusé, message exact')
    verifier(auth.aal == 'aal1', 'mauvais code : la session reste au niveau aal1')
    await page.fill('#porte-code', '123456')
    await page.wait_for_selector('#admin-cadre:not([hidden])')
    verifier(auth.aal == 'aal2', 'bon code (validé dès le 6e chiffre) : session aal2, administration ouverte')
    await page.wait_for_selector('#chiffres .chiffre-cle')
    await page.screenshot(path=f'{CAPTURES}/admin-tableau-telephone.png', full_page=True)
    await ctx.close()

    # 2. Compte client : accès refusé
    ctx, page = await nouvelle_page(nav, None, session_injectee(CLIENT, 'client1@exemple.test'), uid=CLIENT)
    await page.goto(SITE + 'admin/')
    await page.wait_for_selector('text=Accès réservé')
    verifier(await page.is_hidden('#admin-cadre'), 'compte client : accès réservé, administration fermée')
    await ctx.close()

    # 3. Première fois (connecté par code e-mail) : mot de passe puis application
    auth = AuthSimulee(ADMIN, EMAIL_ADMIN)
    ctx, page = await nouvelle_page(nav, auth, auth.injection())
    await page.goto(SITE + 'admin/dispatch/')
    await page.wait_for_selector('#porte-mdp1')
    verifier('1. Mot de passe' in await page.inner_text('.porte-etapes'), 'première fois : étape 1, mot de passe')
    await page.fill('#porte-mdp1', 'court1')
    await page.fill('#porte-mdp2', 'court1')
    await page.click('text=Enregistrer le mot de passe')
    verifier('au moins 10 caractères' in await page.inner_text('.porte .alerte'), 'mot de passe trop court refusé')
    await page.fill('#porte-mdp1', 'Chaumontel2026')
    await page.fill('#porte-mdp2', 'Chaumontel2027')
    await page.click('text=Enregistrer le mot de passe')
    verifier('pas identiques' in await page.inner_text('.porte .alerte'), 'confirmation différente refusée')
    await page.fill('#porte-mdp2', 'Chaumontel2026')
    await page.click('text=Enregistrer le mot de passe')
    await page.wait_for_selector('img.qr')
    verifier(auth.mot_de_passe == 'Chaumontel2026', 'mot de passe enregistré dans le service de connexion')
    src = await page.get_attribute('img.qr', 'src')
    verifier(src.startswith('data:image/svg+xml;charset=utf-8,') and '%23' in src and '#' not in src,
             'QR code : dessin encodé proprement (aucun « # » qui couperait l\'image)')
    verifier(await page.evaluate("document.querySelector('img.qr').naturalWidth > 0"), 'QR code affiché')
    verifier(await page.inner_text('.cle-secrete') == 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP', 'clé à recopier, par groupes de 4')
    verifier((await page.get_attribute('a[href^="otpauth://"]', 'href')).startswith('otpauth://totp/'),
             'bouton « Ajouter à l\'application » pour le même téléphone')
    await page.screenshot(path=f'{CAPTURES}/admin-double-authentification.png', full_page=True)
    await page.fill('#porte-code', '999999')
    await page.click('text=Activer la double authentification')
    await page.wait_for_selector('.porte .alerte:not([hidden])')
    verifier('Code incorrect' in await page.inner_text('.porte .alerte'), 'activation : mauvais code refusé')
    await page.fill('#porte-code', '123456')
    await page.click('text=Activer la double authentification')
    await page.wait_for_selector('#admin-cadre:not([hidden])')
    verifier([f['status'] for f in auth.facteurs] == ['verified'], 'application activée : un seul facteur, vérifié')
    verifier(await page.inner_text('.admin-titre') == 'Dispatch', 'retour à la page demandée (dispatch)')
    await ctx.close()

    # 4. Configuration interrompue puis reprise : l'ancien essai inachevé est retiré
    auth = AuthSimulee(ADMIN, EMAIL_ADMIN, mot_de_passe='Chaumontel2026')
    auth.facteurs.append(auth._facteur('Administration LOC RÉACTION', 'unverified'))
    auth.methodes = ['password']
    ctx, page = await nouvelle_page(nav, auth, auth.injection())
    await page.goto(SITE + 'admin/')
    await page.wait_for_selector('img.qr')
    verifier(len(auth.facteurs) == 1 and ('DELETE', '/factors/f0000000-0000-4000-8000-000000000001') in auth.requetes,
             'connecté par mot de passe : étape 1 sautée, configuration inachevée remplacée')
    await ctx.close()

    # 5. Réglage « changement de mot de passe sécurisé » : code de confirmation par e-mail
    auth = AuthSimulee(ADMIN, EMAIL_ADMIN, reauthentification=True)
    ctx, page = await nouvelle_page(nav, auth, auth.injection())
    await page.goto(SITE + 'admin/')
    await page.wait_for_selector('#porte-mdp1')
    await page.fill('#porte-mdp1', 'Chaumontel2026')
    await page.fill('#porte-mdp2', 'Chaumontel2026')
    await page.click('text=Enregistrer le mot de passe')
    await page.wait_for_selector('#porte-nonce:visible')
    verifier(auth.nonce_envoye and auth.mot_de_passe is None, 'confirmation exigée : code envoyé par e-mail, rien changé encore')
    await page.fill('#porte-nonce', '424242')
    await page.click('text=Enregistrer le mot de passe')
    await page.wait_for_selector('img.qr')
    verifier(auth.mot_de_passe == 'Chaumontel2026', 'code de confirmation saisi : mot de passe enregistré')
    await ctx.close()

    # 6. La base elle-même refuse un administrateur sans double authentification
    ok, message = en_tant_que(ADMIN, 'select public.admin_dispatch()', aal='aal1')
    verifier(not ok and 'Réservé' in message, 'base : fonctions d\'administration refusées en aal1')


async def tableau_de_bord(nav):
    print('Tableau de bord')
    ctx, page, _ = await entrer(nav, mobile=False)
    await page.goto(SITE + 'admin/')
    await page.wait_for_selector('#chiffres .chiffre-cle')
    tuiles = await page.locator('#chiffres .chiffre-cle').all_inner_texts()
    verifier(len(tuiles) == 4 and tuiles[0].startswith('Aujourd\'hui') and '€' in tuiles[0], 'quatre chiffres clés, chiffre du jour en euros')
    attendu = json.loads(appel_rpc('admin_tableau_de_bord', {}, ADMIN)[1])
    verifier(str(attendu['chauffeurs']['valides']) in tuiles[3], 'chauffeurs validés : même nombre que la base')
    verifier(await page.locator('#statuts .statut').count() == 6, 'six statuts de course, menant au dispatch')
    alertes = await page.inner_text('#alertes')
    verifier('registre VTC' in alertes, 'alerte : n° d\'inscription au registre VTC manquant')
    verifier(await page.locator('#alertes a[href="/v2/admin/parametres/"]').count() >= 1, 'alerte : lien vers le module à ouvrir')
    verifier(await page.locator('.graphique .barre').count() == 14, 'graphique : 14 jours')
    await page.hover('.graphique .barre:last-of-type')
    verifier('€' in await page.inner_text('.bulle-graphique'), 'graphique : infobulle au survol')
    await page.click('#voir-tableau')
    verifier(await page.locator('#tableau-serie tbody tr').count() == 14, 'graphique : les mêmes chiffres en tableau')
    verifier(await page.locator('.admin-lien').count() == 8, 'menu : huit modules')
    verifier(await page.get_attribute('.admin-lien[data-module="tableau"]', 'aria-current') == 'page', 'menu : module actif signalé')
    await page.screenshot(path=f'{CAPTURES}/admin-tableau-ordinateur.png', full_page=True)
    await ctx.close()

    # Téléphone : menu en tiroir
    ctx, page, _ = await entrer(nav, mobile=True)
    await page.goto(SITE + 'admin/')
    await page.wait_for_selector('#chiffres .chiffre-cle')
    verifier(not await page.locator('#admin-menu').is_visible() or
             await page.evaluate("getComputedStyle(document.getElementById('admin-menu')).transform") != 'none',
             'téléphone : menu replié au départ')
    hauteurs = await page.evaluate("[...document.querySelectorAll('#statuts .statut a')].map((a) => Math.round(a.getBoundingClientRect().height))")
    verifier(len(hauteurs) == 6 and hauteurs[0] == hauteurs[1] and hauteurs[2] == hauteurs[3] and hauteurs[4] == hauteurs[5],
             f'téléphone : cases des statuts de même hauteur sur chaque ligne ({hauteurs})')
    await page.screenshot(path=f'{CAPTURES}/admin-tableau-telephone-statuts.png', full_page=True)
    await page.click('#admin-ouvrir-menu')
    await page.wait_for_timeout(300)
    verifier(await page.get_attribute('#admin-menu', 'data-ouvert') == 'true', 'téléphone : bouton « Menu » ouvre le tiroir')
    await page.screenshot(path=f'{CAPTURES}/admin-menu-telephone.png')
    await page.keyboard.press('Escape')
    verifier(await page.get_attribute('#admin-menu', 'data-ouvert') == 'false', 'téléphone : Échap referme le tiroir')
    await ctx.close()


def commander(client, **autres):
    corps = {'p_categorie': 'berline_hybride', 'p_depart_adresse': '10 Rue de Rivoli 75004 Paris',
             'p_depart_lat': 48.8556, 'p_depart_lng': 2.36, 'p_arrivee_adresse': 'Gare de Lyon 75012 Paris',
             'p_arrivee_lat': 48.8443, 'p_arrivee_lng': 2.3743, **autres}
    ok, sortie = appel_rpc('commander_course', corps, client)
    assert ok, sortie
    return json.loads(sortie)


def valeur(requete):
    return systeme(requete)


def demain(heure_paris):
    return systeme(f"select to_json(((((now() at time zone 'Europe/Paris')::date + 1) + time '{heure_paris}') at time zone 'Europe/Paris'))#>>'{{}}'")


async def dispatch(nav):
    print('Dispatch')
    # État connu : aucune course active, seule la chauffeuse en ligne près de Paris
    systeme("""update public.courses set statut = 'annulee', annulee_par = 'admin', annulee_le = now()
                 where statut not in ('terminee', 'annulee');
               update public.propositions set statut = 'annulee', repondue_le = now() where statut = 'envoyee';
               update public.positions set en_ligne = false;""")
    systeme(f"""update public.positions set en_ligne = true, latitude = 48.8530, longitude = 2.3500 where chauffeur_id = '{CHAUFFEUSE}';
               update public.chauffeurs set statut = 'valide' where id in ('{CHAUFFEUR}', '{CHAUFFEUSE}');""")
    filleul = 'c0000000-0000-4000-8000-000000000004'
    karim = 'c0000000-0000-4000-8000-000000000003'
    a = commander(CLIENT)                                         # demande envoyée à la chauffeuse
    b = commander(filleul, p_depart_adresse='Gare du Nord 75010 Paris', p_depart_lat=48.8809, p_depart_lng=2.3553)
    c = commander(karim, p_type='planifiee', p_quand=demain('11:00'))
    verifier(valeur(f"select statut from public.courses where id = '{a['id']}'") == 'recherche'
             and valeur(f"select statut from public.courses where id = '{b['id']}'") == 'a_attribuer',
             'préparation : une course en recherche, une à attribuer, une réservation')

    ctx, page, _ = await entrer(nav, mobile=False)
    await page.goto(SITE + 'admin/dispatch/')
    await page.wait_for_selector(f'.course-admin[data-id="{b["id"]}"]')
    verifier(b['numero'] in await page.inner_text('#liste-a-attribuer'), 'à attribuer : la course sans chauffeur')
    recherche = await page.inner_text('#liste-recherche')
    verifier(a['numero'] in recherche and 'Demande chez Nadia Moreau' in recherche, 'recherche : demande en attente chez la chauffeuse')
    await page.wait_for_function("document.querySelector('.minuteur') && /s pour répondre/.test(document.querySelector('.minuteur').textContent)")
    verifier(True, 'recherche : compte à rebours de la demande')
    verifier('Demain' in await page.inner_text('#liste-a-venir') and c['numero'] in await page.inner_text('#liste-a-venir'),
             'réservations : regroupées par jour (« Demain »)')
    verifier(await page.locator('.admin-lien[data-module="dispatch"] .admin-pastille-compte').inner_text() == '1',
             'menu : pastille du nombre de courses à attribuer')
    await page.screenshot(path=f'{CAPTURES}/admin-dispatch-ordinateur.png', full_page=True)

    # Attribution à la main de B à Paul (hors ligne)
    carte_b = page.locator(f'.course-admin[data-id="{b["id"]}"]')
    await carte_b.get_by_role('button', name='Attribuer').click()
    await page.wait_for_selector('.liste-choix .choix')
    choix = await page.inner_text('.liste-choix')
    verifier('Nadia Moreau' in choix and 'Paul Bernard' in choix and 'Hors ligne' in choix, 'fenêtre d\'attribution : chauffeurs, état en ligne')
    await page.screenshot(path=f'{CAPTURES}/admin-attribution.png')
    await page.get_by_role('button', name=f'Attribuer {b["numero"]} à Paul Bernard').click()
    await page.wait_for_function(f"document.getElementById('liste-en-cours').textContent.includes('{b['numero']}')")
    verifier(valeur(f"select statut || ' ' || chauffeur_id || ' ' || attribution from public.courses where id = '{b['id']}'")
             == f'acceptee {CHAUFFEUR} manuelle', 'attribution : course acceptée par Paul, « à la main »')

    # Retrait : personne de libre → de nouveau « à attribuer »
    await page.locator(f'.course-admin[data-id="{b["id"]}"]').get_by_role('button', name='Retirer le chauffeur').click()
    await page.wait_for_selector('dialog.fenetre[open]')
    await page.fill('#fenetre-motif', 'Essai de retrait')
    await page.locator('dialog.fenetre').get_by_role('button', name='Retirer le chauffeur').click()
    await page.wait_for_function(f"document.getElementById('liste-a-attribuer').textContent.includes('{b['numero']}')")
    verifier(valeur(f"select coalesce(chauffeur_id::text, 'aucun') || ' ' || statut from public.courses where id = '{b['id']}'") == 'aucun a_attribuer',
             'retrait du chauffeur : la course revient « à attribuer »')
    await page.locator(f'.course-admin[data-id="{b["id"]}"]').get_by_role('button', name='Relancer la recherche').click()
    await page.wait_for_selector('.message-erreur')
    verifier('Aucun chauffeur en ligne' in await page.inner_text('.message-erreur'), 'relance sans chauffeur libre : message exact')

    # Réservation : attribuée à Paul, puis confiée à Nadia (Paul prévenu)
    await page.locator(f'.course-admin[data-id="{c["id"]}"]').get_by_role('button', name='Attribuer').click()
    await page.get_by_role('button', name=f'Attribuer {c["numero"]} à Paul Bernard').click()
    await page.wait_for_function(f"document.querySelector('.course-admin[data-id=\"{c['id']}\"]').textContent.includes('Paul Bernard')")
    await page.locator(f'.course-admin[data-id="{c["id"]}"]').get_by_role('button', name='Changer de chauffeur').click()
    await page.get_by_role('button', name=f'Attribuer {c["numero"]} à Nadia Moreau').click()
    await page.wait_for_function(f"document.querySelector('.course-admin[data-id=\"{c['id']}\"]').textContent.includes('Nadia Moreau')")
    verifier(valeur(f"select statut || ' ' || chauffeur_id from public.courses where id = '{c['id']}'") == f'planifiee {CHAUFFEUSE}',
             'changement de chauffeur : réservation confiée à Nadia, toujours planifiée')
    verifier(valeur(f"select count(*) from public.notifications where destinataire_id = '{CHAUFFEUR}' and titre = 'Course retirée' and message like '%{c['numero']}%'") == '1',
             'changement de chauffeur : Paul prévenu')

    # Annulation : motif obligatoire
    await page.locator(f'.course-admin[data-id="{a["id"]}"]').get_by_role('button', name='Annuler la course').click()
    await page.wait_for_selector('dialog.fenetre[open]')
    await page.locator('dialog.fenetre').get_by_role('button', name='Annuler la course').click()
    verifier('Indiquez le motif' in await page.inner_text('dialog.fenetre .alerte'), 'annulation : motif exigé')
    await page.fill('#fenetre-motif', 'Client injoignable')
    await page.locator('dialog.fenetre').get_by_role('button', name='Annuler la course').click()
    await page.wait_for_function(f"!document.getElementById('liste-recherche').textContent.includes('{a['numero']}')")
    verifier(valeur(f"select statut || ' ' || annulee_par || ' ' || motif_annulation from public.courses where id = '{a['id']}'")
             == 'annulee admin Client injoignable', 'annulation par l\'administration, motif enregistré')
    await ctx.close()

    # Téléphone
    ctx, page, _ = await entrer(nav, mobile=True)
    await page.goto(SITE + 'admin/dispatch/')
    await page.wait_for_selector(f'.course-admin[data-id="{b["id"]}"]')
    largeur = await page.evaluate('document.documentElement.scrollWidth')
    verifier(largeur <= 390, f'téléphone : aucune barre de défilement horizontale ({largeur} px)')
    await page.screenshot(path=f'{CAPTURES}/admin-dispatch-telephone.png', full_page=True)
    await ctx.close()
    systeme(f"update public.positions set en_ligne = false where chauffeur_id = '{CHAUFFEUSE}'")


async def courses(nav):
    print('Courses')
    ctx, page, _ = await entrer(nav, mobile=False)
    await page.goto(SITE + 'admin/courses/')
    await page.wait_for_selector('#resultats tbody tr')
    total = int(valeur('select count(*) from public.courses'))
    verifier(await page.inner_text('#nb-resultats') == f'{total} courses', f'liste : toutes les courses comptées ({total})')
    annulees = valeur("select count(*) from public.courses where statut = 'annulee'")
    await page.get_by_role('tab', name='Annulées').click()
    await page.wait_for_function(f"document.getElementById('nb-resultats').textContent === '{annulees} courses'")
    verifier('statut=annulees' in page.url, 'onglet « Annulées » : filtre appliqué et gardé dans l\'adresse')
    await page.get_by_role('tab', name='Toutes').click()
    await page.fill('#filtre-texte', 'claire durand')
    await page.click('#filtres button[type=submit]')
    attendu = valeur(f"select count(*) from public.courses where client_id = '{CLIENT}'")
    await page.wait_for_function(f"document.getElementById('nb-resultats').textContent === '{attendu} course{'s' if int(attendu) > 1 else ''}'")
    verifier(True, 'recherche libre sur le client, sans majuscules')
    async with page.expect_download() as telechargement:
        await page.get_by_role('button', name='Exporter (CSV)').click()
    fichier = await (await telechargement.value).path()
    contenu = open(fichier, encoding='utf-8-sig').read()
    verifier(contenu.startswith('Numéro;Statut;Type;') and contenu.count('\n') == int(attendu), 'export CSV : en-têtes, une ligne par course filtrée')

    # Fiche : course terminée de la veille des essais SQL (paiement à encaisser)
    id_course = valeur("""select c.id from public.courses c join public.paiements p on p.course_id = c.id
                          where c.statut = 'terminee' and p.statut = 'a_encaisser' and p.nature = 'course'
                            and p.mode <> 'facture_mensuelle' order by c.terminee_le desc limit 1""")
    await page.goto(SITE + f'admin/courses/?id={id_course}')
    await page.wait_for_selector('#titre-etapes')
    verifier('Commande du client' in await page.inner_text('.chronologie'), 'fiche : étapes horodatées')
    verifier('Prix annoncé' in await page.inner_text('#vue-fiche'), 'fiche : détail du prix')
    await page.get_by_role('button', name='Confirmer l\'encaissement').first.click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Confirmer').click()
    await page.wait_for_selector('text=Encaissé')
    verifier(valeur(f"select statut from public.paiements where course_id = '{id_course}' and nature = 'course'") == 'encaisse',
             'fiche : encaissement confirmé')
    await page.get_by_role('button', name='Rembourser').first.click()
    await page.wait_for_selector('dialog.fenetre[open]')
    champ_montant = page.locator('dialog.fenetre input[name=montant]')
    await champ_montant.fill('2')
    await page.locator('dialog.fenetre textarea[name=motif]').fill('Geste pour le retard')
    await page.locator('dialog.fenetre').get_by_role('button', name='Rembourser').click()
    await page.wait_for_selector('text=Geste pour le retard')
    verifier(valeur(f"select sum(r.montant) from public.remboursements r join public.paiements p on p.id = r.paiement_id where p.course_id = '{id_course}'") == '2.00',
             'fiche : remboursement partiel enregistré')
    await page.screenshot(path=f'{CAPTURES}/admin-fiche-course.png', full_page=True)

    # Réservation : modification de l'heure (heure de Paris) et du vol, puis étapes
    id_resa = valeur(f"select id from public.courses where statut = 'planifiee' and chauffeur_id = '{CHAUFFEUSE}' order by cree_le desc limit 1")
    await page.goto(SITE + f'admin/courses/?id={id_resa}')
    await page.wait_for_selector('#titre-etapes')
    await page.get_by_role('button', name='Modifier').click()
    jour = valeur("select ((now() at time zone 'Europe/Paris')::date + 1)::text")
    await page.locator('dialog.fenetre input[name=prise_en_charge]').fill(f'{jour}T18:30')
    await page.locator('dialog.fenetre input[name=numero_vol]').fill('af1234')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    verifier(valeur(f"select to_char(prise_en_charge_le at time zone 'Europe/Paris', 'YYYY-MM-DD HH24:MI') || ' ' || numero_vol from public.courses where id = '{id_resa}'")
             == f'{jour} 18:30 AF1234', 'modification : 18 h 30 à Paris (quel que soit le fuseau de l\'appareil), vol en majuscules')
    verifier(valeur(f"select count(*) from prive.journal where table_cible = 'courses' and ligne_id = '{id_resa}' and action = 'UPDATE'") == '1',
             'modification inscrite au journal')
    for libelle, statut in [('Chauffeur en route', 'acceptee'), ('Chauffeur arrivé', 'arrivee'), ('Client à bord', 'en_cours'), ('Terminer la course', 'terminee')]:
        await page.get_by_role('button', name=libelle).click()
        await page.locator('dialog.fenetre').get_by_role('button', name=libelle).click()
        await page.wait_for_function("!document.querySelector('dialog.fenetre')")
        await page.wait_for_selector('.message-succes')
        await page.wait_for_timeout(300)
        verifier(valeur(f"select statut from public.courses where id = '{id_resa}'") == statut, f'étape à la place du chauffeur : {libelle}')
    verifier(valeur(f"select count(*) from public.factures where course_id = '{id_resa}'") == '1', 'course terminée par l\'administration : facture émise')
    await ctx.close()


def nouveau_compte(prenom, nom, telephone):
    """Compte neuf (inscription simulée), avec prénom, nom et téléphone."""
    marque = str(int(time.time() * 1000))[-9:]
    uid = systeme(f"""set role supabase_auth_admin;
insert into auth.users (email, raw_user_meta_data)
values ('candidat{marque}@exemple.test', '{{"prenom":"{prenom}","nom":"{nom}","telephone":"{telephone}"}}')
returning id;""").splitlines()[-1]
    return uid, f'candidat{marque}@exemple.test'


async def chauffeurs(nav):
    print('Chauffeurs')
    uid, email = nouveau_compte('Sami', 'Diallo', '+33677889900')
    ok, sortie = appel_rpc('deposer_candidature', {'p_ville': 'Sarcelles', 'p_experience': 'Deux ans de VTC en Île-de-France',
                                                   'p_a_carte_vtc': True, 'p_carte_vtc_numero': 'VTC-777'}, uid)
    assert ok, sortie
    ok, sortie = en_tant_que(uid, f"insert into public.documents (chauffeur_id, type, fichier_chemin) values ('{uid}', 'carte_vtc', '{uid}/carte.pdf'), ('{uid}', 'permis', '{uid}/permis.pdf')")
    assert ok, sortie

    ctx, page, _ = await entrer(nav, mobile=False)
    await page.goto(SITE + 'admin/chauffeurs/?onglet=candidatures')
    fiche = page.locator('section.fiche-chauffeur', has_text='Sami Diallo')
    await fiche.wait_for()
    texte = await fiche.inner_text()
    verifier('Sarcelles' in texte and 'Deux ans de VTC' in texte and 'Carte VTC' in texte, 'candidature : ville, expérience, pièces déposées')
    verifier(await page.locator('#onglets .onglet', has_text='Documents').locator('.compte').inner_text() != '', 'onglet Documents : compteur des pièces à vérifier')

    # Pièce validée avec la date lue sur la pièce
    await fiche.locator('.documents li', has_text='Carte VTC').get_by_role('button', name='Valider').click()
    await page.wait_for_selector('dialog.fenetre[open]')
    fin_validite = valeur("select (current_date + 400)::text")
    await page.locator('dialog.fenetre input[name=expire_le]').fill(fin_validite)
    await page.locator('dialog.fenetre').get_by_role('button', name='Valider la pièce').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    verifier(valeur(f"select carte_vtc_expiration::text from public.chauffeurs where id = '{uid}'") == fin_validite,
             'pièce validée : date d\'expiration reportée sur la fiche')

    # Pièce refusée, motif obligatoire
    fiche = page.locator('section.fiche-chauffeur', has_text='Sami Diallo')
    await fiche.locator('.documents li', has_text='Permis').get_by_role('button', name='Refuser').click()
    await page.fill('#fenetre-motif', 'Photo illisible')
    await page.locator('dialog.fenetre').get_by_role('button', name='Refuser la pièce').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    verifier(valeur(f"select statut || ' ' || commentaire from public.documents where chauffeur_id = '{uid}' and type = 'permis'") == 'refuse Photo illisible',
             'pièce refusée avec son motif')

    # Validation de la candidature, véhicule affecté
    fiche = page.locator('section.fiche-chauffeur', has_text='Sami Diallo')
    await fiche.get_by_role('button', name='Valider la candidature').click()
    await page.wait_for_selector('dialog.fenetre[open]')
    id_vehicule = valeur("select id from public.vehicules where immatriculation = 'GA-123-BC'")
    await page.locator('dialog.fenetre select[name=vehicule]').select_option(id_vehicule)
    await page.locator('dialog.fenetre').get_by_role('button', name='Valider').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    verifier(valeur(f"select p.role || ' ' || c.statut || ' ' || c.vehicule_id from public.profils p join public.chauffeurs c on c.id = p.id where p.id = '{uid}'")
             == f'chauffeur valide {id_vehicule}', 'candidature validée : rôle chauffeur, véhicule affecté')
    await page.wait_for_selector('section.fiche-chauffeur >> text=Sami Diallo')
    verifier('?onglet=' not in page.url or await page.get_attribute('#onglets .onglet[aria-selected="true"]', 'role') == 'tab',
             'après validation : onglet « Chauffeurs »')

    # Suspension (motif), puis réactivation
    fiche = page.locator('section.fiche-chauffeur', has_text='Sami Diallo')
    await fiche.get_by_role('button', name='Suspendre').click()
    await page.fill('#fenetre-motif', 'Contrôle de la carte VTC')
    await page.locator('dialog.fenetre').get_by_role('button', name='Suspendre').click()
    await page.wait_for_selector('section.fiche-chauffeur:has-text("Sami Diallo") >> text=Suspendu')
    verifier(valeur(f"select statut from public.chauffeurs where id = '{uid}'") == 'suspendu', 'chauffeur suspendu')
    await page.locator('section.fiche-chauffeur', has_text='Sami Diallo').get_by_role('button', name='Réactiver').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Réactiver').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    verifier(valeur(f"select statut from public.chauffeurs where id = '{uid}'") == 'valide', 'chauffeur réactivé')

    # Modification de la fiche
    await page.locator('section.fiche-chauffeur', has_text='Sami Diallo').get_by_role('button', name='Modifier la fiche').click()
    await page.locator('dialog.fenetre input[name=permis_numero]').fill('PERMIS-4242')
    await page.locator('dialog.fenetre input[name=chauffeuse]').check()
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    verifier(valeur(f"select permis_numero || ' ' || chauffeuse from public.chauffeurs where id = '{uid}'") == 'PERMIS-4242 true',
             'fiche modifiée (n° de permis, option chauffeuse)')
    await page.screenshot(path=f'{CAPTURES}/admin-chauffeurs.png', full_page=True)

    # Activité
    await page.get_by_role('tab', name='Activité').click()
    await page.wait_for_selector('#contenu tbody tr')
    verifier('Paul Bernard' in await page.inner_text('#contenu'), 'activité : tableau par chauffeur')

    # Enregistrer un chauffeur : recherche de compte
    await page.click('#enregistrer-chauffeur')
    await page.fill('#recherche-compte', 'client2')
    await page.locator('dialog.fenetre').get_by_role('button', name='Chercher').click()
    await page.wait_for_selector('dialog.fenetre .choix')
    verifier('Hugo Petit' in await page.inner_text('dialog.fenetre .liste-choix'), 'enregistrer un chauffeur : recherche du compte')
    await ctx.close()
    systeme(f"update public.chauffeurs set statut = 'refuse' where id = '{uid}'; update public.profils set role = 'client' where id = '{uid}';")


async def flotte(nav):
    print('Flotte')
    systeme("delete from public.entretiens where vehicule_id in (select id from public.vehicules where immatriculation = 'GC-789-DE');"
            "delete from public.documents where vehicule_id in (select id from public.vehicules where immatriculation = 'GC-789-DE');"
            "delete from public.vehicules where immatriculation = 'GC-789-DE';")
    ctx, page, _ = await entrer(nav, mobile=False)
    await page.goto(SITE + 'admin/flotte/')
    await page.wait_for_selector('.fiche-vehicule')
    await page.click('#ajouter-vehicule')
    await page.locator('dialog.fenetre input[name=immatriculation]').fill('gc 789')
    await page.locator('dialog.fenetre input[name=marque]').fill('Toyota')
    await page.locator('dialog.fenetre input[name=modele]').fill('Corolla Touring Sports')
    await page.locator('dialog.fenetre').get_by_role('button', name='Ajouter').click()
    verifier('sans espace' in await page.inner_text('dialog.fenetre'), 'immatriculation mal écrite : refusée sous le champ')
    await page.locator('dialog.fenetre input[name=immatriculation]').fill('GA-123-BC')
    await page.locator('dialog.fenetre').get_by_role('button', name='Ajouter').click()
    await page.wait_for_selector('dialog.fenetre .alerte:not([hidden])')
    verifier('existe déjà' in await page.inner_text('dialog.fenetre .alerte'), 'immatriculation en double : message clair')
    await page.locator('dialog.fenetre input[name=immatriculation]').fill('GC-789-DE')
    await page.locator('dialog.fenetre input[name=couleur]').fill('Noir')
    await page.locator('dialog.fenetre input[name=kilometrage]').fill('1000')
    await page.locator('dialog.fenetre').get_by_role('button', name='Ajouter').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_selector('.fiche-vehicule >> text=GC-789-DE')
    verifier(valeur("select marque || ' ' || modele || ' ' || couleur || ' ' || kilometrage from public.vehicules where immatriculation = 'GC-789-DE'")
             == 'Toyota Corolla Touring Sports Noir 1000', 'véhicule ajouté')
    fiche = page.locator('.fiche-vehicule', has_text='GC-789-DE')
    verifier('date non renseignée' in await fiche.inner_text(), 'véhicule neuf : date d\'assurance « non renseignée » signalée')

    # Entretien : le kilométrage suit
    await fiche.locator('summary', has_text='Entretiens').click()
    await fiche.get_by_role('button', name='Ajouter un entretien').click()
    await page.locator('dialog.fenetre input[name=kilometrage]').fill('1500')
    await page.locator('dialog.fenetre input[name=montant]').fill('89,90')
    await page.locator('dialog.fenetre textarea[name=description]').fill('Révision des 1 500 km')
    await page.locator('dialog.fenetre').get_by_role('button', name='Ajouter').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    verifier(valeur("select v.kilometrage || ' ' || e.montant from public.vehicules v join public.entretiens e on e.vehicule_id = v.id where v.immatriculation = 'GC-789-DE'")
             == '1500 89.90', 'entretien enregistré (virgule acceptée), kilométrage du véhicule mis à jour')

    # Pièce du véhicule : déposée puis validée, date reportée
    fiche = page.locator('.fiche-vehicule', has_text='GC-789-DE')
    await fiche.locator('summary', has_text='Pièces').click()
    await fiche.get_by_role('button', name='Ajouter une pièce').click()
    await page.set_input_files('#piece-fichier', files=[{'name': 'assurance.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 essai'}])
    fin = valeur("select (current_date + 300)::text")
    await page.locator('dialog.fenetre input[name=numero]').fill('POL-2026-88')
    await page.locator('dialog.fenetre input[name=expire_le]').fill(fin)
    await page.locator('dialog.fenetre').get_by_role('button', name='Ajouter la pièce').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    from banc import FICHIERS_DEPOSES
    verifier(any(f.startswith('documents/vehicules/') and f.endswith('.pdf') for f in FICHIERS_DEPOSES), 'pièce déposée dans le dossier privé des véhicules')
    verifier(valeur("select v.assurance_expiration::text || ' ' || d.statut from public.vehicules v join public.documents d on d.vehicule_id = v.id where v.immatriculation = 'GC-789-DE'")
             == f'{fin} valide', 'pièce validée aussitôt : fin d\'assurance reportée sur le véhicule')

    # Désactivation
    await page.locator('.fiche-vehicule', has_text='GC-789-DE').get_by_role('button', name='Désactiver').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Désactiver').click()
    await page.wait_for_selector('.fiche-vehicule:has-text("GC-789-DE") >> text=Désactivé')
    verifier(valeur("select actif from public.vehicules where immatriculation = 'GC-789-DE'") == 'f', 'véhicule désactivé')
    await page.screenshot(path=f'{CAPTURES}/admin-flotte.png', full_page=True)
    await ctx.close()


async def tarifs(nav):
    print('Tarifs et zones')
    sauvegarde = valeur("select json_build_object('t', (select json_agg(t) from public.tarifs t), 'm', (select json_agg(m) from public.majorations m), 'p', (select row_to_json(p) from public.parametres p))")
    ctx, page, _ = await entrer(nav, mobile=False)
    await page.goto(SITE + 'admin/tarifs/')
    await page.wait_for_selector('.resume-tarif')
    verifier('En vigueur' in await page.inner_text('#contenu'), 'tarif en vigueur repéré')
    await page.get_by_role('button', name='Nouveau tarif à partir d\'une date').click()
    await page.wait_for_selector('dialog.fenetre[open]')
    verifier(await page.locator('dialog.fenetre input[name=prix_km]').input_value() == '1,7', 'nouveau tarif : prérempli avec le tarif en vigueur (virgule française)')
    await page.locator('dialog.fenetre input[name=prix_heure_mad]').fill('45')
    await page.locator('dialog.fenetre').get_by_role('button', name='Créer le tarif').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    verifier(valeur("select prix_heure_mad || ' ' || (valide_du = current_date + 1) from public.tarifs order by valide_du desc limit 1") == '45.00 true',
             'nouveau tarif créé à partir de demain (mise à disposition 45 €/h)')
    verifier('À partir du' in await page.inner_text('#contenu'), 'tarif à venir signalé')

    # Lieux : ajout d'une ville et d'un forfait
    await page.get_by_role('tab', name='Lieux et forfaits').click()
    await page.wait_for_selector('.leaflet-container')
    await page.get_by_role('button', name='Ajouter un lieu').click()
    await page.locator('dialog.fenetre input[name=nom]').fill('Paris centre')
    await page.locator('dialog.fenetre select[name=type]').select_option('ville')
    await page.locator('dialog.fenetre input[name=latitude]').fill('48.8566')
    await page.locator('dialog.fenetre input[name=longitude]').fill('2.3522')
    await page.locator('dialog.fenetre input[name=rayon_km]').fill('5')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    verifier(valeur("select code || ' ' || rayon_km from public.zones where nom = 'Paris centre'") == 'ville_paris_centre 5.00', 'lieu ajouté, code créé à partir du nom')
    await page.get_by_role('button', name='Ajouter un forfait').click()
    await page.locator('dialog.fenetre select[name=zone_a_id]').select_option(label='Paris centre (Ville)')
    await page.locator('dialog.fenetre select[name=zone_b_id]').select_option(index=1)
    await page.locator('dialog.fenetre input[name=prix]').fill('55')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    verifier(valeur("select count(*) from public.forfaits f join public.zones z on z.id = f.zone_a_id where z.nom = 'Paris centre' and f.prix = 55") == '1', 'forfait ajouté')
    await page.screenshot(path=f'{CAPTURES}/admin-lieux.png', full_page=True)

    # Majoration du dimanche, jour férié
    await page.get_by_role('tab', name='Majorations et fériés').click()
    await page.locator('tr', has_text='Dimanche').get_by_role('button', name='Modifier').click()
    await page.locator('dialog.fenetre input[name=pourcentage]').fill('10')
    await page.locator('dialog.fenetre input[name=active]').check()
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    verifier(valeur("select pourcentage || ' ' || active from public.majorations where type = 'dimanche'") == '10.00 true', 'majoration du dimanche à 10 %, appliquée')
    await page.get_by_role('button', name='Ajouter un jour férié').click()
    await page.locator('dialog.fenetre input[name=jour]').fill('2028-12-31')
    await page.locator('dialog.fenetre input[name=libelle]').fill('Essai')
    await page.locator('dialog.fenetre').get_by_role('button', name='Ajouter').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_selector('.liste-feries >> text=Essai')
    await page.locator('.liste-feries li', has_text='Essai').get_by_role('button', name='Supprimer').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Supprimer').click()
    await page.wait_for_selector('.liste-feries >> text=Essai', state='detached')
    verifier(valeur("select count(*) from public.jours_feries where jour = '2028-12-31'") == '0', 'jour férié ajouté puis supprimé')

    # Réglages
    await page.get_by_role('tab', name='Réglages').click()
    await page.get_by_role('button', name='Modifier les réglages').click()
    await page.locator('dialog.fenetre input[name=attente_gratuite_min]').fill('7')
    await page.locator('dialog.fenetre input[name=zone_lat_min]').fill('50')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre .alerte:not([hidden])')
    verifier('sud doit être sous le nord' in await page.inner_text('dialog.fenetre .alerte'), 'zone desservie incohérente : refusée')
    await page.locator('dialog.fenetre input[name=zone_lat_min]').fill('48.1')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    verifier(valeur("select attente_gratuite_min from public.parametres") == '7', 'réglages enregistrés')
    await ctx.close()

    # Remise en état (les autres essais comptent sur les valeurs d'origine)
    systeme(f"""delete from public.forfaits where zone_a_id in (select id from public.zones where nom = 'Paris centre') or zone_b_id in (select id from public.zones where nom = 'Paris centre');
delete from public.zones where nom = 'Paris centre';
delete from public.tarifs where valide_du > current_date and not exists (select 1 from public.courses c where c.tarif_id = tarifs.id);
update public.majorations m set pourcentage = s.pourcentage, active = s.active from json_populate_recordset(null::public.majorations, $j${sauvegarde}$j$::json->'m') s where s.type = m.type;
update public.parametres p set attente_gratuite_min = (($j${sauvegarde}$j$::json->'p'->>'attente_gratuite_min'))::integer, zone_lat_min = (($j${sauvegarde}$j$::json->'p'->>'zone_lat_min'))::numeric;""")


async def parametres(nav):
    print('Paramètres')
    sauvegarde = valeur("select row_to_json(s) from public.societe s")
    auth = AuthSimulee(ADMIN, EMAIL_ADMIN, mot_de_passe='Chaumontel2026', facteur_verifie=True)
    auth.aal, auth.methodes = 'aal2', ['password', 'totp']
    ctx, page = await nouvelle_page(nav, auth, auth.injection(), mobile=False)
    await page.goto(SITE + 'admin/parametres/')
    await page.wait_for_selector('#contenu .fiche-donnees')
    verifier('À compléter' in await page.inner_text('#contenu'), 'entreprise : mentions manquantes signalées')
    await page.get_by_role('button', name='Modifier').click()
    await page.locator('dialog.fenetre input[name=siret]').fill('123')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    verifier('14 chiffres' in await page.inner_text('dialog.fenetre'), 'SIRET mal saisi : refusé')
    await page.locator('dialog.fenetre input[name=siret]').fill('99999999800019')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre .alerte:not([hidden])')
    verifier('commencer par les 9 chiffres du SIREN' in await page.inner_text('dialog.fenetre .alerte'), 'SIRET incohérent avec le SIREN : refusé')
    await page.locator('dialog.fenetre input[name=siret]').fill('100 052 570 00017')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    verifier('clé de contrôle' in await page.inner_text('dialog.fenetre'), 'SIRET avec une faute de frappe (clé fausse) : refusé')
    await page.locator('dialog.fenetre input[name=siret]').fill('100 052 570 00015')
    await page.locator('dialog.fenetre input[name=tva_intracommunautaire]').fill('FR 12 100052570')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    verifier('la clé ne correspond pas' in await page.inner_text('dialog.fenetre'), 'n° de TVA avec une clé fausse : refusé')
    await page.locator('dialog.fenetre input[name=tva_intracommunautaire]').fill('FR49 100 052 570')
    await page.locator('dialog.fenetre input[name=iban]').fill('FR76 3000 6000 0112 3456 7890 188')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    verifier('IBAN invalide' in await page.inner_text('dialog.fenetre'), 'IBAN avec une faute de frappe : refusé')
    await page.locator('dialog.fenetre input[name=iban]').fill('fr76 3000 6000 0112 3456 7890 189')
    await page.locator('dialog.fenetre input[name=bic]').fill('agrifrpp')
    await page.locator('dialog.fenetre input[name=registre_vtc_numero]').fill('EVTC095260001')
    await page.locator('dialog.fenetre input[name=code_ape]').fill('49.32z')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(500)
    verifier(valeur("select concat_ws(' ', siret, tva_intracommunautaire, registre_vtc_numero, code_ape, iban, bic) from public.societe")
             == '10005257000015 FR49100052570 EVTC095260001 4932Z FR7630006000011234567890189 AGRIFRPP',
             'identité enregistrée : numéros sans espaces, en majuscules (code APE normalisé)')
    verifier('FR76 3000 6000 0112 3456 7890 189' in await page.inner_text('#contenu'), 'IBAN affiché par groupes de 4')

    # Administrateurs : nommer puis retirer
    await page.get_by_role('tab', name='Administrateurs').click()
    await page.wait_for_selector('#contenu tbody tr')
    verifier('Vous' in await page.inner_text('#contenu'), 'administrateurs : l\'utilisateur actuel repéré')
    await page.get_by_role('button', name='Nommer un administrateur').click()
    await page.fill('#recherche-admin', 'client2')
    await page.locator('dialog.fenetre').get_by_role('button', name='Chercher').click()
    await page.locator('dialog.fenetre .choix', has_text='Hugo Petit').get_by_role('button', name='Nommer administrateur').click()
    await page.locator('dialog.fenetre', has_text='Nommer Hugo Petit').get_by_role('button', name='Nommer').click()
    await page.wait_for_selector('#contenu >> text=Hugo Petit')
    verifier(valeur("select role from public.profils where id = 'c0000000-0000-4000-8000-000000000002'") == 'admin', 'administrateur nommé')
    await page.locator('#contenu tr', has_text='Hugo Petit').get_by_role('button', name='Retirer le rôle').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Retirer le rôle').click()
    await page.wait_for_selector('#contenu >> text=Hugo Petit', state='detached')
    verifier(valeur("select role from public.profils where id = 'c0000000-0000-4000-8000-000000000002'") == 'client', 'rôle d\'administrateur retiré')

    # Mon compte : mot de passe
    await page.get_by_role('tab', name='Mon compte').click()
    await page.wait_for_selector('text=Activée')
    await page.get_by_role('button', name='Changer mon mot de passe').click()
    await page.locator('dialog.fenetre input[name=mdp]').fill('NouveauMotDePasse2027')
    await page.locator('dialog.fenetre input[name=confirmation]').fill('NouveauMotDePasse2027')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    verifier(auth.mot_de_passe == 'NouveauMotDePasse2027', 'mot de passe changé')

    # Journal
    await page.get_by_role('tab', name='Journal des modifications').click()
    await page.wait_for_selector('#journal-liste tbody tr')
    journal = await page.inner_text('#journal-liste')
    verifier('Entreprise' in journal and 'EVTC095260001' in journal, 'journal : modification de l\'entreprise, valeur après')
    await page.select_option('#journal-table', 'profils')
    await page.wait_for_function("!document.getElementById('journal-liste').textContent.includes('EVTC095260001')")
    verifier('Comptes (rôles, blocages, coordonnées)' in await page.inner_text('#journal-liste'), 'journal : filtre par table')
    await page.screenshot(path=f'{CAPTURES}/admin-journal.png', full_page=True)
    await ctx.close()
    systeme(f"update public.societe s set siret = x.siret, tva_intracommunautaire = x.tva_intracommunautaire, "
            f"registre_vtc_numero = x.registre_vtc_numero, code_ape = x.code_ape, iban = x.iban, bic = x.bic "
            f"from json_populate_record(null::public.societe, $j${sauvegarde}$j$::json) x where s.id = 1")


HUGO = 'c0000000-0000-4000-8000-000000000002'
KARIM = 'c0000000-0000-4000-8000-000000000003'


def course_entreprise_terminee(client, compte, heure_paris='18:00'):
    """Réservation sur facture mensuelle, attribuée à Paul et menée jusqu'au bout par l'administration."""
    course = commander(client, p_type='planifiee', p_quand=demain(heure_paris), p_mode_paiement='facture_mensuelle', p_compte_pro=compte)
    appels = [('attribuer_course', {'p_course': course['id'], 'p_chauffeur': CHAUFFEUR})]
    appels += [('avancer_course', {'p_course': course['id'], 'p_etape': e}) for e in ('en_route', 'arrivee', 'a_bord', 'terminee')]
    for nom, corps in appels:
        ok, sortie = appel_rpc(nom, corps, ADMIN)
        assert ok, sortie
    return course


async def clients(nav):
    print('Clients')
    ctx, page, _ = await entrer(nav, mobile=False)
    await page.goto(SITE + 'admin/clients/')
    await page.wait_for_selector('#resultats tbody tr')
    total = int(valeur("select count(*) from public.profils where role = 'client'"))
    verifier(await page.inner_text('#nb-resultats') == f'{total} clients', f'liste : tous les clients ({total}), sans chauffeurs ni administrateurs')
    tuiles = await page.locator('#resume-clients .chiffre-cle').all_inner_texts()
    verifier(len(tuiles) == 4 and tuiles[0].startswith('Clients') and tuiles[0].split('\n')[1] == str(total), 'quatre chiffres clés, dont le nombre de clients')
    verifier(await page.get_attribute('.admin-lien[data-module="clients"]', 'aria-current') == 'page', 'menu : module « Clients et entreprises » actif')
    await page.fill('#filtre-texte', '06 11 11 11 11')
    await page.click('#filtres button[type=submit]')
    await page.wait_for_function("document.getElementById('nb-resultats').textContent === '1 client'")
    verifier('Claire Durand' in await page.inner_text('#resultats') and 'q=06' in page.url,
             'recherche par téléphone saisi avec espaces, gardée dans l\'adresse')
    await page.click('text=Effacer')
    await page.wait_for_function(f"document.getElementById('nb-resultats').textContent === '{total} clients'")
    await page.select_option('#filtre-tri', 'depense')
    await page.wait_for_function("location.search.includes('tri=depense')")
    await page.wait_for_timeout(300)
    verifier('Claire Durand' in await page.locator('#resultats tbody tr').first.inner_text(), 'tri par dépense : Claire en tête')
    async with page.expect_download() as telechargement:
        await page.get_by_role('button', name='Exporter (CSV)').click()
    fichier = await (await telechargement.value).path()
    contenu = open(fichier, encoding='utf-8-sig').read()
    verifier(contenu.startswith('Prénom;Nom;E-mail;') and contenu.count('\n') == total, 'export CSV : en-têtes, une ligne par client')
    await page.screenshot(path=f'{CAPTURES}/admin-clients-liste.png', full_page=True)

    # Fiche de Claire : lecture
    await page.locator('#resultats a', has_text='Claire Durand').click()
    await page.wait_for_selector('#titre-identite')
    verifier(await page.inner_text('.admin-titre') == 'Claire Durand', 'fiche : nom du client en titre')
    texte = await page.inner_text('#contenu')
    verifier('Ponctuelle' in texte and 'Paul Bernard' in texte, 'fiche : note et commentaire du chauffeur (administration seulement)')
    verifier('Atelier Lumière SARL' in texte and 'Gestionnaire' in texte, 'fiche : entreprise de rattachement, rôle')
    verifier('Léa Roux' in texte and 'Mamie Durand' in texte, 'fiche : filleule et proches')
    nb = int(valeur(f"select count(*) from public.courses where client_id = '{CLIENT}'"))
    verifier(await page.locator('section[aria-labelledby=titre-courses] tbody tr').count() == min(nb, 10), 'fiche : les 10 courses les plus récentes d\'abord')
    if nb > 10:
        await page.get_by_role('button', name=f'Afficher les {nb - 10} autres courses').click()
    verifier(await page.locator('section[aria-labelledby=titre-courses] tbody tr').count() == nb, f'fiche : ses {nb} courses, en un clic')
    verifier(await page.locator('section[aria-labelledby=titre-courses] a[href*="courses/?id="]').count() == nb, 'fiche : chaque course mène à sa fiche')
    await page.screenshot(path=f'{CAPTURES}/admin-fiche-client.png', full_page=True)

    # Fiche de Karim : corrections, blocage, solde, notes internes
    corrections = int(valeur(f"select count(*) from prive.journal where table_cible = 'profils' and ligne_id = '{KARIM}' "
                             f"and acteur_id = '{ADMIN}' and apres ->> 'telephone' = '+33655555556'"))
    await page.goto(SITE + f'admin/clients/?id={KARIM}')
    await page.wait_for_selector('#titre-identite')
    await page.get_by_role('button', name='Modifier').click()
    await page.locator('dialog.fenetre input[name=telephone]').fill('06 12')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    verifier('Numéro invalide' in await page.inner_text('dialog.fenetre'), 'téléphone incomplet : refusé, message précis')
    await page.locator('dialog.fenetre input[name=telephone]').fill('06 55 55 55 56')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_selector('#contenu >> text=+33 6 55 55 55 56')
    verifier(valeur(f"select telephone from public.profils where id = '{KARIM}'") == '+33655555556', 'téléphone « 06 … » enregistré au format international')
    verifier(valeur(f"select count(*) from prive.journal where table_cible = 'profils' and ligne_id = '{KARIM}' "
                    f"and acteur_id = '{ADMIN}' and apres ->> 'telephone' = '+33655555556'") == str(corrections + 1), 'correction inscrite au journal, à votre nom')

    await page.get_by_role('button', name='Bloquer le compte').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Bloquer le compte').click()
    verifier('Champ obligatoire' in await page.inner_text('dialog.fenetre'), 'blocage sans motif : refusé')
    await page.locator('dialog.fenetre textarea[name=motif]').fill('Comportement inacceptable envers un chauffeur')
    await page.locator('dialog.fenetre').get_by_role('button', name='Bloquer le compte').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_selector('text=Compte bloqué : ce client ne peut plus commander')
    verifier(valeur(f"select statut from public.profils where id = '{KARIM}'") == 'bloque', 'compte bloqué')
    await page.click('.repli-historique summary')
    await page.wait_for_selector('.repli-historique tbody tr')
    historique = await page.inner_text('.repli-historique')
    verifier('Compte bloqué' in historique and 'Comportement inacceptable' in historique and 'Téléphone' in historique,
             'historique : blocage avec son motif, correction du téléphone')
    await page.screenshot(path=f'{CAPTURES}/admin-fiche-client-bloque.png', full_page=True)
    await page.get_by_role('button', name='Débloquer le compte').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Débloquer').click()
    await page.wait_for_selector('text=Compte bloqué : ce client ne peut plus commander', state='detached')
    verifier(valeur(f"select statut from public.profils where id = '{KARIM}'") == 'actif', 'compte débloqué')

    await page.get_by_role('button', name='Créditer ou débiter le solde').click()
    await page.locator('dialog.fenetre input[name=montant]').fill('5,50')
    await page.locator('dialog.fenetre textarea[name=motif]').fill("Geste commercial : attente à l'aéroport")
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer le mouvement').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_selector("text=Geste commercial : attente à l'aéroport")
    verifier(valeur(f"select montant from public.soldes where profil_id = '{KARIM}'") == '5.50', 'solde crédité de 5,50 € (virgule acceptée)')
    await page.get_by_role('button', name='Créditer ou débiter le solde').click()
    await page.locator('dialog.fenetre select[name=sens]').select_option('debit')
    await page.locator('dialog.fenetre input[name=montant]').fill('10')
    await page.locator('dialog.fenetre textarea[name=motif]').fill('Correction')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer le mouvement').click()
    await page.wait_for_selector('dialog.fenetre .alerte:not([hidden])')
    verifier('Solde insuffisant' in await page.inner_text('dialog.fenetre .alerte'), 'débit supérieur au solde : refusé, message exact')
    await page.locator('dialog.fenetre input[name=montant]').fill('5,50')
    await page.locator('dialog.fenetre').get_by_role('button', name='Enregistrer le mouvement').click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_selector('#contenu >> text=− 5,50 €')
    verifier(valeur(f"select montant from public.soldes where profil_id = '{KARIM}'") == '0.00', 'débit : solde revenu à 0')

    await page.fill('#nouvelle-note', 'Appeler avant 18 h, jamais le week-end.')
    await page.get_by_role('button', name='Ajouter la note').click()
    await page.wait_for_selector('.liste-notes li')
    verifier('Alice Martin' in await page.inner_text('.liste-notes'), 'note interne ajoutée, avec son auteur')
    await page.locator('.liste-notes li').get_by_role('button', name='Retirer').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Retirer').click()
    await page.wait_for_selector('.liste-notes', state='detached')
    verifier(valeur(f"select count(*) from public.notes_internes where profil_id = '{KARIM}'") == '0', 'note interne retirée')
    await ctx.close()

    # Téléphone : liste et fiche lisibles sur 390 px
    ctx, page, _ = await entrer(nav, mobile=True)
    await page.goto(SITE + 'admin/clients/')
    await page.wait_for_selector('#resultats tbody tr')
    verifier(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'téléphone : liste sans défilement horizontal')
    await page.screenshot(path=f'{CAPTURES}/admin-clients-telephone.png', full_page=True)
    await page.goto(SITE + f'admin/clients/?id={CLIENT}')
    await page.wait_for_selector('#titre-identite')
    verifier(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'téléphone : fiche sans défilement horizontal')
    await page.screenshot(path=f'{CAPTURES}/admin-fiche-client-telephone.png', full_page=True)
    await ctx.close()
    systeme(f"update public.profils set telephone = '+33655555555' where id = '{KARIM}'")


async def entreprises(nav):
    print('Entreprises')
    compte = valeur("select id from public.comptes_pro where raison_sociale = 'Atelier Lumière SARL'")
    ctx, page, _ = await entrer(nav, mobile=False)
    await page.goto(SITE + 'admin/clients/?vue=entreprises')
    await page.wait_for_selector('#liste-comptes tbody tr')
    verifier('Atelier Lumière SARL' in await page.inner_text('#liste-comptes')
             and await page.inner_text('.onglet[aria-selected="true"]') == 'Entreprises', 'liste des entreprises (onglet gardé dans l\'adresse)')

    # Création : chaque numéro contrôlé par sa clé
    await page.get_by_role('button', name='Nouveau compte professionnel').click()
    await page.locator('dialog.fenetre input[name=raison_sociale]').fill('Boulangerie des Essais')
    await page.locator('dialog.fenetre input[name=siret]').fill('999 999 998 00028')
    await page.locator('dialog.fenetre input[name=email_facturation]').fill('compta@boulangerie-essais.test')
    await page.locator('dialog.fenetre').get_by_role('button', name='Créer le compte').click()
    verifier('clé de contrôle' in await page.inner_text('dialog.fenetre'), 'SIRET avec une faute de frappe : refusé')
    await page.locator('dialog.fenetre input[name=siret]').fill('999 999 998 00027')
    await page.locator('dialog.fenetre input[name=tva_intracommunautaire]').fill('FR14987654324')
    await page.locator('dialog.fenetre').get_by_role('button', name='Créer le compte').click()
    await page.wait_for_selector('dialog.fenetre .alerte:not([hidden])')
    verifier('ne reprend pas le SIREN' in await page.inner_text('dialog.fenetre .alerte'), 'TVA d\'une autre entreprise : refusée')
    await page.locator('dialog.fenetre input[name=tva_intracommunautaire]').fill('fr 11 999 999 998')
    await page.locator('dialog.fenetre input[name=telephone]').fill('01 40 00 00 01')
    await page.locator('dialog.fenetre input[name=plafond_mensuel]').fill('500')
    await page.locator('dialog.fenetre').get_by_role('button', name='Créer le compte').click()
    await page.wait_for_selector('#titre-identite')
    nouveau = valeur("select id from public.comptes_pro where raison_sociale = 'Boulangerie des Essais'")
    verifier(f'entreprise={nouveau}' in page.url, 'compte créé : sa fiche s\'ouvre')
    verifier(valeur(f"select concat_ws(' ', siret, tva_intracommunautaire, telephone, plafond_mensuel, delai_paiement_jours) "
                    f"from public.comptes_pro where id = '{nouveau}'") == '99999999800027 FR11999999998 +33140000001 500.00 30',
             'numéros sans espaces, TVA en majuscules, téléphone international, plafond, règlement à 30 jours')

    # Membres : rattacher, changer de rôle, détacher
    messages = int(valeur(f"select count(*) from public.notifications where destinataire_id = '{KARIM}' and message like '%Boulangerie des Essais%'"))
    await page.get_by_role('button', name='Rattacher un membre').click()
    await page.fill('#recherche-membre', 'Karim')
    await page.locator('dialog.fenetre').get_by_role('button', name='Chercher').click()
    await page.locator('dialog.fenetre .choix', has_text='Karim Benali').get_by_role('button', name='Rattacher comme membre').click()
    await page.wait_for_selector('section[aria-labelledby=titre-membres] tbody tr')
    verifier(valeur(f"select role from public.comptes_pro_membres where compte_pro_id = '{nouveau}' and profil_id = '{KARIM}'") == 'membre',
             'membre rattaché')
    verifier(valeur(f"select count(*) from public.notifications where destinataire_id = '{KARIM}' and message like '%Boulangerie des Essais%'") == str(messages + 1),
             'membre prévenu dans l\'application')
    await page.get_by_role('button', name='Passer gestionnaire').click()
    await page.wait_for_selector('section[aria-labelledby=titre-membres] >> text=Passer membre')
    verifier(valeur(f"select role from public.comptes_pro_membres where compte_pro_id = '{nouveau}' and profil_id = '{KARIM}'") == 'gestionnaire',
             'membre passé gestionnaire')
    await page.get_by_role('button', name='Détacher').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Détacher').click()
    await page.wait_for_selector('text=Aucun membre : personne ne peut encore commander')
    verifier(valeur(f"select count(*) from public.comptes_pro_membres where compte_pro_id = '{nouveau}'") == '0', 'membre détaché')

    # Suspendre, réactiver, supprimer (aucune course à son nom)
    await page.get_by_role('button', name='Suspendre').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Suspendre').click()
    await page.wait_for_selector('text=Compte suspendu : ses membres ne peuvent plus commander')
    verifier(valeur(f"select statut from public.comptes_pro where id = '{nouveau}'") == 'suspendu', 'compte suspendu')
    await page.get_by_role('button', name='Réactiver').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Réactiver').click()
    await page.wait_for_selector('text=Compte suspendu : ses membres ne peuvent plus commander', state='detached')
    await page.get_by_role('button', name='Supprimer').click()
    await page.locator('dialog.fenetre').get_by_role('button', name='Supprimer').click()
    await page.wait_for_function("location.search === '?vue=entreprises'")
    await page.wait_for_selector('#liste-comptes tbody tr')
    verifier(valeur(f"select count(*) from public.comptes_pro where id = '{nouveau}'") == '0'
             and 'Boulangerie des Essais' not in await page.inner_text('#liste-comptes'), 'compte sans course supprimé, retour à la liste')

    # Relevé mensuel : nouvelle course de Hugo sur facture mensuelle, puis encaissement
    course = course_entreprise_terminee(HUGO, compte)
    reste = valeur(f"select sum(p.montant) from public.paiements p join public.courses c on c.id = p.course_id "
                   f"where c.compte_pro_id = '{compte}' and p.mode = 'facture_mensuelle' and p.statut = 'a_encaisser'")
    await page.goto(SITE + f'admin/clients/?entreprise={compte}')
    await page.wait_for_selector('#releve tbody tr')
    texte = await page.inner_text('#releve')
    verifier(course['numero'] in texte and 'À payer' in texte, 'relevé : la nouvelle course, à payer')
    encaisser = page.get_by_role('button', name=re.compile('^Encaisser le relevé'))
    verifier(await encaisser.count() == 1 and reste.replace('.', ',') in await encaisser.inner_text(),
             f'relevé : bouton d\'encaissement du reste à payer ({reste} €)')
    await encaisser.click()
    await page.locator('dialog.fenetre input[name=reference]').fill('VIR-NAVIGATEUR-002')
    await page.locator('dialog.fenetre').get_by_role('button', name=re.compile('^Encaisser ')).click()
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_selector('#releve >> text=Payé')
    verifier(await page.get_by_role('button', name=re.compile('^Encaisser le relevé')).count() == 0, 'relevé encaissé : plus rien à payer')
    verifier(valeur(f"select count(*) from public.paiements where reference_externe = 'VIR-NAVIGATEUR-002' and statut = 'encaisse'") != '0',
             'paiements encaissés avec la référence du virement')
    await page.screenshot(path=f'{CAPTURES}/admin-fiche-entreprise.png', full_page=True)

    # Relevé imprimable
    await page.get_by_role('link', name='Relevé imprimable (PDF)').click()
    await page.wait_for_selector('.releve-document')
    document = await page.inner_text('.releve-document')
    verifier('Relevé de factures'.upper() in document.upper() and 'LOC RÉACTION S.A.S' in document and 'Atelier Lumière SARL' in document
             and course['numero'] in document and 'Reste à payer' in document,
             'relevé imprimable : émetteur, client, courses, totaux')
    await page.screenshot(path=f'{CAPTURES}/admin-releve-ecran.png', full_page=True)
    await page.emulate_media(media='print')
    verifier(not await page.locator('#admin-menu').is_visible() and not await page.locator('.admin-entete').is_visible(),
             'impression : ni menu ni boutons, seulement le relevé')
    await page.pdf(path=f'{CAPTURES}/admin-releve.pdf', format='A4', print_background=True, prefer_css_page_size=True)
    await page.emulate_media(media='screen')
    await ctx.close()

    # Téléphone
    ctx, page, _ = await entrer(nav, mobile=True)
    await page.goto(SITE + 'admin/clients/?vue=entreprises')
    await page.wait_for_selector('#liste-comptes tbody tr')
    verifier(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'téléphone : liste des entreprises sans défilement horizontal')
    await page.screenshot(path=f'{CAPTURES}/admin-entreprises-telephone.png', full_page=True)
    await page.goto(SITE + f'admin/clients/?entreprise={compte}')
    await page.wait_for_selector('#releve tbody tr')
    verifier(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'téléphone : fiche de l\'entreprise sans défilement horizontal')
    await page.screenshot(path=f'{CAPTURES}/admin-fiche-entreprise-telephone.png', full_page=True)
    mois = valeur("select to_char(now() at time zone 'Europe/Paris', 'YYYY-MM')")
    await page.goto(SITE + f'admin/clients/?entreprise={compte}&releve={mois}')
    await page.wait_for_selector('.releve-document')
    verifier(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'téléphone : relevé sans défilement de la page (le tableau défile dans son cadre)')
    await page.screenshot(path=f'{CAPTURES}/admin-releve-telephone.png', full_page=True)
    await ctx.close()


ETAPES = {'porte': porte, 'tableau': tableau_de_bord, 'dispatch': dispatch, 'courses': courses,
          'clients': clients, 'entreprises': entreprises,
          'chauffeurs': chauffeurs, 'flotte': flotte, 'tarifs': tarifs, 'parametres': parametres}


async def main():
    choix = sys.argv[1:] or list(ETAPES)
    serveur = serveur_local()
    time.sleep(1)
    try:
        async with async_playwright() as p:
            nav = await p.chromium.launch()
            for nom in choix:
                await ETAPES[nom](nav)
            await nav.close()
    finally:
        serveur.terminate()
    # Attendues : refus volontaires (mauvais mot de passe ou code : 400, 422) et
    # temps réel absent du banc (pas de serveur de diffusion)
    attendues = ('favicon', 'WebSocket connection', 'status of 400', 'status of 422')
    erreurs = [c for c in console if not any(a in c for a in attendues)]
    if erreurs:
        print('Erreurs de la console :')
        for e in erreurs:
            print('  ', e)
        raise SystemExit(1)
    print('✔ Administration : parcours conformes.')


if __name__ == '__main__':
    asyncio.run(main())
