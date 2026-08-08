const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore();
const auth = getAuth();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Middleware: verify the user's login token on every protected request
async function verifyUser(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No auth token provided' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    req.userId = decodedToken.uid;
    next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.get('/', (req, res) => {
  res.json({ message: 'Backend is alive! 🎉' });
});

// Generate a caption AND save it, tagged to the logged-in user
app.post('/generate-caption', verifyUser, async (req, res) => {
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
      userId: req.userId,
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({ id: docRef.id, caption });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong generating the caption' });
  }
});

// Get only the logged-in user's posts
app.get('/posts', verifyUser, async (req, res) => {
  try {
    const snapshot = await db.collection('posts')
      .where('userId', '==', req.userId)
      .orderBy('createdAt', 'desc')
      .get();

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