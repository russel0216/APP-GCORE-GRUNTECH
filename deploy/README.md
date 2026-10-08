# Deploying G-CORE Gruntech

Target: `https://gruntech.gcore.tech` on the Windows server, behind a Cloudflare
tunnel. One Node process serves both the API and the web app, so there is one
origin, one port and one tunnel.

```
Internet → https://gruntech.gcore.tech → Cloudflare edge (HTTPS)
                                        │  outbound tunnel, no ports opened
                                   cloudflared  (its own process — NOT the
                                        │        existing Windows service)
                              Node API :5100  ──►  /api  AND  the web app
                                        │
                              Postgres :5435  (own container, own volume)
```

---

## Read this before you touch that machine

**That server also runs `gasion-vision` — live hospital oxygen-plant
monitoring.** It has been taken down three times by careless restarts. Every
rule below exists because of one of those.

| Never | Why |
|---|---|
| `taskkill /F /IM node.exe` | Kills the vision PM2 stack too. A `/FI "WINDOWTITLE eq ..."` filter does **not** make it safe — background processes have no window title, so the filter matches nothing and the `\|\|` fallback runs the unfiltered kill. This is exactly how it went down. |
| `Get-Process node \| Stop-Process` | Same thing in PowerShell. |
| Stop or reconfigure the **`Cloudflared` Windows service** | That service is gasiontech's tunnel. G-Core Gruntech gets its own tunnel process. |
| `pm2 kill` / `pm2 delete all` / `pm2 startup` | PM2 on that host belongs to the vision system. These scripts never call PM2 except to *read* its status. |
| Run the repo's root `docker-compose.yml` | It publishes **5433**, which is already `gasion_db`. Use `deploy/docker-compose.prod.yml`, which uses 5435 and its own volume. |

**What G-Core Gruntech owns, and nothing else:**

| | |
|---|---|
| Code | `C:\G-CORE-GRUNTECH` |
| API port | **5100** |
| Scheduled task | **`GCoreGruntechApi`** |
| Postgres container | **`gcore-gruntech-db`** on host port **5435** |
| Tunnel | **`gcore-gruntech`** → `gruntech.gcore.tech` |
| Backups | `C:\backups\gcore-gruntech`, task `GCoreGruntechBackup` |
| Uploads | `C:\G-CORE-GRUNTECH\data\uploads` |

Restart only by that scheduled task, or by the PID listening on 5100 **after
confirming it is ours** — which `rebuild.ps1` does for you.

---

## First time

Run the preflight first. It is read-only: it changes nothing and tells you what
is already using the ports and names this deployment wants.

```powershell
powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\preflight.ps1
```

Every script here works out where it is from its own location, so if the
repository is somewhere else - a laptop, a folder somebody renamed - point the
command at wherever `deploy` actually is and it will check *that* installation.
It prints which one at the top, so there is no doubt:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\<you>\Desktop\APP-GCORE GRUNTECH\deploy\preflight.ps1"
```

That also means you can dry-run the preflight on the development machine before
going anywhere near the server.

Fix anything it reports before going on.

### 1. Prerequisites

- **Node.js 20+** (24 preferred — the app is developed on 24)
- **Git**
- **Docker Desktop**, running
- **cloudflared** — `winget install --id Cloudflare.cloudflared`

### 2. Get the code

```powershell
git clone <your remote> C:\G-CORE-GRUNTECH
```

If there is no remote yet, copy the folder across and run `git init` on the
server so `rebuild` has something to pull from later — or edit `rebuild.ps1`
to skip the pull step.

### 3. Database

```powershell
cd C:\G-CORE-GRUNTECH\deploy
docker compose -f docker-compose.prod.yml up -d
```

This creates a container named `gcore-gruntech-db` on host port 5435 with its
own volume. It does not touch `gasion_db`.

Set the password **before** the first `up`, in `deploy\.env` (git ignores it):

```
GCORE_DB_PASSWORD=<a long random hex string>
```

The compose file reads it from there, so the password is never committed and
`git pull` never collides with it. Changing it after the first `up` means
recreating the volume.

### 4. Configuration

```powershell
Copy-Item C:\G-CORE-GRUNTECH\deploy\env.production.example C:\G-CORE-GRUNTECH\api\.env
notepad C:\G-CORE-GRUNTECH\api\.env
```

Fill in `DATABASE_URL` (matching the password you just set) and generate a real
`JWT_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The app refuses to start in production with the development secret. That is
deliberate.

### 5. Install

```powershell
powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\install.ps1
```

It installs dependencies, pushes the schema, seeds, builds both halves, and
registers the `GCoreGruntechApi` scheduled task. It refuses to run if the
preflight finds a conflict.

The seed prints the first sign-in. **Change that password immediately.**

### 6. Tunnel

```powershell
cloudflared tunnel login
cloudflared tunnel create gcore-gruntech
cloudflared tunnel route dns gcore-gruntech gruntech.gcore.tech
```

Copy `deploy\cloudflared-config.yml` to
`C:\Users\<you>\.cloudflared\gcore-gruntech.yml` and fill in the tunnel id and
your username. Then register it as **its own service**, under a name that is
not `Cloudflared`:

```powershell
schtasks /Create /F /TN GCoreGruntechTunnel /SC ONSTART /RU SYSTEM /RL HIGHEST `
  /TR "cmd /c cloudflared --config C:\Users\<you>\.cloudflared\gcore-gruntech.yml tunnel run"
powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\tasks.ps1 -Ensure tunnel
```

A scheduled task rather than `cloudflared service install`, because that
command would replace the existing `Cloudflared` service and take gasiontech
offline.

**`tasks.ps1` is not optional.** `schtasks /Create` cannot switch off Windows'
default "stop the task if it runs longer than 3 days", nor "stop on battery
power" (a UPS on USB counts). Without it the tunnel stops by itself three days
after it starts — which took the site down twice (Error 1033, 30 Sep and
4 Oct 2026). `tasks.ps1 -Ensure tunnel` lifts both limits, starts the task and
checks `APP_URL` answers from outside. `rebuild.ps1` runs it on every deploy,
and lifts the same limits from `GCoreGruntechApi`.

### 7. Backups

```powershell
schtasks /Create /F /TN GCoreGruntechBackup /SC DAILY /ST 02:30 /RU SYSTEM `
  /TR "powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\backup.ps1"
```

02:30, not 02:00 — `GCoreDbBackup` already runs at 02:00 and two `pg_dump`s
against the same Docker daemon at once is asking for a timeout.

---

## Every time after that

**Let the server deploy itself.** Once, on the server:

```powershell
powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\autodeploy.ps1 -Register
```

That creates G-Core's own `GCoreGruntechDeploy` task, which every five minutes
fetches `origin/master` and, when it has moved, runs `rebuild.ps1` and writes
what it printed to `data\logs\deploy.log` (the outcome in
`data\logs\deploy-last.txt`). From then on **a push to master is live within
about five minutes plus the build** — nothing to run on the server. It asks
for your Windows password once: the task runs as you, because the pull needs
your saved GitHub login. Register again if that password changes;
`-Unregister` removes the task.

```powershell
Get-Content C:\G-CORE-GRUNTECH\data\logs\deploy.log -Tail 40 -Wait   # watch a deploy
Get-Content C:\G-CORE-GRUNTECH\data\logs\deploy-last.txt             # OK or FAILED, which commit, when
```

A push that does not build leaves the site on the previous version and the log
red; a pull the server refuses (its checkout was changed by hand) is tried once
and then left until the next push. Fix, push again, or rebuild by hand.

**Or by hand**, which is the same script the task runs:

```powershell
powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\rebuild.ps1
```

```bash
/c/G-CORE-GRUNTECH/deploy/rebuild.sh     # Git Bash
```

Both do the same thing in the same order, and the order matters: everything
that can fail happens **while the old site is still running**, so a commit
that does not build never takes the site down.

1. **pull** — `--ff-only`, and it never asks a question (`GIT_ASK_YESNO=false`
   answers the "Unlink of file … try again?" prompt the running API used to
   cause)
2. **install** — quick when nothing changed, essential when a commit added a dependency
3. **generate and build** — the Prisma client's types, then the api and the
   web, with the old API still up. A failure here stops the script and
   changes nothing on the running site.
4. **migrate** — schema before the code that needs it
5. **stop ours** — frees the Prisma query-engine DLL, which the running process holds open
6. **engine and seed** — the engine binary the running API was holding (a
   byte-identical swap; a refusal is noted, not fatal), then the idempotent seed
7. **start and health-check** — lift the API task's 3-day limit, start it, and prove it answers
8. **tunnel** — lift the tunnel task's limit, start it if it stopped, and prove
   `https://gruntech.gcore.tech` answers. A rebuild that ends in red here has
   deployed the code; it is the public address that is down.

One rebuild at a time: `data\rebuild.lock` refuses a second one for up to two
hours, so the task and a person cannot pull and build the same folder at once.

If the rebuild stops with *"port 5100 is held by a process that is not ours"*,
it has done the right thing. Look at what it printed and deal with that process
by hand. Do not reach for a kill-by-name.

---

## Checking on it

```powershell
schtasks /Query /TN GCoreGruntechApi
Invoke-WebRequest http://localhost:5100/api/health -UseBasicParsing
Get-Content C:\G-CORE-GRUNTECH\data\logs\api.log -Tail 50
```

Read-only check that you have not disturbed the other system:

```powershell
pm2 list                                  # the vision stack — should be online
Get-Service Cloudflared                   # gasiontech's tunnel — should be Running
docker ps --filter name=gasion_db         # the other database — should be up
```

## The site shows Cloudflare "Error 1033"

The tunnel is not connected; the app may be perfectly well. In PowerShell as
Administrator on the server:

```powershell
Invoke-RestMethod http://localhost:5100/api/health
powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\tasks.ps1 -Ensure tunnel
```

The first proves the API is up (if not, run `rebuild.ps1`). The second lifts
the 3-day limit, starts G-Core's tunnel task if it stopped, and waits for the
public address to answer. If it still does not, look at our tunnel **with its
own config** — the server's default `config.yml` is G-CORE HR's tunnel, so a
plain `cloudflared tunnel info gcore-gruntech` reports on the wrong one:

```powershell
schtasks /Query /TN GCoreGruntechTunnel /V /FO LIST | findstr /i "Status Last Stop"
cloudflared tunnel --config C:\Users\Administrator\.cloudflared\gcore-gruntech.yml info gcore-gruntech
```

Last Result `267014` means Windows (or a person) ended the task. Never restart
the `Cloudflared` service to fix this — it is gasiontech's.

## Email for invitations and password resets

Off until it is set up, and G-CORE works without it: Admin › Users and the
G-HR employee form then show each invitation or reset link for you to send by
Messenger or Viber, and "Forgot password?" tells people to ask an
administrator.

To have them emailed, add the mailbox to `C:\G-CORE-GRUNTECH\api\.env` — the
commented block in `deploy\env.production.example` has the lines and the
settings for Google Workspace, Microsoft 365 and a web host's mailbox. Use an
app password, never the mailbox's own. Then restart with `rebuild.ps1` (it
restarts only G-Core's task), open Admin › Users, and press **Send me a test
email**: a wrong password or a blocked port shows up there, with the mail
server's reason, rather than on the first person you invite.

## Locked out of the admin account

```powershell
cd C:\G-CORE-GRUNTECH\api
npx tsx scripts\reset-password.ts admin@gruntech.com
```

Prints a generated password once. With no arguments it lists the accounts on
the database. It says loudly when the database is a production one, and writes
every reset to the audit log - "who changed the managing director's password,
and when" is exactly what an audit trail is for.

Needing shell access to run it is the design, not a gap.

## Rolling back

```powershell
cd C:\G-CORE-GRUNTECH
git log --oneline -10
git checkout <commit>
powershell -ExecutionPolicy Bypass -File deploy\rebuild.ps1
```

The schema does not roll back with the code. If the bad commit changed the
database, restore from the nightly dump first:

```powershell
docker cp C:\backups\gcore-gruntech\gcore_<stamp>.dump gcore-gruntech-db:/tmp/r.dump
docker exec gcore-gruntech-db pg_restore -U gcore -d gcore --clean --if-exists /tmp/r.dump
```

---

## Before you let anyone in

- [ ] Change the seeded admin password
- [ ] `cd api && npx tsx scripts/audit-workflows.ts` — assign the roles it names, or approvals go nowhere
- [ ] Company Settings: name, logo, address, TIN, VAT and EWT rates — these print on every document
- [ ] Remove the worked example (`GT-PRJ-2026-0006` and its chain) if you do not want it in the live data
- [ ] Confirm the nightly backup ran: `dir C:\backups\gcore-gruntech`
