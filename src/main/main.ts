/**
 * Electron main process: window security, custom protocols, IPC bridge.
 * All functionality lives in src/services (DriftCore); this file only adapts Electron.
 */
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, protocol, safeStorage, session, shell, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { PickPathRequest } from '../services/contract/dto';
import { DriftCore } from '../services/DriftCore';
import { BridgeError, StudioBridge, YOUTUBE_STUDIO_URL } from '../services/bridge/StudioBridge';
import type { Platform, SecretStore } from '../services/core/platform';
import { MemorySecretStore } from '../services/core/platform';
import { validateUri } from '../services/sessions/launcher';

const APP_ORIGIN = 'drift-app://renderer';
const SAFE_MODE = process.argv.includes('--safe-mode') || process.env.DRIFT_SAFE_MODE === '1';
const DEV_URL = process.env.DRIFT_RENDERER_URL; // e.g. http://localhost:5173 (Vite dev server)

protocol.registerSchemesAsPrivileged([
  { scheme: 'drift-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'drift-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (process.env.DRIFT_USER_DATA) app.setPath('userData', process.env.DRIFT_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const VOICE_MODEL = 'vosk-model-small-en-us-0.15.tar.gz';
/** Offline speech model: bundled in resources/models (installer) or fetched by scripts/fetch-voice-model.mjs (dev). */
function voiceModelPath(): string | null {
  for (const dir of [path.join(process.resourcesPath ?? '', 'models'), path.join(app.getAppPath(), 'resources', 'models'), path.join(app.getPath('userData'), 'models')]) {
    const p = path.join(dir, VOICE_MODEL);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let voiceWindow: BrowserWindow | null = null;

/** Starts or stops the hidden voice host (offline "Clip that" recogniser). */
function setVoiceHost(enabled: boolean): void {
  if (enabled && !voiceWindow) {
    voiceWindow = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'voice-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        devTools: !app.isPackaged,
      },
    });
    hardenContents(voiceWindow.webContents);
    voiceWindow.on('closed', () => {
      voiceWindow = null;
    });
    void voiceWindow.loadURL('drift-app://voice/index.html');
  } else if (!enabled && voiceWindow) {
    voiceWindow.destroy();
    voiceWindow = null;
    bridge?.setVoiceStatus({ state: 'off', detail: null, device: null });
  }
}

let core: DriftCore | null = null;
let bridge: StudioBridge | null = null;
const TEST_MODE = !app.isPackaged && process.env.DRIFT_TEST_MODE === '1';
let mainWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------

class SafeStorageSecrets implements SecretStore {
  private readonly file = path.join(app.getPath('userData'), 'secrets.json');
  get available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }
  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  get(key: string): string | null {
    const v = this.read()[key];
    if (!v) return null;
    try {
      return safeStorage.decryptString(Buffer.from(v, 'base64'));
    } catch {
      return null;
    }
  }
  set(key: string, value: string | null): void {
    const all = this.read();
    if (value === null) delete all[key];
    else all[key] = safeStorage.encryptString(value).toString('base64');
    fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
  }
}

const FILTERS: Record<PickPathRequest['purpose'], Electron.FileFilter[]> = {
  library: [],
  export: [],
  game: process.platform === 'win32' ? [{ name: 'Programs and shortcuts', extensions: ['exe', 'lnk'] }] : [],
  companion: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe', 'lnk'] }] : [],
  artwork: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  music: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'] }],
  import: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'webm', 'flv', 'ts', 'm4v'] }],
  ffmpeg: process.platform === 'win32' ? [{ name: 'ffmpeg.exe', extensions: ['exe'] }] : [],
  ffprobe: process.platform === 'win32' ? [{ name: 'ffprobe.exe', extensions: ['exe'] }] : [],
  whisper: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [],
  model: [{ name: 'Whisper model', extensions: ['bin', 'gguf'] }],
  imageEngine: process.platform === 'win32' ? [{ name: 'stable-diffusion.cpp (sd.exe / sd-cli.exe)', extensions: ['exe'] }] : [],
  imageModel: [{ name: 'Stable Diffusion model', extensions: ['safetensors', 'gguf', 'ckpt'] }],
};

function createPlatform(): Platform {
  const userData = app.getPath('userData');
  const secrets = safeStorage.isEncryptionAvailable() ? new SafeStorageSecrets() : new MemorySecretStore(false);
  return {
    os: process.platform,
    appVersion: app.getVersion(),
    dataDir: userData,
    logsDir: path.join(userData, 'logs'),
    secrets,
    async openExternal(uri) {
      // Only launcher URIs validated by the launcher allowlist reach the OS.
      const problem = validateUri(uri);
      if (problem) throw new Error(problem);
      await shell.openExternal(uri, { activate: true });
    },
    async openPath(p) {
      // Test mode (unpackaged only): record instead of launching a desktop application.
      if (TEST_MODE && process.env.DRIFT_TEST_OPEN_LOG) {
        fs.appendFileSync(process.env.DRIFT_TEST_OPEN_LOG, p + '\n');
        return '';
      }
      return shell.openPath(p);
    },
    showItemInFolder: (p) => shell.showItemInFolder(p),
    async pickPath(req) {
      // Test mode (unpackaged only): native dialogs cannot be automated, so read the answer from a file.
      if (TEST_MODE && process.env.DRIFT_TEST_PICK_FILE) {
        try {
          return JSON.parse(fs.readFileSync(process.env.DRIFT_TEST_PICK_FILE, 'utf8')) as string[];
        } catch {
          return [];
        }
      }
      const props: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory'> =
        req.kind === 'directory' ? ['openDirectory', 'createDirectory'] : req.kind === 'files' ? ['openFile', 'multiSelections'] : ['openFile'];
      const opts: Electron.OpenDialogOptions = { title: req.title ?? undefined, properties: props, filters: FILTERS[req.purpose] };
      const r = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? [] : r.filePaths;
    },
    shortcuts: {
      register: (acc, cb) => globalShortcut.register(acc, cb),
      unregister: (acc) => globalShortcut.unregister(acc),
      unregisterAll: () => globalShortcut.unregisterAll(),
    },
  };
}

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: drift-media:",
  "media-src 'self' blob: drift-media:",
  "font-src 'self' data:",
  "connect-src 'self' drift-media:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

/**
 * The hidden voice host gets its own, separate policy: the Vosk WebAssembly build needs
 * 'unsafe-eval'. That page contains only our static voice script, has no app bridge, and
 * can reach nothing but the local speech model.
 */
const CSP_VOICE = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src blob:",
  'connect-src drift-media:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ico': 'image/x-icon',
  '.gz': 'application/gzip',
};

function rendererRoot(): { dir: string; fallback: boolean } {
  const built = path.join(app.getAppPath(), 'dist');
  if (fs.existsSync(path.join(built, 'index.html'))) return { dir: built, fallback: false };
  return { dir: path.join(__dirname, 'fallback'), fallback: true };
}

function registerProtocols(): void {
  const root = rendererRoot();
  protocol.handle('drift-app', async (req) => {
    const url = new URL(req.url);
    if (url.host === 'voice') {
      const name = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      if (!['index.html', 'voice.js'].includes(name)) return new Response('Not found', { status: 404 });
      const body = await fs.promises.readFile(path.join(__dirname, '..', 'voice', name));
      return new Response(body, { headers: { 'content-type': MIME[path.extname(name)] ?? 'text/plain', 'content-security-policy': CSP_VOICE, 'x-content-type-options': 'nosniff' } });
    }
    if (url.host !== 'renderer') return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(root.dir, rel));
    if (!file.startsWith(root.dir + path.sep)) return new Response('Forbidden', { status: 403 });
    // SPA routing: unknown paths without an extension serve index.html.
    const target = fs.existsSync(file) ? file : path.extname(file) ? null : path.join(root.dir, 'index.html');
    if (!target) return new Response('Not found', { status: 404 });
    const body = await fs.promises.readFile(target);
    return new Response(body, {
      headers: { 'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
    });
  });

  // drift-media://<clip|proxy|thumb>/<clipId>, music/<token>, preview/program — only
  // library-owned ids or user-picked handles resolve; arbitrary paths never do.
  protocol.handle('drift-media', async (req) => {
    const url = new URL(req.url);
    const kind = url.host;
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!core || !['clip', 'proxy', 'thumb', 'music', 'preview', 'model'].includes(kind) || !/^[\w-]{1,128}$/.test(id)) return new Response('Not found', { status: 404, headers: MEDIA_CORS });
    if (kind === 'preview') {
      try {
        const shot = await core.obs.preview(960);
        const b64 = shot.imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
        return new Response(Buffer.from(b64, 'base64'), { headers: { ...MEDIA_CORS, 'content-type': 'image/jpeg', 'cache-control': 'no-store' } });
      } catch {
        return new Response('Preview unavailable', { status: 503, headers: MEDIA_CORS });
      }
    }
    if (kind === 'model') {
      const model = id === 'vosk-small-en' ? voiceModelPath() : null;
      return model ? serveFile(model, req.headers.get('range')) : new Response('Not found', { status: 404, headers: MEDIA_CORS });
    }
    const file = kind === 'music' ? (bridge?.resolveMusic(id) ?? null) : core.library.resolveMedia(kind as 'clip' | 'proxy' | 'thumb', id);
    if (!file) return new Response('Not found', { status: 404, headers: MEDIA_CORS });
    return serveFile(file, req.headers.get('range'));
  });
}

/** Media is readable by the app origin only (fetch/canvas); <img>/<video> need no CORS. */
const MEDIA_CORS = { 'access-control-allow-origin': APP_ORIGIN, 'access-control-allow-headers': 'range', 'access-control-expose-headers': 'content-range, content-length, accept-ranges', vary: 'origin' };

async function serveFile(file: string, range: string | null): Promise<Response> {
  const { size } = await fs.promises.stat(file);
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m) {
    let start = m[1] ? Number(m[1]) : NaN;
    let end = m[2] ? Number(m[2]) : size - 1;
    if (Number.isNaN(start)) {
      start = Math.max(0, size - end);
      end = size - 1;
    }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...MEDIA_CORS, 'content-range': `bytes */${size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...MEDIA_CORS, 'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...MEDIA_CORS, 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes' } });
}

// ---------------------------------------------------------------------------
// Window + security
// ---------------------------------------------------------------------------

function isAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'drift-app:' && u.host === 'renderer') return true;
    if (DEV_URL && !app.isPackaged) return u.origin === new URL(DEV_URL).origin;
    return false;
  } catch {
    return false;
  }
}

function hardenContents(contents: WebContents): void {
  contents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  contents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    // External https links (docs/help) open in the default browser; nothing else opens.
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#faf8ff',
    show: false,
    title: 'Drift Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // Keep listening for "Clip that" while a game has focus.
      backgroundThrottling: false,
      devTools: !app.isPackaged || process.env.DRIFT_DEVTOOLS === '1',
    },
  });
  hardenContents(mainWindow.webContents);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    setVoiceHost(false); // the hidden voice window must not keep the app alive
  });
  const url = DEV_URL && !app.isPackaged ? DEV_URL : `${APP_ORIGIN}/index.html`;
  void mainWindow.loadURL(url);
}

function configureSession(): void {
  const ses = session.defaultSession;
  // Microphone (audio only) is granted to the hidden voice host alone; the UI never needs it.
  const isVoiceUrl = (raw: string) => raw.startsWith('drift-app://voice/');
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details.requestingUrl ?? wc.getURL();
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      return callback(isVoiceUrl(url) && types.length > 0 && types.every((t) => t === 'audio'));
    }
    callback(isAppUrl(url) && permission === 'clipboard-sanitized-write');
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    const url = origin || wc?.getURL() || '';
    if (permission === 'media') return isVoiceUrl(url) || isVoiceUrl(wc?.getURL() ?? '');
    return isAppUrl(url) && permission === 'clipboard-sanitized-write';
  });
  if (DEV_URL && !app.isPackaged) {
    ses.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") + `; connect-src 'self' ws: ${new URL(DEV_URL).origin} drift-media:`] } });
    });
  }
}

function registerIpc(): void {
  const untrusted = { ok: false, error: { code: 'INVALID_INPUT', message: 'Request from an untrusted frame', recoverable: false, details: null } };
  const starting = { ok: false, error: { code: 'BUSY', message: 'Drift Studio is still starting', recoverable: true, details: null } };
  ipcMain.on('voice:event', (event, msg: { type?: string; state?: string; detail?: string | null; device?: string | null; text?: string; confidence?: number }) => {
    if (!voiceWindow || event.sender !== voiceWindow.webContents || !bridge) return;
    if (msg?.type === 'status' && ['loading', 'listening', 'error'].includes(String(msg.state))) {
      bridge.setVoiceStatus({ state: msg.state as 'loading' | 'listening' | 'error', detail: msg.detail ?? null, device: msg.device ?? null });
    } else if (msg?.type === 'heard' && typeof msg.text === 'string') {
      void bridge.voiceHeard(msg.text, Number(msg.confidence) || 0);
    }
  });
  ipcMain.handle('drift:readState', async (event) => {
    if (!isAppUrl(event.senderFrame?.url ?? '')) return untrusted;
    if (!bridge) return starting;
    return { ok: true, data: await bridge.readState() };
  });
  ipcMain.handle('drift:request', async (event, msg: { operation?: unknown; input?: unknown; requestId?: unknown }) => {
    if (!isAppUrl(event.senderFrame?.url ?? '')) return untrusted;
    if (!bridge) return starting;
    try {
      const data = await bridge.request(String(msg?.operation ?? ''), msg?.input, String(msg?.requestId ?? ''));
      return { ok: true, data: data ?? null };
    } catch (err) {
      const e = err instanceof BridgeError ? err.error : { code: 'IO_ERROR', message: 'Unexpected error', recoverable: false, details: String(err) };
      return { ok: false, error: e };
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('web-contents-created', (_e, contents) => hardenContents(contents));

app.whenReady().then(async () => {
  if (app.isPackaged) Menu.setApplicationMenu(null);
  const resourceDirs = [path.join(process.resourcesPath ?? '', 'ffmpeg'), path.join(app.getAppPath(), 'resources', 'ffmpeg')];
  core = new DriftCore({ platform: createPlatform(), resourceDirs, safeMode: SAFE_MODE, echoLogs: !app.isPackaged });
  bridge = new StudioBridge(core, {
    voiceModelPath,
    onVoiceWanted: (wanted) => setVoiceHost(wanted),
    async openYouTubeStudio() {
      // A fixed constant, never a renderer-supplied URL. Test mode records it instead of opening a browser.
      if (TEST_MODE && process.env.DRIFT_TEST_OPEN_LOG) return fs.appendFileSync(process.env.DRIFT_TEST_OPEN_LOG, YOUTUBE_STUDIO_URL + '\n');
      await shell.openExternal(YOUTUBE_STUDIO_URL, { activate: true });
    },
    publish: (snapshot) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('drift:state', snapshot);
    },
  });
  configureSession();
  registerProtocols();
  registerIpc();
  await core.start();
  await bridge.start();
  createWindow();
  setVoiceHost(bridge.voiceWanted());
  // OBS peak meters only while the window is focused (no extra work while gaming).
  app.on('browser-window-focus', () => void bridge?.setMetersWanted(true));
  app.on('browser-window-blur', () => void bridge?.setMetersWanted(false));
  if (SAFE_MODE) core.notice('warning', 'Safe mode', 'Global shortcuts are disabled for this run.');
});

app.on('window-all-closed', () => app.quit());

let disposing = false;
app.on('will-quit', (e) => {
  globalShortcut.unregisterAll();
  if (core && !disposing) {
    disposing = true;
    e.preventDefault();
    bridge?.dispose();
    void core.dispose().finally(() => {
      core = null;
      app.quit();
    });
  }
});
