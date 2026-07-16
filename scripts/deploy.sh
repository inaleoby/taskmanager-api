#!/bin/bash
set -e

# =============================================================
# deploy.sh — Déploiement avec rollback automatique
# Usage : bash deploy.sh <nouveau_tag>
# =============================================================

NOUVEAU_TAG=$1
CURRENT_TAG_FILE=".current_tag"
MAX_RETRIES=12        # 12 tentatives × 10s = 2 minutes max
RETRY_INTERVAL=10     # secondes entre chaque vérification

# Vérifier que le tag est passé en argument
if [ -z "$NOUVEAU_TAG" ]; then
  echo "❌ Usage : bash deploy.sh <tag>"
  exit 1
fi

# -------------------------------------------------------------
# 1. Lire l'ancien tag avant de toucher quoi que ce soit
# -------------------------------------------------------------
ANCIEN_TAG=$(cat $CURRENT_TAG_FILE 2>/dev/null || echo "none")

echo "📌 Ancien tag  : $ANCIEN_TAG"
echo "🚀 Nouveau tag : $NOUVEAU_TAG"

# -------------------------------------------------------------
# 2. Déployer la nouvelle image
# -------------------------------------------------------------
echo "Déploiement en cours..."
IMAGE_TAG=$NOUVEAU_TAG docker compose up -d --pull always --force-recreate api

# -------------------------------------------------------------
# 3. Attendre que le conteneur soit healthy
# -------------------------------------------------------------
echo "🔍 Attente du health check (max $((MAX_RETRIES * RETRY_INTERVAL))s)..."

STATUS=""

for i in $(seq 1 $MAX_RETRIES); do
  STATUS=$(docker inspect task-api --format='{{.State.Health.Status}}' 2>/dev/null || echo "not_found")
  echo "Tentative $i/$MAX_RETRIES — status: $STATUS"

  if [ "$STATUS" = "healthy" ]; then
    break
  fi

  if [ "$STATUS" = "unhealthy" ]; then
    # Échec immédiat — pas besoin d'attendre
    break
  fi

  # starting ou not_found → on attend
  sleep $RETRY_INTERVAL
done

# -------------------------------------------------------------
# 4. Résultat du health check
# -------------------------------------------------------------
if [ "$STATUS" = "healthy" ]; then
  # ✅ Succès — on sauvegarde le nouveau tag seulement maintenant
  echo $NOUVEAU_TAG > $CURRENT_TAG_FILE
  echo "✅ Déploiement réussi — tag actuel : $NOUVEAU_TAG"
  exit 0
fi

# ❌ Échec — unhealthy ou timeout
echo "❌ Health check échoué — status final : $STATUS"

if [ "$ANCIEN_TAG" != "none" ]; then
  echo "⏪ Rollback vers : $ANCIEN_TAG"
  IMAGE_TAG=$ANCIEN_TAG docker compose up -d --force-recreate api
  echo "✅ Rollback effectué — tag restauré : $ANCIEN_TAG"
else
  echo "⚠️ Premier déploiement — pas de rollback possible"
fi
docker image prune -f
# Faire échouer le pipeline pour alerter l'équipe
exit 1
