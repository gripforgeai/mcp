# Consignes pour les agents IA

Ce dépôt est **public** : rien d'interne n'y entre (outils de l'équipe, machines, adresses, liens vers des dépôts
privés, secrets).

- `src/`, `runtime/`, `package.json`, `server.json`, `tsconfig.json`, `icon.png` et `.github/workflows/publish.yml`
  sont recopiés depuis le dépôt du produit à chaque version : ne pas les modifier ici, une modification serait écrasée.
- README, docs, modèles d'issue et de PR se modifient ici, par une PR (voir `CONTRIBUTING.md`).
- Les outils propres à l'équipe (bus des agents, hooks de session) restent sur la machine de chacun : ils sont exclus
  par `.gitignore`.
