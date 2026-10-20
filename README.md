# Workyuk

Workyuk is a private Indonesian client portal for creative agencies. Agency and client pages use separate route prefixes, while the Express API enforces role and project ownership on every protected resource.

## Requirements

- Node.js 20 or newer and npm
- macOS, Linux, or Windows with build tools available if `sqlite3` needs to compile its native module

## Local setup

```sh
npm install
cp .env.example .env
```

Set a unique secret in `.env` before deploying, for example with `openssl rand -hex 32`. The example file contains no usable credential. Default local configuration uses `http://localhost:5173`, an SQLite file at `server/data/workyuk.sqlite`, and private uploads under `server/uploads/`.

Create the schema and the first agency account:

```sh
npm run db:migrate
```

The seed command reads credentials from the environment, never stores a default password, and refuses duplicate usernames. Run it again with another username to add an agency staff account. In zsh, enter credentials without putting the password in shell history:

```sh
read "SEED_AGENCY_USERNAME?Agency username: "
read -s "SEED_AGENCY_PASSWORD?Agency password (12+ characters): "
printf '\n'
export SEED_AGENCY_USERNAME SEED_AGENCY_PASSWORD
npm run seed:agency
unset SEED_AGENCY_USERNAME SEED_AGENCY_PASSWORD
```

Run both applications:

```sh
npm run dev
```

Open <http://localhost:5173/agency/login> for the agency portal and <http://localhost:5173/client/login> for the client portal. The Vite server proxies `/api` to Express on port 3001. Agency creates client accounts without email and sets an initial password; the client is required to replace it at first login.

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | API port | `3001` |
| `CLIENT_ORIGIN` | Allowed browser origin and mutation origin check | `http://localhost:5173` |
| `SESSION_SECRET` | HMAC secret for opaque session cookies | Random local-only secret; required (32+ chars) in production |
| `DATABASE_PATH` | SQLite database file | `server/data/workyuk.sqlite` |
| `UPLOAD_DIR` | Private local binary storage | `server/uploads` |
| `MAX_UPLOAD_MB` | Per-file limit | `25` |
| `NODE_ENV` | Runtime mode | `development` |

The API runs migrations automatically on startup. You can also apply them explicitly with `npm run db:migrate`. The seed command requires `SEED_AGENCY_USERNAME` and `SEED_AGENCY_PASSWORD` in the environment; passwords must be at least 12 characters. Never commit `.env`, a database, or uploaded files.

## Commands

```sh
npm run dev       # Vite and Express
npm run build     # Production frontend build
npm test          # Backend API integration and client API helper tests
npm run db:migrate
npm run seed:agency
```

## Core behavior

- Agency accounts are seeded; there is no public agency registration. Client identities use normalized usernames and passwords, not email.
- Passwords use bcrypt. Browser sessions use signed, opaque, SQLite-backed IDs in `HttpOnly`, `SameSite=Lax` cookies; cookies are `Secure` in production. Mutating requests with a browser `Origin` must match `CLIENT_ORIGIN`.
- Client users can only read projects owned by their client profile. Comments, attachment listing/download, activity, history, upload, and review actions resolve ownership on the server.
- Client serializers omit internal notes. The client may only approve or request revisions for a deliverable in `In Review`; revision requires a comment.
- Attachments support PDF, PNG, JPG/JPEG, TXT, and HTTP(S) links. Uploads use random names, extension/MIME allowlists, file-signature checks, a configurable size limit, and authenticated downloads. The upload folder is never mounted as a public static directory.
- Project archive is a soft archive. Deleting a deliverable cascades its comments and attachment metadata; associated binaries are removed from local storage. Comments are append-only in this MVP.
- Status changes, comments, attachment changes, due date changes, approvals, and revisions are written to the activity log and status history.

## API outline

- Auth: `POST /api/auth/agency/login`, `POST /api/auth/client/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/change-password`
- Agency client management: `GET/POST /api/agency/clients`, `GET/PATCH /api/agency/clients/:id`, `POST /api/agency/clients/:id/reset-password`
- Dashboard: `GET /api/dashboard/agency`, `GET /api/dashboard/client`
- Project workflow: `GET/POST /api/projects`, `GET/PATCH /api/projects/:id`, `POST /api/projects/:id/archive`, `POST /api/projects/:id/subprojects`, `PATCH/DELETE /api/subprojects/:id`
- Collaboration: project comments, attachments, activity and status history; `POST /api/subprojects/:id/review`

Responses use `{ data: ... }` for success and `{ error: { code, message, fields? } }` for errors. Client access failures return 404 to avoid disclosing another client's resource IDs.

## Data, uploads, and backups

The database is initialized from versioned SQL migrations under `server/src/db/migrations`. SQLite has foreign keys enabled, indexed ownership/status/date fields, and integrity triggers that make sure a subproject belongs to the referenced project. File binaries live on the local filesystem; SQLite stores metadata only.

Back up the SQLite database and upload directory as one set. For a consistent local snapshot, stop the app first, copy the configured database file and the entire configured upload directory to the same backup folder, then restart the app. Restore both to their configured locations while the app is stopped. In production, use a coordinated filesystem/SQLite snapshot or SQLite's online backup API; do not copy a live WAL database file alone.

## Current MVP limitations

- One agency workspace is supported. Agency staff accounts are created through the seed command; there is no public registration or staff admin screen. Unread counters and push/email notifications are outside this MVP.
- Comments cannot be edited or deleted. There are no controls suggesting otherwise.
- Upload validation checks a small allowlist and file signatures, but does not run antivirus or content-disarm scanning. Restrict file access and review deployment-specific scanning needs before accepting untrusted public uploads.
- Only PDF, PNG, JPG/JPEG, TXT, and HTTP(S) links are accepted. Storage uses a local adapter designed to be replaced with a managed storage provider later.
- Agency can archive projects; there is no unarchive or hard-delete workflow in the UI.
