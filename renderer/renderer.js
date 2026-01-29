const contentEl = document.getElementById('content');
const errorBanner = document.getElementById('error-banner');
const errorMessage = document.getElementById('error-message');
const errorDismiss = document.getElementById('error-dismiss');

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
}

// Listen for file opened from main process
window.inkwell.onFileOpened(({ html, fileName }) => {
  renderMarkdown(html);
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
