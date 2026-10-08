#!/usr/bin/env bash
# G-CORE Gruntech — safe rebuild and restart (Git Bash / MINGW64).
#
#   /c/G-CORE-GRUNTECH/deploy/rebuild.sh
#
# Restarts ONLY the GCoreGruntechApi scheduled task. It never kills node by
# image name, never touches PM2, and never touches the Cloudflared service —
# that host also runs gasion-vision (live hospital oxygen-plant monitoring) and
# an image-name kill has taken it down three times. See deploy/README.md.
#
# Note the `//` in schtasks arguments: MINGW would otherwise rewrite a single
# leading slash into a Windows path and the command would fail obscurely.
set -euo pipefail

# Where this installation actually is: derived from the script, not hard-coded,
# so it works wherever the repository was put.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
API_PORT=5100
TASK="GCoreGruntechApi"

step() { echo; echo "==> $1"; }

[ -d "$ROOT" ] || { echo "$ROOT does not exist. Is this the right machine?" >&2; exit 1; }

# The order below is deliberate: everything that can FAIL — the pull, the
# installs, the Prisma client, both builds — happens while the old API is still
# running. Only once the new code has built does the script touch the running
# site, so a commit that does not compile leaves the live site on the previous
# version and this script red, rather than leaving the site down.

# ── 1. Pull ──────────────────────────────────────────────────────────────────
# Non-interactive: GIT_ASK_YESNO=false answers "no" to "Unlink of file ...
# Should I try again?" (a file the running API holds; the pull still succeeds),
# and --ff-only refuses rather than opening an editor for a merge.
step "git pull"
cd "$ROOT"
if [ -d "$ROOT/.git" ]; then
  GIT_ASK_YESNO=false GIT_TERMINAL_PROMPT=0 git pull --ff-only origin master
else
  echo "    No git repository here — building what is on disk."
fi

# ── 2. Dependencies ──────────────────────────────────────────────────────────
# Quick when nothing changed, essential the moment a commit adds a dependency.
step "install api dependencies"
cd "$ROOT/api"
npm install --no-audit --no-fund

# ── 3. Prisma client, then the builds — with the old API still up ────────────
# The running API holds node_modules/.prisma/query_engine-windows.dll.node
# open, so generate's LAST step — swapping in the engine binary — fails with
# EPERM while it runs. The generated TypeScript client is written before that
# step, and that is what the build needs; the binary is swapped in step 6,
# once the API is stopped. The api build is the real gate on the client.
step "generate prisma client (types)"
rm -f node_modules/.prisma/client/*.tmp* 2>/dev/null || true
npx prisma generate \
  || echo "    NOTE: prisma generate could not swap the engine binary while the API runs — expected; done again after the stop."

step "build api"
npm run build

step "install web dependencies"
cd "$ROOT/web"
npm install --no-audit --no-fund

step "build web"
npm run build
# In production the API serves web/dist, so there is one origin, one port and
# one tunnel. Without it the app runs as an API with no front end, which looks
# like a broken deployment.
[ -f "$ROOT/web/dist/index.html" ] || { echo "web/dist/index.html was not produced. The web build failed." >&2; exit 1; }

# ── 4. Schema before the code that needs it ──────────────────────────────────
# After the builds, so a commit that does not compile changes nothing at all.
step "apply database schema"
cd "$ROOT/api"
if [ -d "$ROOT/api/prisma/migrations" ]; then
  npx prisma migrate deploy
else
  echo "    No migrations folder — using 'prisma db push'."
  npx prisma db push
fi

# ── 5. Stop OURS, and only ours ──────────────────────────────────────────────
step "stop ONLY $TASK"
schtasks //End //TN "$TASK" >/dev/null 2>&1 || true
sleep 3

# If something still holds the port, make sure it is ours before touching it.
# The predecessor script killed whatever was there; on a shared host that is
# how you take down somebody else's service while restarting your own.
holder=$(netstat -ano | grep -E "[:.]${API_PORT}\b" | grep -i listening | awk '{print $NF}' | head -1 || true)
if [ -n "${holder:-}" ]; then
  # node.exe reports the same executable path for every node process on this
  # box, so the command line is the only thing that identifies ours — which is
  # why start-api.cmd launches with an absolute script path.
  cmdline=$(powershell.exe -NoProfile -Command \
    "(Get-CimInstance Win32_Process -Filter \"ProcessId = $holder\" -ErrorAction SilentlyContinue).CommandLine" \
    2>/dev/null | tr -d '\r' || true)

  if printf '%s' "$cmdline" | grep -qiF 'G-CORE-GRUNTECH'; then
    echo "    Port $API_PORT still held by our own pid $holder — stopping that PID."
    taskkill //PID "$holder" //F >/dev/null 2>&1 || true
    sleep 2
  else
    cat >&2 <<EOF

Port $API_PORT is held by a process that is NOT ours:
    pid   $holder
    cmd   ${cmdline:-unknown}

Refusing to kill it. Find out what it is first. If G-Core should move to a
different port, change PORT in api/.env and the tunnel config to match.
EOF
    exit 1
  fi
fi

# ── 6. The engine binary, and the seed ───────────────────────────────────────
# The DLL sometimes stays locked even after the API stops (antivirus, the search
# indexer, a lingering handle). That last step only swaps in a byte-identical
# binary for the same Prisma version, so a refusal here is noted, not fatal.
step "regenerate prisma client (engine)"
rm -f node_modules/.prisma/client/*.tmp* 2>/dev/null || true
npx prisma generate \
  || echo "    NOTE: prisma generate hit EPERM on the engine binary — continuing; the api build above verified the client."

# Seeding is idempotent by design: permissions are refreshed from the registry,
# a role/permission pair is granted only if the seed has never offered it, and
# everything else is create-only — so an administrator's revocations and edits
# survive. Without this step a new screen's permission, workflow or setting
# never reaches the server.
step "seed (idempotent)"
npm run seed

# ── 7. Start and prove it answers ────────────────────────────────────────────
# Windows stops a task created by schtasks after 3 days, and on battery power.
# Lifted here, while the API is stopped, so the copy started below has neither.
TASKS_PS1=$(cygpath -w "$ROOT/deploy/tasks.ps1")
step "keep $TASK running for good"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TASKS_PS1" -Ensure api

step "start $TASK"
schtasks //Run //TN "$TASK" >/dev/null
sleep 8

step "health check"
healthy=0
for i in 1 2 3 4 5 6; do
  # The face-recognition models load at boot, so the first request can arrive
  # before the listener is up. Worth a few seconds' patience.
  if body=$(curl -fsS --max-time 10 "http://localhost:${API_PORT}/api/health" 2>/dev/null); then
    echo "    API health: $body"
    healthy=1
    break
  fi
  echo "    not up yet (attempt $i of 6)…"
  sleep 5
done

if [ "$healthy" -ne 1 ]; then
  echo >&2
  echo "HEALTH CHECK FAILED. The app did not answer on port $API_PORT." >&2
  echo "Look at: $ROOT/data/logs/api.log" >&2
  exit 1
fi

# ── 8. The tunnel, and the public address ────────────────────────────────────
# A rebuild never restarts the tunnel, so nothing else would notice it had
# stopped — Windows stopped it twice after 3 days (Error 1033). Lift the limit,
# start it if it is not running, and prove the public address answers.
# Only G-Core's own GCoreGruntechTunnel task; never the Cloudflared service.
step "tunnel and public address"
public_ok=1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TASKS_PS1" -Ensure tunnel || public_ok=0

# ── 9. Confirm we disturbed nothing ──────────────────────────────────────────
step "the neighbour (read-only)"
if command -v pm2 >/dev/null 2>&1; then
  pm2 list 2>/dev/null | head -15 || true
elif [ -f "$APPDATA/npm/pm2.cmd" ]; then
  "$APPDATA/npm/pm2.cmd" list 2>/dev/null | head -15 || true
fi

if [ "$public_ok" -ne 1 ]; then
  echo >&2
  echo "The new code is running on http://localhost:${API_PORT}, but the public address is NOT answering — see above." >&2
  exit 1
fi
echo
echo "G-CORE Gruntech is up on http://localhost:${API_PORT} — https://gruntech.gcore.tech"
echo
