import { shiftDate } from './time.mjs';
export const booked = a => a && [2, 4, 8, 10].includes(a.status);
async function confirmation(client, key, date) {
  const classes = client.upcoming ? await client.upcoming(date, shiftDate(date, 1)) : await client.calendar(date, date);
  return classes.find(a => a.key === key);
}
export async function singleBooking(client, key, date, waitlist = false) {
  const current = (await client.calendar(date, date)).find(a => a.key === key);
  if (!current || current.startsAt <= Date.now()) throw new Error('This class is no longer available');
  if (booked(current)) return { status: [4, 10].includes(current.status) ? 'waitlisted' : 'registered', already: true };
  if (![3, 5].includes(current.status) && !(current.status === 1 && waitlist)) throw new Error(current.status === 1 ? 'Class full. Enable the waitlist option to join it.' : 'The club is not accepting registrations for this class');
  let writeError;
  try { await client.register(current, current.status === 1 && waitlist); } catch (e) { writeError = e; }
  // Reconcile even when the network response is lost. Never repeat a mutation automatically.
  const after = await confirmation(client, key, date);
  if (booked(after)) return { status: [4, 10].includes(after.status) ? 'waitlisted' : 'registered', name: after.name, startsAt: after.startsAt };
  throw writeError || new Error('Registration is not confirmed. Refresh Upcoming classes before trying again.');
}
export async function cancelBooking(client, key, date) {
  const current = (await client.calendar(date, date)).find(a => a.key === key);
  if (!booked(current)) return { status: 'cancelled', already: true };
  let writeError;
  try { await client.cancel(current); } catch (e) { writeError = e; }
  const after = await confirmation(client, key, date);
  if (!booked(after)) return { status: 'cancelled', name: current.name, startsAt: current.startsAt };
  throw writeError || new Error('Cancellation is not confirmed. The class is still booked.');
}
