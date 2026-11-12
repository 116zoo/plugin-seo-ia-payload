# Extension de génération éditoriale complète — conception

## Intention

Étendre le plugin Payload SEO IA pour qu’il propose le remplissage de tous les champs **éditoriaux configurés** d’un document, à l’exception du champ principal `content`. Chaque proposition reste un brouillon par locale, lisible en diff et applicable champ par champ. La génération produit aussi un graphe sémantique JSON-LD `@graph` reliant le contenu principal, ses médias, ses relations Payload et les nouveaux brouillons proposés.

## Pourquoi

Le plugin actuel produit surtout la couche SEO. L’objectif est qu’un éditeur puisse préparer une fiche complète (titre, chapô, FAQ, CTA, relations, médias, dates, choix, etc.) sans perdre la maîtrise du texte long `content`, de la publication ni des permissions.

## Objectifs

- Ajouter par collection une déclaration `editorialFields` de chemins Payload générables ; `content` est obligatoirement exclu.
- Supporter texte, textarea, rich-text court configurable, nombre, date, checkbox, select, relation, upload, groupe, array, blocks et tabs via un adaptateur de champ explicite.
- Proposer les relations existantes et, pour les collections explicitement autorisées, proposer de nouveaux documents liés comme brouillons.
- Générer un unique graphe JSON-LD `@graph` cohérent : contenu, organisation, auteur, média, taxonomie, FAQ et entités liées.
- Prévisualiser un diff hiérarchique et laisser l’éditeur choisir chaque champ, relation et brouillon lié avant application.
- Garantir l’indépendance FR/EN : lecture et écriture dans la locale active uniquement, sans traduction ni copie automatique.

## Hors périmètre

- Génération ou modification du champ `content`.
- Création automatique, publication automatique ou liaison automatique de documents liés.
- Modification des champs techniques : identifiants, auteur système, statut, accès, permissions, timestamps, slug/routage, versions et données de paiement.
- Déduction implicite qu’une collection liée est sûre à créer : l’hôte doit l’autoriser explicitement.

## Approches considérées

1. Détecter et remplir tout le schéma Payload : couverture large mais comportement non fiable sur les relations et données métier.
2. **Moteur de schéma configurable retenu** : une déclaration par collection identifie les champs éditoriaux, leurs règles et les collections liées autorisées. C’est la couverture maximale demandée avec des garde-fous portables.
3. Modèle éditorial codé collection par collection : trop coûteux pour un plugin réutilisable.

## Configuration publique

```ts
nimSeoPlugin({
  collections: {
    posts: {
      titleField: 'title',
      localizedSourceFields: ['title', 'excerpt', 'content'],
      editorialFields: {
        include: ['title', 'excerpt', 'subtitle', 'faq', 'cta', 'publishedOn', 'category', 'tags', 'featuredImage'],
        exclude: ['content'],
        relations: {
          category: { relationTo: 'categories', allowCreate: true },
          tags: { relationTo: 'tags', allowCreate: true },
          featuredImage: { relationTo: 'media', allowCreate: false },
        },
      },
      extractContent,
      resolveURL,
      mediaCollection: 'media',
    },
  },
})
```

Le démarrage valide : chemins existants, absence de `content`, champs localisés, type réellement compatible, relation ciblée cohérente et autorisation de création explicitement déclarée.

## Proposition et graphe

Une proposition gagne `editorial` : une arborescence de patches `{ path, operation, value, rationale }`, et `relatedDrafts` : des documents créables `{ collection, localId, fields, graphNodeId }`. Les valeurs respectent les types Payload validés localement. Les relations vers un brouillon utilisent `localId` jusqu’à validation.

Le modèle répond avec un objet structuré comprenant SEO existant, patches éditoriaux, brouillons liés et un seul `semanticGraph` sous forme de `@graph`. Le serveur valide les types Schema.org, les références `@id`, le contexte, la profondeur, les URLs et l’absence de référence vers un brouillon non déclaré.

## Application

L’éditeur coche des patches et brouillons. Le serveur recharge le document et la proposition, vérifie locale, accès, empreinte et permissions. Il crée d’abord les brouillons liés sélectionnés dans une transaction, résout leurs relations, puis applique uniquement les patches sélectionnés au document dans la même transaction. Les patches sur `content`, les chemins non déclarés et les champs techniques sont rejetés même si le client les envoie.

Le graphe final est reconstruit à partir des seuls patches, relations et brouillons effectivement sélectionnés : aucun nœud non appliqué ne survit dans les données validées ou le rendu frontend. Toute collection liée générable déclare ses propres `editorialFields`, avec la même exclusion de `content`.

L’application conserve l’atomicité actuelle : une erreur de création liée, de relation ou de mise à jour annule le tout. Chaque création liée est attribuée à l’éditeur validant et reste en brouillon lorsque la collection le permet ; une collection explicitement autorisée mais sans brouillon peut recevoir un document ordinaire uniquement après validation de l’éditeur.

## Interface admin

Le panneau de la locale active ajoute « Contenu éditorial » avec une arborescence de diff, des choix par champ, une section « Éléments liés à créer », et la prévisualisation du graphe. L’écran explique que `content` est exclu et qu’aucune traduction n’est produite.

```
Proposition · Français
☑ Titre                 "..."
☑ Chapô                 "..."
☑ Catégorie             Existant : Culture
☐ Nouveau tag           "Art numérique" (brouillon)
— Content               Conservé par l’éditeur

Graphe sémantique : Article → Personne → Organisation → ImageObject
```

## Sécurité, tests et documentation

- Tests unitaires des chemins configurés, exclusion `content`, coercition de type, graphes, références locales et garde-fous.
- Tests Payload d’accès et de transaction : patch interdit, création liée autorisée/refusée, rollback complet, indépendance FR/EN et brouillon non publié.
- Tests navigateur : sélection de champs, de brouillons liés, visualisation du graphe et absence de `content`.
- Documentation : configuration de collection, liste des types supportés, relations créables, limites et intégration frontend du graphe.
