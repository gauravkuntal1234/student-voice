# Student Voice

Student Voice is a single-page portal served by a Node.js backend. The server verifies Google ID tokens, keeps browser sessions in secure HTTP-only cookies, and stores student profiles, issues, votes, faculty responses, approvals, archived issues, and chat messages in MySQL.

## Run locally

1. Install Node.js 22.13 or newer.
2. In PowerShell, open the project folder and run:

   ```powershell
   npm.cmd install
   Copy-Item .env.example .env
   ```

3. Create a MySQL schema named `student_voice` in MySQL Workbench, or set `MYSQL_DATABASE` in `.env` to the name of an existing schema. Add your MySQL host, port, username, and password to the `MYSQL_*` settings in `.env`. Do not share or commit the password.
4. Start the app:

   ```powershell
   npm.cmd start
   ```

5. Open `http://127.0.0.1:3000`.

The app creates its tables in the selected MySQL schema on first start. Demo login shortcuts are disabled. Students sign in using an `@bsacet.org` address and a one-time email code; faculty and administrators use Google sign-in.

To copy existing data from `data/student-voice.sqlite`, set `MIGRATE_SQLITE=true` in `.env` for the first MySQL startup. The migration runs only when the destination tables are empty, copies profiles, faculty, sessions, issues, votes, and chats, and preserves the original SQLite file. After a successful startup, set `MIGRATE_SQLITE=false` again. If a migration fails, correct the MySQL settings or schema and retry; the SQLite source remains unchanged.

## Configure sign-in

1. In Google Cloud Console, create a project and configure the OAuth consent screen.
2. Create an OAuth client with application type **Web application**.
3. Add `http://127.0.0.1:3000` to **Authorized JavaScript origins** for local testing.
4. Copy the OAuth **Client ID** into `.env` as `GOOGLE_CLIENT_ID=...`. This client ID is public and is served to the browser; never put a client secret in this static app.
5. Set `ADMIN_EMAILS` to the comma-separated Google email address(es) that own the portal. Set `FACULTY_EMAILS` only for faculty accounts that should be pre-approved.
6. Configure SMTP in `.env` so the server can send student codes. For Google Workspace/Gmail, set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` to the sending mailbox, and `SMTP_FROM` to the approved sender address. Put an App Password in `SMTP_PASSWORD` only if the Workspace account and its administrator permit App Passwords; never use a normal Gmail password.
7. Set a random private value for `OTP_PEPPER`, then stop and restart the server after changing `.env`.

Students must use a syntactically valid `@bsacet.org` address and prove mailbox access with a six-digit code sent by email. Codes expire after 10 minutes, are single-use, allow at most five verification attempts, and can be resent once per minute. The server rate-limits requests per email and client IP. Student Google OAuth bypass is disabled. Faculty and administrators must sign in with a Google-verified account that has been approved/configured on the server. Student profiles are saved to MySQL; Gmail passwords are never requested.

## Production deployment

The app is designed to be deployed as a Node.js web service with a managed MySQL database. GitHub Pages alone cannot host the backend or database. Configure the hosting platform to run `npm ci` during build and `npm start` to start the service; use Node.js 22.13 or newer.

Set these values in the hosting provider's **private environment/secrets settings**, not in GitHub source files:

- `NODE_ENV=production`
- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, and `MYSQL_PASSWORD` for the production MySQL instance. Create the schema first and set `MYSQL_CREATE_DATABASE=false`; the database account still needs permission to create/update the app's tables.
- `GOOGLE_CLIENT_ID` for the OAuth web client, and `ADMIN_EMAILS` for the portal administrator(s).
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and optionally `SMTP_FROM` for OTP delivery.
- `OTP_PEPPER` as a private random value of at least 32 characters. Keep it stable: changing it invalidates pending OTP challenges.
- `PORT` is normally supplied by the hosting provider. The app binds to `0.0.0.0` in production by default.

Enable the hosting provider's HTTPS/custom domain, then add the exact public `https://your-domain` origin to the Google OAuth web client's **Authorized JavaScript origins**. Update the deployed `GOOGLE_CLIENT_ID` if using a different OAuth client. The application uses same-origin API requests and secure HTTP-only session cookies in production. Production startup fails if required sign-in, SMTP, administrator, or database credentials are missing. `GET /api/health` checks that the app can query MySQL and can be used as a hosting health check.

After deployment, test student OTP email delivery, faculty/admin Google sign-in, profiles, issue creation and voting, and chats over HTTPS. Set up automated MySQL backups and verify that a backup can be restored. Do not publish `.env`, database exports, SMTP credentials, OAuth secrets, or `node_modules`.

## What is persisted

Authenticated sessions, profiles and avatar choices, faculty approvals, issues, vote choices, statuses, faculty responses, archived issues, and chat messages are persisted by the backend. Student profiles include a **My profile** page with saved student details and that signed-in student's submitted issues, including issue status, faculty responses, archive status, and attached evidence. Voting is limited to one vote per authenticated account per issue, with the option to remove that vote. Archive downloads are JSON files and can include attached evidence. Messages are refreshed every five seconds while a chat is open.

The seeded sample issues are stored in MySQL the first time the database is created. Back up the MySQL schema regularly.

## Important setup boundary

Only people whose Google emails are in `ADMIN_EMAILS` can administer the real backend. Admins can add faculty in the Developer console; those accounts cannot sign in as faculty until approved. Adding a teacher's email is not identity proof by itself: the teacher must sign in with the same verified Google account.
