(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const initCurrentNav = () => {
    const path = window.location.pathname.replace(/index\.html$/, '');
    const normalized = path.endsWith('/') ? path : `${path}/`;
    const map = new Map([
      ['/', '/'],
      ['/about/', '/about/'],
      ['/blog/', '/blog/'],
      ['/contact/', '/contact/'],
      ['/demo/', '/demo/'],
    ]);
    const current = map.get(normalized) || null;
    document.querySelectorAll('[data-nav-link]').forEach((link) => {
      const href = link.getAttribute('href');
      const isCurrent = current && href === current;
      if (isCurrent) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  };

  const initHeader = () => {
    const header = document.querySelector('.site-header');
    if (!header) return;
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const toggle = document.querySelector('[data-mobile-toggle]');
    const menu = document.querySelector('[data-mobile-menu]');
    if (toggle && menu) {
      toggle.addEventListener('click', () => {
        const open = menu.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
      });
      menu.querySelectorAll('a').forEach((a) => {
        a.addEventListener('click', () => {
          menu.classList.remove('open');
          toggle.setAttribute('aria-expanded', 'false');
        });
      });
    }
  };

  const initReveal = () => {
    const items = document.querySelectorAll('.reveal');
    if (!items.length) return;
    if (reducedMotion || !('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('in-view'));
      return;
    }

    const io = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('in-view');
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.03, rootMargin: '0px 0px -10% 0px' }
    );

    items.forEach((el) => io.observe(el));
  };

  const initStaggerDelays = () => {
    document.querySelectorAll('[data-stagger] > *').forEach((child, index) => {
      if (!child.classList.contains('reveal')) return;
      const jitter = Math.round((Math.random() - 0.5) * 30);
      child.style.setProperty('--delay', `${Math.max(0, index * 90 + jitter)}ms`);
    });
  };

  const splitHeadlines = () => {
    document.querySelectorAll('[data-split]').forEach((el) => {
      if (el.dataset.splitDone === 'true') return;
      const text = el.textContent || '';
      const words = text.trim().split(/\s+/).filter(Boolean);
      el.textContent = '';
      words.forEach((word, index) => {
        const span = document.createElement('span');
        span.className = 'word';
        span.textContent = word + (index < words.length - 1 ? ' ' : '');
        span.style.animationDelay = `${index * 45}ms`;
        el.appendChild(span);
      });
      el.dataset.splitDone = 'true';
    });
  };

  const initHeroStars = () => {
    document.querySelectorAll('[data-stars]').forEach((layer) => {
      if (layer.dataset.seeded === 'true') return;
      const count = Number(layer.dataset.stars || 40);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < count; i += 1) {
        const star = document.createElement('span');
        star.className = 'hero-star';
        const near = Math.random() < 0.18;
        const size = near ? (Math.random() < 0.35 ? 3 : 2) : 1;
        const angle = Math.random() * Math.PI * 2;
        const distance = near ? (28 + Math.random() * 58) : (18 + Math.random() * 48);
        const tx = `${(Math.cos(angle) * distance).toFixed(2)}vw`;
        const ty = `${(Math.sin(angle) * distance * 0.8).toFixed(2)}vh`;
        const rot = `${(angle * 180) / Math.PI}deg`;
        const opacity = (near ? 0.5 + Math.random() * 0.45 : 0.25 + Math.random() * 0.55).toFixed(2);
        const tw = `${(near ? 2.8 : 3.8) + Math.random() * (near ? 4.5 : 6.5)}s`;
        const drift = `${(near ? 4.5 : 7.5) + Math.random() * (near ? 5.5 : 8.5)}s`;
        const delay = `${(-Math.random() * 8).toFixed(2)}s`;
        const delay2 = `${(-Math.random() * 12).toFixed(2)}s`;
        const mxRange = near ? 34 : 18;
        const myRange = near ? 42 : 22;
        const mx = `${(-mxRange + Math.random() * mxRange * 2).toFixed(2)}px`;
        const my = `${(-myRange + Math.random() * myRange * 2).toFixed(2)}px`;
        const blur = near && Math.random() < 0.4 ? 0.35 : 0;
        const stretch = near ? (1.2 + Math.random() * 2.4) : (1 + Math.random() * 0.8);
        const starW = `${(size * stretch).toFixed(2)}px`;
        const starH = `${Math.max(1, size * (near ? 0.65 : 0.85)).toFixed(2)}px`;
        const starScale = (near ? 1.45 + Math.random() * 0.9 : 1.1 + Math.random() * 0.6).toFixed(2);
        star.style.setProperty('--size', `${size}px`);
        star.style.setProperty('--star-w', starW);
        star.style.setProperty('--star-h', starH);
        star.style.setProperty('--o', opacity);
        star.style.setProperty('--tw', tw);
        star.style.setProperty('--drift', drift);
        star.style.setProperty('--delay', delay);
        star.style.setProperty('--delay2', delay2);
        star.style.setProperty('--mx', mx);
        star.style.setProperty('--my', my);
        star.style.setProperty('--star-blur', `${blur}px`);
        star.style.setProperty('--tx', tx);
        star.style.setProperty('--ty', ty);
        star.style.setProperty('--star-rot', rot);
        star.style.setProperty('--star-scale', starScale);
        frag.appendChild(star);
      }
      layer.appendChild(frag);
      layer.dataset.seeded = 'true';
    });
  };

  const initHeroSequence = () => {
    const hero = document.querySelector('[data-hero-intro]');
    if (!hero) return;
    if (reducedMotion) {
      hero.classList.add('hero-intro-ready');
      document.querySelectorAll('[data-hero-seq]').forEach((el) => {
        el.style.opacity = '1';
        el.style.transform = 'none';
        el.style.filter = 'none';
      });
      return;
    }
    requestAnimationFrame(() => {
      hero.classList.add('hero-intro-ready');
    });
  };

  const initTypewrite = () => {
    const els = document.querySelectorAll('[data-typewrite]');
    if (!els.length) return;

    els.forEach((el) => {
      if (el.dataset.typewriteDone === 'true') return;
      const original = (el.textContent || '').trim();
      if (!original) return;
      const speed = Number(el.dataset.typewriteSpeed || 26);
      const delay = Number(el.dataset.typewriteDelay || 0);
      const jitter = Number(el.dataset.typewriteJitter || 16);
      el.classList.add('typewrite');
      el.textContent = '';

      if (reducedMotion) {
        el.textContent = original;
        el.classList.add('done');
        el.dataset.typewriteDone = 'true';
        return;
      }

      let index = 0;
      const tick = () => {
        if (!el.classList.contains('is-typing')) {
          el.classList.add('is-typing');
        }
        if (index >= original.length) {
          el.classList.remove('is-typing');
          el.classList.add('done');
          el.dataset.typewriteDone = 'true';
          return;
        }
        index += 1;
        el.textContent = original.slice(0, index);
        const ch = original[index - 1];
        const extra = ch === ' ' ? 1.05 : ch === ',' || ch === '.' ? 2.2 : 1;
        const next = Math.max(12, speed + (Math.random() - 0.5) * jitter) * extra;
        window.setTimeout(tick, next);
      };

      window.setTimeout(tick, delay);
    });
  };

  const initMarquee = () => {
    document.querySelectorAll('.marquee-track').forEach((track) => {
      if (track.dataset.looped === 'true') return;
      track.innerHTML = `${track.innerHTML}${track.innerHTML}`;
      track.dataset.looped = 'true';
    });
  };

  const initAccordion = () => {
    document.querySelectorAll('.accordion-item').forEach((item, idx) => {
      const button = item.querySelector('.accordion-button');
      if (!button) return;
      button.addEventListener('click', () => {
        const isOpen = item.classList.contains('open');
        const group = item.closest('.faq-list');
        group?.querySelectorAll('.accordion-item.open').forEach((openItem) => {
          if (openItem !== item) openItem.classList.remove('open');
        });
        item.classList.toggle('open', !isOpen);
        button.setAttribute('aria-expanded', String(!isOpen));
      });
      if (idx === 0) {
        item.classList.add('open');
        button.setAttribute('aria-expanded', 'true');
      } else {
        button.setAttribute('aria-expanded', 'false');
      }
    });
  };

  const initParallax = () => {
    if (reducedMotion) return;
    const items = Array.from(document.querySelectorAll('.parallax'));
    if (!items.length) return;
    let raf = 0;

    const render = () => {
      const vh = window.innerHeight || 1;
      for (const el of items) {
        const rect = el.getBoundingClientRect();
        const speed = Number(el.dataset.speed || 0.04);
        const center = rect.top + rect.height / 2;
        const offset = (center - vh / 2) * speed;
        el.style.transform = `translate3d(0, ${-offset}px, 0)`;
      }
      raf = 0;
    };

    const queue = () => {
      if (!raf) raf = requestAnimationFrame(render);
    };

    queue();
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
  };

  const initTilt = () => {
    if (reducedMotion) return;
    document.querySelectorAll('.tilt').forEach((card) => {
      const limit = Number(card.dataset.tilt || 6);
      const onMove = (e) => {
        const rect = card.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        const rx = (0.5 - py) * limit;
        const ry = (px - 0.5) * limit;
        card.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-2px)`;
      };
      const onLeave = () => {
        card.style.transform = '';
      };
      card.addEventListener('mousemove', onMove);
      card.addEventListener('mouseleave', onLeave);
    });
  };

  const initMagneticButtons = () => {
    if (reducedMotion) return;
    document.querySelectorAll('[data-magnetic]').forEach((btn) => {
      const onMove = (e) => {
        const rect = btn.getBoundingClientRect();
        const x = (e.clientX - rect.left - rect.width / 2) * 0.08;
        const y = (e.clientY - rect.top - rect.height / 2) * 0.08;
        btn.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
      };
      const onLeave = () => {
        btn.style.transform = '';
      };
      btn.addEventListener('mousemove', onMove);
      btn.addEventListener('mouseleave', onLeave);
    });
  };

  const initProcessProgress = () => {
    const shell = document.querySelector('[data-process-shell]');
    if (!shell) return;
    const list = shell.querySelector('.process-list');
    if (!list) return;

    const update = () => {
      const rect = shell.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const start = vh * 0.85;
      const end = vh * 0.2;
      const total = rect.height + start - end;
      const progressed = start - rect.top;
      const pct = Math.max(0, Math.min(1, progressed / total));
      shell.style.setProperty('--progress', `${Math.round(pct * 100)}%`);
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
  };

  const initForms = () => {
    const contactForm = document.querySelector('[data-contact-form]');
    if (contactForm) {
      const encode = (data) =>
        Array.from(data.entries())
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&');

      contactForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = contactForm.querySelector('[data-form-status]');

        if (status) {
          status.textContent = '';
        }

        const formData = new FormData(contactForm);

        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          if (status) {
            status.textContent = 'Local preview does not submit forms. Push to Netlify to receive messages in your Netlify Forms inbox.';
          }
          return;
        }

        const submitButton = contactForm.querySelector('button[type="submit"]');
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.setAttribute('aria-busy', 'true');
        }

        try {
          const response = await fetch('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: encode(formData),
          });

          if (!response.ok) {
            throw new Error('Form submission failed');
          }

          contactForm.reset();
          if (status) {
            status.textContent = 'Message sent. We will get back to you soon.';
          }
        } catch (error) {
          if (status) {
            status.textContent = 'Submission failed. Please email info@maika-ai.com directly.';
          }
        } finally {
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.removeAttribute('aria-busy');
          }
        }
      });
    }

    document.querySelectorAll('[data-newsletter-form]').forEach((form) => {
      const encode = (data) =>
        Array.from(data.entries())
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&');

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = form.querySelector('input[name="email"]');
        let status = form.querySelector('[data-newsletter-status]');
        if (!status) {
          status = document.createElement('div');
          status.className = 'form-status';
          status.setAttribute('data-newsletter-status', '');
          status.setAttribute('aria-live', 'polite');
          form.appendChild(status);
        }
        status.textContent = '';

        const formData = new FormData(form);

        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          status.textContent = 'Local preview does not submit forms. Push to Netlify to receive newsletter signups.';
          return;
        }

        const submitButton = form.querySelector('button[type="submit"]');
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.setAttribute('aria-busy', 'true');
        }

        try {
          const response = await fetch('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: encode(formData),
          });

          if (!response.ok) {
            throw new Error('Newsletter signup failed');
          }

          form.reset();
          status.textContent = 'Subscribed. We will email you when updates are ready.';
        } catch (error) {
          status.textContent = 'Subscription failed. Please try again later.';
          if (input) input.focus();
        } finally {
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.removeAttribute('aria-busy');
          }
        }
      });
    });
  };

  const initYear = () => {
    document.querySelectorAll('[data-year]').forEach((el) => {
      el.textContent = String(new Date().getFullYear());
    });
  };

  const BETA_TELEGRAM_URL = 'https://t.me/c/3915691502/1';

  const betaRegisterErrorMessage = (payload) => {
    const tryString = (value) => {
      if (typeof value !== 'string') return '';
      const trimmed = value.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const nested = JSON.parse(trimmed);
          return betaRegisterErrorMessage(nested);
        } catch {
          return '';
        }
      }
      return trimmed;
    };

    if (payload && typeof payload === 'object') {
      return (
        tryString(payload.message) ||
        tryString(payload.error) ||
        tryString(payload.detail) ||
        'Registration failed. Please try again.'
      );
    }

    return tryString(payload) || 'Registration failed. Please try again.';
  };

  const mountBetaRegisterForm = (panel) => {
    if (panel.querySelector('[data-beta-register-form]')) return;

    const data = window.BETA_REGISTER_DATA || {
      countries: [],
      deviceTypes: [
        { value: 'iOS', label: 'iOS' },
        { value: 'Android', label: 'Android' },
        { value: 'Both', label: 'Both' },
      ],
      referralSources: [],
    };

    const escapeHtml = (value) =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const buildSelectOptions = (items, placeholder) => {
      const options = [
        `<option value="" disabled selected hidden>${escapeHtml(placeholder)}</option>`,
      ];
      items.forEach((item) => {
        if (typeof item === 'string') {
          options.push(
            `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`,
          );
        } else {
          options.push(
            `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`,
          );
        }
      });
      return options.join('');
    };

    const today = new Date().toISOString().slice(0, 10);

    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'beta-register-form-title');

    panel.innerHTML = `
      <button type="button" class="beta-register-dialog__backdrop" data-beta-register-close aria-label="Close registration dialog"></button>
      <div class="beta-register-dialog__panel">
        <div class="beta-register-card">
          <div class="beta-register-card__header">
            <div>
              <p class="beta-register-card__kicker">Beta program</p>
              <h2 class="beta-register-card__title" id="beta-register-form-title">Join the Maika beta</h2>
              <p class="beta-register-card__lead">
                Get early access to our adaptive music demo and help shape what we build next.
                We will only use your details for beta access and product updates.
              </p>
            </div>
            <button type="button" class="beta-register-card__close" data-beta-register-close aria-label="Close registration form">×</button>
          </div>
          <form class="beta-register-form" data-beta-register-form novalidate>
            <div class="form-field">
              <label for="beta-register-full-name">Full name</label>
              <input class="input" id="beta-register-full-name" name="full_name" type="text" autocomplete="name" required placeholder="Jane Doe">
            </div>
            <div class="form-field">
              <label for="beta-register-email">Email</label>
              <input class="input" id="beta-register-email" name="email" type="email" autocomplete="email" required placeholder="you@example.com">
            </div>
            <div class="form-row">
              <div class="form-field">
                <label for="beta-register-birthdate">Birthdate</label>
                <input class="input" id="beta-register-birthdate" name="birthdate" type="date" required max="${today}">
              </div>
              <div class="form-field">
                <label for="beta-register-country">Country</label>
                <select class="input select" id="beta-register-country" name="country" required>
                  ${buildSelectOptions(data.countries, 'Select country')}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-field">
                <label for="beta-register-device">Device type</label>
                <select class="input select" id="beta-register-device" name="device_type" required>
                  ${buildSelectOptions(data.deviceTypes, 'Select device')}
                </select>
              </div>
              <div class="form-field">
                <label for="beta-register-referral">How did you hear about us?</label>
                <select class="input select" id="beta-register-referral" name="referral_source" required>
                  ${buildSelectOptions(data.referralSources, 'Select source')}
                </select>
              </div>
            </div>
            <p class="beta-register-form__note">
              By registering, you agree to be contacted about the Maika beta program.
            </p>
            <button class="btn btn-primary beta-register-form__submit" type="submit" data-beta-submit>
              <span class="beta-register-form__submit-inner">
                <span class="beta-register-form__spinner" aria-hidden="true"></span>
                <span data-beta-submit-label>Submit registration</span>
              </span>
            </button>
            <div class="form-status" data-beta-register-status aria-live="polite"></div>
          </form>
          <div class="beta-register-success hidden" data-beta-register-success hidden>
            <p class="beta-register-success__kicker">Registration complete</p>
            <h3 class="beta-register-success__title">You're on the beta list</h3>
            <p class="beta-register-success__copy">
              Thanks for signing up. Join our Telegram group for beta updates, release news, and a direct line to the Maika team.
            </p>
            <a
              class="btn btn-primary beta-register-success__tg"
              href="${BETA_TELEGRAM_URL}"
              target="_blank"
              rel="noopener noreferrer"
            >
              Join Telegram group
              <span aria-hidden="true">↗</span>
            </a>
            <button type="button" class="btn btn-secondary beta-register-success__done" data-beta-register-close>
              Done
            </button>
          </div>
        </div>
      </div>
    `;
  };

  const setBetaRegisterSuccessVisible = (panel, visible) => {
    const form = panel.querySelector('[data-beta-register-form]');
    const success = panel.querySelector('[data-beta-register-success]');
    if (form) {
      form.hidden = visible;
      form.classList.toggle('hidden', visible);
    }
    if (success) {
      success.hidden = !visible;
      success.classList.toggle('hidden', !visible);
    }
  };

  const setBetaDialogOpen = (panel, openButtons, open) => {
    panel.hidden = !open;
    panel.classList.toggle('hidden', !open);
    panel.classList.toggle('is-open', open);
    document.body.classList.toggle('beta-register-open', open);
    openButtons.forEach((btn) => btn.setAttribute('aria-expanded', String(open)));
  };

  const setBetaSubmitLoading = (submitButton, loading) => {
    if (!submitButton) return;
    submitButton.disabled = loading;
    submitButton.classList.toggle('is-loading', loading);
    submitButton.setAttribute('aria-busy', String(loading));
    const label = submitButton.querySelector('[data-beta-submit-label]');
    if (label) {
      label.textContent = loading ? 'Submitting…' : 'Submit registration';
    }
  };

  const initBetaRegister = () => {
    const openButtons = document.querySelectorAll('[data-beta-register-open]');
    const panel = document.getElementById('beta-register-panel');
    if (!openButtons.length || !panel) return;

    mountBetaRegisterForm(panel);

    const form = panel.querySelector('[data-beta-register-form]');
    const status = panel.querySelector('[data-beta-register-status]');
    const closeTargets = panel.querySelectorAll('[data-beta-register-close]');
    const nameInput = panel.querySelector('#beta-register-full-name');
    const submitButton = panel.querySelector('[data-beta-submit]');
    let isSubmitting = false;

    const resetBetaDialogState = () => {
      form?.reset();
      setBetaRegisterSuccessVisible(panel, false);
      if (status) {
        status.textContent = '';
        status.classList.remove('is-error');
      }
      isSubmitting = false;
      setBetaSubmitLoading(submitButton, false);
    };

    const closeDialog = () => {
      if (isSubmitting) return;
      setBetaDialogOpen(panel, openButtons, false);
      window.setTimeout(() => resetBetaDialogState(), reducedMotion ? 0 : 200);
    };

    const openDialog = () => {
      resetBetaDialogState();

      const mobileMenu = document.querySelector('[data-mobile-menu]');
      const mobileToggle = document.querySelector('[data-mobile-toggle]');
      if (mobileMenu?.classList.contains('open')) {
        mobileMenu.classList.remove('open');
        mobileToggle?.setAttribute('aria-expanded', 'false');
      }

      setBetaDialogOpen(panel, openButtons, true);
      window.setTimeout(() => nameInput?.focus(), reducedMotion ? 0 : 120);
    };

    openButtons.forEach((openButton) => {
      openButton.addEventListener('click', openDialog);
    });

    closeTargets.forEach((closeButton) => {
      closeButton.addEventListener('click', closeDialog);
    });

    panel.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeDialog();
    });

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form || !status || isSubmitting) return;

      status.textContent = '';
      status.classList.remove('is-error');

      const formData = new FormData(form);
      const submitPayload = {
        full_name: String(formData.get('full_name') || '').trim(),
        email: String(formData.get('email') || '').trim(),
        birthdate: String(formData.get('birthdate') || '').trim(),
        country: String(formData.get('country') || '').trim(),
        device_type: String(formData.get('device_type') || '').trim(),
        referral_source: String(formData.get('referral_source') || '').trim(),
      };

      if (
        !submitPayload.full_name ||
        !submitPayload.email ||
        !submitPayload.birthdate ||
        !submitPayload.country ||
        !submitPayload.device_type ||
        !submitPayload.referral_source
      ) {
        status.textContent = 'Please complete all fields before submitting.';
        status.classList.add('is-error');
        return;
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submitPayload.email)) {
        status.textContent = 'Please enter a valid email address.';
        status.classList.add('is-error');
        return;
      }

      isSubmitting = true;
      setBetaSubmitLoading(submitButton, true);

      try {
        const response = await fetch('/api/beta-register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(submitPayload),
        });

        let responsePayload = {};
        try {
          responsePayload = await response.json();
        } catch {
          responsePayload = {};
        }

        if (!response.ok || responsePayload.ok === false) {
          throw new Error(betaRegisterErrorMessage(responsePayload));
        }

        form.reset();
        setBetaRegisterSuccessVisible(panel, true);
      } catch (error) {
        status.textContent =
          error instanceof Error
            ? error.message
            : 'Registration failed. Please try again or email info@maika-ai.com.';
        status.classList.add('is-error');
      } finally {
        isSubmitting = false;
        setBetaSubmitLoading(submitButton, false);
      }
    });
  };

  document.addEventListener('DOMContentLoaded', () => {
    initCurrentNav();
    initHeader();
    initHeroStars();
    initHeroSequence();
    initTypewrite();
    splitHeadlines();
    initStaggerDelays();
    initReveal();
    initMarquee();
    initAccordion();
    initParallax();
    initTilt();
    initMagneticButtons();
    initProcessProgress();
    initForms();
    initYear();
    initBetaRegister();
  });
})();
