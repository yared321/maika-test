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
  });
})();
