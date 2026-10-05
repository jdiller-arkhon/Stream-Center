/**
 * Electron main process: window security, custom protocols, IPC bridge.
 * All functionality lives in src/services (DriftCore); this file only adapts Electron.
 */
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, protocol, safeStorage, session, shell, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { IPC_CHANNELS } from '../services/contract/channels';
import type { PickPathRequest } from '../services/contract/dto';
import { DriftCore } from '../services/DriftCore';
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

let core: DriftCore | null = null;
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
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    async pickPath(req) {
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

  // drift-media://<clip|proxy|thumb>/<clipId> — only library-owned ids resolve to files.
  protocol.handle('drift-media', async (req) => {
    const url = new URL(req.url);
    const kind = url.host as 'clip' | 'proxy' | 'thumb';
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!core || !['clip', 'proxy', 'thumb'].includes(kind) || !/^[\w-]{1,128}$/.test(id)) return new Response('Not found', { status: 404 });
    const file = core.library.resolveMedia(kind, id);
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
    backgroundColor: '#000000',
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
      devTools: !app.isPackaged || process.env.DRIFT_DEVTOOLS === '1',
    },
  });
  hardenContents(mainWindow.webContents);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));
  const url = DEV_URL && !app.isPackaged ? DEV_URL : `${APP_ORIGIN}/index.html`;
  void mainWindow.loadURL(url);
}

function configureSession(): void {
  const ses = session.defaultSession;
  // Microphone access (for renderer-side level preview) only; everything else is denied.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const fromApp = isAppUrl(details.requestingUrl ?? wc.getURL());
    if (fromApp && permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      return callback(types.length > 0 && types.every((t) => t === 'audio'));
    }
    callback(fromApp && permission === 'clipboard-sanitized-write');
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    const fromApp = isAppUrl(origin || wc?.getURL() || '');
    return fromApp && (permission === 'media' || permission === 'clipboard-sanitized-write');
  });
  if (DEV_URL && !app.isPackaged) {
    ses.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") + `; connect-src 'self' ws: ${new URL(DEV_URL).origin} drift-media:`] } });
    });
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.invoke, async (event, msg: { method?: unknown; input?: unknown }) => {
    if (!isAppUrl(event.senderFrame?.url ?? '')) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Request from an untrusted frame', detail: null, retryable: false } };
    }
    if (!core) return { ok: false, error: { code: 'BUSY', message: 'Drift Studio is still starting', detail: null, retryable: true } };
    return core.invokeRaw(typeof msg?.method === 'string' ? msg.method : '', msg?.input);
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
  core.bus.onAny((event, payload) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.event, { event, payload });
  });
  configureSession();
  registerProtocols();
  registerIpc();
  createWindow();
  await core.start();
  if (SAFE_MODE) core.notice('warning', 'Safe mode', 'Global shortcuts are disabled for this run.');
});

app.on('window-all-closed', () => app.quit());

let disposing = false;
app.on('will-quit', (e) => {
  globalShortcut.unregisterAll();
  if (core && !disposing) {
    disposing = true;
    e.preventDefault();
    void core.dispose().finally(() => {
      core = null;
      app.quit();
    });
  }
});
