const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ====== UPSTASH REDIS ======
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisSet(key, value) {
  await axios.post(`${REDIS_URL}/set/${key}`, { value }, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
}

async function redisGet(key) {
  try {
    const res = await axios.get(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    let result = res.data.result;
    
    // Falls result ein String ist der wie JSON aussieht → parsen
    if (typeof result === 'string' && result.startsWith('{')) {
      try {
        const parsed = JSON.parse(result);
        if (parsed.value) return parsed.value;
      } catch(e) {}
    }
    
    // Falls result direkt ein Objekt ist
    if (result && typeof result === 'object' && result.value) {
      return result.value;
    }
    
    return result;
  } catch (e) { return null; }
}


// Google OAuth Config
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'https://rico-dashboard-backend.onrender.com/google-callback';

let cachedAccessToken = null;
let tokenExpiry = null;

app.get('/', (req, res) => res.json({ status: 'ok' }));

// ====== GOOGLE AUTH ======
app.get('/google-login', (req, res) => {
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent('https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.readonly')}&` +
    `access_type=offline&prompt=consent`;
  res.redirect(authUrl);
});

app.get('/google-callback', async (req, res) => {
  const { code } = req.query;
  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI, grant_type: 'authorization_code'
    });
    if (response.data.refresh_token) {
      await redisSet('google_refresh_token', response.data.refresh_token);
    }
    cachedAccessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000);
    res.redirect('https://rico-dashboard-app.web.app?calendar=connected');
  } catch (e) {
    res.status(500).send('Auth fehlgeschlagen');
  }
});

async function getValidAccessToken() {
  if (cachedAccessToken && tokenExpiry && Date.now() < tokenExpiry - 60000) return cachedAccessToken;
  const refreshToken = await redisGet('google_refresh_token');
  if (!refreshToken) return null;
  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: 'refresh_token'
    });
    cachedAccessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000);
    return cachedAccessToken;
  } catch (e) { return null; }
}

app.get('/calendar-status', async (req, res) => {
  const token = await redisGet('google_refresh_token');
  res.json({ connected: !!token });
});

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
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

app.post('/calendar-create', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    if (!token) { res.status(401).json({ error: 'Nicht verbunden' }); return; }
    const { title, date, startTime, endTime } = req.body;
    const response = await axios.post(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      { summary: title, start: { dateTime: new Date(`${date}T${startTime}:00`).toISOString() }, end: { dateTime: new Date(`${date}T${endTime}:00`).toISOString() } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// ====== ANTHROPIC ======
app.post('/anthropic', async (req, res) => {
  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', req.body, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
    });
    res.json(response.data);
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// ====== NOTION LESEN ======
app.post('/notion', async (req, res) => {
  try {
    const { databaseId, filter, sorts, page_size } = req.body;
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      { filter, sorts, page_size },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' } }
    );
    res.json(response.data);
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// ====== NOTION TODO ERSTELLEN ======
app.post('/notion-create', async (req, res) => {
  try {
    const { databaseId, title } = req.body;
    const response = await axios.post('https://api.notion.com/v1/pages', {
      parent: { database_id: databaseId },
      properties: {
        'Task name': { title: [{ text: { content: title } }] },
        'Status': { status: { name: 'Not started' } }
      }
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' } });
    res.json(response.data);
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// ====== NOTION TODO ABHAKEN ======
app.post('/notion-complete', async (req, res) => {
  try {
    const { pageId } = req.body;
    const response = await axios.patch(
      `https://api.notion.com/v1/pages/${pageId}`,
      { properties: { 'Status': { status: { name: 'Done' } } } },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' } }
    );
    res.json(response.data);
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// ====== SRF NEWS via RSS ======
app.get('/news', async (req, res) => {
  try {
    // SRF RSS Feed — läuft über Backend, kein CORS Problem
    const rssResponse = await axios.get('https://www.srf.ch/news/bnf/rss/1646', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    // RSS XML parsen
    const xml = rssResponse.data;
    const items = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

    for (const match of itemMatches) {
      const item = match[1];

      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                         item.match(/<title>(.*?)<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/) ||
                        item.match(/<guid>(.*?)<\/guid>/);
      const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                        item.match(/<description>(.*?)<\/description>/);

      if (titleMatch) {
        items.push({
          title: titleMatch[1].trim(),
          url: linkMatch ? linkMatch[1].trim() : '',
          description: descMatch ? descMatch[1].replace(/<[^>]*>/g, '').trim().slice(0, 100) : ''
        });
      }

      if (items.length >= 5) break;
    }

    res.json({ articles: items });
  } catch (e) {
    console.error('SRF News Fehler:', e.message);
    // Fallback auf NewsAPI
    try {
      const response = await axios.get(
        'https://newsapi.org/v2/everything?q=Schweiz+OR+Fussball&language=de&sortBy=publishedAt&pageSize=5',
        { headers: { 'X-Api-Key': process.env.NEWS_KEY } }
      );
      const articles = response.data.articles.map(a => ({
        title: a.title,
        url: a.url,
        description: a.description?.slice(0, 100) || ''
      }));
      res.json({ articles });
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// ====== GMAIL — Wichtige & Ungelesene Mails ======
app.get('/gmail-important', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    if (!token) { res.status(401).json({ error: 'Nicht verbunden', needsReauth: true }); return; }

    // Ungelesene + wichtige Mails (max 5)
    const listRes = await axios.get(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=IMPORTANT,UNREAD&maxResults=5',
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const messages = listRes.data.messages || [];
    if (!messages.length) { res.json({ emails: [] }); return; }

    // Metadaten für jede Mail laden
    const emails = await Promise.all(messages.map(async (msg) => {
      const detail = await axios.get(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject,From`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const headers = detail.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '(Kein Betreff)';
      const fromFull = headers.find(h => h.name === 'From')?.value || '';
      const fromName = fromFull.replace(/<[^>]+>/g, '').trim().replace(/"/g, '') || fromFull.split('@')[0];
      return {
        id: msg.id,
        subject: subject.slice(0, 70),
        from: fromName.slice(0, 35),
        snippet: (detail.data.snippet || '').slice(0, 90),
        url: `https://mail.google.com/mail/#inbox/${msg.id}`
      };
    }));

    res.json({ emails });
  } catch (e) {
    if (e.response?.status === 403) {
      res.json({ emails: [], needsReauth: true });
    } else {
      res.status(500).json({ error: e.response?.data || e.message });
    }
  }
});

// ====== DEBUG (temporär) ======
app.get('/debug-token', async (req, res) => {
  const refreshToken = await redisGet('google_refresh_token');
  if (!refreshToken) { res.json({ error: 'Kein Refresh Token in Redis' }); return; }
  
  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    res.json({ success: true, tokenType: response.data.token_type, expiresIn: response.data.expires_in });
  } catch (e) {
    res.json({ 
      error: e.response?.data || e.message,
      status: e.response?.status
    });
  }
});


// ====== DEBUG REDIS ======
app.get('/debug-redis', async (req, res) => {
  const refreshToken = await redisGet('google_refresh_token');
  res.json({ 
    tokenType: typeof refreshToken,
    tokenStart: refreshToken ? refreshToken.slice(0, 30) : 'NULL',
    tokenLength: refreshToken ? refreshToken.length : 0
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
