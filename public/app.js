const menuToggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#primary-navigation');
const healthIndicator = document.querySelector('.status-dot');
const contactForm = document.querySelector('#contact-form');
const formStatus = document.querySelector('#form-status');
const yearElement = document.querySelector('#copyright-year');
const publicJobList = document.querySelector('#job-list');

if (yearElement) {
  yearElement.textContent = new Date().getFullYear();
}

if (menuToggle && navigation) {
  menuToggle.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isOpen));
    menuToggle.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
    navigation.classList.toggle('is-open', !isOpen);
  });

  navigation.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      menuToggle.setAttribute('aria-expanded', 'false');
      menuToggle.setAttribute('aria-label', 'Open navigation');
      navigation.classList.remove('is-open');
    }
  });
}

if (healthIndicator) {
  fetch('/api/health')
    .then((response) => {
      if (!response.ok) throw new Error('Health check failed');
      return response.json();
    })
    .then(() => {
      healthIndicator.dataset.state = 'online';
      healthIndicator.title = 'Service online';
    })
    .catch(() => {
      healthIndicator.dataset.state = 'offline';
      healthIndicator.title = 'Service status unavailable';
    });
}

function renderPublicJobs(jobs) {
  publicJobList.replaceChildren();
  if (!jobs.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'section-copy';
    emptyMessage.textContent = 'There are no open positions right now. Check back later or email us about future opportunities.';
    publicJobList.append(emptyMessage);
    return;
  }

  for (const job of jobs) {
    const opening = document.createElement('article');
    opening.className = 'job-opening';
    const heading = document.createElement('h3');
    heading.textContent = job.title;
    const meta = document.createElement('p');
    meta.className = 'job-meta';
    meta.textContent = `${job.location} · ${job.employmentType.replace('-', ' ')}`;
    const summary = document.createElement('p');
    summary.textContent = job.summary;
    const requirements = document.createElement('ul');
    for (const requirement of job.requirements) {
      const item = document.createElement('li');
      item.textContent = requirement;
      requirements.append(item);
    }
    const applyLink = document.createElement('a');
    applyLink.className = 'text-link';
    applyLink.href = `mailto:HR@karvishit.com?subject=${encodeURIComponent(`Application: ${job.title}`)}`;
    applyLink.textContent = 'Apply by email ↗';
    opening.append(heading, meta, summary, requirements, applyLink);
    publicJobList.append(opening);
  }
}

if (publicJobList) {
  fetch('/api/jobs')
    .then((response) => {
      if (!response.ok) throw new Error('Job openings are unavailable right now.');
      return response.json();
    })
    .then(renderPublicJobs)
    .catch((error) => {
      publicJobList.replaceChildren();
      const message = document.createElement('p');
      message.className = 'section-copy';
      message.textContent = error.message;
      publicJobList.append(message);
    });
}

if (contactForm && formStatus) {
  contactForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!contactForm.reportValidity()) return;

    const submitButton = contactForm.querySelector('button[type="submit"]');
    const originalButtonText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Sending...';
    formStatus.dataset.state = 'pending';
    formStatus.textContent = 'Sending your message...';

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(contactForm)))
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Your message could not be sent.');

      formStatus.dataset.state = 'success';
      formStatus.textContent = result.message;
      contactForm.reset();
    } catch (error) {
      formStatus.dataset.state = 'error';
      formStatus.textContent = error.message || 'Your message could not be sent. Please email HR@karvishit.com.';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalButtonText;
    }
  });
}
