#!/usr/bin/env bash
set -euo pipefail
container_id=$(docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17.6)
trap 'docker rm -f "$container_id" >/dev/null 2>&1 || true' EXIT
for attempt in $(seq 1 30); do
  if docker exec "$container_id" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 30 ]; then printf '%s\n' 'Postgres did not become ready.' >&2; exit 1; fi
  sleep 1
done
docker exec -i "$container_id" psql -X -q -v ON_ERROR_STOP=1 -U postgres -c 'create role metaglasses_api; create role metaglasses_migrator login;'
docker exec -i "$container_id" psql -X -q -v ON_ERROR_STOP=1 -U postgres < database/migrations/0001_initial.sql
docker exec -i "$container_id" psql -X -q -v ON_ERROR_STOP=1 -U postgres -c 'grant usage, create on schema app to metaglasses_migrator; grant select, update, references on table app.pairings to metaglasses_migrator;'
for migration in database/migrations/*.sql; do
  if [ "$migration" = database/migrations/0001_initial.sql ]; then continue; fi
  docker exec -i "$container_id" psql -X -q -v ON_ERROR_STOP=1 -U metaglasses_migrator -d postgres < "$migration"
done
docker exec -i "$container_id" psql -X -q -v ON_ERROR_STOP=1 -U postgres < database/tests/task_plan_library.sql
printf '%s\n' 'Task plan library database tests passed.'
