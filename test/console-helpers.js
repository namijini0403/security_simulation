// 진행 화면 검사에서 함께 쓰는 도구 (검사 파일이 아니다).
// 시연 프로그램 전체(진행 화면 + 두 앱)를 빈 포트에 실제로 띄우고 실제 요청을 보낸다. 브라우저는 열지 않는다.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { closeServer, listen } from '../src/shared/http.js';
import { createReceiver } from '../src/receiver/server.js';
import { startDemo } from '../src/demo.js';

export const SUBJECTS = ['국어', '수학', '사회', '과학', '영어'];
export const NEIGHBOR = { 'X-Demo-Screen': 'neighbor' };
export const NO_SUCH_DIR = path.join(os.tmpdir(), 'console-test-no-such-folder');

/** 쓰지 않는 포트 번호(받는 쪽이 꺼져 있는 상황용). */
export async function closedPort() {
  const server = http.createServer();
  const port = await listen(server, 0);
  await closeServer(server);
  return port;
}

/**
 * 시연 프로그램을 띄운다. receiver: true(기본)이면 진짜 받는 쪽 프로그램도 빈 포트에 띄운다.
 * receiver: false이면 받는 쪽 포트는 아무도 듣지 않는 포트다.
 * receiverPort를 주면 받는 쪽을 띄우지 않고 그 포트를 받는 쪽 포트로 쓴다(검사가 띄운 대역용).
 */
export async function startRig(t, options = {}) {
  const { receiver: withReceiver = true, receiverPort: givenPort, ...demoOptions } = options;
  let receiver = null;
  let receiverPort;
  if (givenPort !== undefined) {
    // 검사가 직접 띄운 대역(받는 쪽 자리에 선 다른 서버)의 포트를 쓴다.
    receiverPort = givenPort;
  } else if (withReceiver) {
    receiver = createReceiver({ port: 0, publicDir: NO_SUCH_DIR });
    receiverPort = (await receiver.listen()).port;
  } else {
    receiverPort = await closedPort();
  }
  const demo = await startDemo({
    ports: { console: 0, app1: 0, app2: 0, receiver: receiverPort },
    openBrowser: false,
    log: () => {},
    appPublicDir: NO_SUCH_DIR,
    receiverCacheMs: 0,
    forwardTimeoutMs: 1500,
    // 받는 쪽이 꺼져 있는 검사에서는 받는 쪽 질의를 기다리지 않는다(필요한 검사만 따로 정한다).
    ...(withReceiver ? {} : { receiverWaitMs: 0, actionWaitMs: 0 }),
    ...demoOptions,
  });
  const rig = {
    demo,
    receiver,
    receiverPort,
    base: demo.urls.console,
    url1: demo.urls.app1,
    url2: demo.urls.app2,
    app1: demo.apps.app1,
    app2: demo.apps.app2,
    async close() {
      await demo.close();
      if (receiver) await receiver.close();
    },
    async stopReceiver() {
      if (receiver) await receiver.close();
      receiver = null;
      rig.receiver = null;
    },
    get: (pathname, init) => api(rig.base, 'GET', pathname, undefined, init),
    post: (pathname, body, init) => api(rig.base, 'POST', pathname, body, init),
    state: async (query = '') => (await api(rig.base, 'GET', `/api/state${query}`)).json,
  };
  t.after(() => rig.close());
  return rig;
}

/** 진행 화면에 보내는 실제 요청 하나. */
export async function api(base, method, pathname, body, { headers } = {}) {
  const requestHeaders = { ...(headers || {}) };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!('Content-Type' in requestHeaders)) requestHeaders['Content-Type'] = 'application/json';
  }
  const response = await fetch(base + pathname, {
    method,
    headers: requestHeaders,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, headers: Object.fromEntries(response.headers) };
}

/** 앱에 보내는 실제 요청 하나. 쿠키는 손으로 넘긴다. */
export async function appCall(base, method, pathname, { cookie, body, headers } = {}) {
  const requestHeaders = { ...(headers || {}) };
  if (cookie) requestHeaders.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    requestHeaders['Content-Type'] = 'application/json';
  }
  const response = await fetch(base + pathname, { method, headers: requestHeaders, body: payload, redirect: 'manual' });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    json,
    cookie: response.headers.getSetCookie().map((line) => line.split(';')[0]).join('; '),
  };
}

export async function appLogin(base, loginId) {
  const password = loginId === 'teacher' ? 'teacher1234' : 'demo1234';
  const response = await appCall(base, 'POST', '/api/login', { body: { loginId, password } });
  if (response.status !== 200) throw new Error(`로그인 실패: ${loginId} ${response.status}`);
  return response.cookie;
}

/**
 * Host 머리글을 마음대로 정해 보내는 요청(fetch로는 Host를 바꿀 수 없다).
 * @returns {Promise<{status: number, json: any}>}
 */
export function rawRequest(port, { method = 'GET', path: pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, setHost: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function waitFor(check, ms, label) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(typeof label === 'function' ? label() : label);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 공개 전에는 진행 화면 어디에도 나오면 안 되는 낱말. */
export const FORBIDDEN_BEFORE_REVEAL = [
  '허술', '취약', '안전', '막아 둔', '막아둔', '잘 막은', 'unsafe', 'insecure', 'secure', 'vulnerab',
  'checkPermission', 'permissionChecked', 'checksPermission', '권한 확인', '권한을 확인', '확인 안 함', '확인하지 않',
  'appWithoutCheck', '비교용 예제',
];

export function findForbidden(text) {
  const lower = text.toLowerCase();
  return FORBIDDEN_BEFORE_REVEAL.filter((word) => lower.includes(word.toLowerCase()));
}
