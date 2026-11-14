// 성적 관리 앱 검사에서 함께 쓰는 도구 (검사 파일이 아니다).
// 실제 서버를 빈 포트에 띄우고 실제 요청을 보낸다.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createAccessSwitch } from '../src/shared/access-switch.js';
import { closeServer, listen } from '../src/shared/http.js';
import { createGradeApp } from '../src/app/server.js';

export const SUBJECTS = ['국어', '수학', '사회', '과학', '영어'];
export const ALL_GOOD = Object.fromEntries(SUBJECTS.map((subject) => [subject, '잘함']));
export const NEIGHBOR = { 'X-Demo-Screen': 'neighbor' };

/**
 * 받는 쪽을 대신하는 임시 서버. 받은 요청을 그대로 적어 둔다.
 * mode: 'ok'(정상) | 'error'(500) | 'hang'(응답하지 않음) | 'bad-draft'(초안 없는 200)
 */
export async function startReceiver() {
  const state = { mode: 'ok', requests: [], draft: '사전 작성된 모의 응답: 꾸준히 노력합니다.' };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      state.requests.push({
        method: req.method,
        path: req.url,
        contentType: req.headers['content-type'],
        body: text === '' ? null : JSON.parse(text),
      });
      if (state.mode === 'hang') return;
      if (state.mode === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"x"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.url === '/ai/draft' && state.mode !== 'bad-draft') res.end(JSON.stringify({ draft: state.draft }));
      else res.end(JSON.stringify({ ok: true }));
    });
  });
  const port = await listen(server, 0);
  return {
    state,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  };
}

/** 쓰지 않는 포트 번호(받는 쪽이 꺼져 있는 상황용). */
export async function closedPort() {
  const server = http.createServer();
  const port = await listen(server, 0);
  await closeServer(server);
  return port;
}

/**
 * 두 앱을 스위치에 등록해 띄운다. a = 권한을 확인하지 않는 쪽, b = 확인하는 쪽.
 * receiver.base를 바꾸면 그 뒤의 전송 목적지가 바뀐다(진행 화면이 정하는 것을 흉내).
 */
export async function startApps(options = {}) {
  const receiver = { base: options.receiverBase ?? 'http://127.0.0.1:9' };
  const sw = createAccessSwitch({ rescanMs: 0 });
  const common = {
    getReceiverBase: () => receiver.base,
    forwardTimeoutMs: options.forwardTimeoutMs ?? 1500,
    // 따로 주지 않으면 없는 폴더를 쓴다(화면 파일이 생겨도 검사 결과가 달라지지 않게).
    publicDir: options.publicDir ?? path.join(os.tmpdir(), 'grade-app-no-such-folder'),
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxLogEntries ? { maxLogEntries: options.maxLogEntries } : {}),
  };
  const a = createGradeApp({ label: '1번 앱', checkPermission: false, cookieName: 'gsid_a', ...common });
  const b = createGradeApp({ label: '2번 앱', checkPermission: true, cookieName: 'gsid_b', ...common });
  const la = await sw.listen({ name: 'app1', port: 0, handler: a.handler });
  const lb = await sw.listen({ name: 'app2', port: 0, handler: b.handler });
  return {
    a,
    b,
    receiver,
    urlA: `http://127.0.0.1:${la.port}`,
    urlB: `http://127.0.0.1:${lb.port}`,
    close: () => sw.close(),
  };
}

/** 실제 요청 하나. 쿠키는 손으로 넘긴다. */
export async function call(base, method, path, { cookie, body, headers, rawBody } = {}) {
  const requestHeaders = { ...(headers || {}) };
  if (cookie) requestHeaders.Cookie = cookie;
  let payload;
  if (rawBody !== undefined) payload = rawBody;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined && !('Content-Type' in requestHeaders)) requestHeaders['Content-Type'] = 'application/json';
  const response = await fetch(base + path, { method, headers: requestHeaders, body: payload, redirect: 'manual' });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  const setCookies = response.headers.getSetCookie();
  return {
    status: response.status,
    json,
    text,
    headers: Object.fromEntries(response.headers),
    setCookies,
    cookie: setCookies.map((line) => line.split(';')[0]).join('; '),
  };
}

/** 로그인하고 쿠키 글자('이름=값')를 돌려준다. */
export async function login(base, loginId) {
  const password = loginId === 'teacher' ? 'teacher1234' : 'demo1234';
  const response = await call(base, 'POST', '/api/login', { body: { loginId, password } });
  if (response.status !== 200) throw new Error(`로그인 실패: ${loginId} ${response.status}`);
  return response.cookie;
}
