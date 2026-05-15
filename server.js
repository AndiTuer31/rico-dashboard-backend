const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Google OAuth Config
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'https://rico-dashboard-backend.onrender.com/google-callback';

// Refresh Token im Memory speichern (bleibt solange Server läuft)
let storedRefreshToken = null;
let storedAccessToken = null;
let tokenExpiry = null;

// Health Check
app.get('/', (req, res) => res.json({ status: 'ok' }));

// ====== GOOGLE AUTH — Login starten ======
app.get('/google-login', (req, res) => {
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent('https://www.googleapis.com/auth/calendar')}&` +
    `access_type=offline&` +
    `prompt=consent`;
  res.redirect(authUrl);
});

// ====== GOOGLE CALLBACK — Token speichern ======
app.get('/google-callback', async (req, res) => {
  const { code } = req.query;
  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });

    storedRefreshToken = response.data.refresh_token;
    storedAccessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000);

    // Zurück zur App
    res.redirect('https://rico-dashboard-app.web.app?calendar=connected');
  } catch (e) {
    console.error('Auth Fehler:', e.response?.data || e.message);
    res.status(500).send('Auth fehlgeschlagen');
  }
});

// ====== ACCESS TOKEN ERNEUERN ======
async function getValidAccessToken() {
  // Token noch gültig?
  if (storedAccessToken && tokenExpiry && Date.now() < tokenExpiry - 60000) {
    return storedAccessToken;
  }

  // Neu holen mit Refresh Token
  if (!storedRefreshToken) return null;

  const response = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: storedRefreshToken,
    grant_type: 'refresh_token'
  });

  storedAccessToken = response.data.access_token;
  tokenExpiry = Date.now() + (response.data.expires_in * 1000);
  return storedAccessToken;
}

// ====== CALENDAR STATUS ======
app.get('/calendar-status', (req, res) => {
  res.json({ connected: !!storedRefreshToken });
});

// ====== CALENDAR EVENTS LESEN ======
app.get('/calendar-events', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    if (!token) { res.status(401).json({ error: 'Nicht verbunden' }); return; }

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

    const response = await axios.get(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${start}&timeMax=${end}&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ====== CALENDAR EVENT ERSTELLEN ======
app.post('/calendar-create', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    if (!token) { res.status(401).json({ error: 'Nicht verbunden' }); return; }

    const { title, date, startTime, endTime } = req.body;
    const start = new Date(`${date}T${startTime}:00`);
    const end = new Date(`${date}T${endTime}:00`);

    const response = await axios.post(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      { summary: title, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ====== ANTHROPIC ======
app.post('/anthropic', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      req.body,
      { headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }}
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ====== NOTION LESEN ======
app.post('/notion', async (req, res) => {
  try {
    const { databaseId, filter, sorts, page_size } = req.body;
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      { filter, sorts, page_size },
      { headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28'
      }}
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ====== NOTION TODO ERSTELLEN ======
app.post('/notion-create', async (req, res) => {
  try {
    const { databaseId, title } = req.body;
    const response = await axios.post(
      'https://api.notion.com/v1/pages',
      {
        parent: { database_id: databaseId },
        properties: {
          'Task name': { title: [{ text: { content: title } }] },
          'Status': { status: { name: 'Not started' } }
        }
      },
      { headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28'
      }}
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ====== NEWS ======
app.get('/news', async (req, res) => {
  try {
    const response = await axios.get(
      'https://newsapi.org/v2/everything?q=Schweiz+OR+Fussball+OR+Reisen&language=de&sortBy=publishedAt&pageSize=5',
      { headers: { 'X-Api-Key': process.env.NEWS_KEY }}
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));