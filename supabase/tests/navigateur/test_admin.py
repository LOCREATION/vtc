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
    verifier(await page.locator('.admin-lien').count() == 11, 'menu : onze modules')
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
    # « Demain » à l'heure de Paris (la base locale compte en temps universel : entre minuit et 1 h, ce n'est pas le même jour)
    verifier(valeur("select prix_heure_mad || ' ' || (valide_du = (now() at time zone 'Europe/Paris')::date + 1) from public.tarifs order by valide_du desc limit 1") == '45.00 true',
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
    verifier(await page.evaluate('document.documentElement.scrollWidth <= screen.width'), 'téléphone : liste sans défilement horizontal')
    await page.screenshot(path=f'{CAPTURES}/admin-clients-telephone.png', full_page=True)
    await page.goto(SITE + f'admin/clients/?id={CLIENT}')
    await page.wait_for_selector('#titre-identite')
    verifier(await page.evaluate('document.documentElement.scrollWidth <= screen.width'), 'téléphone : fiche sans défilement horizontal')
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
    # Le relevé se recharge : l'ancien affichage (qui a déjà des lignes « Payé »)
    # reste visible le temps de la lecture ; on attend la ligne de la nouvelle
    # course passée « Payé » dans le nouvel affichage
    await page.wait_for_function("""(numero) => [...document.querySelectorAll('#releve tbody tr')]
        .some((tr) => tr.innerText.includes(numero) && tr.innerText.includes('Payé'))""", arg=course['numero'])
    verifier(await page.get_by_role('button', name=re.compile('^Encaisser le relevé')).count() == 0, 'relevé encaissé : plus rien à payer')
    verifier(await page.locator('#releve .sous-titre').inner_text()
             == await page.evaluate("""() => { const m = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }).format(new Date());
                                               return `Relevé provisoire : le mois ${/^[aeiouyàâéèêîôû]/i.test(m) ? "d'" + m : 'de ' + m} n'est pas terminé. Les courses à venir s'y ajouteront.`; }"""),
             'relevé du mois en cours : « le mois d\'octobre », « de novembre » (élision)')
    verifier(valeur(f"select count(*) from public.paiements where reference_externe = 'VIR-NAVIGATEUR-002' and statut = 'encaisse'") != '0',
             'paiements encaissés avec la référence du virement')
    await page.screenshot(path=f'{CAPTURES}/admin-fiche-entreprise.png', full_page=True)

    # Relevé imprimable
    await page.get_by_role('link', name='Relevé imprimable (PDF)').click()
    await page.wait_for_selector('.doc')
    document = await page.inner_text('.doc')
    verifier('Relevé de factures'.upper() in document.upper() and 'LOC RÉACTION S.A.S' in document and 'Atelier Lumière SARL' in document
             and course['numero'] in document and 'Reste à payer' in document,
             'relevé imprimable : émetteur, client, courses, totaux')
    avoirs_releve = int(valeur(f"""select count(*) from public.avoirs a join public.factures f on f.id = a.facture_id
                                   where f.compte_pro_id = '{compte}' and to_char(f.date_emission, 'YYYY-MM') = to_char(now() at time zone 'Europe/Paris', 'YYYY-MM')"""))
    verifier(await page.locator('.doc tr.doc-ligne-avoir').count() == avoirs_releve and avoirs_releve > 0
             and 'Avoirs TTC' in document and 'Non dû' in document,
             f'relevé imprimable : {avoirs_releve} avoir(s) sous la facture corrigée, déduit(s) des totaux')
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
    verifier(await page.evaluate('document.documentElement.scrollWidth <= screen.width'), 'téléphone : liste des entreprises sans défilement horizontal')
    await page.screenshot(path=f'{CAPTURES}/admin-entreprises-telephone.png', full_page=True)
    await page.goto(SITE + f'admin/clients/?entreprise={compte}')
    await page.wait_for_selector('#releve tbody tr')
    verifier(await page.evaluate('document.documentElement.scrollWidth <= screen.width'), 'téléphone : fiche de l\'entreprise sans défilement horizontal')
    await page.screenshot(path=f'{CAPTURES}/admin-fiche-entreprise-telephone.png', full_page=True)
    mois = valeur("select to_char(now() at time zone 'Europe/Paris', 'YYYY-MM')")
    await page.goto(SITE + f'admin/clients/?entreprise={compte}&releve={mois}')
    await page.wait_for_selector('.doc')
    verifier(await page.evaluate('document.documentElement.scrollWidth <= screen.width'), 'téléphone : relevé sans défilement de la page (le tableau défile dans son cadre)')
    await page.screenshot(path=f'{CAPTURES}/admin-releve-telephone.png', full_page=True)
    await ctx.close()


def course_terminee(client, mode, heure_paris):
    """Réservation payée sur place, attribuée à Paul et menée jusqu'au bout par l'administration."""
    course = commander(client, p_type='planifiee', p_quand=demain(heure_paris), p_mode_paiement=mode)
    appels = [('attribuer_course', {'p_course': course['id'], 'p_chauffeur': CHAUFFEUR})]
    appels += [('avancer_course', {'p_course': course['id'], 'p_etape': e}) for e in ('en_route', 'arrivee', 'a_bord', 'terminee')]
    for nom, corps in appels:
        ok, sortie = appel_rpc(nom, corps, ADMIN)
        assert ok, sortie
    course['paiement'] = valeur(f"select id from public.paiements where course_id = '{course['id']}' and nature = 'course'")
    course['montant'] = valeur(f"select montant from public.paiements where id = '{course['paiement']}'")
    return course


def ligne_paiement(page, numero):
    return page.locator('#liste-paiements tbody tr', has_text=numero)


async def fenetre(page):
    await page.wait_for_selector('dialog.fenetre[open]')
    return page.locator('dialog.fenetre')


async def fermee(page):
    await page.wait_for_selector('dialog.fenetre', state='detached')
    await page.wait_for_timeout(400)


async def finances(nav):
    print('Finances')
    KARIM = valeur("select id from public.profils where prenom = 'Karim' and nom = 'Benali'")
    especes = course_terminee(KARIM, 'especes', '06:00')
    carte = course_terminee(CLIENT, 'carte', '05:00')     # de nuit : majoration
    du_jour = course_terminee(KARIM, 'especes', '05:30')
    # Un paiement oublié depuis deux jours : alerte du tableau de bord
    systeme(f"update public.paiements set cree_le = now() - interval '2 days' where id = '{du_jour['paiement']}'")

    ctx, page, _ = await entrer(nav, mobile=False)

    # Tableau de bord : l'alerte mène directement aux paiements à encaisser
    await page.goto(SITE + 'admin/')
    await page.wait_for_selector('#alertes li')
    lien = page.locator('#alertes li', has_text='depuis plus de 24 h').locator('a')
    verifier(await lien.get_attribute('href') == '/v2/admin/finances/?vue=a_encaisser',
             'tableau de bord : « paiements à encaisser depuis plus de 24 h » mène à Finances, liste à encaisser')
    await lien.click()
    await page.wait_for_selector('#liste-paiements tbody tr')
    verifier(await page.inner_text('.admin-titre') == 'Finances'
             and await page.get_attribute('.admin-lien[data-module="finances"]', 'aria-current') == 'page',
             'module Finances ouvert, signalé dans le menu')

    # 1. À encaisser : cases de chiffres et liste conformes à la base
    attendu = valeur("select count(*) || '|' || coalesce(sum(montant), 0) from public.paiements where statut = 'a_encaisser' and mode <> 'facture_mensuelle'").split('|')
    tuiles = await page.locator('#chiffres-encaissements .chiffre-cle').all_inner_texts()
    verifier(len(tuiles) == 4 and attendu[1].replace('.', ',') in tuiles[0].replace(' ', ' ').replace(' ', '')
             and 'depuis plus de 24 h' in tuiles[0], f'case « À encaisser » : {attendu[1]} € sur place, dont un paiement de plus de 24 h')
    total = int(valeur("select count(*) from public.paiements where statut = 'a_encaisser'"))
    verifier(f'{total} paiement' in await page.inner_text('#resume-paiements'), f'liste « À encaisser » : {total} paiements')
    plus_ancien = valeur("select c.numero from public.paiements p join public.courses c on c.id = p.course_id where p.statut = 'a_encaisser' order by p.cree_le, p.id limit 1")
    verifier(plus_ancien in await page.locator('#liste-paiements tbody tr').first.inner_text(), 'liste « À encaisser » : le plus ancien en tête')

    # 2. Confirmer des espèces : gardées par le chauffeur
    await ligne_paiement(page, especes['numero']).get_by_role('button', name='Confirmer l\'encaissement').click()
    f = await fenetre(page)
    verifier('Paul Bernard, qui les remettra au bureau' in await f.locator('select[name=recu_par]').inner_text(),
             'espèces : qui a reçu l\'argent (le chauffeur, ou le bureau)')
    await f.get_by_role('button', name='Confirmer').click()
    await fermee(page)
    verifier(valeur(f"select statut || ' ' || coalesce(especes_chauffeur_id::text, '-') from public.paiements where id = '{especes['paiement']}'")
             == f'encaisse {CHAUFFEUR}', 'espèces confirmées : gardées par Paul jusqu\'à leur remise')

    # 3. Déclarer impayé (carte refusée), puis encaisser quand le client règle
    await ligne_paiement(page, carte['numero']).get_by_role('button', name='Déclarer impayé').click()
    f = await fenetre(page)
    await f.get_by_role('button', name='Déclarer impayé').click()
    verifier(await f.locator('.erreur-champ:not([hidden])').count() == 1, 'impayé : motif obligatoire')
    await f.locator('textarea[name=motif]').fill('Carte refusée au terminal')
    await f.get_by_role('button', name='Déclarer impayé').click()
    await fermee(page)
    verifier(valeur(f"select statut || ' ' || motif from public.paiements where id = '{carte['paiement']}'") == 'echoue Carte refusée au terminal',
             'paiement déclaré impayé, avec son motif')
    await page.get_by_role('tab', name=re.compile('^Impayés')).click()
    await page.wait_for_function("location.search.includes('vue=impayes')")
    await page.wait_for_selector(f"#liste-paiements tbody tr:has-text('{carte['numero']}')")
    verifier('Carte refusée au terminal' in await ligne_paiement(page, carte['numero']).inner_text(), 'liste « Impayés » : le motif')
    await ligne_paiement(page, carte['numero']).get_by_role('button', name='Encaisser (réglé depuis)').click()
    f = await fenetre(page)
    await f.get_by_role('button', name='Confirmer').click()
    await fermee(page)
    verifier(valeur(f"select statut from public.paiements where id = '{carte['paiement']}'") == 'encaisse', 'impayé encaissé une fois le client a réglé')

    # 4. Annuler une partie de la somme due : avoir
    await page.get_by_role('tab', name=re.compile('^À encaisser')).click()
    await page.wait_for_selector(f"#liste-paiements tbody tr:has-text('{du_jour['numero']}')")
    await ligne_paiement(page, du_jour['numero']).get_by_role('button', name='Annuler la somme').click()
    f = await fenetre(page)
    await f.locator('input[name=montant]').fill('2,50')
    await f.locator('textarea[name=motif]').fill('Attente offerte')
    await f.get_by_role('button', name='Annuler la somme').click()
    await fermee(page)
    reste = valeur(f"select montant from public.paiements where id = '{du_jour['paiement']}'")
    verifier(round(float(reste), 2) == round(float(du_jour['montant']) - 2.5, 2)
             and valeur(f"select count(*) from public.avoirs where paiement_id = '{du_jour['paiement']}' and montant_ttc = 2.50") == '1',
             f'annulation partielle : 2,50 € retirés (reste {reste} €), avoir émis')

    # 5. Encaissés du mois : liste, export, remboursement par carte
    await page.get_by_role('tab', name=re.compile('^Encaissés')).click()
    await page.wait_for_selector('#paiements-periode')
    encaisses = valeur("""select count(*) from public.paiements where statut in ('encaisse', 'rembourse')
                          and encaisse_le >= date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris'""")
    await page.wait_for_function(f"document.getElementById('resume-paiements').textContent.includes('{encaisses} paiement')")
    verifier(await page.input_value('#paiements-periode') == 'mois', f'encaissés de ce mois-ci : {encaisses} paiements')
    async with page.expect_download() as telechargement:
        await page.get_by_role('button', name='Exporter (CSV)').click()
    contenu = open(await (await telechargement.value).path(), encoding='utf-8-sig').read()
    verifier(contenu.startswith('Encaissé le;Course;') and contenu.count('\n') == int(encaisses),
             'export des encaissés : en-têtes, une ligne par paiement')
    await ligne_paiement(page, carte['numero']).get_by_role('button', name='Rembourser').click()
    f = await fenetre(page)
    verifier(await f.locator('select[name=mode]').input_value() == 'carte', 'remboursement d\'une carte : sur la carte par défaut')
    await f.locator('input[name=montant]').fill('1,50')
    await f.locator('textarea[name=motif]').fill('Détour non prévu')
    await f.get_by_role('button', name='Rembourser').click()
    await fermee(page)
    verifier(valeur(f"""select r.mode || ' ' || r.montant || ' ' || a.numero from public.remboursements r
                        join public.avoirs a on a.remboursement_id = r.id where r.paiement_id = '{carte['paiement']}'""").startswith('carte 1.50 AV-'),
             'remboursement : 1,50 € sur la carte, avoir émis')
    await page.screenshot(path=f'{CAPTURES}/admin-finances-encaissements.png', full_page=True)

    # 6. Espèces des chauffeurs : remise au bureau, puis annulation
    await page.get_by_role('tab', name='Espèces des chauffeurs').click()
    await page.wait_for_selector('#liste-chauffeurs tbody tr')
    detenu = json.loads(appel_rpc('admin_especes_chauffeurs', {}, ADMIN)[1])
    paul = next(c for c in detenu['chauffeurs'] if c['chauffeur_id'] == CHAUFFEUR)
    ligne_paul = page.locator('#liste-chauffeurs tbody tr', has_text='Paul Bernard')
    verifier(f"{paul['a_remettre']:.2f}".replace('.', ',') in (await ligne_paul.inner_text()).replace(' ', ''),
             f"Paul : {paul['a_remettre']} € à remettre, comme la base")
    await ligne_paul.get_by_role('button', name='Enregistrer une remise').click()
    f = await fenetre(page)
    await f.locator('input[name=note]').fill('Enveloppe du navigateur')
    await f.get_by_role('button', name='Enregistrer la remise').click()
    await fermee(page)
    remise = valeur("select numero || '|' || montant from public.remises_especes where note = 'Enveloppe du navigateur' order by cree_le desc limit 1").split('|')
    verifier(remise[0].startswith('RE-') and float(remise[1]) == float(paul['a_remettre']),
             f'remise enregistrée : reçu {remise[0]}, tout ce que Paul détenait')
    await page.wait_for_selector(f"#liste-remises tbody tr:has-text('{remise[0]}')")
    await page.locator('#liste-remises tbody tr', has_text=remise[0]).get_by_role('button', name='Annuler').click()
    f = await fenetre(page)
    await f.locator('textarea[name=motif]').fill('Montant à recompter')
    await f.get_by_role('button', name='Annuler la remise').click()
    await fermee(page)
    verifier(valeur(f"select motif_annulation from public.remises_especes where numero = '{remise[0]}'") == 'Montant à recompter'
             and 'Annulée' in await page.locator('#liste-remises tbody tr', has_text=remise[0]).inner_text(),
             'remise annulée : motif conservé, ligne barrée et visible')
    await page.screenshot(path=f'{CAPTURES}/admin-finances-especes.png', full_page=True)

    # 7. Factures et avoirs : registre, continuité, export, pièces imprimables
    await page.get_by_role('tab', name='Factures et avoirs').click()
    await page.wait_for_selector('#liste-registre tbody tr')
    pieces = valeur("""select (select count(*) from public.factures where date_emission >= date_trunc('month', now() at time zone 'Europe/Paris'))
                            + (select count(*) from public.avoirs where date_emission >= date_trunc('month', now() at time zone 'Europe/Paris'))""")
    verifier(f'{pieces} pièce' in await page.inner_text('#resume-registre'), f'registre du mois : {pieces} factures et avoirs')
    verifier('aucun numéro manquant' in await page.inner_text('.continuite'), 'numérotation continue contrôlée : aucun numéro manquant')
    async with page.expect_download() as telechargement:
        await page.get_by_role('button', name='Exporter (CSV)').click()
    registre = open(await (await telechargement.value).path(), encoding='utf-8-sig', newline='').read().split('\r\n')
    verifier(registre[0].startswith('Date;Pièce;Type;') and len(registre) - 1 == int(pieces)
             and any(';Avoir;' in l and ';-' in l for l in registre),
             'export du registre : une ligne par pièce, avoirs en montants négatifs')
    avoir = valeur(f"select a.id || '|' || a.numero from public.avoirs a join public.remboursements r on r.id = a.remboursement_id where r.paiement_id = '{carte['paiement']}'").split('|')
    await page.goto(SITE + f'admin/finances/?avoir={avoir[0]}')
    await page.wait_for_selector('.doc')
    doc = await page.inner_text('.doc')
    facture_carte = valeur(f"select numero from public.factures where course_id = '{carte['id']}'")
    verifier('AVOIR' in doc.upper() and avoir[1] in doc and facture_carte in doc and 'Détour non prévu' in doc
             and 'sur la carte de paiement' in doc, 'avoir imprimable : numéro, facture corrigée, motif, remboursement sur la carte')
    await page.screenshot(path=f'{CAPTURES}/admin-avoir-ecran.png', full_page=True)
    await page.get_by_role('link', name=facture_carte).click()
    await page.wait_for_selector('.doc')
    doc = await page.inner_text('.doc')
    verifier('FACTURE' in doc.upper() and facture_carte in doc and 'Transport de personnes en VTC' in doc and 'Détail du prix (TTC)' in doc
             and 'Majoration de nuit (+30 %)' in doc and 'Total TTC' in doc and 'ACQUITTÉE' in doc.upper() and 'LOC RÉACTION S.A.S' in doc,
             'facture imprimable : désignation, détail du prix (majoration de nuit), totaux, acquittée')
    verifier(avoir[1] in await page.inner_text('.carte-admin.non-imprimable'), 'facture : ses avoirs signalés à l\'écran (jamais imprimés)')
    await page.screenshot(path=f'{CAPTURES}/admin-facture-ecran.png', full_page=True)
    await page.emulate_media(media='print')
    verifier(not await page.locator('#admin-menu').is_visible() and not await page.locator('.barre-document').is_visible()
             and not await page.locator('.carte-admin.non-imprimable').is_visible(), 'impression : seulement la facture')
    await page.pdf(path=f'{CAPTURES}/admin-facture.pdf', format='A4', print_background=True, prefer_css_page_size=True)
    await page.emulate_media(media='screen')

    # 8. Remboursements du mois
    await page.goto(SITE + 'admin/finances/?vue=remboursements')
    await page.wait_for_selector('#liste-remboursements tbody tr')
    nb_remb = int(valeur("select count(*) from public.remboursements where cree_le >= date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris'"))
    verifier(await page.locator('#liste-remboursements tbody tr').count() == min(nb_remb, 50)
             and await page.locator(f'#liste-remboursements a:text("{avoir[1]}")').count() == 1,
             f'remboursements du mois : {nb_remb}, avec le lien vers leur avoir')

    # 9. TVA et dossier pour l'expert-comptable
    await page.goto(SITE + 'admin/finances/?vue=tva')
    await page.wait_for_selector('#tableau-tva tbody tr')
    verifier(await page.locator('#tableau-tva tbody tr').count() == 17, 'TVA : 12 mois, 4 trimestres, l\'année')
    annee = int(valeur("select extract(year from now() at time zone 'Europe/Paris')"))
    tva = json.loads(appel_rpc('admin_tva', {'p_annee': annee}, ADMIN)[1])
    mois_courant = valeur("select to_char(now() at time zone 'Europe/Paris', 'YYYY-MM')")
    exigible = next(m for m in tva['mois'] if m['periode'] == mois_courant)['tva_exigible']
    nom_mois = valeur("select (array['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'])[extract(month from now() at time zone 'Europe/Paris')]")
    ligne_mois = (await page.locator('#tableau-tva tbody tr', has_text=f'{nom_mois} {annee}').inner_text()).replace(' ', '')
    verifier(f'{exigible:.2f}'.replace('.', ',') in ligne_mois, f'TVA sur encaissements du mois : {exigible} €, comme la base')
    await page.select_option('#dossier-periode', 'mois')
    async with page.expect_download() as telechargement:
        await page.get_by_role('button', name=re.compile('^Télécharger le dossier')).click()
    import zipfile
    archive = zipfile.ZipFile(await (await telechargement.value).path())
    noms = [n.split('/')[-1] for n in archive.namelist()]
    verifier(archive.testzip() is None and 'LISEZ-MOI.txt' in noms and '1-registre-factures-et-avoirs.csv' in noms
             and '2-journal-des-encaissements.csv' in noms and '4-remises-especes-des-chauffeurs.csv' in noms
             and any(n.startswith('6-sommes-dues-au-') for n in noms) and '7-releves-des-plateformes.csv' in noms,
             f'dossier ZIP : archive valable, {len(noms)} fichiers (LISEZ-MOI, registre, encaissements, remises, sommes dues, relevés des plateformes…)')
    lisez_moi = archive.read(next(n for n in archive.namelist() if n.endswith('LISEZ-MOI.txt'))).decode('utf-8-sig')
    verifier('7. Relevés des plateformes' in lisez_moi, 'LISEZ-MOI : les relevés des plateformes présentés')
    registre_zip = archive.read(next(n for n in archive.namelist() if n.endswith('1-registre-factures-et-avoirs.csv'))).decode('utf-8-sig')
    verifier(registre_zip.count('\r\n') == int(pieces), 'dossier ZIP : le registre du mois, une ligne par pièce')
    await page.screenshot(path=f'{CAPTURES}/admin-finances-tva.png', full_page=True)

    # 10. Fiche de la course : factures et avoirs, avec leurs liens
    await page.goto(SITE + f"admin/courses/?id={du_jour['id']}")
    await page.wait_for_selector('#titre-paiements')
    verifier(await page.locator('#vue-fiche a[href*="finances/?avoir="]').count() == 1
             and await page.locator('#vue-fiche a[href*="finances/?facture="]').count() == 1,
             'fiche de la course : facture et avoir, chacun ouvrant sa pièce imprimable')
    await ctx.close()

    # Téléphone
    ctx, page, _ = await entrer(nav, mobile=True)
    for vue, attente, capture in [('a_encaisser', '#liste-paiements tbody tr', 'admin-finances-telephone'),
                                  ('especes', '#liste-chauffeurs tbody tr', 'admin-finances-especes-telephone'),
                                  ('factures', '#liste-registre tbody tr', 'admin-finances-factures-telephone'),
                                  ('tva', '#tableau-tva tbody tr', 'admin-finances-tva-telephone')]:
        await page.goto(SITE + f'admin/finances/?vue={vue}')
        await page.wait_for_selector(attente)
        verifier(await page.evaluate('document.documentElement.scrollWidth <= screen.width'),
                 f'téléphone : « {vue} » sans défilement horizontal de la page')
        await page.screenshot(path=f'{CAPTURES}/{capture}.png', full_page=True)
    id_facture = valeur(f"select id from public.factures where course_id = '{carte['id']}'")
    await page.goto(SITE + f'admin/finances/?facture={id_facture}')
    await page.wait_for_selector('.doc')
    verifier(await page.evaluate('document.documentElement.scrollWidth <= screen.width'), 'téléphone : facture sans défilement de la page')
    await page.screenshot(path=f'{CAPTURES}/admin-facture-telephone.png', full_page=True)
    await ctx.close()


def euros_fr(v):
    """« 1549.49 » → « 1 549,49 € » (affichage français, espaces ordinaires)."""
    entier, _, decimales = f'{float(v):.2f}'.partition('.')
    groupes = []
    while len(entier) > 3:
        groupes.insert(0, entier[-3:])
        entier = entier[:-3]
    groupes.insert(0, entier)
    return f"{' '.join(groupes)},{decimales} €"


def texte(s):
    """Texte affiché, espaces insécables remplacées (montants en euros à la française)."""
    return s.replace(' ', ' ').replace(' ', ' ')


async def plateformes(nav):
    print('Plateformes')
    from banc import FICHIERS_DEPOSES, FICHIERS_RETIRES
    lundi = valeur("select date_trunc('week', now() at time zone 'Europe/Paris')::date::text")
    s3_debut = valeur(f"select ('{lundi}'::date - 21)::text")
    s3_fin = valeur(f"select ('{lundi}'::date - 15)::text")
    du = s3_debut
    au = valeur("select (now() at time zone 'Europe/Paris')::date::text")
    ctx, page, _ = await entrer(nav, mobile=False)

    # 1. Relevés de la période : chiffres clés et liste conformes à la base
    await page.goto(SITE + f'admin/plateformes/?vue=releves&du={du}&au={au}')
    await page.wait_for_selector('#liste-releves tbody tr')
    verifier(await page.inner_text('.admin-titre') == 'Plateformes'
             and await page.get_attribute('.admin-lien[data-module="plateformes"]', 'aria-current') == 'page',
             'module Plateformes ouvert, signalé dans le menu')
    attendu = valeur(f"select count(*) || '|' || to_char(sum(montant_trajets), 'FM999990.00') from public.releves_plateformes where fin between '{du}' and '{au}'").split('|')
    tuiles = [texte(t) for t in await page.locator('#chiffres-releves .chiffre-cle').all_inner_texts()]
    verifier(len(tuiles) == 4 and attendu[1].replace('.', ',') in tuiles[0].replace(' ', '') and f'{attendu[0]} relevés' in tuiles[0],
             f'case « Trajets » : {attendu[1]} € sur {attendu[0]} relevés')
    verifier(await page.locator('#liste-releves tbody tr').count() == int(attendu[0]), 'une ligne par relevé de la période')
    verifier('Bolt' in await page.inner_text('#resume-releves') and 'Uber' in await page.inner_text('#resume-releves'),
             'résumé par plateforme (Bolt, Uber)')

    # 2. Ajout d'un relevé Heetch avec son PDF : net et montant viré calculés pendant la saisie
    await page.get_by_role('button', name='Ajouter un relevé').click()
    f = await fenetre(page)
    await f.locator('select[name=plateforme]').select_option('heetch')
    await f.locator('select[name=chauffeur]').select_option(CHAUFFEUR)
    await f.locator('input[name=debut]').fill(s3_debut)
    await f.locator('input[name=fin]').fill(s3_fin)
    await f.locator('input[name=trajets]').fill('230,40')
    await f.locator('input[name=frais]').fill('34,56')
    await f.locator('input[name=especes]').fill('50')
    await f.locator('input[name=nb_courses]').fill('9')
    apercu = texte(await f.locator('.apercu-calcul').inner_text())
    verifier('Net calculé : 195,84 €' in apercu and 'viré : 145,84 €' in apercu and 'frais 15 %' in apercu,
             f'saisie : net, montant viré et taux des frais recalculés à la frappe ({apercu})')
    await page.set_input_files('#releve-fichier', files=[{'name': 'releve-heetch.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 essai'}])
    await f.get_by_role('button', name='Ajouter le relevé').click()
    await fermee(page)
    heetch = valeur(f"select id || '|' || montant_net || '|' || virement || '|' || coalesce(fichier_chemin, '') from public.releves_plateformes where plateforme = 'heetch' and chauffeur_id = '{CHAUFFEUR}' and debut = '{s3_debut}'").split('|')
    verifier(heetch[1] == '195.84' and heetch[2] == '145.84' and heetch[3].startswith(f'releves/{heetch[0]}/'),
             'relevé Heetch enregistré : net 195,84 €, viré 145,84 €, PDF joint')
    verifier(f'administration/{heetch[3]}' in FICHIERS_DEPOSES, 'PDF déposé dans le dossier privé de l\'administration')

    # 3. Second relevé Heetch sur la même semaine : refusé, message exact
    await page.get_by_role('button', name='Ajouter un relevé').click()
    f = await fenetre(page)
    await f.locator('select[name=plateforme]').select_option('heetch')
    await f.locator('select[name=chauffeur]').select_option(CHAUFFEUR)
    await f.locator('input[name=debut]').fill(s3_debut)
    await f.locator('input[name=fin]').fill(s3_fin)
    await f.locator('input[name=trajets]').fill('10')
    await f.locator('input[name=frais]').fill('1')
    await f.get_by_role('button', name='Ajouter le relevé').click()
    await page.wait_for_selector('dialog.fenetre .alerte:not([hidden])')
    message = await f.locator('.alerte').inner_text()
    verifier(message.startswith('Paul Bernard a déjà un relevé Heetch du ') and 'corrigez-le plutôt' in message,
             f'chevauchement refusé : {message}')
    await f.get_by_role('button', name='Annuler').click()
    await fermee(page)

    # 4. Correction : les frais mal recopiés
    ligne = page.locator('#liste-releves tbody tr', has_text='Heetch')
    await ligne.get_by_role('button', name='Corriger').click()
    f = await fenetre(page)
    await f.locator('input[name=frais]').fill('34,60')
    verifier('Net calculé : 195,80 €' in texte(await f.locator('.apercu-calcul').inner_text()), 'correction : net recalculé à la frappe')
    await f.get_by_role('button', name='Enregistrer').click()
    await fermee(page)
    verifier(valeur(f"select frais_service || '|' || montant_net from public.releves_plateformes where id = '{heetch[0]}'") == '34.60|195.80',
             'relevé corrigé dans la base')

    # 5. PDF : consultation par lien signé, puis remplacement (l'ancien est retiré)
    ligne = page.locator('#liste-releves tbody tr', has_text='Heetch')
    async with page.expect_popup() as fenetre_pdf:
        await ligne.get_by_role('button', name='Voir').click()
    pdf = await fenetre_pdf.value
    await pdf.wait_for_url(re.compile('object/sign/administration/releves/'))
    verifier(f'administration/releves/{heetch[0]}/' in pdf.url, 'PDF du relevé ouvert par un lien signé')
    await pdf.close()
    await ligne.get_by_role('button', name='Remplacer').click()
    f = await fenetre(page)
    await page.set_input_files('#releve-pdf', files=[{'name': 'releve-heetch-v2.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 essai 2'}])
    await f.get_by_role('button', name='Joindre').click()
    await fermee(page)
    nouveau = valeur(f"select fichier_chemin from public.releves_plateformes where id = '{heetch[0]}'")
    verifier(nouveau != heetch[3] and f'administration/{heetch[3]}' in FICHIERS_RETIRES, 'PDF remplacé : l\'ancien est retiré du dossier')

    # 6. Export CSV, ordre chronologique
    async with page.expect_download() as telechargement:
        await page.get_by_role('button', name='Exporter (CSV)').click()
    lignes_csv = open(await (await telechargement.value).path(), encoding='utf-8-sig', newline='').read().split('\r\n')
    nb = int(valeur(f"select count(*) from public.releves_plateformes where fin between '{du}' and '{au}'"))
    verifier(lignes_csv[0].startswith('Plateforme;Chauffeur;Du;Au;Courses;Trajets TTC;Frais de service;') and len(lignes_csv) == nb + 1
             and lignes_csv[1].startswith('Heetch;Paul Bernard;'),
             f'export CSV : en-têtes, {nb} relevés, le plus ancien d\'abord')
    await page.screenshot(path=f'{CAPTURES}/admin-plateformes-releves.png', full_page=True)

    # 7. Rentabilité : chiffres égaux à ceux de la base
    await page.get_by_role('tab', name='Rentabilité par chauffeur').click()
    await page.wait_for_function("location.search.includes('vue=rentabilite')")
    await page.fill('#rentabilite-du', du)
    await page.fill('#rentabilite-au', au)
    await page.locator('#rentabilite-au').dispatch_event('change')
    await page.wait_for_function(f"location.search.includes('du={du}')")
    await page.wait_for_selector('#liste-rentabilite tbody tr')
    renta = json.loads(appel_rpc('admin_rentabilite_chauffeurs', {'p_debut': du, 'p_fin': au}, ADMIN)[1])
    paul = next(c for c in renta['chauffeurs'] if c['chauffeur_id'] == CHAUFFEUR)
    ligne = texte(await page.locator('#liste-rentabilite tbody tr', has_text='Paul Bernard').inner_text())
    marge = f"{paul['marge']:,.2f}".replace(',', ' ').replace('.', ',')
    verifier(marge in ligne and f"{paul['plateformes']['releves']} relevés" in ligne,
             f'rentabilité de Paul : marge {marge} € et relevés comme dans la base')
    tuiles = [texte(t) for t in await page.locator('#chiffres-rentabilite .chiffre-cle').all_inner_texts()]
    ca = f"{renta['totaux']['ca_ht']:,.2f}".replace(',', ' ').replace('.', ',')
    verifier(len(tuiles) == 5 and ca in tuiles[0] and '% des trajets' in tuiles[1],
             f'chiffres clés : chiffre d\'affaires HT {ca} €, taux moyen des frais')
    async with page.expect_download() as telechargement:
        await page.get_by_role('button', name='Exporter (CSV)').click()
    contenu = open(await (await telechargement.value).path(), encoding='utf-8-sig', newline='').read().split('\r\n')
    verifier(contenu[0].startswith('Chauffeur;Statut;Courses en direct;Direct HT;') and len(contenu) == len(renta['chauffeurs']) + 1,
             'export de la rentabilité : une ligne par chauffeur')
    await page.screenshot(path=f'{CAPTURES}/admin-plateformes-rentabilite.png', full_page=True)

    # 8. Suppression d'un relevé : PDF retiré, trace au journal
    await page.goto(SITE + f'admin/plateformes/?vue=releves&du={du}&au={au}')
    await page.wait_for_selector('#liste-releves tbody tr')
    await page.locator('#liste-releves tbody tr', has_text='Heetch').get_by_role('button', name='Supprimer').click()
    f = await fenetre(page)
    await f.get_by_role('button', name='Supprimer').click()
    await fermee(page)
    verifier(valeur(f"select count(*) from public.releves_plateformes where id = '{heetch[0]}'") == '0'
             and f'administration/{nouveau}' in FICHIERS_RETIRES
             and valeur(f"select count(*) from prive.journal where table_cible = 'releves_plateformes' and ligne_id = '{heetch[0]}' and action = 'DELETE'") == '1',
             'relevé supprimé : PDF retiré du dossier, suppression gardée au journal')
    await ctx.close()

    # Téléphone : aucune page plus large que l'écran
    ctx, page, _ = await entrer(nav, mobile=True)
    for vue, attente, capture in [('releves', '#liste-releves tbody tr', 'admin-plateformes-telephone'),
                                  ('rentabilite', '#liste-rentabilite tbody tr', 'admin-plateformes-rentabilite-telephone')]:
        await page.goto(SITE + f'admin/plateformes/?vue={vue}&du={du}&au={au}')
        await page.wait_for_selector(attente)
        verifier(await page.evaluate('document.documentElement.scrollWidth <= screen.width'),
                 f'téléphone : « {vue} » sans défilement horizontal de la page')
        await page.screenshot(path=f'{CAPTURES}/{capture}.png', full_page=True)
    await page.goto(SITE + f'admin/plateformes/?vue=releves&du={du}&au={au}')
    await page.wait_for_selector('#liste-releves tbody tr')
    await page.get_by_role('button', name='Ajouter un relevé').click()
    await fenetre(page)
    verifier(await page.evaluate('document.documentElement.scrollWidth <= screen.width'), 'téléphone : formulaire de saisie sans défilement horizontal')
    await page.screenshot(path=f'{CAPTURES}/admin-plateformes-saisie-telephone.png')
    await ctx.close()


async def rh(nav):
    print('RH et paie')
    from banc import FICHIERS_DEPOSES
    nadia = valeur("select id from public.salaries where matricule = 'S0002'")
    paul = valeur("select id from public.salaries where matricule = 'S0001'")
    karim = valeur("select id from public.salaries where matricule = 'S0003'")
    ctx, page, _ = await entrer(nav, mobile=False)

    # 1. Salariés : liste et chiffres conformes à la base
    await page.goto(SITE + 'admin/rh/')
    await page.wait_for_selector('#liste-salaries tbody tr')
    verifier(await page.inner_text('.admin-titre') == 'RH et paie'
             and await page.get_attribute('.admin-lien[data-module="rh"]', 'aria-current') == 'page'
             and await page.locator('.onglet[role=tab]').count() == 5,
             'module RH et paie ouvert, signalé dans le menu, cinq onglets')
    nombre = int(valeur("select count(*) from public.salaries"))
    verifier(await page.locator('#liste-salaries tbody tr').count() == nombre, f'une ligne par salarié ({nombre})')
    tuiles = [texte(t) for t in await page.locator('#chiffres-salaries .chiffre-cle').all_inner_texts()]
    verifier(len(tuiles) == 4 and 'Demandes de congés' in tuiles[3], 'quatre chiffres clés, dont les demandes de congés')

    # 2. Nouvelle fiche : contrôle du n° de Sécurité sociale, puis création
    await page.get_by_role('button', name='Ajouter un salarié').click()
    f = await fenetre(page)
    verifier(await f.locator('textarea[name=repartition_horaire]').is_hidden(), 'fiche : répartition des heures masquée pour un temps plein')
    await f.locator('select[name=civilite]').select_option('Monsieur')
    await f.locator('input[name=prenom]').fill('Yanis')
    await f.locator('input[name=nom]').fill('Durand')
    await f.locator('input[name=date_naissance]').fill('1990-04-15')
    await f.locator('input[name=lieu_naissance]').fill('Creil')
    await f.locator('input[name=nationalite]').fill('Française')
    await f.locator('input[name=numero_securite_sociale]').fill('1 90 04 60 159 001 00')
    await f.locator('input[name=adresse]').fill('5 rue de la Gare')
    await f.locator('input[name=code_postal]').fill('60100')
    await f.locator('input[name=ville]').fill('Creil')
    await f.locator('input[name=qualification]').fill('Employé')
    await f.locator('input[name=lieu_travail]').fill('Île-de-France, au départ du dépôt de Chaumontel')
    await f.locator('input[name=date_entree]').fill('2026-10-01')
    await f.locator('input[name=salaire_base_mensuel]').fill('2 100')
    await f.get_by_role('button', name='Créer la fiche').click()
    verifier('La clé ne correspond pas' in await f.inner_text(), 'fiche : n° de Sécurité sociale avec une clé fausse refusé à la saisie')
    cle = 97 - (1900460159001 % 97)
    await f.locator('input[name=numero_securite_sociale]').fill(f'1 90 04 60 159 001 {cle:02d}')
    await f.get_by_role('button', name='Créer la fiche').click()
    await fermee(page)
    yanis = valeur("select id from public.salaries where nom = 'Durand' and prenom = 'Yanis'")
    verifier(valeur(f"select matricule || '|' || numero_securite_sociale || '|' || salaire_base_mensuel from public.salaries where id = '{yanis}'")
             == f'S0005|1900460159001{cle:02d}|2100.00',
             'fiche créée : matricule suivant, n° de Sécurité sociale sans espaces, salaire')

    # 3. Dossier : contrat CDI établi depuis la fiche, sans champ à compléter
    await page.goto(SITE + f'admin/rh/?salarie={yanis}')
    await page.wait_for_selector('#titre-contrats')
    verifier('Pour établir un contrat' not in await page.inner_text('#contenu'), 'dossier : rien ne manque pour établir le contrat')
    await page.get_by_role('button', name='Établir un contrat ou un avenant').click()
    f = await fenetre(page)
    verifier(await f.locator('input[name=essai]').input_value() == '2026-11-30', 'période d\'essai proposée à sa durée maximale (2 mois)')
    await f.get_by_role('button', name='Établir le contrat').click()
    await page.wait_for_url(re.compile(r'rh/\?contrat='))
    await page.wait_for_selector('article.contrat')
    contrat = texte(await page.inner_text('article.contrat'))
    # Taux exact : 4 décimales ne suffisent pas (151,67 × 13,8458 = 2 099,99 €), il en faut 5
    taux = '13,84585'
    open(f'{CAPTURES}/contrat-essai.txt', 'w', encoding='utf-8').write(contrat)
    verifier('contrat de travail à durée indéterminée' in contrat.lower() and 'LOC RÉACTION S.A.S' in contrat,
             'contrat imprimable : titre et employeur')
    verifier('période d\'essai de deux mois, soit jusqu\'au 30 novembre 2026' in contrat, 'contrat : période d\'essai de deux mois, date de fin')
    verifier('35 heures par semaine' in contrat and f'taux horaire brut de {taux} €' in contrat,
             f'contrat : 35 heures, taux horaire exact ({taux} €)')
    verifier('carte professionnelle de conducteur de VTC' in contrat and 'L. 121-6 du Code de la route' in contrat, 'contrat : clauses propres à la conduite de VTC')
    verifier('compléter' not in contrat.lower(), 'contrat : aucun champ à compléter')
    verifier('en qualité de conducteur de VTC' in contrat, 'contrat : emploi en minuscule au fil du texte, sigle conservé')
    await page.screenshot(path=f'{CAPTURES}/admin-rh-contrat-ordinateur.png', full_page=True)
    await page.goto(SITE + f'admin/rh/?salarie={yanis}')
    await page.wait_for_selector('#titre-contrats')
    await page.get_by_role('button', name='Remis pour signature').click()
    await page.wait_for_selector('text=Remis pour signature >> nth=1')
    await page.get_by_role('button', name='Classer le PDF signé').click()
    await fenetre(page)
    await page.set_input_files('#contrat-pdf', files=[{'name': 'contrat-signe.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 essai'}])
    await page.locator('dialog.fenetre').get_by_role('button', name='Classer').click()
    await fermee(page)
    signe = valeur(f"select statut || '|' || pdf_chemin from public.contrats where salarie_id = '{yanis}'").split('|')
    verifier(signe[0] == 'signe' and signe[1].startswith(f'{yanis}/contrats/cdi-2026-10-01') and f'paie/{signe[1]}' in FICHIERS_DEPOSES,
             'contrat signé : PDF classé dans le dossier privé de la paie')

    # 4. Bulletin d'octobre de Nadia : préparation, aperçu calculé par la base, validation
    await page.goto(SITE + f'admin/rh/?vue=bulletins&periode=2026-10-01')
    await page.wait_for_selector('#liste-bulletins tbody tr')
    ligne_nadia = page.locator('#liste-bulletins tbody tr', has_text='Nadia Moreau')
    verifier('À établir' in await ligne_nadia.inner_text(), 'bulletins d\'octobre : celui de Nadia est à établir')
    await ligne_nadia.get_by_role('link', name='Préparer').click()
    await page.wait_for_selector('.apercu-bulletin .chiffre-cle')
    brut_base = texte(await page.locator('.apercu-bulletin .chiffre-cle').first.inner_text())
    verifier('1 900,00 €' in brut_base, f'aperçu : brut d\'un mois complet ({brut_base.splitlines()[1] if len(brut_base.splitlines()) > 1 else brut_base})')
    bloc_primes = page.locator('fieldset.bloc-variables', has_text='Primes et indemnités soumises')
    await bloc_primes.get_by_role('button', name='Ajouter une ligne').click()
    await bloc_primes.locator('.ligne-variable input').first.fill('Prime de qualité')
    await bloc_primes.locator('.ligne-variable input').nth(1).fill('75')
    await page.wait_for_function("document.querySelector('.apercu-bulletin .chiffre-cle') && document.querySelector('.apercu-bulletin .chiffre-cle').textContent.replace(/[\\u00a0\\u202f]/g, ' ').includes('1 975,00')")
    verifier(True, 'aperçu recalculé par la base à la saisie d\'une prime (brut 1 975,00 €)')
    await page.screenshot(path=f'{CAPTURES}/admin-rh-preparation-ordinateur.png', full_page=True)
    await page.get_by_role('button', name='Enregistrer et valider').click()
    f = await fenetre(page)
    await f.get_by_role('button', name='Valider').click()
    await page.wait_for_url(re.compile(r'rh/\?bulletin='))
    await page.wait_for_selector('article.bulletin')
    b = valeur(f"select statut || '|' || brut || '|' || net_a_payer || '|' || (calcul ->> 'net_a_payer') from public.bulletins where salarie_id = '{nadia}' and periode = '2026-10-01'").split('|')
    doc = texte(await page.inner_text('article.bulletin'))
    net = euros_fr(b[2])
    verifier(b[0] == 'valide' and b[1] == '1975.00' and b[2] == b[3]
             and 'bulletin de paie' in doc.lower() and 'octobre 2026' in doc and net in doc,
             f'bulletin validé et imprimable : net à payer {net} identique au calcul de la base')
    verifier('conservez ce bulletin de paie sans limitation de durée' in doc and 'Montant net social' in doc.replace('MONTANT NET SOCIAL', 'Montant net social')
             and 'Taux non personnalisé' in doc and 'SIRET 100 052 570 00019' in doc and 'brouillon' not in doc.lower(),
             'bulletin : mentions obligatoires, taux non personnalisé, identité de l\'employeur')
    await page.screenshot(path=f'{CAPTURES}/admin-rh-bulletin-ordinateur.png', full_page=True)
    await page.get_by_role('button', name='Remis au salarié').click()
    await fenetre(page)
    await page.locator('dialog.fenetre').get_by_role('button', name='Noter comme remis').click()
    await fermee(page)
    verifier(valeur(f"select statut from public.bulletins where salarie_id = '{nadia}' and periode = '2026-10-01'") == 'envoye',
             'bulletin noté comme remis au salarié')

    # 5. Congés et absences : refus motivé de la demande de Paul
    await page.goto(SITE + 'admin/rh/?vue=absences')
    await page.wait_for_selector('#liste-demandes tbody tr')
    await page.locator('#liste-demandes tbody tr', has_text='Paul').get_by_role('button', name='Refuser').click()
    f = await fenetre(page)
    await f.locator('textarea').fill('Période de forte activité : merci de proposer d\'autres dates.')
    await f.get_by_role('button', name='Refuser').click()
    await fermee(page)
    verifier(valeur(f"select statut || '|' || decision_note from public.absences where salarie_id = '{paul}' and debut = '2026-12-21'")
             == 'refusee|Période de forte activité : merci de proposer d\'autres dates.', 'demande de Paul refusée, motif conservé')
    await page.get_by_role('button', name='Ajouter une absence').click()
    f = await fenetre(page)
    await f.locator('select[name=salarie]').select_option(karim)
    await f.locator('select[name=type]').select_option('conges_payes')
    await f.locator('input[name=debut]').fill('2026-11-16')
    await f.locator('input[name=fin]').fill('2026-11-21')
    await f.get_by_role('button', name='Ajouter').click()
    await fermee(page)
    verifier(valeur(f"select jours || '|' || statut from public.absences where salarie_id = '{karim}' and debut = '2026-11-16'") == '6.0|validee',
             'congés de Karim du lundi au samedi : 6 jours ouvrables, acceptés')

    # 6. Temps de travail : heures de Karim (temps partiel), heures complémentaires
    await page.goto(SITE + f'admin/rh/?vue=temps&salarie={karim}&mois=2026-11-01')
    await page.wait_for_selector('.semaine .saisie-heures')
    for jour in ('2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'):
        await page.fill(f'#temps-{jour}', '6,5')
    await page.get_by_role('button', name='Enregistrer les heures').click()
    await page.wait_for_function("document.querySelector('#chiffres-temps') && document.querySelector('#chiffres-temps').textContent.includes('26 h')")
    verifier(valeur(f"select sum(heures) from public.temps_travail where salarie_id = '{karim}' and jour between '2026-11-02' and '2026-11-08'") == '26.00',
             'heures de Karim enregistrées : 26 h la semaine du 2 novembre (2 h complémentaires)')

    # 7. Paramètres de paie : 2026 validés, 2027 à mettre à jour puis valider
    await page.goto(SITE + 'admin/rh/?vue=parametres&annee=2026')
    await page.wait_for_selector('#titre-validation')
    verifier('Validés par l\'expert-comptable' in await page.inner_text('#contenu') and await page.locator('#titre-lignes').count() == 1,
             'paramètres 2026 : validés, lignes de cotisation affichées')
    await page.goto(SITE + 'admin/rh/?vue=parametres&annee=2027')
    await page.wait_for_selector('#titre-validation')
    await page.locator('section', has=page.locator('#titre-constantes')).get_by_role('button', name='Modifier').click()
    f = await fenetre(page)
    await f.locator('input[name=plafond_mensuel_ss]').fill('4 120')
    await f.get_by_role('button', name='Enregistrer').click()
    await fermee(page)
    verifier(valeur("select plafond_mensuel_ss from public.constantes_paie where annee = 2027") == '4120.00', 'constantes 2027 modifiées (plafond)')
    await page.get_by_role('button', name='Valider les paramètres').click()
    f = await fenetre(page)
    await f.locator('input[name=note]').fill('Cabinet Exemple Expertise, le 31/10/2026')
    await f.get_by_role('button', name='Valider').click()
    await fermee(page)
    verifier(valeur("select valide_par_comptable::text || '|' || validation_note from public.constantes_paie where annee = 2027")
             == 'true|Cabinet Exemple Expertise, le 31/10/2026', 'paramètres 2027 validés : qui et quand')
    await page.wait_for_selector('text=Retirer la validation')
    verifier(await page.locator('section', has=page.locator('#titre-constantes')).get_by_role('button', name='Modifier').count() == 0,
             'année validée : plus aucune modification proposée')
    await ctx.close()

    # Téléphone : aucune page plus large que l'écran
    ctx, page, _ = await entrer(nav, mobile=True)
    bulletin = valeur(f"select id from public.bulletins where salarie_id = '{nadia}' and periode = '2026-10-01'")
    contrat_id = valeur(f"select id from public.contrats where salarie_id = '{yanis}'")
    for adresse, attente, capture in [('rh/', '#liste-salaries tbody tr', 'admin-rh-salaries-telephone'),
                                      (f'rh/?salarie={nadia}', '#titre-contrats', 'admin-rh-dossier-telephone'),
                                      (f'rh/?contrat={contrat_id}', 'article.contrat', 'admin-rh-contrat-telephone'),
                                      ('rh/?vue=bulletins&periode=2026-10-01', '#liste-bulletins tbody tr', 'admin-rh-bulletins-telephone'),
                                      (f'rh/?preparer={karim}&periode=2026-10-01', '.apercu-bulletin .chiffre-cle', 'admin-rh-preparation-telephone'),
                                      (f'rh/?bulletin={bulletin}', 'article.bulletin', 'admin-rh-bulletin-telephone'),
                                      ('rh/?vue=absences', '#liste-absences tbody tr', 'admin-rh-absences-telephone'),
                                      (f'rh/?vue=temps&salarie={karim}&mois=2026-11-01', '.semaine', 'admin-rh-temps-telephone'),
                                      ('rh/?vue=parametres&annee=2026', '#titre-lignes', 'admin-rh-parametres-telephone')]:
        await page.goto(SITE + 'admin/' + adresse)
        await page.wait_for_selector(attente)
        verifier(await page.evaluate('document.documentElement.scrollWidth <= screen.width'),
                 f'téléphone : {capture.replace("admin-rh-", "").replace("-telephone", "")} sans défilement horizontal de la page')
        await page.screenshot(path=f'{CAPTURES}/{capture}.png', full_page=True)
    await ctx.close()


ETAPES = {'porte': porte, 'tableau': tableau_de_bord, 'dispatch': dispatch, 'courses': courses,
          'clients': clients, 'entreprises': entreprises, 'finances': finances, 'plateformes': plateformes, 'rh': rh,
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
