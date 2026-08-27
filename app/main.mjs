/**
 * MiraQuota 桌面版主进程：托盘常驻 + 面板窗口。
 * 数据引擎与 CLI provider 共用（provider/lib/engine.mjs），口径只有一份。
 */
import electron from 'electron';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = electron;
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Engine } from '../provider/lib/engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_MS = 5_000;    // 界面心跳：账本增量 + 倒计时
const FETCH_EVERY = 3;         // 每 3 跳问一次 /v1/limits（15 秒，与 mac 版一致）

// 单实例：重复启动把已有实例的面板唤到前台。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let tray = null;
  let engine = null;
  let ticks = 0;

  const iconPath = join(HERE, 'assets', 'tray.png');

  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  function createWindow() {
    win = new BrowserWindow({
      width: 440,
      height: 720,
      minWidth: 380,
      minHeight: 520,
      frame: false,
      backgroundColor: '#16181d',
      show: false,
      icon: iconPath,
      webPreferences: {
        preload: join(HERE, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.loadFile(join(HERE, 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());
    // 关窗即隐藏到托盘，进程常驻继续记账与标定。
    win.on('close', (e) => {
      if (!app.isQuittingForReal) { e.preventDefault(); win.hide(); }
    });
  }

  function trayTooltip(p) {
    const parts = (p.windows ?? []).slice(0, 3).map((w) => {
      const mark = w.inferred ? '≈' : '';
      const usd = w.scaledSpentUSD != null ? ` $${w.scaledSpentUSD.toFixed(1)}` : '';
      return `${w.label} ${mark}${w.usedPercent.toFixed(1)}%${usd}`;
    });
    return ['MiraQuota · ' + (p.stateLabel ?? ''), ...parts].join('\n');
  }

  function createTray() {
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('MiraQuota');
    tray.on('click', () => { if (win.isVisible()) win.hide(); else { win.show(); win.focus(); } });
    const menu = Menu.buildFromTemplate([
      { label: '显示面板', click: () => { win.show(); win.focus(); } },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: '项目主页', click: () => shell.openExternal('https://github.com/Heartcoolman/MiraQuota') },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuittingForReal = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  }

  async function tick() {
    // 每跳都刷账本与推算（payload 里的倒计时、锚点推算随时间走）；限频问接口。
    if (ticks % FETCH_EVERY === 0) await engine.poll().catch(() => {});
    else { engine.ledger.refresh(); if (engine.speed) try { engine.speed.refresh(); } catch { /* 忽略 */ } }
    ticks++;
    const p = engine.payload();
    if (win && !win.isDestroyed()) win.webContents.send('quota', p);
    if (tray) tray.setToolTip(trayTooltip(p));
  }

  app.whenReady().then(async () => {
    engine = new Engine({ forceOffline: process.argv.includes('--offline') });
    await engine.loadSpeed();
    createWindow();
    createTray();
    ipcMain.handle('quota:get', () => engine.payload());
    ipcMain.handle('app:version', () => app.getVersion());
    ipcMain.on('win:min', () => win.minimize());
    ipcMain.on('win:hide', () => win.hide());
    ipcMain.on('app:quit', () => { app.isQuittingForReal = true; app.quit(); });
    await tick();
    setInterval(() => tick().catch(() => {}), HEARTBEAT_MS);
  });

  // 所有窗口关闭也不退出——托盘常驻。
  app.on('window-all-closed', () => { /* 常驻 */ });
}
