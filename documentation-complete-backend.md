# Documentation complète — Task Manager Backend

Documentation consolidée du projet : mise en place de l'infrastructure AWS complète (staging EC2 + prod ECS + RDS + DNS/HTTPS), avec chaque étape, les erreurs rencontrées et leurs corrections.

## Table des matières

1. [Étape 1 — Déploiement staging (EC2 + Docker Compose)](#étape-1--déploiement-staging-ec2--docker-compose)
2. [Étape 2 — Déploiement prod (VPC + RDS + ECS)](#étape-2--déploiement-prod-vpc--rds--ecs)
3. [Étape 3 — DNS et HTTPS](#étape-3--dns-et-https-domaine-custom-sur-lalb)

---

Documentation du projet Task Manager : mise en place du pipeline CI/CD pour l'environnement de test (EC2, Docker Compose, rollback), avec ECR comme registry d'images.

---

## 1. Création des repos ECR

- Création de deux repositories ECR privés, un par service :
  - `taskmanager-api`
  - `taskmanager-front`
- Repos en **privé** (pas de raison d'exposer les images publiquement), tag mutability **Mutable**, chiffrement **AES-256** par défaut.

**Format de l'URI d'un repo ECR :**
```
<account-id>.dkr.ecr.<region>.amazonaws.com/<repository-name>[:<tag>]
```

**Erreur rencontrée :** création du repo refusée avec un message `16 out of 256 characters` alors que `taskmanager-api` ne fait que 15 caractères.
**Cause :** espace invisible collé dans le champ (copier-coller).
**Correction :** ressaisir le nom directement au clavier.

---

## 2. Validation manuelle du mécanisme ECR (avant toute automatisation)

Test en local, avant d'introduire GitHub Actions, pour isoler les problèmes IAM des problèmes de pipeline :

```bash
# 1. Authentification (mot de passe temporaire, valide 12h)
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com

# 2. Build
docker build -t taskmanager-api .

# 3. Tag vers l'URI ECR (le nom après le dernier "/" doit correspondre exactement au nom du repo créé)
docker tag taskmanager-api:latest <account-id>.dkr.ecr.<region>.amazonaws.com/taskmanager-api:test-manuel

# 4. Push
docker push <account-id>.dkr.ecr.<region>.amazonaws.com/taskmanager-api:test-manuel
```

Vérification du succès dans la console ECR → repo → onglet Images.

---

## 3. Authentification GitHub Actions → AWS via OIDC

Objectif : ne stocker **aucune clé AWS statique** dans les secrets GitHub.

### 3.1 Création de l'identity provider (OIDC)

Une seule fois par compte AWS — IAM → Identity providers → Add provider :
- Provider type : **OpenID Connect**
- Provider URL : `https://token.actions.githubusercontent.com`
- Audience : `sts.amazonaws.com`

**Erreur rencontrée :** `Invalid value` sur le champ Audience.
**Cause :** espace invisible collé (même type d'erreur qu'à l'étape 1).
**Correction :** ressaisir directement au clavier.

### 3.2 Création du rôle IAM (trusted entity = Web identity)

- Trusted entity type : **Web identity**
- Identity provider : `token.actions.githubusercontent.com`
- Audience : `sts.amazonaws.com`
- GitHub organization : username GitHub (`<votre-username>`)
- GitHub repository : `taskmanager-api`
- GitHub branch : `*` (toutes branches autorisées)
- Nom du rôle : `github-actions-ecr-push`

### 3.3 Création de la policy (permissions du rôle)

Scope minimal : uniquement les actions nécessaires au **push** d'image, rien d'autre (pas de delete, pas de create repo, etc.) :

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": "arn:aws:ecr:<region>:<account-id>:repository/taskmanager-api"
    }
  ]
}
```

**Erreur rencontrée :** `RESOURCE DOES NOT MATCH` à la validation de la policy.
**Cause :** ARN mal formé — service `iam` utilisé au lieu de `ecr`, et région manquante.
**Format correct d'un ARN ECR :** `arn:aws:ecr:<region>:<account-id>:repository/<repository-name>`
**Rappel général sur les ARN AWS :** `arn:aws:<service>:<region>:<account-id>:<resource-type>/<resource-id>` (certains services comme IAM sont globaux et n'ont pas de région dans l'ARN).

### 3.4 Attacher la policy au rôle

IAM → Roles → `github-actions-ecr-push` → Permissions → Attach policies → sélectionner la policy créée.

### 3.5 Référencer le rôle dans la pipeline

- ARN du rôle stocké en **variable GitHub** (`vars.AWS_ROLE_ARN`), pas en secret — un ARN seul ne donne aucun accès sans passer par la validation OIDC.
- Utilisation dans le workflow via `aws-actions/configure-aws-credentials@v4` (`role-to-assume`) puis `aws-actions/amazon-ecr-login@v2`.

**Erreur rencontrée :** `Error: Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity`
**Cause :** le format du claim `sub` envoyé par GitHub a changé — il inclut désormais les **IDs numériques immuables** de l'utilisateur et du repo, collés avec `@` :
```
sub: repo:<votre-username>@<owner-id>/taskmanager-api@<repo-id>:ref:refs/heads/dev
```
au lieu du format classique `repo:<votre-username>/taskmanager-api:ref:...` attendu par une trust policy du type `repo:<votre-username>/*`.

**Diagnostic** : ajout temporaire d'un step de debug pour lire le contenu réel du token OIDC :
```yaml
- name: Debug OIDC token claims
  run: |
    curl -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
      "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | \
      jq -r '.value' | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

**Correction** : mise à jour du `sub` dans la trust policy pour matcher le nouveau format :
```json
"StringLike": {
  "token.actions.githubusercontent.com:sub": [
    "repo:<votre-username>@<owner-id>/taskmanager-api@<repo-id>:*"
  ]
}
```

**Note pour retrouver ces IDs sans repasser par le debug :**
```bash
curl -s https://api.github.com/repos/<votre-username>/taskmanager-api | jq '{owner_id: .owner.id, repo_id: .id}'
```

---

## 4. Authentification de l'EC2 pour pull l'image (côté déploiement)

Même logique que pour GitHub Actions : éviter tout credential statique stocké sur le serveur.

### 4.1 Création d'un rôle IAM pour l'instance EC2

- Trusted entity : **AWS service → EC2**
- Nom du rôle : `EC2PullECR`

### 4.2 Création de la policy (permissions de pull)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": [
        "arn:aws:ecr:<region>:<account-id>:repository/taskmanager-api",
        "arn:aws:ecr:<region>:<account-id>:repository/taskmanager-front"
      ]
    }
  ]
}
```

### 4.3 Attacher la policy au rôle, puis le rôle à l'instance

- IAM → Roles → `EC2PullECR` → Add permissions → Attach policies
- EC2 → instance → Actions → Security → **Modify IAM role** → sélectionner `EC2PullECR` (peut se faire à chaud, sans redémarrage)

### 4.4 Installation de l'AWS CLI v2 sur l'EC2

Le package `awscli` via `apt` n'était pas disponible / proposait une version obsolète (v1). Installation via l'installeur officiel :
```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
sudo apt install unzip -y
unzip awscliv2.zip
sudo ./aws/install
```

**Erreur rencontrée :** `AccessDeniedException` sur `ecr:GetAuthorizationToken` malgré une policy en apparence correcte.
**Cause :** la policy avait été **créée mais jamais attachée** au rôle `EC2PullECR` (deux actions distinctes dans IAM : créer une policy ≠ l'attacher à un rôle).
**Correction :** attacher explicitement la policy au rôle via l'onglet Permissions.

---

## 5. Docker Compose — référencer l'image ECR

```yaml
services:
  api:
    image: <account-id>.dkr.ecr.<region>.amazonaws.com/taskmanager-api:${IMAGE_TAG}
    container_name: task-api
    ports:
      - "3001:3000"
    env_file:
      - .env
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --spider 127.0.0.1:3000/health"]
      interval: 1m30s
      timeout: 30s
      retries: 5
      start_period: 30s
```

`IMAGE_TAG` injecté dynamiquement au moment du déploiement (short SHA du commit), pas de tag `latest` utilisé en autonome pour garder la capacité de rollback précis.

**Erreur rencontrée :** health check du script de déploiement bloqué sur `not_found` en boucle, alors que `docker ps` montrait le conteneur `Up (healthy)`.
**Cause :** le script `deploy.sh` interrogeait un nom de conteneur erroné (`pdj-api`, reliquat d'un projet précédent) au lieu de `task-api`.
**Correction :** correction du nom de conteneur référencé dans le script.

---

## 6. Secrets vs Variables GitHub Actions

| Donnée | Type | Raison |
|---|---|---|
| `AWS_REGION`, `AWS_ACCOUNT_ID`, `IMAGE_API_NAME` | Variable | Non sensible |
| `AWS_ROLE_ARN` | Variable | Un ARN seul ne donne aucun accès sans validation OIDC |
| `DEPLOY_PATH` | Variable | Simple chemin serveur |
| `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`, `SERVER_SSH_PORT` | **Secret** | Accès SSH direct au serveur |

Principe retenu : aucune donnée réellement sensible n'est nécessaire pour l'auth AWS (OIDC), seuls les accès SSH restent des secrets classiques.

---

## 7. Résultat final validé

- Pipeline déclenché sur push/PR vers `dev` (déploiement effectif uniquement sur push/merge réel, pas à l'ouverture de la PR)
- Build → push ECR → SCP du compose + script vers l'EC2 → SSH deploy
- Health check fonctionnel
- **Rollback testé et validé** : déploiement d'un tag volontairement cassé → script revient automatiquement sur le tag précédent stable

---

## Récapitulatif des erreurs rencontrées (liste courte)

1. Espace invisible dans le nom du repo ECR
2. Espace invisible dans le champ Audience du OIDC provider
3. ARN mal formé dans la policy IAM (service `iam` au lieu de `ecr`, région manquante)
4. Mismatch du claim `sub` OIDC — nouveau format GitHub avec IDs numériques immuables
5. Policy IAM créée mais non attachée au rôle `EC2PullECR`
6. Nom de conteneur erroné dans le script de health check (`pdj-api` au lieu de `task-api`)

Documentation du projet Task Manager : mise en place de l'infrastructure prod (VPC custom, RDS PostgreSQL, cluster ECS Fargate, ALB), construite manuellement avant automatisation CI/CD.

---

## 2.1 — VPC

- VPC `ECS-VPC`, CIDR `10.0.0.0/16`, région `<region>`
- 4 subnets sur 2 AZ :

| Subnet | CIDR | AZ | Type |
|---|---|---|---|
| `taskmanager-public-1a` | `10.0.0.0/24` | <region>a | Public |
| `taskmanager-public-1b` | `10.0.1.0/24` | <region>b | Public |
| `taskmanager-private-1a` | `10.0.10.0/24` | <region>a | Privé |
| `taskmanager-private-1b` | `10.0.11.0/24` | <region>b | Privé |

- Internet Gateway attaché au VPC, route table publique → IGW
- **NAT Gateway** (choix retenu plutôt que VPC Endpoints) placé dans un subnet public, route table privée → NAT Gateway
- Créé via l'assistant "VPC and more" de la console (subnets, IGW, NAT, route tables générés automatiquement), puis vérifié manuellement

**Pourquoi RDS a besoin d'un minimum de 2 AZ même en single-AZ :** RDS gère lui-même le placement de l'instance parmi les subnets fournis (migration interne, maintenance, failover potentiel) — contrairement à EC2/ECS où le subnet est choisi explicitement à un instant T.

---

## 2.2 — Security Groups

Principe : chaque SG n'autorise que le SG précédent dans la chaîne comme source, jamais d'IP ouverte en interne.

```
Internet → ALB (taskmanager-alb-sg) → Tasks ECS (taskmanager-ecs-tasks-sg) → RDS (taskmanager-rds-sg)
```

| SG | Inbound | Source |
|---|---|---|
| `taskmanager-alb-sg` | HTTP 80 (+ HTTPS 443 si besoin futur) | `0.0.0.0/0` |
| `taskmanager-ecs-tasks-sg` | TCP 3000 | `taskmanager-alb-sg` |
| `taskmanager-rds-sg` | PostgreSQL 5432 | `taskmanager-ecs-tasks-sg` |

Référencer les SG entre eux (plutôt que des CIDR figés) reste valide même quand les IP changent (tasks Fargate recréées à chaque déploiement).

---

## 2.3 — RDS PostgreSQL

### DB Subnet Group

- Nom : `taskmanager-rds-subnet-group`
- Subnets : `taskmanager-private-1a`, `taskmanager-private-1b`

### Instance RDS

| Paramètre | Valeur |
|---|---|
| Engine | PostgreSQL |
| DB instance identifier | `taskmanager-db` |
| Master username | `postgres` |
| Credentials | **Managed via Secrets Manager** (case cochée à la création) |
| Instance class | `db.t3.micro` |
| Multi-AZ | Non |
| Public access | Non |
| VPC security group | `taskmanager-rds-sg` |
| Initial database name | `taskmanager` |

**Distinction DB instance identifier vs Initial database name :**
- *DB instance identifier* = nom du serveur RDS (devient l'endpoint DNS : `taskmanager-db.xxxx.<region>.rds.amazonaws.com`)
- *Initial database name* = nom de la base créée à l'intérieur de ce serveur (équivalent de `POSTGRES_DB` dans un `docker-compose`)

**Secret généré automatiquement** dans Secrets Manager (`rds!db-xxxxxxxx`), contenant `username`, `password`, `host`, `port`, `dbname` — référencé directement depuis la task definition ECS, jamais dupliqué en clair.

---

## 2.4 — ECS Cluster

- Nom : `taskmanager-cluster`
- Infrastructure : AWS Fargate (serverless)

**Erreur rencontrée :** `Request failed — A CloudFormation stack already exists for a failed cluster with the same name.`
**Cause racine (trouvée dans les Events du stack CloudFormation) :**
```
Unable to assume the service linked role. Please verify that the ECS service linked role exists.
```
Le **Service-Linked Role** `AWSServiceRoleForECS` n'était pas encore propagé au moment de la toute première tentative de création du cluster (rôle créé automatiquement en arrière-plan mais pas encore disponible).

**Correction :**
1. Supprimer le stack CloudFormation cassé (`Infra-ECS-Cluster-taskmanager-cluster-xxxxxxxx`) via la console CloudFormation, attendre `DELETE_COMPLETE`
2. Vérifier l'existence du rôle : `aws iam get-role --role-name AWSServiceRoleForECS` (tenter `aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com` — erreur "already taken" si déjà existant, confirmant qu'il ne manquait qu'un délai de propagation)
3. Attendre 2-3 minutes puis recréer le cluster normalement

---

## 2.5 — Task Definition

| Paramètre | Valeur |
|---|---|
| Family | `taskmanager-api` |
| Launch type | AWS Fargate |
| CPU / Memory (task-level) | 0.5 vCPU / 1 GB |
| Container name | `taskmanager-api` |
| Image URI | `<account-id>.dkr.ecr.<region>.amazonaws.com/taskmanager-api:<tag>` |
| Port mapping | 3000 / TCP |

### Task Role vs Task Execution Role — distinction clé

- **Task Execution Role** (`ecsTaskExecutionRole`) : utilisé par ECS lui-même pour préparer la task (pull image ECR, résoudre les secrets Secrets Manager, envoyer les logs CloudWatch) — invisible pour l'appli
- **Task Role** : utilisé par l'application elle-même pour appeler d'autres services AWS — non utilisé ici (l'API ne parle qu'à la RDS)

### Environment variables (non sensibles)
```
DB_HOST = taskmanager-db.xxxx.<region>.rds.amazonaws.com
DB_PORT = 5432
DB_NAME = taskmanager
DB_SSL  = true
```

### Secrets (Value type: ValueFrom)
```
DB_USER     → <secret-arn>:username::
DB_PASSWORD → <secret-arn>:password::
```
Format : `<secret-arn>:<json-key>:<version-stage>` — laisser le version-stage vide (`::`) pour utiliser `AWSCURRENT` automatiquement.

**Erreur rencontrée (piège UI) :** les champs "Resource allocation limits" au niveau conteneur (CPU/Memory hard/soft limit) avaient été remplis par erreur, en plus des valeurs déjà fixées au niveau task — source de confusion, pas d'erreur bloquante en soi. **Correction :** laisser ces champs vides quand la task n'a qu'un seul conteneur, les valeurs task-level suffisent.

**Permission manquante à ajouter sur `ecsTaskExecutionRole` :** la policy managée par défaut ne couvre pas Secrets Manager.
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:<region>:<account-id>:secret:rds!db-xxxxxxxx*"
    }
  ]
}
```

---

## 2.6 — ALB + Target Group

### Target Group
- Nom : `taskmanager-api-tg`
- Target type : **IP addresses** (obligatoire pour Fargate)
- Protocol/Port : HTTP / 3000
- Health check path : `/health`

### Application Load Balancer
- Nom : `taskmanager-alb`
- Scheme : Internet-facing
- Subnets : les 2 subnets **publics**
- Security group : `taskmanager-alb-sg`
- Listener : HTTP:80 → forward vers `taskmanager-api-tg`

---

## 2.7 — Service ECS

| Paramètre | Valeur |
|---|---|
| Cluster | `taskmanager-cluster` |
| Service name | `taskmanager-api-service` |
| Launch type | FARGATE |
| Desired tasks | 1 |
| Subnets | les 2 subnets **privés** |
| Security group | `taskmanager-ecs-tasks-sg` |
| Public IP | Turned off |
| Load balancer | ALB existant → target group existant `taskmanager-api-tg` |

**Erreur rencontrée :** migration DB en échec en boucle avec l'erreur :
```
no pg_hba.conf entry for host "10.0.x.x", user "postgres", database "taskmanager", no encryption
```
**Cause :** RDS PostgreSQL exige une connexion SSL/TLS par défaut (`rds.force_ssl`), l'application se connectait sans chiffrement.
**Correction (code applicatif, fichier `db.js`)** : rendre le SSL conditionnel via une variable d'environnement, pour ne pas casser l'environnement local (docker-compose sans SSL) :
```js
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
```
Ajout de `DB_SSL=true` dans la task definition (prod uniquement), rebuild + repush de l'image avec un nouveau tag, nouvelle révision de task definition, mise à jour du service (`Force new deployment`).

---

## 2.8 — Vérification end-to-end

Test de validation via l'endpoint public de l'ALB :
```bash
curl http://<dns-alb>.<region>.elb.amazonaws.com/health
# → {"status":"ok"}
```
Confirme la chaîne complète : Internet → ALB → ECS (Fargate, subnet privé) → RDS (subnet privé, SSL).

---

## Comment mettre en pause l'environnement (coûts)

| Ressource | Coût si laissée active | Action de pause |
|---|---|---|
| NAT Gateway | ~32$/mois + trafic | Supprimer (pas d'option pause native) + release l'Elastic IP associée |
| ALB | ~16-20$/mois | Supprimer (pas d'option pause native) |
| RDS | ~10-15$/mois (db.t3.micro) | **Stop** (pas supprimer) — `aws rds stop-db-instance`, valable 7 jours avant redémarrage auto forcé par AWS |
| Tasks ECS Fargate | à l'heure, selon vCPU/RAM | `aws ecs update-service --desired-count 0` |

**Gratuit, rien à faire :** VPC, subnets, route tables, IGW, Security Groups, rôles/policies IAM, cluster ECS vide, task definitions (métadonnées), images ECR (coût quasi nul), Secrets Manager (~0.40$/mois/secret).

### Pour reprendre après une pause

1. Recréer le NAT Gateway (nouvelle Elastic IP) + mettre à jour la route table privée
2. Recréer l'ALB (le target group existant, gratuit, peut être réutilisé)
3. `aws rds start-db-instance --db-instance-identifier taskmanager-db`
4. `aws ecs update-service --desired-count 1`

---

## Récapitulatif des erreurs rencontrées (liste courte)

1. Cluster ECS bloqué en `CREATE_FAILED` — Service-Linked Role `AWSServiceRoleForECS` pas encore propagé au moment de la création
2. Champs "Resource allocation limits" remplis par erreur au niveau conteneur, en doublon avec les valeurs task-level
3. Permission `secretsmanager:GetSecretValue` manquante sur le Task Execution Role
4. Connexion RDS refusée (`pg_hba.conf`, no encryption) — SSL requis par RDS, non configuré côté application

---

## 2.9 — CI/CD GitHub Actions vers ECS

### Choix d'architecture retenu : rebuild sur main (pas de promotion d'image)

Deux approches possibles pour déployer sur `main` :
- **Approche A (retenue)** : rebuild complet de l'image à chaque push/merge sur `main`, tag basé sur `${GITHUB_SHA::7}` du commit sur `main`
- **Approche B (écartée pour rester simple)** : réutiliser l'image déjà buildée et testée sur `dev` en la retaggant (pattern "build once, deploy everywhere"), sans rebuild — plus rigoureux mais plus complexe (le SHA du commit sur `dev` diffère de celui sur `main` en cas de merge commit, il faut retrouver le SHA source de la PR via `github.event.pull_request.head.sha`)

Amélioration future possible : passer à l'approche B pour garantir que l'image en prod est bit-pour-bit identique à celle validée en staging.

### Rôle IAM séparé pour le déploiement ECS

Principe de permissions minimales : un rôle dédié `github-actions-ecs-deploy`, distinct de `github-actions-ecr-push` (celui-ci ne fait que pousser des images, celui-là déploie sur ECS).

**Trust policy** (même OIDC provider déjà existant depuis l'étape 1, format avec IDs immuables) :
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:<votre-username>@<owner-id>/taskmanager-api@<repo-id>:*"
          ]
        }
      }
    }
  ]
}
```

**Erreur rencontrée (répétition du piège de l'étape 1) :** une trust policy éditée à la main est repartie sur l'ancien format (`repo:<votre-username>/taskmanager-api:*`), sans les IDs numériques. **Rappel :** ce format n'est correct que lorsqu'il est généré automatiquement par l'assistant console (champs GitHub organization/repository remplis), jamais en JSON collé à la main sans vérification.

**Permissions policy** `ecs-deploy-taskmanager-api` :
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:UpdateService", "ecs:DescribeServices"],
      "Resource": "arn:aws:ecs:<region>:<account-id>:service/taskmanager-cluster/taskmanager-api-service"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": ["arn:aws:iam::<account-id>:role/ecsTaskExecutionRole"]
    }
  ]
}
```

### Référence : correspondance action IAM ↔ besoin fonctionnel

Table de correspondance à réutiliser pour tout futur projet AWS :

| Besoin exprimé en langage naturel | Action IAM | Remarque |
|---|---|---|
| "Créer une nouvelle version de la task definition" | `ecs:RegisterTaskDefinition` | Non scopable à une ressource précise → `Resource: "*"` obligatoire |
| "Lire une task definition existante" | `ecs:DescribeTaskDefinition` | Idem, `Resource: "*"` |
| "Dire au service d'utiliser cette nouvelle version" | `ecs:UpdateService` | Scopable à l'ARN du service précis |
| "Vérifier l'état du service après déploiement" | `ecs:DescribeServices` | Scopable à l'ARN du service |
| "Confier un rôle IAM à une ressource que je crée/modifie" | `iam:PassRole` | Scopé au(x) rôle(s) précis référencés — jamais `Resource: "*"` |

**Règle générale sur `iam:PassRole`** : nécessaire uniquement quand l'action effectuée fait référence à un rôle IAM à l'intérieur de la ressource créée/modifiée (task definition avec `executionRoleArn`, instance EC2 avec Instance Profile, fonction Lambda avec rôle d'exécution, etc.). Un simple `docker push` vers ECR n'en a pas besoin — aucune notion de rôle IAM n'entre en jeu dans cette opération.

### Workflow — job `deploy-prod`

Ajouté au fichier `ci-cd.yml` existant, déclenché sur push/PR vers `main` :

```yaml
deploy-prod:
  name: Deploy to Production (ECS)
  runs-on: ubuntu-latest
  needs: build
  if: github.ref == 'refs/heads/main'
  environment:
    name: production

  steps:
    - name: Checkout
      uses: actions/checkout@v6

    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v4
      with:
        aws-region: ${{ vars.AWS_REGION }}
        role-to-assume: ${{ vars.AWS_ROLE_ARN_ECS }}

    - name: Generate short SHA
      id: vars
      run: echo "SHA_SHORT=${GITHUB_SHA::7}" >> $GITHUB_OUTPUT

    - name: Download current task definition
      run: |
        aws ecs describe-task-definition \
          --task-definition taskmanager-api \
          --query taskDefinition \
          --output json > task-def.json

    - name: Update image in task definition
      id: task-def
      uses: aws-actions/amazon-ecs-render-task-definition@v1
      with:
        task-definition: task-def.json
        container-name: taskmanager-api
        image: ${{ vars.AWS_ACCOUNT_ID }}.dkr.ecr.${{ vars.AWS_REGION }}.amazonaws.com/${{ vars.IMAGE_API_NAME }}:${{ steps.vars.outputs.SHA_SHORT }}

    - name: Deploy to ECS
      uses: aws-actions/amazon-ecs-deploy-task-definition@v2
      with:
        task-definition: ${{ steps.task-def.outputs.task-definition }}
        service: taskmanager-api-service
        cluster: taskmanager-cluster
        wait-for-service-stability: true
```

**Erreur rencontrée :** `Error: Cannot read properties of null (reading 'containerDefinitions')`
**Cause :** mauvais nom de champ dans la requête `--query taskDef` — le champ réel retourné par `describe-task-definition` s'appelle **`taskDefinition`**, pas `taskDef`. Le fichier JSON contenait donc `null`.
**Correction :** `--query taskDefinition` (déjà intégré dans le snippet ci-dessus).

**Pourquoi pas de SHA mismatch entre `dev` et `main` avec cette approche :** contrairement à l'approche B (promotion), l'approche A rebuild systématiquement à partir du commit exact présent sur `main` au moment du déclenchement — un seul SHA en jeu par run, jamais de comparaison entre le SHA de `dev` et celui de `main`.

### Variables GitHub à ajouter/renommer

| Variable | Valeur |
|---|---|
| `AWS_ROLE_ARN_ECR` (renommée depuis `AWS_ROLE_ARN`) | ARN de `github-actions-ecr-push` |
| `AWS_ROLE_ARN_ECS` (nouvelle) | ARN de `github-actions-ecs-deploy` |

---

## Test du rollback automatique (circuit breaker ECS)

### Configuration constatée (déjà active par défaut, sans action manuelle)

Console ECS → Service → Configuration and networking → **Deployment options** :

| Paramètre | Valeur |
|---|---|
| Deployment strategy | Rolling update |
| Min running tasks % | 100 |
| Max running tasks % | 200 |

Console ECS → Service → **Deployment failure detection** :

| Paramètre | Valeur |
|---|---|
| Use the Amazon ECS deployment circuit breaker | ✅ Activé |
| Rollback on failures | ✅ Activé |
| Reset on healthy task | ☐ Désactivé |
| Threshold type | Bounded percentage of desired count |
| Threshold value | 50% (arrondi au plancher de 3 échecs avec desired count = 1) |
| Health check grace period | 0 seconde (à surveiller — pas encore ajusté, risque avec un conteneur qui met du temps à démarrer) |

### Déroulé du test

1. Nouvelle révision de task definition (`:6`) créée manuellement via la console, avec `DB_HOST` volontairement invalide
2. Déploiement lancé → nouvelle task tente de démarrer, crash (`Exit Code: 1`, connexion DB impossible)
3. **Ancienne task jamais arrêtée** pendant toute la tentative (`Min running tasks: 100%` respecté) → **zéro interruption de service** constatée (`/health` répond en continu)
4. ECS retente le démarrage, échoue à nouveau — environ 1 à 2 minutes par cycle (temps de provisioning Fargate + boucle de retry interne de `migrate.js`, 5 tentatives × 3s)
5. Au bout de **3 échecs consécutifs** (`Failure threshold: 3`), le circuit breaker se déclenche : `Service deployment circuit breaker: Triggered`
6. **Rollback automatique** vers la dernière révision saine (`:5`), sans aucune intervention manuelle ni script

### Point de vigilance découvert suite au test

Le rollback automatique remet le **service** sur la bonne révision (`:5`), mais la **dernière révision enregistrée** de la task definition reste la version cassée (`:6`). Un prochain déploiement via le pipeline (`describe-task-definition` sans préciser de révision) récupérerait cette dernière révision cassée comme base, et ne changerait que l'image dessus — donc redéploierait une config cassée.

**Correction appliquée :** créer une nouvelle révision (`:7`) à partir de la dernière révision saine (`:5`), sans aucune autre modification — pour que "dernière révision" et "dernière révision saine" redeviennent la même chose avant tout nouveau déploiement.

### Conclusion du test

Le rollback ECS est **entièrement géré par l'infrastructure**, sans logique à écrire dans le pipeline — contrairement au rollback EC2/docker-compose qui nécessite un script custom (health check manuel, comparaison de tags, `docker compose` rollback). Le pipeline GitHub Actions n'a besoin d'aucun ajout pour bénéficier de ce mécanisme ; il échoue simplement (`wait-for-service-stability` en timeout) si un rollback se produit, ce qui reste le signal voulu.

Documentation du projet Task Manager : remplacement de l'URL brute de l'ALB par un sous-domaine custom en HTTPS, domaine géré chez Hostinger (hors AWS).

---

## Contexte et choix d'architecture

Domaine `votre-domaine.com` déjà enregistré et géré chez **Hostinger** (hors AWS). Deux options envisagées pour brancher AWS dessus :

- **Option A — Délégation de sous-domaine à Route 53** (`aws.votre-domaine.com` en NS chez Hostinger, géré ensuite entièrement dans Route 53) : **abandonnée**, l'éditeur DNS simplifié de Hostinger ne propose pas le type d'enregistrement **NS** (uniquement A, MX, AAAA, CNAME, SRV, TXT, CAA disponibles).
- **Option B — CNAME direct chez Hostinger** (retenue) : le sous-domaine pointe directement vers le DNS de l'ALB, sans passer par Route 53 pour la résolution. Validation ACM en DNS manuelle (pas d'automatisation "1-clic" possible sans Route 53 côté zone).

**Incident évité de justesse :** une première tentative de délégation a modifié par erreur les **nameservers globaux du domaine** (`votre-domaine.com` entier) au lieu d'ajouter un enregistrement NS scopé à un sous-domaine — en ajoutant les 4 nameservers Route 53 à côté des 2 nameservers Hostinger d'origine dans "Modifier les serveurs de noms". **Correction :** retrait immédiat des 4 nameservers Route 53 ajoutés, restauration des 2 nameservers Hostinger d'origine (`ns1.dns-parking.com`, `ns2.dns-parking.com`).

**Point de vigilance à retenir :** bien distinguer "Modifier les serveurs de noms" (nameservers globaux du domaine entier, à ne jamais toucher pour une délégation partielle) de "Gérer les enregistrements DNS" (enregistrements individuels, où doit se faire toute délégation ou tout CNAME).

---

## 1. Enregistrement CNAME chez Hostinger

Dans Gérer les enregistrements DNS :

| Champ | Valeur |
|---|---|
| Type | CNAME |
| Nom | `api-taskmanager` |
| Valeur | `<dns-alb>` |
| TTL | 300 |

**Note sur le wildcard existant :** un enregistrement `A *` préexistant pointait déjà tout sous-domaine non défini vers l'IP du site principal. Un enregistrement explicite (CNAME `api-taskmanager`) est plus spécifique et prend le dessus sur le wildcard pour ce nom précis, sans affecter le reste du domaine.

---

## 2. Certificat ACM

**Contrainte à respecter :** le certificat doit être demandé dans la **même région que l'ALB** (`<region>`), sinon il n'apparaît pas comme sélectionnable au moment de créer le listener HTTPS.

ACM → Request a certificate → Public certificate :
- Domain name : `api-taskmanager.votre-domaine.com`
- Validation method : **DNS validation**

**Différence par rapport à un domaine géré nativement par Route 53 :** pas de bouton "Create records in Route 53" automatique ici — ACM fournit un enregistrement CNAME de validation (`_xxxxx.api-taskmanager.votre-domaine.com` → `_yyyyy.acm-validations.aws`) à créer **manuellement** chez Hostinger, de la même façon que le CNAME principal. Validation effective quelques minutes après propagation.

---

## 3. Listener HTTPS sur l'ALB

EC2 → Load Balancers → `taskmanager-alb` → Listeners → Add listener :
- Protocol : HTTPS, Port : 443
- Default action : forward vers `taskmanager-api-tg`
- Certificate : celui créé à l'étape 2 (sélectionnable seulement une fois passé en statut `Issued`)

---

## Résultat validé

```bash
curl https://api-taskmanager.votre-domaine.com/health
# → {"status":"ok"}
```

Chaîne complète : Internet (HTTPS, certificat ACM) → ALB → ECS (Fargate) → RDS.

## Amélioration possible non traitée

Listener HTTP:80 toujours actif en parallèle sans redirection forcée vers HTTPS — à ajouter si on veut interdire le trafic non chiffré (`Redirect to HTTPS` comme default action sur le listener 80).
