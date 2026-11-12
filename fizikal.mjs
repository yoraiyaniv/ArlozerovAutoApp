import { normalize, shiftDate } from './time.mjs';
const COBR = 'JpcTNAEJt1VDUX3aoF9kYxpak8GAd7fp4B3bcf6BRFE=';
const ROOT = 'https://m.fizikal.co.il';
export class Fizikal {
  constructor() { this.session = null; this.config = null; this.dayCache = new Map(); this.dayLoads = new Map(); this.retryDelay = 400; }
  async setup() {
    if (this.config) return;
    const res = await fetch(`${ROOT}/website/NavJsHandler.aspx?cobr=${encodeURIComponent(COBR)}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('Could not read club configuration');
    const text = await res.text();
    const read = key => {
      const value = text.match(new RegExp(`OlConfig\\.${key}\\s*=\\s*'([^']+)'`))?.[1];
      if (!value) throw new Error('Club configuration changed');
      return value;
    };
    const server = read('SERVER_URL');
    if (server !== `${ROOT}/wsw`) throw new Error('Unexpected booking service URL');
    this.config = { server, headers: { SYSTEM: read('SYSTEM'), USER_NAME: read('USER_NAME'), PASSWORD: read('PASSWORD'), APP_TYPE: 'Web', CLIENT_VERSION: '2', 'system-id': 'www', 'access-source': 'direct', 'Content-Type': 'application/json' } };
  }
  async call(path, params = {}, method = 'GET', body, session = this.session, retry = true) {
    await this.setup();
    const url = new URL(this.config.server + path);
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    // Reads are safe to repeat, so retry dropped connections and club 5xx errors. Writes are never replayed blindly.
    const tries = method === 'GET' ? 3 : 1;
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(url, { method, headers: { ...this.config.headers, ...(session?.token ? { TOKEN: session.token } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}), signal: AbortSignal.timeout(method === 'GET' ? 45000 : 20000) });
        if (!(res.status >= 500) || attempt >= tries) break;
      } catch (e) {
        if (attempt >= tries || e.name === 'TimeoutError' || e.name === 'AbortError') throw e;
      }
      await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
    }
    if (!res.ok) throw new Error(`Club service returned HTTP ${res.status}`);
    const data = await res.json();
    if (data.ResultCode !== 1) {
      if (data.ResultCode === 2 && method === 'GET' && session && retry && this.reauthenticate) {
        this.session = null; this.dayCache.clear();
        if (await this.reauthenticate()) return this.call(path, { ...params, ...('userId' in params ? { userId: this.session.userId } : {}) }, method, body, this.session, false);
      }
      const error = new Error(String(data.Message || data.ErrorMessage || 'The club rejected this request').slice(0, 250));
      error.code = data.ResultCode;
      throw error;
    }
    return data.Data;
  }
  async login(phone, password) {
    const info = await this.call('/JLoginService.svc/UserThin', {}, 'POST', { MainCompanyID: 230, MainBranchID: 23, CompanyID: 230, BranchID: 23, ClientType: 'Web', Password: password, UserIDs: [phone.replace(/[ -]/g, '')], VerifyCode: null, Type: 0, ClientVersion: 2 }, null);
    const branches = [info.MainBranch, ...(info.OtherBranches || [])].filter(b => b?.CompanyID === 230 && b.ID === 23 && b.LoggedUser?.ID);
    if (!info.Token || branches.length !== 1) throw new Error(branches.length > 1 ? 'Multiple family members found. Member selection needs to be added before booking.' : 'Login did not return a member at this club');
    this.session = { token: info.Token, userId: branches[0].LoggedUser.ID, name: branches[0].LoggedUser.FirstName || 'Member' };
    return { name: this.session.name };
  }
  async calendar(start, end, guest = false, fresh = false) {
    const dates = [];
    for (let date = start; date <= end; date = shiftDate(date, 1)) { dates.push(date); if (dates.length > 90) throw new Error('Schedule range too large'); }
    let cursor = 0;
    const result = new Array(dates.length);
    await Promise.all(Array.from({ length: Math.min(3, dates.length) }, async () => {
      while (cursor < dates.length) { const i = cursor++; result[i] = await this.calendarDay(dates[i], guest, fresh); }
    }));
    return result.flat();
  }
  async calendarDay(start, guest = false, fresh = false) {
    const cacheKey = `${guest ? 'guest' : this.session?.userId || 'guest'}:${start}`;
    const cached = this.dayCache.get(cacheKey);
    // A booking attempt must see the club's status right now, never a copy up to 15 seconds old or one already in flight.
    if (!fresh && cached && Date.now() - cached.at < 15000) return cached.classes;
    if (!fresh && this.dayLoads.has(cacheKey)) return this.dayLoads.get(cacheKey);
    const task = this.fetchCalendarDay(start, guest).then(classes => { this.dayCache.set(cacheKey, { at: Date.now(), classes }); return classes; }).finally(() => { if (this.dayLoads.get(cacheKey) === task) this.dayLoads.delete(cacheKey); });
    this.dayLoads.set(cacheKey, task);
    return task;
  }
  async fetchCalendarDay(start, guest = false) {
    const end = start;
    const params = { companyId: 230, branchId: 23, moduleId: 11, userId: guest ? null : this.session?.userId, start: start.replaceAll('-', '/'), end: end.replaceAll('-', '/'), preferred: false };
    const data = await this.call('/JActivityService.svc/Calendar', params, 'GET', undefined, guest ? null : this.session);
    if (!Array.isArray(data)) throw new Error('Unexpected club schedule response');
    return data.map(normalize);
  }
  async register(a, waitlist = false) {
    if (!this.session) throw new Error('Connect your club account first');
    if (a.paid || a.seatsMap || a.raw.RequireReserve || a.raw.HasCourt) throw new Error('This class needs a purchase, seat, or reservation selection. Book it on Fizikal.');
    const params = { companyId: 230, branchId: 23, userId: this.session.userId, lessonId: a.lessonId, date: a.date.replaceAll('-', '/'), time: a.raw.StartHour, instructorId: a.instructorId, activityId: a.activityId };
    if (!waitlist) params.seatId = '';
    try { return await this.call(`/JActivityService.svc/${waitlist ? 'Waitlist' : 'User'}`, params, 'PUT', {}); }
    finally { this.dayCache.clear(); }
  }
  async upcoming(start, end) {
    if (!this.session) throw new Error('Connect your club account first');
    const data = await this.call('/JActivityService.svc/User', { companyId: 230, branchId: 23, userId: this.session.userId, start: start.replaceAll('-', '/'), end: end.replaceAll('-', '/'), preferred: false });
    if (!Array.isArray(data)) throw new Error('Unexpected member bookings response');
    return data.map(normalize).filter(a => a.startsAt > Date.now() && [2, 4, 8, 10].includes(a.status));
  }
  async cancel(a) {
    if (!this.session) throw new Error('Connect your club account first');
    if (a.status === 8) throw new Error('The club cancellation deadline has passed. Contact the club.');
    if (![2, 4, 10].includes(a.status)) throw new Error('This class is not currently booked');
    try { await this.call(`/JActivityService.svc/${[4, 10].includes(a.status) ? 'Waitlist' : 'User2'}`, {
      companyId: 230, branchId: 23, userId: this.session.userId, lessonId: a.lessonId,
      date: a.date.replaceAll('-', '/'), time: a.raw.StartHour, instructorId: a.instructorId, activityId: a.activityId
    }, 'DELETE'); } finally { this.dayCache.clear(); }
  }
}
