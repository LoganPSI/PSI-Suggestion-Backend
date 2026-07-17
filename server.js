const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const LOGO_PATH = path.join(__dirname, 'public', 'logo.png');

// Render provides DATABASE_URL automatically when you link a Postgres database
// to this web service. DASHBOARD_PASSCODE is one you set yourself.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DASHBOARD_PASSCODE = process.env.DASHBOARD_PASSCODE || 'psi2026';
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
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      doc.image(LOGO_PATH, 48, 40, { width: 130 });
    } catch (e) { /* logo missing — continue without it */ }

    doc.fontSize(16).fillColor('#013165').font('Helvetica-Bold')
      .text(title, 48, 110);
    doc.fontSize(10).fillColor('#6B7280').font('Helvetica')
      .text(subtitle, 48, 132);

    doc.moveTo(48, 156).lineTo(547, 156).strokeColor('#EAF2FC').stroke();
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
      doc.fontSize(11.5).fillColor('#013165').font('Helvetica-Bold')
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
          doc.fontSize(9.5).fillColor('#014BA4').font('Helvetica-Bold').text(label, 48, y);
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

    doc.end();
  });
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

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-passcode, x-cron-secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Create the table on startup if it doesn't already exist
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
  console.log('Database ready.');
}
initDb().catch(err => console.error('Failed to set up database:', err));

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

// Fetch all suggestions — protected by a simple passcode header
app.get('/api/submissions', async (req, res) => {
  const passcode = req.headers['x-passcode'];
  if (passcode !== DASHBOARD_PASSCODE) {
    return res.status(401).json({ error: 'Incorrect passcode.' });
  }
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
