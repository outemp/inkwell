const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { marked } = require('marked');
const hljs = require('highlight.js');
const { markedHighlight } = require('marked-highlight');
const Store = require('electron-store');
const chokidar = require('chokidar');

// Initialize electron-store for preferences
const store = new Store({
  defaults: {
    darkMode: false,
    recentFiles: []
  }
});

// Configure marked with highlight.js
marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language }).value;
  }
}));

// Configure marked options for GFM
// Disable raw HTML to prevent XSS - HTML tags will be escaped
marked.use({
  gfm: true,
  breaks: false,
  pedantic: false
});

// Custom renderer to escape any HTML in the markdown
const renderer = new marked.Renderer();
const originalHtml = renderer.html.bind(renderer);
renderer.html = (html) => {
  // Escape HTML blocks instead of rendering them
  return `<pre><code>${escapeHtml(html.text)}</code></pre>`;
};

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

marked.use({ renderer });

// Parse markdown (HTML is escaped, not rendered)
function parseMarkdown(content) {
  return marked.parse(content);
}

let mainWindow = null;
let fileToOpen = null;
let currentFilePath = null;
let fileWatcher = null;
let debounceTimer = null;

// Allowed file extensions
const ALLOWED_EXTENSIONS = ['.md', '.markdown'];
const MAX_RECENT_FILES = 10;

function isAllowedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

// Recent files management
function getRecentFiles() {
  return store.get('recentFiles', []);
}

function addRecentFile(filePath) {
  let recent = getRecentFiles();
  // Remove if already exists
  recent = recent.filter(item => item.path !== filePath);
  // Add to beginning
  recent.unshift({ path: filePath, timestamp: Date.now() });
  // Limit to max
  recent = recent.slice(0, MAX_RECENT_FILES);
  store.set('recentFiles', recent);
  updateMenu();
}

function clearRecentFiles() {
  store.set('recentFiles', []);
  updateMenu();
}

// File watcher management
function startWatching(filePath) {
  stopWatching();

  fileWatcher = chokidar.watch(filePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50
    }
  });

  fileWatcher.on('change', () => {
    // Debounce 300ms
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      reloadCurrentFile();
    }, 300);
  });

  fileWatcher.on('unlink', () => {
    stopWatching();
    if (mainWindow) {
      mainWindow.webContents.send('file-deleted', { filePath });
    }
  });

  fileWatcher.on('error', (error) => {
    console.error('File watcher error:', error);
    stopWatching();
  });
}

function stopWatching() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

async function reloadCurrentFile() {
  if (!currentFilePath || !mainWindow) return;

  try {
    const content = await fs.readFile(currentFilePath, 'utf-8');
    const html = parseMarkdown(content);
    mainWindow.webContents.send('file-changed', { html });
  } catch (err) {
    console.error('Error reloading file:', err);
    stopWatching();
    mainWindow.webContents.send('file-deleted', { filePath: currentFilePath });
  }
}

// Dark mode management
function getDarkMode() {
  return store.get('darkMode', false);
}

function setDarkMode(enabled) {
  store.set('darkMode', enabled);
  if (mainWindow) {
    mainWindow.webContents.send('preferences-changed', { darkMode: enabled });
  }
  updateMenu();
}

function toggleDarkMode() {
  setDarkMode(!getDarkMode());
}

// Open file dialog
async function openFileDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    openFile(result.filePaths[0]);
  }
}

// Build recent files submenu
function buildRecentFilesSubmenu() {
  const recentFiles = getRecentFiles();

  if (recentFiles.length === 0) {
    return [
      { label: 'No Recent Files', enabled: false }
    ];
  }

  const items = recentFiles.map(item => ({
    label: path.basename(item.path),
    click: () => openRecentFile(item.path)
  }));

  items.push({ type: 'separator' });
  items.push({
    label: 'Clear Recent',
    click: () => clearRecentFiles()
  });

  return items;
}

async function openRecentFile(filePath) {
  try {
    await fs.access(filePath);
    openFile(filePath);
  } catch {
    // File no longer exists
    let recent = getRecentFiles();
    recent = recent.filter(item => item.path !== filePath);
    store.set('recentFiles', recent);
    updateMenu();
    sendError(`File no longer exists: ${path.basename(filePath)}`);
  }
}

// Create application menu
function createMenu() {
  const darkMode = getDarkMode();

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: () => openFileDialog()
        },
        {
          label: 'Open Recent',
          submenu: buildRecentFilesSubmenu()
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find...',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('toggle-find');
            }
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Dark Mode',
          accelerator: 'CmdOrCtrl+D',
          type: 'checkbox',
          checked: darkMode,
          click: () => toggleDarkMode()
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function updateMenu() {
  createMenu();
}

function createWindow() {
  const darkMode = getDarkMode();

  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 400,
    minHeight: 300,
    titleBarStyle: 'hiddenInset',
    backgroundColor: darkMode ? '#1a1a1a' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  // Deny all new window/popup requests
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    // Send initial preferences
    mainWindow.webContents.send('preferences-changed', { darkMode: getDarkMode() });

    if (fileToOpen) {
      openFile(fileToOpen);
      fileToOpen = null;
    }
  });

  mainWindow.on('closed', () => {
    stopWatching();
    mainWindow = null;
    currentFilePath = null;
  });
}

async function openFile(filePath) {
  if (!mainWindow) {
    fileToOpen = filePath;
    return;
  }

  // Validate file extension
  if (!isAllowedFile(filePath)) {
    sendError('Invalid file type. Only .md and .markdown files are supported.');
    return;
  }

  try {
    // Resolve to absolute path and normalize
    const resolvedPath = path.resolve(filePath);

    // Check file exists and is a file (not directory)
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      sendError('Path is not a file.');
      return;
    }

    const content = await fs.readFile(resolvedPath, 'utf-8');
    const fileName = path.basename(resolvedPath);
    const html = parseMarkdown(content);

    // Update current file and start watching
    currentFilePath = resolvedPath;
    startWatching(resolvedPath);

    // Add to recent files
    addRecentFile(resolvedPath);

    mainWindow.webContents.send('file-opened', { html, fileName, filePath: resolvedPath });
    mainWindow.setTitle(`${fileName} - Inkwell`);
  } catch (err) {
    console.error('Error reading file:', err);
    sendError(`Could not open file: ${err.message}`);
  }
}

function sendError(message) {
  if (mainWindow) {
    mainWindow.webContents.send('error', { message });
  }
}

// Handle file open from command line arguments
async function handleCommandLineArgs(argv) {
  // Skip electron executable and script path
  const args = argv.slice(app.isPackaged ? 1 : 2);

  for (const arg of args) {
    if (isAllowedFile(arg)) {
      const filePath = path.resolve(arg);
      try {
        await fs.access(filePath);
        openFile(filePath);
        return;
      } catch {
        // File doesn't exist, continue
      }
    }
  }
}

// macOS: Handle file open via double-click or drag-drop
app.on('open-file', (event, filePath) => {
  event.preventDefault();

  if (!isAllowedFile(filePath)) {
    return;
  }

  if (app.isReady()) {
    if (mainWindow) {
      openFile(filePath);
      mainWindow.focus();
    } else {
      fileToOpen = filePath;
      createWindow();
    }
  } else {
    fileToOpen = filePath;
  }
});

// Single instance lock - route files to existing instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Someone tried to run a second instance, focus our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      // Handle file from second instance command line
      handleCommandLineArgs(commandLine);
    }
  });

  app.whenReady().then(() => {
    createMenu();
    createWindow();
    handleCommandLineArgs(process.argv);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  stopWatching();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers

// Get preferences
ipcMain.handle('get-preferences', () => {
  return {
    darkMode: getDarkMode(),
    recentFiles: getRecentFiles()
  };
});

// Toggle dark mode
ipcMain.handle('toggle-dark-mode', () => {
  toggleDarkMode();
  return getDarkMode();
});

// Clear recent files
ipcMain.handle('clear-recent-files', () => {
  clearRecentFiles();
});

// Handle requests from renderer to open files via drag-drop
ipcMain.handle('open-dropped-file', async (event, filePath) => {
  // Validate extension
  if (!isAllowedFile(filePath)) {
    return { error: 'Invalid file type. Only .md and .markdown files are supported.' };
  }

  try {
    // Resolve and normalize path
    const resolvedPath = path.resolve(filePath);

    // Check it's a file
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      return { error: 'Path is not a file.' };
    }

    const content = await fs.readFile(resolvedPath, 'utf-8');
    const fileName = path.basename(resolvedPath);
    const html = parseMarkdown(content);

    // Update current file and start watching
    currentFilePath = resolvedPath;
    startWatching(resolvedPath);

    // Add to recent files
    addRecentFile(resolvedPath);

    mainWindow.setTitle(`${fileName} - Inkwell`);
    return { html, fileName, filePath: resolvedPath };
  } catch (err) {
    console.error('Error reading dropped file:', err);
    return { error: `Could not open file: ${err.message}` };
  }
});
