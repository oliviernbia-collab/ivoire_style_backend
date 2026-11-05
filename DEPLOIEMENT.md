# Déploiement continu — Ivoire Style

Chaque envoi sur la branche `main` d'un dépôt met en ligne sa partie, sans intervention :

| Dépôt | Outil | Ce qui se passe |
|---|---|---|
| `ivoire_style_backend` | GitHub Actions (`.github/workflows/deploy.yml`) | vérification du code → envoi par FTP chiffré dans `backendivoirestyle` → redémarrage (Passenger) → **migration de la base au démarrage** → contrôle de `/api/v1/health` |
| `ivoire_style_web` | GitHub Actions (`.github/workflows/deploy.yml`) | build Vite → envoi par FTP chiffré dans `public_html/ivoire-style.site` (le dossier `api` n'est jamais touché) → contrôle du site |
| `ivoire_style_mobile` | EAS Workflows (`.eas/workflows/deploy.yml`) | code natif inchangé → **mise à jour à distance** (reçue au prochain lancement de l'app) ; code natif modifié → **nouvel APK** compilé |

Un déploiement peut être relancé à la main : GitHub → *Actions* → le workflow → *Run workflow*.
Les fichiers propres au serveur (`.env`, `node_modules`, `stderr.log`) ne sont jamais envoyés ni supprimés.

## Base de données

- Toute évolution du schéma s'écrit dans `database/migrations.js` (chaque étape vérifie l'état avant d'agir)
  et dans `database/schema.sql` pour les nouvelles installations.
- L'API applique les migrations **à chaque démarrage**, avant de servir la moindre requête, sous verrou MySQL
  (une seule instance migre). Si une migration échoue, l'API ne démarre pas et l'erreur est dans `stderr.log`.
- `npm run db:migrate` applique les mêmes étapes à la main.
- Sauvegardes : celles de LWS (cPanel → *Sauvegarde* / JetBackup). Avant une migration risquée, exporter la base
  depuis phpMyAdmin.

## Dépendances de l'API

Si `package.json` change (nouvelle bibliothèque), le workflow l'indique : cliquer ensuite sur
**Run NPM Install** puis **Restart** dans cPanel → *Setup Node.js App*.

## Mise en place (une seule fois)

### 1. Comptes FTP (cPanel → *Comptes FTP*)
Créer deux comptes limités chacun à son dossier :

| Compte | Répertoire |
|---|---|
| `deploy-api` | `backendivoirestyle` |
| `deploy-web` | `public_html/ivoire-style.site` |

### 2. Secrets GitHub (*Settings* → *Secrets and variables* → *Actions*)

| Dépôt | `FTP_SERVER` | `FTP_USERNAME` | `FTP_PASSWORD` |
|---|---|---|---|
| `ivoire_style_backend` | `web41.lws-hosting.com` | identifiant complet du compte `deploy-api` (ex. `deploy-api@olitechnologie.com`) | son mot de passe |
| `ivoire_style_web` | `web41.lws-hosting.com` | identifiant complet du compte `deploy-web` | son mot de passe |

Variable facultative `FTP_DIR` (onglet *Variables*) : chemin du dossier vu par le compte FTP, se terminant par `/`,
si le compte n'est pas limité à ce dossier (ex. `backendivoirestyle/` pour le compte FTP principal).

### 3. Application mobile
expo.dev → projet `ivoire-style` → *Project settings* → *GitHub* → connecter le dépôt `ivoire_style_mobile`.
L'adresse de l'API des mises à jour à distance est la variable EAS `EXPO_PUBLIC_API_URL` (environnement `production`).

Le premier déploiement compile un APK avec le module de mise à jour à distance : il faut l'installer **une fois**.
Les versions suivantes arrivent ensuite d'elles-mêmes (fermer puis rouvrir l'app, deux fois au besoin).

## Points d'attention
- Le cache Varnish de LWS ne garde pas les réponses de l'API (en-tête `Cache-Control: no-store`).
- Un changement de code natif (nouveau module Expo, permissions, icône, `app.json`) produit un nouvel APK à réinstaller.
