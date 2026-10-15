const applicationForm = document.querySelector('#application-form');
const applicationStatus = document.querySelector('#application-status');
const applicationAvailability = document.querySelector('#application-availability');
const applicationJob = document.querySelector('#application-job');
const applicationResume = document.querySelector('#application-resume');
const MAX_RESUME_SIZE = 5 * 1024 * 1024;

function setUnavailable(message) {
  applicationAvailability.dataset.state = 'error';
  applicationAvailability.textContent = message;
  applicationForm.querySelectorAll('input, select, textarea, button').forEach((control) => {
    control.disabled = true;
  });
}

async function loadApplicationOptions() {
  const [statusResponse, jobsResponse] = await Promise.all([
    fetch('/api/application-status', { cache: 'no-store' }),
    fetch('/api/jobs')
  ]);
  if (!statusResponse.ok || !jobsResponse.ok) {
    throw new Error('Applications are unavailable right now. Please try again later.');
  }

  const status = await statusResponse.json();
  if (!status.available) {
    setUnavailable('Applications are temporarily closed while secure storage is configured. Please check back soon.');
    return;
  }

  const jobs = await jobsResponse.json();
  for (const job of jobs) {
    const option = document.createElement('option');
    option.value = job.id;
    option.textContent = `${job.title} — ${job.location}`;
    applicationJob.append(option);
  }

  const requestedJob = new URLSearchParams(window.location.search).get('job');
  if (requestedJob && jobs.some((job) => job.id === requestedJob)) {
    applicationJob.value = requestedJob;
  }

  applicationAvailability.dataset.state = 'success';
  applicationAvailability.textContent = 'Secure application form is ready.';
}

applicationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!applicationForm.reportValidity()) return;

  const resume = applicationResume.files[0];
  if (!resume) {
    applicationStatus.dataset.state = 'error';
    applicationStatus.textContent = 'Choose a resume file to continue.';
    return;
  }
  if (resume.size > MAX_RESUME_SIZE) {
    applicationStatus.dataset.state = 'error';
    applicationStatus.textContent = 'Resume files must be 5 MB or smaller.';
    return;
  }

  const submitButton = applicationForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  applicationStatus.dataset.state = 'pending';
  applicationStatus.textContent = 'Submitting your application...';

  try {
    const response = await fetch('/api/applications', {
      method: 'POST',
      body: new FormData(applicationForm)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Your application could not be submitted.');

    applicationStatus.dataset.state = 'success';
    applicationStatus.textContent = result.message;
    applicationForm.reset();
    applicationJob.value = '';
  } catch (error) {
    applicationStatus.dataset.state = 'error';
    applicationStatus.textContent = error.message || 'Your application could not be submitted. Please try again.';
  } finally {
    submitButton.disabled = false;
  }
});

loadApplicationOptions().catch((error) => {
  setUnavailable(error.message);
});
