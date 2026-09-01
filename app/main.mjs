/**
 * MiraQuota 桌面版主进程：托盘常驻 + 面板窗口。
 * 数据引擎与 CLI provider 共用（provider/lib/engine.mjs），口径只有一份。
 */
import electron from 'electron';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = electron;
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { Engine } from '../provider/lib/engine.mjs';
import { startFeed, Injector } from '../provider/lib/injector.mjs';
import { resolveVersion } from './version.mjs';
import { createUpdater } from './updater.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP_VERSION = resolveVersion(ROOT);
const HEARTBEAT_MS = 5_000;    // 界面心跳：账本增量 + 倒计时
const FETCH_EVERY = 3;         // 每 3 跳问一次 /v1/limits（15 秒，与 mac 版一致）

// 单实例：重复启动把已有实例的面板唤到前台。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let tray = null;
  let engine = null;
  let updater = null;
  let ticks = 0;

  const iconPath = join(HERE, 'assets', 'tray.png');

  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  // 窗口位置与主题偏好同存一个文件；读失败一律回默认，不让 UI 状态挡住启动。
  const UI_FILE = join(homedir(), '.miraquota', 'ui.json');
  function readUI() {
    try { return JSON.parse(readFileSync(UI_FILE, 'utf8')) ?? {}; } catch { return {}; }
  }
  function writeUI(patch) {
    try {
      mkdirSync(join(homedir(), '.miraquota'), { recursive: true });
      writeFileSync(UI_FILE, JSON.stringify({ ...readUI(), ...patch }));
    } catch { /* ignore */ }
  }
  const savedBounds = () => readUI().bounds ?? null;

  /**
   * 主题走 Electron 原生 nativeTheme.themeSource：设成 light/dark 后渲染进程里的
   * prefers-color-scheme 随之翻转，所以 CSS 不需要为手动切换另写一套选择器。
   * 'system' 回到跟随系统。
   */
  const THEMES = ['system', 'light', 'dark'];
  function applyTheme(v) {
    const t = THEMES.includes(v) ? v : 'system';
    electron.nativeTheme.themeSource = t;
    return t;
  }

  function createWindow() {
    // 首开高度按总览页一屏取（tab 化后各页自滚动），封顶到工作区；此后记住用户调的尺寸。
    const work = electron.screen.getPrimaryDisplay().workAreaSize;
    const saved = savedBounds();
    win = new BrowserWindow({
      width: saved?.width ?? 440,
      height: saved?.height ?? Math.min(760, work.height - 60),
      ...(saved?.x != null ? { x: saved.x, y: saved.y } : {}),
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
    let saveTimer = null;
    const persistBounds = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => writeUI({ bounds: win.getBounds() }), 500);
    };
    win.on('resize', persistBounds);
    win.on('move', persistBounds);
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
      { label: '检查更新', click: () => updater?.checkInteractive() },
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
    applyTheme(readUI().theme);   // 建窗前定主题，避免首帧闪一下另一套配色
    createWindow();
    createTray();
    ipcMain.handle('quota:get', () => engine.payload());
    // 与 dist 同一口径（见 app/version.mjs）；安装包无 .git 时回退 package.json（builder 已注入）
    ipcMain.handle('app:version', () => APP_VERSION);
    // 档位倍率：落盘成功才算改成功，改完立刻重画一帧，用户不用等下一次心跳。
    ipcMain.handle('settings:pointCost', async (_e, group, ratio) => {
      const ok = engine.settings.setGroupRatio(group, ratio);
      if (ok) await tick().catch(() => {});
      return ok;
    });
    ipcMain.handle('theme:get', () => applyTheme(readUI().theme));
    ipcMain.handle('theme:set', (_e, v) => {
      const t = applyTheme(v);
      writeUI({ theme: t });
      return t;
    });
    ipcMain.on('win:min', () => win.minimize());
    ipcMain.on('win:hide', () => win.hide());
    ipcMain.on('app:quit', () => { app.isQuittingForReal = true; app.quit(); });

    // 自动更新：状态推给面板画提示条，安装前先放行关窗（托盘版关窗默认只隐藏）。
    updater = createUpdater({
      onState: (s) => { if (win && !win.isDestroyed()) win.webContents.send('update', s); },
      beforeQuit: () => { app.isQuittingForReal = true; },
    });
    ipcMain.handle('update:get', () => updater.state());
    ipcMain.handle('update:check', () => updater.check());
    ipcMain.handle('update:install', () => updater.install());
    updater.start();
    await tick();
    setInterval(() => tick().catch(() => {}), HEARTBEAT_MS);

    // 内嵌形态与桌面形态合一：feed + CDP 注入随桌面版常驻。
    // Mirasim 带 --remote-debugging-port=9333 启动时，控件自动出现在其标题栏；没带就静默巡检。
    try {
      const { server, port } = await startFeed({ payload: () => engine.payload() });
      const injector = new Injector({
        widgetPath: join(HERE, '..', 'widget', 'miraquota-widget.js'),
        log: () => {},
      });
      injector.start(port);
      app.on('will-quit', () => { injector.stop(); server.close(); });
    } catch (e) {
      console.error('feed/注入启动失败（面板不受影响）：' + e.message);
    }
  });

  // 所有窗口关闭也不退出——托盘常驻。
  app.on('window-all-closed', () => { /* 常驻 */ });
}
