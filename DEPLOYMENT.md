# Bulk Mailer — Windows Server Production Deployment Guide

> This guide covers deploying Bulk Mailer on a **Windows Server 2019/2022** machine.
> The application runs as two PM2-managed Node.js processes behind IIS acting as a reverse proxy.

---

## Prerequisites

| Requirement | Version | Install method |
|---|---|---|
| **Node.js** | 18 LTS | [nodejs.org](https://nodejs.org) — download Windows Installer |
| **PM2** | latest | `npm install -g pm2` |
| **PostgreSQL** | 13+ | [postgresql.org](https://www.postgresql.org/download/windows/) |
| **Redis for Windows** | 6+ | `winget install Redis.Redis` |
| **IIS** | bundled | Server Manager → Add Roles → Web Server (IIS) |
| **URL Rewrite Module** | 2.1 | [IIS URL Rewrite](https://www.iis.net/downloads/microsoft/url-rewrite) |
| **ARR (Application Request Routing)** | 3.0 | [Microsoft ARR](https://www.iis.net/downloads/microsoft/application-request-routing) |

---

## 1. Install Node.js 18 LTS

1. Download the Windows Installer (`.msi`) from [nodejs.org/en/download](https://nodejs.org/en/download/).
2. Run the installer as Administrator. Tick **"Add to PATH"**.
3. Verify:

```powershell
node --version   # should print v18.x.x
npm --version
```

---

## 2. Install PM2 Globally

```powershell
npm install -g pm2
pm2 --version
```

### Register PM2 as a Windows startup service

Run once in an **Administrator** PowerShell:

```powershell
# Install pm2-windows-startup helper
npm install -g pm2-windows-startup
pm2-startup install

# After the app is running (step 6), save the process list so it restores on reboot:
pm2 save
```

---

## 3. Install and Configure PostgreSQL

1. Download and run the PostgreSQL installer from [postgresql.org](https://www.postgresql.org/download/windows/).
2. During setup, set a superuser (`postgres`) password — note it down.
3. Open **pgAdmin** or **psql** and run:

```sql
CREATE DATABASE bulkmailer;
CREATE USER bulkmailer WITH PASSWORD 'your-strong-password';
GRANT ALL PRIVILEGES ON DATABASE bulkmailer TO bulkmailer;
```

4. Ensure PostgreSQL service starts automatically:
   - `services.msc` → PostgreSQL → Startup type: **Automatic**

---

## 4. Install and Configure Redis

```powershell
winget install Redis.Redis
```

Set Redis to auto-start:

```powershell
# In an Administrator PowerShell:
net start Redis
# Then in services.msc: Redis → Startup type: Automatic
```

Verify:

```powershell
redis-cli ping   # should print: PONG
```

---

## 5. Deploy Application Files

```powershell
# Clone or copy the application to the server
# Choose an install directory (referred to below as <APP_DIR>)

cd <APP_DIR>

# Install production dependencies
npm install --omit=dev

# Copy and edit the environment file
Copy-Item .env.example .env
notepad .env
```

**Key `.env` values to set for production:**

```env
NODE_ENV=production
PORT=3000
SESSION_SECRET=<generate a 64-char random string>
DB_PASS=<your PostgreSQL password>
SMTP_HOST=<your SMTP relay host>
LOCAL_ADMIN_PASS_HASH=<run: node scripts/hash-password.js YourPassword>
```

---

## 6. Run Database Migrations

```powershell
cd <APP_DIR>
npm run migrate
```

Expected output:

```
[migrate] Running migration: 001_init.sql
[migrate] ✅ All migrations applied.
```

---

## 7. Start the Application with PM2

```powershell
cd <APP_DIR>

# Start both the web server and the worker
pm2 start pm2.config.js --env production

# Check status
pm2 status

# View logs
pm2 logs

# Save process list (so it restores after reboot)
pm2 save
```

**Expected PM2 status:**

```
┌──────────────────────────┬───┬─────────┬──────┬────────┐
│ App name                 │ id│ status  │ cpu  │ memory │
├──────────────────────────┼───┼─────────┼──────┼────────┤
│ bulk-mailer          │ 0 │ online  │ 0%   │ 60mb   │
│ bulk-mailer-worker   │ 1 │ online  │ 0%   │ 40mb   │
└──────────────────────────┴───┴─────────┴──────┴────────┘
```

Verify the server is running:

```powershell
Invoke-WebRequest http://localhost:3000/health | Select-Object -ExpandProperty Content
# Expected: {"status":"ok","timestamp":"..."}
```

---

## 8. Configure IIS as a Reverse Proxy

### 8a. Install required IIS modules

Download and install (in this order):
1. [URL Rewrite 2.1](https://www.iis.net/downloads/microsoft/url-rewrite)
2. [Application Request Routing 3.0](https://www.iis.net/downloads/microsoft/application-request-routing)

Enable ARR proxy in IIS Manager:
- Server node → **Application Request Routing Cache** → **Server Proxy Settings** → tick **Enable proxy** → Apply.

### 8b. Create IIS Site

1. In IIS Manager, right-click **Sites** → **Add Website**
2. Site name: `Bulk Mailer`
3. Physical path: `<APP_DIR>\public` (or any temp folder — it won't serve files directly)
4. Binding: HTTP port 80 (or HTTPS 443 with a certificate)
5. Click OK.

### 8c. Add web.config for reverse proxy

Create `<APP_DIR>\public\web.config` (or place at IIS site root):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="Bulk Mailer Proxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://localhost:3000/{R:1}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <!-- Allow large file uploads (ZIP/Excel) up to 600 MB -->
        <requestLimits maxAllowedContentLength="629145600" />
      </requestFiltering>
    </security>
  </system.webServer>
</configuration>
```

### 8d. Add HTTPS binding (recommended)

1. Obtain an SSL certificate (internal CA or Let's Encrypt via win-acme).
2. In IIS Manager, site Bindings → Add → HTTPS, port 443, select certificate.
3. Add HTTP → HTTPS redirect rule in `web.config` if desired.

---

## 9. Configure Windows Firewall

Allow inbound traffic on the IIS port:

```powershell
# Allow HTTP (if using port 80)
New-NetFirewallRule -DisplayName "Bulk Mailer HTTP" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow

# Allow HTTPS (if using port 443)
New-NetFirewallRule -DisplayName "Bulk Mailer HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow

# Node.js port 3000 should NOT be exposed externally — IIS proxies it
```

---

## 10. First-Run Checklist

After deployment, verify each item:

- [ ] `pm2 status` shows both processes `online`
- [ ] `http://localhost:3000/health` returns `{"status":"ok"}`
- [ ] Login page loads at `http://<server-hostname>/`
- [ ] Login with local superadmin (`admin` + your set password) succeeds
- [ ] Dashboard page shows 0 jobs / 0 sent (correct for fresh install)
- [ ] Upload a 3-row test Excel → job created
- [ ] Verify SMTP relay is reachable (check server logs for SMTP verify line)
- [ ] Send the test job → check received emails
- [ ] `pm2 logs` shows no errors

---

## 11. How to Update (Zero-Downtime)

```powershell
cd <APP_DIR>

# Pull new code (or copy new files)
git pull origin main

# Install any new dependencies
npm install --omit=dev

# Run any new migrations
npm run migrate

# Reload PM2 processes (zero-downtime rolling restart)
pm2 reload pm2.config.js --env production

# Verify
pm2 status
```

---

## 12. Log Locations

| Log | Path |
|---|---|
| Server stdout | `<APP_DIR>\logs\server-out.log` |
| Server errors | `<APP_DIR>\logs\server-error.log` |
| Worker stdout | `<APP_DIR>\logs\worker-out.log` |
| Worker errors | `<APP_DIR>\logs\worker-error.log` |
| IIS access log | `<IIS log directory>` |

View live logs:

```powershell
pm2 logs                        # all logs
pm2 logs bulk-mailer        # server only
pm2 logs bulk-mailer-worker # worker only
```

---

## 13. Troubleshooting

### Port 3000 already in use

The server auto-detects a free port. Check the startup log:

```powershell
pm2 logs bulk-mailer --lines 20
# Look for: "Bulk Mailer is running" and the actual port used
```

### Redis connection refused

```powershell
redis-cli ping
# If "Could not connect": start Redis
net start Redis
```

### PostgreSQL authentication failed

Check `DB_PASS` in `.env` matches the password set during PostgreSQL setup.
Also verify the `bulkmailer` user has access:

```powershell
psql -U bulkmailer -d bulkmailer -h localhost -c "SELECT 1"
```

### LDAP login not working but local admin works

1. Verify `LDAP_URL` is reachable from the server: `Test-NetConnection -ComputerName dc.example.com -Port 389`
2. Confirm the user is in `BulkMailer-Users` AD group.
3. Check `pm2 logs` for LDAP bind errors.

### Session lost after server restart

Set `SESSION_STORE=postgres` in `.env` to use PostgreSQL-backed sessions that survive restarts.
The `connect-pg-simple` package is already included in `package.json`.
