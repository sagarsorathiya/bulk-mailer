# 📧 Bulk Mailer

> **Internal bulk mail portal** — send bulk personalised emails with individually mapped file attachments using a simple Excel sheet and email template. No third-party SaaS. Runs entirely on-premises.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Database Setup](#4-database-setup)
5. [Redis Setup (Windows)](#5-redis-setup-windows)
6. [First-Run Sequence](#6-first-run-sequence)
7. [Running the Application](#7-running-the-application)
8. [Setting Up the Superadmin Password](#8-setting-up-the-superadmin-password)
9. [Active Directory (LDAP) Setup](#9-active-directory-ldap-setup)
10. [Allowed From-Address Configuration](#10-allowed-from-address-configuration)
11. [Production Deployment (PM2)](#11-production-deployment-pm2)
12. [How to Use the Portal](#12-how-to-use-the-portal)
13. [Excel File Format](#13-excel-file-format)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Prerequisites

Install the following before proceeding:

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 18 or higher | [nodejs.org](https://nodejs.org) |
| **PostgreSQL** | 13 or higher | [postgresql.org](https://www.postgresql.org) |
| **Redis** | 6 or higher | Windows install via `winget` (see §5) |
| **Git** | Any | To clone the repository |

> **SMTP relay** — The portal sends mail through your existing internal SMTP relay (e.g. Exchange gateway). No external mail service is needed. The relay must be reachable from the server machine on port 25.

---

## 2. Installation

```powershell
# Clone the repository
git clone https://github.com/<your-username>/bulk-mailer.git bulk-mailer
cd bulk-mailer

# Install Node dependencies
npm install
```

---

## 3. Configuration

Copy the example environment file and edit it with your real values:

```powershell
copy .env.example .env
notepad .env
```

### Full `.env` reference

```env
# ── Server ──────────────────────────────────────────────────────
PORT=3000
NODE_ENV=development        # change to 'production' on the live server

# ── SMTP Relay ──────────────────────────────────────────────────
# Your internal mail relay — no authentication required on LAN
SMTP_HOST=smtp.example.com       # host of your SMTP relay / Exchange gateway
SMTP_PORT=25
SMTP_SECURE=false           # true only if relay requires TLS on port 465

# ── PostgreSQL ──────────────────────────────────────────────────
DB_HOST=localhost
DB_PORT=5432
DB_NAME=bulkmailer
DB_USER=bulkmailer
DB_PASS=changeme            # use a strong password in production

# ── Redis ───────────────────────────────────────────────────────
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# ── LDAP / Active Directory ─────────────────────────────────────
LDAP_URL=ldap://dc.example.com               # host of your Domain Controller
LDAP_BASE_DN=DC=example,DC=com              # your AD domain
LDAP_BIND_DN=CN=svc-bulkmailer,OU=Service Accounts,DC=example,DC=com
LDAP_BIND_PASS=<service-account-password>
LDAP_REQUIRED_GROUP=BulkMailer-Users    # AD group (CN) users must belong to

# ── File Storage ────────────────────────────────────────────────
UPLOAD_DIR=./uploads                    # where ZIPs are extracted (local path)
ATTACHMENT_BASE_PATH=\\SERVER\shared\attachments   # base for network paths

# ── Rate Limiting ───────────────────────────────────────────────
SEND_DELAY_MS=2000          # milliseconds to wait between each email sent
MAX_BATCH_SIZE=500          # max recipients per job

# ── Session ─────────────────────────────────────────────────────
SESSION_SECRET=change-this-to-a-long-random-string

# ── Local Superadmin (bypasses LDAP, always works) ──────────────
LOCAL_ADMIN_USER=admin
LOCAL_ADMIN_PASS_HASH=      # generate with: npm run hash-password <password>
LOCAL_ADMIN_DISPLAY_NAME=Super Admin
LOCAL_ADMIN_DEPARTMENT=Admin
```

---

## 4. Database Setup

### 4.1 Create the database and user

Open **pgAdmin** or **psql** and run:

```sql
CREATE DATABASE bulkmailer;
CREATE USER bulkmailer WITH PASSWORD 'changeme';
GRANT ALL PRIVILEGES ON DATABASE bulkmailer TO bulkmailer;
```

> Replace `changeme` with the same password you put in `.env` → `DB_PASS`.

### 4.2 Run migrations

```powershell
npm run migrate
```

This creates three tables: `users`, `jobs`, `send_logs` and their indexes. Run this **once** on first setup. It is safe to re-run — existing tables are not dropped.

---

## 5. Redis Setup (Windows)

### 5.1 Install Redis (one-time)

```powershell
winget install Redis.Redis
```

### 5.2 Start Redis before each session

```powershell
npm run redis:start

# Verify it's running:
npm run redis:ping
# Expected output: PONG
```

### 5.3 Auto-start Redis on Windows boot (recommended for servers)

Run **PowerShell as Administrator** once:

```powershell
net start Redis
```

Then open `services.msc`, find **Redis**, and set **Startup type → Automatic**.

After that, Redis starts automatically on every reboot and you don't need `npm run redis:start` again.

---

## 6. First-Run Sequence

Do this in order the very first time:

```powershell
# 1. Copy and edit environment file
copy .env.example .env
#    → Edit SMTP_HOST, DB_PASS, LDAP_URL, SESSION_SECRET, etc.

# 2. Install packages
npm install

# 3. Set the superadmin password
npm run hash-password <your-password>
#    → Copy the printed hash into .env → LOCAL_ADMIN_PASS_HASH

# 4. Start Redis
npm run redis:start
npm run redis:ping   # must print PONG

# 5. Run database migrations
npm run migrate

# 6. Start the portal
npm run dev:all
#    → Open http://localhost:3000
#    → Login with: admin / <your-password>
```

---

## 7. Running the Application

### Development (recommended for testing)

```powershell
npm run dev:all
```

Starts both the web server (with auto-restart on file changes) and the background mail worker in a single terminal window.

### Production (stable, no auto-restart)

```powershell
npm run start:all
```

### Run components separately (advanced)

```powershell
# Terminal 1 — Web server
npm run dev

# Terminal 2 — Background mail worker
npm run worker
```

### Available commands

| Command | Description |
|---|---|
| `npm run dev:all` | **Primary** — server + worker, nodemon auto-restart |
| `npm run start:all` | Production — server + worker, no nodemon |
| `npm run migrate` | Run database migrations |
| `npm run worker` | Background worker only |
| `npm run hash-password <pw>` | Generate bcrypt hash for superadmin password |
| `npm run redis:start` | Start Redis (Windows) |
| `npm run redis:ping` | Check Redis is alive |

---

## 8. Setting Up the Superadmin Password

The local superadmin account bypasses Active Directory and always works — even if LDAP is unreachable.

**Step 1 — Generate the hash:**

```powershell
npm run hash-password YourNewPassword123
```

Output example:
```
Hash: $2b$12$abc123...xyz
```

**Step 2 — Paste into `.env`:**

```env
LOCAL_ADMIN_USER=admin
LOCAL_ADMIN_PASS_HASH=$2b$12$abc123...xyz
LOCAL_ADMIN_DISPLAY_NAME=Super Admin
LOCAL_ADMIN_DEPARTMENT=Admin
```

**Step 3 — Restart the server** (if already running) so it picks up the new hash.

> ⚠️ Never put a plain-text password in `LOCAL_ADMIN_PASS_HASH` — it must be the bcrypt hash output from `npm run hash-password`.

---

## 9. Active Directory (LDAP) Setup

### What is required in AD

1. **A service account** (e.g. `svc-bulkmailer`) with read permission to query the directory.
2. **A security group** named `BulkMailer-Users` (or set `LDAP_REQUIRED_GROUP`). Add all users who should have access to this group.

### `.env` LDAP settings

```env
LDAP_URL=ldap://dc.example.com           # Domain Controller IP
LDAP_BASE_DN=DC=example,DC=com
LDAP_BIND_DN=CN=svc-bulkmailer,OU=Service Accounts,DC=example,DC=com
LDAP_BIND_PASS=<service-account-password>
LDAP_REQUIRED_GROUP=BulkMailer-Users     # optional; this is the default
```

### How login works

1. The portal first checks the local superadmin credentials (bcrypt compare).
2. If not superadmin, it binds to LDAP using the service account, then verifies the user's password with a second bind.
3. It checks if the user is a member of `BulkMailer-Users`.
4. On success, `{ username, displayName, department }` is stored in the session.

> If your LDAP is not available during development, the superadmin account still works normally.

---

## 10. Allowed From-Address Configuration

Each department is restricted to a list of permitted "From" email addresses to prevent spoofing. Edit `config/allowedSenders.js`:

```js
module.exports = {
  HR:      ['hr@example.com'],
  Finance: ['finance@example.com', 'accounts@example.com'],
  Admin:   ['admin@example.com'],
  IT:      ['it@example.com'],
}
```

- Users can only send from their own department's addresses.
- The `Admin` department (superadmin) can send from **any** address.
- Add new departments and addresses here as needed — no database change required.

---

## 11. Production Deployment (PM2)

PM2 keeps the server and worker running as background services that restart on crash and auto-start on reboot.

### Install PM2 globally

```powershell
npm install -g pm2
```

### Start with PM2

```powershell
# Set NODE_ENV=production in .env first
pm2 start pm2.config.js
pm2 save                  # persist across reboots
pm2 startup               # follow the printed instructions
```

### Useful PM2 commands

```powershell
pm2 status                # view running processes
pm2 logs                  # tail combined logs
pm2 logs bulk-mailer-server       # server logs only
pm2 logs bulk-mailer-worker       # worker logs only
pm2 restart all           # restart after .env changes
pm2 stop all              # stop everything
```

---

## 12. How to Use the Portal

### Step 1 — Compose (Tab 1)

- Enter the **From address** (pre-filled for your department).
- Type the **Subject** — use `{{ColumnName}}` placeholders, e.g. `Form 16 for FY 2024-25 — {{Name}}`.
- Type the **Email Body** in the rich-text editor (bold, bullet lists, etc. supported).
  - Click column name chips to insert `{{ColumnName}}` at the cursor.
- Select attachment mode: **ZIP** (upload a ZIP of PDFs) or **Network** (UNC/absolute paths in Excel).

### Step 2 — Data (Tab 2)

- Download the **sample Excel** to see the expected format.
- Upload your **Excel file** (`.xlsx` or `.csv`).
- Review the validation summary and column chip list.
- If ZIP mode: upload your **ZIP file** containing all PDF attachments.

### Step 3 — Send (Tab 3)

- Check the summary (recipient count, from address, attachment mode).
- Click **Preview 3 Mails** to verify the merged output before sending.
- Click **Send Now** and confirm → emails are dispatched with a configurable delay between each.
- Watch the live progress bar and per-recipient log table.

---

## 13. Excel File Format

| Email | Name | AttachmentPath | Department | EmployeeID | (any other columns) |
|---|---|---|---|---|---|
| alice@example.com | Alice Example | Form-16\789.pdf | HR | EMP001 | ... |
| bob@example.com | Bob Example | Form-16\790.pdf | Finance | EMP002 | ... |

### Rules

| Column | Required? | Notes |
|---|---|---|
| `Email` | ✅ Yes | Must be a valid email address |
| `AttachmentPath` | ✅ Yes | Filename (ZIP mode) or full/relative path (network mode) |
| `Name` | ❌ Optional | Becomes `{{Name}}` placeholder |
| `EmployeeID` | ❌ Optional | Any extra column becomes a placeholder |
| `Department` | ❌ Optional | Any extra column becomes a placeholder |

- **Only `Email` and `AttachmentPath` are mandatory.** All other columns are optional and flexible.
- Column headers become `{{placeholders}}` automatically — no configuration needed.
- Blank rows are skipped automatically.
- Both `\` and `/` path separators are accepted in `AttachmentPath`.

### ZIP attachment path examples

| ZIP structure | Put in `AttachmentPath` column |
|---|---|
| Files directly in ZIP root | `789.pdf` |
| ZIP has a `Form-16/` subfolder | `Form-16\789.pdf` |
| Nested subfolders | `FY2024\HR\789.pdf` |

---

## 14. Troubleshooting

### Server won't start

| Symptom | Fix |
|---|---|
| `Error: connect ECONNREFUSED 127.0.0.1:5432` | PostgreSQL is not running — start it via Services |
| `Error: connect ECONNREFUSED 127.0.0.1:6379` | Redis is not running — run `npm run redis:start` |
| `SESSION_SECRET` warning | Set a real value in `.env`, not the placeholder |
| Port 3000 already in use | Change `PORT=3001` in `.env` or kill the process using port 3000 |

### Login issues

| Symptom | Fix |
|---|---|
| Superadmin login fails | Ensure `LOCAL_ADMIN_PASS_HASH` in `.env` is the **bcrypt hash**, not a plain password |
| AD login fails — "not a member" | Add the user to `BulkMailer-Users` AD group |
| AD login fails — timeout | Check `LDAP_URL` IP is reachable; superadmin still works offline |

### Email sending issues

| Symptom | Fix |
|---|---|
| `SMTP connect timeout` | SMTP relay IP unreachable — check `SMTP_HOST` and that you're on the LAN / VPN |
| `Attachment not found: Form-16\789.pdf` | ZIP extracted but path not matching — check that the folder structure in the ZIP matches what's in the Excel column |
| Emails arrive with double spacing | This is the Quill `<p>` margin bug — already fixed in `mailSender.js` `normaliseHtml()`. Ensure you're running the latest code. |

### Redis issues

| Symptom | Fix |
|---|---|
| `PONG` not received | Redis not started — run `npm run redis:start` |
| Jobs stuck in "pending" | Worker not running — ensure you started with `npm run dev:all`, not just `npm run dev` |

---

## Project structure (reference)

```
bulk-mailer/
├── .env                       ← your configuration (gitignored)
├── .env.example               ← template — copy to .env
├── server.js                  ← Express entry point
├── pm2.config.js              ← production PM2 config
├── config/
│   ├── allowedSenders.js      ← per-dept from-address allowlist
│   ├── db.js                  ← PostgreSQL pool
│   ├── ldap.js                ← LDAP auth helper
│   ├── mailer.js              ← Nodemailer transporter
│   └── redis.js               ← Redis client
├── middleware/
│   ├── auth.js                ← Session auth middleware
│   └── upload.js              ← Multer config
├── routes/
│   ├── auth.js                ← Login / logout / me
│   ├── jobs.js                ← Job CRUD + sample Excel download
│   ├── preview.js             ← Mail preview
│   └── logs.js                ← Send log viewer + CSV export
├── services/
│   ├── attachmentResolver.js  ← ZIP + network path resolution
│   ├── excelParser.js         ← Parse Excel, validate columns
│   ├── jobProcessor.js        ← Bull worker — sends emails
│   ├── mailSender.js          ← Single email send via nodemailer
│   └── templateEngine.js      ← {{placeholder}} merge engine
├── db/
│   ├── migrate.js             ← Migration runner
│   └── migrations/
│       └── 001_init.sql       ← Schema
├── scripts/
│   └── hash-password.js       ← bcrypt hash generator
└── public/
    ├── index.html             ← Login page
    ├── app.html               ← 3-tab portal UI (Compose / Data / Send)
    ├── logs.html              ← Send log viewer
    └── assets/
        ├── app.js             ← Frontend JS
        └── style.css          ← design system
```

---

For a production deployment walkthrough see [DEPLOYMENT.md](./DEPLOYMENT.md).

## License

MIT — see [LICENSE](./LICENSE).
