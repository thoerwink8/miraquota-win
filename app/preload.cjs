// 渲染进程与主进程之间的最小桥：取数、主题、三个窗口动作，外加更新提示条要的三件。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miraquota', {
  get: () => ipcRenderer.invoke('quota:get'),
  version: () => ipcRenderer.invoke('app:version'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (v) => ipcRenderer.invoke('theme:set', v),
  onQuota: (cb) => ipcRenderer.on('quota', (_e, payload) => cb(payload)),
  update: () => ipcRenderer.invoke('update:get'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, s) => cb(s)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  minimize: () => ipcRenderer.send('win:min'),
  hide: () => ipcRenderer.send('win:hide'),
  quit: () => ipcRenderer.send('app:quit'),
});
