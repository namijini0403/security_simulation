import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readJsonBody,
  sendJson,
  sendError,
  serveStatic,
  parseCookies,
  readCookie,
  setCookie,
  clearCookie,
  openBrowser,
  listen,
  closeServer,
  portInUseMessage,
  describeStartupError,
  exitOnStartupError,
  checkNodeVersion,
  ensureNodeVersion,
} from '../src/shared/http.js';
import { DEFAULT_PORTS, readConfig } from '../src/shared/config.js';

const KOREAN = /[가-힣]/;

/** 검사용 서버를 127.0.0.1의 빈 포트에 띄운다. */
async function startServer(t, handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(error && error.stack));
    });
  });
  const port = await listen(server, 0);
  t.after(() => closeServer(server));
  return { server, port, url: `http://127.0.0.1:${port}` };
}

/** 주소를 고치지 않고 그대로 보내는 요청(.. 이 들어간 경로 확인용). */
function rawRequest(port, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

// --------------------------------------------------------------------------- 본문 읽기

async function bodyServer(t, options) {
  return startServer(t, async (req, res) => {
    try {
      const body = await readJsonBody(req, options);
      sendJson(res, 200, { received: body });
    } catch (error) {
      sendJson(res, 200, { code: error.code, status: error.status, message: error.message });
    }
  });
}

const post = (url, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(url, { method: 'POST', body, headers }).then((r) => r.json());

test('JSON 본문 읽기: 정상, 한글, 빈 본문', async (t) => {
  const { url } = await bodyServer(t);
  assert.deepEqual(await post(url, JSON.stringify({ ratings: { 국어: '잘함' } })), {
    received: { ratings: { 국어: '잘함' } },
  });
  assert.deepEqual(await post(url, ''), { received: {} });
  assert.deepEqual(await post(url, '[1,2]'), { received: [1, 2] });
});

test('JSON 본문 읽기: 형식이 틀리면 구분되는 실패', async (t) => {
  const { url } = await bodyServer(t);
  for (const bad of ['{', 'abc', '{"a":1}x', '\uFEFF{']) {
    const result = await post(url, bad);
    assert.equal(result.code, 'BODY_INVALID_JSON', bad);
    assert.equal(result.status, 400);
    assert.match(result.message, KOREAN);
  }
});

test('JSON 본문 읽기: 크기 제한을 넘으면 구분되는 실패 (제한은 부르는 쪽이 정한다)', async (t) => {
  const limit = 16 * 1024;
  const { url } = await bodyServer(t, { limitBytes: limit });
  const wrap = (length) => JSON.stringify({ a: 'x'.repeat(length - 8) });
  assert.equal(Buffer.byteLength(wrap(limit)), limit);

  const atLimit = await post(url, wrap(limit));
  assert.equal(atLimit.received.a.length, limit - 8, '제한과 같은 크기는 받는다');

  const over = await post(url, wrap(limit + 1));
  assert.equal(over.code, 'BODY_TOO_LARGE');
  assert.equal(over.status, 413);
  assert.match(over.message, KOREAN);
  assert.equal(over.received, undefined);

  // 한글은 글자 수가 아니라 바이트로 센다.
  const korean = JSON.stringify({ a: '가'.repeat(6000) });
  assert.ok(korean.length < limit && Buffer.byteLength(korean) > limit);
  assert.equal((await post(url, korean)).code, 'BODY_TOO_LARGE');

  // 길이를 미리 알리지 않고 조각으로 보내도 제한이 적용된다.
  const chunked = await new Promise((resolve, reject) => {
    const { hostname, port } = new URL(url);
    const request = http.request({ host: hostname, port, method: 'POST', path: '/' }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve(JSON.parse(text)));
    });
    request.on('error', reject);
    request.write('{"a":"');
    request.write('y'.repeat(limit));
    request.end('"}');
  });
  assert.equal(chunked.code, 'BODY_TOO_LARGE');

  // 기본 제한도 있다.
  const { url: defaultUrl } = await bodyServer(t);
  assert.equal((await post(defaultUrl, JSON.stringify({ a: 'x'.repeat(200 * 1024) }))).code, 'BODY_TOO_LARGE');
});

// --------------------------------------------------------------------------- 응답 보내기

test('JSON 응답과 한국어 오류 응답', async (t) => {
  const { url } = await startServer(t, (req, res) => {
    if (req.url === '/ok') return sendJson(res, 200, { name: '가상학생01', list: [1] });
    if (req.url === '/head') return sendJson(res, 201, { ok: true }, { 'X-Test': 'yes' });
    return sendError(res, 403, '이 요청은 허용되지 않습니다.');
  });
  const ok = await fetch(`${url}/ok`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok.json(), { name: '가상학생01', list: [1] });

  const head = await fetch(`${url}/head`);
  assert.equal(head.status, 201);
  assert.equal(head.headers.get('x-test'), 'yes');

  const denied = await fetch(`${url}/denied`);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await denied.json(), { error: '이 요청은 허용되지 않습니다.' });
});

// --------------------------------------------------------------------------- 화면 파일

async function staticFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-http-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'public');
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.mkdir(path.join(base, 'public-secret'));
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>가상반</title>');
  await fs.writeFile(path.join(root, 'style.css'), 'body{color:#000}');
  await fs.writeFile(path.join(root, 'app.js'), 'const 이름 = "가상";');
  await fs.writeFile(path.join(root, 'sub', 'index.html'), '<p>sub</p>');
  await fs.writeFile(path.join(root, 'sub', 'page.html'), '<p>page</p>');
  await fs.writeFile(path.join(root, 'data.bin'), 'bin');
  await fs.writeFile(path.join(base, 'secret.txt'), 'SECRET');
  await fs.writeFile(path.join(base, 'public-secret', 'secret.txt'), 'SECRET');
  return root;
}

async function staticServer(t, options) {
  const root = await staticFixture(t);
  return startServer(t, async (req, res) => {
    const served = await serveStatic(req, res, root, options);
    if (!served) sendError(res, 404, '찾을 수 없습니다.');
  });
}

test('화면 파일 보내기: 종류에 맞는 형식과 UTF-8', async (t) => {
  const { port } = await staticServer(t);
  const index = await rawRequest(port, '/');
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['cache-control'], 'no-store');
  assert.equal(index.body, '<!doctype html><title>가상반</title>');
  assert.equal(Number(index.headers['content-length']), Buffer.byteLength(index.body));

  assert.equal((await rawRequest(port, '/index.html')).body, index.body);
  assert.equal((await rawRequest(port, '/index.html?x=1#y')).status, 200);

  const css = await rawRequest(port, '/style.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');

  const js = await rawRequest(port, '/app.js');
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(js.body, 'const 이름 = "가상";');

  assert.equal((await rawRequest(port, '/sub/page.html')).body, '<p>page</p>');
  assert.equal((await rawRequest(port, '/sub/')).body, '<p>sub</p>');
  assert.equal((await rawRequest(port, '/data.bin')).headers['content-type'], 'application/octet-stream');

  const head = await rawRequest(port, '/style.css', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-type'], 'text/css; charset=utf-8');
});

test('화면 파일 보내기: 폴더 밖의 파일은 어떤 경로로도 나가지 않는다', async (t) => {
  const { port } = await staticServer(t);
  const attempts = [
    '/../secret.txt', '/sub/../../secret.txt', '/%2e%2e/secret.txt', '/%2E%2E%2Fsecret.txt',
    '/..%2fsecret.txt', '/..%5csecret.txt', '/..\\secret.txt', '/sub/..%5c..%5csecret.txt',
    '/%252e%252e/secret.txt', '//secret.txt', '/../public-secret/secret.txt', '/..%2fpublic-secret/secret.txt',
    '/....//secret.txt', '/%00', '/index.html%00.css', '/C:/Windows/win.ini', '/C:%5cWindows%5cwin.ini',
    '/%c0%ae%c0%ae/secret.txt', '/%', '/sub/%zz',
    '/missing.html', '/sub', '/sub/missing.css', '/index.html/', '/index.html/x',
  ];
  for (const attempt of attempts) {
    const response = await rawRequest(port, attempt);
    assert.equal(response.status, 404, `404여야 함: ${attempt} (받은 내용: ${response.body})`);
    assert.doesNotMatch(response.body, /SECRET/, attempt);
    assert.match(response.body, KOREAN);
  }
  // 읽기가 아닌 요청은 다루지 않는다(부르는 쪽이 처리).
  assert.equal((await rawRequest(port, '/index.html', 'POST')).status, 404);
});

test('화면 파일 보내기: 경로를 직접 정해 줄 수 있다 (예: /neighbor → neighbor.html)', async (t) => {
  const root = await staticFixture(t);
  const { port } = await startServer(t, async (req, res) => {
    const served = await serveStatic(req, res, root, { urlPath: '/sub/page.html' });
    if (!served) sendError(res, 404, '찾을 수 없습니다.');
  });
  assert.equal((await rawRequest(port, '/neighbor')).body, '<p>page</p>');
});

// --------------------------------------------------------------------------- 쿠키

test('쿠키 읽기', () => {
  const req = { headers: { cookie: 'app1_login=abc123; other=x%20y; empty=; app1_login=second; bad' } };
  assert.equal(readCookie(req, 'app1_login'), 'abc123', '같은 이름이 여러 번이면 첫 번째');
  assert.equal(readCookie(req, 'other'), 'x y');
  assert.equal(readCookie(req, 'empty'), '');
  assert.equal(readCookie(req, 'missing'), undefined);
  assert.equal(readCookie(req, 'toString'), undefined);
  assert.equal(readCookie(req, '__proto__'), undefined);
  assert.deepEqual({ ...parseCookies(req) }, { app1_login: 'abc123', other: 'x y', empty: '' });
  assert.deepEqual({ ...parseCookies({ headers: {} }) }, {});
  assert.equal(readCookie({ headers: { cookie: 'a=%E0%A4%A' } }, 'a'), '%E0%A4%A', '풀 수 없는 값은 그대로');
  assert.equal(readCookie({ headers: { cookie: 'a="q v"' } }, 'a'), 'q v');
});

test('쿠키 쓰기와 지우기: HttpOnly, SameSite=Lax, Path=/ 그리고 앱마다 다른 이름', async (t) => {
  const { url } = await startServer(t, (req, res) => {
    if (req.url === '/set') {
      setCookie(res, 'app1_login', 'token-1');
      setCookie(res, 'app2_login', 'token 2', { maxAgeSeconds: 60 });
      return sendJson(res, 200, {});
    }
    if (req.url === '/clear') {
      clearCookie(res, 'app1_login');
      return sendJson(res, 200, {});
    }
    return sendJson(res, 200, { app1: readCookie(req, 'app1_login') ?? null, app2: readCookie(req, 'app2_login') ?? null });
  });
  const set = await fetch(`${url}/set`);
  assert.deepEqual(set.headers.getSetCookie(), [
    'app1_login=token-1; Path=/; HttpOnly; SameSite=Lax',
    'app2_login=token%202; Path=/; HttpOnly; SameSite=Lax; Max-Age=60',
  ]);
  const cleared = await fetch(`${url}/clear`);
  assert.deepEqual(cleared.headers.getSetCookie(), ['app1_login=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']);

  const echoed = await fetch(`${url}/echo`, { headers: { cookie: 'app1_login=token-1; app2_login=token%202' } });
  assert.deepEqual(await echoed.json(), { app1: 'token-1', app2: 'token 2' });

  assert.throws(() => setCookie({ getHeader() {}, setHeader() {} }, 'bad name', 'x'));
  assert.throws(() => setCookie({ getHeader() {}, setHeader() {} }, 'a;b', 'x'));
});

// --------------------------------------------------------------------------- 브라우저 열기

function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() { return this; }, unref() {} };
  };
  return { calls, spawn };
}

test('브라우저 열기: DEMO_NO_BROWSER=1이면 열지 않는다', () => {
  const { calls, spawn } = fakeSpawn();
  assert.equal(openBrowser('http://127.0.0.1:4170/', { env: { DEMO_NO_BROWSER: '1' }, spawn, platform: 'win32' }), false);
  assert.equal(calls.length, 0);
});

test('브라우저 열기: 운영체제마다 맞는 방법으로 연다 (검사에서는 실제로 열지 않음)', () => {
  const url = 'http://127.0.0.1:4170/?a=1&b=2';
  const expected = { win32: 'rundll32', darwin: 'open', linux: 'xdg-open' };
  for (const [platform, command] of Object.entries(expected)) {
    const { calls, spawn } = fakeSpawn();
    assert.equal(openBrowser(url, { env: {}, spawn, platform }), true, platform);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, command);
    assert.equal(calls[0].args.at(-1), url);
    assert.notEqual(calls[0].options.shell, true, '주소를 명령 해석기에 넘기지 않는다');
  }
});

test('브라우저 열기: http 주소가 아니면 열지 않고, 실행에 실패해도 프로그램이 멈추지 않는다', () => {
  const { calls, spawn } = fakeSpawn();
  for (const bad of ['file:///C:/x', 'javascript:alert(1)', 'calc.exe', '', undefined, 'http://127.0.0.1:4170/" & calc']) {
    assert.equal(openBrowser(bad, { env: {}, spawn, platform: 'win32' }), false, String(bad));
  }
  assert.equal(calls.length, 0);
  const throwing = () => { throw new Error('spawn failed'); };
  assert.equal(openBrowser('http://127.0.0.1:4170/', { env: {}, spawn: throwing, platform: 'linux' }), false);
});

// --------------------------------------------------------------------------- 시작 실패 안내

test('listen: 기본은 같은 PC 전용(127.0.0.1), 실제 포트를 돌려준다', async (t) => {
  const server = http.createServer((req, res) => res.end('ok'));
  t.after(() => closeServer(server));
  const port = await listen(server, 0);
  assert.ok(Number.isInteger(port) && port > 0);
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
});

test('listen: 포트가 이미 쓰이고 있으면 어떤 포트인지 담아 실패하고, 부르는 쪽이 전부 정리할 수 있다', async (t) => {
  const busy = http.createServer();
  t.after(() => closeServer(busy));
  const busyPort = await listen(busy, 0);

  const first = http.createServer();
  const second = http.createServer();
  const started = [];
  let failure;
  try {
    started.push(first); await listen(first, 0);
    started.push(second); await listen(second, busyPort);
  } catch (error) {
    failure = error;
    await Promise.all(started.map((server) => closeServer(server)));
  }
  assert.ok(failure, '두 번째 서버는 실패해야 한다');
  assert.equal(failure.code, 'EADDRINUSE');
  assert.equal(failure.port, busyPort);
  assert.equal(first.listening, false, '먼저 뜬 서버도 정리된다');
  assert.equal(second.listening, false);

  const message = describeStartupError(failure);
  assert.match(message, KOREAN);
  assert.ok(message.includes(String(busyPort)), '어떤 포트인지 알려 준다');
  assert.match(message, /닫/, '무엇을 하면 되는지 알려 준다');
  assert.equal(message, portInUseMessage(busyPort));
  assert.doesNotMatch(message, /EADDRINUSE|bind|listen/i);
});

test('시작 실패 안내: 다른 오류도 한국어로, 알리고 끝내는 길은 부를 때만 실행된다', () => {
  const other = describeStartupError(Object.assign(new Error('permission denied'), { code: 'EACCES', port: 80 }));
  assert.match(other, KOREAN);
  assert.ok(other.includes('80'));
  assert.match(describeStartupError(new Error('boom')), KOREAN);
  assert.match(describeStartupError(undefined), KOREAN);

  const lines = [];
  const exits = [];
  exitOnStartupError(Object.assign(new Error('x'), { code: 'EADDRINUSE', port: 4173 }), {
    log: (line) => lines.push(line),
    exit: (code) => exits.push(code),
  });
  assert.deepEqual(exits, [1]);
  assert.ok(lines.join('\n').includes('4173'));
  assert.match(lines.join('\n'), KOREAN);
});

test('closeServer: 살아 있는 연결이 있어도 끝나고, 여러 번 불러도 괜찮다', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  const port = await listen(server, 0);
  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, agent }, (response) => { response.resume(); response.on('end', resolve); }).on('error', reject);
  });
  await closeServer(server);
  assert.equal(server.listening, false);
  await closeServer(server);
  await closeServer(http.createServer());
  agent.destroy();
});

test('Node.js 버전 확인: 22보다 낮으면 한국어로 알린다', () => {
  assert.deepEqual(checkNodeVersion('22.0.0'), { ok: true });
  assert.deepEqual(checkNodeVersion('v22.23.4'), { ok: true });
  assert.deepEqual(checkNodeVersion('24.1.0'), { ok: true });
  assert.deepEqual(checkNodeVersion(), { ok: true });
  for (const old of ['21.9.0', 'v20.11.1', '18.0.0', '8.17.0', 'abc', '']) {
    const result = checkNodeVersion(old);
    assert.equal(result.ok, false, old);
    assert.match(result.message, KOREAN);
    assert.ok(result.message.includes('22'));
  }
  const lines = [];
  const exits = [];
  assert.equal(ensureNodeVersion({ version: '22.1.0', log: (l) => lines.push(l), exit: (c) => exits.push(c) }), true);
  assert.deepEqual(exits, []);
  assert.equal(ensureNodeVersion({ version: '20.0.0', log: (l) => lines.push(l), exit: (c) => exits.push(c) }), false);
  assert.deepEqual(exits, [1]);
  assert.match(lines.join('\n'), KOREAN);
});

// --------------------------------------------------------------------------- 설정

test('포트 설정: 기본값과 환경 변수', () => {
  assert.deepEqual({ ...DEFAULT_PORTS }, { console: 4170, app1: 4173, app2: 4174, receiver: 4180 });
  assert.deepEqual(readConfig({}), {
    consolePort: 4170, app1Port: 4173, app2Port: 4174, receiverPort: 4180, noBrowser: false,
  });
  assert.deepEqual(
    readConfig({ CONSOLE_PORT: '5170', APP1_PORT: '5173', APP2_PORT: '5174', RECEIVER_PORT: '5180', DEMO_NO_BROWSER: '1' }),
    { consolePort: 5170, app1Port: 5173, app2Port: 5174, receiverPort: 5180, noBrowser: true },
  );
  assert.equal(readConfig({ APP1_PORT: '', DEMO_NO_BROWSER: '0' }).app1Port, 4173);
  assert.equal(readConfig({ DEMO_NO_BROWSER: '0' }).noBrowser, false);
  assert.equal(readConfig({ APP1_PORT: '0' }).app1Port, 0, '0은 빈 포트 자동 선택(검사용)');
  for (const bad of ['abc', '-1', '65536', '41.5', '4173x', ' ']) {
    assert.throws(() => readConfig({ APP1_PORT: bad }), (error) => {
      assert.match(error.message, KOREAN);
      assert.ok(error.message.includes('APP1_PORT'));
      return true;
    }, bad);
  }
  assert.ok(typeof readConfig().consolePort === 'number');
});
