#!/bin/sh
set -e

echo "Lancement des migrations..."
node migrate.js

echo "Démarrage du serveur..."
exec node index.js