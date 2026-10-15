const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { MongoClient } = require('mongodb');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.jsonl');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const APPLICATIONS_FILE = path.join(DATA_DIR, 'applications.jsonl');
const RESUMES_DIR = path.join(DATA_DIR, 'resumes');
const ADMIN_PAGE = path.join(__dirname, 'admin', 'index.html');
const EMPLOYMENT_TYPES = new Set(['full-time', 'part-time', 'contract', 'temporary', 'internship']);
const MAX_RESUME_SIZE = 5 * 1024 * 1024;
const RESUME_TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
]);

let mongoClient;
let contactsCollection;
let jobsCollection;
let applicationsCollection;
let mailTransporter;

const applicationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many applications from this connection. Please try again later.' }
});

const contactRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many messages from this connection. Please try again later.' }
});

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_SIZE, files: 1, fields: 10, parts: 11 },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    if (RESUME_TYPES.get(extension) !== file.mimetype) {
      return callback(new Error('Upload a PDF, DOC, or DOCX resume.'));
    }
    return callback(null, true);
  }
});

if (process.env.RENDER) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      ...(process.env.NODE_ENV === 'production' ? { upgradeInsecureRequests: [] } : {})
    }
  }
}));

function secureEquals(actual, expected) {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function requireAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
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

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();

  let requestOrigin;
  try {
    requestOrigin = new URL(`${req.protocol}://${req.get('host')}`).origin;
  } catch {
    return res.status(403).json({ message: 'This request origin is not allowed.' });
  }

  if (origin !== requestOrigin) {
    return res.status(403).json({ message: 'This request origin is not allowed.' });
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

async function readLocalApplications() {
  try {
    const content = await fs.readFile(APPLICATIONS_FILE, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function publicApplication(application) {
  const { resumeData, resumeFile, ...details } = application;
  return details;
}

async function saveApplication(application, resume) {
  if (applicationsCollection) {
    await applicationsCollection.insertOne({
      ...application,
      resumeData: Buffer.from(resume.buffer)
    });
    return;
  }

  await fs.mkdir(RESUMES_DIR, { recursive: true });
  const resumePath = path.join(RESUMES_DIR, application.resumeFile);
  await fs.writeFile(resumePath, resume.buffer, { flag: 'wx', mode: 0o600 });
  try {
    await fs.appendFile(APPLICATIONS_FILE, `${JSON.stringify(application)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    await fs.unlink(resumePath).catch((cleanupError) => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}

async function getApplicationResume(id) {
  if (applicationsCollection) {
    const application = await applicationsCollection.findOne(
      { id },
      { projection: { resumeData: 1, resumeName: 1, resumeType: 1 } }
    );
    if (!application) return null;
    const resumeData = application.resumeData;
    const buffer = Buffer.isBuffer(resumeData)
      ? resumeData
      : Buffer.from(typeof resumeData?.value === 'function' ? resumeData.value(true) : resumeData);
    return { buffer, name: application.resumeName, type: application.resumeType };
  }

  const application = (await readLocalApplications()).find((item) => item.id === id);
  if (!application) return null;
  return {
    buffer: await fs.readFile(path.join(RESUMES_DIR, application.resumeFile)),
    name: application.resumeName,
    type: application.resumeType
  };
}

async function removeApplication(id) {
  if (applicationsCollection) {
    const result = await applicationsCollection.deleteOne({ id });
    return result.deletedCount > 0;
  }

  const applications = await readLocalApplications();
  const application = applications.find((item) => item.id === id);
  if (!application) return false;

  const remaining = applications.filter((item) => item.id !== id);
  const temporaryFile = `${APPLICATIONS_FILE}.${randomUUID()}.tmp`;
  await fs.writeFile(
    temporaryFile,
    remaining.map((item) => JSON.stringify(item)).join('\n') + (remaining.length ? '\n' : ''),
    { encoding: 'utf8', mode: 0o600 }
  );
  await fs.rename(temporaryFile, APPLICATIONS_FILE);
  await fs.unlink(path.join(RESUMES_DIR, application.resumeFile)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return true;
}

function validResumeFile(file) {
  if (!file) return false;
  const extension = path.extname(file.originalname).toLowerCase();
  if (RESUME_TYPES.get(extension) !== file.mimetype) return false;
  if (extension === '.pdf') return file.buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (extension === '.doc') return file.buffer.subarray(0, 8).equals(Buffer.from('D0CF11E0A1B11AE1', 'hex'));
  return extension === '.docx' && file.buffer.subarray(0, 2).toString('ascii') === 'PK';
}

function safeResumeName(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180) || 'resume';
}

function validLinkedInUrl(value) {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'www.linkedin.com';
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

async function sendApplicationNotification(application, resume) {
  if (!mailTransporter || !process.env.APPLICATION_NOTIFICATION_EMAIL) return false;

  await mailTransporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.APPLICATION_NOTIFICATION_EMAIL,
    subject: `Candidate application: ${application.jobTitle}`,
    text: `New candidate application\nName: ${application.name}\nEmail: ${application.email}\nPhone: ${application.phone || 'Not provided'}\nLocation: ${application.location}\nPosition: ${application.jobTitle}\nLinkedIn: ${application.linkedIn || 'Not provided'}`,
    html: `<p>A new candidate application was submitted.</p><ul>
      <li>Name: ${escapeHtml(application.name)}</li>
      <li>Email: ${escapeHtml(application.email)}</li>
      <li>Phone: ${escapeHtml(application.phone || 'Not provided')}</li>
      <li>Location: ${escapeHtml(application.location)}</li>
      <li>Position: ${escapeHtml(application.jobTitle)}</li>
      <li>LinkedIn: ${escapeHtml(application.linkedIn || 'Not provided')}</li>
    </ul>`,
    attachments: [{
      filename: resume.name,
      content: resume.buffer,
      contentType: resume.type
    }]
  });
  return true;
}

app.use(express.json({ limit: '20kb' }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    storage: jobsCollection ? 'mongodb' : 'local-json',
    applicationsAvailable: Boolean(applicationsCollection || process.env.NODE_ENV !== 'production')
  });
});

app.get('/api/application-status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ available: Boolean(applicationsCollection || process.env.NODE_ENV !== 'production') });
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

app.get('/apply', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'apply.html'));
});

app.post('/api/applications', applicationRateLimit, requireSameOrigin, (req, res) => {
  if (process.env.NODE_ENV === 'production' && !applicationsCollection) {
    return res.status(503).json({ message: 'Applications are temporarily unavailable while secure storage is configured.' });
  }

  resumeUpload.single('resume')(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE';
      const status = tooLarge ? 413 : 400;
      return res.status(status).json({
        message: tooLarge ? 'Resume files must be 5 MB or smaller.' : uploadError.message
      });
    }

    if (req.body?.website) return res.status(400).json({ message: 'Application could not be submitted.' });

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    const location = typeof req.body?.location === 'string' ? req.body.location.trim() : '';
    const jobId = typeof req.body?.jobId === 'string' ? req.body.jobId : '';
    const linkedIn = typeof req.body?.linkedIn === 'string' ? req.body.linkedIn.trim() : '';
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ message: 'Enter a name between 2 and 100 characters.' });
    }
    if (email.length > 254 || !validEmail) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }
    if (phone.length > 40 || location.length < 2 || location.length > 100) {
      return res.status(400).json({ message: 'Enter a location and a phone number no longer than 40 characters.' });
    }
    if (linkedIn.length > 300 || !validLinkedInUrl(linkedIn)) {
      return res.status(400).json({ message: 'Enter a valid LinkedIn profile URL.' });
    }
    if (req.body?.consent !== 'on') {
      return res.status(400).json({ message: 'Please confirm the application data notice before submitting.' });
    }
    if (!validResumeFile(req.file)) {
      return res.status(400).json({ message: 'Choose a valid PDF, DOC, or DOCX resume (5 MB maximum).' });
    }

    try {
      const activeJobs = await listJobs();
      const selectedJob = jobId ? activeJobs.find((job) => job.id === jobId && job.active) : null;
      if (jobId && !selectedJob) {
        return res.status(400).json({ message: 'That job is no longer accepting applications.' });
      }

      const resumeName = safeResumeName(req.file.originalname);
      const application = {
        id: randomUUID(),
        name,
        email,
        phone,
        location,
        jobId: selectedJob?.id || '',
        jobTitle: selectedJob?.title || 'General application',
        linkedIn,
        createdAt: new Date().toISOString(),
        resumeName,
        resumeType: req.file.mimetype,
        resumeSize: req.file.size,
        resumeFile: `${randomUUID()}${path.extname(resumeName).toLowerCase()}`
      };

      await saveApplication(application, req.file);
      let notified = false;
      try {
        notified = await sendApplicationNotification(application, {
          name: resumeName,
          type: req.file.mimetype,
          buffer: req.file.buffer
        });
      } catch (notificationError) {
        console.error('Application was saved, but its email notification failed:', notificationError);
      }

      return res.status(201).json({
        message: notified
          ? 'Thank you. Your application has been received.'
          : 'Thank you. Your application has been saved for review.'
      });
    } catch (error) {
      console.error('Unable to save candidate application:', error);
      return res.status(500).json({ message: 'We could not save your application. Please try again.' });
    }
  });
});

app.post('/api/contact', contactRateLimit, requireSameOrigin, async (req, res) => {
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

app.use('/api/admin', requireAdmin, requireSameOrigin);

app.get('/api/admin/jobs', async (req, res) => {
  try {
    return res.json(await listJobs());
  } catch (error) {
    console.error('Unable to load admin job openings:', error);
    return res.status(500).json({ message: 'Job openings could not be loaded.' });
  }
});

app.get('/api/admin/applications', async (req, res) => {
  try {
    const applications = applicationsCollection
      ? await applicationsCollection.find({}, { projection: { _id: 0, resumeData: 0 } }).sort({ createdAt: -1 }).limit(100).toArray()
      : (await readLocalApplications()).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 100);
    return res.json(applications.map(publicApplication));
  } catch (error) {
    console.error('Unable to load candidate applications:', error);
    return res.status(500).json({ message: 'Candidate applications could not be loaded.' });
  }
});

app.get('/api/admin/applications/:id/resume', async (req, res) => {
  try {
    const resume = await getApplicationResume(req.params.id);
    if (!resume) return res.status(404).json({ message: 'Candidate resume not found.' });
    res.set('Content-Type', resume.type);
    res.set('Content-Disposition', `attachment; filename="${safeResumeName(resume.name)}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    return res.send(resume.buffer);
  } catch (error) {
    console.error('Unable to download candidate resume:', error);
    return res.status(500).json({ message: 'Candidate resume could not be downloaded.' });
  }
});

app.delete('/api/admin/applications/:id', async (req, res) => {
  try {
    const removed = await removeApplication(req.params.id);
    if (!removed) return res.status(404).json({ message: 'Candidate application not found.' });
    return res.status(204).end();
  } catch (error) {
    console.error('Unable to remove candidate application:', error);
    return res.status(500).json({ message: 'Candidate application could not be removed.' });
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
    applicationsCollection = database.collection('applications');
  }

  if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 16)) {
    throw new Error('Set a unique ADMIN_PASSWORD of at least 16 characters before running in production.');
  }

  if (process.env.SMTP_HOST && process.env.APPLICATION_NOTIFICATION_EMAIL) {
    mailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      ...(process.env.SMTP_USER && process.env.SMTP_PASS
        ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
        : {})
    });
  }

  app.listen(PORT, () => {
    console.log(`Website running at http://localhost:${PORT}`);
    console.log(`Contact storage: ${contactsCollection ? 'MongoDB' : CONTACTS_FILE}`);
    console.log(`Careers storage: ${jobsCollection ? 'MongoDB' : JOBS_FILE}`);
    console.log(`Candidate application storage: ${applicationsCollection ? 'MongoDB' : APPLICATIONS_FILE}`);
  });
}

module.exports = app;

if (require.main === module) {
  startServer().catch(async (error) => {
    console.error('Unable to start the server:', error);
    if (mongoClient) await mongoClient.close();
    process.exitCode = 1;
  });
}
