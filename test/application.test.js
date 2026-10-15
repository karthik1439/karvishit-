const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

async function findPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer(t, overrides = {}) {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'karvishit-test-'));
  const port = await findPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDirectory,
      ADMIN_USERNAME: 'test-admin',
      ADMIN_PASSWORD: 'test-password-that-is-long-enough',
      RENDER: '',
      ...overrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    child.kill();
    await once(child, 'exit').catch(() => {});
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before becoming ready:\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, dataDirectory };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`Server did not become ready:\n${output}`);
}

function createApplicationForm({ consent = true, resume = Buffer.from('%PDF-1.7\nsample resume') } = {}) {
  const form = new FormData();
  form.set('name', 'Sample Candidate');
  form.set('email', 'candidate@example.test');
  form.set('phone', '+1 555 0100');
  form.set('location', 'Remote');
  form.set('jobId', '');
  form.set('linkedIn', 'https://www.linkedin.com/in/sample-candidate');
  if (consent) form.set('consent', 'on');
  form.set('resume', new Blob([resume], { type: 'application/pdf' }), 'candidate-resume.pdf');
  return form;
}

test('candidate applications validate, stay private, and support protected resume management', async (t) => {
  const { baseUrl, dataDirectory } = await startServer(t, { NODE_ENV: 'test' });
  const adminHeaders = { Authorization: `Basic ${Buffer.from('test-admin:test-password-that-is-long-enough').toString('base64')}` };

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await healthResponse.json()).applicationsAvailable, true);
  assert.equal((await fetch(`${baseUrl}/apply`)).status, 200);

  const wrongOrigin = await fetch(`${baseUrl}/api/applications`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
    body: createApplicationForm()
  });
  assert.equal(wrongOrigin.status, 403);

  const invalidResume = await fetch(`${baseUrl}/api/applications`, {
    method: 'POST',
    body: createApplicationForm({ resume: Buffer.from('not a PDF') })
  });
  assert.equal(invalidResume.status, 400);

  const missingConsent = await fetch(`${baseUrl}/api/applications`, {
    method: 'POST',
    body: createApplicationForm({ consent: false })
  });
  assert.equal(missingConsent.status, 400);

  const resumeBytes = Buffer.from('%PDF-1.7\nprivate sample resume');
  const submitResponse = await fetch(`${baseUrl}/api/applications`, {
    method: 'POST',
    body: createApplicationForm({ resume: resumeBytes })
  });
  assert.equal(submitResponse.status, 201);

  const privateWithoutAuth = await fetch(`${baseUrl}/api/admin/applications`);
  assert.equal(privateWithoutAuth.status, 401);

  const listResponse = await fetch(`${baseUrl}/api/admin/applications`, { headers: adminHeaders });
  assert.equal(listResponse.status, 200);
  const [application] = await listResponse.json();
  assert.equal(application.name, 'Sample Candidate');
  assert.equal(application.jobTitle, 'General application');
  assert.equal(Object.hasOwn(application, 'resumeData'), false);
  assert.equal(Object.hasOwn(application, 'resumeFile'), false);

  const unauthorizedDownload = await fetch(`${baseUrl}/api/admin/applications/${application.id}/resume`);
  assert.equal(unauthorizedDownload.status, 401);

  const downloadResponse = await fetch(`${baseUrl}/api/admin/applications/${application.id}/resume`, { headers: adminHeaders });
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), resumeBytes);

  const deleteResponse = await fetch(`${baseUrl}/api/admin/applications/${application.id}`, {
    method: 'DELETE',
    headers: { ...adminHeaders, Origin: baseUrl }
  });
  assert.equal(deleteResponse.status, 204);
  assert.equal((await fs.readdir(path.join(dataDirectory, 'resumes'))).length, 0);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/admin/applications`, { headers: adminHeaders })).json(), []);
});

test('production refuses candidate applications without persistent MongoDB storage', async (t) => {
  const { baseUrl } = await startServer(t, {
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'production-test-password-that-is-long-enough'
  });

  const status = await fetch(`${baseUrl}/api/application-status`);
  assert.deepEqual(await status.json(), { available: false });
  const response = await fetch(`${baseUrl}/api/applications`, {
    method: 'POST',
    body: createApplicationForm()
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /secure storage/i);
});
