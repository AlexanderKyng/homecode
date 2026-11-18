# Prototype hiérarchique fichier → chunks

Ce prototype évalue une récupération en deux temps sans changer le classement de production : Semble fournit les fichiers candidats, puis leurs chunks sont rescorrés localement. Il lit uniquement les générations HomeGrep déjà présentes. Aucun graphe, modèle, index ou état persistant n'est créé par l'expérience.

## Reproduction

Le run a utilisé un environnement Python isolé, la révision Semble `8ee6463efbb1ff755c339e965c7298b7afd7db5b` et les cinq générations consignées dans le JSON de résultats. Depuis `packages/homegrep`, définissez `SEMBLE_PYTHON` vers l'interpréteur de cet environnement. Si Semble n'est pas déjà sur son chemin d'import, définissez aussi `SEMBLE_PYTHONPATH` vers son répertoire `site-packages` :

```sh
PYTHONPATH="${SEMBLE_PYTHONPATH:-}" \
HOMEGREP_HOME="${HOMEGREP_HOME:-.homegrep-hierarchical-eval}" \
HOMEGREP_EVAL_OUTPUT=benchmarks/agentic-retrieval-v2/experiments/hierarchical/results-2026-11-17.json \
"${SEMBLE_PYTHON:-python3}" benchmarks/agentic-retrieval-v2/experiments/hierarchical/evaluate.py \
  --timing-repetitions 10
```

La commande échoue si les cinq qrels ne sont pas présents ou si une génération d'index manque; elle ne déclenche pas d'indexation. Les répétitions supplémentaires servent uniquement aux latences. Les mesures de pertinence portent sur 150 tâches indépendantes : 90 en développement et 60 en test tenu à l'écart. HomeEngine.cpp et mini-swe-agent sont exclusivement dans le split tenu à l'écart pour la sélection des paramètres.

## Protocole

Le balayage croise deux ordres de fichiers (`default`, première apparition dans le top 100 Semble; `channel_rrf`, meilleure fusion des rangs BM25 et vectoriels), cinq budgets de fichiers (5, 10, 25, 50, 100), quatre plafonds de chunks par fichier (1, 3, 10, sans plafond) et trois classements locaux (BM25, cosinus dense, RRF). Les passages sont choisis par les scores seulement. Les qrels ne servent qu'à calculer les métriques et à sélectionner un réglage sur les seuls dépôts de développement.

Les chemins sont dédupliqués dans l'ordre de première apparition. Les chunks sont identifiés par chemin relatif normalisé et lignes de début/fin; les égalités de score sont départagées par ce triplet. Le benchmark de référence appelle directement la recherche Semble épinglée avec le même index. Les scores BM25 bruts et les similarités cosinus sont enregistrés séparément. Pour les canaux, le diagnostic compare le top 500 de chaque canal au top 100 hybride.

Les métriques sont des moyennes macro par tâche avec au moins un jugement applicable : Recall symbolique@10/100 et nDCG symbolique@10; Recall fichiers@10/100 et nDCG fichiers@10. Les intervalles à 95 % sont des bootstraps appariés par tâche, 2 000 tirages, graine fixe. Les latences p50/p95 sont mesurées sur les 60 requêtes tenues à l'écart, dix répétitions chacune, sans phase de chauffe dédiée. Le budget de contexte compte les dix premiers chunks en caractères et mots séparés par des espaces; aucun tokenizer du modèle consommateur n'est imposé ici, donc ces valeurs ne sont pas des tokens exacts.

La sélection sur développement garde le Recall fichier@10 à 1 point, le Recall fichier@100 à 2 points et le nDCG fichier@10 à 3 points du Semble initial. Parmi les réglages admissibles, elle maximise le nDCG symbolique@10, puis le Recall symbolique@10 et @100, et départage par le nombre de chunks rescorrés. Le résultat sélectionné est `default/files100/chunks10/rrf`. Aucun score des deux dépôts de test n'intervient dans ce choix.

## Résultats observés

Sur les 60 tâches tenues à l'écart, le réglage sélectionné fait passer le Recall symbolique@100 de 0,669 à 0,800 (+13,1 points; IC apparié 95 % [+4,7; +23,1]). Le Recall symbolique@10 progresse de 0,386 à 0,433 (+4,7 points; IC [−3,6; +12,8]) et le nDCG symbolique@10 de 0,314 à 0,318 (+0,4 point; IC [−6,9; +7,4]); ces deux intervalles incluent zéro.

Le coût est défavorable pour la navigation par fichiers : Recall fichier@10 0,892 → 0,783 (−10,8 points; IC [−21,7; −0,8]) et nDCG fichier@10 0,650 → 0,534 (−11,6 points; IC [−19,9; −3,2]). Le Recall fichier@100 baisse de 0,992 à 0,983 (−0,8 point; IC [−2,5; 0]). HomeEngine.cpp récupère davantage de symboles à 100 (0,417 → 0,633), mais son Recall fichier@10 baisse de 0,933 à 0,700 et son nDCG fichier@10 de 0,625 à 0,450. mini-swe-agent conserve presque son Recall fichier@10 (0,850 → 0,867) avec un nDCG fichier en baisse (0,674 → 0,618).

Parmi les 42 échecs intra-fichier historiques, le prototype en récupère 20 : 8/18 sur le développement et 12/24 sur le test. Il ne résout donc pas le problème de granularité dans près de la moitié des cas.

Les 44 symboles manqués par Semble dans le diagnostic historique se répartissent ainsi dans les pools bruts top 500 : 28 sont présents dans les deux canaux, 1 en BM25 seul, 7 en dense seul et 8 dans aucun. Dans les seuls 42 échecs intra-fichier, 36 sont donc présents dans au moins un pool de canal, mais n'atteignent pas le top 100 final. Cela pointe principalement le classement et le seuil de sortie après génération des candidats. Les scores bruts BM25 et cosinus ont des unités différentes, mais Semble les convertit en rangs RRF avant fusion; un simple déséquilibre d'échelle n'explique pas à lui seul ces pertes. Une vérification sur une requête HomeCode a retrouvé les mêmes 500 chunks vectoriels que le backend Semble (erreur maximale de norme des vecteurs : 1,8×10⁻⁷). Les distributions par jugement et les résultats complets se trouvent dans le JSON.

Le réglage sélectionné prend 26,4 ms p50 et 84,0 ms p95, contre 17,1 ms et 39,6 ms pour Semble sur les mêmes requêtes: environ 1,5× et 2,1× plus lent. Il rescorrige en moyenne 630 chunks par tâche tenue à l'écart. Le contexte des dix premiers chunks est de 6 693 caractères / 704 mots p50 et 17 840 caractères / 2 371 mots p95, contre 6 730 / 873 et 23 600 / 3 285 pour Semble. Le RSS maximum du processus complet est 443 344 KiB; charger les cinq générations existantes prend environ 0,57 s au total. Le balayage complet consomme 866 s CPU, coût de mesure hors requête interactive.

## Interprétation

Le prototype donne un gain de rappel symbolique@100 mesurable sur les dépôts tenus à l'écart, mais les intervalles ne démontrent pas de gain pour les métriques de tête (Recall@10 et nDCG@10), tandis que le classement des fichiers et la latence régressent nettement. Le bénéfice agrégé masque en outre une forte variation entre dépôts. Ces résultats justifient de garder l'approche au stade expérimental; ils ne justifient pas son activation par défaut.

Le test ne mesure pas le taux de résolution d'un agent. Les qrels sont manuels, sans accord inter-annotateurs, et seuls 179 jugements de symboles sont disponibles. Les « mots » ne sont pas des tokens de modèle. Le prototype utilise les API internes de Semble épinglé pour lire les scores, ce qui rend la reproduction dépendante de cette révision. L'index, les fichiers qrels et les résultats historiques restent inchangés; ce dossier expérimental est réversible et isolé du moteur de production.
