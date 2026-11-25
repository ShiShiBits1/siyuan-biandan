const CLIENT_ID = '5765880207852987515';
const REDIRECT_URI = 'https://www.biandangroup.com/#/biandan_online';
const CALLBACK_PORT = 42681;
const CALLBACK_PATH = '/biandan/callback';
const AUTHORIZE_URL = 'https://oauth-login.cloud.huawei.com/oauth2/v3/authorize';
const TOKEN_URL = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token';
const RENEWAL_ROOT = 'https://auth.biandangroup.com/v1';

export class BiandanAuthError extends Error {
  constructor(message, code = 'AUTH_ERROR') { super(message); this.name = 'BiandanAuthError'; this.code = code; }
}

/** Desktop-only OAuth. Persisted state contains encrypted refresh credentials;
 * access tokens and PKCE material never enter plugin data or diagnostic output. */
export function createBiandanAuth({
  fetcher = globalThis.fetch, loadState = async () => null, saveState = async () => {},
  openExternal, nodeRequire = globalThis.require, timeoutMs = 300000, requestTimeoutMs = 30000,
} = {}) {
  let disposed = false, generation = 0, loaded = false, loading;
  let credentials = null, accessToken = '', expiresAt = 0;
  let connecting = null, refreshing = null, cancelAuthorization = null;
  let saveQueue = Promise.resolve();
  const requests = new Set();
  const error = (message, code) => new BiandanAuthError(message, code);
  const current = epoch => {
    if (disposed || epoch !== generation) throw error('授权流程已结束，请重新连接。', 'AUTH_CANCELLED');
  };
  function requireDesktop(name) {
    if (typeof nodeRequire !== 'function') throw error('请在思源桌面客户端中连接便单。', 'DESKTOP_REQUIRED');
    try { return nodeRequire(name); } catch { throw error('当前桌面环境缺少便单授权所需组件。', 'DESKTOP_REQUIRED'); }
  }
  function secureStorage() {
    const electron = requireDesktop('electron');
    let storage = electron.safeStorage || electron.remote?.safeStorage;
    if (!storage) {
      try { storage = nodeRequire('@electron/remote').safeStorage; } catch { /* Optional renderer bridge. */ }
    }
    if (!storage?.isEncryptionAvailable?.() || typeof storage.encryptString !== 'function' || typeof storage.decryptString !== 'function') {
      throw error('当前思源环境无法使用系统加密存储，未保存任何明文凭据。', 'SECURE_STORAGE_UNAVAILABLE');
    }
    // Electron's basic_text backend does not provide an OS-protected secret store.
    if (storage.getSelectedStorageBackend?.() === 'basic_text') throw error('请先配置系统密钥库，再连接便单。', 'SECURE_STORAGE_UNAVAILABLE');
    return storage;
  }
  const save = value => {
    const result = saveQueue.catch(() => {}).then(() => saveState(value));
    saveQueue = result;
    return result;
  };
  async function ensureLoaded() {
    if (disposed) throw error('便单连接已关闭。', 'AUTH_CANCELLED');
    if (loaded) return;
    if (loading) return loading;
    const epoch = generation;
    loading = (async () => {
      let stored;
      try { stored = await loadState(); } catch { throw error('无法读取便单加密凭据，请稍后重试。', 'STATE_READ_FAILED'); }
      current(epoch);
      if (stored != null) {
        if (typeof stored.encrypted !== 'string' || !stored.encrypted || !/^[A-Za-z0-9+/]+={0,2}$/.test(stored.encrypted)) throw error('便单凭据格式无效，请断开后重新连接。', 'STATE_INVALID');
        const storage = secureStorage(), {Buffer} = requireDesktop('node:buffer');
        let parsed;
        try { parsed = JSON.parse(storage.decryptString(Buffer.from(stored.encrypted, 'base64'))); }
        catch { throw error('无法解密便单凭据，请在原系统用户下重试或重新连接。', 'STATE_INVALID'); }
        if (typeof parsed?.refresh_token !== 'string' || !parsed.refresh_token || (parsed.device_grant != null && typeof parsed.device_grant !== 'string')) throw error('便单凭据内容无效，请重新连接。', 'STATE_INVALID');
        credentials = {refresh_token:parsed.refresh_token, device_grant:parsed.device_grant || ''};
      }
      loaded = true;
    })().finally(() => { loading = null; });
    return loading;
  }
  async function persist(next, epoch) {
    current(epoch);
    const storage = secureStorage();
    let encrypted;
    try { encrypted = storage.encryptString(JSON.stringify(next)).toString('base64'); }
    catch { throw error('便单凭据加密失败，未保存明文。', 'STATE_SAVE_FAILED'); }
    // The pair is one encrypted payload and one serialized save operation.
    const result = saveQueue.catch(() => {}).then(async () => {
      current(epoch);
      try { await saveState({encrypted}); } catch { throw error('便单凭据保存未确认，请重新连接后再使用。', 'STATE_SAVE_FAILED'); }
    });
    saveQueue = result;
    await result;
    current(epoch);
    credentials = next;
    loaded = true;
  }
  async function requestJSON(url, init, epoch) {
    current(epoch);
    const controller = new AbortController(); requests.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetcher(url, {...init, signal:controller.signal, redirect:'error'});
      current(epoch);
      let body;
      try { body = await response.json(); } catch { throw error('授权服务返回了无法读取的响应，请稍后重试。', 'AUTH_RESPONSE_INVALID'); }
      return {response, body};
    } catch (failure) {
      if (failure instanceof BiandanAuthError) throw failure;
      current(epoch);
      throw error('授权服务暂时无法连接，请稍后重试；已有授权状态已保留。', 'AUTH_NETWORK_ERROR');
    } finally { clearTimeout(timer); requests.delete(controller); }
  }
  function tokenFields(body, fallbackRefresh = '') {
    const seconds = Number(body?.expires_in);
    if (typeof body?.access_token !== 'string' || !body.access_token || !Number.isFinite(seconds) || seconds <= 0) throw error('授权服务没有返回有效访问令牌。', 'AUTH_RESPONSE_INVALID');
    const refresh = body.refresh_token === undefined ? fallbackRefresh : body.refresh_token;
    if (typeof refresh !== 'string' || !refresh) throw error('未取得离线刷新凭据，请重新授权。', 'AUTH_RESPONSE_INVALID');
    return {token:body.access_token, expiresAt:Date.now() + Math.max(0, seconds - Math.min(60, seconds / 10)) * 1000, refresh};
  }
  async function renew() {
    await ensureLoaded();
    if (!credentials) throw error('请点击“连接便单”完成华为授权。', 'AUTH_REQUIRED');
    if (refreshing) return refreshing;
    const epoch = generation, previous = {...credentials};
    refreshing = (async () => {
      const headers = {'Content-Type':'application/json', Accept:'application/json'};
      if (previous.device_grant) headers.Authorization = 'Bearer ' + previous.device_grant;
      const {response,body} = await requestJSON(RENEWAL_ROOT + (previous.device_grant ? '/refresh' : '/device'), {
        method:'POST', headers, body:JSON.stringify({refresh_token:previous.refresh_token}),
      }, epoch);
      if (!response.ok) {
        if (response.status === 401 && [body?.error,body?.code,body?.error_code].includes('reauthorization_required')) {
          credentials = null; accessToken = ''; expiresAt = 0;
          await save(null); current(epoch);
          throw error('便单授权已失效，请重新连接。', 'AUTH_REQUIRED');
        }
        if (response.status === 403) throw error('续期凭据不匹配，请核对原授权状态，勿反复登记设备。', 'AUTH_FORBIDDEN');
        if (response.status === 429) {
          const failure = error('授权服务请求过于频繁，请稍后重试。', 'AUTH_RATE_LIMITED');
          const retry = Number(response.headers?.get?.('retry-after'));
          if (Number.isFinite(retry) && retry >= 0) failure.retryAfterSeconds = retry;
          throw failure;
        }
        throw error('便单授权续期暂未成功，原凭据已保留。', 'AUTH_RENEWAL_FAILED');
      }
      const fields = tokenFields(body, previous.refresh_token);
      if (typeof body.device_grant !== 'string' || !body.device_grant) throw error('续期服务未返回配套设备凭据，未覆盖旧授权。', 'AUTH_RESPONSE_INVALID');
      await persist({refresh_token:fields.refresh,device_grant:body.device_grant}, epoch);
      accessToken = fields.token; expiresAt = fields.expiresAt;
      return accessToken;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function connect() {
    if (disposed) throw error('便单连接已关闭。', 'AUTH_CANCELLED');
    if (connecting) return connecting;
    // An explicit login replaces only this in-memory attempt, not another program's state.
    const epoch = generation;
    secureStorage();
    const http = requireDesktop('node:http'), crypto = requireDesktop('node:crypto');
    if (typeof openExternal !== 'function') throw error('无法打开系统浏览器，请在思源桌面客户端重试。', 'DESKTOP_REQUIRED');
    const state = 'biandan-local-v1.' + crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    connecting = (async () => {
      const code = await new Promise((resolve, reject) => {
        let finished = false, accepting = false, timer;
        const finish = (failure, value) => {
          if (finished) return; finished = true; clearTimeout(timer);
          server.close(); server.closeIdleConnections?.(); cancelAuthorization = null;
          if (failure) reject(failure); else resolve(value);
        };
        const server = http.createServer((req,res) => {
          res.setHeader('Content-Type','text/html; charset=utf-8');
          res.setHeader('Cache-Control','no-store');
          res.setHeader('Connection','close');
          res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
          const send = (status, message) => {res.writeHead(status); res.end('<!doctype html><meta charset="utf-8"><title>便单第三方连接</title><p>'+message+'</p>');};
          let url; try { url = new URL(req.url, 'http://127.0.0.1:' + CALLBACK_PORT); } catch { send(400,'请求无效。'); return; }
          if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {send(404,'找不到此页面。');return;}
          if (finished || accepting) {send(409,'本次授权已处理。');return;}
          const received = url.searchParams.get('state') || '';
          const same = received.length === state.length && crypto.timingSafeEqual(crypto.createHash('sha256').update(received).digest(),crypto.createHash('sha256').update(state).digest());
          if (!same) {send(400,'授权状态不匹配，请回到思源重试。');return;}
          accepting = true;
          if (url.searchParams.has('error')) {send(400,'授权未完成，请回到思源重试。');finish(error('华为授权已取消或被拒绝。','AUTH_DENIED'));return;}
          const value = url.searchParams.get('code');
          if (!value) {send(400,'没有收到授权码。');finish(error('没有收到有效授权码，请重新连接。','AUTH_RESPONSE_INVALID'));return;}
          send(200,'已收到授权，请返回思源等待连接结果。'); finish(null,value);
        });
        cancelAuthorization = () => finish(error('授权已取消。','AUTH_CANCELLED'));
        server.once('error', () => finish(error('本机授权端口42681不可用，请关闭其他授权流程后重试。','AUTH_PORT_UNAVAILABLE')));
        server.listen(CALLBACK_PORT,'127.0.0.1', async () => {
          if (finished) {server.close();return;}
          timer = setTimeout(() => finish(error('授权已超时，请重新连接。','AUTH_TIMEOUT')),timeoutMs);
          const url = new URL(AUTHORIZE_URL);
          for (const [key,value] of Object.entries({response_type:'code',client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,scope:'openid profile',state,code_challenge:challenge,code_challenge_method:'S256',access_type:'offline'})) url.searchParams.set(key,value);
          try {current(epoch); await openExternal(url.toString());}
          catch {finish(error('无法打开授权浏览器，请重新连接。','AUTH_BROWSER_FAILED'));}
        });
      });
      current(epoch);
      const form = new URLSearchParams({grant_type:'authorization_code',client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,code,code_verifier:verifier});
      const {response,body} = await requestJSON(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:form.toString()},epoch);
      if (!response.ok) throw error('华为授权码换取凭据失败，请重新连接。','AUTH_EXCHANGE_FAILED');
      const fields = tokenFields(body);
      await persist({refresh_token:fields.refresh,device_grant:''},epoch);
      accessToken = fields.token; expiresAt = fields.expiresAt;
      return {connected:true};
    })().finally(() => { connecting = null; });
    return connecting;
  }
  return {
    connect,
    async getAccessToken({forceRefresh = false} = {}) {
      await ensureLoaded();
      if (!forceRefresh && accessToken && Date.now() < expiresAt) return accessToken;
      return renew();
    },
    async disconnect() {
      generation++; cancelAuthorization?.();
      for (const request of requests) request.abort();
      credentials = null; accessToken = ''; expiresAt = 0; loaded = true;
      await save(null);
    },
    status() {return {connected:Boolean(credentials || accessToken),authorizing:Boolean(connecting),refreshing:Boolean(refreshing),loaded};},
    dispose() {if(disposed)return;disposed=true;generation++;cancelAuthorization?.();for(const request of requests)request.abort();},
  };
}
