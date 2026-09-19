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
                              Postgres :5434  (own container, own volume)
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
| Run the repo's root `docker-compose.yml` | It publishes **5433**, which is already `gasion_db`. Use `deploy/docker-compose.prod.yml`, which uses 5434 and its own volume. |

**What G-Core Gruntech owns, and nothing else:**

| | |
|---|---|
| Code | `C:\G-CORE-GRUNTECH` |
| API port | **5100** |
| Scheduled task | **`GCoreGruntechApi`** |
| Postgres container | **`gcore-gruntech-db`** on host port **5434** |
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

This creates a container named `gcore-gruntech-db` on host port 5434 with its
own volume. It does not touch `gasion_db`.

Set a real password in `docker-compose.prod.yml` **before** the first `up` —
changing it afterwards means recreating the volume.

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
schtasks /Run /TN GCoreGruntechTunnel
```

A scheduled task rather than `cloudflared service install`, because that
command would replace the existing `Cloudflared` service and take gasiontech
offline.

### 7. Backups

```powershell
schtasks /Create /F /TN GCoreGruntechBackup /SC DAILY /ST 02:30 /RU SYSTEM `
  /TR "powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\backup.ps1"
```

02:30, not 02:00 — `GCoreDbBackup` already runs at 02:00 and two `pg_dump`s
against the same Docker daemon at once is asking for a timeout.

---

## Every time after that

```powershell
powershell -ExecutionPolicy Bypass -File C:\G-CORE-GRUNTECH\deploy\rebuild.ps1
```

```bash
/c/G-CORE-GRUNTECH/deploy/rebuild.sh     # Git Bash
```

Both do the same thing in the same order, and the order matters:

1. **pull** — new code and any new migrations
2. **install** — quick when nothing changed, essential when a commit added a dependency
3. **migrate** — schema before the code that needs it
4. **stop ours** — frees the Prisma query-engine DLL, which the running process holds open. Skipping this is what causes `EPERM: operation not permitted, rename query_engine-windows.dll.node`
5. **generate** — the typed client, or `tsc` fails
6. **build** — api, then web
7. **start and health-check** — and prove it answers

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
