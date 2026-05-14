const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Health Check
app.get('/', (req, res) => res.json({ status: 'ok' }));

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

// ====== NOTION — Lesen ======
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

// ====== NOTION — ToDo erstellen ======
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
