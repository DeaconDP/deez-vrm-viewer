const { contextBridge, ipcRenderer } = require('electron');

const queuedModels = [];
const listeners = new Set();

ipcRenderer.on('open-model', (_event, payload) => {
  if (listeners.size === 0) queuedModels.push(payload);
  else listeners.forEach(listener => listener(payload));
});

contextBridge.exposeInMainWorld('desktop', {
  onOpenModel(listener) {
    listeners.add(listener);
    while (queuedModels.length) listener(queuedModels.shift());
    return () => listeners.delete(listener);
  }
});
