const jobForm = document.querySelector('#job-form');
const adminStatus = document.querySelector('#admin-status');
const adminJobList = document.querySelector('#admin-job-list');

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.message || 'Request failed.');
  return result;
}

function renderAdminJobs(jobs) {
  adminJobList.replaceChildren();
  if (!jobs.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'section-copy';
    emptyMessage.textContent = 'No job openings have been posted yet.';
    adminJobList.append(emptyMessage);
    return;
  }

  for (const job of jobs) {
    const item = document.createElement('article');
    item.className = 'admin-job-item';
    const details = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = job.title;
    const meta = document.createElement('p');
    meta.className = 'job-meta';
    meta.textContent = `${job.location} · ${job.employmentType.replace('-', ' ')} · ${job.active ? 'Published' : 'Draft'}`;
    details.append(title, meta);

    const removeButton = document.createElement('button');
    removeButton.className = 'remove-job-button';
    removeButton.type = 'button';
    removeButton.textContent = 'Remove';
    removeButton.setAttribute('aria-label', `Remove ${job.title}`);
    removeButton.addEventListener('click', async () => {
      if (!window.confirm(`Remove “${job.title}”?`)) return;
      removeButton.disabled = true;
      try {
        await requestJson(`/api/admin/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
        await loadJobs();
      } catch (error) {
        removeButton.disabled = false;
        adminStatus.dataset.state = 'error';
        adminStatus.textContent = error.message;
      }
    });

    item.append(details, removeButton);
    adminJobList.append(item);
  }
}

async function loadJobs() {
  const jobs = await requestJson('/api/admin/jobs');
  renderAdminJobs(jobs);
}

jobForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!jobForm.reportValidity()) return;

  const submitButton = jobForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  adminStatus.dataset.state = 'pending';
  adminStatus.textContent = 'Publishing opening...';
  const values = new FormData(jobForm);
  const job = {
    title: values.get('title'),
    location: values.get('location'),
    employmentType: values.get('employmentType'),
    summary: values.get('summary'),
    requirements: values.get('requirements').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    active: values.has('active')
  };

  try {
    await requestJson('/api/admin/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job)
    });
    jobForm.reset();
    jobForm.elements.active.checked = true;
    adminStatus.dataset.state = 'success';
    adminStatus.textContent = 'Job opening saved.';
    await loadJobs();
  } catch (error) {
    adminStatus.dataset.state = 'error';
    adminStatus.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

loadJobs().catch((error) => {
  adminJobList.replaceChildren();
  const message = document.createElement('p');
  message.className = 'form-status';
  message.dataset.state = 'error';
  message.textContent = error.message;
  adminJobList.append(message);
});
