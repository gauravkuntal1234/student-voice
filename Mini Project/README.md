# Student Voice

Student Voice is a single-page portal served by a Node.js backend. The server verifies Google ID tokens, keeps browser sessions in secure HTTP-only cookies, and stores student profiles, issues, votes, faculty responses, approvals, archived issues, and chat messages in SQLite.

## Run locally

1. Install Node.js 22.13 or newer.
2. In PowerShell, open the project folder and run:

   ```powershell
   npm.cmd install
   Copy-Item .env.example .env
   ```

3. Start the app:

   ```powershell
   npm.cmd start
   ```

4. Open `http://127.0.0.1:3000`.

The app creates `data/student-voice.sqlite` on first start. Demo login shortcuts are disabled. Students sign in using an `@bsacet.org` address and a one-time email code; faculty and administrators use Google sign-in.

## Configure sign-in

1. In Google Cloud Console, create a project and configure the OAuth consent screen.
2. Create an OAuth client with application type **Web application**.
3. Add `http://127.0.0.1:3000` to **Authorized JavaScript origins** for local testing.
4. Copy the OAuth **Client ID** into `.env` as `GOOGLE_CLIENT_ID=...`. This client ID is public and is served to the browser; never put a client secret in this static app.
5. Set `ADMIN_EMAILS` to the comma-separated Google email address(es) that own the portal. Set `FACULTY_EMAILS` only for faculty accounts that should be pre-approved.
6. Configure SMTP in `.env` so the server can send student codes. For Google Workspace/Gmail, set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` to the sending mailbox, and `SMTP_FROM` to the approved sender address. Put an App Password in `SMTP_PASSWORD` only if the Workspace account and its administrator permit App Passwords; never use a normal Gmail password.
7. Set a random private value for `OTP_PEPPER`, then stop and restart the server after changing `.env`.

Students must use a syntactically valid `@bsacet.org` address and prove mailbox access with a six-digit code sent by email. Codes expire after 10 minutes, are single-use, allow at most five verification attempts, and can be resent once per minute. The server rate-limits requests per email and client IP. Student Google OAuth bypass is disabled. Faculty and administrators must sign in with a Google-verified account that has been approved/configured on the server. Student profiles are saved to SQLite; Gmail passwords are never requested.

For a public deployment, use HTTPS and a hosting provider that supports Node.js, persistent disk storage, and backups. Register the final HTTPS origin in Google Cloud Console and set `NODE_ENV=production`. Do not publish `.env`, the SQLite database, or `node_modules`.

## What is persisted

Authenticated sessions, profiles and avatar choices, faculty approvals, issues, vote choices, statuses, faculty responses, archived issues, and chat messages are persisted by the backend. Student profiles include a **My profile** page with saved student details and that signed-in student's submitted issues, including issue status, faculty responses, archive status, and attached evidence. Voting is limited to one vote per authenticated account per issue, with the option to remove that vote. Archive downloads are JSON files and can include attached evidence. Messages are refreshed every five seconds while a chat is open.

The seeded sample issues are stored in SQLite the first time the database is created. Back up the `data` directory regularly.

## Important setup boundary

Only people whose Google emails are in `ADMIN_EMAILS` can administer the real backend. Admins can add faculty in the Developer console; those accounts cannot sign in as faculty until approved. Adding a teacher's email is not identity proof by itself: the teacher must sign in with the same verified Google account.
