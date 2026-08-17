const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

// Use environment variable if available (production/Render), otherwise use local file (development)
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./serviceAccountKey.json');

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
       model: 'openai/gpt-oss-120b',
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
      published: false,
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

// Analyze sentiment of comments for a specific post
app.post('/analyze-sentiment', verifyUser, async (req, res) => {
  try {
    const { postId, comments } = req.body;

    if (!postId || !comments || !Array.isArray(comments) || comments.length === 0) {
      return res.status(400).json({ error: 'postId and a non-empty comments array are required' });
    }

    const commentsList = comments.map((c, i) => `${i + 1}. ${c}`).join('\n');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
       model: 'openai/gpt-oss-120b',
        messages: [
          {
            role: 'system',
            content: `You are a social media sentiment analyst. Given a list of comments, respond ONLY with valid JSON in this exact format, no other text:
{
  "positive": <count>,
  "neutral": <count>,
  "negative": <count>,
  "summary": "<one sentence summary of overall audience reaction>",
  "suggestion": "<one sentence suggestion for improving future content based on this feedback>"
}`
          },
          {
            role: 'user',
            content: commentsList
          }
        ]
      })
    });

    const data = await response.json();
    let sentimentResult;

    try {
      sentimentResult = JSON.parse(data.choices[0].message.content);
    } catch (parseError) {
      return res.status(500).json({ error: 'Could not parse sentiment analysis result' });
    }

    // Save sentiment result onto the post document
    await db.collection('posts').doc(postId).update({
      sentiment: sentimentResult,
      analyzedCommentsCount: comments.length
    });

    res.json({ sentiment: sentimentResult });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong analyzing sentiment' });
  }
});
// Set or update the scheduled date/time for a post
app.patch('/posts/:postId/schedule', verifyUser, async (req, res) => {
  try {
    const { postId } = req.params;
    const { scheduledDate } = req.body;

    if (!scheduledDate) {
      return res.status(400).json({ error: 'scheduledDate is required' });
    }

    const postRef = db.collection('posts').doc(postId);
    const postDoc = await postRef.get();

    if (!postDoc.exists || postDoc.data().userId !== req.userId) {
      return res.status(404).json({ error: 'Post not found' });
    }

    await postRef.update({ scheduledDate });

    res.json({ success: true, scheduledDate });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong scheduling the post' });
  }
});
// Check for due posts and publish them to Discord (called by Make.com on a schedule)
app.post('/publish-due-posts', async (req, res) => {
  try {
    const now = new Date().toISOString();

    const snapshot = await db.collection('posts')
      .where('scheduledDate', '<=', now)
      .where('published', '==', false)
      .get();

    if (snapshot.empty) {
      return res.json({ message: 'No due posts found.', published: [] });
    }

    const publishedPosts = [];

    for (const doc of snapshot.docs) {
      const post = doc.data();

      // Send to Discord webhook
      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `📱 **New Post Published!**\n\n**Business:** ${post.businessDescription}\n\n${post.caption}`
        })
      });

      // Mark as published in Firestore
      await doc.ref.update({ published: true, publishedAt: FieldValue.serverTimestamp() });

      publishedPosts.push({ id: doc.id, caption: post.caption });
    }

    res.json({ message: `Published ${publishedPosts.length} post(s).`, published: publishedPosts });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong publishing due posts' });
  }
});
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});