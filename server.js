const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Render provides DATABASE_URL automatically when you link a Postgres database
// to this web service. DASHBOARD_PASSCODE is one you set yourself.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DASHBOARD_PASSCODE = process.env.DASHBOARD_PASSCODE || 'psi2026';

app.use(express.json());
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
    await pool.query(
      `INSERT INTO submissions (name, q1, q2, q3, q4, other) VALUES ($1,$2,$3,$4,$5,$6)`,
      [name.trim(), q1 || '', q2 || '', q3 || '', q4 || '', other || '']
    );
    res.json({ ok: true });
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
