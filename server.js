const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.jsonl');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const ADMIN_PAGE = path.join(__dirname, 'admin', 'index.html');
const EMPLOYMENT_TYPES = new Set(['full-time', 'part-time', 'contract', 'temporary', 'internship']);

let mongoClient;
let contactsCollection;
let jobsCollection;

function secureEquals(actual, expected) {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function requireAdmin(req, res, next) {
  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
  const expectedPassword = process.env.ADMIN_PASSWORD;

  if (!expectedPassword) {
    return res.status(503).send('Admin access is not configured. Set ADMIN_PASSWORD before starting the server.');
  }

  const authorization = req.get('authorization') || '';
  const credentialsMatch = /^Basic\s+(.+)$/i.exec(authorization);
  let username = '';
  let password = '';

  if (credentialsMatch) {
    const decoded = Buffer.from(credentialsMatch[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) {
      username = decoded.slice(0, separator);
      password = decoded.slice(separator + 1);
    }
  }

  if (!secureEquals(username, expectedUsername) || !secureEquals(password, expectedPassword)) {
    res.set('WWW-Authenticate', 'Basic realm="Karvishit Careers Admin", charset="UTF-8"');
    return res.status(401).send('Admin credentials required.');
  }

  return next();
}

async function readLocalJobs() {
  try {
    return JSON.parse(await fs.readFile(JOBS_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listJobs() {
  if (jobsCollection) return jobsCollection.find({}).sort({ createdAt: -1 }).toArray();
  return readLocalJobs();
}

async function saveJob(job) {
  if (jobsCollection) {
    await jobsCollection.insertOne(job);
    return;
  }

  const jobs = await readLocalJobs();
  jobs.unshift(job);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf8');
}

async function removeJob(id) {
  if (jobsCollection) {
    const result = await jobsCollection.deleteOne({ id });
    return result.deletedCount > 0;
  }

  const jobs = await readLocalJobs();
  const remainingJobs = jobs.filter((job) => job.id !== id);
  if (remainingJobs.length === jobs.length) return false;
  await fs.writeFile(JOBS_FILE, JSON.stringify(remainingJobs, null, 2), 'utf8');
  return true;
}

app.use(express.json({ limit: '20kb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', storage: jobsCollection ? 'mongodb' : 'local-json' });
});

app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await listJobs();
    return res.json(jobs.filter((job) => job.active));
  } catch (error) {
    console.error('Unable to load job openings:', error);
    return res.status(500).json({ message: 'Job openings are unavailable right now.' });
  }
});

app.post('/api/contact', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ message: 'Enter a name between 2 and 80 characters.' });
  }
  if (email.length > 254 || !validEmail) {
    return res.status(400).json({ message: 'Enter a valid email address.' });
  }
  if (message.length < 10 || message.length > 2000) {
    return res.status(400).json({ message: 'Enter a message between 10 and 2000 characters.' });
  }

  const contact = { name, email, message, createdAt: new Date().toISOString() };

  try {
    if (contactsCollection) {
      await contactsCollection.insertOne(contact);
    } else {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.appendFile(CONTACTS_FILE, `${JSON.stringify(contact)}\n`, 'utf8');
    }
    return res.status(201).json({ message: 'Thanks. Your message has been sent.' });
  } catch (error) {
    console.error('Unable to save contact submission:', error);
    return res.status(500).json({ message: 'We could not save your message. Please try again.' });
  }
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(ADMIN_PAGE);
});

app.use('/api/admin', requireAdmin);

app.get('/api/admin/jobs', async (req, res) => {
  try {
    return res.json(await listJobs());
  } catch (error) {
    console.error('Unable to load admin job openings:', error);
    return res.status(500).json({ message: 'Job openings could not be loaded.' });
  }
});

app.post('/api/admin/jobs', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const location = typeof req.body?.location === 'string' ? req.body.location.trim() : '';
  const employmentType = typeof req.body?.employmentType === 'string' ? req.body.employmentType : '';
  const summary = typeof req.body?.summary === 'string' ? req.body.summary.trim() : '';
  const requirements = Array.isArray(req.body?.requirements)
    ? req.body.requirements.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];

  if (title.length < 3 || title.length > 100) {
    return res.status(400).json({ message: 'Job title must be between 3 and 100 characters.' });
  }
  if (location.length < 2 || location.length > 100) {
    return res.status(400).json({ message: 'Enter a location between 2 and 100 characters.' });
  }
  if (!EMPLOYMENT_TYPES.has(employmentType)) {
    return res.status(400).json({ message: 'Choose a valid employment type.' });
  }
  if (summary.length < 20 || summary.length > 500) {
    return res.status(400).json({ message: 'Job summary must be between 20 and 500 characters.' });
  }
  if (requirements.length < 1 || requirements.length > 12 || requirements.some((item) => item.length > 240)) {
    return res.status(400).json({ message: 'Add 1 to 12 requirements, each no longer than 240 characters.' });
  }

  const job = {
    id: randomUUID(),
    title,
    location,
    employmentType,
    summary,
    requirements,
    active: req.body.active !== false,
    createdAt: new Date().toISOString()
  };

  try {
    await saveJob(job);
    return res.status(201).json(job);
  } catch (error) {
    console.error('Unable to save job opening:', error);
    return res.status(500).json({ message: 'Job opening could not be saved.' });
  }
});

app.delete('/api/admin/jobs/:id', async (req, res) => {
  try {
    const removed = await removeJob(req.params.id);
    if (!removed) return res.status(404).json({ message: 'Job opening not found.' });
    return res.status(204).end();
  } catch (error) {
    console.error('Unable to remove job opening:', error);
    return res.status(500).json({ message: 'Job opening could not be removed.' });
  }
});

app.use(express.static(PUBLIC_DIR));

async function startServer() {
  if (process.env.MONGODB_URI) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    const database = mongoClient.db(process.env.MONGODB_DB || 'karvishit');
    contactsCollection = database.collection('contacts');
    jobsCollection = database.collection('jobs');
  }

  app.listen(PORT, () => {
    console.log(`Website running at http://localhost:${PORT}`);
    console.log(`Contact storage: ${contactsCollection ? 'MongoDB' : CONTACTS_FILE}`);
    console.log(`Careers storage: ${jobsCollection ? 'MongoDB' : JOBS_FILE}`);
  });
}

startServer().catch(async (error) => {
  console.error('Unable to start the server:', error);
  if (mongoClient) await mongoClient.close();
  process.exitCode = 1;
});
