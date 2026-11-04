<!-- Titre clair : « Combat : barres de vie des ennemis ». Ouvrir en BROUILLON, vers dev :
     gh pr create --draft --base dev ; puis gh pr ready <n°> quand c'est prêt à relire. -->

## 🎯 Quoi et pourquoi

<!-- Ce que change la PR, en deux ou trois phrases. -->

Closes #

## 🧱 Pile

<!-- PR empilée : « dépend de #66 », base = la branche de #66, étage « (2/3) » dans le titre. Sinon, effacer. -->

## 🧪 Résultats

<!-- Comment vous avez testé, captures d'écran ou vidéo collées ici (jamais de chemin de disque). -->

<!-- modele:verifications:debut -->

## ✅ Vérifié par l'auteur (charte commune)

- [ ] Une issue liée (`Closes #…`), branche `labo/<sujet>` partie de `origin/dev`, PR vers `dev`
- [ ] Testé sur ma machine ce que j'ai touché (tests ciblés, lint)
- [ ] CI verte, ou échec **déjà présent** sur `dev` signalé ici avec l'étiquette `déjà-rouge`
- [ ] Doc à jour si un comportement change
- [ ] Nouvelle dépendance : licence citée ici (MIT / BSD / Apache-2.0 en production)
- [ ] Aucun secret, prénom, pseudo, adresse IP ni chemin de disque dans le diff
- [ ] Moins de 400 lignes utiles, ou découpée en pile

<!-- modele:verifications:fin -->

## 🧭 Propre à ce dépôt

- [ ] `npm run build` passe (compilation TypeScript sans erreur) ; aucun fichier `dist/` ni `node_modules/` commité
- [ ] Outil ajouté ou changé : description, schéma `zod` et coût en crédits à jour dans `README.md` (§ Tool reference)
- [ ] Variable d'environnement ajoutée : listée dans `README.md` (§ Env), jamais de valeur par défaut secrète
- [ ] Version : `package.json` et `server.json` montés ensemble si la PR doit être publiée (la publication part d'un push sur `main` qui touche `package.json`)
- [ ] Fichiers `*.generated.ts` : ne pas les éditer à la main (voir `CONTRIBUTING.md`)
- [ ] Dépôt **public** : rien d'interne (machine, runner, dépôt privé, adresse) dans le diff, la description ou les commentaires

## 👀 Pour le relecteur

<!-- Où regarder d'abord, ce qui est risqué, ce qui reste à vérifier. -->
