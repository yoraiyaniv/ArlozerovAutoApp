const $ = selector => document.querySelector(selector);
const ZONE = 'Asia/Jerusalem';
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmt = (ms, options = {}) => new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, ...options }).format(new Date(ms));
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const today = dateFormat.format(new Date());
function shift(date, n) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
let week = shift(today, -new Date(today + 'T12:00:00Z').getUTCDay());
let selectedDate = today, classes = [], state = { rules: [], jobs: [] }, selectedClass, view = 'schedule', calendarRequest = 0;
let upcoming = [], cancellingClass;
let calendarLoading = false, calendarError = '', loadedWeek = null;
const loadedDays = new Map();
let accountGeneration = 0;
function clearAccountData() {
  accountGeneration++; calendarRequest++; classes = []; upcoming = []; loadedDays.clear();
  state = { rules: [], jobs: [], connected: false }; calendarLoading = false; calendarError = ''; loadedWeek = null;
  $('#classes').replaceChildren(el('div', 'empty', 'Sign in to see your classes.'));
  $('#bookings-list').replaceChildren(); $('#rules-list').replaceChildren(); $('#jobs-list').replaceChildren();
  $('#class-count').textContent = '—'; $('#active-count').textContent = '0'; $('#rule-count').textContent = '0';
  $('#member-label').textContent = 'Sign in with Fizikal'; $('#account-label').textContent = 'Your private account';
  $('#mode-banner').textContent = 'Sign in with your own Fizikal account to manage your classes.';
  $('#error').hidden = true;
  for (const d of document.querySelectorAll('dialog[open]')) if (d.id !== 'auth-dialog') d.close();
}
function el(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function error(message) { $('#error').textContent = message || ''; $('#error').hidden = !message; }
async function api(path, options = {}) {
  const generation = accountGeneration;
  const res = await fetch('/api/' + path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.accountId ? { 'X-Arlo-Account': state.accountId } : {}), ...options.headers } });
  const data = await res.json();
  if (generation !== accountGeneration) throw new Error('Your account changed. Please try again.');
  if (!res.ok) {
    if ((res.status === 401 && path !== 'auth') || data.code === 'ACCOUNT_CHANGED') { clearAccountData(); if (!$('#auth-dialog').open) $('#auth-dialog').showModal(); }
    throw new Error(data.error || 'Request failed');
  }
  return data;
}
async function refreshState() {
  const next = await api('state');
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  state = next;
  if (changed) renderState();
}
function renderState() {
  $('#rule-count').textContent = state.rules.length;
  $('#active-count').textContent = state.rules.filter(r => r.enabled && !r.once).length;
  $('#member-label').textContent = state.connected ? (state.member || 'Club account connected') : 'Connect your account';
  $('#account-label').textContent = state.connected ? 'Manage connection' : 'Fizikal membership';
  $('#disconnect').hidden = !state.connected;
  $('#mode-banner').classList.toggle('live', state.live && state.connected);
  $('#mode-banner').textContent = !state.live ? (state.connected ? 'Fizikal connected · One-time registration is available. Automatic weekly booking is paused.' : 'Connect your Fizikal account to register. Automatic weekly booking is paused.') : state.connected ? 'Fizikal connected · Weekly booking is enabled.' : 'Connect your Fizikal account to activate registration.';
  if (state.syncError) $('#mode-banner').textContent += ' Schedule sync needs attention: ' + state.syncError;
  renderRules(); renderJobs(); renderClasses();
}
async function loadCalendar(force = false, attempt = 0) {
  const request = ++calendarRequest, start = selectedDate, generation = accountGeneration;
  const savedDay = loadedDays.get(start);
  if (!force && savedDay && Date.now() - savedDay.fetchedAt < 30000) {
    calendarLoading = false; calendarError = ''; renderDays(); renderClasses(); return;
  }
  calendarLoading = true; calendarError = '';
  $('#refresh').disabled = true;
  renderClasses();
  renderDays(); error('');
  try {
    const data = await api('calendar?start=' + start + '&days=1' + (force ? '&refresh=1' : ''));
    if (request !== calendarRequest) return;
    loadedDays.set(start, data);
    classes = [...classes.filter(a => a.date !== start), ...data.classes];
    loadedWeek = start; calendarLoading = false;
    $('#class-count').textContent = classes.filter(a => a.date >= week && a.date <= shift(week, 6)).length;
    $('#sync-label').textContent = (data.stale ? 'Saved schedule · updated ' : 'Live schedule · updated ') + fmt(data.fetchedAt, { hour: '2-digit', minute: '2-digit' });
    // An old saved copy is refreshing on the server; pick up the result quietly before warning.
    if (data.stale && !data.failed && attempt < 3) setTimeout(() => { if (selectedDate === start && generation === accountGeneration) loadCalendar(false, attempt + 1); }, 6000);
    else if (data.stale) error('Fizikal is responding slowly. Showing the last saved schedule; availability will be checked when you register.');
    const value = $('#type-filter').value;
    $('#type-filter').replaceChildren(new Option('All classes', ''));
    [...new Set(classes.map(a => a.name))].sort((a, b) => a.localeCompare(b, 'he')).forEach(name => $('#type-filter').add(new Option(name, name)));
    $('#type-filter').value = value;
    renderClasses();
  } catch (e) { if (request === calendarRequest) { calendarError = 'Fizikal could not return the schedule. Use Refresh to try again.'; error(e.message); } }
  finally { if (request === calendarRequest) { calendarLoading = false; $('#refresh').disabled = false; renderClasses(); } }
}
function renderDays() {
  const start = new Date(week + 'T12:00:00Z'), end = new Date(shift(week, 6) + 'T12:00:00Z');
  $('#week-label').textContent = `${fmt(start, { day: 'numeric', month: 'short' })} – ${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  $('#days').replaceChildren();
  days.forEach((day, i) => {
    const date = shift(week, i), button = el('button', 'day' + (date === selectedDate ? ' selected' : '') + (date === today ? ' is-today' : ''));
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', date === selectedDate ? 'true' : 'false');
    button.append(el('small', '', day.slice(0, 3)), el('strong', '', Number(date.slice(-2))));
    button.onclick = () => { selectedDate = date; loadCalendar(); };
    $('#days').append(button);
  });
  $('#day-label').textContent = fmt(new Date(selectedDate + 'T12:00:00Z'), { weekday: 'long', day: 'numeric', month: 'long' });
}
const statuses = { 0: 'Full', 1: 'Waitlist available', 2: 'Registered', 3: 'Open for booking', 4: 'On waitlist', 5: 'Few places left', 6: 'Not open yet', 7: 'Booking closed', 8: 'Registered', 9: 'Reminder set', 10: 'Waitlist place ready' };
function renderClasses() {
  const q = $('#search').value.toLocaleLowerCase().trim(), type = $('#type-filter').value;
  const filtered = classes.filter(a => a.date === selectedDate && (!type || a.name === type) && (!q || (a.name + ' ' + a.instructor).toLocaleLowerCase().includes(q))).sort((a, b) => a.startsAt - b.startsAt);
  $('#result-count').textContent = `${filtered.length} classes`;
  const list = $('#classes'); list.replaceChildren();
  if (!filtered.length) return list.append(el('div', 'empty', calendarLoading ? 'Loading this day’s classes from Fizikal…' : calendarError || (loadedDays.has(selectedDate) ? 'No classes match this day and filter.' : 'Choose Refresh to load this day’s schedule.')));
  for (const a of filtered) {
    const full = [0, 1].includes(a.status);
    const row = el('article', 'class-row' + (full ? ' is-full' : ''));
    const time = el('div', 'class-time'); time.append(el('strong', '', a.time), el('small', '', `${a.duration} min`));
    const stripe = el('div', 'class-stripe' + (/יוגה/.test(a.name) ? ' yoga' : /פילאטיס|מכשירים|לאטיס/.test(a.name) ? ' pilates' : /מים|בריכה|שחייה/.test(a.name) ? ' water' : ''));
    const details = el('div', 'class-details'), title = el('h3', '', a.name), meta = el('p', '', [a.instructor, a.location].filter(Boolean).join(' · '));
    title.dir = 'auto'; meta.dir = 'auto'; details.append(title, meta);
    const occupancy = a.registered !== null && a.registered !== undefined && a.capacity ? `${a.registered} / ${a.capacity} registered` : 'Registration count unavailable';
    const capacity = el('div', 'occupancy');
    capacity.append(el('span', '', occupancy));
    if (full) capacity.append(el('span', 'full-badge', 'Full'));
    details.append(capacity);
    const status = el('span', 'status' + ([3, 5].includes(a.status) ? ' open' : '')); status.append(el('i'), el('span', '', statuses[a.status] || 'Check Fizikal'));
    const saved = state.rules.find(r => r.lessonId === a.lessonId && r.weekday === a.weekday && r.time === a.time);
    const manual = a.paid || a.seatsMap;
    const registered = [2, 4, 8, 10].includes(a.status);
    const button = el('button', 'repeat' + (registered ? ' saved' : '') + (full ? ' waitlist-button' : ''), registered ? 'View booking' : manual ? 'Manual booking' : a.status === 1 ? 'Join waitlist' : a.status === 0 ? 'Full · No waitlist' : 'Register');
    button.disabled = manual || a.status === 0; button.title = manual ? 'This class needs a purchase or seat selection on Fizikal' : a.status === 0 ? 'The club does not offer a waitlist for this class' : '';
    button.onclick = () => registered ? setView('upcoming') : openRule(a);
    row.append(time, stripe, details, status, button); list.append(row);
  }
}
function track(event) { api('ab/event', { method: 'POST', body: JSON.stringify({ event }) }).catch(() => {}); }
function openRule(a) {
  selectedClass = a; $('#rule-form').reset(); $('#rule-error').textContent = '';
  const notOpen = a.status === 6 && a.dueAt > Date.now();
  $('#scheduled-option').hidden = !notOpen;
  if (notOpen) $('[name="booking-mode"][value="scheduled"]').checked = true;
  else if (state.abVariant === 'B') $('[name="booking-mode"][value="recurring"]').checked = true;
  track('dialog_opened');
  $('#waitlist').checked = a.status === 1;
  const title = el('strong', '', a.name); title.dir = 'auto';
  $('#rule-summary').replaceChildren(title, el('div', '', fmt(a.startsAt, { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ` · ${a.duration} minutes`), el('div', '', a.instructor));
  $('#next-booking').textContent = a.dueAt > Date.now() ? 'Next target: ' + fmt(a.dueAt, { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' (Israel time)' : 'This occurrence’s booking target has passed. The routine starts with the next future opening window.';
  const w = a.clubWindow;
  const differs = w && (w.NumberOfDays * 1440 + w.NumberOfMinutes !== 1440);
  $('#window-note').textContent = differs ? `The club lists a different opening window (${w.NumberOfDays} days, ${w.NumberOfMinutes} minutes before). Your routine will still target exactly 24 hours before class.` : 'You can pause or remove this routine at any time.';
  updateBookingMode(); $('#rule-dialog').showModal();
}
function updateBookingMode() {
  const mode = $('[name="booking-mode"]:checked').value, single = mode === 'single', scheduled = mode === 'scheduled', recurring = mode === 'recurring';
  $('#recurring-options').hidden = single;
  $('#recurring-options strong').textContent = scheduled ? '↻    Once, 24 hours before' : '↻    Every week, 24 hours before';
  $('#pin-instructor').parentElement.hidden = scheduled;
  $('#single-note').hidden = !single;
  const waitlisting = selectedClass.status === 1;
  $('#waitlist').disabled = single && waitlisting;
  if (single && waitlisting) $('#waitlist').checked = true;
  $('#single-note').textContent = waitlisting ? 'This class is full. This sends a request to join its waitlist on Fizikal.' : 'This sends a real registration request to Fizikal for this class only. ' + (statuses[selectedClass.status] || '');
  const exists = scheduled ? state.rules.some(r => r.once === selectedClass.key) : state.rules.some(r => !r.once && r.lessonId === selectedClass.lessonId && r.weekday === selectedClass.weekday && r.time === selectedClass.time);
  $('#register-submit').textContent = scheduled ? (exists ? 'Already scheduled' : 'Register me when it opens') : recurring ? (exists ? 'Weekly routine already exists' : 'Enable weekly routine') : waitlisting ? 'Join waitlist' : 'Register for this class';
  $('#register-submit').disabled = scheduled || recurring ? exists : !state.connected || ![1, 3, 5].includes(selectedClass.status) || selectedClass.startsAt <= Date.now();
}
document.querySelectorAll('[name="booking-mode"]').forEach(input => { input.onchange = updateBookingMode; });
$('#rule-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('#rule-error').textContent = '';
  try {
    const mode = $('[name="booking-mode"]:checked').value, recurring = mode === 'recurring', scheduled = mode === 'scheduled';
    const result = await api(recurring || scheduled ? 'rules' : 'bookings/register', { method: 'POST', body: JSON.stringify({ key: selectedClass.key, date: selectedClass.date, start: week, waitlist: $('#waitlist').checked, pinInstructor: !scheduled && $('#pin-instructor').checked, ...(scheduled ? { once: true } : {}) }) });
    $('#rule-dialog').close();
    if (!scheduled) track(recurring ? 'rule_created' : 'single_booked');
    toast(scheduled ? (state.live ? 'Scheduled. We’ll register you 24 hours before class.' : 'Saved, but automatic booking is paused, so nothing will be booked.') : recurring ? (state.live ? 'Weekly routine saved' : 'Routine saved. Automatic weekly booking is paused.') : result.status === 'waitlisted' ? 'Waitlist confirmed by Fizikal' : 'Registration confirmed by Fizikal');
    refreshState().catch(() => {});
    if (scheduled) await setView('rules'); else if (!recurring) { await setView('upcoming'); }
  } catch (e) { $('#rule-error').textContent = e.message; }
  finally { button.disabled = false; }
};
function renderRules() {
  const list = $('#rules-list'); list.replaceChildren();
  if (!state.rules.length) return list.append(el('div', 'empty', 'No recurring classes yet. Choose Register, then Repeat weekly, on a class.'));
  for (const r of state.rules) {
    const card = el('article', 'rule-card'), info = el('div'), title = el('h3', '', r.name); title.dir = 'auto';
    info.append(title, el('p', '', (r.once ? `One time · ${fmt(r.startsAt, { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : `Every ${days[r.weekday]} at ${r.time}`) + ` · ${r.enabled ? 'Active' : 'Paused'}`), el('p', '', `Books 24 hours before · ${r.waitlist ? 'Waitlist enabled' : 'No waitlist'} · ${r.pinInstructor ? 'Instructor pinned' : 'Any scheduled instructor'}`));
    const next = state.jobs.filter(j => j.ruleId === r.id && ['pending', 'retry', 'running'].includes(j.status)).sort((a,b) => a.dueAt-b.dueAt)[0];
    info.append(el('p', '', next ? 'Next attempt: ' + fmt(next.dueAt, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Next opening will appear after schedule sync.'));
    const actions = el('div', 'card-actions'), toggle = el('button', '', r.enabled ? 'Ⅱ  Pause' : '▶  Resume'), remove = el('button', '', 'Remove');
    toggle.onclick = async () => { try { await api('rules/' + r.id, { method: 'PATCH', body: JSON.stringify({ enabled: !r.enabled }) }); await refreshState(); toast(r.enabled ? 'Routine paused. Existing bookings remain.' : 'Routine resumed. Future openings will be queued.'); } catch (e) { error(e.message); } };
    remove.onclick = async () => { try { await api('rules/' + r.id, { method: 'DELETE' }); await refreshState(); toast('Routine removed. Existing club bookings remain.'); } catch (e) { error(e.message); } };
    actions.append(toggle, remove); card.append(info, actions); list.append(card);
  }
}
function renderJobs() {
  const list = $('#jobs-list'); list.replaceChildren();
  if (!state.jobs.length) return list.append(el('div', 'empty', 'No booking attempts yet. Upcoming targets appear here after you add a routine.'));
  for (const j of [...state.jobs].sort((a,b) => a.dueAt-b.dueAt)) {
    const card = el('article', 'job-card'), info = el('div'), title = el('h3', '', j.data.name); title.dir = 'auto';
    info.append(title, el('p', '', 'Class: ' + fmt(j.startsAt, { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })), el('p', '', 'Booking target: ' + fmt(j.dueAt, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · Israel time'), el('p', '', j.message || (state.live ? 'Waiting for the opening window' : 'Preview only — no booking request will be sent')));
    card.append(info, el('span', 'job-status ' + j.status, j.status.replaceAll('_', ' '))); list.append(card);
  }
}
function setView(name) {
  view = name;
  const titles = { upcoming: ['Your upcoming classes', 'Confirmed registrations and waitlist places, straight from Fizikal.'], schedule: ['Your week starts here', 'Find your rhythm. Turn the classes you love into a weekly routine.'], rules: ['Your recurring classes', 'Manage, pause, or remove your weekly registrations.'], activity: ['Every booking, in view', 'See upcoming targets, registration attempts, and confirmed results.'] };
  for (const key of Object.keys(titles)) $('#' + key + '-view').hidden = key !== name;
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  $('#breadcrumb').textContent = { upcoming: 'UPCOMING CLASSES', schedule: 'CLASS SCHEDULE', rules: 'RECURRING CLASSES', activity: 'BOOKING ACTIVITY' }[name];
  $('#page-title').replaceChildren(document.createTextNode(titles[name][0]), el('span', '', '.'));
  $('#page-description').textContent = titles[name][1]; $('#refresh').hidden = name !== 'schedule';
  if (name === 'upcoming') return loadBookings();
}
async function loadBookings() {
  $('#refresh-bookings').disabled = true;
  $('#bookings-list').replaceChildren(el('div', 'empty', 'Checking your bookings with Fizikal…'));
  try {
    if (!state.connected) throw new Error('Connect your Fizikal account to see upcoming classes.');
    const data = await api('bookings'); upcoming = data.classes;
    renderBookings(); error('');
  } catch (e) { $('#bookings-list').replaceChildren(el('div', 'empty', e.message)); }
  finally { $('#refresh-bookings').disabled = false; }
}
function renderBookings() {
  const list = $('#bookings-list'); list.replaceChildren();
  if (!upcoming.length) return list.append(el('div', 'empty', 'No upcoming registrations or waitlist places in the next 60 days.'));
  for (const a of upcoming.sort((a,b) => a.startsAt-b.startsAt)) {
    const card = el('article', 'rule-card'), info = el('div'), title = el('h3', '', a.name); title.dir = 'auto';
    info.append(title, el('p', '', fmt(a.startsAt, { weekday:'long', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })), el('p', '', [a.instructor, a.location].filter(Boolean).join(' · ')), el('p', '', statuses[a.status]));
    const cancel = el('button', 'button danger', a.status === 8 ? 'Cancellation closed' : 'Cancel class'); cancel.disabled = a.status === 8;
    cancel.onclick = () => {
      cancellingClass = a; $('#cancel-error').textContent = '';
      $('#cancel-summary').replaceChildren(el('strong', '', a.name), el('div', '', fmt(a.startsAt, { weekday:'long', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })));
      $('#cancel-dialog').showModal();
    };
    card.append(info, cancel); list.append(card);
  }
}
$('#refresh-bookings').onclick = loadBookings;
$('#cancel-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    await api('bookings/cancel', { method:'POST', body:JSON.stringify({ key:cancellingClass.key, date:cancellingClass.date }) });
    $('#cancel-dialog').close(); toast('Cancellation confirmed by Fizikal'); await refreshState(); await loadBookings();
  } catch (e) { $('#cancel-error').textContent = e.message; }
  finally { button.disabled = false; }
};
document.querySelectorAll('.nav').forEach(n => { n.onclick = () => setView(n.dataset.view); });
document.querySelectorAll('[data-close]').forEach(n => { n.onclick = () => $('#' + n.dataset.close).close(); });
$('#prev-week').onclick = () => { week = shift(week, -7); selectedDate = week; loadCalendar(); };
$('#next-week').onclick = () => { week = shift(week, 7); selectedDate = week; loadCalendar(); };
$('#today').onclick = () => { week = shift(today, -new Date(today + 'T12:00:00Z').getUTCDay()); selectedDate = today; loadCalendar(); };
$('#refresh').onclick = async () => { await loadCalendar(true); try { await refreshState(); } catch (e) { error(e.message); } };
$('#search').oninput = renderClasses; $('#type-filter').onchange = renderClasses;
$('#account-button').onclick = () => { $('#account-form').reset(); $('#account-error').textContent = ''; $('#account-dialog').showModal(); };
$('#account-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const fields = new FormData(event.target);
    await api('account', { method: 'POST', body: JSON.stringify({ phone: fields.get('phone'), password: fields.get('password') }) });
    event.target.reset(); $('#account-dialog').close(); await refreshState(); await loadCalendar(); toast('Club account connected');
  } catch (e) { $('#account-error').textContent = e.message; }
  finally { button.disabled = false; }
};
$('#disconnect').onclick = async () => {
  try { await api('account', { method: 'DELETE' }); clearAccountData(); $('#auth-dialog').showModal(); toast('Account disconnected on all phones and routines paused'); } catch (e) { $('#account-error').textContent = e.message; }
};
$('#signout').onclick = async () => {
  try { await api('logout', { method: 'POST' }); clearAccountData(); $('#auth-form').reset(); $('#auth-error').textContent = ''; $('#auth-dialog').showModal(); toast('Signed out on this phone. Your weekly routines continue.'); }
  catch (e) { $('#account-error').textContent = e.message; }
};
$('#auth-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const fields = new FormData(event.target); await api('auth', { method: 'POST', body: JSON.stringify({ phone: fields.get('phone'), password: fields.get('password') }) }); event.target.reset(); clearAccountData(); $('#auth-dialog').close(); await initialize(); toast('Signed in. This phone will stay connected.'); }
  catch (e) { $('#auth-error').textContent = e.message; } finally { button.disabled = false; }
};
$('#auth-dialog').addEventListener('cancel', event => event.preventDefault());
async function initialize() { try { await refreshState(); await loadCalendar(); } catch (e) { if (!$('#auth-dialog').open) error(e.message); } }
renderDays(); initialize();
setInterval(() => { if (!document.hidden && !$('#auth-dialog').open) refreshState().catch(() => {}); }, 15000);
