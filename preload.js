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
