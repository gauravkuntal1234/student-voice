import { createServer } from "node:http";
import { createReadStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { randomBytes, randomInt, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { OAuth2Client } from "google-auth-library";
import nodemailer from "nodemailer";
import mysql from "mysql2/promise";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const isProduction = process.env.NODE_ENV === "production";
const clientId = process.env.GOOGLE_CLIENT_ID?.trim() || "";
const studentEmailDomain = "@bsacet.org";
const otpPepper = process.env.OTP_PEPPER || (isProduction ? "" : randomBytes(32).toString("hex"));
const smtpHost = process.env.SMTP_HOST?.trim() || "";
const smtpUser = process.env.SMTP_USER?.trim() || "";
const smtpPassword = process.env.SMTP_PASSWORD || "";
const smtpFrom = process.env.SMTP_FROM?.trim() || smtpUser;
const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpSecure = process.env.SMTP_SECURE !== "false";
const smtpConfigured = smtpHost && smtpUser && smtpPassword && smtpFrom &&
  Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort <= 65_535;
const mailer = smtpConfigured
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: { user: smtpUser, pass: smtpPassword },
    })
  : null;
const sessionDays = Math.min(Math.max(Number(process.env.SESSION_DAYS || 7), 1), 30);
const sessionDuration = sessionDays * 24 * 60 * 60 * 1000;
const adminEmails = new Set(
  (process.env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean),
);
const facultyEmails = new Set(
  (process.env.FACULTY_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean),
);
const otpIpWindows = new Map();
const oauthClient = new OAuth2Client(clientId || undefined);
const databaseName = process.env.MYSQL_DATABASE || "student_voice";
if (isProduction) {
  const missingSettings = [
    ["GOOGLE_CLIENT_ID", clientId],
    ["ADMIN_EMAILS", adminEmails.size > 0],
    ["OTP_PEPPER", otpPepper.length >= 32],
    ["SMTP_HOST", smtpHost],
    ["SMTP_USER", smtpUser],
    ["SMTP_PASSWORD", smtpPassword],
    ["MYSQL_HOST", process.env.MYSQL_HOST],
    ["MYSQL_USER", process.env.MYSQL_USER],
    ["MYSQL_PASSWORD", process.env.MYSQL_PASSWORD],
  ].filter(([, configured]) => !configured).map(([name]) => name);
  if (missingSettings.length > 0) {
    throw new Error(`Production configuration is incomplete: ${missingSettings.join(", ")}.`);
  }
}
if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error("MYSQL_DATABASE may contain only letters, numbers, and underscores.");
}
const mysqlOptions = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  waitForConnections: true,
  connectionLimit: 10,
  supportBigNumbers: true,
  bigNumberStrings: false,
};
if (!Number.isInteger(mysqlOptions.port) || mysqlOptions.port < 1 || mysqlOptions.port > 65_535) {
  throw new Error("MYSQL_PORT must be a valid TCP port.");
}
const createDatabase = process.env.MYSQL_CREATE_DATABASE
  ? process.env.MYSQL_CREATE_DATABASE === "true"
  : !isProduction;
if (createDatabase) {
  const bootstrap = await mysql.createConnection({
    host: mysqlOptions.host,
    port: mysqlOptions.port,
    user: mysqlOptions.user,
    password: mysqlOptions.password,
    connectTimeout: 5_000,
  });
  try {
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await bootstrap.end();
  }
}

const pool = mysql.createPool({ ...mysqlOptions, database: databaseName, connectTimeout: 5_000 });
const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    email VARCHAR(254) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    role ENUM('student', 'faculty', 'developer') NOT NULL,
    profile_json LONGTEXT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS faculty_accounts (
    email VARCHAR(254) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    gender VARCHAR(16) NOT NULL DEFAULT '',
    title VARCHAR(255) NOT NULL DEFAULT 'Faculty',
    approved TINYINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    email VARCHAR(254) NOT NULL,
    expires_at BIGINT NOT NULL,
    auth_method VARCHAR(16) NOT NULL DEFAULT 'google',
    INDEX sessions_expiry (expires_at),
    CONSTRAINT sessions_user_fk FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS email_otp_challenges (
    email VARCHAR(254) NOT NULL PRIMARY KEY,
    code_hash CHAR(64) NOT NULL,
    expires_at BIGINT NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    sent_at BIGINT NOT NULL,
    consumed_at BIGINT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS issues (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    portal VARCHAR(32) NOT NULL,
    title VARCHAR(100) NOT NULL,
    category VARCHAR(32) NOT NULL,
    description TEXT NOT NULL,
    author VARCHAR(255) NOT NULL,
    author_email VARCHAR(254) NOT NULL,
    created_at BIGINT NOT NULL,
    status VARCHAR(16) NOT NULL,
    evidence_json LONGTEXT NULL,
    responses_json LONGTEXT NOT NULL,
    archived_at BIGINT NULL,
    archived_by VARCHAR(255) NULL,
    INDEX issues_portal_active (portal, archived_at, created_at),
    INDEX issues_author_time (author_email, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS votes (
    issue_id BIGINT NOT NULL,
    email VARCHAR(254) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (issue_id, email),
    CONSTRAINT votes_issue_fk FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
    CONSTRAINT votes_user_fk FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    conversation_key VARCHAR(520) NOT NULL,
    author_email VARCHAR(254) NOT NULL,
    text VARCHAR(1000) NOT NULL,
    created_at BIGINT NOT NULL,
    INDEX chat_conversation_time (conversation_key, created_at),
    CONSTRAINT chat_author_fk FOREIGN KEY (author_email) REFERENCES users(email) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS migration_state (
    migration_key VARCHAR(100) NOT NULL PRIMARY KEY,
    completed_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];
for (const statement of schema) await pool.query(statement);

async function migrateSqliteData() {
  if (process.env.MIGRATE_SQLITE !== "true") return;
  const migrationKey = "sqlite-to-mysql-v1";
  const [completed] = await pool.execute("SELECT migration_key FROM migration_state WHERE migration_key = ?", [migrationKey]);
  const sqlitePath = resolve(root, process.env.DATABASE_PATH || "./data/student-voice.sqlite");
  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  if (completed.length > 0) {
    const otpMigrationKey = "sqlite-to-mysql-otp-v1";
    const [otpMigrated] = await pool.execute("SELECT migration_key FROM migration_state WHERE migration_key = ?", [otpMigrationKey]);
    if (otpMigrated.length === 0) {
      const challenges = source.prepare(`
        SELECT email, code_hash, expires_at, attempts, sent_at, consumed_at
        FROM email_otp_challenges
      `).all();
      for (const challenge of challenges) {
        await pool.execute(`
          INSERT IGNORE INTO email_otp_challenges (email, code_hash, expires_at, attempts, sent_at, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          challenge.email,
          challenge.code_hash,
          challenge.expires_at,
          challenge.attempts,
          challenge.sent_at,
          challenge.consumed_at,
        ]);
      }
      await pool.execute("INSERT INTO migration_state (migration_key, completed_at) VALUES (?, ?)", [otpMigrationKey, Date.now()]);
      console.log("Pending SQLite email verification challenges were copied to MySQL.");
    }
    source.close();
    return;
  }

  const tables = {
    users: ["email", "name", "role", "profile_json", "created_at", "updated_at"],
    faculty_accounts: ["email", "name", "gender", "title", "approved", "created_at"],
    issues: ["id", "portal", "title", "category", "description", "author", "author_email", "created_at", "status", "evidence_json", "responses_json", "archived_at", "archived_by"],
    sessions: ["token_hash", "email", "expires_at", "auth_method"],
    email_otp_challenges: ["email", "code_hash", "expires_at", "attempts", "sent_at", "consumed_at"],
    votes: ["issue_id", "email", "created_at"],
    chat_messages: ["id", "conversation_key", "author_email", "text", "created_at"],
  };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const table of Object.keys(tables)) {
      const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
      if (Number(rows[0].count) !== 0) {
        throw new Error(`Cannot migrate SQLite data because MySQL table "${table}" is not empty.`);
      }
    }
    for (const [table, columns] of Object.entries(tables)) {
      const rows = source.prepare(`SELECT ${columns.map((column) => `\`${column}\``).join(", ")} FROM \`${table}\``).all();
      if (rows.length === 0) continue;
      const insert = `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
      for (const row of rows) {
        await connection.execute(insert, columns.map((column) => row[column]));
      }
    }
    await connection.execute("INSERT INTO migration_state (migration_key, completed_at) VALUES (?, ?)", [migrationKey, Date.now()]);
    await connection.execute("INSERT INTO migration_state (migration_key, completed_at) VALUES (?, ?)", ["sqlite-to-mysql-otp-v1", Date.now()]);
    await connection.commit();
    console.log("SQLite data was copied to MySQL; the original SQLite file was preserved.");
  } catch (cause) {
    await connection.rollback();
    throw cause;
  } finally {
    source.close();
    connection.release();
  }
}

await migrateSqliteData();

const database = {
  prepare(statement) {
    return {
      async get(...parameters) {
        const [rows] = await pool.execute(statement, parameters);
        return rows[0];
      },
      async all(...parameters) {
        const [rows] = await pool.execute(statement, parameters);
        return rows;
      },
      async run(...parameters) {
        const [result] = await pool.execute(statement, parameters);
        return { changes: result.affectedRows, lastInsertRowid: result.insertId };
      },
    };
  },
  close() {
    return pool.end();
  },
};

const addConfiguredFaculty = database.prepare(`
  INSERT IGNORE INTO faculty_accounts (email, name, title, approved, created_at)
  VALUES (?, ?, 'Faculty', 1, ?)
`);
for (const email of facultyEmails) {
  await addConfiguredFaculty.run(email, email, Date.now());
}

const seedCount = Number((await database.prepare("SELECT COUNT(*) AS count FROM issues").get()).count);
if (seedCount === 0) {
  const seedIssue = database.prepare(`
    INSERT INTO issues (
      portal, title, category, description, author, author_email, created_at,
      status, responses_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  await seedIssue.run(
    "Public Portal",
    "Library Wi-Fi keeps disconnecting",
    "Facilities",
    "The connection drops repeatedly in the reading area, making it difficult to access research materials.",
    "Student Voice demo",
    "sample@demo.com",
    now - 3_600_000,
    "Open",
    "[]",
  );
  await seedIssue.run(
    "Public Portal",
    "Please publish exam timetables earlier",
    "Academic",
    "A little more notice would help students plan revision around other commitments.",
    "Student Voice demo",
    "sample-2@demo.com",
    now - 7_200_000,
    "In review",
    JSON.stringify([{
      author: "Demo Faculty",
      text: "The exam office has been asked to review the publication timeline.",
      createdAt: now - 1_800_000,
    }]),
  );
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isStudentEmail(email) {
  return email.endsWith(studentEmailDomain) && /^[^\s@]+@bsacet\.org$/.test(email);
}

function hashOtp(email, code) {
  return createHmac("sha256", otpPepper).update(`${email}:${code}`).digest("hex");
}

async function issueSession(email, authMethod) {
  const now = Date.now();
  const session = randomBytes(32).toString("base64url");
  const sessionHash = createHash("sha256").update(session).digest("hex");
  await database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  await database.prepare("INSERT INTO sessions (token_hash, email, expires_at, auth_method) VALUES (?, ?, ?, ?)").run(
    sessionHash,
    email,
    now + sessionDuration,
    authMethod,
  );
  return session;
}

function json(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function error(response, status, message) {
  json(response, status, { error: message });
}

function cookieOptions() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDays * 86400}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `sv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function parseCookies(request) {
  const cookies = new Map();
  for (const entry of (request.headers.cookie || "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    cookies.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim());
  }
  return cookies;
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 9 * 1024 * 1024) {
      const limitError = new Error("Request body is larger than 9 MB.");
      limitError.statusCode = 413;
      throw limitError;
    }
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const parseError = new Error("Request body must be valid JSON.");
    parseError.statusCode = 400;
    throw parseError;
  }
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) {
    if (!isProduction) return;
    const originError = new Error("A same-origin request is required.");
    originError.statusCode = 403;
    throw originError;
  }
  const expected = `${process.env.NODE_ENV === "production" ? "https" : "http"}://${request.headers.host}`;
  if (origin !== expected) {
    const originError = new Error("Cross-origin requests are not allowed.");
    originError.statusCode = 403;
    throw originError;
  }
}

async function getUserFromSession(request) {
  const sessionToken = parseCookies(request).get("sv_session");
  if (!sessionToken) return null;
  const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
  const row = await database.prepare(`
    SELECT users.email, users.name, users.role, users.profile_json, sessions.auth_method
    FROM sessions JOIN users ON users.email = sessions.email
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash, Date.now());
  if (!row) return null;
  const role = await roleFor(row.email);
  if (role === "pending-faculty") return null;
  if (role === "student" && (!isStudentEmail(row.email) || row.auth_method !== "otp")) return null;
  const profile = row.profile_json ? JSON.parse(row.profile_json) : {};
  const faculty = role === "faculty"
    ? await database.prepare("SELECT name, gender, title FROM faculty_accounts WHERE email = ?").get(row.email)
    : null;
  return {
    email: row.email,
    name: profile.fullName || faculty?.name || row.name,
    role,
    ...(faculty ? { gender: faculty.gender, title: faculty.title } : {}),
    ...profile,
  };
}

async function roleFor(email) {
  if (adminEmails.has(email)) return "developer";
  const faculty = await database.prepare("SELECT approved FROM faculty_accounts WHERE email = ?").get(email);
  if (faculty) return faculty.approved ? "faculty" : "pending-faculty";
  return "student";
}

async function requireUser(request, response) {
  const user = await getUserFromSession(request);
  if (!user) {
    error(response, 401, "Please sign in with Google again.");
    return null;
  }
  return user;
}

function canAccessPortal(user, portal) {
  if (!["Public Portal", "Personal Portal", "Boys Portal", "Girls Portal"].includes(portal)) return false;
  if (portal === "Boys Portal") return user.role === "developer" || user.gender === "Male";
  if (portal === "Girls Portal") return user.role === "developer" || user.gender === "Female";
  return true;
}

async function canAccessConversation(user, key) {
  if (key === "public") return true;
  if (key === "boys") return user.role === "developer" || user.gender === "Male";
  if (key === "girls") return user.role === "developer" || user.gender === "Female";
  if (!key.startsWith("direct:")) return false;
  const participants = key.slice("direct:".length).split("|");
  if (participants.length !== 2 || participants[0] === participants[1] || !participants.includes(user.email)) return false;
  const otherEmail = participants.find((email) => email !== user.email);
  const faculty = await database.prepare("SELECT approved FROM faculty_accounts WHERE email = ?").get(otherEmail);
  const otherUser = await database.prepare("SELECT email FROM users WHERE email = ?").get(otherEmail);
  if (!otherUser) return false;
  if (user.role === "developer") return true;
  if (user.role === "student") return Boolean(faculty?.approved);
  return user.role === "faculty" && await roleFor(otherEmail) === "student";
}

async function mapMessage(row) {
  const profile = row.profile_json ? JSON.parse(row.profile_json) : {};
  const faculty = row.faculty_name
    ? { name: row.faculty_name, gender: row.faculty_gender, title: row.faculty_title }
    : null;
  const gender = faculty?.gender || profile.gender || "";
  return {
    id: row.id,
    name: profile.fullName || faculty?.name || row.name || row.author_email,
    email: row.author_email,
    role: faculty ? "faculty" : await roleFor(row.author_email),
    gender,
    avatarChoice: profile.avatarChoice || (gender ? gender.toLowerCase() : "initials"),
    imageData: profile.imageData || "",
    text: row.text,
    createdAt: row.created_at,
    time: new Date(row.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };
}

async function fetchMessages(key, limit = 100) {
  const rows = await database.prepare(`
    SELECT chat_messages.id, chat_messages.author_email, chat_messages.text, chat_messages.created_at,
      users.name, users.profile_json, faculty_accounts.name AS faculty_name,
      faculty_accounts.gender AS faculty_gender, faculty_accounts.title AS faculty_title
    FROM chat_messages
    JOIN users ON users.email = chat_messages.author_email
    LEFT JOIN faculty_accounts ON faculty_accounts.email = chat_messages.author_email
    WHERE chat_messages.conversation_key = ?
    ORDER BY chat_messages.created_at DESC, chat_messages.id DESC
    LIMIT ?
  `).all(key, limit);
  const messages = [];
  for (const row of rows.reverse()) {
    if (row.faculty_name) row.name = row.faculty_name;
    messages.push(await mapMessage(row));
  }
  return messages;
}

async function mapIssue(row, user, includeArchive = false) {
  const result = {
    id: row.id,
    portal: row.portal,
    title: row.title,
    category: row.category,
    description: row.description,
    author: row.author,
    authorEmail: row.author_email,
    createdAt: row.created_at,
    status: row.status,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
    responses: JSON.parse(row.responses_json),
    supportCount: Number((await database.prepare("SELECT COUNT(*) AS count FROM votes WHERE issue_id = ?").get(row.id)).count),
    hasVoted: Boolean(await database.prepare("SELECT 1 FROM votes WHERE issue_id = ? AND email = ?").get(row.id, user.email)),
  };
  if (includeArchive) {
    result.archivedAt = row.archived_at;
    result.archivedBy = row.archived_by;
  }
  return result;
}

function validateEvidence(evidence) {
  if (evidence == null) return null;
  if (
    typeof evidence !== "object" ||
    typeof evidence.data !== "string" ||
    typeof evidence.type !== "string" ||
    typeof evidence.name !== "string" ||
    (!evidence.type.startsWith("image/") && !evidence.type.startsWith("video/")) ||
    !evidence.data.startsWith(`data:${evidence.type};base64,`) ||
    Buffer.byteLength(evidence.data, "utf8") > 7 * 1024 * 1024
  ) {
    throw Object.assign(new Error("Evidence must be a photo or video smaller than 5 MB."), { statusCode: 400 });
  }
  return evidence;
}

async function handleApi(request, response, url) {
  const { pathname, searchParams } = url;
  const method = request.method || "GET";
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) assertSameOrigin(request);

  if (method === "GET" && pathname === "/api/health") {
    await database.prepare("SELECT 1 AS ok").get();
    return json(response, 200, { status: "ok" });
  }
  if (method === "GET" && pathname === "/api/config") {
    return json(response, 200, { googleClientId: clientId });
  }
  if (method === "POST" && pathname === "/api/auth/otp/request") {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return error(response, 400, "Enter a valid college email address.");
    }
    if (!isStudentEmail(email)) {
      return error(response, 403, "Student sign-in is only available with an @bsacet.org email address.");
    }
    if (await roleFor(email) !== "student") {
      return error(response, 403, "This account must sign in using the Google button.");
    }
    if (!mailer) return error(response, 503, "Email OTP is not configured. Set the SMTP settings in the local .env file.");

    const now = Date.now();
    const previous = await database.prepare("SELECT sent_at FROM email_otp_challenges WHERE email = ?").get(email);
    if (previous && now - previous.sent_at < 60_000) {
      return json(response, 200, {
        ok: true,
        message: "A code was sent recently. Check your inbox or spam folder and enter it below.",
      });
    }
    const ip = request.socket.remoteAddress || "unknown";
    let ipWindow = otpIpWindows.get(ip);
    if (!ipWindow || now - ipWindow.startedAt >= 60 * 60_000) {
      ipWindow = { startedAt: now, count: 0 };
      otpIpWindows.set(ip, ipWindow);
    }
    if (ipWindow.count >= 10) return error(response, 429, "Too many code requests. Try again in an hour.");
    ipWindow.count += 1;
    if (otpIpWindows.size > 1_000) {
      for (const [key, value] of otpIpWindows) {
        if (now - value.startedAt >= 60 * 60_000) otpIpWindows.delete(key);
      }
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = hashOtp(email, code);
    await database.prepare(`
      INSERT INTO email_otp_challenges (email, code_hash, expires_at, attempts, sent_at, consumed_at)
      VALUES (?, ?, ?, 0, ?, NULL)
      ON DUPLICATE KEY UPDATE
        code_hash = VALUES(code_hash),
        expires_at = VALUES(expires_at),
        attempts = 0,
        sent_at = VALUES(sent_at),
        consumed_at = NULL
    `).run(email, codeHash, now + 10 * 60_000, now);
    try {
      await mailer.sendMail({
        from: smtpFrom,
        to: email,
        subject: "Your Student Voice verification code",
        text: `Your Student Voice sign-in code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      });
    } catch (cause) {
      await database.prepare("DELETE FROM email_otp_challenges WHERE email = ? AND code_hash = ?").run(email, codeHash);
      console.error("Email OTP delivery failed:", JSON.stringify({
        name: cause.name,
        code: cause.code,
        responseCode: cause.responseCode,
        command: cause.command,
        response: cause.response,
      }));
      return error(response, 502, "The verification email could not be sent. Check the SMTP settings and try again.");
    }
    return json(response, 200, { ok: true, message: "A verification code was sent to your college email." });
  }
  if (method === "POST" && pathname === "/api/auth/otp/verify") {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!isStudentEmail(email)) {
      return error(response, 403, "Student sign-in is only available with an @bsacet.org email address.");
    }
    if (!/^\d{6}$/.test(code)) return error(response, 400, "Enter the six-digit verification code.");
    if (await roleFor(email) !== "student") {
      return error(response, 403, "This account must sign in using the Google button.");
    }
    const challenge = await database.prepare("SELECT * FROM email_otp_challenges WHERE email = ?").get(email);
    if (!challenge || challenge.consumed_at || challenge.expires_at <= Date.now() || challenge.attempts >= 5) {
      return error(response, 401, "The code is missing, expired, or locked. Request a new verification code.");
    }
    const expectedHash = Buffer.from(challenge.code_hash, "hex");
    const actualHash = Buffer.from(hashOtp(email, code), "hex");
    if (!timingSafeEqual(expectedHash, actualHash)) {
      await database.prepare("UPDATE email_otp_challenges SET attempts = attempts + 1 WHERE email = ?").run(email);
      return error(response, 401, "That verification code is incorrect.");
    }

    const now = Date.now();
    const existing = await database.prepare("SELECT name, profile_json FROM users WHERE email = ?").get(email);
    const name = existing?.name || email;
    await database.prepare(`
      INSERT INTO users (email, name, role, profile_json, created_at, updated_at)
      VALUES (?, ?, 'student', ?, ?, ?)
      ON DUPLICATE KEY UPDATE role = 'student', updated_at = VALUES(updated_at)
    `).run(email, name, existing?.profile_json || null, now, now);
    await database.prepare("UPDATE email_otp_challenges SET consumed_at = ? WHERE email = ?").run(now, email);
    const session = await issueSession(email, "otp");
    const profile = existing?.profile_json ? JSON.parse(existing.profile_json) : {};
    return json(response, 200, {
      user: { email, name: profile.fullName || name, role: "student", ...profile },
      profileComplete: Boolean(profile.collegeId && profile.gender),
    }, { "Set-Cookie": `sv_session=${session}; ${cookieOptions()}` });
  }
  if (method === "POST" && pathname === "/api/auth/google") {
    if (!clientId) return error(response, 503, "Google sign-in is not configured on this server yet.");
    const body = await readJson(request);
    if (typeof body.credential !== "string" || body.credential.length > 12_000) {
      return error(response, 400, "Google did not return a valid sign-in credential.");
    }
    let ticket;
    try {
      ticket = await oauthClient.verifyIdToken({ idToken: body.credential, audience: clientId });
    } catch {
      return error(response, 401, "Google could not verify this sign-in. Please try again.");
    }
    const payload = ticket.getPayload();
    const email = normalizeEmail(payload?.email);
    if (!email || payload?.email_verified !== true) {
      return error(response, 401, "Google must confirm that this email address is verified.");
    }

    const now = Date.now();
    const role = await roleFor(email);
    if (role === "pending-faculty") {
      return error(response, 403, "This faculty account is awaiting administrator approval.");
    }
    if (role === "student") {
      return error(response, 403, "Students must sign in with their @bsacet.org email and verification code.");
    }
    const faculty = role === "faculty"
      ? await database.prepare("SELECT name, gender, title FROM faculty_accounts WHERE email = ?").get(email)
      : null;
    const existing = await database.prepare("SELECT profile_json FROM users WHERE email = ?").get(email);
    const savedProfile = existing?.profile_json ? JSON.parse(existing.profile_json) : {};
    const name = savedProfile.fullName || faculty?.name || payload.name || email;
    await database.prepare(`
      INSERT INTO users (email, name, role, profile_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = VALUES(updated_at)
    `).run(email, name, role, existing?.profile_json || null, now, now);

    const session = await issueSession(email, "google");
    const profile = await database.prepare("SELECT profile_json FROM users WHERE email = ?").get(email);
    const userProfile = profile.profile_json ? JSON.parse(profile.profile_json) : {};
    return json(response, 200, {
      user: { email, name, role, ...(faculty ? { gender: faculty.gender, title: faculty.title } : {}), ...userProfile },
      profileComplete: role !== "student" || Boolean(userProfile.collegeId && userProfile.gender),
    }, { "Set-Cookie": `sv_session=${session}; ${cookieOptions()}` });
  }

  if (method === "GET" && pathname === "/api/auth/me") {
    const user = await getUserFromSession(request);
    if (!user) return json(response, 200, { user: null, profileComplete: false });
    return json(response, 200, {
      user,
      profileComplete: user.role !== "student" || Boolean(user.collegeId && user.gender),
    });
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    const sessionToken = parseCookies(request).get("sv_session");
    if (sessionToken) {
      const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
      await database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    }
    return json(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  const user = await requireUser(request, response);
  if (!user) return;

  if (pathname === "/api/admin/faculty") {
    if (user.role !== "developer") return error(response, 403, "Developer administrator access is required.");
    if (method === "GET") {
      const teachers = await database.prepare(`
        SELECT email, name, gender, title, approved FROM faculty_accounts ORDER BY created_at, email
      `).all().map((teacher) => ({ ...teacher, approved: Boolean(teacher.approved) }));
      return json(response, 200, teachers);
    }
    if (method === "POST") {
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const gender = body.gender;
      if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return error(response, 400, "Enter a valid faculty Google email.");
      }
      if (!name || name.length > 120 || !["Male", "Female"].includes(gender)) {
        return error(response, 400, "Enter a faculty name and select a valid gender.");
      }
      if (adminEmails.has(email)) return error(response, 409, "An administrator cannot be added as faculty.");
      try {
        await database.prepare(`
          INSERT INTO faculty_accounts (email, name, gender, title, approved, created_at)
          VALUES (?, ?, ?, 'Faculty', 0, ?)
        `).run(email, name, gender, Date.now());
      } catch (cause) {
        if (cause.code === "ER_DUP_ENTRY") return error(response, 409, "This faculty email is already on the list.");
        throw cause;
      }
      return json(response, 201, { ok: true });
    }
  }

  const facultyApprovalMatch = pathname.match(/^\/api\/admin\/faculty\/([^/]+)\/approval$/);
  if (method === "PATCH" && facultyApprovalMatch) {
    if (user.role !== "developer") return error(response, 403, "Developer administrator access is required.");
    const email = normalizeEmail(decodeURIComponent(facultyApprovalMatch[1]));
    const body = await readJson(request);
    if (typeof body.approved !== "boolean") return error(response, 400, "Approval must be true or false.");
    const result = await database.prepare("UPDATE faculty_accounts SET approved = ? WHERE email = ?")
      .run(body.approved ? 1 : 0, email);
    if (result.changes === 0) return error(response, 404, "Faculty account not found.");
    return json(response, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/api/faculty") {
    const teachers = await database.prepare(`
      SELECT email, name, gender, title FROM faculty_accounts
      WHERE approved = 1 AND email != ? ORDER BY name, email
    `).all(user.email);
    return json(response, 200, teachers);
  }

  if (method === "GET" && pathname === "/api/inbox") {
    if (user.role !== "faculty" && user.role !== "developer") return error(response, 403, "Faculty access is required.");
    const rows = await database.prepare(`
      SELECT conversation_key, MAX(id) AS latest_id
      FROM chat_messages WHERE conversation_key LIKE 'direct:%'
      GROUP BY conversation_key ORDER BY latest_id DESC
    `).all();
    const inbox = [];
    for (const row of rows) {
      if (!row.conversation_key.slice("direct:".length).split("|").includes(user.email)) continue;
      const message = (await fetchMessages(row.conversation_key, 1))[0];
      if (message && message.email !== user.email) inbox.push({ key: row.conversation_key, message });
    }
    return json(response, 200, inbox);
  }

  if (method === "GET" && pathname === "/api/messages") {
    const key = searchParams.get("key") || "";
    if (!await canAccessConversation(user, key)) return error(response, 403, "You cannot access this conversation.");
    return json(response, 200, await fetchMessages(key));
  }

  if (method === "POST" && pathname === "/api/messages") {
    const body = await readJson(request);
    const key = typeof body.key === "string" ? body.key : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!await canAccessConversation(user, key)) return error(response, 403, "You cannot access this conversation.");
    if (!text || text.length > 1_000) return error(response, 400, "Messages must be between 1 and 1,000 characters.");
    const result = await database.prepare(`
      INSERT INTO chat_messages (conversation_key, author_email, text, created_at) VALUES (?, ?, ?, ?)
    `).run(key, user.email, text, Date.now());
    const messageRow = await database.prepare(`
      SELECT chat_messages.id, chat_messages.author_email, chat_messages.text, chat_messages.created_at,
        users.name, users.profile_json, faculty_accounts.name AS faculty_name,
        faculty_accounts.gender AS faculty_gender, faculty_accounts.title AS faculty_title
      FROM chat_messages JOIN users ON users.email = chat_messages.author_email
      LEFT JOIN faculty_accounts ON faculty_accounts.email = chat_messages.author_email
      WHERE chat_messages.id = ?
    `).get(result.lastInsertRowid);
    return json(response, 201, await mapMessage(messageRow));
  }

  const messageDeleteMatch = pathname.match(/^\/api\/messages\/(\d+)$/);
  if (method === "DELETE" && messageDeleteMatch) {
    const id = Number(messageDeleteMatch[1]);
    const row = await database.prepare(`
      SELECT conversation_key, author_email, created_at FROM chat_messages WHERE id = ?
    `).get(id);
    if (!row) return error(response, 404, "Message not found.");
    if (!await canAccessConversation(user, row.conversation_key)) return error(response, 403, "You cannot moderate this conversation.");
    if (user.role === "student") {
      if (row.author_email !== user.email) return error(response, 403, "You can only delete your own messages.");
      const age = Date.now() - Number(row.created_at);
      if (age < 0 || age > 5 * 60_000) return error(response, 403, "Your messages can only be deleted within five minutes.");
    } else if (user.role !== "faculty" && user.role !== "developer") {
      return error(response, 403, "You do not have permission to delete messages.");
    }
    await database.prepare("DELETE FROM chat_messages WHERE id = ?").run(id);
    return json(response, 200, { ok: true });
  }

  if (method === "PUT" && pathname === "/api/profile") {
    if (user.role !== "student") return error(response, 403, "Only student accounts have a student profile.");
    if (!isStudentEmail(user.email)) return error(response, 403, "Student profiles require an @bsacet.org account.");
    const body = await readJson(request);
    const fields = ["fullName", "collegeId", "branch", "section", "year", "gender", "phone", "birthDate", "city", "avatarChoice", "imageData"];
    for (const field of fields) {
      if (body[field] !== undefined && (typeof body[field] !== "string" || body[field].length > 1_500_000)) {
        return error(response, 400, `Invalid ${field}.`);
      }
    }
    for (const field of ["fullName", "collegeId", "branch", "section", "year", "gender"]) {
      if (typeof body[field] !== "string" || !body[field].trim()) return error(response, 400, `${field} is required.`);
    }
    if (!["Male", "Female"].includes(body.gender)) return error(response, 400, "Select a valid gender.");
    const name = body.fullName.trim().slice(0, 120);
    const profile = {
      fullName: name,
      collegeId: body.collegeId.trim().slice(0, 120),
      branch: body.branch.trim().slice(0, 120),
      section: body.section.trim().slice(0, 40),
      year: body.year.trim().slice(0, 40),
      gender: body.gender,
      phone: (body.phone || "Not provided").trim().slice(0, 80),
      birthDate: (body.birthDate || "Not provided").trim().slice(0, 40),
      city: (body.city || "Not provided").trim().slice(0, 120),
      avatarChoice: ["initials", "male", "female", "image"].includes(body.avatarChoice) ? body.avatarChoice : "initials",
      imageData: typeof body.imageData === "string" ? body.imageData : "",
    };
    await database.prepare("UPDATE users SET name = ?, profile_json = ?, updated_at = ? WHERE email = ?")
      .run(name, JSON.stringify(profile), Date.now(), user.email);
    return json(response, 200, { user: { ...user, ...profile, name } });
  }

  if (method === "PUT" && pathname === "/api/profile/appearance") {
    const body = await readJson(request);
    if (!["initials", "male", "female", "image"].includes(body.avatarChoice)) {
      return error(response, 400, "Select a valid profile icon.");
    }
    const imageData = body.imageData || "";
    if (
      typeof imageData !== "string" ||
      imageData.length > 1_500_000 ||
      (imageData && !imageData.startsWith("data:image/"))
    ) {
      return error(response, 400, "Choose an image smaller than 1 MB.");
    }
    if (body.avatarChoice === "image" && !imageData) {
      return error(response, 400, "Choose an image for this profile icon.");
    }
    const existingProfile = await database.prepare("SELECT profile_json FROM users WHERE email = ?").get(user.email);
    const profile = existingProfile?.profile_json ? JSON.parse(existingProfile.profile_json) : {};
    profile.avatarChoice = body.avatarChoice;
    profile.imageData = body.avatarChoice === "image" ? imageData : "";
    await database.prepare("UPDATE users SET profile_json = ?, updated_at = ? WHERE email = ?")
      .run(JSON.stringify(profile), Date.now(), user.email);
    return json(response, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/api/stats") {
    const stats = await database.prepare(`
      SELECT
        SUM(CASE WHEN archived_at IS NULL AND status != 'Resolved' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN archived_at IS NULL AND status = 'Resolved' THEN 1 ELSE 0 END) AS resolved_count,
        (SELECT COUNT(*) FROM votes JOIN issues ON issues.id = votes.issue_id WHERE issues.archived_at IS NULL) AS vote_count
      FROM issues
    `).get();
    return json(response, 200, {
      open: stats.open_count || 0,
      resolved: stats.resolved_count || 0,
      votes: stats.vote_count || 0,
    });
  }

  if (method === "GET" && pathname === "/api/my/issues") {
    if (user.role !== "student") return error(response, 403, "Only students can view their submitted issues.");
    const rows = await database.prepare(`
      SELECT * FROM issues WHERE author_email = ? ORDER BY created_at DESC
    `).all(user.email);
    return json(response, 200, await Promise.all(rows.map((row) => mapIssue(row, user, Boolean(row.archived_at)))));
  }

  if (method === "GET" && pathname === "/api/issues") {
    const portal = searchParams.get("portal");
    if (!canAccessPortal(user, portal)) return error(response, 403, "You cannot access this portal.");
    const rows = await database.prepare(`
      SELECT * FROM issues WHERE portal = ? AND archived_at IS NULL ORDER BY created_at DESC
    `).all(portal);
    return json(response, 200, await Promise.all(rows.map((row) => mapIssue(row, user))));
  }

  if (method === "POST" && pathname === "/api/issues") {
    if (user.role !== "student") return error(response, 403, "Only students can post issues.");
    const body = await readJson(request);
    if (!canAccessPortal(user, body.portal)) return error(response, 403, "You cannot post in this portal.");
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const category = typeof body.category === "string" ? body.category : "";
    if (!title || title.length > 100 || !description || description.length > 1_200) {
      return error(response, 400, "Enter an issue title (up to 100 characters) and description (up to 1,200 characters).");
    }
    if (!["Academic", "Facilities", "Safety", "Wellbeing", "Other"].includes(category)) {
      return error(response, 400, "Select a valid issue category.");
    }
    const evidence = validateEvidence(body.evidence);
    const now = Date.now();
    const result = await database.prepare(`
      INSERT INTO issues (
        portal, title, category, description, author, author_email, created_at, status, evidence_json, responses_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', ?, '[]')
    `).run(body.portal, title, category, description, user.name, user.email, now, evidence ? JSON.stringify(evidence) : null);
    await database.prepare("INSERT INTO votes (issue_id, email, created_at) VALUES (?, ?, ?)").run(result.lastInsertRowid, user.email, now);
    const row = await database.prepare("SELECT * FROM issues WHERE id = ?").get(result.lastInsertRowid);
    return json(response, 201, await mapIssue(row, user));
  }

  const issueMatch = pathname.match(/^\/api\/issues\/(\d+)(?:\/(vote|status|responses|archive))?$/);
  if (issueMatch) {
    const issueId = Number(issueMatch[1]);
    const action = issueMatch[2] || "";
    const issue = await database.prepare("SELECT * FROM issues WHERE id = ?").get(issueId);
    if (!issue) return error(response, 404, "Issue not found.");
    if (issue.archived_at && action !== "archive") return error(response, 404, "Issue is in the archive.");
    if (!canAccessPortal(user, issue.portal)) return error(response, 403, "You cannot access this issue.");

    if (method === "POST" && action === "vote") {
      if (user.role !== "student") return error(response, 403, "Only students can vote.");
      if (issue.status === "Resolved") return error(response, 409, "Resolved issues are closed for voting.");
      const existingVote = await database.prepare("SELECT 1 FROM votes WHERE issue_id = ? AND email = ?").get(issueId, user.email);
      if (existingVote) {
        await database.prepare("DELETE FROM votes WHERE issue_id = ? AND email = ?").run(issueId, user.email);
      } else {
        await database.prepare("INSERT INTO votes (issue_id, email, created_at) VALUES (?, ?, ?)").run(issueId, user.email, Date.now());
      }
      return json(response, 200, await mapIssue(issue, user));
    }

    if (method === "PATCH" && action === "status") {
      if (user.role !== "faculty" && user.role !== "developer") return error(response, 403, "Faculty access is required.");
      const body = await readJson(request);
      if (!["Open", "In review", "Resolved"].includes(body.status)) return error(response, 400, "Invalid issue status.");
      await database.prepare("UPDATE issues SET status = ? WHERE id = ? AND archived_at IS NULL").run(body.status, issueId);
      return json(response, 200, await mapIssue(await database.prepare("SELECT * FROM issues WHERE id = ?").get(issueId), user));
    }

    if (method === "POST" && action === "responses") {
      if (user.role !== "faculty" && user.role !== "developer") return error(response, 403, "Faculty access is required.");
      const body = await readJson(request);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 500) return error(response, 400, "Faculty updates must be between 1 and 500 characters.");
      const responses = JSON.parse(issue.responses_json);
      responses.push({ author: user.name, text, createdAt: Date.now() });
      await database.prepare(`
        UPDATE issues SET responses_json = ?, status = CASE WHEN status = 'Open' THEN 'In review' ELSE status END
        WHERE id = ? AND archived_at IS NULL
      `).run(JSON.stringify(responses), issueId);
      return json(response, 200, await mapIssue(await database.prepare("SELECT * FROM issues WHERE id = ?").get(issueId), user));
    }

    if (method === "POST" && action === "archive") {
      if (user.role !== "faculty" && user.role !== "developer") return error(response, 403, "Faculty access is required.");
      if (issue.status !== "Resolved") return error(response, 409, "Only resolved issues can be archived.");
      await database.prepare("UPDATE issues SET archived_at = ?, archived_by = ? WHERE id = ? AND archived_at IS NULL")
        .run(Date.now(), user.name, issueId);
      return json(response, 200, { ok: true });
    }
  }

  if (method === "GET" && pathname === "/api/archive") {
    if (user.role !== "faculty" && user.role !== "developer") return error(response, 403, "Faculty access is required.");
    const rows = await database.prepare("SELECT * FROM issues WHERE archived_at IS NOT NULL ORDER BY archived_at DESC").all();
    return json(response, 200, await Promise.all(rows.map((row) => mapIssue(row, user, true))));
  }

  const restoreMatch = pathname.match(/^\/api\/archive\/(\d+)\/restore$/);
  if (method === "POST" && restoreMatch) {
    if (user.role !== "faculty" && user.role !== "developer") return error(response, 403, "Faculty access is required.");
    const issueId = Number(restoreMatch[1]);
    const result = await database.prepare(`
      UPDATE issues SET archived_at = NULL, archived_by = NULL
      WHERE id = ? AND archived_at IS NOT NULL
    `).run(issueId);
    if (result.changes === 0) return error(response, 404, "Archived issue not found.");
    return json(response, 200, { ok: true });
  }

  return error(response, 404, "API endpoint not found.");
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);
const publicFiles = new Set(["index.html", "student-voice-campus.jpeg"]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return error(response, 405, "Method not allowed.");
    }
    const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    if (!publicFiles.has(relativePath)) return error(response, 404, "File not found.");
    const filePath = resolve(root, normalize(relativePath));
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      return error(response, 403, "Path is not available.");
    }
    if (relativePath === "index.html") {
      const nonce = randomBytes(18).toString("base64");
      const html = (await readFile(filePath, "utf8")).replace(
        /<(script|style)(?=[\s>])/gi,
        `<$1 nonce="${nonce}"`,
      );
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com; img-src 'self' data: https://lh3.googleusercontent.com; media-src 'self' data:; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/`,
      });
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }
    const file = createReadStream(filePath);
    file.on("error", (fileError) => {
      if (!response.headersSent) {
        error(response, fileError.code === "ENOENT" ? 404 : 500, "File could not be served.");
      } else {
        response.destroy(fileError);
      }
    });
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
    if (request.method === "HEAD") {
      file.destroy();
      response.end();
    } else {
      file.pipe(response);
    }
  } catch (cause) {
    const status = Number.isInteger(cause.statusCode) ? cause.statusCode : 500;
    if (status >= 500) console.error(cause);
    error(response, status, status >= 500 ? "The server could not complete the request." : cause.message);
  }
});

const host = process.env.HOST || (isProduction ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port.");
}
server.listen(port, host, () => {
  console.log(`Student Voice is listening on ${host}:${port}`);
  if (!clientId) console.warn("Google sign-in is disabled until GOOGLE_CLIENT_ID is configured.");
  if (!mailer) console.warn("Student email OTP is disabled until SMTP settings are configured.");
  if (adminEmails.size === 0) console.warn("No developer administrator is configured; set ADMIN_EMAILS.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      database.close();
      process.exit(0);
    });
  });
}
