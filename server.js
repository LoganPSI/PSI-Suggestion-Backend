const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const bcrypt = require('bcrypt');
const session = require('express-session');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const LOGO_PATH = path.join(__dirname, 'public', 'psi-group-logo.png');

// Render provides DATABASE_URL automatically when you link a Postgres database
// to this web service.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
});

// The owner account. It can never be removed, so the dashboard can't be
// locked out by accident. Everyone else is added in "Manage access".
const OWNER_EMAIL = (process.env.ADMIN_EMAIL || 'logan.t@psigroup.net.au').toLowerCase();
const REPORT_RECIPIENTS = ['greg.t@psigroup.net.au', 'logan.t@psigroup.net.au'];

// Email transport — sends via the Gmail account set up with an app password
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

const QUESTION_LABELS = [
  "Workplace improvements",
  "Customer experience",
  "Safety",
  "Tools & equipment"
];

function fmtDateForFilename(d) {
  return d.toISOString().slice(0, 10);
}

function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

// Builds a PDF (as a Buffer) for a list of submissions. Used for the weekly
// report, the "generate instant report" button, and single-entry safety alerts.
function buildReportPdf({ title, subtitle, entries }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 20, left: 48, right: 48 }, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      doc.image(LOGO_PATH, 48, 44, { width: 170 });
    } catch (e) { /* logo missing — continue without it */ }

    doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold')
      .text(title, 48, 110);
    doc.fontSize(10).fillColor('#6B7280').font('Helvetica')
      .text(subtitle, 48, 132);

    doc.moveTo(48, 156).lineTo(547, 156).strokeColor('#DCE6F6').stroke();
    doc.moveDown(2);
    let y = 168;

    if (entries.length === 0) {
      doc.fontSize(11).fillColor('#6B7280').font('Helvetica-Oblique')
        .text('No suggestions were submitted in this period.', 48, y);
    }

    entries.forEach((e, idx) => {
      if (y > 740) { doc.addPage(); y = 56; }
      const dateStr = new Date(e.submitted_at).toLocaleString('en-AU', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      doc.fontSize(11.5).fillColor('#000000').font('Helvetica-Bold')
        .text(`${idx + 1}. ${e.name}`, 48, y, { continued: false });
      doc.fontSize(9).fillColor('#6B7280').font('Helvetica')
        .text(dateStr, 400, y, { width: 147, align: 'right' });
      y += 18;

      const qas = [];
      [e.q1, e.q2, e.q3, e.q4].forEach((answer, i) => {
        if (answer && answer.trim()) qas.push([QUESTION_LABELS[i], answer]);
      });
      if (e.other && e.other.trim()) qas.push(['Other suggestions', e.other]);
      if (qas.length === 0) qas.push([null, 'No details provided.']);

      qas.forEach(([label, answer]) => {
        if (y > 740) { doc.addPage(); y = 56; }
        if (label) {
          doc.fontSize(9.5).fillColor('#174EA2').font('Helvetica-Bold').text(label, 48, y);
          y += 13;
        }
        doc.fontSize(10).fillColor('#12203A').font('Helvetica');
        const height = doc.heightOfString(answer, { width: 499 });
        doc.text(answer, 48, y, { width: 499 });
        y += height + 8;
      });
      y += 10;
      doc.moveTo(48, y).lineTo(547, y).strokeColor('#EEF2F7').stroke();
      y += 16;
    });

    addWatermarkToAllPages(doc);
    doc.end();
  });
}

function addWatermarkToAllPages(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const pageHeight = doc.page.height;
    const pageWidth = doc.page.width;
    doc.fontSize(7.5).fillColor('#9AA6B5').font('Helvetica')
      .text('PSI GROUP  ·  SPEED  ·  QUALITY  ·  KNOWLEDGE', 0, pageHeight - 34, {
        width: pageWidth, align: 'center'
      });
  }
}

async function sendReportEmail({ to, subject, bodyText, pdfBuffer, filename }) {
  await transporter.sendMail({
    from: `"PSI Suggestion Box" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text: bodyText,
    attachments: [{ filename, content: pdfBuffer }]
  });
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Render terminates HTTPS in front of the app, so trust its proxy headers —
// needed for secure cookies and for building links back to this site.
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// SESSIONS — stored in Postgres so sign-ins survive deploys and spin-downs
// ============================================
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_SECRET = process.env.SESSION_SECRET
  || (process.env.DATABASE_URL && crypto.createHash('sha256').update('psi-suggestions:' + process.env.DATABASE_URL).digest('hex'))
  || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set; deriving one from DATABASE_URL. Set SESSION_SECRET in Render for a proper secret.');
}

const sessionExpiry = sess => new Date(
  (sess && sess.cookie && sess.cookie.expires) ? sess.cookie.expires : Date.now() + SESSION_TTL_MS
);

class PgSessionStore extends session.Store {
  async get(sid, cb) {
    try {
      const r = await pool.query('SELECT sess FROM user_sessions WHERE sid = $1 AND expire > NOW()', [sid]);
      cb(null, r.rows.length ? r.rows[0].sess : null);
    } catch (e) {
      console.error('Session read failed:', e.message);
      cb(null, null);
    }
  }
  async set(sid, sess, cb) {
    try {
      await pool.query(
        `INSERT INTO user_sessions (sid, sess, expire) VALUES ($1, $2, $3)
         ON CONFLICT (sid) DO UPDATE SET sess = $2, expire = $3`,
        [sid, sess, sessionExpiry(sess)]
      );
      cb && cb(null);
    } catch (e) { console.error('Session write failed:', e.message); cb && cb(e); }
  }
  async destroy(sid, cb) {
    try { await pool.query('DELETE FROM user_sessions WHERE sid = $1', [sid]); cb && cb(null); }
    catch (e) { cb && cb(e); }
  }
  async touch(sid, sess, cb) {
    try { await pool.query('UPDATE user_sessions SET expire = $2 WHERE sid = $1', [sid, sessionExpiry(sess)]); cb && cb(null); }
    catch (e) { cb && cb(null); }
  }
}

app.use(session({
  store: new PgSessionStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: SESSION_TTL_MS, httpOnly: true, sameSite: 'lax', secure: !!process.env.RENDER },
}));

// Create the tables on startup if they don't already exist
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      q1 TEXT,
      q2 TEXT,
      q3 TEXT,
      q4 TEXT,
      other TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR(255) PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire)');
  await pool.query('DELETE FROM user_sessions WHERE expire < NOW()');

  // Who can see the dashboard. A row with approved = TRUE and no password is an
  // invite: that person sets their own password the first time they sign in.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT,
      approved BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    );
  `);
  await pool.query(
    `INSERT INTO dashboard_users (email, name, approved) VALUES ($1, 'Logan', TRUE)
     ON CONFLICT (email) DO UPDATE SET approved = TRUE`,
    [OWNER_EMAIL]
  );
  console.log('Database ready.');
}
initDb().catch(err => console.error('Failed to set up database:', err));

// ============================================
// AUTH
// ============================================
const normEmail = e => String(e || '').toLowerCase().trim();

// Looks the user up on every request rather than trusting the session alone,
// so removing someone in "Manage access" locks them out straight away.
async function loadUser(req) {
  if (!req.session || !req.session.userId) return null;
  const r = await pool.query('SELECT * FROM dashboard_users WHERE id = $1', [req.session.userId]);
  const user = r.rows[0];
  if (!user || !user.approved || !user.password_hash) return null;
  return user;
}

async function requireAuth(req, res, next) {
  try {
    const user = await loadUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    req.user = user;
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not check sign-in.' }); }
}

const publicUser = u => ({
  email: u.email, name: u.name
});

function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.save(e => e ? reject(e) : resolve());
    });
  });
}

const siteUrl = req => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

async function adminEmails() {
  const r = await pool.query('SELECT email FROM dashboard_users WHERE approved AND password_hash IS NOT NULL');
  return r.rows.map(x => x.email);
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const password = req.body.password || '';
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });

    const r = await pool.query('SELECT * FROM dashboard_users WHERE email = $1', [email]);
    const user = r.rows[0];
    if (user && user.approved && !user.password_hash) {
      return res.status(409).json({ error: "You've been given access but haven't set a password yet — use \"First time here?\" below.", needsSetup: true });
    }
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    if (!user.approved) return res.status(403).json({ error: 'Your access request is waiting for approval.' });

    await startSession(req, user);
    await pool.query('UPDATE dashboard_users SET last_login_at = now() WHERE id = $1', [user.id]);
    res.json({ ok: true, user: publicUser(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Sign-in failed.' }); }
});

// First-time setup. If an admin has already added this email, the person sets
// a password and goes straight in. Anyone else becomes a pending request that
// an admin has to approve.
app.post('/api/auth/register', async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const name = String(req.body.name || '').trim();
    const password = req.body.password || '';
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and a password.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query('SELECT * FROM dashboard_users WHERE email = $1', [email]);
    const existing = r.rows[0];

    if (existing && existing.password_hash) {
      return res.status(400).json({ error: 'That email already has an account — sign in instead, or ask an admin to reset it.' });
    }

    if (existing && existing.approved) {
      const u = await pool.query(
        'UPDATE dashboard_users SET password_hash = $1, name = COALESCE(NULLIF($2, \'\'), name), last_login_at = now() WHERE id = $3 RETURNING *',
        [hash, name, existing.id]
      );
      await startSession(req, u.rows[0]);
      return res.json({ ok: true, user: publicUser(u.rows[0]) });
    }

    if (existing) {
      await pool.query('UPDATE dashboard_users SET password_hash = $1, name = COALESCE(NULLIF($2, \'\'), name) WHERE id = $3', [hash, name, existing.id]);
    } else {
      await pool.query('INSERT INTO dashboard_users (email, name, password_hash) VALUES ($1, $2, $3)', [email, name || email.split('@')[0], hash]);
    }

    res.json({ ok: true, pending: true, message: "Request sent. You'll be able to sign in once an admin approves it." });

    try {
      await transporter.sendMail({
        from: `"PSI Suggestion Box" <${process.env.GMAIL_USER}>`,
        to: await adminEmails(),
        subject: `Suggestion dashboard access request: ${name || email}`,
        html: `<p><strong>${escHtml(name || 'Someone')}</strong> (${escHtml(email)}) has asked for access to the suggestion box dashboard.</p>
               <p>Approve or decline it under <strong>Manage access</strong>: <a href="${siteUrl(req)}/dashboard.html">${siteUrl(req)}/dashboard.html</a></p>`
      });
    } catch (err) { console.error('Could not send access request email:', err.message); }
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not create your account.' }); }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await loadUser(req);
    res.json(user ? { authenticated: true, user: publicUser(user) } : { authenticated: false });
  } catch (e) { res.json({ authenticated: false }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ============================================
// ADMIN — manage who can see the dashboard
// ============================================
async function endSessionsFor(userId) {
  await pool.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [userId]);
}

app.get('/api/admin/users', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, email, name, approved, (password_hash IS NOT NULL) AS has_password, created_at, last_login_at
      FROM dashboard_users ORDER BY approved, lower(name)`);
    res.json(r.rows.map(u => ({ ...u, is_owner: u.email === OWNER_EMAIL })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load users.' }); }
});

// Give someone access. They get an email telling them to set a password.
app.post('/api/admin/users', requireAuth, async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const name = String(req.body.name || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

    const r = await pool.query(
      `INSERT INTO dashboard_users (email, name, approved) VALUES ($1, $2, TRUE)
       ON CONFLICT (email) DO UPDATE SET approved = TRUE, name = COALESCE(NULLIF($2, ''), dashboard_users.name)
       RETURNING *`,
      [email, name || email.split('@')[0]]
    );
    res.json({ ok: true });

    try {
      const url = `${siteUrl(req)}/dashboard.html`;
      await transporter.sendMail({
        from: `"PSI Suggestion Box" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: 'You have access to the PSI suggestion box dashboard',
        html: `<p>Hi ${escHtml(r.rows[0].name)},</p>
               <p>${escHtml(req.user.name || req.user.email)} has given you access to the PSI suggestion box dashboard.</p>
               <p>${r.rows[0].password_hash ? 'Sign in' : 'Open the link below, choose <strong>First time here?</strong> and set a password'}: <a href="${url}">${url}</a></p>`
      });
    } catch (err) { console.error('Could not send invite email:', err.message); }
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not add user.' }); }
});

app.post('/api/admin/users/:id/approve', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('UPDATE dashboard_users SET approved = TRUE WHERE id = $1 RETURNING *', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found.' });
    res.json({ ok: true });

    try {
      const url = `${siteUrl(req)}/dashboard.html`;
      await transporter.sendMail({
        from: `"PSI Suggestion Box" <${process.env.GMAIL_USER}>`,
        to: r.rows[0].email,
        subject: 'Your suggestion dashboard access was approved',
        html: `<p>Hi ${escHtml(r.rows[0].name)},</p><p>Your access has been approved. Sign in here: <a href="${url}">${url}</a></p>`
      });
    } catch (err) { console.error('Could not send approval email:', err.message); }
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not approve user.' }); }
});

// Clears their password and signs them out. They set a new one via "First time here?".
app.post('/api/admin/users/:id/reset-password', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('UPDATE dashboard_users SET password_hash = NULL WHERE id = $1 AND approved RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found.' });
    await endSessionsFor(r.rows[0].id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not reset password.' }); }
});

// Removes access completely (also used to decline a pending request).
app.delete('/api/admin/users/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, email FROM dashboard_users WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found.' });
    if (r.rows[0].email === OWNER_EMAIL) return res.status(400).json({ error: "The owner account can't be removed." });
    if (r.rows[0].id === req.user.id) return res.status(400).json({ error: "You can't remove yourself." });
    await endSessionsFor(r.rows[0].id);
    await pool.query('DELETE FROM dashboard_users WHERE id = $1', [r.rows[0].id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not remove user.' }); }
});

// Submit a new suggestion (public — anyone with the form link can post)
app.post('/api/submit', async (req, res) => {
  try {
    const { name, q1, q2, q3, q4, other } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (![q1, q2, q3, q4, other].some(v => v && v.trim())) {
      return res.status(400).json({ error: 'Please fill in at least one suggestion.' });
    }
    const result = await pool.query(
      `INSERT INTO submissions (name, q1, q2, q3, q4, other) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name.trim(), q1 || '', q2 || '', q3 || '', q4 || '', other || '']
    );
    const entry = result.rows[0];
    res.json({ ok: true });

    // Fire off an immediate alert if a safety suggestion was included —
    // this happens after responding to the user so it never slows down their submit.
    if (q3 && q3.trim()) {
      try {
        const pdfBuffer = await buildReportPdf({
          title: 'URGENT — Safety Suggestion Submitted',
          subtitle: `Submitted ${new Date(entry.submitted_at).toLocaleString('en-AU')}`,
          entries: [entry]
        });
        const filename = `PSI-URGENT-Safety-${entry.name.replace(/[^a-zA-Z0-9]+/g, '-')}-${fmtDateForFilename(new Date(entry.submitted_at))}.pdf`;
        await sendReportEmail({
          to: REPORT_RECIPIENTS,
          subject: `URGENT: Safety suggestion from ${entry.name}`,
          bodyText: `A safety-related suggestion has just been submitted by ${entry.name}. See the attached PDF for full details. This was sent immediately due to being flagged under Safety.`,
          pdfBuffer,
          filename
        });
        console.log('Safety alert email sent for submission', entry.id);
      } catch (err) {
        console.error('Failed to send safety alert email:', err);
      }
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong saving your suggestion.' });
  }
});

// Fetch all suggestions — signed-in, approved dashboard users only
app.get('/api/submissions', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM submissions ORDER BY submitted_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load submissions.' });
  }
});

async function runWeeklyReport() {
  const now = new Date();
  const thisWeekStart = startOfWeek(now);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = thisWeekStart; // exclusive

  const result = await pool.query(
    `SELECT * FROM submissions WHERE submitted_at >= $1 AND submitted_at < $2 ORDER BY submitted_at ASC`,
    [lastWeekStart, lastWeekEnd]
  );
  const entries = result.rows;

  const fmt = (d) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  const subtitle = `${fmt(lastWeekStart)} – ${fmt(new Date(lastWeekEnd.getTime() - 86400000))} (${entries.length} submission${entries.length === 1 ? '' : 's'})`;

  const pdfBuffer = await buildReportPdf({
    title: 'Weekly Suggestion Report',
    subtitle,
    entries
  });
  const filename = `PSI-Suggestions-Weekly-${fmtDateForFilename(lastWeekStart)}.pdf`;

  await sendReportEmail({
    to: REPORT_RECIPIENTS,
    subject: `PSI Weekly Suggestion Report — ${subtitle}`,
    bodyText: `Attached is the automatic weekly suggestion report covering ${subtitle}.`,
    pdfBuffer,
    filename
  });
  console.log(`Weekly report sent — ${entries.length} submissions.`);
}

// Runs automatically every Monday at 6:00am (server time)
cron.schedule('0 6 * * 1', () => {
  runWeeklyReport().catch(err => console.error('Weekly report failed:', err));
});

// Manual trigger for testing — protected by a secret so randoms can't spam it
app.post('/api/reports/send-weekly-now', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Not authorized.' });
  }
  try {
    await runWeeklyReport();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send weekly report.' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
