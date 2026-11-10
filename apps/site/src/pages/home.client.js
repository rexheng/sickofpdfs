// The home page's only script, inlined by scripts/build.mjs: the count, and the cloud sync waitlist form.
// Nothing loads from another site until someone uses the form: then Cloudflare Turnstile (the bot check) loads, once.
(() => {
  const $ = (id) => document.getElementById(id);
  const number = (n) => n.toLocaleString('en-US');

  const SAY = {
    thanks: 'Thanks. We’ll email you when cloud sync is ready.',
    sending: 'Sending…',
    invalid_email: 'Check your email address and try again.',
    bot_check: 'The bot check didn’t pass. Please try again.',
    rate_limited: 'Too many tries. Wait a minute, then try again.',
    closed: 'The waitlist isn’t open yet.',
    unavailable: 'Something went wrong. Please try again later.',
  };

  // --- the count: only a real number, labelled with what it counts; nothing when there is none
  async function showCount() {
    const el = $('count');
    try {
      const res = await fetch('/api/count', { cache: 'no-store' });
      if (!res.ok) return;
      const { waitlist, users } = await res.json();
      if (typeof users === 'number') {
        el.textContent = `${number(users)} ${users === 1 ? 'user' : 'users'} on the Chrome Web Store.`;
      } else if (typeof waitlist === 'number' && waitlist > 0) {
        el.textContent = `${number(waitlist)} ${waitlist === 1 ? 'person' : 'people'} on the cloud sync waitlist.`;
      } else {
        return;
      }
      el.hidden = false;
    } catch {
      // no number to show
    }
  }

  // --- the waitlist
  const form = $('join');
  const input = $('email');
  const status = $('join-status');
  const button = form.querySelector('button');
  let setup = null; // the bot check loading, once
  let widget = null;
  let token = null;
  let waiting = [];

  const say = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('err', error);
  };
  const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

  function loadCheck() {
    setup ??= (async () => {
      const res = await fetch('/api/waitlist');
      const { siteKey } = res.ok ? await res.json() : {};
      if (!siteKey) throw new Error('closed');
      await new Promise((resolve, reject) => {
        window.sopTurnstileReady = resolve;
        const s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=sopTurnstileReady';
        s.async = true;
        s.onerror = () => reject(new Error('unavailable'));
        document.head.append(s);
      });
      widget = window.turnstile.render('#bot-check', {
        sitekey: siteKey,
        action: 'waitlist',
        appearance: 'interaction-only',
        size: 'flexible',
        callback: (t) => {
          token = t;
          waiting.splice(0).forEach((w) => w.resolve(t));
        },
        'expired-callback': () => {
          token = null;
        },
        'error-callback': () => {
          token = null;
          waiting.splice(0).forEach((w) => w.reject(new Error('bot_check')));
        },
      });
    })().catch((err) => {
      setup = null; // try again next time
      throw err;
    });
    return setup;
  }

  function nextToken() {
    if (token) return Promise.resolve(token);
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      waiting.push(w);
      setTimeout(() => {
        waiting = waiting.filter((x) => x !== w);
        reject(new Error('bot_check'));
      }, 30_000);
    });
  }

  input.addEventListener('focus', () => loadCheck().catch(() => {}), { once: true });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = input.value.trim();
    if (!looksLikeEmail(email)) {
      say(SAY.invalid_email, true);
      input.focus();
      return;
    }
    button.disabled = true;
    say(SAY.sending);
    try {
      await loadCheck();
      const turnstileToken = await nextToken();
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, turnstileToken }),
      });
      const out = await res.json().catch(() => ({ ok: false, reason: 'unavailable' }));
      // a token works once: ask for a fresh one, unless the email was refused before the bot check used it
      if (out.ok || out.reason !== 'invalid_email') {
        token = null;
        window.turnstile.reset(widget);
      }
      if (out.ok) {
        say(SAY.thanks);
        form.reset();
        void showCount();
      } else {
        say(SAY[out.reason] ?? SAY.unavailable, true);
        if (out.reason === 'invalid_email') input.focus();
      }
    } catch (err) {
      say(SAY[err?.message] ?? SAY.unavailable, true);
    } finally {
      button.disabled = false;
    }
  });

  void showCount();
})();
