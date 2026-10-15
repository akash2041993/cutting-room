#!/bin/sh
# Starts a throwaway Postgres, loads a Supabase stand-in plus supabase/schema.sql, runs the rule tests.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PGBIN=/usr/lib/postgresql/16/bin
pkill -u postgres postgres 2>/dev/null || true
sleep 1
rm -rf /tmp/pg && mkdir -p /tmp/pg && chown postgres /tmp/pg
chmod -R a+rX "$ROOT" || true
su postgres -s /bin/bash -c "$PGBIN/initdb -D /tmp/pg/data -A trust -E UTF8 >/dev/null"
su postgres -s /bin/bash -c "$PGBIN/pg_ctl -D /tmp/pg/data -o '-p 54329 -k /tmp/pg -c listen_addresses=' -l /tmp/pg/log -w start >/dev/null"
P="psql -h /tmp/pg -p 54329 -U postgres -X -q -v ON_ERROR_STOP=1 -d postgres"
$P -f "$HERE/stub.sql"
$P -f "$ROOT/supabase/schema.sql" >/dev/null
echo "schema loaded; running it a second time to prove it is re-runnable"
$P -f "$ROOT/supabase/schema.sql" >/dev/null
python3 "$HERE/rls_test.py"
RC=$?
su postgres -s /bin/bash -c "$PGBIN/pg_ctl -D /tmp/pg/data -m fast stop >/dev/null" || true
exit $RC
