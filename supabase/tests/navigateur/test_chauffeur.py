# Banc d'essai de l'espace chauffeur v2 : service, demande entrante, course
# complète, encaissement, note, feuille de route, délai dépassé, refus,
# réservation prise ; onglets Revenus, Courses et Compte, demande reçue sur
# un autre onglet, feuille de route et relevé en PDF ; onglet Compte de la
# salariée : documents (dépôt, vérification, retrait), bulletins et contrat
# imprimables, heures, demande et retrait d'absence ; liens des
# notifications ; déconnexion.
# Joué avec la chauffeuse des scénarios de test (Nadia, salariée).
# Tout ce qui est créé ici est retiré : le parcours de l'administration
# part ensuite du même état.
import asyncio, json, re, time
from decimal import Decimal
from playwright.async_api import async_playwright
from banc import (SITE, CAPTURES, CLIENT, CHAUFFEUSE, ADMIN, PNG_GRIS, FICHIERS_DEPOSES, FICHIERS_RETIRES,
                  systeme, en_tant_que, appel_rpc, session_injectee, routeur, serveur_local, verifier)

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
    verifier('Justificatif de la réservation préalable' in texte and 'Prise en charge' in texte and 'Réservée le' in texte
             and 'null' not in texte, 'feuille de route PDF : réservation préalable, date et lieu de prise en charge')
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
    verifier(f'Chiffred\'affairesdescourses{montant_fr(mois)}' in normaliser(texte) and course['numero'] in texte and 'null' not in texte,
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
    await compte_salariee(ctx, page)
    await page.click('#onglets [data-onglet="accueil"]')
    await page.wait_for_selector('#vue-accueil:not([hidden])')
    verifier(page.url.endswith('/chauffeur/'), 'retour à l\'accueil : adresse sans onglet')
    await page.go_back()
    await page.wait_for_selector('#vue-compte:not([hidden])')
    verifier(True, 'bouton Retour du téléphone : onglet précédent (Compte)')
    await page.click('#onglets [data-onglet="accueil"]')
    await page.wait_for_selector('#vue-accueil:not([hidden])')


def ligne_sql(requete):
    return valeur(requete).split('|')


async def sans_messages(page):
    """Avant une capture : les messages brefs des étapes précédentes (affichés quelques secondes) sont effacés."""
    await page.evaluate("document.getElementById('zone-messages')?.replaceChildren()")


async def message_affiche(page, texte):
    """Attend un message bref (zone en bas de l'écran) contenant « texte »."""
    await page.wait_for_function(f"(document.getElementById('zone-messages')?.textContent || '').includes({json.dumps(texte)})", timeout=8000)


async def compte_salariee(ctx, page):
    """Onglet Compte de la chauffeuse salariée : documents, paie, heures et absences, liens des notifications."""
    nadia = valeur(f"select id from public.salaries where profil_id = '{CHAUFFEUSE}'")
    debut = valeur("select clock_timestamp()::text")          # notifications créées par ce parcours : retirées à la fin

    print('Compte : documents')
    await page.wait_for_selector('#docs-liste .piece')
    permis = page.locator('#docs-liste .piece', has_text='Permis de conduire')
    verifier('Validé' in await permis.inner_text() and await permis.get_by_role('button', name='Retirer').count() == 0,
             'documents : permis validé par LOC RÉACTION, qui ne se retire plus')
    await page.click('#docs-ajouter')
    await page.click('#docs-envoyer')
    verifier(await page.is_visible('#docs-type-erreur') and await page.is_visible('#docs-fichier-erreur'),
             'dépôt : type de document et fichier demandés avant l\'envoi')
    await page.select_option('#docs-type', 'carte_vtc')
    verifier(await page.is_visible('#docs-echeance'), 'carte VTC : fin de validité demandée')
    await page.fill('#docs-numero', 'VTC-0002')
    await page.fill('#docs-echeance', '2025-01-31')
    await page.set_input_files('#docs-fichier', files=[{'name': 'carte-vtc.png', 'mimeType': 'image/png', 'buffer': PNG_GRIS}])
    await page.click('#docs-envoyer')
    verifier('plus valable' in await page.inner_text('#docs-echeance-erreur'), 'dépôt : carte périmée refusée avant l\'envoi')
    echeance = valeur("select ((now() at time zone 'Europe/Paris')::date + 700)::text")
    await page.fill('#docs-echeance', echeance)
    verifier(await page.is_hidden('#docs-echeance-erreur'), 'date corrigée : son message d\'erreur disparaît')
    await sans_messages(page)
    await capture_complete(page, f'{CAPTURES}/chauffeur-compte-depot-telephone.png')
    await page.click('#docs-envoyer')
    await page.wait_for_selector('#docs-formulaire', state='hidden')
    await message_affiche(page, 'Carte professionnelle VTC envoyée : LOC RÉACTION la vérifie.')
    carte = ligne_sql(f"""select id || '|' || statut || '|' || fichier_chemin || '|' || coalesce(numero, '') || '|' || expire_le
                           from public.documents where chauffeur_id = '{CHAUFFEUSE}' and type = 'carte_vtc' order by cree_le desc limit 1""")
    verifier(carte[1] == 'en_attente' and re.match(rf'^{CHAUFFEUSE}/carte_vtc-\d+\.png$', carte[2]) is not None
             and carte[3] == 'VTC-0002' and carte[4] == echeance and f'documents/{carte[2]}' in FICHIERS_DEPOSES,
             'carte VTC déposée : en vérification, numéro et date enregistrés, fichier dans le dossier privé de la chauffeuse')
    await page.wait_for_function("document.getElementById('docs-liste').textContent.includes('En cours de vérification')")
    piece = page.locator('#docs-liste .piece', has_text='Carte professionnelle VTC')
    async with page.expect_popup() as fenetre:
        await piece.get_by_role('button', name='Voir').click()
    vue = await fenetre.value
    await vue.wait_for_url(re.compile('object/sign/documents/'))
    verifier(f'object/sign/documents/{carte[2]}' in vue.url, 'Voir : la pièce s\'ouvre par un lien temporaire')
    await vue.close()

    # Vérification par l'administration : refus motivé, vu depuis le lien de la notification
    ok, sortie = appel_rpc('admin_verifier_document', {'p_document': carte[0], 'p_statut': 'refuse',
                                                       'p_commentaire': 'Photo floue : envoyez une photo nette du recto et du verso.'}, ADMIN)
    assert ok, sortie
    lien = valeur(f"select lien from public.notifications where destinataire_id = '{CHAUFFEUSE}' and titre = 'Document refusé' order by cree_le desc limit 1")
    verifier(lien == '/chauffeur/documents/', 'notification « Document refusé » : lien vers les documents')
    await page.goto(SITE + lien.lstrip('/'))
    await page.wait_for_url(re.compile(r'/chauffeur/\?onglet=compte#compte-documents$'))
    await page.wait_for_function("document.getElementById('docs-liste')?.textContent.includes('Refusé')", timeout=8000)
    await page.wait_for_function("Math.abs(document.getElementById('compte-documents').getBoundingClientRect().top) < 60", timeout=5000)
    verifier(await page.is_visible('#vue-compte'), 'lien de la notification : onglet Compte, section Mes documents en haut de l\'écran')
    piece = page.locator('#docs-liste .piece', has_text='Carte professionnelle VTC')
    texte = await piece.inner_text()
    verifier('Refusé' in texte and 'Motif : Photo floue' in texte and await piece.get_by_role('button', name='Retirer').count() == 0,
             'document refusé : motif de LOC RÉACTION affiché')
    await sans_messages(page)
    await capture_complete(page, f'{CAPTURES}/chauffeur-compte-documents-telephone.png')

    # Retrait d'une pièce en vérification ; puis retrait d'une pièce validée entre-temps
    for type_piece, libelle in (('justificatif_domicile', 'Justificatif de domicile'), ('piece_identite', 'Pièce d\'identité')):
        await page.click('#docs-ajouter')
        await page.select_option('#docs-type', type_piece)
        if type_piece == 'piece_identite':
            await page.fill('#docs-echeance', echeance)
        await page.set_input_files('#docs-fichier', files=[{'name': f'{type_piece}.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 essai'}])
        await page.click('#docs-envoyer')
        await page.wait_for_selector('#docs-formulaire', state='hidden')
        await page.wait_for_function(f"document.getElementById('docs-liste').textContent.includes({json.dumps(libelle)})")
    domicile = ligne_sql(f"select id || '|' || fichier_chemin from public.documents where chauffeur_id = '{CHAUFFEUSE}' and type = 'justificatif_domicile'")
    await page.locator('#docs-liste .piece', has_text='Justificatif de domicile').get_by_role('button', name='Retirer').click()
    await message_affiche(page, 'Document retiré.')
    await page.wait_for_function("!document.getElementById('docs-liste').textContent.includes('Justificatif de domicile')")
    verifier(valeur(f"select count(*) from public.documents where id = '{domicile[0]}'") == '0' and f'documents/{domicile[1]}' in FICHIERS_RETIRES,
             'retrait d\'une pièce en vérification : ligne et fichier retirés')
    identite = valeur(f"select id from public.documents where chauffeur_id = '{CHAUFFEUSE}' and type = 'piece_identite'")
    ok, sortie = appel_rpc('admin_verifier_document', {'p_document': identite, 'p_statut': 'valide'}, ADMIN)
    assert ok, sortie
    await page.locator('#docs-liste .piece', has_text='Pièce d\'identité').get_by_role('button', name='Retirer').click()
    await message_affiche(page, 'déjà vérifié ce document')
    await page.wait_for_function("document.getElementById('docs-liste').textContent.includes('Validé') && document.querySelectorAll('#docs-liste .etat-piece[data-statut=\"valide\"]').length === 2")
    verifier(valeur(f"select statut from public.documents where id = '{identite}'") == 'valide'
             and 'Validé' in await page.locator('#docs-liste .piece', has_text='Pièce d\'identité').inner_text(),
             'pièce validée entre-temps : non retirée, message clair, liste à jour')
    systeme(f"""delete from public.documents where id in ('{carte[0]}', '{identite}');
               delete from public.notifications where destinataire_id = '{CHAUFFEUSE}' and titre in ('Document refusé', 'Document validé')
                 and cree_le >= '{debut}';""")

    print('Compte : paie')
    await page.wait_for_selector('#compte-paie:not([hidden]) #paie-bulletins .piece')
    bulletins = valeur(f"select count(*) from public.bulletins where salarie_id = '{nadia}' and statut <> 'brouillon'")
    dernier = ligne_sql(f"""select id || '|' || net_a_payer || '|' || coalesce(pdf_chemin, '') from public.bulletins
                             where salarie_id = '{nadia}' and statut <> 'brouillon' order by periode desc limit 1""")
    verifier(await page.locator('#paie-bulletins .piece').count() == int(bulletins)
             and montant_fr(dernier[1]) in normaliser(await page.inner_text('#paie-bulletins .piece >> nth=0')),
             f'paie : {bulletins} bulletins validés, le plus récent en tête avec son net à payer')
    lien_bulletin = await page.get_attribute('#paie-bulletins .piece >> nth=0 >> a', 'href')
    verifier(lien_bulletin == f'document/?type=bulletin&id={dernier[0]}', 'paie : bulletin imprimable')
    contrat = ligne_sql(f"""select id || '|' || type || '|' || statut || '|' || coalesce(pdf_chemin, '') from public.contrats
                             where salarie_id = '{nadia}' and statut <> 'brouillon' order by date_debut desc limit 1""")
    texte = await page.inner_text('#paie-contrats')
    verifier(contrat[1] in texte and ('Signé' in texte if contrat[2] == 'signe' else True) and ('PDF signé' in texte) == bool(contrat[3]),
             f'paie : contrat {contrat[1]} ({contrat[2]}), PDF signé disponible')
    await page.evaluate("document.getElementById('compte-paie').scrollIntoView()")
    await sans_messages(page)
    await page.screenshot(path=f'{CAPTURES}/chauffeur-compte-paie-telephone.png')

    doc = await ctx.new_page()
    doc.on('pageerror', lambda e: console.append(f'pageerror (document) : {e}'))
    await doc.goto(SITE + 'chauffeur/' + lien_bulletin)
    await doc.wait_for_selector('#document .doc.bulletin')
    texte = await doc.inner_text('#document')
    verifier('BULLETIN DE PAIE' in texte.upper() and 'NADIA MOREAU' in texte.upper() and 'LOC RÉACTION S.A.S' in texte
             and montant_fr(dernier[1]) in normaliser(texte) and 'null' not in texte,
             'bulletin imprimable : employeur, salariée, net à payer comme dans la base')
    verifier((await doc.locator('.barre-document button', has_text='PDF remis').count() == 1) == bool(dernier[2]),
             'bulletin : « PDF remis » quand LOC RÉACTION l\'a joint')
    await doc.screenshot(path=f'{CAPTURES}/chauffeur-bulletin-telephone.png', full_page=True)
    await doc.emulate_media(media='print')
    verifier(await doc.is_hidden('.barre-document') and await doc.is_visible('#document .doc'), 'impression du bulletin : le document seul')
    await doc.emulate_media(media='screen')
    await doc.goto(SITE + f'chauffeur/document/?type=contrat&id={contrat[0]}')
    await doc.wait_for_selector('#document .doc')
    texte = await doc.inner_text('#document')
    verifier('CONTRAT DE TRAVAIL À DURÉE INDÉTERMINÉE' in texte.upper() and 'NADIA' in texte.upper() and 'LOC RÉACTION S.A.S' in texte
             and 'Article 1' in texte and 'null' not in texte, 'contrat imprimable : texte établi par LOC RÉACTION, parties, articles')
    if contrat[3]:
        async with doc.expect_popup() as fenetre:
            await doc.locator('.barre-document button', has_text='PDF signé').click()
        vue = await fenetre.value
        await vue.wait_for_url(re.compile('object/sign/paie/'))
        verifier(f'object/sign/paie/{contrat[3]}' in vue.url, 'contrat : PDF signé ouvert par un lien temporaire')
        await vue.close()
    await doc.screenshot(path=f'{CAPTURES}/chauffeur-contrat-telephone.png', full_page=True)
    await doc.goto(SITE + 'chauffeur/document/?type=bulletin&id=00000000-0000-4000-8000-000000000000')
    await doc.wait_for_selector('#erreur:not([hidden]) .alerte')
    verifier('introuvable' in await doc.inner_text('#erreur'), 'bulletin inconnu : message clair')
    await doc.close()

    print('Compte : heures et absences')
    absences = valeur(f"select count(*) from public.absences where salarie_id = '{nadia}'")
    verifier(await page.locator('#absences-liste .piece').count() == int(absences) and 'Acceptée' in await page.inner_text('#absences-liste'),
             f'absences : {absences} absences, avec la réponse de LOC RÉACTION')
    verifier(re.match(r"^Heures d(e |')[a-zéû]+$", await page.inner_text('#planning-chiffres div:first-child dt')) is not None,
             'heures du mois en cours : « ' + await page.inner_text('#planning-chiffres div:first-child dt') + ' »')
    await page.click('#absence-demander')
    hier = valeur("select ((now() at time zone 'Europe/Paris')::date - 1)::text")
    await page.fill('#absence-debut', hier)
    await page.fill('#absence-fin', hier)
    await page.click('#absence-envoyer')
    verifier('déjà passé' in await page.inner_text('#absence-debut-erreur'), 'demande : premier jour passé refusé avant l\'envoi')
    lundi = valeur("select date_trunc('week', (now() at time zone 'Europe/Paris')::date + 63)::date::text")
    mardi = valeur(f"select ('{lundi}'::date + 1)::text")
    await page.select_option('#absence-type', 'conges_payes')
    await page.fill('#absence-debut', lundi)
    verifier(await page.is_hidden('#absence-debut-erreur'), 'premier jour corrigé : son message d\'erreur disparaît')
    await page.fill('#absence-fin', mardi)
    await page.fill('#absence-commentaire', 'Rendez-vous à la préfecture')
    await sans_messages(page)
    await capture_complete(page, f'{CAPTURES}/chauffeur-absence-telephone.png')
    await page.click('#absence-envoyer')
    await page.wait_for_selector('#absence-formulaire', state='hidden')
    demande = ligne_sql(f"""select id || '|' || statut || '|' || jours || '|' || prive.jours_ouvrables(debut, fin) || '|' || coalesce(commentaire, '')
                             from public.absences where salarie_id = '{nadia}' and debut = '{lundi}'""")
    verifier(demande[1] == 'demandee' and Decimal(demande[2]) == Decimal(demande[3]) and demande[4] == 'Rendez-vous à la préfecture',
             f'demande de congés payés enregistrée : en attente, {demande[3]} jours ouvrables comptés par la base')
    await page.wait_for_function("document.getElementById('absences-liste').textContent.includes('En attente de réponse')")
    verifier(await page.inner_text('#planning-chiffres div:nth-child(2) dd') == '1', 'heures et absences : 1 demande en attente')
    await page.click('#absence-demander')
    await page.fill('#absence-debut', mardi)
    await page.fill('#absence-fin', mardi)
    await page.click('#absence-envoyer')
    await message_affiche(page, 'Une absence est déjà enregistrée')
    verifier(await page.is_visible('#absence-formulaire'), 'jours déjà demandés : refusés par la base, message affiché, formulaire gardé')
    await page.click('#absence-formulaire >> text=Annuler')
    await page.locator('#absences-liste .piece', has_text='En attente de réponse').get_by_role('button', name='Retirer la demande').click()
    await message_affiche(page, 'Demande retirée.')
    await page.wait_for_function("!document.getElementById('absences-liste').textContent.includes('En attente de réponse')")
    verifier(valeur(f"select count(*) from public.absences where id = '{demande[0]}'") == '0', 'demande retirée : plus dans la base')

    # Demande acceptée pendant que l'écran est ouvert : le retrait est refusé, la liste se met à jour
    ok, sortie = en_tant_que(CHAUFFEUSE, f"insert into public.absences (salarie_id, type, debut, fin) values ('{nadia}', 'sans_solde', '{lundi}', '{lundi}') returning id")
    assert ok, sortie
    sans_solde = sortie.strip().splitlines()[0]
    await page.click('#onglets [data-onglet="accueil"]')
    await page.click('#onglets [data-onglet="compte"]')
    await page.wait_for_function("document.getElementById('absences-liste').textContent.includes('En attente de réponse')")
    ok, sortie = appel_rpc('admin_decider_absence', {'p_absence': sans_solde, 'p_decision': 'validee'}, ADMIN)
    assert ok, sortie
    await page.locator('#absences-liste .piece', has_text='En attente de réponse').get_by_role('button', name='Retirer la demande').click()
    await message_affiche(page, 'déjà répondu à cette demande')
    await page.wait_for_function("!document.getElementById('absences-liste').textContent.includes('En attente de réponse')")
    verifier(valeur(f"select statut from public.absences where id = '{sans_solde}'") == 'validee',
             'demande acceptée entre-temps : non retirée, message clair, liste à jour')
    systeme(f"""delete from public.absences where id = '{sans_solde}';
               delete from public.notifications where destinataire_id = '{CHAUFFEUSE}' and titre = 'Demande d''absence acceptée'
                 and cree_le >= '{debut}';""")

    print('Liens des notifications')
    await page.goto(SITE + 'chauffeur/revenus/')
    await page.wait_for_url(re.compile(r'/chauffeur/\?onglet=revenus$'))
    await page.wait_for_selector('#vue-revenus:not([hidden]) #revenus-ca')
    verifier(True, 'lien « Pourboire reçu » (/chauffeur/revenus/) : onglet Revenus')
    await page.click('#onglets [data-onglet="compte"]')
    await page.wait_for_selector('#vue-compte:not([hidden]) #compte-profil dd')


async def nouveau_chauffeur(nav):
    """Entrée chauffeur d'un nouveau compte : identité, candidature, dossier et documents,
    validation par LOC RÉACTION (le service s'ouvre) ; compte « chauffeur » sans fiche."""
    marque = str(int(time.time() * 1000))[-9:]
    uid = systeme(f"""set role supabase_auth_admin;
insert into auth.users (email, raw_user_meta_data) values ('nouveau{marque}@exemple.test', '{{}}') returning id;""").splitlines()[-1]
    sans_fiche = systeme(f"""set role supabase_auth_admin;
insert into auth.users (email, raw_user_meta_data)
values ('sansfiche{marque}@exemple.test', '{{"prenom":"Malik","nom":"Benali","telephone":"+33677001122"}}') returning id;""").splitlines()[-1]
    systeme(f"update public.profils set role = 'chauffeur' where id = '{sans_fiche}';")
    try:
        ctx = await nav.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                    locale='fr-FR', timezone_id='Europe/Paris', service_workers='block',
                                    geolocation={'latitude': 48.8530, 'longitude': 2.3500}, permissions=['geolocation'])
        await ctx.add_init_script(session_injectee(uid, f'nouveau{marque}@exemple.test'))
        await ctx.route('**/*', routeur(uid))
        page = await ctx.new_page()
        page.on('console', lambda m: console.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
        page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))

        # Identité incomplète : la page de connexion de l'espace chauffeur la fait compléter
        await page.goto(SITE + 'chauffeur/')
        await page.wait_for_url(re.compile(r'/chauffeur/connexion/$'))
        await page.wait_for_selector('#etape-profil:not([hidden])')
        verifier((await page.text_content('#etape-profil .etiquette-espace')).strip() == 'Espace chauffeur',
                 'nouveau compte : entrée de l\'espace chauffeur, identité demandée')
        await page.fill('#prenom', 'Sami')
        await page.fill('#telephone', '06 77 88 99 00')
        await page.click('#bouton-profil')
        verifier(await page.is_visible('#erreur-nom'), 'identité d\'un chauffeur : le nom est obligatoire')
        await page.fill('#nom', 'Haddad')
        await page.click('#bouton-profil')
        await page.wait_for_url(re.compile(r'/chauffeur/$'))
        await page.wait_for_selector('#dossier #candidature')
        verifier(valeur(f"select prenom || ' ' || nom || ' ' || telephone || ' ' || role from public.profils where id = '{uid}'")
                 == 'Sami Haddad +33677889900 client', 'identité enregistrée ; le compte n\'est pas encore chauffeur')
        verifier(await page.is_hidden('#pastille-etat') and await page.is_hidden('#espace'),
                 'avant validation : ni « en ligne », ni onglets du service')
        verifier('Devenir chauffeur LOC RÉACTION' in await page.inner_text('#dossier-titre'), 'espace chauffeur : candidature « Devenir chauffeur »')

        # Candidature : contrôles, puis envoi
        await page.click('#cand-envoyer')
        verifier(await page.is_visible('#cand-ville-erreur') and await page.is_visible('#cand-experience-erreur')
                 and await page.is_visible('#cand-carte-erreur'), 'candidature : ville, expérience et carte VTC demandées')
        await page.fill('#cand-ville', 'Chaumontel')
        await page.fill('#cand-experience', 'Cinq ans de VTC : transferts aéroports et mises à disposition.')
        await page.check('#cand-carte-oui')
        verifier(await page.is_visible('#cand-carte-numero'), 'carte VTC : numéro et date demandés')
        carte_fin = valeur("select ((now() at time zone 'Europe/Paris')::date + 500)::text")
        await page.fill('#cand-carte-numero', 'VTC-777')
        await page.fill('#cand-carte-date', carte_fin)
        await page.fill('#cand-permis-numero', 'P-123456')
        await sans_messages(page)
        await capture_complete(page, f'{CAPTURES}/chauffeur-candidature-telephone.png')
        await page.click('#cand-envoyer')
        await page.wait_for_selector('#pieces-demandees li')
        verifier(valeur(f"""select k.statut || ' ' || k.ville || ' ' || c.statut || ' ' || c.carte_vtc_numero || ' ' || c.carte_vtc_expiration || ' ' || c.permis_numero
                             from public.candidatures k join public.chauffeurs c on c.id = k.profil_id where k.profil_id = '{uid}'""")
                 == f'nouvelle Chaumontel candidat VTC-777 {carte_fin} P-123456', 'candidature enregistrée : fiche « candidat » avec carte VTC et permis')
        verifier(await page.locator('#pieces-demandees li', has_text='À déposer').count() == 4, 'dossier : 4 documents à fournir')

        # Dépôt du permis depuis le dossier
        await page.click('#docs-ajouter')
        await page.select_option('#docs-type', 'permis')
        await page.fill('#docs-echeance', valeur("select ((now() at time zone 'Europe/Paris')::date + 3000)::text"))
        await page.set_input_files('#docs-fichier', files=[{'name': 'permis.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 essai'}])
        await page.click('#docs-envoyer')
        await page.wait_for_function("document.querySelector('#pieces-demandees li[data-statut=\"en_attente\"]')?.textContent.includes('Permis')")
        verifier(valeur(f"select statut from public.documents where chauffeur_id = '{uid}' and type = 'permis'") == 'en_attente',
                 'dossier : permis déposé, en vérification')
        await sans_messages(page)
        await capture_complete(page, f'{CAPTURES}/chauffeur-dossier-telephone.png')

        # Validation par LOC RÉACTION : le service s'ouvre
        ok, sortie = appel_rpc('valider_candidature', {'p_profil': uid}, ADMIN)
        assert ok, sortie
        await page.reload()
        await page.wait_for_selector('#espace:not([hidden])')
        verifier(await page.inner_text('#pastille-etat') == 'Hors ligne' and await page.is_hidden('#dossier'),
                 'candidature validée : le service de l\'espace chauffeur s\'ouvre')
        await ctx.close()

        # Compte passé « chauffeur » directement dans la base, sans fiche
        ctx = await nav.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                    locale='fr-FR', timezone_id='Europe/Paris', service_workers='block')
        await ctx.add_init_script(session_injectee(sans_fiche, f'sansfiche{marque}@exemple.test'))
        await ctx.route('**/*', routeur(sans_fiche))
        page = await ctx.new_page()
        await page.goto(SITE + 'chauffeur/')
        await page.wait_for_selector('#dossier:not([hidden]) #dossier-titre')
        verifier(await page.inner_text('#dossier-titre') == 'Compte chauffeur à activer'
                 and 'Enregistrer un chauffeur' in await page.inner_text('#dossier'),
                 'rôle « chauffeur » sans fiche : compte à activer, et comment LOC RÉACTION l\'active')
        await page.click('#dossier-deconnexion')
        await page.wait_for_url(re.compile(r'/chauffeur/connexion/$'))
        verifier(True, 'déconnexion depuis le dossier : retour à l\'entrée de l\'espace chauffeur')
        await ctx.close()
    finally:
        # Comptes d'essai retirés (fiche, candidature, documents, notifications suivent)
        systeme(f"delete from auth.users where id in ('{uid}', '{sans_fiche}');")


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
            await page.wait_for_url(re.compile(r'/chauffeur/connexion/$'))
            # (le banc réinjecte la session à chaque page : on s'arrête à l'adresse)
            verifier(valeur(f"select en_ligne from public.positions where chauffeur_id = '{CHAUFFEUSE}'") == 'f',
                     'déconnexion : hors ligne d\'abord, puis entrée de l\'espace chauffeur')

            print('Nouveau chauffeur')
            await nouveau_chauffeur(nav)
            await nav.close()
    finally:
        serveur.terminate()
    utiles = [c for c in console if 'WebSocket' not in c and 'realtime' not in c.lower() and 'ERR_FAILED' not in c]
    # Refus attendu (une seule fois) : demande d'absence sur des jours déjà demandés, refusée par la base
    attendu = 'error: Failed to load resource: the server responded with a status of 400 (Bad Request)'
    if attendu in utiles:
        utiles.remove(attendu)
    print('Erreurs de la console (hors temps réel, injoignable ici, et hors refus attendu de la base) :', utiles or 'aucune')

asyncio.run(main())
