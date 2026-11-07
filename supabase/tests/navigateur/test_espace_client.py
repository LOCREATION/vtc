# Banc d'essai de l'espace client v2 (client/) : onglets Accueil, Activité,
# Compte (lieux, proches, solde, parrainage, compte professionnel, sécurité,
# notifications, données personnelles), cloche des notifications, « Mes
# demandes au support », pourboire en fin de course, lien « Mon compte » de
# l'accueil public.
# Joué avec la cliente des scénarios de test (Claire) ; ce qui est créé ici
# (courses, lieux, proches, demandes, notifications) est retiré, le profil
# remis comme avant.
import asyncio, json, re, time
from playwright.async_api import async_playwright
from banc import (SITE, CAPTURES, CLIENT, CHAUFFEUSE, ADMIN, PNG_GRIS, FICHIERS_DEPOSES, FICHIERS_RETIRES, AuthSimulee,
                  systeme, en_tant_que, appel_rpc, session_injectee, routeur, serveur_local, verifier)

console = []


def valeur(requete):
    return systeme(requete)


def ligne_sql(requete):
    return valeur(requete).split('|')


async def attendre_valeur(requete, attendu, delai=6):
    """Attend (quelques secondes au plus) que la base renvoie « attendu »."""
    fin = time.time() + delai
    while True:
        obtenu = valeur(requete)
        if obtenu == attendu or time.time() > fin:
            break
        await asyncio.sleep(0.3)
    verifier(obtenu == attendu, f'base : {attendu} attendu (obtenu : {obtenu})')


async def message_affiche(page, texte):
    """Attend un message bref (zone en bas de l'écran) contenant « texte »."""
    await page.wait_for_function(f"(document.getElementById('zone-messages')?.textContent || '').includes({json.dumps(texte)})", timeout=8000)


def a_lire_sql():
    """Réponses de LOC RÉACTION que la cliente n'a pas encore lues, toutes demandes confondues."""
    return int(valeur(f"""select count(*) from public.messages m join public.demandes d on d.id = m.demande_id
                            where d.auteur_id = '{CLIENT}' and m.auteur_id <> '{CLIENT}' and m.lu_le is null"""))


async def verifier_a_lire(page, n, libelle):
    """Compte > Aide et support : « n réponses de LOC RÉACTION à lire. » (rien si aucune)."""
    attendu = '' if n == 0 else ('1 réponse de LOC RÉACTION à lire.' if n == 1 else f'{n} réponses de LOC RÉACTION à lire.')
    script = ("(() => { const z = document.getElementById('compte-support-non-lus'); "
              f"return !!z && (z.hidden ? '' : z.textContent) === {json.dumps(attendu)}; }})()")
    try:
        await page.wait_for_function(script, timeout=6000)
    except Exception:
        pass
    verifier(await page.evaluate(script), libelle)


async def support_client(page, debut, demandes_creees):
    """« Mes demandes au support » (commun/support.js) dans l'espace client :
    nouvelle demande depuis Compte (contrôles, course de la cliente), réponse
    avec une photo, réponse de LOC RÉACTION lue (et sa notification), nombre de
    réponses à lire dans Compte, lien d'une notification, pièce jointe retirée
    si la demande a été close entre-temps, « Signaler un problème » depuis la
    page d'une course terminée, adresse /client/demandes/?id=…."""
    print('Mes demandes au support')
    # Les 20 dernières courses de la cliente (celles que propose le formulaire) ; la plus récente terminée
    recentes = f"select * from public.courses where client_id = '{CLIENT}' order by prise_en_charge_le desc limit 20"
    terminee, numero_terminee = ligne_sql(f"select id || '|' || numero from ({recentes}) x where statut = 'terminee' "
                                          "order by prise_en_charge_le desc limit 1")
    await page.click('#onglets [data-onglet="compte"]')
    await page.wait_for_selector('#vue-compte:not([hidden]) #compte-bloc-support')
    a_lire = a_lire_sql()
    await verifier_a_lire(page, a_lire, f'Compte > Aide et support : {a_lire} réponse(s) de LOC RÉACTION à lire au départ')
    await page.click('#compte-nouvelle-demande')
    await page.wait_for_selector('dialog#support[open] #support-vue-nouvelle:not([hidden])')
    verifier(await page.inner_text('#support-titre') == 'Nouvelle demande'
             and await page.get_attribute('#support-sujet', 'placeholder') == 'Ex. : sac oublié dans le véhicule',
             'Compte > « Nouvelle demande » : formulaire du support, exemple adapté au client')
    options = await page.eval_on_selector_all('#support-course option', 'os => os.map(o => o.value)')
    attendues = valeur(f"select string_agg(id::text, ',') from ({recentes}) x").split(',')
    verifier(options[0] == '' and sorted(options[1:]) == sorted(attendues) and terminee in options,
             'nouvelle demande : « Aucune course en particulier », puis les 20 dernières courses de la cliente')
    await page.click('#support-envoyer-demande')
    verifier(await page.is_visible('#support-sujet-erreur') and await page.is_visible('#support-message-erreur'),
             'nouvelle demande vide : sujet et message demandés avant l\'envoi')
    await page.select_option('#support-type', 'objet_perdu')
    await page.select_option('#support-course', terminee)
    await page.fill('#support-sujet', 'Sac oublié dans le véhicule')
    await page.fill('#support-message', "J'ai oublié un sac de sport bleu sur la banquette arrière.")
    await page.click('#support-envoyer-demande')
    await page.wait_for_selector('#support-vue-fil:not([hidden]) #support-fil li')
    demande, numero = ligne_sql(f"select id || '|' || numero from public.demandes where auteur_id = '{CLIENT}' "
                                f"and sujet = 'Sac oublié dans le véhicule' and type = 'objet_perdu' and course_id = '{terminee}'")
    demandes_creees.append(demande)
    await message_affiche(page, f'Demande {numero} envoyée')
    sous_titre = await page.inner_text('#support-sous-titre')
    verifier(numero in sous_titre and 'Ouverte' in sous_titre and numero_terminee in sous_titre,
             'demande envoyée : enregistrée (type, course), son fil s\'ouvre')
    verifier(int(valeur(f"select count(*) from public.notifications where destinataire_id = '{ADMIN}' and cree_le >= '{debut}' "
                        f"and titre = 'Nouvelle demande au support' and lien = '/admin/support/?demande={demande}'")) == 1,
             'nouvelle demande : l\'administration est prévenue (lien direct vers la demande)')

    # Réponse avec une photo
    await page.set_input_files('#support-reponse-fichier', files=[{'name': 'sac.png', 'mimeType': 'image/png', 'buffer': PNG_GRIS}])
    await page.wait_for_selector('#support-piece-choisie:not([hidden])')
    await page.fill('#support-reponse-texte', 'Voici une photo du sac.')
    await page.click('#support-reponse-envoyer')
    await page.wait_for_function("document.querySelectorAll('#support-fil li[data-auteur=\"moi\"]').length === 2")
    chemin = valeur(f"select piece_jointe_chemin from public.messages where demande_id = '{demande}' and piece_jointe_chemin is not null")
    verifier(chemin.startswith(f'{demande}/') and chemin.endswith('.png') and f'support/{chemin}' in FICHIERS_DEPOSES,
             'réponse avec une photo : déposée dans le dossier de la demande, message enregistré')
    verifier(int(valeur(f"select count(*) from public.notifications where destinataire_id = '{ADMIN}' and cree_le >= '{debut}' "
                        f"and titre = 'Nouveau message sur une demande' and lien = '/admin/support/?demande={demande}'")) == 1,
             'réponse de la cliente : l\'administration est prévenue')

    # Réponse de LOC RÉACTION : « 1 réponse non lue », lue à l'ouverture (et sa notification)
    ok, sortie = appel_rpc('admin_repondre_demande', {'p_demande': demande, 'p_message': 'Votre chauffeur a retrouvé le sac.'}, ADMIN)
    assert ok, sortie
    verifier(valeur(f"select count(*) from public.notifications where destinataire_id = '{CLIENT}' and titre = 'Réponse du support' "
                    f"and lien = '/client/demandes/?id={demande}' and lu_le is null") == '1',
             'réponse du support : notification de la cliente avec le lien de son espace')
    await page.click('#support-retour')
    await page.wait_for_selector(f'#support-liste button[data-id="{demande}"]')
    carte = await page.inner_text(f'#support-liste button[data-id="{demande}"]')
    verifier('1 réponse non lue' in carte and 'En cours' in carte and 'Objet oublié' in carte,
             'Mes demandes : « 1 réponse non lue », « En cours », « Objet oublié »')
    await page.click(f'#support-liste button[data-id="{demande}"]')
    await page.wait_for_selector('#support-fil li[data-auteur="equipe"]')
    verifier('Votre chauffeur a retrouvé le sac.' in await page.inner_text('#support-fil li[data-auteur="equipe"]'),
             'fil : réponse de LOC RÉACTION affichée')
    await attendre_valeur(f"select count(*) from public.messages where demande_id = '{demande}' and auteur_id <> '{CLIENT}' and lu_le is null", '0')
    await attendre_valeur(f"select count(*) from public.notifications where destinataire_id = '{CLIENT}' "
                          f"and lien = '/client/demandes/?id={demande}' and lu_le is null", '0')
    verifier(True, 'fil ouvert : réponse marquée « lue », sa notification aussi')

    # Nouvelle réponse pendant que le panneau est fermé : Compte l'annonce, la cloche aussi
    ok, sortie = appel_rpc('admin_repondre_demande', {'p_demande': demande, 'p_message': 'Il vous sera remis demain matin à votre domicile.'}, ADMIN)
    assert ok, sortie
    await page.click('#support-fermer')
    await verifier_a_lire(page, a_lire + 1, 'panneau refermé : Compte compte la nouvelle réponse à lire')
    await page.click('#cloche')
    await page.wait_for_selector('dialog#notifs[open] #notifs-liste li')
    await page.locator('#notifs-liste .notif', has_text='Il vous sera remis demain matin').click()
    await page.wait_for_selector('dialog#support[open] #support-vue-fil:not([hidden])')
    verifier(await page.inner_text('#support-titre') == 'Sac oublié dans le véhicule' and await page.is_hidden('dialog#notifs'),
             'notification « Réponse du support » : la demande s\'ouvre dans le panneau du support')

    # Demande close pendant que la cliente écrit : la photo déposée est retirée
    ok, sortie = appel_rpc('admin_statut_demande', {'p_demande': demande, 'p_statut': 'resolue'}, ADMIN)
    assert ok, sortie
    await page.set_input_files('#support-reponse-fichier', files=[{'name': 'ticket.png', 'mimeType': 'image/png', 'buffer': PNG_GRIS}])
    await page.fill('#support-reponse-texte', 'Merci beaucoup !')
    await page.click('#support-reponse-envoyer')
    await message_affiche(page, 'Réponse non envoyée : cette demande est close.')
    # Ce refus de la base (réponse 400) est voulu : il ne compte pas parmi les erreurs de la console
    for i in range(len(console) - 1, -1, -1):
        if 'status of 400' in console[i]:
            del console[i]
            break
    depose = [f for f in FICHIERS_DEPOSES if f.startswith(f'support/{demande}/') and f != f'support/{chemin}']
    verifier(len(depose) == 1 and depose[0] in FICHIERS_RETIRES,
             'demande close entre-temps : réponse refusée, la photo déposée est retirée (pas de fichier orphelin)')
    await page.click('#support-retour')
    await page.click(f'#support-liste button[data-id="{demande}"]')
    await page.wait_for_selector('#support-fermee:not([hidden])')
    verifier(await page.is_hidden('#support-reponse') and 'Demande résolue' in await page.inner_text('#support-fermee'),
             'demande résolue : plus de réponse, « Nouvelle demande » proposée')
    await page.evaluate("document.getElementById('zone-messages')?.replaceChildren()")
    await page.screenshot(path=f'{CAPTURES}/client-support-fil.png')
    await page.click('#support-fermer')
    await verifier_a_lire(page, a_lire, 'réponses lues : Compte revient au nombre de départ')

    # Page d'une course terminée : « Signaler un problème sur cette course »
    await page.goto(SITE + f'client/course/?id={terminee}')
    await page.wait_for_selector('#signaler:not([hidden])')
    verifier(await page.evaluate("document.getElementById('signaler').href") == SITE + f'client/?signaler={terminee}',
             'course terminée : « Signaler un problème sur cette course »')
    await page.click('#signaler')
    await page.wait_for_selector('dialog#support[open] #support-vue-nouvelle:not([hidden])')
    await page.wait_for_function(f"document.getElementById('support-course').value === '{terminee}'")
    verifier(await page.input_value('#support-type') == 'course' and page.url == SITE + 'client/',
             '« Signaler un problème » : espace client, nouvelle demande sur cette course (adresse nettoyée)')
    await page.click('#support-fermer')

    # Adresse des notifications (page de renvoi) : la demande s'ouvre dans l'espace client
    await page.goto(SITE + f'client/demandes/?id={demande}')
    await page.wait_for_selector('dialog#support[open] #support-vue-fil:not([hidden])')
    verifier(page.url == SITE + 'client/' and await page.inner_text('#support-titre') == 'Sac oublié dans le véhicule',
             'adresse /client/demandes/?id=… : l\'espace client ouvre la demande')
    await page.click('#support-fermer')
    return demande


async def proches_client(page):
    """Compte > Mes proches (client/compte/proches.js) : liste, ajout (contrôles,
    numéro déjà enregistré), modification, « Commander » (la commande s'ouvre
    pour ce proche), retrait."""
    print('Mes proches')
    await page.goto(SITE + 'client/?onglet=compte')
    await page.wait_for_selector('#compte-proches')
    existants = ligne_sql(f"select count(*) || '|' || coalesce(min(nom), '') || '|' || coalesce(min(telephone), '') "
                          f"from public.proches where client_id = '{CLIENT}'")
    nombre, premier_nom, premier_tel = int(existants[0]), existants[1], existants[2]
    await page.wait_for_function(f"document.querySelectorAll('#compte-liste-proches li').length === {nombre}")
    if nombre:
        verifier(premier_nom in await page.inner_text('#compte-liste-proches') and await page.is_hidden('#compte-proches-vide'),
                 f'Mes proches : {nombre} proche(s) déjà enregistré(s) affiché(s)')
    else:
        verifier(await page.is_visible('#compte-proches-vide'), 'Mes proches : « Aucun proche enregistré. »')
    await page.click('#proche-ajouter')
    await page.wait_for_selector('#proche-formulaire:not([hidden])')
    verifier(await page.inner_text('#proche-formulaire-titre') == 'Ajouter un proche', '« Ajouter » : formulaire « Ajouter un proche »')
    await page.click('#proche-enregistrer')
    verifier(await page.is_visible('#proche-nom-compte-erreur') and await page.is_visible('#proche-telephone-compte-erreur'),
             'proche sans nom ni numéro : refusé avant l\'envoi')
    await page.fill('#proche-nom-compte', 'Paul Martin')
    if premier_tel:
        await page.fill('#proche-telephone-compte', premier_tel)
        await page.click('#proche-enregistrer')
        verifier(f'Ce numéro est déjà celui de {premier_nom}.' == await page.inner_text('#proche-telephone-compte-erreur'),
                 'numéro déjà enregistré pour un autre proche : signalé avant l\'envoi')
    await page.fill('#proche-telephone-compte', '06 11 22 33 44')
    await page.fill('#proche-relation-compte', 'Fils')
    await page.click('#proche-enregistrer')
    await message_affiche(page, 'Proche enregistré : Paul Martin.')
    proche = valeur(f"select id from public.proches where client_id = '{CLIENT}' and nom = 'Paul Martin' "
                    "and telephone = '+33611223344' and relation = 'Fils'")
    verifier(len(proche) == 36 and await page.is_hidden('#proche-formulaire')
             and '+33 6 11 22 33 44' in await page.inner_text(f'#proche-{proche}'),
             'proche enregistré dans la base (nom, numéro international, lien), affiché lisiblement')

    await page.click(f'#proche-{proche}-modifier')
    await page.wait_for_selector('#proche-formulaire:not([hidden])')
    verifier(await page.inner_text('#proche-formulaire-titre') == 'Modifier Paul Martin'
             and await page.input_value('#proche-telephone-compte') == '+33 6 11 22 33 44',
             '« Modifier » : formulaire rempli avec le proche')
    await page.fill('#proche-relation-compte', 'Fils aîné')
    await page.click('#proche-enregistrer')
    await message_affiche(page, 'Proche enregistré : Paul Martin.')
    verifier(valeur(f"select relation from public.proches where id = '{proche}'") == 'Fils aîné', 'proche modifié dans la base')

    verifier(await page.evaluate(f"document.getElementById('proche-{proche}-commander').href") == SITE + f'client/commande/?proche={proche}',
             '« Commander » : vers la commande, pour ce proche')
    await page.click(f'#proche-{proche}-commander')
    await page.wait_for_url(re.compile(r'/client/commande/\?proche='))
    await page.wait_for_function("document.getElementById('proche-nom').value === 'Paul Martin'")
    verifier(await page.is_checked('input[name="pour"][value="proche"]') and await page.is_visible('#bloc-proche')
             and await page.input_value('#proche-telephone') == '+33 6 11 22 33 44'
             and await page.input_value('#proche-enregistre') == proche and await page.is_hidden('#case-enregistrer-proche'),
             'commande : « Pour un proche », Paul Martin déjà choisi')
    await page.go_back()
    await page.wait_for_selector(f'#proche-{proche}-retirer')
    await page.click(f'#proche-{proche}-retirer')
    await message_affiche(page, 'Proche retiré : Paul Martin.')
    verifier(valeur(f"select count(*) from public.proches where id = '{proche}'") == '0'
             and await page.locator(f'#proche-{proche}').count() == 0,
             '« Retirer » : proche retiré de la base et de la liste')


def montant_fr(sql_montant):
    """Montant de la base écrit comme à l'écran : « 5,00 € »."""
    return valeur(f"select replace(to_char(coalesce(({sql_montant}), 0), 'FM999990.00'), '.', ',') || ' €'")


def espaces(texte):
    """Espaces insécables (montants, ponctuation) ramenées à des espaces simples."""
    return texte.replace('\u202f', ' ').replace('\xa0', ' ')


async def solde_parrainage_client(ctx, page):
    """Compte > Mon solde et Parrainage et codes promo (solde.js, parrainage.js) :
    montant et mouvements, code, partage du lien, copie du code, filleuls,
    codes promo utilisés, lien des notifications du parrainage, adresse
    /client/compte/#…."""
    print('Solde, parrainage et codes promo')
    await ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin='http://localhost:8765')
    await page.goto(SITE + 'client/?onglet=compte')
    await page.wait_for_selector('#compte-solde-montant:not(:empty)')
    solde = montant_fr(f"select montant from public.soldes where profil_id = '{CLIENT}'")
    ecritures = int(valeur(f"select count(*) from public.ecritures_solde where profil_id = '{CLIENT}'"))
    verifier(espaces(await page.inner_text('#compte-solde-montant')) == solde
             and await page.locator('#compte-mouvements li').count() == min(ecritures, 10),
             f'Mon solde : {solde}, {min(ecritures, 10)} mouvement(s) affiché(s)')
    if ecritures:
        dernier = valeur(f"select motif from public.ecritures_solde where profil_id = '{CLIENT}' order by cree_le desc limit 1")
        verifier(dernier in await page.inner_text('#compte-mouvements li:first-child'), f'Mon solde : dernier mouvement « {dernier} »')

    code = valeur(f"select code_parrainage from public.profils where id = '{CLIENT}'")
    recompense = montant_fr("select recompense_filleul from public.parametres")
    verifier(await page.inner_text('#compte-code-parrainage') == code and recompense in espaces(await page.inner_text('#compte-parrainage-offre')),
             f'Parrainage : code {code} et offre de bienvenue ({recompense})')
    inscrits, valides = ligne_sql(f"select count(*) filter (where statut <> 'annule') || '|' || count(*) filter (where statut = 'valide') "
                                  f"from public.parrainages where parrain_id = '{CLIENT}'")
    gagne = montant_fr(f"select sum(recompense_parrain) from public.parrainages where parrain_id = '{CLIENT}' and statut = 'valide'")
    filleuls = espaces(await page.inner_text('#compte-filleuls'))
    verifier((f'{inscrits} personne' in filleuls if int(inscrits) else 'Personne ne' in filleuls)
             and (f'{valides} parrainage' in filleuls and gagne in filleuls if int(valides) else True),
             f'Parrainage : {inscrits} inscrit(s), {valides} validé(s) ({gagne})')
    verifier(await page.is_hidden('#compte-code-parrain-formulaire'),
             'cliente déjà venue en course : pas de saisie du code d\'un parrain')

    # Partager mon lien (feuille de partage du téléphone, imitée ici) et copier le code
    await page.evaluate("navigator.share = async (donnees) => { window.__partage = donnees; }")
    await page.click('#compte-partager')
    await page.wait_for_function("!!window.__partage")
    partage = await page.evaluate("window.__partage")
    verifier(partage['url'] == SITE + f'connexion/?parrain={code}' and recompense.replace(' ', '') in espaces(partage['text']).replace(' ', ''),
             '« Partager mon lien » : lien d\'invitation (connexion/?parrain=…) et message avec l\'offre')
    await page.click('#compte-copier-code')
    await message_affiche(page, 'Code copié.')
    verifier(await page.evaluate("navigator.clipboard.readText()") == code, '« Copier le code » : le code est dans le presse-papiers')

    # Codes promo déjà utilisés
    promos = int(valeur(f"select count(*) from public.utilisations_promo where client_id = '{CLIENT}'"))
    if promos:
        verifier(await page.locator('#compte-promos li').count() == min(promos, 20)
                 and 'Course C-' in await page.inner_text('#compte-promos li:first-child'),
                 f'codes promo : {min(promos, 20)} remise(s), avec la course')
    else:
        verifier(await page.is_visible('#compte-promos-vide'), 'codes promo : « Aucun code promo utilisé pour le moment. »')
    await page.evaluate("document.getElementById('zone-messages')?.replaceChildren()")
    await page.evaluate("document.getElementById('compte-solde').scrollIntoView({ block: 'start' })")
    await page.screenshot(path=f'{CAPTURES}/client-solde-parrainage.png')

    # Notification « Parrainage validé » : onglet Compte, à « Mon solde »
    systeme(f"""insert into public.notifications (destinataire_id, type, titre, message, lien) values
      ('{CLIENT}', 'paiement', 'Parrainage validé', 'Essai : 5,00 € crédités sur votre solde.', '/client/compte/#compte-solde');""")
    await page.goto(SITE + 'client/')
    await page.wait_for_selector('#cloche-non-lues:not([hidden])')
    await page.click('#cloche')
    await page.wait_for_selector('dialog#notifs[open] #notifs-liste li')
    await page.locator('#notifs-liste .notif', has_text='Essai : 5,00 € crédités sur votre solde.').click()
    await page.wait_for_selector('#vue-compte:not([hidden]) #compte-solde-montant:not(:empty)')
    await page.wait_for_function("Math.abs(document.getElementById('compte-solde').getBoundingClientRect().top) < 120")
    verifier(await page.is_hidden('dialog#notifs'), 'notification « Parrainage validé » : onglet Compte, à « Mon solde »')

    # Adresse /client/compte/#compte-parrainage (page de renvoi)
    await page.goto(SITE + 'client/compte/#compte-parrainage')
    await page.wait_for_url(SITE + 'client/?onglet=compte#compte-parrainage')
    await page.wait_for_selector('#vue-compte:not([hidden]) #compte-code-parrainage:not(:empty)')
    await page.wait_for_function("Math.abs(document.getElementById('compte-parrainage').getBoundingClientRect().top) < 120")
    verifier(True, 'adresse /client/compte/#compte-parrainage : onglet Compte, à la section du parrainage')


async def compte_pro_client(page):
    """Compte > Compte professionnel (client/compte/pro.js), lecture seule :
    Claire, gestionnaire d'un compte (raison sociale, statut, rôle, SIRET,
    plafond, courses du mois sur facture mensuelle, facturation)."""
    print('Compte professionnel')
    compte = valeur(f"select compte_pro_id from public.comptes_pro_membres where profil_id = '{CLIENT}' limit 1")
    if not compte:
        print('  (Claire n\'est rattachée à aucun compte professionnel : vérification sautée)')
        return
    raison, siret, courriel = ligne_sql(f"select raison_sociale || '|' || coalesce(siret, '') || '|' || email_facturation "
                                        f"from public.comptes_pro where id = '{compte}'")
    n, montant = ligne_sql(f"""select count(*) || '|' || replace(to_char(coalesce(sum(case when statut = 'annulee' then frais_annulation
                                   else prix_total + frais_attente end), 0), 'FM999990.00'), '.', ',')
                                 from public.courses where compte_pro_id = '{compte}' and mode_paiement = 'facture_mensuelle'
                                   and cree_le >= now() - interval '32 days'
                                   and to_char(cree_le at time zone 'Europe/Paris', 'YYYY-MM') = to_char(now() at time zone 'Europe/Paris', 'YYYY-MM')""")
    attendu = 'Aucune course du compte' if n == '0' else (f'1 course du compte, {montant} €' if n == '1' else f'{n} courses du compte, {montant} €')
    await page.goto(SITE + 'client/compte/#compte-pro')
    await page.wait_for_selector(f'#compte-pro-{compte}')
    carte = espaces(await page.inner_text(f'#compte-pro-{compte}'))
    verifier(raison in carte and 'Actif' in carte and 'gestionnaire' in carte and '« Facture mensuelle »' in carte
             and await page.is_hidden('#compte-pro-aucun'),
             f'compte professionnel : {raison}, actif, Claire gestionnaire, « Facture mensuelle » à la commande')
    verifier((not siret or f'{siret[:3]} {siret[3:6]} {siret[6:9]} {siret[9:]}' in carte) and attendu in carte and courriel in carte,
             f'compte professionnel : SIRET lisible, ce mois-ci « {attendu} », facturation ({courriel})')
    if n != '0':
        premier = valeur(f"""select numero from public.courses where compte_pro_id = '{compte}' and mode_paiement = 'facture_mensuelle'
                              and to_char(cree_le at time zone 'Europe/Paris', 'YYYY-MM') = to_char(now() at time zone 'Europe/Paris', 'YYYY-MM')
                            order by cree_le desc limit 1""")
        verifier(await page.locator(f'#compte-pro-{compte} .pro-courses li').count() == min(int(n), 10)
                 and premier in await page.inner_text(f'#compte-pro-{compte} .pro-courses li:first-child'),
                 f'gestionnaire : les {min(int(n), 10)} dernières courses du mois, la plus récente d\'abord ({premier})')
    await page.evaluate("document.getElementById('compte-pro').scrollIntoView({ block: 'start' })")
    await page.screenshot(path=f'{CAPTURES}/client-compte-pro.png')


def course_terminee(**autres):
    """Réservation de Claire (dans 3 heures), assurée par Nadia et terminée à
    l'instant (étapes passées par la chauffeuse) : renvoie la course."""
    course = commander(p_type='planifiee', p_quand=valeur("select (now() + interval '3 hours')::text"), **autres)
    ok, sortie = appel_rpc('attribuer_course', {'p_course': course['id'], 'p_chauffeur': CHAUFFEUSE}, ADMIN)
    assert ok, sortie
    for etape in ('en_route', 'arrivee', 'a_bord', 'terminee'):
        ok, sortie = appel_rpc('avancer_course', {'p_course': course['id'], 'p_etape': etape}, CHAUFFEUSE)
        assert ok, sortie
    return course


async def pourboire_client(nav):
    """Pourboire en fin de course (client/course/) : montants proposés, autre
    montant contrôlé avant l'envoi, consigne et reçu, encaissement par la
    chauffeuse, pourboire laissé entre-temps sur un autre appareil (réponse de
    la base traduite, écran remis à jour), délais (30 minutes en espèces ou
    par carte, le formulaire se retire de lui-même ; 24 heures sur facture
    mensuelle), en anglais."""
    print('Pourboire en fin de course')
    debut = valeur("select now()")
    prenom = valeur(f"select prenom from public.profils where id = '{CHAUFFEUSE}'")
    ctx, page = await nouveau_contexte(nav)

    # 1. En espèces : choix du montant, contrôles, envoi
    especes = course_terminee()
    await page.goto(SITE + f'client/course/?id={especes["id"]}')
    await page.wait_for_selector('#bloc-pourboire:not([hidden])')
    boutons = [espaces(b) for b in await page.locator('#montants-pourboire button').all_inner_texts()]
    verifier(espaces(await page.inner_text('#pourboire-titre')) == f'Un pourboire pour {prenom} ?'
             and espaces(await page.inner_text('#pourboire-aide')).startswith(f'En espèces : remettez-le à {prenom} avant de vous quitter, dans les 30 minutes')
             and boutons == ['2 €', '5 €', '10 €', 'Autre montant'],
             f'course terminée en espèces : « Un pourboire pour {prenom} ? », consigne (30 minutes), 2 €, 5 €, 10 €, « Autre montant »')
    verifier(await page.is_visible('#bloc-note') and await page.inner_text('#envoyer-pourboire') == 'Laisser un pourboire',
             'pourboire proposé après la note, bouton « Laisser un pourboire »')
    await page.click('#envoyer-pourboire')
    verifier(await page.inner_text('#erreur-pourboire') == 'Choisissez un montant.', 'aucun montant choisi : « Choisissez un montant. »')
    await page.click('#pourboire-choix-autre')
    verifier(await page.is_visible('#pourboire-autre') and await page.evaluate("document.activeElement.id") == 'pourboire-autre'
             and await page.is_hidden('#erreur-pourboire'), '« Autre montant » : champ affiché, le curseur y est')
    await page.fill('#pourboire-autre', '0,2')
    await page.click('#envoyer-pourboire')
    verifier(espaces(await page.inner_text('#erreur-pourboire')) == 'Indiquez un montant de 0,50 € à 100 €, par exemple 3 ou 7,50.'
             and await page.get_attribute('#pourboire-autre', 'aria-invalid') == 'true'
             and valeur(f"select pourboire from public.courses where id = '{especes['id']}'") == '0.00',
             'autre montant de 0,20 € : refusé avant l\'envoi, message clair, rien dans la base')
    await page.fill('#pourboire-autre', '7,50')
    verifier(espaces(await page.inner_text('#envoyer-pourboire')) == 'Laisser 7,50 € de pourboire' and await page.is_hidden('#erreur-pourboire'),
             'autre montant saisi (7,50) : le bouton annonce « Laisser 7,50 € de pourboire »')
    await page.click('#montants-pourboire button[data-montant="5"]')
    verifier(await page.get_attribute('#montants-pourboire button[data-montant="5"]', 'aria-pressed') == 'true'
             and await page.get_attribute('#pourboire-choix-autre', 'aria-pressed') == 'false' and await page.is_hidden('#pourboire-autre')
             and espaces(await page.inner_text('#envoyer-pourboire')) == 'Laisser 5,00 € de pourboire',
             '5 € choisi : bouton marqué, champ « Autre montant » refermé, « Laisser 5,00 € de pourboire »')
    await page.evaluate("document.getElementById('bloc-pourboire').scrollIntoView({ block: 'center' })")
    await page.screenshot(path=f'{CAPTURES}/client-pourboire.png')
    await page.click('#envoyer-pourboire')
    await message_affiche(page, 'Votre pourboire de 5,00')
    await page.wait_for_selector('#pourboire-donne:not([hidden])')
    verifier(await page.is_hidden('#bloc-pourboire')
             and espaces(await page.inner_text('#pourboire-donne')) == f'Votre pourboire : 5,00 €, à remettre en espèces à {prenom}.',
             f'pourboire envoyé : « Merci ! », consigne « à remettre en espèces à {prenom} », plus de formulaire')
    recu = espaces(await page.inner_text('#recu-pourboire'))
    verifier('Pourboire 5,00 €' in recu and 'Hors TVA, en plus de la facture' in recu and 'Espèces · à régler' in recu,
             'reçu du pourboire sous la facture : 5,00 €, hors TVA, en plus de la facture, « Espèces · à régler »')
    verifier(valeur(f"""select c.pourboire || '|' || p.mode || '|' || p.montant || '|' || p.statut
                         from public.courses c join public.paiements p on p.course_id = c.id and p.nature = 'pourboire'
                         where c.id = '{especes['id']}'""") == '5.00|especes|5.00|a_encaisser'
             and valeur(f"""select count(*) from public.notifications where destinataire_id = '{CHAUFFEUSE}'
                             and titre = 'Pourboire en espèces' and lien = '/chauffeur/course/?id={especes['id']}'""") == '1',
             f'base : pourboire de 5,00 € sur la course, paiement en espèces à encaisser, {prenom} prévenue (lien vers la course)')
    await page.evaluate("document.getElementById('zone-messages')?.replaceChildren()")
    await page.evaluate("document.getElementById('pourboire-donne').scrollIntoView({ block: 'center' })")
    await page.screenshot(path=f'{CAPTURES}/client-pourboire-laisse.png')
    paiement = valeur(f"select id from public.paiements where course_id = '{especes['id']}' and nature = 'pourboire'")
    ok, sortie = appel_rpc('confirmer_encaissement', {'p_paiement': paiement}, CHAUFFEUSE)
    assert ok, sortie
    await page.reload()
    await page.wait_for_selector('#recu-pourboire:not([hidden])')
    verifier(espaces(await page.inner_text('#pourboire-donne')) == 'Votre pourboire : 5,00 €. Merci !'
             and re.search(r'Espèces · réglé le \d', espaces(await page.inner_text('#recu-pourboire'))) is not None,
             'pourboire reçu par la chauffeuse : « Merci ! », reçu « Espèces · réglé le … »')

    # 2. Par carte : pourboire laissé entre-temps sur un autre appareil
    carte = course_terminee(p_mode_paiement='carte')
    await page.goto(SITE + f'client/course/?id={carte["id"]}')
    await page.wait_for_selector('#bloc-pourboire:not([hidden])')
    verifier(espaces(await page.inner_text('#pourboire-aide')).startswith(f'Par carte : {prenom} l\'encaisse sur son terminal avant de vous quitter'),
             'course payée par carte : consigne « l\'encaisse sur son terminal »')
    ok, sortie = appel_rpc('ajouter_pourboire', {'p_course': carte['id'], 'p_montant': 3}, CLIENT)
    assert ok, sortie
    await page.click('#montants-pourboire button[data-montant="2"]')
    await page.click('#envoyer-pourboire')
    await message_affiche(page, 'Un pourboire a déjà été laissé pour cette course.')
    # Ce refus de la base (réponse 400) est voulu : il ne compte pas parmi les erreurs de la console
    for i in range(len(console) - 1, -1, -1):
        if 'status of 400' in console[i]:
            del console[i]
            break
    await page.wait_for_selector('#pourboire-donne:not([hidden])')
    verifier(await page.is_hidden('#bloc-pourboire')
             and espaces(await page.inner_text('#pourboire-donne')) == f'Votre pourboire : 3,00 €, à régler par carte sur le terminal de {prenom}.'
             and valeur(f"select pourboire from public.courses where id = '{carte['id']}'") == '3.00',
             'pourboire déjà laissé sur un autre appareil : refus traduit, l\'écran montre le pourboire de 3,00 € (un seul dans la base)')

    # 3. Délai de 30 minutes en espèces : dépassé, puis atteint page ouverte
    tard = course_terminee()
    systeme(f"update public.courses set terminee_le = now() - interval '31 minutes' where id = '{tard['id']}'")
    await page.goto(SITE + f'client/course/?id={tard["id"]}')
    await page.wait_for_selector('#bloc-note:not([hidden])')
    verifier(await page.is_hidden('#bloc-pourboire') and await page.is_hidden('#pourboire-donne') and await page.is_hidden('#recu-pourboire'),
             'espèces, course finie depuis 31 minutes : plus de pourboire proposé')
    # 10 secondes avant la fin du délai : le formulaire s'affiche, puis se retire
    systeme(f"update public.courses set terminee_le = now() - interval '29 minutes 50 seconds' where id = '{tard['id']}'")
    await page.reload()
    await page.wait_for_selector('#bloc-pourboire:not([hidden])')
    await page.wait_for_selector('#bloc-pourboire', state='hidden', timeout=15000)
    verifier(True, 'délai atteint page ouverte : le formulaire du pourboire se retire de lui-même')

    # 4. Sur facture mensuelle : 24 heures
    compte = valeur(f"""select m.compte_pro_id from public.comptes_pro_membres m join public.comptes_pro cp on cp.id = m.compte_pro_id
                         where m.profil_id = '{CLIENT}' and cp.statut = 'actif' limit 1""")
    if compte:
        pro = course_terminee(p_mode_paiement='facture_mensuelle', p_compte_pro=compte)
        systeme(f"update public.courses set terminee_le = now() - interval '23 hours' where id = '{pro['id']}'")
        await page.goto(SITE + f'client/course/?id={pro["id"]}')
        await page.wait_for_selector('#bloc-pourboire:not([hidden])')
        verifier(espaces(await page.inner_text('#pourboire-aide')) == 'Sur la facture mensuelle de votre entreprise, dans les 24 heures qui suivent '
                 f'la course. Il revient en entier à {prenom}.',
                 'facture mensuelle, course finie depuis 23 heures : pourboire encore proposé (24 heures)')
        await page.click('#pourboire-choix-autre')
        await page.fill('#pourboire-autre', '3')
        await page.click('#envoyer-pourboire')
        await page.wait_for_selector('#pourboire-donne:not([hidden])')
        verifier(espaces(await page.inner_text('#pourboire-donne')) == 'Votre pourboire : 3,00 €, sur la facture mensuelle de votre entreprise. Merci !'
                 and 'Facture mensuelle · à régler' in espaces(await page.inner_text('#recu-pourboire'))
                 and valeur(f"""select count(*) from public.notifications where destinataire_id = '{CHAUFFEUSE}' and titre = 'Pourboire reçu'
                                 and lien = '/chauffeur/revenus/' and message like '3,00 € pour la course {pro['numero']}, sur la facture mensuelle%'""") == '1',
                 'facture mensuelle : pourboire de 3,00 € (autre montant) sur le relevé de l\'entreprise, chauffeuse prévenue')
    else:
        print('  (Claire n\'est membre d\'aucun compte professionnel actif : facture mensuelle sautée)')
    await ctx.close()

    # 5. En anglais
    ctx, page = await nouveau_contexte(nav)
    anglais = course_terminee()
    await page.goto(SITE + f'client/course/?id={anglais["id"]}&lang=en')
    await page.wait_for_selector('#bloc-pourboire:not([hidden])')
    verifier(await page.inner_text('#pourboire-titre') == f'A tip for {prenom}?'
             and (await page.inner_text('#pourboire-aide')).startswith(f'In cash: hand it to {prenom} before you part, within 30 minutes')
             and await page.locator('#montants-pourboire button').all_inner_texts() == ['€2', '€5', '€10', 'Other amount'],
             f'en anglais : « A tip for {prenom}? », consigne, €2, €5, €10, « Other amount »')
    await page.click('#montants-pourboire button[data-montant="10"]')
    verifier(await page.inner_text('#envoyer-pourboire') == 'Leave a €10.00 tip', 'en anglais : « Leave a €10.00 tip »')
    await page.click('#envoyer-pourboire')
    await page.wait_for_selector('#pourboire-donne:not([hidden])')
    verifier(await page.inner_text('#pourboire-donne') == f'Your tip: €10.00, to hand to {prenom} in cash.'
             and 'Cash · to be paid' in await page.inner_text('#recu-pourboire'),
             f'en anglais : « Your tip: €10.00, to hand to {prenom} in cash. », reçu « Cash · to be paid »')
    await ctx.close()
    # Les notifications de ces essais sont retirées (celles de Claire le sont à la fin)
    systeme(f"delete from public.notifications where destinataire_id = '{CHAUFFEUSE}' and cree_le >= '{debut}';")


def retirer_refus_console(statut):
    """Un refus voulu (réponse « statut ») ne compte pas parmi les erreurs de la console."""
    for i in range(len(console) - 1, -1, -1):
        if f'status of {statut}' in console[i]:
            del console[i]
            return


async def preferences_client(page):
    """Compte > Notifications (client/compte/preferences.js) : les trois
    interrupteurs lus dans le profil, adresse et numéro rappelés, chaque choix
    enregistré aussitôt ; refus de la base : l'interrupteur revient à sa
    position, message clair."""
    print('Compte : notifications')
    avant = valeur(f"select notif_email || ',' || notif_whatsapp || ',' || notif_push from public.profils where id = '{CLIENT}'")
    systeme(f"update public.profils set notif_email = true, notif_whatsapp = true, notif_push = false where id = '{CLIENT}';")
    email, telephone = ligne_sql(f"select email || '|' || telephone from public.profils where id = '{CLIENT}'")
    try:
        await page.goto(SITE + 'client/compte/#compte-notifications')
        await page.wait_for_function("(document.getElementById('compte-notif-email-detail')?.textContent || '') !== ''")
        verifier(await page.is_checked('#compte-notif-email') and await page.is_checked('#compte-notif-whatsapp')
                 and not await page.is_checked('#compte-notif-push'),
                 'notifications : les trois choix lus dans le profil (e-mail et WhatsApp oui, téléphone non)')
        lisible = f'+33 {telephone[3]} {telephone[4:6]} {telephone[6:8]} {telephone[8:10]} {telephone[10:12]}'
        verifier(email in await page.inner_text('#compte-notif-email-detail')
                 and lisible in espaces(await page.inner_text('#compte-notif-whatsapp-detail'))
                 and await page.get_attribute('#compte-notif-push', 'role') == 'switch',
                 f'notifications : adresse ({email}) et numéro ({lisible}) rappelés, interrupteurs annoncés comme tels')
        await page.click('label[for="compte-notif-whatsapp"]')
        await message_affiche(page, 'Préférence enregistrée.')
        await attendre_valeur(f"select notif_whatsapp from public.profils where id = '{CLIENT}'", 'f')
        await page.click('label[for="compte-notif-push"]')
        await attendre_valeur(f"select notif_push from public.profils where id = '{CLIENT}'", 't')
        verifier(not await page.is_checked('#compte-notif-whatsapp') and await page.is_checked('#compte-notif-push'),
                 'WhatsApp coupé, téléphone activé : enregistrés aussitôt dans le profil')
        await page.evaluate("document.getElementById('zone-messages')?.replaceChildren()")
        await page.evaluate("document.getElementById('compte-notifications').scrollIntoView({ block: 'start' })")
        await page.screenshot(path=f'{CAPTURES}/client-notifications.png')
        # Refus de la base (droit retiré le temps de l'essai) : retour en arrière
        systeme("revoke update (notif_email) on public.profils from authenticated;")
        try:
            await page.click('label[for="compte-notif-email"]')
            await message_affiche(page, 'L\'opération n\'a pas abouti')
            await page.wait_for_function("document.getElementById('compte-notif-email').checked && !document.getElementById('compte-notif-email').disabled")
            retirer_refus_console(400)
            verifier(valeur(f"select notif_email from public.profils where id = '{CLIENT}'") == 't',
                     'refus de la base : l\'interrupteur revient à sa position, message clair, rien de changé')
        finally:
            systeme("grant update (notif_email) on public.profils to authenticated;")
    finally:
        e, w, n = avant.split(',')
        systeme(f"update public.profils set notif_email = {e}, notif_whatsapp = {w}, notif_push = {n} where id = '{CLIENT}';")


async def securite_client(nav):
    """Compte > Sécurité (client/compte/securite.js), avec le service de
    connexion imité (AuthSimulee) : e-mail de connexion et dernière connexion,
    changement d'adresse par code (contrôles avant l'envoi, adresse d'un autre
    compte, « Annuler » puis reprise, code erroné, renvoi du code, double
    confirmation : nouvelle adresse puis adresse actuelle), profil mis à jour
    par la base, « Se déconnecter des autres appareils »."""
    print('Compte : sécurité')
    email = valeur(f"select email from auth.users where id = '{CLIENT}'")
    nouvelle = 'claire.nouvelle@exemple.test'
    auth = AuthSimulee(CLIENT, email)
    ctx = await nav.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                locale='fr-FR', timezone_id='Europe/Paris', service_workers='block')
    await ctx.add_init_script(auth.injection())
    await ctx.route('**/*', routeur(CLIENT, auth))
    page = await ctx.new_page()
    page.on('console', lambda m: console.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))
    try:
        await page.goto(SITE + 'client/compte/#compte-securite')
        await page.wait_for_function("(document.getElementById('compte-securite-infos')?.textContent || '').includes('@')")
        infos = espaces(await page.inner_text('#compte-securite-infos'))
        verifier(email in infos and '6 novembre 2026 à 09:15' in infos,
                 f'sécurité : e-mail de connexion ({email}) et dernière connexion (6 novembre 2026 à 09:15), lus au service de connexion')

        # Contrôles avant l'envoi, puis adresse d'un autre compte
        await page.click('#compte-changer-email')
        await page.wait_for_selector('#compte-email-formulaire:not([hidden])')
        verifier(await page.is_hidden('#compte-securite-actions') and await page.evaluate("document.activeElement.id") == 'compte-email-nouveau',
                 '« Changer d\'adresse e-mail » : formulaire ouvert, le curseur dans le champ')
        await page.fill('#compte-email-nouveau', 'claire@')
        await page.click('#compte-email-valider')
        verifier(await page.inner_text('#compte-email-nouveau-erreur') == 'Adresse e-mail invalide : vérifiez-la (ex. prenom.nom@exemple.fr).',
                 'adresse mal formée : refusée avant l\'envoi')
        await page.fill('#compte-email-nouveau', email.upper())
        await page.click('#compte-email-valider')
        verifier(await page.inner_text('#compte-email-nouveau-erreur') == 'C\'est déjà votre adresse de connexion.'
                 and auth.nouvel_email is None, 'même adresse (en majuscules) : refusée avant l\'envoi')
        await page.fill('#compte-email-nouveau', AuthSimulee.ADRESSE_PRISE)
        await page.click('#compte-email-valider')
        await page.wait_for_function("document.getElementById('compte-email-nouveau-erreur').textContent.includes('autre compte')")
        retirer_refus_console(422)
        verifier(await page.inner_text('#compte-email-nouveau-erreur') == 'Cette adresse est déjà celle d\'un autre compte LOC RÉACTION.',
                 'adresse d\'un autre compte : refus du service traduit')

        # Code envoyé, « Annuler » : le changement attend son code, puis se reprend
        await page.fill('#compte-email-nouveau', 'Claire.Nouvelle@Exemple.test')
        await page.click('#compte-email-valider')
        await page.wait_for_selector('#compte-email-code-bloc:not([hidden])')
        verifier(auth.nouvel_email == nouvelle and nouvelle in await page.inner_text('#compte-email-envoye')
                 and await page.is_disabled('#compte-email-renvoyer')
                 and re.search(r'^Renvoyer le code \(\d+ s\)$', espaces(await page.inner_text('#compte-email-renvoyer'))) is not None
                 and await page.evaluate("document.activeElement.id") == 'compte-email-code',
                 'code envoyé à la nouvelle adresse (en minuscules) ; « Renvoyer le code » après 60 s')
        await page.screenshot(path=f'{CAPTURES}/client-securite-code.png')
        await page.click('#compte-email-annuler')
        await page.wait_for_selector('#compte-email-attente:not([hidden])')
        verifier(nouvelle in await page.inner_text('#compte-email-attente-texte') and await page.is_visible('#compte-changer-email'),
                 '« Annuler » : le changement reste en attente, « Saisir le code » le reprend')
        await page.click('#compte-email-reprendre')
        await page.wait_for_selector('#compte-email-code-bloc:not([hidden])')
        await page.fill('#compte-email-code', '12')
        await page.click('#compte-email-valider')
        verifier(await page.inner_text('#compte-email-code-erreur') == 'Saisissez le code reçu par e-mail : 6 chiffres ou plus.',
                 'code trop court : refusé avant l\'envoi')
        await page.fill('#compte-email-code', '999999')
        await page.click('#compte-email-valider')
        await page.wait_for_function("document.getElementById('compte-email-code-erreur').textContent.startsWith('Code incorrect')")
        retirer_refus_console(403)
        verifier(True, 'code erroné : « Code incorrect ou expiré : vérifiez-le, ou demandez un nouveau code. »')
        await page.click('#compte-email-renvoyer')
        await message_affiche(page, 'Nouveau code envoyé.')
        verifier(auth.renvois and auth.renvois[-1].get('type') == 'email_change' and auth.renvois[-1].get('email') == nouvelle
                 and await page.is_disabled('#compte-email-renvoyer'),
                 '« Renvoyer le code » : nouveau code pour la nouvelle adresse, puis 60 s d\'attente')

        # Double confirmation : code de la nouvelle adresse, puis de l'actuelle
        await page.fill('#compte-email-code', AuthSimulee.CODE_NOUVELLE)
        await page.click('#compte-email-valider')
        await page.wait_for_function("document.getElementById('compte-email-envoye').textContent.includes('adresse actuelle')")
        verifier(email in await page.inner_text('#compte-email-envoye') and await page.input_value('#compte-email-code') == '',
                 'premier code accepté : le code envoyé à l\'adresse actuelle est demandé pour finir')
        await page.fill('#compte-email-code', AuthSimulee.CODE_ACTUELLE)
        await page.click('#compte-email-valider')
        await message_affiche(page, f'Adresse e-mail changée : {nouvelle}.')
        await page.wait_for_selector('#compte-email-formulaire', state='hidden')
        await page.wait_for_function(f"document.getElementById('compte-profil').textContent.includes({json.dumps(nouvelle)})")
        verifier(valeur(f"select email from public.profils where id = '{CLIENT}'") == nouvelle
                 and nouvelle in await page.inner_text('#compte-securite-infos') and await page.is_hidden('#compte-email-attente'),
                 'adresse changée : profil mis à jour par la base, « Sécurité » et « Profil » l\'affichent')

        # Autres appareils
        await page.click('#compte-deconnecter-autres')
        await message_affiche(page, 'Vos autres appareils sont déconnectés')
        verifier(auth.deconnexions == ['others'] and await page.is_visible('#compte-securite'),
                 '« Se déconnecter des autres appareils » : portée « others », ce téléphone reste connecté')
        await page.evaluate("document.getElementById('zone-messages')?.replaceChildren()")
        await page.evaluate("document.getElementById('compte-securite').scrollIntoView({ block: 'start' })")
        await page.screenshot(path=f'{CAPTURES}/client-securite.png')
    finally:
        systeme(f"update auth.users set email = '{email}' where id = '{CLIENT}';")
        await ctx.close()


async def donnees_client(nav):
    """Compte > Données personnelles (client/compte/donnees.js), avec un client
    d'essai (Mathis) : « Télécharger mes données » (fichier JSON daté, tout y
    est), « Supprimer mon compte » (solde annoncé perdu, mot de confirmation,
    refus de la base tant qu'une course est à venir, puis suppression : la
    page oublie la session, ne propose plus que l'accueil), en anglais."""
    print('Compte : données personnelles')
    mathis = systeme(f"""set role supabase_auth_admin;
insert into auth.users (email, raw_user_meta_data) values ('mathis{int(time.time())}@exemple.test', '{{"prenom":"Mathis","nom":"Lambert"}}') returning id;""").splitlines()[-1]
    systeme(f"""update public.profils set telephone = '+33644556677' where id = '{mathis}';
               insert into public.lieux (client_id, type, adresse, latitude, longitude)
               values ('{mathis}', 'domicile', '3 rue du Château, 95270 Chaumontel', 49.1260, 2.4310);
               select prive.ecrire_solde('{mathis}', 4, 'Geste commercial', null);""")
    quand = valeur("select (now() + interval '2 days')::text")
    ok, sortie = appel_rpc('commander_course', {'p_categorie': 'berline_hybride', 'p_depart_adresse': '3 rue du Château, 95270 Chaumontel',
                                                'p_depart_lat': 49.1260, 'p_depart_lng': 2.4310, 'p_arrivee_adresse': 'Gare de Lyon',
                                                'p_arrivee_lat': 48.8443, 'p_arrivee_lng': 2.3743, 'p_type': 'planifiee', 'p_quand': quand}, mathis)
    assert ok, sortie
    reservation = json.loads(sortie)['id']

    ctx = await nav.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                locale='fr-FR', timezone_id='Europe/Paris', service_workers='block', accept_downloads=True)
    await ctx.add_init_script(session_injectee(mathis, 'mathis@exemple.test'))
    await ctx.route('**/*', routeur(mathis))
    page = await ctx.new_page()
    page.on('console', lambda m: console.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))

    # En anglais d'abord : libellés et mot de confirmation
    await page.goto(SITE + 'client/compte/?lang=en#compte-donnees')
    await page.wait_for_selector('#compte-supprimer')
    await page.click('#compte-supprimer')
    await page.wait_for_selector('dialog#compte-suppression[open]')
    verifier(await page.inner_text('#compte-titre-donnees') == 'Personal data' and await page.inner_text('#compte-telecharger') == 'Download my data'
             and await page.inner_text('label[for="compte-suppression-mot"]') == 'To confirm, type DELETE',
             'en anglais : « Personal data », « Download my data », mot de confirmation « DELETE »')
    await page.click('#compte-suppression-garder')
    await page.wait_for_selector('dialog#compte-suppression:not([open])', state='attached')

    # Télécharger mes données
    await page.goto(SITE + 'client/compte/#compte-donnees')
    await page.wait_for_selector('#compte-telecharger')
    async with page.expect_download() as telechargement:
        await page.click('#compte-telecharger')
    fichier = await telechargement.value
    donnees = json.load(open(await fichier.path(), encoding='utf-8'))
    jour = valeur("select to_char(now() at time zone 'Europe/Paris', 'YYYY-MM-DD')")
    await message_affiche(page, 'Vos données sont téléchargées')
    verifier(fichier.suggested_filename == f'loc-reaction-mes-donnees-{jour}.json'
             and donnees['profil']['prenom'] == 'Mathis' and donnees['profil']['telephone'] == '+33644556677'
             and len(donnees['lieux']) == 1 and len(donnees['courses']) == 1 and float(donnees['solde']['montant']) == 4
             and donnees['a_propos']['responsable_du_traitement']['raison_sociale'] == 'LOC RÉACTION S.A.S',
             f'« Télécharger mes données » : fichier loc-reaction-mes-donnees-{jour}.json (profil, lieu, course, solde, responsable)')

    # Supprimer mon compte : solde annoncé, mot de confirmation, refus de la base
    await page.click('#compte-supprimer')
    await page.wait_for_selector('dialog#compte-suppression[open]')
    verifier(espaces(await page.inner_text('#compte-suppression-solde')) == 'Votre solde de 4,00 € sera perdu.'
             and await page.evaluate("document.activeElement.id") == 'compte-suppression-mot'
             and 'comptabilité' in await page.inner_text('#compte-suppression'),
             'boîte de suppression : ce qui est effacé, ce qui est gardé (comptabilité), solde de 4,00 € perdu ; le curseur dans le champ')
    await page.fill('#compte-suppression-mot', 'oui')
    await page.click('#compte-suppression-confirmer')
    verifier(await page.inner_text('#compte-suppression-erreur') == 'Écrivez SUPPRIMER pour confirmer la suppression.',
             'mot de confirmation erroné : refusé avant l\'envoi')
    await page.fill('#compte-suppression-mot', 'supprimer')
    await page.click('#compte-suppression-confirmer')
    await page.wait_for_function("document.getElementById('compte-suppression-erreur').textContent.startsWith('Une course est en cours ou à venir')")
    retirer_refus_console(400)
    verifier(valeur(f"select statut from public.profils where id = '{mathis}'") == 'actif',
             'réservation à venir : suppression refusée par la base, message clair, compte intact')
    await page.evaluate("document.getElementById('compte-suppression').scrollTop = 0")
    await page.screenshot(path=f'{CAPTURES}/client-suppression.png')

    # La réservation annulée, la suppression passe
    ok, sortie = appel_rpc('annuler_course', {'p_course': reservation, 'p_motif': 'Plus besoin'}, mathis)
    assert ok, sortie
    await page.click('#compte-suppression-confirmer')
    await page.wait_for_selector('#compte-suppression-fait:not([hidden])')
    await page.keyboard.press('Escape')
    await page.wait_for_timeout(300)
    jeton = await page.evaluate("localStorage.getItem('sb-rolfbdmrhwslwxluhfwr-auth-token')")
    verifier(await page.is_visible('dialog#compte-suppression[open] #compte-suppression-fait') and jeton is None
             and valeur(f"select statut || '|' || coalesce(email, 'aucun') from public.profils where id = '{mathis}'") == 'supprime|aucun'
             and valeur(f"select (banned_until > now()) || '|' || coalesce(email, 'aucun') from auth.users where id = '{mathis}'") == 'true|aucun',
             'compte supprimé : effacé dans la base, connexion fermée, la page oublie sa session ; Échap ne referme pas la boîte')
    await page.screenshot(path=f'{CAPTURES}/client-compte-supprime.png')
    await page.click('#compte-suppression-accueil')
    await page.wait_for_url(re.compile(r'/v2/(\?lang=fr)?$'))
    verifier(True, '« Retour à l\'accueil » : page d\'accueil')
    await ctx.close()


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
    demandes_creees = []
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

            demande = await support_client(page, debut, demandes_creees)
            await proches_client(page)
            await solde_parrainage_client(ctx, page)
            await compte_pro_client(page)
            await pourboire_client(nav)
            await securite_client(nav)
            await preferences_client(page)
            await donnees_client(nav)

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
            await page.click('#compte-mes-demandes')
            await page.wait_for_selector(f'dialog#support[open] #support-liste button[data-id="{demande}"]')
            verifier(await page.inner_text('#support-titre') == 'My support requests'
                     and 'Resolved' in await page.inner_text(f'#support-liste button[data-id="{demande}"]')
                     and await page.inner_text('#support-nouvelle') == 'New request',
                     'support en anglais : « My support requests », statut « Resolved »')
            await page.click('#support-fermer')
            await page.goto(SITE + f'client/demandes/?id={demande}&lang=en')
            await page.wait_for_selector('dialog#support[open] #support-vue-fil:not([hidden])')
            verifier(page.url == SITE + 'client/?lang=en' and 'Resolved' in await page.inner_text('#support-sous-titre')
                     and 'Request resolved.' in await page.inner_text('#support-fermee'),
                     'adresse /client/demandes/?id=…&lang=en : la demande s\'ouvre en anglais')
            await page.click('#support-fermer')
            await page.click('#onglets [data-onglet="compte"]')
            await page.wait_for_selector('#compte-langue-fr')
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

                await page.click('#onglets [data-onglet="compte"]')
                await page.wait_for_selector('#compte-code-parrain-formulaire:not([hidden])')
                verifier(espaces(await page.inner_text('#compte-solde-montant')) == '0,00 €' and await page.is_visible('#compte-mouvements-vide')
                         and await page.is_visible('#compte-promos-vide') and 'Personne ne' in await page.inner_text('#compte-filleuls'),
                         'nouveau client : solde à 0,00 €, aucun mouvement, aucun filleul, aucun code promo')
                await page.fill('#compte-code-parrain', 'ab!')
                await page.click('#compte-code-parrain-valider')
                verifier('Code invalide' in await page.inner_text('#compte-code-parrain-erreur'), 'code de parrain mal formé : refusé avant l\'envoi')
                code_ines = valeur(f"select code_parrainage from public.profils where id = '{nouveau}'")
                await page.fill('#compte-code-parrain', code_ines)
                await page.click('#compte-code-parrain-valider')
                await page.wait_for_function("document.getElementById('compte-code-parrain-erreur').textContent.includes('propre code')")
                verifier(True, 'son propre code : refusé par la base, message clair')
                code_claire = valeur(f"select code_parrainage from public.profils where id = '{CLIENT}'")
                await page.fill('#compte-code-parrain', code_claire.lower())
                await page.click('#compte-code-parrain-valider')
                await message_affiche(page, 'Code de parrainage enregistré.')
                await page.wait_for_selector('#compte-mon-parrainage:not([hidden])')
                verifier(await page.is_hidden('#compte-code-parrain-formulaire')
                         and 'Vous avez été parrainé(e)' in await page.inner_text('#compte-mon-parrainage')
                         and valeur(f"select statut from public.parrainages where filleul_id = '{nouveau}' and parrain_id = '{CLIENT}'") == 'en_attente',
                         'code de la marraine saisi : parrainage en attente de la première course, annoncé dans Compte')
                await page.evaluate("document.getElementById('zone-messages')?.replaceChildren()")
                await page.evaluate("document.getElementById('compte-parrainage').scrollIntoView({ block: 'start' })")
                await page.screenshot(path=f'{CAPTURES}/client-parrainage-filleul.png')
                verifier(await page.is_visible('#compte-pro-aucun') and await page.locator('#compte-pro-liste article').count() == 0,
                         'nouveau client sans compte professionnel : ce qu\'apporte un compte, « Demander un compte professionnel »')
                await page.click('#compte-pro-demander')
                await page.wait_for_selector('dialog#support[open] #support-vue-nouvelle:not([hidden])')
                verifier(await page.input_value('#support-type') == 'compte'
                         and await page.input_value('#support-sujet') == 'Ouverture d\'un compte professionnel'
                         and await page.evaluate("document.activeElement.id") == 'support-message',
                         '« Demander un compte professionnel » : nouvelle demande au support, type et sujet déjà remplis')
                await page.click('#support-fermer')
                await ctx.close()
            finally:
                systeme(f"delete from auth.users where id = '{nouveau}';")
            await nav.close()
    finally:
        serveur.terminate()
        # Retour à l'état de départ
        for c in (en_cours, reservation):
            appel_rpc('annuler_course', {'p_course': c['id'], 'p_motif': 'Fin de l\'essai'}, ADMIN)
        systeme(f"""delete from public.proches where client_id = '{CLIENT}' and nom = 'Paul Martin';
                   delete from public.lieux where client_id = '{CLIENT}';
                   update public.profils set telephone = nullif($t${telephone}$t$, ''), langue = '{langue}' where id = '{CLIENT}';
                   delete from public.notifications where destinataire_id = '{CLIENT}' and cree_le >= '{debut}';""")
        for d in demandes_creees:
            systeme(f"""delete from public.notifications where cree_le >= '{debut}' and lien like '%{d}%';
                       delete from public.demandes where id = '{d}';""")
    utiles = [c for c in console if 'WebSocket' not in c and 'realtime' not in c.lower() and 'ERR_FAILED' not in c]
    print('Erreurs de la console (hors temps réel, injoignable ici) :', utiles or 'aucune')


asyncio.run(main())
