const { contextBridge, ipcRenderer, shell, webUtils } = require('electron');

// Validate URL scheme - only allow http and https
function isValidExternalUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

contextBridge.exposeInMainWorld('inkwell', {
  onFileOpened: (callback) => {
    ipcRenderer.on('file-opened', (event, data) => {
      callback(data);
    });
  },

  onError: (callback) => {
    ipcRenderer.on('error', (event, data) => {
      callback(data);
    });
  },

  onPreferencesChanged: (callback) => {
    ipcRenderer.on('preferences-changed', (event, data) => {
      callback(data);
    });
  },

  onFileChanged: (callback) => {
    ipcRenderer.on('file-changed', (event, data) => {
      callback(data);
    });
  },

  onFileDeleted: (callback) => {
    ipcRenderer.on('file-deleted', (event, data) => {
      callback(data);
    });
  },

  onToggleFind: (callback) => {
    ipcRenderer.on('toggle-find', () => {
      callback();
    });
  },

  onToggleViewSource: (callback) => {
    ipcRenderer.on('toggle-view-source', () => {
      callback();
    });
  },

  onSaveFile: (callback) => {
    ipcRenderer.on('save-file', () => {
      callback();
    });
  },

  onSaveAndClose: (callback) => {
    ipcRenderer.on('save-and-close', () => {
      callback();
    });
  },

  onExportHTML: (callback) => {
    ipcRenderer.on('export-html', (event, data) => {
      callback(data);
    });
  },

  onShowShortcuts: (callback) => {
    ipcRenderer.on('show-shortcuts', () => {
      callback();
    });
  },

  saveHTMLExport: async (filePath, content) => {
    return await ipcRenderer.invoke('save-html-export', { filePath, content });
  },

  saveFile: async (filePath, content) => {
    return await ipcRenderer.invoke('save-file', { filePath, content });
  },

  setViewMode: (isSourceView) => {
    ipcRenderer.invoke('set-view-mode', isSourceView);
  },

  setDirty: (dirty) => {
    ipcRenderer.invoke('set-dirty', dirty);
  },

  parseMarkdown: async (content) => {
    return await ipcRenderer.invoke('parse-markdown', content);
  },

  // Get preferences from main process
  getPreferences: () => {
    return ipcRenderer.invoke('get-preferences');
  },

  // Toggle dark mode
  toggleDarkMode: () => {
    return ipcRenderer.invoke('toggle-dark-mode');
  },

  // Clear recent files
  clearRecentFiles: () => {
    return ipcRenderer.invoke('clear-recent-files');
  },

  // Get file path from a dropped File object (works in sandbox mode)
  getFilePath: (file) => {
    return webUtils.getPathForFile(file);
  },

  openDroppedFile: async (filePath) => {
    return await ipcRenderer.invoke('open-dropped-file', filePath);
  },

  openExternal: (url) => {
    // Only allow http and https URLs
    if (isValidExternalUrl(url)) {
      shell.openExternal(url);
    } else {
      console.warn('Blocked opening URL with disallowed scheme:', url);
    }
  }
});
