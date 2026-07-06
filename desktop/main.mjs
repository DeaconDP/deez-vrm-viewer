import { app, BrowserWindow, dialog, Menu, net, protocol, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const isDev = process.argv.includes('--dev');
const modelPattern = /\.(vrm|glb|gltf)$/i;
let mainWindow;
let pendingModelPath = process.argv.find(argument => modelPattern.test(argument));

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

app.setName('Deez VRM Viewer');
app.setAppUserModelId('io.worldbuild.deez-vrm-viewer');

if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', (_event, argv) => {
  const modelPath = argv.find(argument => modelPattern.test(argument));
  if (modelPath) void sendModel(modelPath);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

async function sendModel(filePath) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingModelPath = filePath;
    return;
  }
  try {
    const bytes = await readFile(filePath);
    mainWindow.webContents.send('open-model', { name: path.basename(filePath), bytes });
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Could not open model',
      message: 'Deez VRM Viewer could not read that file.',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

async function chooseModel() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a VRM or glTF model',
    properties: ['openFile'],
    filters: [{ name: 'VRM and glTF models', extensions: ['vrm', 'glb', 'gltf'] }]
  });
  if (!result.canceled && result.filePaths[0]) await sendModel(result.filePaths[0]);
}

function createMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open Model…', accelerator: 'CmdOrCtrl+O', click: () => void chooseModel() },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ]);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Deez VRM Viewer',
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121417',
    icon: path.join(root, 'dist', 'icon-512.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://') && !url.startsWith('http://127.0.0.1:')) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingModelPath) {
      const filePath = pendingModelPath;
      pendingModelPath = undefined;
      void sendModel(filePath);
    }
  });

  if (isDev) await mainWindow.loadURL('http://127.0.0.1:5173');
  else await mainWindow.loadURL('app://viewer/index.html');
}

app.whenReady().then(async () => {
  protocol.handle('app', request => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const distRoot = path.join(root, 'dist');
    const filePath = path.resolve(distRoot, relativePath);
    if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${path.sep}`)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
  Menu.setApplicationMenu(createMenu());
  await createWindow();
});

app.on('window-all-closed', () => app.quit());
