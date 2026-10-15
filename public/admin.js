const jobForm = document.querySelector('#job-form');
const adminStatus = document.querySelector('#admin-status');
const adminJobList = document.querySelector('#admin-job-list');
const adminApplicationList = document.querySelector('#admin-application-list');
const sampleJobButton = document.querySelector('#sample-job-button');

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

function renderApplications(applications) {
  adminApplicationList.replaceChildren();
  if (!applications.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'section-copy';
    emptyMessage.textContent = 'No candidate applications have been received.';
    adminApplicationList.append(emptyMessage);
    return;
  }

  for (const application of applications) {
    const item = document.createElement('article');
    item.className = 'admin-application-item';
    const details = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = application.name;
    const meta = document.createElement('p');
    meta.className = 'job-meta';
    meta.textContent = `${application.jobTitle} · ${application.location} · ${new Date(application.createdAt).toLocaleDateString()}`;
    const email = document.createElement('a');
    email.href = `mailto:${application.email}`;
    email.textContent = application.email;
    details.append(title, meta, email);
    if (application.phone) {
      const phone = document.createElement('p');
      phone.className = 'application-detail';
      phone.textContent = application.phone;
      details.append(phone);
    }
    if (application.linkedIn) {
      const linkedIn = document.createElement('a');
      linkedIn.href = application.linkedIn;
      linkedIn.target = '_blank';
      linkedIn.rel = 'noopener noreferrer';
      linkedIn.textContent = 'LinkedIn profile';
      details.append(linkedIn);
    }
    if (application.coverLetter) {
      const coverLetter = document.createElement('p');
      coverLetter.className = 'application-detail';
      coverLetter.textContent = application.coverLetter;
      details.append(coverLetter);
    }

    const actions = document.createElement('div');
    actions.className = 'application-actions';
    const resumeLink = document.createElement('a');
    resumeLink.className = 'remove-job-button';
    resumeLink.href = `/api/admin/applications/${encodeURIComponent(application.id)}/resume`;
    resumeLink.textContent = `Download ${application.resumeName}`;
    const removeButton = document.createElement('button');
    removeButton.className = 'remove-job-button';
    removeButton.type = 'button';
    removeButton.textContent = 'Delete';
    removeButton.setAttribute('aria-label', `Delete application from ${application.name}`);
    removeButton.addEventListener('click', async () => {
      if (!window.confirm(`Delete ${application.name}'s application and resume?`)) return;
      removeButton.disabled = true;
      try {
        await requestJson(`/api/admin/applications/${encodeURIComponent(application.id)}`, { method: 'DELETE' });
        await loadApplications();
      } catch (error) {
        removeButton.disabled = false;
        adminStatus.dataset.state = 'error';
        adminStatus.textContent = error.message;
      }
    });
    actions.append(resumeLink, removeButton);
    item.append(details, actions);
    adminApplicationList.append(item);
  }
}

async function loadApplications() {
  const applications = await requestJson('/api/admin/applications');
  renderApplications(applications);
}

sampleJobButton.addEventListener('click', () => {
  jobForm.elements.title.value = 'Sample draft — People Development Associate';
  jobForm.elements.location.value = 'Remote / Hybrid';
  jobForm.elements.employmentType.value = 'full-time';
  jobForm.elements.summary.value = 'This clearly labeled sample role shows how a people development opening can appear to candidates.';
  jobForm.elements.requirements.value = [
    'Interest in leadership development and workplace learning',
    'Clear written and verbal communication',
    'Able to collaborate with a diverse team'
  ].join('\n');
  jobForm.elements.active.checked = false;
  adminStatus.dataset.state = 'pending';
  adminStatus.textContent = 'Example draft loaded. It will not appear publicly unless you publish it.';
  jobForm.elements.title.focus();
});

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

loadApplications().catch((error) => {
  adminApplicationList.replaceChildren();
  const message = document.createElement('p');
  message.className = 'form-status';
  message.dataset.state = 'error';
  message.textContent = error.message;
  adminApplicationList.append(message);
});
