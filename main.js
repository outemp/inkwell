const { app, BrowserWindow, ipcMain, Menu, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { marked } = require('marked');
const hljs = require('highlight.js');
const { markedHighlight } = require('marked-highlight');
const Store = require('electron-store');
const chokidar = require('chokidar');
const katex = require('katex');

// Mermaid rendering using a hidden BrowserWindow with secure settings
let mermaidWindow = null;
let mermaidReady = false;
let mermaidPendingRequests = new Map();
let mermaidRequestId = 0;

// Register custom protocol for serving mermaid assets securely
function registerMermaidProtocol() {
  protocol.registerFileProtocol('mermaid-asset', (request, callback) => {
    const url = request.url.replace('mermaid-asset://', '');
    let filePath;

    if (url === 'mermaid.min.js') {
      try {
        filePath = require.resolve('mermaid/dist/mermaid.min.js');
      } catch {
        callback({ statusCode: 404 });
        return;
      }
    } else if (url === 'renderer.html') {
      filePath = path.join(__dirname, 'renderer', 'mermaid-renderer.html');
    } else {
      callback({ statusCode: 404 });
      return;
    }

    callback({ path: filePath });
  });
}

function createMermaidWindow() {
  if (mermaidWindow) return;

  mermaidWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });

  // Load the mermaid renderer page via custom protocol
  mermaidWindow.loadURL('mermaid-asset://renderer.html');

  mermaidWindow.webContents.on('did-finish-load', () => {
    // Inject mermaid library and initialize
    const mermaidCode = fsSync.readFileSync(require.resolve('mermaid/dist/mermaid.min.js'), 'utf-8');
    mermaidWindow.webContents.executeJavaScript(`
      ${mermaidCode}
      mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
      window.mermaidReady = true;
    `).then(() => {
      mermaidReady = true;
      processMermaidQueue();
    }).catch(err => {
      console.error('Failed to initialize mermaid:', err);
    });
  });

  mermaidWindow.on('closed', () => {
    mermaidWindow = null;
    mermaidReady = false;
  });
}

function processMermaidQueue() {
  if (!mermaidReady || !mermaidWindow) return;

  for (const [requestId, { code, resolve, reject }] of mermaidPendingRequests) {
    const safeCode = JSON.stringify(code);
    mermaidWindow.webContents.executeJavaScript(`window.renderDiagram('mermaid-${requestId}', ${safeCode})`)
      .then(result => {
        mermaidPendingRequests.delete(requestId);
        if (result && result.error) {
          reject(new Error(result.error));
        } else if (result && result.svg) {
          resolve(result.svg);
        } else if (typeof result === 'string') {
          resolve(result);
        } else {
          reject(new Error('Invalid mermaid result'));
        }
      })
      .catch(err => {
        mermaidPendingRequests.delete(requestId);
        reject(err);
      });
  }
}

async function renderMermaid(code) {
  return new Promise((resolve, reject) => {
    const requestId = mermaidRequestId++;
    mermaidPendingRequests.set(requestId, { code, resolve, reject });

    // Set a timeout to avoid hanging
    setTimeout(() => {
      if (mermaidPendingRequests.has(requestId)) {
        mermaidPendingRequests.delete(requestId);
        reject(new Error('Mermaid render timeout'));
      }
    }, 10000);

    if (!mermaidWindow) {
      createMermaidWindow();
    } else if (mermaidReady) {
      processMermaidQueue();
    }
  });
}

// Initialize electron-store for preferences
const store = new Store({
  defaults: {
    theme: 'light',
    recentFiles: [],
    windowBounds: { width: 900, height: 700 },
    zoomLevel: 0,
    tocVisible: false,
    syncScrollEnabled: true
  }
});

// Migrate legacy darkMode preference to theme
(function migrateLegacyPrefs() {
  if (store.has('darkMode')) {
    const wasDark = store.get('darkMode');
    if (wasDark && !store.has('theme')) {
      store.set('theme', 'dark');
    }
    store.delete('darkMode');
  }
})();

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

// KaTeX extension for math rendering
const katexExtension = {
  name: 'math',
  level: 'inline',
  start(src) {
    // Find the start of inline math $...$ or block math $$...$$
    const blockMatch = src.indexOf('$$');
    const inlineMatch = src.indexOf('$');
    if (blockMatch === 0) return 0;
    if (inlineMatch === 0 && src[1] !== '$') return 0;
    if (blockMatch > 0 && (inlineMatch < 0 || blockMatch < inlineMatch)) return blockMatch;
    if (inlineMatch > 0) return inlineMatch;
    return -1;
  },
  tokenizer(src) {
    // Block math: $$...$$
    const blockRule = /^\$\$([\s\S]+?)\$\$/;
    const blockMatch = blockRule.exec(src);
    if (blockMatch) {
      return {
        type: 'math',
        raw: blockMatch[0],
        text: blockMatch[1].trim(),
        displayMode: true
      };
    }

    // Inline math: $...$ (but not $$)
    const inlineRule = /^\$([^\$\n]+?)\$/;
    const inlineMatch = inlineRule.exec(src);
    if (inlineMatch) {
      return {
        type: 'math',
        raw: inlineMatch[0],
        text: inlineMatch[1].trim(),
        displayMode: false
      };
    }
  },
  renderer(token) {
    try {
      const html = katex.renderToString(token.text, {
        displayMode: token.displayMode,
        throwOnError: false,
        strict: false,
        trust: false
      });
      return token.displayMode
        ? `<div class="math-block">${html}</div>`
        : `<span class="math-inline">${html}</span>`;
    } catch (err) {
      const escapedText = escapeHtml(token.text);
      const escapedError = escapeHtml(err.message);
      return token.displayMode
        ? `<div class="math-block math-error">Math error: ${escapedError}<br><code>${escapedText}</code></div>`
        : `<span class="math-inline math-error" title="${escapedError}">${escapedText}</span>`;
    }
  }
};

marked.use({ extensions: [katexExtension] });

// Helper to escape HTML
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

// Allowed URL schemes for links
const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:'];

function sanitizeLinkHref(href) {
  if (!href) return '';
  try {
    // Handle relative URLs (they're safe)
    if (href.startsWith('/') || href.startsWith('#') || href.startsWith('./') || href.startsWith('../')) {
      return href;
    }
    const url = new URL(href, 'http://example.com');
    if (ALLOWED_LINK_SCHEMES.includes(url.protocol)) {
      return href;
    }
    // Disallowed scheme - return empty to disable link
    return '';
  } catch {
    // Invalid URL - escape and return as-is for relative paths
    return href.startsWith('#') ? href : '';
  }
}

// Custom renderer to escape any HTML in the markdown and handle mermaid
const renderer = new marked.Renderer();

// Sanitize links to prevent javascript: and other dangerous schemes
const originalLink = renderer.link.bind(renderer);
renderer.link = function(token) {
  // Handle both object form (newer marked) and positional arguments
  const href = typeof token === 'object' ? token.href : token;
  const title = typeof token === 'object' ? token.title : arguments[1];
  const text = typeof token === 'object' ? token.text : arguments[2];

  const sanitizedHref = sanitizeLinkHref(href);
  if (!sanitizedHref) {
    // Dangerous link - render as plain text
    return escapeHtml(text || href);
  }

  const escapedHref = escapeHtml(sanitizedHref);
  const escapedTitle = title ? ` title="${escapeHtml(title)}"` : '';
  const escapedText = typeof token === 'object' && token.tokens
    ? this.parser.parseInline(token.tokens)
    : escapeHtml(text || href);

  return `<a href="${escapedHref}"${escapedTitle}>${escapedText}</a>`;
};

// Escape HTML blocks
const originalHtml = renderer.html.bind(renderer);
renderer.html = (html) => {
  // Handle both string and token forms
  const htmlText = typeof html === 'object' ? html.text : html;
  return `<pre><code>${escapeHtml(htmlText || '')}</code></pre>`;
};

// Handle mermaid code blocks
const originalCode = renderer.code.bind(renderer);
renderer.code = function(code) {
  // Handle both object form (newer marked) and positional arguments
  const codeText = typeof code === 'object' ? code.text : code;
  const lang = typeof code === 'object' ? code.lang : arguments[1];

  if (lang === 'mermaid') {
    // Wrap mermaid code in a special container for client-side rendering
    const escapedCode = escapeHtml(codeText);
    return `<div class="mermaid-container"><pre class="mermaid-source" style="display:none;">${escapedCode}</pre><div class="mermaid">${escapedCode}</div></div>`;
  }
  // For other code blocks, use the highlight.js renderer (already configured)
  if (originalCode) {
    return originalCode(code);
  }
  const language = hljs.getLanguage(lang) ? lang : 'plaintext';
  const highlighted = hljs.highlight(codeText, { language }).value;
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
};

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
let viewMode = 'rendered'; // 'rendered' | 'source' | 'split'
let isDirty = false;
let pendingExportPath = null; // Track export path in main process for security
let zenModeEnabled = false;
let syncScrollEnabled = store.get('syncScrollEnabled', true); // Load persisted preference

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
    mainWindow.webContents.send('file-changed', { html, raw: content });
  } catch (err) {
    console.error('Error reloading file:', err);
    stopWatching();
    mainWindow.webContents.send('file-deleted', { filePath: currentFilePath });
  }
}

// Theme management
const VALID_THEMES = ['light', 'dark', 'sepia', 'solarized-light', 'solarized-dark'];

function getTheme() {
  return store.get('theme', 'light');
}

function setTheme(theme) {
  if (!VALID_THEMES.includes(theme)) {
    theme = 'light';
  }
  store.set('theme', theme);
  if (mainWindow) {
    mainWindow.webContents.send('theme-changed', { theme });
  }
  updateMenu();
}

// TOC visibility management
function getTocVisible() {
  return store.get('tocVisible', false);
}

function setTocVisible(visible) {
  store.set('tocVisible', visible);
  if (mainWindow) {
    mainWindow.webContents.send('toc-visibility-changed', { visible });
  }
  updateMenu();
}

function toggleToc() {
  setTocVisible(!getTocVisible());
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

// Export to PDF
async function exportToPDF() {
  if (!mainWindow || !currentFilePath) {
    sendError('No file to export.');
    return;
  }

  const defaultName = path.basename(currentFilePath, path.extname(currentFilePath)) + '.pdf';
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });

  if (!result.canceled && result.filePath) {
    try {
      const pdfData = await mainWindow.webContents.printToPDF({
        printBackground: true,
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
      });
      await fs.writeFile(result.filePath, pdfData);
    } catch (err) {
      console.error('Error exporting PDF:', err);
      sendError(`Could not export PDF: ${err.message}`);
    }
  }
}

// Export to HTML
async function exportToHTML() {
  if (!mainWindow || !currentFilePath) {
    sendError('No file to export.');
    return;
  }

  const defaultName = path.basename(currentFilePath, path.extname(currentFilePath)) + '.html';
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });

  if (!result.canceled && result.filePath) {
    // Store path in main process for security - renderer cannot override it
    pendingExportPath = result.filePath;
    mainWindow.webContents.send('export-html', {});
  }
}

// Print
function printDocument() {
  if (mainWindow) {
    mainWindow.webContents.print({ printBackground: true });
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
  const currentTheme = getTheme();
  const tocVisible = getTocVisible();
  const hasFile = !!currentFilePath;

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
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('save-file');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            {
              label: 'Export to PDF...',
              accelerator: 'CmdOrCtrl+E',
              click: () => exportToPDF()
            },
            {
              label: 'Export to HTML...',
              accelerator: 'CmdOrCtrl+Shift+E',
              click: () => exportToHTML()
            }
          ]
        },
        {
          label: 'Print...',
          accelerator: 'CmdOrCtrl+P',
          click: () => printDocument()
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
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
        },
        { type: 'separator' },
        {
          label: 'Format',
          submenu: [
            {
              label: 'Bold',
              accelerator: 'CmdOrCtrl+B',
              click: () => {
                if (mainWindow) mainWindow.webContents.send('format', 'bold');
              }
            },
            {
              label: 'Italic',
              accelerator: 'CmdOrCtrl+I',
              click: () => {
                if (mainWindow) mainWindow.webContents.send('format', 'italic');
              }
            },
            {
              label: 'Link',
              accelerator: 'CmdOrCtrl+K',
              click: () => {
                if (mainWindow) mainWindow.webContents.send('format', 'link');
              }
            },
            {
              label: 'Code',
              accelerator: 'CmdOrCtrl+Shift+C',
              click: () => {
                if (mainWindow) mainWindow.webContents.send('format', 'code');
              }
            }
          ]
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Theme',
          submenu: [
            {
              label: 'Light',
              type: 'radio',
              checked: currentTheme === 'light',
              click: () => setTheme('light')
            },
            {
              label: 'Dark',
              type: 'radio',
              checked: currentTheme === 'dark',
              click: () => setTheme('dark')
            },
            {
              label: 'Sepia',
              type: 'radio',
              checked: currentTheme === 'sepia',
              click: () => setTheme('sepia')
            },
            {
              label: 'Solarized Light',
              type: 'radio',
              checked: currentTheme === 'solarized-light',
              click: () => setTheme('solarized-light')
            },
            {
              label: 'Solarized Dark',
              type: 'radio',
              checked: currentTheme === 'solarized-dark',
              click: () => setTheme('solarized-dark')
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Table of Contents',
          accelerator: 'CmdOrCtrl+T',
          type: 'checkbox',
          checked: tocVisible,
          enabled: hasFile && viewMode !== 'source',
          click: () => toggleToc()
        },
        {
          label: 'Split View',
          accelerator: 'CmdOrCtrl+Shift+S',
          type: 'checkbox',
          checked: viewMode === 'split',
          enabled: hasFile,
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('toggle-split-view');
            }
          }
        },
        {
          label: viewMode === 'source' ? 'View Rendered' : 'View Source',
          accelerator: 'CmdOrCtrl+U',
          enabled: hasFile && viewMode !== 'split',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('toggle-view-source');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Zen Mode',
          accelerator: 'CmdOrCtrl+Shift+D',
          type: 'checkbox',
          checked: zenModeEnabled,
          enabled: hasFile,
          click: () => {
            zenModeEnabled = !zenModeEnabled;
            if (mainWindow) {
              mainWindow.webContents.send('toggle-zen-mode');
            }
            updateMenu();
          }
        },
        {
          label: 'Sync Scroll',
          type: 'checkbox',
          checked: syncScrollEnabled,
          enabled: viewMode === 'split',
          click: () => {
            syncScrollEnabled = !syncScrollEnabled;
            store.set('syncScrollEnabled', syncScrollEnabled);
            if (mainWindow) {
              mainWindow.webContents.send('toggle-sync-scroll');
            }
            updateMenu();
          }
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
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('show-shortcuts');
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function updateMenu() {
  createMenu();
}

// Get background color for theme
function getThemeBackgroundColor(theme) {
  const bgColors = {
    'light': '#ffffff',
    'dark': '#1a1a1a',
    'sepia': '#f5f0e6',
    'solarized-light': '#fdf6e3',
    'solarized-dark': '#002b36'
  };
  return bgColors[theme] || '#ffffff';
}

function createWindow() {
  const theme = getTheme();
  const windowBounds = store.get('windowBounds', { width: 900, height: 700 });
  const zoomLevel = store.get('zoomLevel', 0);

  mainWindow = new BrowserWindow({
    width: windowBounds.width,
    height: windowBounds.height,
    x: windowBounds.x,
    y: windowBounds.y,
    minWidth: 400,
    minHeight: 300,
    titleBarStyle: 'hiddenInset',
    backgroundColor: getThemeBackgroundColor(theme),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  // Restore zoom level
  mainWindow.webContents.setZoomLevel(zoomLevel);

  // Deny all new window/popup requests
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    // Send initial preferences
    mainWindow.webContents.send('theme-changed', { theme: getTheme() });
    mainWindow.webContents.send('toc-visibility-changed', { visible: getTocVisible() });

    if (fileToOpen) {
      openFile(fileToOpen);
      fileToOpen = null;
    }
  });

  // Save window bounds and zoom level before close
  mainWindow.on('close', (e) => {
    // Save window state
    const bounds = mainWindow.getBounds();
    store.set('windowBounds', bounds);
    store.set('zoomLevel', mainWindow.webContents.getZoomLevel());

    if (isDirty) {
      e.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Save', 'Don\'t Save', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Unsaved Changes',
        message: 'You have unsaved changes. Do you want to save before closing?'
      });

      if (choice === 0) {
        // Save - tell renderer to save, then close
        mainWindow.webContents.send('save-and-close');
      } else if (choice === 1) {
        // Don't Save - force close
        isDirty = false;
        mainWindow.close();
      }
      // Cancel (choice === 2) - do nothing, window stays open
    }
  });

  mainWindow.on('closed', () => {
    stopWatching();
    mainWindow = null;
    currentFilePath = null;
  });
}

async function openFile(filePath, skipDirtyCheck = false) {
  if (!mainWindow) {
    fileToOpen = filePath;
    return;
  }

  // Check for unsaved changes before opening a new file
  if (isDirty && !skipDirtyCheck && currentFilePath) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Save', 'Don\'t Save', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved Changes',
      message: 'You have unsaved changes. Do you want to save before opening a new file?'
    });

    if (choice === 0) {
      // Save first, then open the new file
      mainWindow.webContents.send('save-before-open', { pendingFilePath: filePath });
      return;
    } else if (choice === 2) {
      // Cancel - don't open the new file
      return;
    }
    // choice === 1: Don't Save - continue opening new file
    isDirty = false;
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

    mainWindow.webContents.send('file-opened', { html, raw: content, fileName, filePath: resolvedPath });
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
    // Register custom protocol for mermaid assets
    registerMermaidProtocol();

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
    theme: getTheme(),
    tocVisible: getTocVisible(),
    recentFiles: getRecentFiles(),
    syncScrollEnabled: syncScrollEnabled
  };
});

// Set theme
ipcMain.handle('set-theme', (event, theme) => {
  setTheme(theme);
  return getTheme();
});

// Set TOC visibility
ipcMain.handle('set-toc-visible', (event, visible) => {
  setTocVisible(visible);
  return getTocVisible();
});

// Clear recent files
ipcMain.handle('clear-recent-files', () => {
  clearRecentFiles();
});

// Set view mode (for menu label)
ipcMain.handle('set-view-mode', (event, mode) => {
  viewMode = mode;
  updateMenu();
});

// Set dirty state
ipcMain.handle('set-dirty', (event, dirty) => {
  isDirty = dirty;
});

// Parse markdown (for re-rendering edited content)
ipcMain.handle('parse-markdown', (event, content) => {
  return parseMarkdown(content);
});

// Save file - only allows saving to the currently opened file
ipcMain.handle('save-file', async (event, { filePath, content }) => {
  // Security: Only allow saving to the currently opened file
  if (!currentFilePath) {
    return { error: 'No file is currently open.' };
  }

  const resolvedPath = path.resolve(filePath);
  if (resolvedPath !== currentFilePath) {
    console.warn('Attempted to save to different path than current file:', resolvedPath);
    return { error: 'Can only save to the currently opened file.' };
  }

  // Validate extension
  if (!isAllowedFile(resolvedPath)) {
    return { error: 'Invalid file type.' };
  }

  try {
    await fs.writeFile(resolvedPath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    console.error('Error saving file:', err);
    return { error: `Could not save file: ${err.message}` };
  }
});

// Save HTML export - uses path stored in main process, ignores renderer-provided path
ipcMain.handle('save-html-export', async (event, { content }) => {
  // Security: Only use the path stored in main process from the Save dialog
  if (!pendingExportPath) {
    return { error: 'No export path set. Please use File > Export menu.' };
  }

  const exportPath = pendingExportPath;
  pendingExportPath = null; // Clear after use

  try {
    await fs.writeFile(exportPath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    console.error('Error exporting HTML:', err);
    return { error: `Could not export HTML: ${err.message}` };
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

    // Update current file and start watching
    currentFilePath = resolvedPath;
    startWatching(resolvedPath);

    // Add to recent files
    addRecentFile(resolvedPath);

    mainWindow.setTitle(`${fileName} - Inkwell`);
    return { html, raw: content, fileName, filePath: resolvedPath };
  } catch (err) {
    console.error('Error reading dropped file:', err);
    return { error: `Could not open file: ${err.message}` };
  }
});

// Open file after save (used when saving before opening a new file)
ipcMain.handle('open-file-after-save', async (event, filePath) => {
  isDirty = false;
  await openFile(filePath, true);
});

// Check if there are unsaved changes (for drag-drop handling)
ipcMain.handle('check-dirty-state', () => {
  return isDirty;
});

// Render mermaid diagram
ipcMain.handle('render-mermaid', async (event, code) => {
  try {
    const svg = await renderMermaid(code);
    return svg;
  } catch (err) {
    console.error('Mermaid render error:', err);
    throw new Error(err.message || 'Failed to render diagram');
  }
});
