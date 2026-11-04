# 🔐 Sécurité

> [!CAUTION]
> **Une faille ? Ne l'écrivez jamais dans une issue publique.** Ce dépôt est public : tout le monde la lirait.

## 📣 Signaler une faille

| Quoi | Où |
|---|---|
| Faille de sécurité dans ce serveur | **signalement privé de GitHub** : onglet **Security** → **Report a vulnerability** |
| Secret ou clé exposé (le vôtre ou celui d'un autre) | idem, ou le responsable en privé |
| Bug sans enjeu de sécurité | issue avec le formulaire 🐛 Bug, sans coller de secret |
| Question | voir [SUPPORT.md](.github/SUPPORT.md) |

Le signalement privé de GitHub garde votre message visible des seuls mainteneurs, le temps de corriger.

## 🔑 Secrets

- `GRIPFORGE_API_KEY` (clé d'API, forme `gf_…`) : donnée par l'utilisateur au client MCP (variable d'environnement ou
  en-tête `x-api-key`), **jamais** écrite dans le dépôt, un exemple ou un journal. Les exemples du README utilisent
  `gf_...`.
- `GRIPFORGE_PUBLICATION_TOKEN` : jeton de publication de jeux, lu par le serveur depuis l'environnement uniquement.
- Publication : `NPM_TOKEN` (secret GitHub Actions, facultatif) ; sans lui, la publication npm utilise le « trusted
  publishing » OIDC (aucun jeton stocké), et le registre MCP s'authentifie aussi par OIDC.
- Les variables `GRIPFORGE_*_BIN` / `GODOT_BIN` pointent vers des outils locaux : ce sont des chemins, pas des secrets,
  mais ne les commitez pas non plus.

> [!WARNING]
> Un secret commité ou affiché par erreur : le **révoquer tout de suite** (clé d'API : créer une nouvelle clé sur
> gripforge.ai et supprimer l'ancienne ; `NPM_TOKEN` : le révoquer sur npmjs.com), puis le retirer de l'historique.
> Le supprimer dans un nouveau commit ne suffit pas : dans un dépôt public, il est déjà copié.

## 🛡️ Bon à savoir

- Le serveur démarre sans clé et n'en exige une que pour appeler un outil ; l'adresse de l'API se règle avec
  `GRIPFORGE_API_URL` (par défaut `https://gripforge.ai`) : ne la pointez que vers un serveur de confiance.
- Les outils « locaux » du paquet npm écrivent dans le dossier du projet de l'utilisateur (`out_dir`,
  `project_dir`) ; une livraison de gamekit sauvegarde les fichiers remplacés dans `gripforge/.backup/`.
- Le workflow de publication tourne sur des runners GitHub hébergés, avec des permissions minimales
  (`contents: read`, `id-token: write`).
