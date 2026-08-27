// 渲染进程与主进程之间的最小桥：只暴露取数与三个窗口动作。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miraquota', {
  get: () => ipcRenderer.invoke('quota:get'),
  onQuota: (cb) => ipcRenderer.on('quota', (_e, payload) => cb(payload)),
  minimize: () => ipcRenderer.send('win:min'),
  hide: () => ipcRenderer.send('win:hide'),
  quit: () => ipcRenderer.send('app:quit'),
});
