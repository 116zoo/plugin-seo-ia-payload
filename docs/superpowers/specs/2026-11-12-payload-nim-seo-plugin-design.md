# Plugin SEO IA NIM pour Payload — conception

## Intention

Créer un plugin TypeScript réutilisable pour Payload CMS v3 qui aide les éditeurs à produire et à remettre à niveau le SEO de contenus, via une API NVIDIA NIM. Il doit fonctionner dans l’admin Payload en français et en anglais, tout en gardant séparées les données éditoriales des deux locales. L’IA produit des **propositions à valider**, jamais une publication ou un écrasement automatique.

## Objectifs

- Ajouter un espace SEO localisé aux collections configurées (par exemple `pages`, `posts`).
- Générer, pour la locale active seulement : titre SEO, meta-description, slug/URL suggéré lorsque le projet l’autorise, canonical, robots, mots-clés/intentions éditoriales, Open Graph et Twitter/X.
- Proposer une image de mise en avant depuis la médiathèque Payload, ainsi que le nom de fichier SEO, texte alternatif, légende facultative et recommandations de dimensions/cadrage. Aucune image n’est générée par un fournisseur tiers dans cette version.
- Générer et valider des graphes JSON-LD Schema.org adaptés au type de contenu, notamment `WebPage`, `Article`, `BlogPosting`, `BreadcrumbList`, `Organization`, `WebSite` et, lorsque la collection le permet, `FAQPage`.
- Générer des blocs de citabilité, un par locale, d’au plus 2 000 caractères (validation serveur incluse) afin d’être réutilisés par le frontend.
- Auditer les documents existants : état de complétude, erreurs et recommandations ; permettre des traitements en masse qui créent uniquement des brouillons de propositions.
- Conserver l’historique, l’état et les éventuelles erreurs des générations, sans exposer de clé NIM au navigateur.

## Hors périmètre

- Publication automatique, application automatique et traduction automatique FR ↔ EN.
- Génération binaire d’images ou ajout obligatoire d’un second fournisseur IA.
- Promesse d’un classement, d’une indexation ou d’un enrichissement Google garanti.
- Rendu HTML des balises et JSON-LD sur le site frontend : le plugin stocke des données prêtes à consommer ; l’intégration de rendu est documentée et fournie comme utilitaire optionnel.

## Contraintes et décisions confirmées

- Payload v3, plugin NPM TypeScript portable ; les collections et le champ média sont configurables.
- NVIDIA NIM est appelé depuis le serveur via son API compatible OpenAI, avec URL, modèle et secret configurés côté serveur.
- Toutes les sorties sont des propositions revues et appliquées explicitement par un éditeur autorisé.
- Le français et l’anglais sont indépendants : génération sur la locale ouverte, aucune copie ni traduction implicite.
- Les contenus source eux-mêmes (titre, corps/blocs et métadonnées éditoriales configurées) doivent être localisés indépendamment en français et en anglais dans Payload ; le plugin ne génère qu’à partir de la version active.
- Les images sont choisies dans la médiathèque Payload ; le plugin propose les attributs SEO de l’image et les dimensions recommandées.

## Approches considérées

1. Champs SEO uniquement dans chaque contenu : simple, mais ne permet pas de piloter l’optimisation du stock ni de tracer les brouillons et coûts.
2. Centre SEO externe : bon pour l’audit, mais sépare les résultats validés du contenu et rend le rendu frontend fragile.
3. **Hybride retenue** : les résultats validés sont des champs des contenus ; une collection centrale conserve audits, propositions, travaux et historique. Cela permet la validation locale et les campagnes de remise à niveau.

## Architecture

### Paquet

`@scope/payload-plugin-nim-seo` exporte `nimSeoPlugin(options)`. Le plugin :

- ajoute le groupe de champs `seo` aux collections sélectionnées ;
- ajoute les collections internes `seo-proposals` et `seo-runs` avec restrictions d’accès ;
- enregistre les tâches Payload pour l’audit et la génération en arrière-plan ;
- ajoute un panneau Admin React Server/Client pour la génération, la comparaison et l’application ;
- fournit les helpers de rendu `buildMetadata()` et `buildJsonLd()` à appeler par un frontend Next.js ou autre consommateur Payload.

### Configuration publique

```ts
nimSeoPlugin({
  collections: {
    posts: { titleField: 'title', extractContent: postToPlainText, resolveURL: postURL, mediaCollection: 'media' },
    pages: { titleField: 'title', extractContent: pageToPlainText, resolveURL: pageURL, mediaCollection: 'media' },
  },
  locales: ['fr', 'en'],
  nim: { baseURL: process.env.NIM_BASE_URL, apiKey: process.env.NIM_API_KEY, model: process.env.NIM_MODEL },
  site: { defaultLocale: 'fr', organization: { name: '…', url: '…' } },
  permissions: { generate: isSeoEditor, apply: isSeoEditor, manage: isSeoAdmin },
})
```

Chaque collection doit fournir `extractContent({ doc, locale })`, qui convertit le rich text/blocs du projet en texte borné envoyé au modèle, et `resolveURL({ doc, locale })`, qui retourne l’URL publique localisée. Le plugin ne devine ni la structure de contenu ni le routage du site : sans URL, il ne génère pas de canonical ni de champs JSON-LD qui exigent une URL. Le slug est délibérément hors du périmètre du socle : les routes et contraintes d’unicité Payload varient trop selon le projet ; une extension future pourra l’ajouter via un adaptateur par collection.

Le plugin exige que le projet hôte active Payload localization pour `fr` et `en` (ou les deux locales configurées) ; il valide cette compatibilité au démarrage et explique la correction si elle manque. Le tableau `locales` du plugin est nécessairement un sous-ensemble des locales Payload de l’hôte.

### Données persistées sur le contenu

Tous les champs ci-dessous sont localisés par Payload :

- `seo.meta`: `title`, `description`, `canonical`, `robots`, `focusKeyphrase`.
- `seo.social`: relation `image` vers la médiathèque, `imageAlt`, `imageFilename`, `imageCaption`, `recommendedWidth`, `recommendedHeight`, `ogTitle`, `ogDescription`, `twitterCard`.
- `seo.schema`: liste de graphes JSON-LD validés et versionnés, avec type Schema.org déclaré.
- `seo.citability`: `summary`, maximum 2 000 caractères, plus sources/claims facultatifs.
- `seo.status`: date de dernière validation, état de complétude et avertissements de validation.

Les données validées n’écrasent pas les champs source du contenu. L’éditeur sélectionne précisément les groupes/champs d’une proposition à appliquer.

### Propositions et traitements

`seo-proposals` contient le document source, la locale, un instantané/empreinte des champs utilisés, le résultat structuré de NIM, les avertissements, le diff, l’auteur et l’état (`draft`, `approved`, `applied`, `discarded`, `failed`). Une proposition devient périmée lorsque le contenu a changé après sa création ; le panneau bloque son application jusqu’à régénération ou confirmation explicite.

`seo-runs` garde les opérations de lot : filtre Payload, collections/locales, progression, erreurs document par document, coût ou consommation si retourné par le fournisseur. Une tâche de lot lit chaque document dans sa locale, crée une proposition et n’applique rien. Le plugin s’appuie sur les jobs Payload activés par l’hôte pour les lots et échoue clairement à l’initialisation si la file n’est pas configurée ; la génération d’un seul document conserve une exécution serveur directe, afin de rester utilisable sans worker pour le flux éditorial.

### Génération NIM et garde-fous

Un adaptateur NIM appelle le endpoint compatible OpenAI côté serveur. Les prompts demandent un JSON strict correspondant à un schéma Zod/JSON Schema ; la sortie est parseée, validée et rejetée/réessayée si elle est invalide. Le contexte comprend uniquement les champs configurés, la locale, le type de contenu, le site et les règles de longueur. Les règles déterministes sont appliquées après réponse : limites de longueurs, 2 000 caractères maximum pour `citability.summary`, dédoublonnage, URL/canonical valides, types Schema.org autorisés, structure JSON-LD sûre et absence de balisage dangereux.

La médiathèque n’est jamais transmise intégralement à NIM. L’éditeur choisit l’image dans le sélecteur Payload, puis le plugin envoie uniquement les métadonnées de cette image sélectionnée (identifiant, nom, texte alternatif existant, dimensions et légende) pour obtenir une proposition de métadonnées. Une option d’extension permettra plus tard de fournir une liste explicitement limitée et filtrée d’assets si une sélection IA est souhaitée.

Les clés et URLs NIM restent dans les variables d’environnement/configuration serveur. Le navigateur appelle uniquement les endpoints Payload autorisés. Les journaux excluent les secrets et limitent le contenu journalisé.

### Admin bilingue

Les libellés, statuts, erreurs et actions du plugin sont fournis dans un catalogue `fr`/`en`. Le panneau affiche la locale active et ne présente que les propositions correspondant à cette locale. Il comprend :

```
SEO IA · Français
État : 62 % complet   [Auditer] [Générer une proposition]

Proposition du 12 nov.   Modifications : meta · OG · JSON-LD · citabilité
[Prévisualiser le diff] [Sélectionner les éléments] [Appliquer] [Rejeter]
```

Le tableau « Audit SEO » filtre par collection, locale, statut et score ; il permet de planifier la génération de propositions pour la sélection.

### Flux

1. L’éditeur crée/modifie un document dans une locale et demande une proposition, ou un administrateur lance un audit/lot.
2. Une tâche extrait le contenu configuré, appelle NIM et persiste une `seo-proposal` validée.
3. Le panneau montre un diff lisible, les alertes et l’aperçu des graphes/OG.
4. Un éditeur habilité applique les éléments cochés ; les champs localisés du document sont mis à jour et la proposition est marquée `applied`.
5. Le frontend lit les champs validés pour ses balises HTML/JSON-LD.

## Qualité, sécurité et tests attendus

- Tests unitaires de l’adaptateur NIM, des schémas de sortie, limites de caractères, validation JSON-LD, diff et règles de locale.
- Tests d’intégration Payload : injection de plugin, champs localisés FR/EN, création de proposition, application partielle, refus des permissions et traitement de lot sans mutation du contenu.
- Tests d’admin : locale active, écran de diff et actions protégées.
- Tests de contrat simulés pour le JSON NIM ; aucune clé ou requête réelle dans la suite.
- Documentation : installation, variables d’environnement, configuration des collections/médias, accès, exemple de rendu Next.js, limites et migration.

## Décisions du builder

- Choisir le gestionnaire de paquets, l’outillage de build et le framework de tests adaptés au nouveau dépôt.
- Définir le modèle NIM par défaut et les prompts précis, dans une surface configurable.
- Définir les seuils SEO non imposés par une spécification (hors limite confirmée de 2 000 caractères).
- Prévoir des types Schema.org supplémentaires sous une allow-list et des extensions documentées.

