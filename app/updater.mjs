/**
 * 自动更新：读 GitHub Releases 的 latest.yml 比版本，有新版就后台差分下载，退出时装上。
 *
 * 为什么是安装版（NSIS）而不是原来的免安装 exe（2026-09-02 用户拍板）：
 * 包里 87MB 绝大部分是 Electron 运行时，日常改的只有几十 KB 的 JS。安装版带 blockmap，
 * electron-updater 会逐块比对、只下改动的块（几 MB 量级）；免安装单文件是自解压包，
 * 官方不支持差分，每次都得全量重下。更新会变常态，这个差价是一直摊着的。
 *
 * 呈现取舍（与多机同步一致）：抖动不报红。检查失败不进界面，只有「下载中 / 已就绪」
 * 才出提示条——更新失败用户也无事可做，报红只是让人白紧张；真要看结果就点托盘里的
 * 「检查更新」，那是用户主动问的，才回话。
 */
import electron from 'electron';
import updaterPkg from 'electron-updater';

const { app, dialog } = electron;
const { autoUpdater } = updaterPkg;

const FIRST_CHECK_MS = 15_000;      // 启动即查会和首帧抢网络，让一让
// 半小时一轮。原来是 6 小时，实测太懒：托盘常驻的实例启动后查一次，用户中途打开面板
// 看到的永远是几小时前的结论（用户 2026-09-02 报「最新 0.9.12，我这看不到提示」）。
// 一次检查只是拉几百字节的 latest.yml，密一点不心疼。
const EVERY_MS = 30 * 60 * 1000;
// 打开面板时补查一次——那正是用户会看角标的时刻；这个节流防止反复开关窗口猛敲接口。
const ON_SHOW_MIN_GAP_MS = 3 * 60 * 1000;

/** git/网络类报错的人话归纳，只在用户主动点「检查更新」时用得上。 */
const HINTS = [
  [/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket|proxy|certificate/i, '网络连不上 GitHub（代理或网络问题）'],
  [/404|not found/i, '还没有发布过版本，或仓库地址变了'],
  [/permission|EPERM|EACCES|EBUSY/i, '没权限写安装目录（换个目录装，或退出后重试）'],
];
export function explainUpdateError(raw) {
  const s = String(raw ?? '');
  for (const [re, hint] of HINTS) if (re.test(s)) return hint;
  return null;
}

/**
 * @param opts.onState 状态变化回调，参数即 state()（渲染进程据此画提示条）
 * @param opts.beforeQuit 重启安装前调用，让主进程放行关窗（托盘版关窗默认只隐藏）
 */
export function createUpdater({ onState = () => {}, beforeQuit = () => {} } = {}) {
  // 开发态没有 app-update.yml，任何检查都会报错；直接空转，dev 不该被更新逻辑打扰。
  const enabled = app.isPackaged;
  let state = { phase: enabled ? 'idle' : 'dev' };

  const set = (next) => { state = next; onState(state); };

  if (enabled) {
    autoUpdater.autoDownload = true;          // 差分下载，平时几 MB，不必问用户
    autoUpdater.autoInstallOnAppQuit = true;  // 用户不点「重启更新」也会在下次退出时装上
    autoUpdater.on('checking-for-update', () => set({ phase: 'checking' }));
    autoUpdater.on('update-not-available', () => set({ phase: 'none', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => set({ phase: 'downloading', version: info?.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => set({
      phase: 'downloading',
      version: state.version,
      percent: Math.round(p?.percent ?? 0),
      // 差分命中时 total 只是本次实下的字节数，正好拿来向用户证明「没重下整包」
      totalMB: p?.total ? p.total / 1e6 : null,
    }));
    autoUpdater.on('update-downloaded', (info) => set({ phase: 'ready', version: info?.version }));
    autoUpdater.on('error', (err) => set({
      phase: 'error',
      message: String(err?.message ?? err),
      hint: explainUpdateError(err?.message ?? err),
      at: Date.now(),
    }));
  }

  let lastCheckAt = 0;
  async function check() {
    if (!enabled) return state;
    lastCheckAt = Date.now();
    try { await autoUpdater.checkForUpdates(); } catch { /* 已由 error 事件记下 */ }
    return state;
  }

  /** 立刻重启装新版；没下完时什么也不做（界面此时不会给入口）。 */
  function install() {
    if (!enabled || state.phase !== 'ready') return false;
    beforeQuit();
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  return {
    state: () => state,
    check,
    install,
    /** 托盘菜单里用户主动问的一次检查：无论结果都回一句话，别让人点了没反应。 */
    async checkInteractive() {
      if (!enabled) {
        dialog.showMessageBox({ message: '开发态不检查更新。', buttons: ['好'] });
        return;
      }
      const s = await check();
      const text = {
        none: '已是最新版本。',
        downloading: `发现新版 ${s.version ?? ''}，正在后台下载。`,
        ready: `新版 ${s.version ?? ''} 已下载，重启即生效。`,
        error: `检查更新失败：${s.hint ?? s.message}`,
      }[s.phase] ?? '正在检查……';
      dialog.showMessageBox({ message: text, buttons: ['好'] });
    },
    /**
     * 点标题栏角标走这条：先确认再装。角标紧挨着关闭按钮，误点就重启应用太粗暴；
     * 确认框也是交代「不装会怎样」的地方——不装也会在下次退出时装上，用户不必现在决定。
     */
    async promptInstall() {
      if (!enabled || state.phase !== 'ready') return false;
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: `新版本 v${state.version} 已下载`,
        detail: '安装会重启应用（账本与标定已落盘，不丢数）。\n不装也会在下次退出应用时自动装上。',
        buttons: ['安装并重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return false;
      return install();
    },
    /** 面板显示时补查：用户正好在看角标的那一刻，结论不该是几小时前的。 */
    checkOnShow() {
      if (!enabled || state.phase === 'ready') return;   // 已就绪就没什么可查了
      if (Date.now() - lastCheckAt < ON_SHOW_MIN_GAP_MS) return;
      check();
    },
    start() {
      if (!enabled) return;
      setTimeout(() => check(), FIRST_CHECK_MS);
      setInterval(() => check(), EVERY_MS);
    },
  };
}
