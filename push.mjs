import webpush from 'web-push';
const ALLOWED = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com)\//;
const B64URL = /^[A-Za-z0-9_-]{8,200}$/;
const TITLES = { starting: 'Booking now', retrying: 'Retrying', registered: 'Registered', waitlisted: 'On the waitlist', failed: 'Booking failed', missed: 'Booking missed', cancelled: 'Booking cancelled' };
// The server will POST to this URL, so only genuine browser push services are accepted.
export function validSubscription(s) {
  return !!s && typeof s.endpoint === 'string' && s.endpoint.length <= 1000 && ALLOWED.test(s.endpoint) &&
    B64URL.test(s.keys?.p256dh) && B64URL.test(s.keys?.auth);
}
const when = ms => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);
// A registration or cancellation the member made by hand, confirmed by the club.
export function manualNotice(result, key) {
  const text = { registered: ['Registered', 'Registration confirmed by the club.'], waitlisted: ['On the waitlist', 'Waitlist confirmed by the club.'], cancelled: ['Cancelled', 'Cancellation confirmed by the club.'] }[result.status];
  return { title: `${text[0]}: ${result.name}`, body: `${when(result.startsAt)}. ${text[1]}`, tag: key, url: '/#activity' };
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// A routine or one-time booking being saved, paused, resumed or removed.
export function ruleNotice(kind, rule, live) {
  const what = rule.once ? `${when(rule.startsAt)}` : `Every ${DAYS[rule.weekday]} at ${rule.time}`;
  const text = {
    saved: [rule.once ? 'Scheduled' : 'Weekly routine saved', live ? `${what}. We register you 24 hours before class.` : `${what}. Automatic booking is paused, so nothing will be booked.`],
    paused: ['Routine paused', `${what}. Existing bookings stay.`],
    resumed: ['Routine resumed', `${what}. Future openings are queued again.`],
    removed: ['Routine removed', `${what}. Existing bookings stay.`]
  }[kind];
  return { title: `${text[0]}: ${rule.name}`, body: text[1], tag: `rule:${rule.id}`, url: '/#rules' };
}
export function outcomeNotice(job, status, message, live) {
  const detail = status === 'missed' && !live ? 'Not booked: automatic booking is paused.' : message;
  return { title: `${TITLES[status]}: ${JSON.parse(job.data).name}`, body: `${when(job.startsAt)}. ${detail}`, tag: job.key, url: '/#activity' };
}
export function createPush(root, { subject = process.env.VAPID_SUBJECT || 'https://github.com/yoraiyaniv/ArlozerovAutoApp', send = (sub, body, options) => webpush.sendNotification(sub, body, options), log = console.error } = {}) {
  let keys;
  const saved = root.get('vapid');
  if (saved) keys = root.decrypt(saved);
  else { keys = webpush.generateVAPIDKeys(); root.set('vapid', root.encrypt(keys)); }
  const vapidDetails = { subject, publicKey: keys.publicKey, privateKey: keys.privateKey };
  return {
    publicKey: keys.publicKey,
    async notify(store, payload) {
      const body = JSON.stringify(payload);
      return Promise.all(store.pushSubs().map(async sub => {
        const host = new URL(sub.endpoint).host;
        try { await send(sub, body, { vapidDetails, TTL: 3600, urgency: 'high', timeout: 10000 }); return { host, ok: true }; }
        catch (e) {
          if ([404, 410].includes(e.statusCode)) store.removePush(sub.endpoint);
          const message = String(e.body || e.message).slice(0, 200);
          log(`Push to ${host} failed (${e.statusCode ?? 'no response'}): ${message}`);
          return { host, ok: false, status: e.statusCode, message };
        }
      }));
    }
  };
}
