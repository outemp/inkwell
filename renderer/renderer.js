const contentEl = document.getElementById('content');
const errorBanner = document.getElementById('error-banner');
const errorMessage = document.getElementById('error-message');
const errorDismiss = document.getElementById('error-dismiss');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const searchPrev = document.getElementById('search-prev');
const searchNext = document.getElementById('search-next');
const searchClose = document.getElementById('search-close');
const statusBar = document.getElementById('status-bar');
const wordCountEl = document.getElementById('word-count');
const charCountEl = document.getElementById('char-count');
const shortcutsOverlay = document.getElementById('shortcuts-overlay');
const shortcutsClose = document.getElementById('shortcuts-close');
const tocSidebar = document.getElementById('toc-sidebar');
const tocNav = document.getElementById('toc-nav');

// Search state
let searchMatches = [];
let currentMatchIndex = -1;
let searchDebounceTimer = null;

// View state
let currentHtml = '';
let currentRaw = '';
let currentFilePath = '';
let currentFileName = '';
let viewMode = 'rendered'; // 'rendered' | 'source' | 'split'
let isDirty = false;
let currentTheme = 'light';
let tocVisible = false;
let zenMode = false;
let syncScrollEnabled = true;
let autoSaveTimer = null;
const AUTO_SAVE_DELAY = 30000; // 30 seconds of inactivity

// Show error banner
function showError(message) {
  errorMessage.textContent = message;
  errorBanner.classList.remove('hidden');

  // Auto-hide after 5 seconds
  setTimeout(() => {
    hideError();
  }, 5000);
}

// Hide error banner
function hideError() {
  errorBanner.classList.add('hidden');
}

// Dismiss button handler
errorDismiss.addEventListener('click', hideError);

// Render markdown content (receives pre-parsed and sanitized HTML from main process)
async function renderMarkdown(html) {
  contentEl.innerHTML = `<article class="markdown-body">${html}</article>`;

  // Make external links open in default browser
  setupExternalLinks(contentEl);

  // Render mermaid diagrams
  await renderMermaidDiagrams();

  // Clear any existing search
  clearSearch();

  // Update TOC if visible
  if (tocVisible) {
    buildToc();
  }
}

// SVG Sanitizer - removes dangerous elements and attributes
const DANGEROUS_SVG_ELEMENTS = [
  'script', 'foreignobject', 'iframe', 'object', 'embed',
  'use', 'image', 'animate', 'animatemotion', 'animatetransform', 'set'
];

const DANGEROUS_SVG_ATTRIBUTES = [
  'onload', 'onerror', 'onclick', 'onmouseover', 'onmouseout', 'onmousedown',
  'onmouseup', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'onreset',
  'onselect', 'onkeydown', 'onkeypress', 'onkeyup', 'ondblclick',
  'oncontextmenu', 'ondrag', 'ondragend', 'ondragenter', 'ondragleave',
  'ondragover', 'ondragstart', 'ondrop', 'onmouseenter', 'onmouseleave',
  'onmousemove', 'onscroll', 'onwheel', 'ontouchstart', 'ontouchmove',
  'ontouchend', 'ontouchcancel', 'onanimationstart', 'onanimationend',
  'onanimationiteration', 'ontransitionend', 'xlink:href'
];

function sanitizeSvg(svgString) {
  // Parse SVG in a safe way
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');

  // Check for parsing errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.warn('SVG parsing error:', parseError.textContent);
    return '';
  }

  const svg = doc.documentElement;
  if (!svg || svg.tagName.toLowerCase() !== 'svg') {
    return '';
  }

  // Recursively sanitize all elements
  function sanitizeElement(el) {
    // Remove dangerous elements
    const tagName = el.tagName.toLowerCase();
    if (DANGEROUS_SVG_ELEMENTS.includes(tagName)) {
      el.remove();
      return;
    }

    // Remove dangerous attributes
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      const attrName = attr.name.toLowerCase();
      // Remove event handlers and dangerous attributes
      if (DANGEROUS_SVG_ATTRIBUTES.includes(attrName) ||
          attrName.startsWith('on') ||
          (attrName === 'href' && attr.value.toLowerCase().startsWith('javascript:'))) {
        el.removeAttribute(attr.name);
      }
    }

    // Recursively sanitize children
    Array.from(el.children).forEach(sanitizeElement);
  }

  sanitizeElement(svg);

  // Serialize back to string
  const serializer = new XMLSerializer();
  return serializer.serializeToString(svg);
}

// Render mermaid diagrams in a container
async function renderMermaidInContainer(container) {
  const mermaidContainers = container.querySelectorAll('.mermaid-container');
  if (mermaidContainers.length === 0) return;

  for (const mContainer of mermaidContainers) {
    const sourceEl = mContainer.querySelector('.mermaid-source');
    const mermaidEl = mContainer.querySelector('.mermaid');
    if (!sourceEl || !mermaidEl) continue;

    const code = sourceEl.textContent;
    try {
      const svg = await window.inkwell.renderMermaid(code);
      if (svg) {
        // Sanitize SVG before inserting into DOM
        const sanitizedSvg = sanitizeSvg(svg);
        if (sanitizedSvg) {
          mermaidEl.innerHTML = sanitizedSvg;
        } else {
          mermaidEl.innerHTML = `<div class="mermaid-error">Invalid SVG output</div>`;
        }
      }
    } catch (err) {
      mermaidEl.innerHTML = `<div class="mermaid-error">Mermaid error: ${escapeHtmlText(err.message || 'Failed to render diagram')}<pre>${escapeHtmlText(code)}</pre></div>`;
    }
  }
}

// Render mermaid diagrams in main content
async function renderMermaidDiagrams() {
  await renderMermaidInContainer(contentEl);
}

// Render raw source view (editable)
function renderSource(raw) {
  const textarea = document.createElement('textarea');
  textarea.className = 'source-view';
  textarea.id = 'source-editor';
  textarea.value = raw;
  textarea.spellcheck = false;

  // Track changes for dirty state and update status bar
  textarea.addEventListener('input', () => {
    if (!isDirty) {
      setDirty(true);
    }
    // Update currentRaw to reflect changes for status bar
    currentRaw = textarea.value;
    // Schedule auto-save
    scheduleAutoSave();
    // Update status bar with new word/char counts
    updateStatusBar();
  });

  contentEl.innerHTML = '';
  contentEl.appendChild(textarea);
  clearSearch();
}

// Schedule auto-save after period of inactivity
function scheduleAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
  }

  autoSaveTimer = setTimeout(async () => {
    if (isDirty && currentFilePath && (viewMode === 'source' || viewMode === 'split')) {
      await saveCurrentContent();
    }
  }, AUTO_SAVE_DELAY);
}

// Cancel auto-save timer
function cancelAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}

// Update document title with dirty indicator
function updateTitle() {
  if (!currentFileName) return;
  const dirtyIndicator = isDirty ? '• ' : '';
  document.title = `${dirtyIndicator}${currentFileName} - Inkwell`;
}

// Set dirty state and notify main process
function setDirty(dirty) {
  isDirty = dirty;
  window.inkwell.setDirty(dirty);
  updateTitle();

  // Cancel auto-save if file was saved
  if (!dirty) {
    cancelAutoSave();
  }
}

// Update body classes based on view mode
function updateViewModeClasses() {
  document.body.classList.toggle('split-mode', viewMode === 'split');
  document.body.classList.toggle('source-mode', viewMode === 'source');
}

// Render current view based on mode
function renderCurrentView() {
  // Clean up divider handlers when leaving split view
  if (viewMode !== 'split') {
    cleanupDividerHandlers();
  }

  updateViewModeClasses();
  if (viewMode === 'source') {
    renderSource(currentRaw);
  } else if (viewMode === 'split') {
    renderSplitView();
  } else {
    renderMarkdown(currentHtml);
  }
  updateTocVisibility();
}

// Toggle between rendered and source view
async function toggleViewSource() {
  if (!currentRaw && viewMode === 'rendered') return; // No file loaded
  if (viewMode === 'split') return; // Don't toggle in split mode

  // If switching from source to rendered, capture edits and re-parse
  if (viewMode === 'source') {
    const editor = document.getElementById('source-editor');
    if (editor) {
      const editedContent = editor.value;
      if (editedContent !== currentRaw) {
        currentRaw = editedContent;
        // Re-parse the markdown
        currentHtml = await window.inkwell.parseMarkdown(editedContent);
      }
    }
    viewMode = 'rendered';
  } else {
    viewMode = 'source';
  }

  window.inkwell.setViewMode(viewMode);
  const scrollY = window.scrollY;
  renderCurrentView();
  window.scrollTo(0, scrollY);
}

// Toggle split view
async function toggleSplitView() {
  if (!currentRaw) return; // No file loaded

  // If coming from source view, capture edits first
  if (viewMode === 'source') {
    const editor = document.getElementById('source-editor');
    if (editor) {
      const editedContent = editor.value;
      if (editedContent !== currentRaw) {
        currentRaw = editedContent;
        currentHtml = await window.inkwell.parseMarkdown(editedContent);
      }
    }
  }

  viewMode = viewMode === 'split' ? 'rendered' : 'split';
  window.inkwell.setViewMode(viewMode);
  renderCurrentView();
}

// Render split view with source and preview side by side
function renderSplitView() {
  const splitContainer = document.createElement('div');
  splitContainer.className = 'split-container';

  // Source pane (left side)
  const sourcePane = document.createElement('div');
  sourcePane.className = 'split-pane split-source';
  const textarea = document.createElement('textarea');
  textarea.className = 'source-view split-editor';
  textarea.id = 'source-editor';
  textarea.value = currentRaw;
  textarea.spellcheck = false;
  sourcePane.appendChild(textarea);

  // Divider
  const divider = document.createElement('div');
  divider.className = 'split-divider';

  // Preview pane (right side)
  const previewPane = document.createElement('div');
  previewPane.className = 'split-pane split-preview';
  previewPane.id = 'split-preview';
  previewPane.innerHTML = `<article class="markdown-body">${currentHtml}</article>`;

  splitContainer.appendChild(sourcePane);
  splitContainer.appendChild(divider);
  splitContainer.appendChild(previewPane);

  contentEl.innerHTML = '';
  contentEl.appendChild(splitContainer);

  // Set up sync scroll between source and preview
  setupSyncScroll(textarea, previewPane);

  // Set up live preview with debounce (500ms for better performance on large docs)
  let previewDebounce = null;
  let isUpdatingPreview = false;

  textarea.addEventListener('input', () => {
    if (!isDirty) {
      setDirty(true);
    }

    // Schedule auto-save
    scheduleAutoSave();

    if (previewDebounce) clearTimeout(previewDebounce);

    // Show updating indicator for large content
    if (textarea.value.length > 5000 && !isUpdatingPreview) {
      previewPane.style.opacity = '0.7';
    }

    previewDebounce = setTimeout(async () => {
      isUpdatingPreview = true;
      const editedContent = textarea.value;
      currentRaw = editedContent;

      // Preserve scroll position during update
      const savedScrollTop = previewPane.scrollTop;

      try {
        currentHtml = await window.inkwell.parseMarkdown(editedContent);
        previewPane.innerHTML = `<article class="markdown-body">${currentHtml}</article>`;
        previewPane.style.opacity = '';

        // Restore scroll position
        previewPane.scrollTop = savedScrollTop;

        setupExternalLinks(previewPane);

        // Render mermaid in preview pane (only if there are mermaid blocks)
        if (currentHtml.includes('mermaid-container')) {
          await renderMermaidInContainer(previewPane);
        }

        updateStatusBar();

        // Rebuild TOC using requestIdleCallback if available (non-blocking)
        if (tocVisible) {
          if (window.requestIdleCallback) {
            requestIdleCallback(() => buildTocFromSplitPreview(), { timeout: 1000 });
          } else {
            buildTocFromSplitPreview();
          }
        }
      } finally {
        isUpdatingPreview = false;
        previewPane.style.opacity = '';
      }
    }, 500);
  });

  // Set up resizable divider
  setupDividerResize(divider, sourcePane, previewPane);

  // Setup external links in preview
  setupExternalLinks(previewPane);

  // Build TOC from preview pane in split mode
  if (tocVisible) {
    buildTocFromSplitPreview();
  }

  // Render mermaid in initial preview
  renderMermaidInContainer(previewPane);

  clearSearch();
}

// Build TOC from split preview pane
function buildTocFromSplitPreview() {
  if (!tocNav) return;

  const previewPane = document.getElementById('split-preview');
  const markdownBody = previewPane ? previewPane.querySelector('.markdown-body') : null;

  if (!markdownBody) {
    tocNav.innerHTML = '<ul class="toc-list"><li class="toc-empty">No headings found</li></ul>';
    return;
  }

  const headings = markdownBody.querySelectorAll('h1, h2, h3, h4, h5, h6');
  if (headings.length === 0) {
    tocNav.innerHTML = '<ul class="toc-list"><li class="toc-empty">No headings found</li></ul>';
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'toc-list';

  headings.forEach((heading, index) => {
    if (!heading.id) {
      heading.id = `heading-${index}`;
    }

    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${heading.id}`;
    a.textContent = heading.textContent;
    a.className = `toc-${heading.tagName.toLowerCase()}`;
    a.setAttribute('data-heading-id', heading.id);

    a.addEventListener('click', (e) => {
      e.preventDefault();
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      tocNav.querySelectorAll('a').forEach(link => link.classList.remove('active'));
      a.classList.add('active');
    });

    li.appendChild(a);
    ul.appendChild(li);
  });

  tocNav.innerHTML = '';
  tocNav.appendChild(ul);

  // Set up scroll spy for preview pane
  setupScrollSpyForPreview(headings, previewPane);
}

// Scroll spy for split view preview pane
function setupScrollSpyForPreview(headings, previewPane) {
  if (tocObserver) {
    tocObserver.disconnect();
  }

  const options = {
    root: previewPane,
    rootMargin: '-80px 0px -70% 0px',
    threshold: 0
  };

  tocObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        tocNav.querySelectorAll('a').forEach(link => {
          link.classList.toggle('active', link.getAttribute('data-heading-id') === id);
        });
      }
    });
  }, options);

  headings.forEach(heading => {
    tocObserver.observe(heading);
  });
}

// Set up synchronized scrolling between source and preview
function setupSyncScroll(source, preview) {
  let isSyncingFromSource = false;
  let isSyncingFromPreview = false;

  source.addEventListener('scroll', () => {
    if (!syncScrollEnabled || isSyncingFromPreview) return;

    // Guard against divide by zero when content fits viewport
    const sourceScrollable = source.scrollHeight - source.clientHeight;
    const previewScrollable = preview.scrollHeight - preview.clientHeight;
    if (sourceScrollable <= 0 || previewScrollable <= 0) return;

    isSyncingFromSource = true;
    const scrollPercent = source.scrollTop / sourceScrollable;
    const targetScroll = scrollPercent * previewScrollable;
    preview.scrollTop = targetScroll;

    requestAnimationFrame(() => {
      isSyncingFromSource = false;
    });
  });

  preview.addEventListener('scroll', () => {
    if (!syncScrollEnabled || isSyncingFromSource) return;

    // Guard against divide by zero when content fits viewport
    const previewScrollable = preview.scrollHeight - preview.clientHeight;
    const sourceScrollable = source.scrollHeight - source.clientHeight;
    if (previewScrollable <= 0 || sourceScrollable <= 0) return;

    isSyncingFromPreview = true;
    const scrollPercent = preview.scrollTop / previewScrollable;
    const targetScroll = scrollPercent * sourceScrollable;
    source.scrollTop = targetScroll;

    requestAnimationFrame(() => {
      isSyncingFromPreview = false;
    });
  });
}

// Allowed URL schemes for external links
const ALLOWED_EXTERNAL_SCHEMES = ['http:', 'https:'];
const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:'];

function isAllowedLinkScheme(href) {
  if (!href) return false;
  try {
    // Relative URLs and anchors are safe for in-page navigation
    if (href.startsWith('#')) return true;
    const url = new URL(href, 'http://example.com');
    return ALLOWED_LINK_SCHEMES.includes(url.protocol);
  } catch {
    return href.startsWith('#');
  }
}

function isExternalLink(href) {
  if (!href) return false;
  try {
    const url = new URL(href, 'http://example.com');
    return ALLOWED_EXTERNAL_SCHEMES.includes(url.protocol);
  } catch {
    return false;
  }
}

// Make links safe - prevent dangerous schemes, open external links in browser
function setupExternalLinks(container) {
  container.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href');

    // Always prevent default to block any navigation
    link.addEventListener('click', (e) => {
      e.preventDefault();

      if (!href || !isAllowedLinkScheme(href)) {
        // Block dangerous schemes silently
        console.warn('Blocked navigation to disallowed URL:', href);
        return;
      }

      if (href.startsWith('#')) {
        // In-page anchor - scroll to element
        const targetId = href.slice(1);
        const target = document.getElementById(targetId);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }

      if (isExternalLink(href)) {
        // Open http/https in external browser
        window.inkwell.openExternal(href);
      } else if (href.startsWith('mailto:')) {
        // Open mailto in external handler
        window.inkwell.openExternal(href);
      }
    });
  });
}

// Track global handlers for cleanup
let dividerMoveHandler = null;
let dividerUpHandler = null;

// Setup divider drag to resize panes
function setupDividerResize(divider, leftPane, rightPane) {
  let isDragging = false;
  let startX = 0;
  let leftWidth = 0;

  // Remove any existing global handlers first
  cleanupDividerHandlers();

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    leftWidth = leftPane.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  dividerMoveHandler = (e) => {
    if (!isDragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.max(200, Math.min(leftWidth + delta, window.innerWidth - 250));
    leftPane.style.width = newWidth + 'px';
    leftPane.style.flex = 'none';
  };

  dividerUpHandler = () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };

  document.addEventListener('mousemove', dividerMoveHandler);
  document.addEventListener('mouseup', dividerUpHandler);
}

// Cleanup divider handlers when leaving split view
function cleanupDividerHandlers() {
  if (dividerMoveHandler) {
    document.removeEventListener('mousemove', dividerMoveHandler);
    dividerMoveHandler = null;
  }
  if (dividerUpHandler) {
    document.removeEventListener('mouseup', dividerUpHandler);
    dividerUpHandler = null;
  }
}

// Theme handling
function setTheme(theme) {
  currentTheme = theme;
  document.body.setAttribute('data-theme', theme);
  // Also update the legacy dark class for backwards compatibility
  document.body.classList.toggle('dark', theme === 'dark' || theme === 'solarized-dark');
}

// Listen for theme changes from main process
window.inkwell.onThemeChanged(({ theme }) => {
  setTheme(theme);
});

// Listen for TOC visibility changes from main process
window.inkwell.onTocVisibilityChanged(({ visible }) => {
  tocVisible = visible;
  updateTocVisibility();
});

// Update TOC visibility
function updateTocVisibility() {
  if (tocSidebar) {
    // Hide TOC only in source mode (not in split view anymore)
    const shouldHide = !tocVisible || viewMode === 'source';
    tocSidebar.classList.toggle('hidden', shouldHide);
  }
  // Update body class for layout adjustment - now includes split mode
  document.body.classList.toggle('toc-open', tocVisible && viewMode !== 'source');
}

// Build Table of Contents from headings
let tocObserver = null;

function buildToc() {
  if (!tocNav) return;

  const markdownBody = contentEl.querySelector('.markdown-body');
  if (!markdownBody) {
    tocNav.innerHTML = '<ul class="toc-list"><li class="toc-empty">No headings found</li></ul>';
    return;
  }

  const headings = markdownBody.querySelectorAll('h1, h2, h3, h4, h5, h6');
  if (headings.length === 0) {
    tocNav.innerHTML = '<ul class="toc-list"><li class="toc-empty">No headings found</li></ul>';
    return;
  }

  // Clear existing TOC and create proper list structure
  const ul = document.createElement('ul');
  ul.className = 'toc-list';

  // Build TOC list
  headings.forEach((heading, index) => {
    // Add an ID to the heading if it doesn't have one
    if (!heading.id) {
      heading.id = `heading-${index}`;
    }

    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${heading.id}`;
    a.textContent = heading.textContent;
    a.className = `toc-${heading.tagName.toLowerCase()}`;
    a.setAttribute('data-heading-id', heading.id);

    a.addEventListener('click', (e) => {
      e.preventDefault();
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Update active state
      tocNav.querySelectorAll('a').forEach(link => link.classList.remove('active'));
      a.classList.add('active');
    });

    li.appendChild(a);
    ul.appendChild(li);
  });

  tocNav.innerHTML = '';
  tocNav.appendChild(ul);

  // Set up scroll spy
  setupScrollSpy(headings);
}

// Set up IntersectionObserver for scroll spy
function setupScrollSpy(headings) {
  // Clean up previous observer
  if (tocObserver) {
    tocObserver.disconnect();
  }

  const options = {
    root: null,
    rootMargin: '-80px 0px -70% 0px',
    threshold: 0
  };

  tocObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        tocNav.querySelectorAll('a').forEach(link => {
          link.classList.toggle('active', link.getAttribute('data-heading-id') === id);
        });
      }
    });
  }, options);

  headings.forEach(heading => {
    tocObserver.observe(heading);
  });
}

// Toggle TOC visibility
function toggleToc() {
  tocVisible = !tocVisible;
  window.inkwell.setTocVisible(tocVisible);
  updateTocVisibility();
  if (tocVisible) {
    if (viewMode === 'split') {
      buildTocFromSplitPreview();
    } else if (viewMode === 'rendered') {
      buildToc();
    }
  }
}

// Toggle Zen Mode
function toggleZenMode() {
  zenMode = !zenMode;
  document.body.classList.toggle('zen-mode', zenMode);

  // Hide/show various UI elements
  if (zenMode) {
    // Hide status bar and other distractions
    statusBar.classList.add('hidden');
    if (tocSidebar) tocSidebar.classList.add('zen-hidden');
    searchBar.classList.add('hidden');
    closeSearch();
  } else {
    // Restore status bar
    if (currentRaw) statusBar.classList.remove('hidden');
    if (tocSidebar && tocVisible && viewMode !== 'source') {
      tocSidebar.classList.remove('zen-hidden');
    }
  }
}

// Listen for toggle-toc from menu
window.inkwell.onToggleToc(() => {
  toggleToc();
});

// Listen for file opened from main process
window.inkwell.onFileOpened(({ html, raw, fileName, filePath }) => {
  currentHtml = html;
  currentRaw = raw;
  currentFilePath = filePath;
  currentFileName = fileName;
  viewMode = 'rendered'; // Reset to rendered view on new file
  setDirty(false);
  window.inkwell.setViewMode('rendered');
  renderMarkdown(html);
  updateStatusBar();
});

// Listen for file changed (live reload)
window.inkwell.onFileChanged(({ html, raw }) => {
  // If there are unsaved changes, show conflict banner instead of auto-reloading
  if (isDirty) {
    showConflictBanner(html, raw);
    return;
  }

  currentHtml = html;
  currentRaw = raw;
  // Preserve scroll position
  const scrollY = window.scrollY;
  renderCurrentView();
  window.scrollTo(0, scrollY);
  updateStatusBar();
});

// Show conflict resolution banner when file changes externally with unsaved edits
let pendingExternalHtml = null;
let pendingExternalRaw = null;

function showConflictBanner(html, raw) {
  pendingExternalHtml = html;
  pendingExternalRaw = raw;

  // Create conflict banner if it doesn't exist
  let conflictBanner = document.getElementById('conflict-banner');
  if (!conflictBanner) {
    conflictBanner = document.createElement('div');
    conflictBanner.id = 'conflict-banner';
    conflictBanner.className = 'conflict-banner';
    conflictBanner.innerHTML = `
      <span class="conflict-message">File changed on disk. You have unsaved changes.</span>
      <button id="conflict-reload" class="conflict-btn">Reload from disk</button>
      <button id="conflict-keep" class="conflict-btn conflict-btn-primary">Keep my changes</button>
    `;
    document.body.insertBefore(conflictBanner, document.body.firstChild.nextSibling.nextSibling);

    document.getElementById('conflict-reload').addEventListener('click', () => {
      hideConflictBanner();
      if (pendingExternalHtml !== null) {
        currentHtml = pendingExternalHtml;
        currentRaw = pendingExternalRaw;
        setDirty(false);
        renderCurrentView();
        updateStatusBar();
      }
      pendingExternalHtml = null;
      pendingExternalRaw = null;
    });

    document.getElementById('conflict-keep').addEventListener('click', () => {
      hideConflictBanner();
      // Keep current edits, discard external changes
      pendingExternalHtml = null;
      pendingExternalRaw = null;
    });
  }

  conflictBanner.classList.remove('hidden');
}

function hideConflictBanner() {
  const conflictBanner = document.getElementById('conflict-banner');
  if (conflictBanner) {
    conflictBanner.classList.add('hidden');
  }
}

// Listen for file deleted
window.inkwell.onFileDeleted(({ filePath }) => {
  showError('File was deleted or moved.');
});

// Listen for errors from main process
window.inkwell.onError(({ message }) => {
  showError(message);
});

// Handle drag and drop
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.body.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.body.classList.remove('drag-over');
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.body.classList.remove('drag-over');

  const files = Array.from(e.dataTransfer.files);
  const mdFile = files.find(f => f.name.endsWith('.md') || f.name.endsWith('.markdown'));

  if (mdFile) {
    // Use webUtils.getPathForFile via preload to get path in sandbox mode
    const filePath = window.inkwell.getFilePath(mdFile);
    if (filePath) {
      const result = await window.inkwell.openDroppedFile(filePath);
      if (result) {
        if (result.error) {
          showError(result.error);
        } else if (result.html) {
          currentHtml = result.html;
          currentRaw = result.raw;
          currentFilePath = result.filePath;
          currentFileName = result.fileName;
          viewMode = 'rendered';
          setDirty(false);
          window.inkwell.setViewMode('rendered');
          renderMarkdown(result.html);
          updateStatusBar();
        }
      }
    } else {
      showError('Could not get file path.');
    }
  } else {
    showError('Please drop a .md or .markdown file.');
  }
});

// ===== Find in Document =====

// Toggle search bar visibility
function toggleSearch() {
  const isHidden = searchBar.classList.contains('hidden');
  if (isHidden) {
    searchBar.classList.remove('hidden');
    searchInput.focus();
    searchInput.select();
  } else {
    closeSearch();
  }
}

// Close search bar
function closeSearch() {
  searchBar.classList.add('hidden');
  clearSearch();
  searchInput.value = '';
}

// Clear all search highlights
function clearSearch() {
  // Remove all existing mark elements and restore text
  const marks = contentEl.querySelectorAll('mark.search-highlight');
  marks.forEach(mark => {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  searchMatches = [];
  currentMatchIndex = -1;
  updateSearchCount();
}

// Perform search using text node walking (XSS-safe, no innerHTML)
// Uses chunked processing for large documents to prevent UI freezing
function performSearch(query) {
  clearSearch();

  if (!query || query.trim() === '') {
    return;
  }

  const normalizedQuery = query.toLowerCase();
  const markdownBody = contentEl.querySelector('.markdown-body');

  if (!markdownBody) {
    updateSearchCount();
    return;
  }

  // Walk all text nodes and find matches
  const textNodes = [];
  const walker = document.createTreeWalker(
    markdownBody,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let node;
  while ((node = walker.nextNode())) {
    textNodes.push(node);
  }

  // Process text nodes in chunks for large documents
  const CHUNK_SIZE = 100;
  let currentIndex = 0;

  function processChunk() {
    const endIndex = Math.min(currentIndex + CHUNK_SIZE, textNodes.length);

    for (let i = currentIndex; i < endIndex; i++) {
      const textNode = textNodes[i];
      const text = textNode.textContent;
      const lowerText = text.toLowerCase();
      let lastIndex = 0;
      const fragments = [];
      let matchIndex = lowerText.indexOf(normalizedQuery, lastIndex);

      while (matchIndex !== -1) {
        // Add text before match
        if (matchIndex > lastIndex) {
          fragments.push(document.createTextNode(text.slice(lastIndex, matchIndex)));
        }

        // Create mark element for match
        const mark = document.createElement('mark');
        mark.className = 'search-highlight';
        mark.textContent = text.slice(matchIndex, matchIndex + query.length);
        fragments.push(mark);
        searchMatches.push(mark);

        lastIndex = matchIndex + query.length;
        matchIndex = lowerText.indexOf(normalizedQuery, lastIndex);
      }

      // Add remaining text
      if (lastIndex < text.length) {
        fragments.push(document.createTextNode(text.slice(lastIndex)));
      }

      // Replace text node with fragments if matches found in this node
      if (fragments.length > 0 && fragments.some(f => f.nodeName === 'MARK')) {
        const parent = textNode.parentNode;
        if (parent) {
          fragments.forEach(fragment => {
            parent.insertBefore(fragment, textNode);
          });
          parent.removeChild(textNode);
        }
      }
    }

    currentIndex = endIndex;

    // Continue processing if there are more nodes
    if (currentIndex < textNodes.length) {
      // Use requestAnimationFrame to yield to the browser
      requestAnimationFrame(processChunk);
    } else {
      // Done processing - update count and navigate to first match
      updateSearchCount();
      if (searchMatches.length > 0) {
        navigateToMatch(0);
      }
    }
  }

  // Start processing (for small docs, this completes synchronously in one chunk)
  if (textNodes.length <= CHUNK_SIZE) {
    // Small document - process synchronously
    processChunk();
  } else {
    // Large document - show progress and process in chunks
    searchCount.textContent = 'Searching...';
    requestAnimationFrame(processChunk);
  }
}

// Update match counter display
function updateSearchCount() {
  if (searchMatches.length === 0) {
    if (searchInput.value.trim()) {
      searchCount.textContent = '0 matches';
    } else {
      searchCount.textContent = '';
    }
    searchPrev.disabled = true;
    searchNext.disabled = true;
  } else {
    searchCount.textContent = `${currentMatchIndex + 1} of ${searchMatches.length}`;
    searchPrev.disabled = false;
    searchNext.disabled = false;
  }
}

// Navigate to a specific match
function navigateToMatch(index) {
  // Remove current highlight from previous match
  if (currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
    searchMatches[currentMatchIndex].classList.remove('current');
  }

  // Update index
  currentMatchIndex = index;

  // Handle wraparound
  if (currentMatchIndex < 0) {
    currentMatchIndex = searchMatches.length - 1;
  } else if (currentMatchIndex >= searchMatches.length) {
    currentMatchIndex = 0;
  }

  // Highlight current match and scroll into view
  if (currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
    const match = searchMatches[currentMatchIndex];
    match.classList.add('current');
    match.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  updateSearchCount();
}

// Navigate to next match
function nextMatch() {
  if (searchMatches.length > 0) {
    navigateToMatch(currentMatchIndex + 1);
  }
}

// Navigate to previous match
function prevMatch() {
  if (searchMatches.length > 0) {
    navigateToMatch(currentMatchIndex - 1);
  }
}

// Search input handler with debounce and minimum query length
searchInput.addEventListener('input', () => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }

  const query = searchInput.value;

  // Require minimum 2 characters to search (reduces CPU usage on large docs)
  if (query.length > 0 && query.length < 2) {
    searchCount.textContent = 'Type 2+ chars';
    return;
  }

  // Use longer debounce (250ms) to reduce CPU usage during rapid typing
  searchDebounceTimer = setTimeout(() => {
    // Use requestIdleCallback if available for non-blocking search
    if (window.requestIdleCallback) {
      requestIdleCallback(() => performSearch(query), { timeout: 500 });
    } else {
      performSearch(query);
    }
  }, 250);
});

// Search keyboard navigation
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) {
      prevMatch();
    } else {
      nextMatch();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
});

// Search navigation buttons
searchNext.addEventListener('click', nextMatch);
searchPrev.addEventListener('click', prevMatch);
searchClose.addEventListener('click', closeSearch);

// Listen for toggle-find from main process (Cmd+F)
window.inkwell.onToggleFind(() => {
  toggleSearch();
});

// Listen for toggle-view-source from main process (Cmd+U)
window.inkwell.onToggleViewSource(() => {
  toggleViewSource();
});

// Save file handler
async function saveFile() {
  if (!currentFilePath) {
    showError('No file to save.');
    return;
  }

  if (viewMode === 'rendered') {
    showError('Switch to source view (Cmd+U) or split view (Cmd+Shift+S) to edit and save.');
    return;
  }

  const editor = document.getElementById('source-editor');
  if (!editor) return;

  const content = editor.value;
  const result = await window.inkwell.saveFile(currentFilePath, content);

  if (result.error) {
    showError(result.error);
    return false;
  } else {
    // Update current raw content
    currentRaw = content;
    setDirty(false);
    // File watcher will trigger reload with new HTML
    return true;
  }
}

// Listen for save-file from main process (Cmd+S)
window.inkwell.onSaveFile(() => {
  saveFile();
});

// Listen for save-and-close from main process (when closing with unsaved changes)
window.inkwell.onSaveAndClose(async () => {
  // If in rendered view, need to switch to source to get current content
  // Or we can just save currentRaw directly
  const saved = await saveCurrentContent();
  if (saved) {
    window.close();
  }
});

// Listen for save-before-open from main process (when opening a new file with unsaved changes)
window.inkwell.onSaveBeforeOpen(async ({ pendingFilePath }) => {
  const saved = await saveCurrentContent();
  if (saved) {
    // Now open the new file
    await window.inkwell.openFileAfterSave(pendingFilePath);
  }
});

// Save current content (works from any view)
async function saveCurrentContent() {
  if (!currentFilePath) return false;

  // If in source or split view, get content from editor
  let content = currentRaw;
  if (viewMode === 'source' || viewMode === 'split') {
    const editor = document.getElementById('source-editor');
    if (editor) {
      content = editor.value;
    }
  }

  const result = await window.inkwell.saveFile(currentFilePath, content);
  if (result.error) {
    showError(result.error);
    return false;
  }
  setDirty(false);
  return true;
}

// Global Escape key handler
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !searchBar.classList.contains('hidden')) {
    closeSearch();
  }
});

// ===== Status Bar =====

function updateStatusBar() {
  if (!currentRaw || zenMode) {
    statusBar.classList.add('hidden');
    return;
  }

  statusBar.classList.remove('hidden');

  // Count words (split by whitespace, filter empty)
  const words = currentRaw.trim().split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;

  // Count characters (excluding whitespace for "characters", total for reference)
  const charCount = currentRaw.length;
  const charCountNoSpaces = currentRaw.replace(/\s/g, '').length;

  // Calculate reading time (average 200 words per minute)
  const readingMinutes = Math.ceil(wordCount / 200);

  wordCountEl.textContent = `${wordCount} word${wordCount !== 1 ? 's' : ''}`;
  charCountEl.textContent = `${charCountNoSpaces} characters`;

  // Update reading time
  let readingTimeEl = document.getElementById('reading-time');
  if (!readingTimeEl) {
    const separator = document.createElement('span');
    separator.className = 'status-separator';
    separator.textContent = '|';
    statusBar.appendChild(separator);

    readingTimeEl = document.createElement('span');
    readingTimeEl.id = 'reading-time';
    statusBar.appendChild(readingTimeEl);
  }
  readingTimeEl.textContent = `${readingMinutes} min read`;
}

// ===== Shortcuts Overlay =====

function showShortcuts() {
  shortcutsOverlay.classList.remove('hidden');
}

function hideShortcuts() {
  shortcutsOverlay.classList.add('hidden');
}

shortcutsClose.addEventListener('click', hideShortcuts);

// Close on overlay background click
shortcutsOverlay.addEventListener('click', (e) => {
  if (e.target === shortcutsOverlay) {
    hideShortcuts();
  }
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !shortcutsOverlay.classList.contains('hidden')) {
    hideShortcuts();
  }
});

// Listen for show-shortcuts from main process (Cmd+/)
window.inkwell.onShowShortcuts(() => {
  showShortcuts();
});

// ===== Export HTML =====

window.inkwell.onExportHTML(async () => {
  // Generate standalone HTML - path is managed by main process for security
  const htmlContent = generateExportHTML();
  const result = await window.inkwell.saveHTMLExport(htmlContent);
  if (result.error) {
    showError(result.error);
  }
});

function generateExportHTML() {
  const isDark = currentTheme === 'dark' || currentTheme === 'solarized-dark';
  const title = currentFileName || 'Document';

  // Theme-specific colors
  const themeColors = {
    'light': { text: '#37352f', bg: '#ffffff', bgCode: '#f7f6f3', border: '#e9e9e7', link: '#0077aa', textSecondary: '#6b6b6b' },
    'dark': { text: '#e0e0e0', bg: '#1a1a1a', bgCode: '#2d2d2d', border: '#3a3a3a', link: '#4fc3f7', textSecondary: '#a0a0a0' },
    'sepia': { text: '#5c4b37', bg: '#f5f0e6', bgCode: '#e8e2d4', border: '#d4cec2', link: '#8b5a2b', textSecondary: '#7a6a56' },
    'solarized-light': { text: '#657b83', bg: '#fdf6e3', bgCode: '#eee8d5', border: '#d3cbb7', link: '#268bd2', textSecondary: '#839496' },
    'solarized-dark': { text: '#839496', bg: '#002b36', bgCode: '#073642', border: '#094656', link: '#2aa198', textSecondary: '#93a1a1' }
  };
  const colors = themeColors[currentTheme] || themeColors['light'];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtmlText(title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 16px;
      line-height: 1.7;
      color: ${colors.text};
      background: ${colors.bg};
      max-width: 720px;
      margin: 0 auto;
      padding: 40px;
    }
    h1, h2, h3, h4, h5, h6 { font-family: Georgia, serif; font-weight: 600; margin-top: 1.5em; }
    h1 { font-size: 2.25rem; border-bottom: 1px solid ${colors.border}; padding-bottom: 0.3em; }
    h2 { font-size: 1.75rem; border-bottom: 1px solid ${colors.border}; padding-bottom: 0.2em; }
    a { color: ${colors.link}; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: 'SF Mono', Monaco, monospace; background: ${colors.bgCode}; padding: 0.2em 0.4em; border-radius: 4px; }
    pre { background: ${colors.bgCode}; padding: 1em; border-radius: 6px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    blockquote { margin: 1em 0; padding: 0.5em 1em; border-left: 3px solid ${colors.border}; color: ${colors.textSecondary}; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { padding: 10px 14px; border: 1px solid ${colors.border}; text-align: left; }
    th { background: ${colors.bgCode}; }
    img { max-width: 100%; }
  </style>
</head>
<body>
  <article>${currentHtml}</article>
</body>
</html>`;
}

function escapeHtmlText(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Listen for toggle-split-view from main process
window.inkwell.onToggleSplitView(() => {
  toggleSplitView();
});

// Listen for toggle-zen-mode from main process
window.inkwell.onToggleZenMode(() => {
  toggleZenMode();
});

// Listen for toggle-sync-scroll from main process
window.inkwell.onToggleSyncScroll(() => {
  syncScrollEnabled = !syncScrollEnabled;
});

// Initialize theme on load
(async function init() {
  try {
    const prefs = await window.inkwell.getPreferences();
    if (prefs) {
      if (prefs.theme) {
        setTheme(prefs.theme);
      }
      if (prefs.tocVisible !== undefined) {
        tocVisible = prefs.tocVisible;
        updateTocVisibility();
      }
      if (prefs.syncScrollEnabled !== undefined) {
        syncScrollEnabled = prefs.syncScrollEnabled;
      }
    }
  } catch (err) {
    console.error('Failed to load preferences:', err);
  }
})();
