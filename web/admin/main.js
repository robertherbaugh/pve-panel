import {
  $, esc, api, toast, fail, confirmAction, promptText, SignedOut, setUnauthorizedHandler,
} from '/shared/ui.js';
import { createAdmin } from '/admin.js';
import { brandMark, applyBrand } from '/shared/icons.js';
import { signInSecondStep } from '/shared/twofa.js';
import { prepareSignIn, resumeSso } from '/shared/signin.js';

applyBrand('Administration');
document.querySelectorAll('[data-brand-mark]').forEach((el) => { el.innerHTML = brandMark(28); });

let me = null;
const shell = $('#app-view');
const menuToggle = $('#admin-menu-toggle');
const compactNavigation = window.matchMedia('(max-width: 860px)');

function setNavigationOpen(open) {
  shell.classList.toggle('nav-open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
}
menuToggle.addEventListener('click', () => setNavigationOpen(!shell.classList.contains('nav-open')));
shell.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && shell.classList.contains('nav-open')) {
    setNavigationOpen(false);
    menuToggle.focus();
  }
});
shell.addEventListener('click', (event) => {
  if (!event.target.closest('.admin-sidebar')) setNavigationOpen(false);
});
compactNavigation.addEventListener('change', () => setNavigationOpen(false));

function resetLogin() {
  const box = $('#login-2fa');
  box.hidden = true;
  box.innerHTML = '';
  $('#login-form').hidden = false;
  $('#login-form [name=email]').focus();
}

const signInReady = prepareSignIn($('#login-form'), {
  onSignedIn: (account) => { resetLogin(); start(account); },
});

async function showLogin() {
  setNavigationOpen(false);
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  resetLogin();
  await signInReady;
  resumeSso({
    form: $('#login-form'),
    box: $('#login-2fa'),
    errorEl: $('#login-error'),
    onSignedIn: (account) => { resetLogin(); start(account); },
    onRestart: resetLogin,
  });
}
setUnauthorizedHandler(showLogin);

const admin = createAdmin({
  root: $('#admin-view'),
  navigation: $('#admin-nav'),
  api, toast, fail, confirmAction, promptText, esc,
  getMe: () => me,
  onAbout: showVersion,
  onNavigate: () => {
    const wasOpen = shell.classList.contains('nav-open');
    setNavigationOpen(false);
    if (wasOpen && compactNavigation.matches) $('#admin-page-title').focus();
  },
});

/** Version in the top bar; a dot when a newer release is available. */
function showVersion(about) {
  const badge = $('#version-badge');
  const update = about.update?.updateAvailable;
  badge.hidden = false;
  badge.classList.toggle('has-update', !!update);
  badge.textContent = `v${about.version}`;
  badge.title = update ? `Version ${about.update.latest.version} is available` : 'About this version';
}
$('#version-badge').addEventListener('click', () => admin.openTab('about'));

function start(account) {
  me = account;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#account-email').textContent = me.email;
  admin.open();
  api('/api/admin/about').then(showVersion).catch(() => {});
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $('#login-error');
  err.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const email = form.email.value;
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: form.password.value },
    });
    form.reset();
    if (r.twoFactor) {
      form.hidden = true;
      const box = $('#login-2fa');
      box.hidden = false;
      signInSecondStep(box, {
        stage: r.twoFactor,
        email,
        onSignedIn: (account) => { resetLogin(); start(account); },
        onRestart: resetLogin,
      });
    } else {
      start(r);
    }
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    button.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  me = null;
  showLogin();
});

api('/api/auth/me').then(start).catch((err) => {
  if (!(err instanceof SignedOut)) showLogin();
});
