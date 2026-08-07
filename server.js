const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'Backend is alive! 🎉' });
});

app.post('/generate-caption', async (req, res) => {
  try {
    const { businessDescription } = req.body;

    if (!businessDescription) {
      return res.status(400).json({ error: 'businessDescription is required' });
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are a social media expert. Generate a short, engaging Instagram caption with 3-5 relevant hashtags for the given business.'
          },
          {
            role: 'user',
            content: businessDescription
          }
        ]
      })
    });

    const data = await response.json();
    const caption = data.choices[0].message.content;

    const docRef = await db.collection('posts').add({
      businessDescription,
      caption,
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({ id: docRef.id, caption });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong generating the caption' });
  }
});

app.get('/posts', async (req, res) => {
  try {
    const snapshot = await db.collection('posts').orderBy('createdAt', 'desc').get();
    const posts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ posts });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong fetching posts' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});