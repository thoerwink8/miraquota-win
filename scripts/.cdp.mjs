// 调试草稿（未跟踪）：对着带 --remote-debugging-port 的 MiraQuota 求值一段 JS。
// 用法：node scripts/.cdp.mjs <port> "<js 表达式>"
const port = process.argv[2] ?? '9334';
const expr = process.argv[3] ?? 'document.getElementById("upd").innerText';

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('没找到可调试页面：' + JSON.stringify(list.map((t) => t.type))); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const reply = new Promise((resolve) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === 1) resolve(m.result);
  };
});
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
const out = await Promise.race([reply, new Promise((r) => setTimeout(() => r({ timeout: true }), 8000))]);
console.log(JSON.stringify(out?.result ?? out));
ws.close();
