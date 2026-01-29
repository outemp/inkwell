const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { marked } = require('marked');
const hljs = require('highlight.js');
const { markedHighlight } = require('marked-highlight');

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

// Allowed file extensions
const ALLOWED_EXTENSIONS = ['.md', '.markdown'];

function isAllowedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
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

// Create application menu
function createMenu() {
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
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 400,
    minHeight: 300,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
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
    if (fileToOpen) {
      openFile(fileToOpen);
      fileToOpen = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
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
  if (process.platform !== 'darwin') {
    app.quit();
  }
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

    mainWindow.setTitle(`${fileName} - Inkwell`);
    return { html, fileName, filePath: resolvedPath };
  } catch (err) {
    console.error('Error reading dropped file:', err);
    return { error: `Could not open file: ${err.message}` };
  }
});
