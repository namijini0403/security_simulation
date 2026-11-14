import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

import {
  createAccessSwitch,
  decideRequest,
  DEFAULT_LIMIT_MS,
  DEFAULT_WARNING_MS,
  SWITCH_MESSAGES,
} from '../src/shared/access-switch.js';
import { listInternalAddresses } from '../src/shared/address.js';

const MINUTE = 60 * 1000;
const KOREAN = /[가-힣]/;

/** 가짜 시계: 시간을 손으로 옮긴다. 타이머는 기록만 하고, 필요할 때 직접 실행한다. */
function fakeClock(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    advance(ms) { current += ms; },
    setTimer(fn, ms) { const id = nextId; nextId += 1; timers.set(id, { fn, at: current + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    /** 시각이 된 타이머를 실행한다. */
    fire() {
      for (const [id, timer] of [...timers]) {
        if (timer.at <= current) { timers.delete(id); timer.fn(); }
      }
    },
    pending: () => timers.size,
  };
}

/** 내부 주소가 없는 것처럼 꾸민 스위치(다른 기기 쪽으로는 아무것도 열지 않는다). */
function offlineSwitch(clock, extra = {}) {
  return createAccessSwitch({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    listAddresses: () => [],
    ...extra,
  });
}

/** 연결을 시도한다. 연결되면 true, 실패(거절·시간 초과)면 false. */
function canConnect(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}

const counterHandler = () => {
  let count = 0;
  return (req, res, info) => {
    count += 1;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ count, info }));
  };
};

test('기본값: 30분 제한, 2분 전 알림', () => {
  assert.equal(DEFAULT_LIMIT_MS, 30 * MINUTE);
  assert.equal(DEFAULT_WARNING_MS, 2 * MINUTE);
  assert.match(SWITCH_MESSAGES.confirmWarning, /전용 실습용 연결에서만 켜세요/);
  assert.equal(SWITCH_MESSAGES.autoOff, '다른 기기 접속이 자동으로 꺼졌습니다');
  assert.match(SWITCH_MESSAGES.noInternalAddress, KOREAN);
});

test('처음에는 꺼져 있다', async (t) => {
  const clock = fakeClock();
  const sw = offlineSwitch(clock);
  t.after(() => sw.close());
  const status = sw.status();
  assert.equal(status.on, false);
  assert.equal(status.remainingMs, 0);
  assert.equal(status.limitMs, DEFAULT_LIMIT_MS);
  assert.equal(status.warning, false);
  assert.equal(status.autoOff, false);
  assert.equal(clock.pending(), 0);
});

test('확인 없이는 켜지지 않는다', async (t) => {
  const clock = fakeClock();
  const sw = offlineSwitch(clock);
  t.after(() => sw.close());
  for (const argument of [undefined, {}, { confirmed: false }, { confirmed: 'true' }, { confirmed: 1 }, true, null]) {
    const result = await sw.turnOn(argument);
    assert.equal(result.ok, false, JSON.stringify(argument));
    assert.match(result.error, KOREAN);
    assert.equal(result.status.on, false);
    assert.equal(sw.status().on, false);
  }
  assert.equal(clock.pending(), 0);
});

test('켜기 → 남은 시간 → 2분 전 알림 → 연장 → 끄기', async (t) => {
  const clock = fakeClock();
  const events = [];
  const sw = offlineSwitch(clock, { onChange: (status) => events.push(status) });
  t.after(() => sw.close());

  const turnedOn = await sw.turnOn({ confirmed: true });
  assert.equal(turnedOn.ok, true);
  assert.equal(turnedOn.status.on, true);
  assert.equal(sw.status().on, true);
  assert.equal(sw.status().remainingMs, 30 * MINUTE);
  assert.equal(sw.status().warning, false);
  assert.equal(sw.status().autoOff, false);

  clock.advance(27 * MINUTE);
  assert.equal(sw.status().remainingMs, 3 * MINUTE);
  assert.equal(sw.status().warning, false);

  clock.advance(1 * MINUTE);
  assert.equal(sw.status().remainingMs, 2 * MINUTE);
  assert.equal(sw.status().warning, true, '2분 남으면 알림');

  clock.advance(1 * MINUTE + 59_000);
  assert.equal(sw.status().remainingMs, 1000);
  assert.equal(sw.status().warning, true);
  assert.equal(sw.status().on, true);

  const extended = sw.extend();
  assert.equal(extended.ok, true);
  assert.equal(sw.status().remainingMs, 30 * MINUTE, '연장하면 그때부터 다시 30분');
  assert.equal(sw.status().warning, false);

  // 이미 켜져 있을 때 다시 켜도 남은 시간이 조용히 늘어나지 않는다(연장은 연장 버튼으로만).
  clock.advance(10 * MINUTE);
  const again = await sw.turnOn({ confirmed: true });
  assert.equal(again.ok, true);
  assert.equal(sw.status().remainingMs, 20 * MINUTE);

  const turnedOff = await sw.turnOff();
  assert.equal(turnedOff.ok, true);
  assert.equal(sw.status().on, false);
  assert.equal(sw.status().remainingMs, 0);
  assert.equal(sw.status().warning, false);
  assert.equal(sw.status().autoOff, false, '직접 끈 것은 자동 꺼짐이 아니다');
  assert.equal(clock.pending(), 0, '꺼지면 남은 타이머가 없다');

  assert.ok(events.length >= 3, '켜기·연장·끄기를 알린다');
  assert.equal(events.at(-1).on, false);
});

test('꺼져 있을 때 연장은 되지 않는다', async (t) => {
  const clock = fakeClock();
  const sw = offlineSwitch(clock);
  t.after(() => sw.close());
  const result = sw.extend();
  assert.equal(result.ok, false);
  assert.match(result.error, KOREAN);
  assert.equal(sw.status().on, false);
});

test('제한 시간이 지나면 자동으로 꺼지고 그 사실이 남는다 (가짜 시계)', async (t) => {
  const clock = fakeClock();
  const events = [];
  const sw = offlineSwitch(clock, { onChange: (status) => events.push(status) });
  t.after(() => sw.close());

  await sw.turnOn({ confirmed: true });
  clock.advance(30 * MINUTE - 1);
  clock.fire();
  assert.equal(sw.status().on, true);

  clock.advance(1);
  clock.fire();
  const status = sw.status();
  assert.equal(status.on, false);
  assert.equal(status.remainingMs, 0);
  assert.equal(status.warning, false);
  assert.equal(status.autoOff, true);
  assert.equal(status.lastEvent.type, 'auto-off');
  assert.equal(status.lastEvent.message, '다른 기기 접속이 자동으로 꺼졌습니다');
  assert.equal(events.at(-1).on, false);
  assert.equal(events.at(-1).autoOff, true);

  // 다시 켜면 자동 꺼짐 표시는 사라진다.
  await sw.turnOn({ confirmed: true });
  assert.equal(sw.status().autoOff, false);
  assert.equal(sw.status().remainingMs, 30 * MINUTE);
});

test('타이머가 늦더라도 시각이 지났으면 상태를 묻는 순간 꺼진다', async (t) => {
  const clock = fakeClock();
  const sw = offlineSwitch(clock, { limitMs: 5 * MINUTE });
  t.after(() => sw.close());
  await sw.turnOn({ confirmed: true });
  assert.equal(sw.status().limitMs, 5 * MINUTE);
  clock.advance(5 * MINUTE + 1); // 타이머는 실행하지 않는다.
  const status = sw.status();
  assert.equal(status.on, false);
  assert.equal(status.autoOff, true);
});

test('연장한 뒤에는 예전 타이머가 울려도 꺼지지 않는다', async (t) => {
  const clock = fakeClock();
  const sw = offlineSwitch(clock, { limitMs: 10 * MINUTE });
  t.after(() => sw.close());
  await sw.turnOn({ confirmed: true });
  clock.advance(9 * MINUTE);
  sw.extend();
  clock.advance(5 * MINUTE);
  clock.fire();
  assert.equal(sw.status().on, true);
  assert.equal(sw.status().remainingMs, 5 * MINUTE);
  clock.advance(5 * MINUTE);
  clock.fire();
  assert.equal(sw.status().on, false);
  assert.equal(sw.status().autoOff, true);
});

test('자동 꺼짐 알림을 확인하면 표시가 지워진다', async (t) => {
  const clock = fakeClock();
  const sw = offlineSwitch(clock, { limitMs: 1000 });
  t.after(() => sw.close());
  await sw.turnOn({ confirmed: true });
  clock.advance(1000);
  assert.equal(sw.status().autoOff, true);
  sw.clearAutoOffNotice();
  assert.equal(sw.status().autoOff, false);
});

test('실제 타이머로도 자동으로 꺼진다 (짧은 제한 시간)', async (t) => {
  const sw = createAccessSwitch({ limitMs: 120, warningMs: 60, listAddresses: () => [] });
  t.after(() => sw.close());
  const autoOff = new Promise((resolve) => {
    sw.onChange((status) => { if (!status.on && status.autoOff) resolve(status); });
  });
  await sw.turnOn({ confirmed: true });
  assert.equal(sw.status().on, true);
  assert.ok(sw.status().remainingMs <= 120);
  const status = await autoOff;
  assert.equal(status.on, false);
  assert.equal(sw.status().autoOff, true);
});

test('내부 주소를 찾지 못하면 그렇다고 알린다', async (t) => {
  const clock = fakeClock();
  const sw = offlineSwitch(clock);
  t.after(() => sw.close());
  const listening = await sw.listen({ name: 'app1', port: 0, handler: counterHandler() });
  await sw.turnOn({ confirmed: true });
  const status = sw.status();
  assert.equal(status.on, true);
  assert.deepEqual(status.addresses, []);
  assert.equal(status.noInternalAddress, true);
  assert.match(status.guidance, KOREAN);
  assert.deepEqual(sw.urlsFor('app1', '/neighbor'), []);
  assert.deepEqual(status.servers, [{ name: 'app1', port: listening.port, urls: [] }]);
});

test('켜고 꺼도 같은 포트·같은 프로그램·같은 메모리 상태가 유지된다', async (t) => {
  const clock = fakeClock();
  const sw = offlineSwitch(clock);
  t.after(() => sw.close());
  const { port } = await sw.listen({ name: 'app1', port: 0, handler: counterHandler() });
  assert.ok(port > 0);
  const url = `http://127.0.0.1:${port}/`;

  const first = await getJson(url);
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 1);
  assert.equal(first.body.info.local, true);
  assert.equal(first.body.info.samePc, true);
  assert.equal(first.body.info.clientAddress, '127.0.0.1');

  await sw.turnOn({ confirmed: true });
  assert.equal((await getJson(url)).body.count, 2);
  await sw.turnOff();
  assert.equal((await getJson(url)).body.count, 3);
  await sw.turnOn({ confirmed: true });
  clock.advance(DEFAULT_LIMIT_MS);
  clock.fire();
  assert.equal(sw.status().on, false);
  assert.equal((await getJson(url)).body.count, 4);
});

test('요청마다 보낸 주소를 확인한다: 사설 주소가 아니면 403과 한국어 설명', async (t) => {
  const clock = fakeClock();
  let pretend = '127.0.0.1';
  const sw = offlineSwitch(clock, { clientAddressOf: () => pretend });
  t.after(() => sw.close());
  let handled = 0;
  const { port } = await sw.listen({
    name: 'app1',
    port: 0,
    handler: (req, res, info) => {
      handled += 1;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ info }));
    },
  });
  const url = `http://127.0.0.1:${port}/api/roster`;
  await sw.turnOn({ confirmed: true });

  for (const address of ['8.8.8.8', '::ffff:8.8.8.8', '172.32.0.1', '11.0.0.1', '192.169.0.1', '2001:db8::1', undefined]) {
    pretend = address;
    const before = handled;
    const { status, body } = await getJson(url);
    assert.equal(status, 403, String(address));
    assert.deepEqual(Object.keys(body), ['error']);
    assert.match(body.error, KOREAN);
    assert.equal(handled, before, '거절된 요청은 처리기로 넘어가지 않는다');
  }

  for (const address of ['192.168.0.7', '::ffff:192.168.0.7', '10.1.2.3', '172.16.0.9', '169.254.3.3', '::1']) {
    pretend = address;
    const { status, body } = await getJson(url);
    assert.equal(status, 200, address);
    assert.equal(body.info.clientAddress, address);
  }

  // 꺼져 있을 때도 같은 확인을 한다.
  await sw.turnOff();
  pretend = '8.8.8.8';
  assert.equal((await getJson(url)).status, 403);
});

test('요청 판단 함수: 같은 PC 쪽 문과 다른 기기 쪽 문', () => {
  // 같은 PC 쪽 문으로 온 요청은 스위치와 무관하게 처리한다.
  assert.deepEqual(decideRequest({ viaLan: false, switchOn: false, clientAddress: '127.0.0.1' }), { action: 'serve' });
  assert.deepEqual(decideRequest({ viaLan: false, switchOn: true, clientAddress: '::1' }), { action: 'serve' });
  // 다른 기기 쪽 문은 스위치가 켜져 있고 사설 주소일 때만.
  for (const clientAddress of ['192.168.0.7', '10.0.0.2', '172.31.9.9', '169.254.1.2', '::ffff:192.168.0.7', '127.0.0.1']) {
    assert.deepEqual(decideRequest({ viaLan: true, switchOn: true, clientAddress }), { action: 'serve' }, clientAddress);
  }
  for (const clientAddress of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '::ffff:8.8.8.8', 'fe80::1', '', undefined]) {
    for (const viaLan of [true, false]) {
      const decision = decideRequest({ viaLan, switchOn: true, clientAddress });
      assert.equal(decision.action, 'forbid', String(clientAddress));
      assert.equal(decision.status, 403);
      assert.match(decision.error, KOREAN);
    }
  }
  // 스위치가 꺼져 있는데 다른 기기 쪽 문으로 들어온 요청은 응답 없이 끊는다.
  assert.deepEqual(decideRequest({ viaLan: true, switchOn: false, clientAddress: '192.168.0.7' }), { action: 'drop' });
  assert.deepEqual(decideRequest({ viaLan: true, switchOn: false, clientAddress: '8.8.8.8' }), { action: 'drop' });
  assert.deepEqual(decideRequest({ viaLan: true, switchOn: false, clientAddress: '127.0.0.1' }), { action: 'drop' });
});

test('포트가 이미 쓰이고 있으면 listen이 실패를 알려 준다', async (t) => {
  const clock = fakeClock();
  const first = offlineSwitch(clock);
  const second = offlineSwitch(clock);
  t.after(() => Promise.all([first.close(), second.close()]));
  const { port } = await first.listen({ name: 'app1', port: 0, handler: counterHandler() });
  await assert.rejects(
    second.listen({ name: 'app1', port, handler: counterHandler() }),
    (error) => {
      assert.equal(error.code, 'EADDRINUSE');
      assert.equal(error.port, port);
      return true;
    },
  );
  assert.deepEqual(second.status().servers, []);
  // 같은 이름을 두 번 등록할 수 없다.
  await assert.rejects(first.listen({ name: 'app1', port: 0, handler: counterHandler() }));
});

test('close()는 모든 것을 놓아준다: 포트를 다시 쓸 수 있고, 살아 있던 연결도 끝난다', async (t) => {
  const clock = fakeClock();
  const sw = offlineSwitch(clock);
  t.after(() => sw.close());
  const { port } = await sw.listen({ name: 'app1', port: 0, handler: counterHandler() });
  await sw.turnOn({ confirmed: true });

  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  // 응답을 다 받은 뒤에도 살아 있는 연결(keep-alive)을 하나 만들어 둔다.
  const socket = await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', agent }, (response) => {
      const { socket: used } = response; // 응답이 끝나면 response.socket은 비워지므로 미리 잡아 둔다.
      response.resume();
      response.once('end', () => resolve(used));
    });
    request.on('error', reject);
  });
  assert.equal(socket.destroyed, false);
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  await sw.close();
  await socketClosed;
  assert.equal(sw.status().on, false);
  assert.equal(clock.pending(), 0);
  assert.equal(await canConnect('127.0.0.1', port), false);

  const reuse = http.createServer();
  reuse.listen(port, '127.0.0.1');
  await once(reuse, 'listening');
  reuse.close();

  // 닫은 뒤에는 다시 켜지지 않는다.
  const result = await sw.turnOn({ confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(sw.status().on, false);
  await sw.close(); // 두 번 불러도 괜찮다.
});

// ---------------------------------------------------------------------------
// 실제 내부 주소로 확인하는 검사. 이 PC에 사설 IPv4 주소가 없으면 건너뛴다.
// ---------------------------------------------------------------------------
const lanAddresses = listInternalAddresses();
const lanAddress = lanAddresses[0];
const lanSkip = lanAddress
  ? false
  : '이 PC에 사설 IPv4 주소가 없어 실제 내부 주소 접속 검사를 건너뜁니다 (통과로 치지 않음)';

test('실제 내부 주소: 꺼져 있으면 연결 실패, 켜면 접속, 끄면 다시 실패', { skip: lanSkip }, async (t) => {
  const sw = createAccessSwitch({ rescanMs: 0 });
  t.after(() => sw.close());
  const seen = [];
  const { port } = await sw.listen({
    name: 'app1',
    port: 0,
    handler: (req, res, info) => {
      seen.push(info);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ count: seen.length, info }));
    },
  });
  // 스위치에 등록하지 않은 서버(진행 화면에 해당): 127.0.0.1에만 열려 있다.
  const consoleServer = http.createServer((req, res) => res.end('console'));
  consoleServer.listen(0, '127.0.0.1');
  await once(consoleServer, 'listening');
  t.after(() => { consoleServer.closeAllConnections(); consoleServer.close(); });
  const consolePort = consoleServer.address().port;

  // 1) 꺼짐: 같은 PC 주소로는 되고, 내부 주소로는 연결 자체가 안 된다.
  assert.equal(sw.status().on, false);
  assert.equal(await canConnect('127.0.0.1', port), true);
  assert.equal(await canConnect(lanAddress, port), false, '꺼져 있을 때 내부 주소로 연결되면 안 된다');

  // 2) 확인 없이 켜려 해도 여전히 연결되지 않는다.
  assert.equal((await sw.turnOn()).ok, false);
  assert.equal(await canConnect(lanAddress, port), false);

  // 3) 켜짐: 같은 포트가 내부 주소로도 열린다. 프로그램 상태는 그대로다.
  await getJson(`http://127.0.0.1:${port}/`);
  const on = await sw.turnOn({ confirmed: true });
  assert.equal(on.ok, true);
  const status = sw.status();
  assert.deepEqual(status.addresses, lanAddresses);
  assert.equal(status.noInternalAddress, false);
  assert.deepEqual(status.failures, []);
  assert.deepEqual(sw.urlsFor('app1', '/neighbor'), lanAddresses.map((a) => `http://${a}:${port}/neighbor`));
  assert.deepEqual(status.servers, [
    { name: 'app1', port, urls: lanAddresses.map((a) => `http://${a}:${port}`) },
  ]);
  assert.equal(await canConnect(lanAddress, port), true);
  const viaLan = await getJson(`http://${lanAddress}:${port}/api`);
  assert.equal(viaLan.status, 200);
  assert.equal(viaLan.body.count, 2, '켜기 전의 요청 횟수가 이어진다');
  assert.equal(viaLan.body.info.local, false, '내부 주소 쪽 문으로 들어온 요청임을 알 수 있다');
  assert.equal(viaLan.body.info.samePc, true, '보낸 주소가 이 PC의 주소이므로 같은 PC');
  assert.equal(viaLan.body.info.clientAddress, lanAddress);
  assert.equal((await getJson(`http://127.0.0.1:${port}/`)).body.info.local, true);

  // 4) 등록하지 않은 서버는 켜져 있어도 내부 주소로 열리지 않는다.
  assert.equal(await canConnect('127.0.0.1', consolePort), true);
  assert.equal(await canConnect(lanAddress, consolePort), false, '진행 화면은 다른 기기에서 열리지 않는다');

  // 5) 끄기: 살아 있던 연결(keep-alive)도 끊기고, 새 연결은 바로 실패한다.
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const keepAliveSocket = await new Promise((resolve, reject) => {
    const request = http.get({ host: lanAddress, port, path: '/', agent }, (response) => {
      const { socket: used } = response; // 응답이 끝나면 response.socket은 비워지므로 미리 잡아 둔다.
      response.resume();
      response.once('end', () => resolve(used));
    });
    request.on('error', reject);
  });
  assert.equal(keepAliveSocket.destroyed, false);
  const keepAliveClosed = new Promise((resolve) => keepAliveSocket.once('close', resolve));
  const off = sw.turnOff();
  assert.equal(sw.status().on, false, '끄기는 부르는 즉시 반영된다');
  await off;
  await keepAliveClosed;
  assert.equal(await canConnect(lanAddress, port), false, '끈 뒤에는 내부 주소로 연결되면 안 된다');
  assert.deepEqual(sw.urlsFor('app1', '/neighbor'), [], '꺼져 있을 때는 입력할 주소가 없다');
  const local = await getJson(`http://127.0.0.1:${port}/`);
  assert.equal(local.status, 200, '같은 PC에서는 계속 열린다');
  assert.equal(local.body.count, seen.length);
});

test('실제 내부 주소: 제한 시간이 지나면 자동으로 닫힌다', { skip: lanSkip }, async (t) => {
  const sw = createAccessSwitch({ limitMs: 400, warningMs: 100, rescanMs: 0 });
  t.after(() => sw.close());
  const { port } = await sw.listen({ name: 'receiver', port: 0, handler: counterHandler() });
  const autoOff = new Promise((resolve) => {
    sw.onChange((status) => { if (!status.on && status.autoOff) resolve(); });
  });
  await sw.turnOn({ confirmed: true });
  assert.equal((await getJson(`http://${lanAddress}:${port}/`)).status, 200);
  await autoOff;
  assert.equal(sw.status().autoOff, true);
  assert.equal(await canConnect(lanAddress, port), false, '자동으로 꺼진 뒤에는 연결되면 안 된다');
  assert.equal((await getJson(`http://127.0.0.1:${port}/`)).status, 200);

  // 다시 켜면 다시 열리고, close()로 모두 닫힌다.
  await sw.turnOn({ confirmed: true });
  assert.equal(await canConnect(lanAddress, port), true);
  await sw.close();
  assert.equal(await canConnect(lanAddress, port), false);
  assert.equal(await canConnect('127.0.0.1', port), false);
});

test('실제 내부 주소: 켜는 도중에 끄면 끝까지 닫힌 상태로 남는다', { skip: lanSkip }, async (t) => {
  const sw = createAccessSwitch({ rescanMs: 0 });
  t.after(() => sw.close());
  const { port } = await sw.listen({ name: 'app1', port: 0, handler: counterHandler() });
  const turningOn = sw.turnOn({ confirmed: true });
  const turningOff = sw.turnOff();
  await Promise.all([turningOn, turningOff]);
  assert.equal(sw.status().on, false);
  assert.equal(await canConnect(lanAddress, port), false);
});

test('실제 내부 주소: 켜진 뒤에 등록한 서버도 열리고, 주소가 바뀌면 다시 살펴서 맞춘다', { skip: lanSkip }, async (t) => {
  let addresses = [];
  const sw = createAccessSwitch({ listAddresses: () => addresses, rescanMs: 0 });
  t.after(() => sw.close());
  const first = await sw.listen({ name: 'app1', port: 0, handler: counterHandler() });
  await sw.turnOn({ confirmed: true });
  assert.equal(sw.status().noInternalAddress, true);
  assert.equal(await canConnect(lanAddress, first.port), false);

  // 켠 뒤에 연결(핫스팟 등)이 생긴 경우.
  addresses = [lanAddress];
  const refreshed = await sw.refresh();
  assert.deepEqual(refreshed.addresses, [lanAddress]);
  assert.equal(refreshed.noInternalAddress, false);
  assert.equal(await canConnect(lanAddress, first.port), true);

  const second = await sw.listen({ name: 'app2', port: 0, handler: counterHandler() });
  assert.equal(await canConnect(lanAddress, second.port), true);
  assert.deepEqual(sw.urlsFor('app2'), [`http://${lanAddress}:${second.port}/`]);

  // 연결이 사라진 경우.
  addresses = [];
  await sw.refresh();
  assert.equal(await canConnect(lanAddress, first.port), false);
  assert.equal(await canConnect(lanAddress, second.port), false);
  assert.equal(sw.status().on, true);
  assert.equal(sw.status().noInternalAddress, true);
});
