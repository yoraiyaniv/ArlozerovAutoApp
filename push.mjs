import webpush from 'web-push';
const ALLOWED = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com)\//;
const B64URL = /^[A-Za-z0-9_-]{8,200}$/;
const TITLES = { registered: 'Registered', waitlisted: 'On the waitlist', failed: 'Booking failed', missed: 'Booking missed', cancelled: 'Booking cancelled' };
// The server will POST to this URL, so only genuine browser push services are accepted.
export function validSubscription(s) {
  return !!s && typeof s.endpoint === 'string' && s.endpoint.length <= 1000 && ALLOWED.test(s.endpoint) &&
    B64URL.test(s.keys?.p256dh) && B64URL.test(s.keys?.auth);
}
export function outcomeNotice(job, status, message, live) {
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(job.startsAt);
  const detail = status === 'missed' && !live ? 'Not booked: automatic booking is paused.' : message;
  return { title: `${TITLES[status]}: ${JSON.parse(job.data).name}`, body: `${when}. ${detail}`, tag: job.key, url: '/#activity' };
}
export function createPush(root, { subject = process.env.VAPID_SUBJECT || 'https://github.com/yoraiyaniv/ArlozerovAutoApp', send = (sub, body, options) => webpush.sendNotification(sub, body, options) } = {}) {
  let keys;
  const saved = root.get('vapid');
  if (saved) keys = root.decrypt(saved);
  else { keys = webpush.generateVAPIDKeys(); root.set('vapid', root.encrypt(keys)); }
  const vapidDetails = { subject, publicKey: keys.publicKey, privateKey: keys.privateKey };
  return {
    publicKey: keys.publicKey,
    async notify(store, payload) {
      const body = JSON.stringify(payload);
      await Promise.all(store.pushSubs().map(async sub => {
        try { await send(sub, body, { vapidDetails, TTL: 3600, urgency: 'high', timeout: 10000 }); }
        catch (e) { if ([404, 410].includes(e.statusCode)) store.removePush(sub.endpoint); }
      }));
    }
  };
}
