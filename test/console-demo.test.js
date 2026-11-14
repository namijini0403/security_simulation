// 시연 프로그램 실행(src/demo.js)과 "진행 화면은 다른 기기에서 열리지 않는다" (명세 3, 7, 11-4, 12).
// 브라우저는 열지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { listInternalAddresses } from '../src/shared/address.js';
import { startDemo } from '../src/demo.js';
import { NO_SUCH_DIR, closedPort, startRig, waitFor } from './console-helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'src', 'demo.js');
const KOREAN = /[가-힣]/;

/** 연결을 시도해 본다: 'open' | 'refused'(연결 거절 등 오류) | 'timeout' */
function tryConnect(host, port, ms = 4000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(ms, () => done('timeout'));
    socket.once('connect', () => done('open'));
    socket.once('error', () => done('refused'));
  });
}

test('진행 화면은 스위치가 켜져 있어도 이 PC의 내부 주소로는 열리지 않는다. 두 앱은 열린다', async (t) => {
  const addresses = listInternalAddresses();
  if (addresses.length === 0) {
    t.skip('이 PC에 내부 주소(사설 IPv4)가 없어서 확인하지 못함');
    return;
  }
  const rig = await startRig(t, { receiver: false });
  const { console: consolePort, app1, app2 } = rig.demo.ports;
  const lan = addresses[0];

  // 꺼져 있을 때: 앱도 진행 화면도 내부 주소로는 연결되지 않는다.
  assert.notEqual(await tryConnect(lan, app1), 'open');
  assert.notEqual(await tryConnect(lan, consolePort), 'open');

  const on = await rig.post('/api/switch', { action: 'on', confirmed: true });
  assert.equal(on.json.state.switch.on, true);
  assert.ok(on.json.state.switch.addresses.includes(lan));

  // 켜져 있을 때: 두 앱은 내부 주소로 실제로 열린다.
  for (const port of [app1, app2]) {
    const res = await fetch(`http://${lan}:${port}/api/app`, { signal: AbortSignal.timeout(8000) });
    assert.equal(res.status, 200);
    assert.match((await res.json()).label, /번 앱$/);
  }
  // 진행 화면은 여전히 내부 주소로는 연결 자체가 되지 않는다.
  for (const address of on.json.state.switch.addresses) {
    assert.notEqual(await tryConnect(address, consolePort), 'open', `${address}로 진행 화면이 열렸다`);
    await assert.rejects(fetch(`http://${address}:${consolePort}/api/state`, { signal: AbortSignal.timeout(8000) }));
  }
  // 같은 PC 주소로는 열려 있다.
  assert.equal((await rig.get('/api/state')).status, 200);
  // 진행 화면은 스위치에 등록되어 있지 않다.
  assert.deepEqual(rig.demo.sw.status().servers.map((server) => server.name), ['app1', 'app2']);
  assert.deepEqual(rig.demo.sw.urlsFor('console'), []);
  assert.equal(rig.demo.console.server.address().address, '127.0.0.1');

  await rig.post('/api/switch', { action: 'off' });
  assert.notEqual(await tryConnect(lan, app1), 'open', '끄면 다시 닫힌다');
});

test('startDemo: 불러오기만 해서는 아무것도 열지 않고, 닫으면 아무것도 남지 않는다', async () => {
  const receiverPort = await closedPort();
  const lines = [];
  let opened = null;
  const demo = await startDemo({
    ports: { console: 0, app1: 0, app2: 0, receiver: receiverPort },
    log: (line) => lines.push(line),
    openBrowser: (url) => { opened = url; return true; },
    appPublicDir: NO_SUCH_DIR,
  });
  try {
    assert.equal(opened, `${demo.urls.console}/`, '진행 화면을 연다');
    const text = lines.join('\n');
    assert.ok(text.includes(`진행 화면: ${demo.urls.console}/`));
    assert.ok(text.includes(demo.urls.app1) && text.includes(demo.urls.app2));
    assert.match(text, /교육용 실습 \/ 100% 합성 데이터 \/ 실제 개인정보 입력 금지/);
    const state = await (await fetch(`${demo.urls.console}/api/state`)).json();
    assert.equal(state.switch.on, false, '실행 직후에는 꺼져 있다');
    assert.equal(state.switch.limitMs, 30 * 60 * 1000);
    assert.equal(state.receiver.port, receiverPort);
    assert.equal((await (await fetch(`${demo.urls.app1}/api/app`)).json()).label, '1번 앱');
    assert.equal((await (await fetch(`${demo.urls.app2}/api/app`)).json()).label, '2번 앱');
  } finally {
    await demo.close();
  }
  for (const port of Object.values(demo.ports)) assert.notEqual(await tryConnect('127.0.0.1', port), 'open');
  await demo.close(); // 여러 번 불러도 괜찮다
});

test('startDemo: 셋 중 하나라도 열지 못하면 모두 닫고 실패한다(일부만 뜬 채로 남지 않는다)', async (t) => {
  const blocker = net.createServer();
  blocker.listen({ port: 0, host: '127.0.0.1', exclusive: true });
  await once(blocker, 'listening');
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const busy = blocker.address().port;
  const receiverPort = await closedPort();

  for (const which of ['console', 'app1', 'app2']) {
    const free = { console: await closedPort(), app1: await closedPort(), app2: await closedPort() };
    const ports = { ...free, [which]: busy, receiver: receiverPort };
    let opened = false;
    await assert.rejects(
      startDemo({ ports, log: () => {}, openBrowser: () => { opened = true; return true; }, appPublicDir: NO_SUCH_DIR }),
      (error) => error.code === 'EADDRINUSE' && error.port === busy,
      which,
    );
    assert.equal(opened, false, '실패하면 브라우저를 열지 않는다');
    for (const [name, port] of Object.entries(free)) {
      if (name !== which) assert.notEqual(await tryConnect('127.0.0.1', port), 'open', `${which} 실패 뒤 ${name}이 남아 있다`);
    }
  }
});

// --------------------------------------------------------------------------- 실제로 실행해 보기

function run(env) {
  const child = spawn(process.execPath, [MAIN], {
    cwd: ROOT,
    env: { ...process.env, DEMO_NO_BROWSER: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output.stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, output, exited };
}

async function waitExit(proc, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  const result = await Promise.race([proc.exited, timeout]);
  clearTimeout(timer);
  if (result === null) {
    proc.child.kill('SIGKILL');
    await proc.exited;
    assert.fail(`${label}: ${ms}ms 안에 끝나지 않았습니다.\n${proc.output.stdout}\n${proc.output.stderr}`);
  }
  return result;
}

const killLater = (t, proc) => t.after(() => {
  if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL');
});

test('실행: 빈 포트로 띄우면 진행 화면 주소를 알려 주고, 응답하며, 끝내면 끝난다', async (t) => {
  const receiverPort = await closedPort();
  const proc = run({ CONSOLE_PORT: '0', APP1_PORT: '0', APP2_PORT: '0', RECEIVER_PORT: String(receiverPort) });
  killLater(t, proc);

  const match = await waitFor(
    () => /진행 화면: http:\/\/127\.0\.0\.1:(\d+)\//.exec(proc.output.stdout),
    15000,
    () => `주소 안내가 나오지 않았습니다.\n${proc.output.stdout}\n${proc.output.stderr}`,
  );
  const port = Number(match[1]);
  assert.ok(port > 0);
  assert.match(proc.output.stdout, KOREAN);
  const appPorts = [...proc.output.stdout.matchAll(/번 앱: http:\/\/127\.0\.0\.1:(\d+)\//g)].map((m) => Number(m[1]));
  assert.equal(appPorts.length, 2);

  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.step.id, 'start');
  assert.equal(state.switch.on, false);
  assert.equal(state.revealed, false);
  assert.equal(state.receiver.port, receiverPort);
  assert.equal((await fetch(`http://127.0.0.1:${appPorts[0]}/api/roster`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${appPorts[1]}/api/roster`)).status, 401);

  proc.child.kill();
  await waitExit(proc, 10000, '끝내기');
  for (const p of [port, ...appPorts]) await assert.rejects(fetch(`http://127.0.0.1:${p}/api/state`));
});

test('실행: 포트가 이미 쓰이고 있으면 한국어로 알리고 끝난다. 아무것도 남지 않는다', async (t) => {
  const blocker = net.createServer();
  blocker.listen({ port: 0, host: '127.0.0.1', exclusive: true });
  await once(blocker, 'listening');
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const busy = blocker.address().port;
  const receiverPort = await closedPort();

  // 2번 앱의 포트가 막혀 있다: 1번 앱이 먼저 떴더라도 함께 닫혀야 한다.
  const app1Port = await closedPort();
  const consolePort = await closedPort();
  const proc = run({
    CONSOLE_PORT: String(consolePort), APP1_PORT: String(app1Port), APP2_PORT: String(busy), RECEIVER_PORT: String(receiverPort),
  });
  killLater(t, proc);
  const { code } = await waitExit(proc, 15000, '포트 충돌');
  assert.equal(code, 1);
  const text = proc.output.stderr + proc.output.stdout;
  assert.ok(text.includes(`${busy}번 포트`), text);
  assert.match(text, /닫은 뒤 다시 실행/);
  assert.doesNotMatch(text, /EADDRINUSE|at .*\.js:\d+/, '어려운 오류 글자를 그대로 보여주지 않는다');
  assert.doesNotMatch(proc.output.stdout, /진행 화면: http/, '시작했다고 알리지 않는다');
  assert.notEqual(await tryConnect('127.0.0.1', app1Port), 'open');
  assert.notEqual(await tryConnect('127.0.0.1', consolePort), 'open');
});

test('실행: 포트 설정이 잘못되어 있으면 한국어로 알리고 끝난다', async (t) => {
  for (const env of [{ APP1_PORT: 'abc' }, { RECEIVER_PORT: '0' }]) {
    const proc = run({ CONSOLE_PORT: '0', APP1_PORT: '0', APP2_PORT: '0', ...env });
    killLater(t, proc);
    const { code } = await waitExit(proc, 15000, '잘못된 설정');
    assert.equal(code, 1);
    assert.match(proc.output.stderr, new RegExp(Object.keys(env)[0]));
    assert.match(proc.output.stderr, KOREAN);
    assert.doesNotMatch(proc.output.stderr, /at .*\.js:\d+/);
  }
});
