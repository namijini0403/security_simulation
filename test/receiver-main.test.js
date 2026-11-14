// 받는 쪽 프로그램 실행 파일(src/receiver/main.js): 실제로 실행해 보고 끝낸다 (명세 3, 12).
// 브라우저는 열지 않는다(DEMO_NO_BROWSER=1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'src', 'receiver', 'main.js');
const KOREAN = /[가-힣]/;

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

/** 끝나기를 기다린다. 시간 안에 끝나지 않으면 강제로 끝내고 실패로 알린다. */
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

async function waitFor(check, ms, label) {
  const until = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) assert.fail(label());
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('실행: 빈 포트로 띄우면 주소를 알려 주고, 같은 PC에서 응답하며, 끝내면 끝난다', async (t) => {
  const proc = run({ RECEIVER_PORT: '0' });
  t.after(() => { if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL'); });

  const match = await waitFor(
    () => /http:\/\/127\.0\.0\.1:(\d+)\//.exec(proc.output.stdout),
    15000,
    () => `주소 안내가 나오지 않았습니다.\n${proc.output.stdout}\n${proc.output.stderr}`,
  );
  const port = Number(match[1]);
  assert.ok(port > 0);
  assert.match(proc.output.stdout, KOREAN);
  assert.match(proc.output.stdout, /받는 쪽/);

  const ping = await fetch(`http://127.0.0.1:${port}/api/ping`);
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { ok: true, service: 'receiver' });

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('교육용 실습 / 100% 합성 데이터 / 실제 개인정보 입력 금지'));

  const status = await (await fetch(`http://127.0.0.1:${port}/local/switch`)).json();
  assert.equal(status.on, false, '실행 직후에는 꺼져 있다');
  assert.equal(status.limitMs, 30 * 60 * 1000);

  proc.child.kill();
  await waitExit(proc, 10000, '끝내기');
  // 끝난 뒤에는 더 이상 응답하지 않는다.
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/ping`));
});

test('실행: 포트가 이미 쓰이고 있으면 한국어로 알리고 끝난다', async (t) => {
  const blocker = net.createServer();
  blocker.listen({ port: 0, host: '127.0.0.1', exclusive: true });
  await once(blocker, 'listening');
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const port = blocker.address().port;

  const proc = run({ RECEIVER_PORT: String(port) });
  t.after(() => { if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL'); });
  const { code } = await waitExit(proc, 15000, '포트 충돌');
  assert.notEqual(code, 0);
  assert.equal(code, 1);
  const text = proc.output.stderr + proc.output.stdout;
  assert.ok(text.includes(`${port}번 포트`), text);
  assert.match(text, /닫은 뒤 다시 실행/);
  assert.doesNotMatch(text, /EADDRINUSE|at .*\.js:\d+/, '어려운 오류 글자를 그대로 보여주지 않는다');
});

test('실행: 포트 설정이 잘못되어 있으면 한국어로 알리고 끝난다', async (t) => {
  const proc = run({ RECEIVER_PORT: 'abc' });
  t.after(() => { if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL'); });
  const { code } = await waitExit(proc, 15000, '잘못된 설정');
  assert.equal(code, 1);
  assert.match(proc.output.stderr, /RECEIVER_PORT/);
  assert.match(proc.output.stderr, KOREAN);
  assert.doesNotMatch(proc.output.stderr, /at .*\.js:\d+/);
});
