// 받는 쪽 프로그램: 화면과 다른 기기 접속 스위치 (명세 6, 7, 11-3)
// 실제 서버를 빈 포트에 띄우고 실제 요청으로 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { createReceiver, SWITCH_PATHS } from '../src/receiver/server.js';
import { createStudents } from '../src/shared/data.js';
import { listInternalAddresses } from '../src/shared/address.js';
import { DEFAULT_LIMIT_MS, SWITCH_MESSAGES } from '../src/shared/access-switch.js';

const KOREAN = /[가-힣]/;
const MINUTE = 60 * 1000;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function fakeClock(start = 1_700_000_000_000) {
  let current = start;
  return { now: () => current, advance(ms) { current += ms; } };
}

async function start(t, options = {}) {
  const receiver = createReceiver({ ...options, port: 0 });
  t.after(() => receiver.close());
  const { url, port } = await receiver.listen();
  return { receiver, url, port };
}

const offline = { listAddresses: () => [] };

async function getStatus(url) {
  const res = await fetch(`${url}${SWITCH_PATHS.status}`);
  assert.equal(res.status, 200);
  return res.json();
}

function control(url, name, body) {
  return fetch(`${url}${SWITCH_PATHS[name]}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function canConnect(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

test('조작 경로는 정해진 네 가지(와 알림 닫기)다', () => {
  assert.deepEqual(SWITCH_PATHS, {
    status: '/local/switch',
    on: '/local/switch/on',
    extend: '/local/switch/extend',
    off: '/local/switch/off',
    dismiss: '/local/switch/dismiss',
  });
});

test('같은 PC에서는 화면이 열린다', async (t) => {
  const { url } = await start(t, { switchOptions: offline });
  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.ok(html.includes('교육용 실습 / 100% 합성 데이터 / 실제 개인정보 입력 금지'));
  // 화면이 쓰는 파일도 같은 프로그램에서 나온다.
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) {
    assert.match(ref, /^\/[\w.-]+$/);
    const res = await fetch(`${url}${ref}`);
    assert.equal(res.status, 200, ref);
    await res.arrayBuffer();
  }
});

test('스위치: 처음엔 꺼져 있고, 기본 시간은 30분이다', async (t) => {
  const { url, receiver } = await start(t, { switchOptions: offline });
  const status = await getStatus(url);
  assert.equal(status.on, false);
  assert.equal(status.remainingMs, 0);
  assert.equal(status.limitMs, DEFAULT_LIMIT_MS);
  assert.equal(status.limitMs, 30 * MINUTE);
  assert.equal(status.autoOff, false);
  assert.deepEqual(status.openAddresses, []);
  assert.equal(receiver.accessSwitch.status().on, false);
});

test('스위치: 확인 값이 없으면 켜지지 않는다', async (t) => {
  const { url, receiver } = await start(t, { switchOptions: offline });
  for (const body of [undefined, {}, { confirmed: false }, { confirmed: 'true' }, { confirmed: 1 }, { confirm: true }, [true], 'true']) {
    const res = await control(url, 'on', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, KOREAN);
    assert.equal(receiver.accessSwitch.status().on, false);
  }
  const broken = await fetch(`${url}${SWITCH_PATHS.on}`, { method: 'POST', headers: JSON_HEADERS, body: '{"confirmed":' });
  assert.equal(broken.status, 400);
  assert.equal((await getStatus(url)).on, false);
  // 주소로 열기(GET)만으로는 켜지지 않는다.
  const viaGet = await fetch(`${url}${SWITCH_PATHS.on}?confirmed=true`);
  assert.equal(viaGet.status, 405);
  assert.equal((await getStatus(url)).on, false);
});

test('스위치: 켜기 → 연장 → 자동 꺼짐 (시계를 손으로 옮겨 확인)', async (t) => {
  const clock = fakeClock();
  const { url } = await start(t, { switchOptions: { ...offline, now: clock.now } });

  const offExtend = await control(url, 'extend');
  assert.equal(offExtend.status, 409);
  assert.match((await offExtend.json()).error, KOREAN);

  const onRes = await control(url, 'on', { confirmed: true });
  assert.equal(onRes.status, 200);
  let status = await onRes.json();
  assert.equal(status.on, true);
  assert.equal(status.remainingMs, 30 * MINUTE);
  assert.equal(status.warning, false);

  clock.advance(28 * MINUTE + 1000);
  status = await getStatus(url);
  assert.equal(status.on, true);
  assert.equal(status.remainingMs, 2 * MINUTE - 1000);
  assert.equal(status.warning, true, '2분 남으면 알린다');

  const extended = await control(url, 'extend');
  assert.equal(extended.status, 200);
  status = await extended.json();
  assert.equal(status.remainingMs, 30 * MINUTE, '연장하면 그때부터 다시 30분');
  assert.equal(status.warning, false);

  clock.advance(29 * MINUTE);
  assert.equal((await getStatus(url)).on, true);
  clock.advance(MINUTE);
  status = await getStatus(url);
  assert.equal(status.on, false);
  assert.equal(status.autoOff, true);
  assert.equal(status.autoOffMessage, SWITCH_MESSAGES.autoOff);
  assert.equal(status.autoOffMessage, '다른 기기 접속이 자동으로 꺼졌습니다');

  const dismissed = await control(url, 'dismiss');
  assert.equal(dismissed.status, 200);
  assert.equal((await getStatus(url)).autoOff, false);
});

test('스위치: 끄기 버튼으로 언제든 끈다. 받은 내용은 그대로다', async (t) => {
  const { url } = await start(t, { switchOptions: offline });
  const row = createStudents()[0];
  await fetch(`${url}/sheet/rows`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(row) });
  assert.equal((await (await control(url, 'on', { confirmed: true })).json()).on, true);
  const off = await control(url, 'off');
  assert.equal(off.status, 200);
  const status = await off.json();
  assert.equal(status.on, false);
  assert.equal(status.autoOff, false);
  const data = await (await fetch(`${url}/api/received`)).json();
  assert.equal(data.sheet.length, 1);
});

test('스위치: 제한 시간을 넣어 줄 수 있고, 그 시간이 지나면 실제로 자동으로 꺼진다', async (t) => {
  const { url } = await start(t, { limitMs: 150, warningMs: 50, switchOptions: offline });
  const status = await (await control(url, 'on', { confirmed: true })).json();
  assert.equal(status.on, true);
  assert.equal(status.limitMs, 150);
  assert.ok(status.remainingMs <= 150);
  await sleep(400);
  const after = await getStatus(url);
  assert.equal(after.on, false);
  assert.equal(after.autoOff, true);
});

test('내부 주소를 찾지 못하면 그렇다고 알리고 확인 방법을 안내한다', async (t) => {
  const { url } = await start(t, { switchOptions: offline });
  const status = await (await control(url, 'on', { confirmed: true })).json();
  assert.equal(status.on, true);
  assert.equal(status.noInternalAddress, true);
  assert.deepEqual(status.addresses, []);
  assert.deepEqual(status.openAddresses, []);
  assert.match(status.guidance, /찾지 못했습니다/);
  assert.match(status.guidance, /ipconfig/);
});

test('사설 주소가 아닌 곳에서 온 요청은 무엇이든 403이다', async (t) => {
  const { url } = await start(t, { switchOptions: { ...offline, clientAddressOf: () => '8.8.8.8' } });
  for (const [method, pathname] of [['GET', '/api/ping'], ['GET', '/'], ['GET', '/api/received'], ['GET', SWITCH_PATHS.status], ['POST', '/api/clear']]) {
    const res = await fetch(`${url}${pathname}`, { method });
    assert.equal(res.status, 403, `${method} ${pathname}`);
    assert.match((await res.json()).error, KOREAN);
  }
});

test('다른 기기 쪽 문으로 온 요청은 화면도 스위치 조작도 거절된다', async (t) => {
  const receiver = createReceiver({ switchOptions: offline });
  t.after(() => receiver.close());
  // 스위치가 "다른 기기 쪽 문으로 들어온 요청"이라고 알려 주는 경우를 그대로 만든다(local: false).
  const info = { local: false, clientAddress: '192.168.0.77', samePc: false };
  const door = http.createServer((req, res) => receiver.handler(req, res, info));
  await new Promise((resolve) => door.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { door.close(resolve); door.closeAllConnections(); }));
  const url = `http://127.0.0.1:${door.address().port}`;

  assert.equal((await fetch(`${url}/api/ping`)).status, 200);
  for (const pathname of ['/', '/index.html', '/receiver.js', '/receiver.css', SWITCH_PATHS.status]) {
    const res = await fetch(`${url}${pathname}`);
    assert.equal(res.status, 403, pathname);
    assert.match((await res.json()).error, KOREAN);
  }
  for (const name of ['on', 'extend', 'off', 'dismiss']) {
    const res = await control(url, name, { confirmed: true });
    assert.equal(res.status, 403, name);
    assert.match((await res.json()).error, KOREAN);
  }
  assert.equal(receiver.accessSwitch.status().on, false, '다른 기기는 스위치를 켤 수 없다');
  const other = await fetch(`${url}/local/anything`);
  assert.ok([403, 404].includes(other.status));
  assert.match((await other.json()).error, KOREAN);
});

test('다른 사이트의 화면이 이 PC의 브라우저를 시켜 스위치를 조작할 수 없다', async (t) => {
  const { url, receiver, port } = await start(t, { switchOptions: offline });
  const foreign = await fetch(`${url}${SWITCH_PATHS.on}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: 'http://example.invalid' },
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(foreign.status, 403);
  assert.match((await foreign.json()).error, KOREAN);
  assert.equal(receiver.accessSwitch.status().on, false);

  // 다른 이름으로 이 프로그램을 가리키게 한 경우(주소 이름 바꿔치기)도 거절한다.
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: SWITCH_PATHS.on, method: 'POST', headers: { Host: `evil.invalid:${port}`, 'Content-Type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ confirmed: true }));
  });
  assert.equal(status, 403);
  assert.equal(receiver.accessSwitch.status().on, false);

  // 같은 화면에서 보낸 것은 된다.
  const own = await fetch(`${url}${SWITCH_PATHS.on}`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, Origin: url },
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(own.status, 200);
  assert.equal(receiver.accessSwitch.status().on, true);
});

// ---------------------------------------------------------------------------
// 이 PC의 실제 내부 주소로 접속해 보는 검사. 내부 주소가 없는 PC에서는 건너뛴다(꾸미지 않는다).

const lanAddresses = listInternalAddresses();
const lanSkip = lanAddresses.length === 0
  ? '이 PC에 내부 주소(와이파이·핫스팟 연결)가 없어서 건너뜁니다'
  : false;

test('실제 내부 주소: 꺼져 있으면 연결되지 않고, 켜면 다섯 요청만 되고, 끄면 다시 닫힌다', { skip: lanSkip }, async (t) => {
  const { url, port } = await start(t);
  const lan = lanAddresses[0];
  const lanUrl = `http://${lan}:${port}`;

  assert.equal(await canConnect(lan, port, 1500), false, '꺼져 있으면 연결 자체가 되지 않는다');

  const on = await (await control(url, 'on', { confirmed: true })).json();
  assert.equal(on.on, true);
  assert.ok(on.addresses.includes(lan));
  if (!on.openAddresses.includes(lan)) {
    t.skip(`내부 주소 ${lan}로 열지 못해서 건너뜁니다: ${JSON.stringify(on.failures)}`);
    return;
  }

  const ping = await fetch(`${lanUrl}/api/ping`);
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { ok: true, service: 'receiver' });

  const row = createStudents()[6];
  const sent = await fetch(`${lanUrl}/sheet/rows`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(row) });
  assert.equal(sent.status, 200);
  const data = await (await fetch(`${lanUrl}/api/received`)).json();
  assert.equal(data.sheet.length, 1);
  assert.equal(data.sheet[0].from, lan, '보낸 쪽 주소가 기록된다');

  for (const pathname of ['/', '/receiver.js', SWITCH_PATHS.status]) {
    const res = await fetch(`${lanUrl}${pathname}`);
    assert.equal(res.status, 403, `내부 주소로는 ${pathname}가 열리지 않는다`);
    assert.match((await res.json()).error, KOREAN);
  }
  for (const name of ['off', 'extend', 'on']) {
    const res = await fetch(`${lanUrl}${SWITCH_PATHS[name]}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ confirmed: true }) });
    assert.equal(res.status, 403, name);
  }
  assert.equal((await getStatus(url)).on, true, '내부 주소 쪽에서는 끌 수 없다');

  const off = await (await control(url, 'off')).json();
  assert.equal(off.on, false);
  assert.equal(await canConnect(lan, port, 1500), false, '끄면 새 접속이 바로 불가능해진다');
  // 같은 PC에서는 계속 되고, 받은 내용도 그대로다.
  assert.equal((await (await fetch(`${url}/api/received`)).json()).sheet.length, 1);
});

test('실제 내부 주소: 제한 시간이 지나면 다른 기기 쪽이 저절로 닫힌다', { skip: lanSkip }, async (t) => {
  const { url, port } = await start(t, { limitMs: 300, warningMs: 100 });
  const lan = lanAddresses[0];
  const on = await (await control(url, 'on', { confirmed: true })).json();
  if (!on.openAddresses.includes(lan)) {
    t.skip(`내부 주소 ${lan}로 열지 못해서 건너뜁니다: ${JSON.stringify(on.failures)}`);
    return;
  }
  await sleep(700);
  assert.equal(await canConnect(lan, port, 1500), false);
  const status = await getStatus(url);
  assert.equal(status.on, false);
  assert.equal(status.autoOff, true);
});
