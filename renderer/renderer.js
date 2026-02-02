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

// Search state
let searchMatches = [];
let currentMatchIndex = -1;
let searchDebounceTimer = null;

// View state
let currentHtml = '';
let currentRaw = '';
let currentFilePath = '';
let currentFileName = '';
let isSourceView = false;
let isDirty = false;

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
function renderMarkdown(html) {
  contentEl.innerHTML = `<article class="markdown-body">${html}</article>`;

  // Make external links open in default browser
  contentEl.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href');
    if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        window.inkwell.openExternal(href);
      });
    }
  });

  // Clear any existing search
  clearSearch();
}

// Render raw source view (editable)
function renderSource(raw) {
  const textarea = document.createElement('textarea');
  textarea.className = 'source-view';
  textarea.id = 'source-editor';
  textarea.value = raw;
  textarea.spellcheck = false;

  // Track changes for dirty state
  textarea.addEventListener('input', () => {
    if (!isDirty) {
      setDirty(true);
    }
  });

  contentEl.innerHTML = '';
  contentEl.appendChild(textarea);
  clearSearch();
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
}

// Render current view based on mode
function renderCurrentView() {
  if (isSourceView) {
    renderSource(currentRaw);
  } else {
    renderMarkdown(currentHtml);
  }
}

// Toggle between rendered and source view
async function toggleViewSource() {
  if (!currentRaw && !isSourceView) return; // No file loaded

  // If switching from source to rendered, capture edits and re-parse
  if (isSourceView) {
    const editor = document.getElementById('source-editor');
    if (editor) {
      const editedContent = editor.value;
      if (editedContent !== currentRaw) {
        currentRaw = editedContent;
        // Re-parse the markdown
        currentHtml = await window.inkwell.parseMarkdown(editedContent);
      }
    }
  }

  isSourceView = !isSourceView;
  window.inkwell.setViewMode(isSourceView);
  const scrollY = window.scrollY;
  renderCurrentView();
  window.scrollTo(0, scrollY);
}

// Dark mode handling
function setDarkMode(enabled) {
  if (enabled) {
    document.body.classList.add('dark');
  } else {
    document.body.classList.remove('dark');
  }
}

// Listen for preferences changes from main process
window.inkwell.onPreferencesChanged(({ darkMode }) => {
  setDarkMode(darkMode);
});

// Listen for file opened from main process
window.inkwell.onFileOpened(({ html, raw, fileName, filePath }) => {
  currentHtml = html;
  currentRaw = raw;
  currentFilePath = filePath;
  currentFileName = fileName;
  isSourceView = false; // Reset to rendered view on new file
  setDirty(false);
  window.inkwell.setViewMode(false);
  renderMarkdown(html);
});

// Listen for file changed (live reload)
window.inkwell.onFileChanged(({ html, raw }) => {
  currentHtml = html;
  currentRaw = raw;
  setDirty(false);
  // Preserve scroll position
  const scrollY = window.scrollY;
  renderCurrentView();
  window.scrollTo(0, scrollY);
});

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
          isSourceView = false;
          setDirty(false);
          window.inkwell.setViewMode(false);
          renderMarkdown(result.html);
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

  // Process each text node
  textNodes.forEach(textNode => {
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

    // Replace text node with fragments if matches found
    if (fragments.length > 0 && searchMatches.length > 0 && fragments.some(f => f.nodeName === 'MARK')) {
      const parent = textNode.parentNode;
      fragments.forEach(fragment => {
        parent.insertBefore(fragment, textNode);
      });
      parent.removeChild(textNode);
    }
  });

  // Update count and navigate to first match
  updateSearchCount();
  if (searchMatches.length > 0) {
    navigateToMatch(0);
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

// Search input handler with debounce
searchInput.addEventListener('input', () => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    performSearch(searchInput.value);
  }, 150);
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

  if (!isSourceView) {
    showError('Switch to source view (Cmd+U) to edit and save.');
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

// Save current content (works from any view)
async function saveCurrentContent() {
  if (!currentFilePath) return false;

  // If in source view, get content from editor
  let content = currentRaw;
  if (isSourceView) {
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

// Initialize dark mode on load
(async function init() {
  try {
    const prefs = await window.inkwell.getPreferences();
    if (prefs && prefs.darkMode) {
      setDarkMode(true);
    }
  } catch (err) {
    console.error('Failed to load preferences:', err);
  }
})();
