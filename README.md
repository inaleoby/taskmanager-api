# Task Manager — Backend API

API de gestion de tâches (Express.js), déployée sur deux environnements AWS : staging (EC2 + Docker Compose) et production (ECS Fargate + RDS PostgreSQL), avec CI/CD GitHub Actions et rollback automatique sur les deux.

Documentation détaillée (historique, erreurs rencontrées, corrections) : [`documentation-complete-backend.md`](./documentation-complete-backend.md)
Schéma d'architecture : [`taskmanager-architecture.drawio`](./taskmanager-architecture.drawio) (à ouvrir sur [app.diagrams.net](https://app.diagrams.net))

---

## Architecture

```
                 ┌─────────────┐
   dev  ────────▶│  EC2 test   │  Docker Compose, rollback par script
                 └─────────────┘
push/PR                │
                        ▼
                 ┌─────────────┐        ┌──────────┐
   main ────────▶│ ECS Fargate │───────▶│   RDS    │
push/PR          │  (ALB+HTTPS)│        │PostgreSQL│
                 └─────────────┘        └──────────┘
```

- **Registry d'images** : Amazon ECR (repo privé `taskmanager-api`)
- **Auth CI/CD → AWS** : OIDC (aucune clé statique stockée dans GitHub)
- **Domaine** : `api-taskmanager.votre-domaine.com` (HTTPS via ACM)

---

## Prérequis

- Docker + Docker Compose
- Node.js (version du `Dockerfile`)
- AWS CLI v2, configuré avec un accès IAM valide (`aws sts get-caller-identity` doit répondre)
- Accès au compte AWS du projet (region `<region>`)

---

## Développement local

```bash
docker compose up -d
```

Lance l'API + une base PostgreSQL locale. Variables d'environnement dans `.env` (voir `.env.example`).

---

## Environnements déployés

| Environnement | Déclencheur | Infra | URL |
|---|---|---|---|
| Staging | push/merge sur `dev` | EC2 + Docker Compose | interne (SSH) |
| Production | push/merge sur `main` | ECS Fargate + ALB + RDS | https://api-taskmanager.votre-domaine.com |

Le déploiement est **automatique** via GitHub Actions (`.github/workflows/ci-cd.yml`) — aucune action manuelle nécessaire pour un déploiement standard.

---

## CI/CD — ce que fait le pipeline

1. **Build & push** : build l'image Docker, tag `<short-sha>`, push sur ECR
2. **Staging** (`dev`) : copie `docker-compose.yml` + script de déploiement sur l'EC2 via SCP, déploiement via SSH, rollback automatique si le health check échoue
3. **Production** (`main`) : récupère la task definition ECS actuelle, met à jour uniquement l'image, déploie via `ecs:UpdateService` — rollback automatique géré nativement par le **circuit breaker ECS** si le déploiement échoue (aucun script requis)

---

## Rollback

| Environnement | Mécanisme |
|---|---|
| Staging (EC2) | Script custom (`deploy.sh`) : health check + retour au tag précédent |
| Production (ECS) | Circuit breaker natif ECS : après 3 échecs consécutifs, retour automatique à la dernière révision saine de la task definition, sans interruption de service (`Min running tasks: 100%`) |

Rollback manuel possible depuis la console ECS (bouton **Roll-back** sur l'onglet Deployments du service) ou en CLI :
```bash
aws ecs update-service --cluster taskmanager-cluster --service taskmanager-api-service --task-definition <revision-précédente> --region <region>
```

---

## Variables et secrets requis (GitHub Actions)

**Variables** (Settings → Secrets and variables → Actions → Variables) :

| Nom | Description |
|---|---|
| `AWS_REGION` | `<region>` |
| `AWS_ACCOUNT_ID` | ID du compte AWS |
| `IMAGE_API_NAME` | `taskmanager-api` |
| `AWS_ROLE_ARN_ECR` | ARN du rôle OIDC pour push sur ECR |
| `AWS_ROLE_ARN_ECS` | ARN du rôle OIDC pour déployer sur ECS |
| `DEPLOY_PATH` | Chemin de déploiement sur l'EC2 staging |

**Secrets** :

| Nom | Description |
|---|---|
| `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`, `SERVER_SSH_PORT` | Accès SSH à l'EC2 staging |

---

## Infrastructure AWS — résumé des ressources

| Ressource | Nom |
|---|---|
| VPC | `ECS-VPC` (`10.0.0.0/16`) |
| Subnets publics | `taskmanager-public-1a`, `taskmanager-public-1b` |
| Subnets privés | `taskmanager-private-1a`, `taskmanager-private-1b` |
| Security Groups | `taskmanager-alb-sg` → `taskmanager-ecs-tasks-sg` → `taskmanager-rds-sg` |
| RDS | `taskmanager-db` (PostgreSQL, credentials dans Secrets Manager) |
| Cluster ECS | `taskmanager-cluster` (Fargate) |
| Service ECS | `taskmanager-api-service` |
| ALB | `taskmanager-alb` |
| Rôles IAM (déploiement) | `github-actions-ecr-push`, `github-actions-ecs-deploy` |
| Rôles IAM (exécution) | `ecsTaskExecutionRole`, `EC2PullECR` |

Détail complet de chaque ressource, permissions IAM, et raisonnement derrière chaque choix : voir [`documentation-complete-backend.md`](./documentation-complete-backend.md).

---

## Déployer manuellement (cas exceptionnel)

**Staging (EC2)** :
```bash
ssh <user>@<ec2-host>
cd <deploy-path>
docker compose pull
docker compose up -d
```

**Production (ECS)** — forcer un redéploiement sans changement de code :
```bash
aws ecs update-service --cluster taskmanager-cluster --service taskmanager-api-service --force-new-deployment --region <region>
```

---

## Limitations connues / améliorations futures

- Migration DB (`migrate.js`) exécutée dans l'entrypoint du conteneur — risque de concurrence si plusieurs tasks démarrent en parallèle (amélioration possible : découpler via `ecs run-task` dédié avant le déploiement)
- Listener HTTP:80 sur l'ALB sans redirection forcée vers HTTPS:443
- `Health check grace period` du circuit breaker ECS à 0s — pas de marge si le démarrage du conteneur (migration incluse) prend du temps
- Approche CI/CD "rebuild sur main" plutôt que promotion d'image testée en staging (pattern "build once, deploy everywhere" non implémenté)
- Frontend non encore déployé (à venir, même pattern EC2/ECS que le backend)
