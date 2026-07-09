#!/bin/sh
# When pointed at DynamoDB (local sidecar or otherwise), make sure the table
# exists before the server starts. create-table.ts is idempotent (it swallows
# ResourceInUseException), so re-running it on every boot is safe.
set -e

if [ "$STORE" = "dynamo" ] && [ -n "$DYNAMO_ENDPOINT" ]; then
  echo "waiting for DynamoDB at $DYNAMO_ENDPOINT..."
  i=0
  until node -e "fetch(process.env.DYNAMO_ENDPOINT).then(() => process.exit(0)).catch(() => process.exit(1))"; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      echo "DynamoDB still unreachable after 30s, continuing anyway"
      break
    fi
    sleep 1
  done
  npm run create-table
fi

exec npm run start
