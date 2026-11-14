// 처음부터 끝까지 검사(e2e)에서 함께 쓰는 도구 (검사 파일이 아니다).
//
// 진짜 시연 프로그램(startDemo: 진행 화면 + 1번 앱 + 2번 앱)과 진짜 받는 쪽 프로그램(createReceiver)을
// 빈 포트에 함께 띄운다. 화면 파일도 실제 폴더의 것을 그대로 쓴다. 대신하는 서버는 없다.
// 브라우저는 열지 않는다. 모든 확인은 실제 HTTP 요청으로 한다.

import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createReceiver } from '../src/receiver/server.js';
import { startDemo } from '../src/demo.js';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SUBJECTS = ['국어', '수학', '사회', '과학', '영어'];
export const ALL_GOOD = Object.freeze({ 국어: '잘함', 수학: '잘함', 사회: '잘함', 과학: '잘함', 영어: '잘함' });
/** 옆 사람 화면이 자기 요청에 붙이는 표시(src/app/public/neighbor.js와 같은 값). */
export const NEIGHBOR = Object.freeze({ 'X-Demo-Screen': 'neighbor' });
export const NOT_LOGGED_IN = '로그인 안 함';

export const studentId = (n) => `TEST-10${String(n).padStart(2, '0')}`;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 조건이 맞을 때까지 실제로 다시 물어본다. 시간 안에 맞지 않으면 실패. */
export async function waitFor(check, ms, label) {
  const until = Date.now() + ms;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > until) assert.fail(typeof label === 'function' ? label() : label);
    await sleep(25);
  }
}

/** 연결을 시도해 본다: 'open' | 'refused'(연결 거절 등) | 'timeout' */
export function tryConnect(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(ms, () => done('timeout'));
    socket.once('connect', () => done('open'));
    socket.once('error', () => done('refused'));
  });
}

/** 실제 요청 하나. 쿠키는 손으로 넘긴다(브라우저가 하는 일을 그대로 한다). */
export async function call(base, method, pathname, { cookie, body, headers, rawBody } = {}) {
  const requestHeaders = { ...(headers || {}) };
  if (cookie) requestHeaders.Cookie = cookie;
  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
    if (!('Content-Type' in requestHeaders)) requestHeaders['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    requestHeaders['Content-Type'] = 'application/json';
  }
  const response = await fetch(base + pathname, {
    method,
    headers: requestHeaders,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
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
    bytes,
    headers: Object.fromEntries(response.headers),
    setCookies,
    cookie: setCookies.map((line) => line.split(';')[0]).filter((pair) => !pair.endsWith('=')).join('; '),
  };
}

/**
 * 진짜 시연 프로그램 + 진짜 받는 쪽 프로그램을 띄운다.
 * receiverCacheMs: 0 은 진행 화면이 받는 쪽에 "묻는 간격"만 없앤다(화면은 평소 1초에 한 번 묻는다).
 * 묻는 내용과 보여주는 내용은 그대로다.
 */
export async function startTalk(t, demoOptions = {}) {
  let receiver = createReceiver({ port: 0 });
  const receiverPort = (await receiver.listen()).port;
  const receiverBase = `http://127.0.0.1:${receiverPort}`;
  const demo = await startDemo({
    ports: { console: 0, app1: 0, app2: 0, receiver: receiverPort },
    openBrowser: false,
    log: () => {},
    receiverCacheMs: 0,
    ...demoOptions,
  });

  const rig = {
    demo,
    receiverPort,
    receiverBase,
    consoleBase: demo.urls.console,
    bases: { 1: demo.urls.app1, 2: demo.urls.app2 },
    ports: demo.ports,
    get receiver() { return receiver; },

    /** 진행 화면이 지금 보여줄 것(GET /api/state의 실제 응답). */
    async state(query = '?limit=500') {
      const res = await call(rig.consoleBase, 'GET', `/api/state${query}`);
      assert.equal(res.status, 200, res.text);
      return res.json;
    },
    /** 진행 화면의 버튼이 보내는 요청. */
    press: (pathname, body = {}) => call(rig.consoleBase, 'POST', pathname, { body }),
    /** 받는 쪽 프로그램이 지금 실제로 갖고 있는 것. */
    async held() {
      const res = await call(receiverBase, 'GET', '/api/received');
      assert.equal(res.status, 200);
      return res.json;
    },
    /** 받는 쪽 프로그램을 끈다(발표 도중에 꺼진 상황). */
    async stopReceiver() {
      if (receiver) await receiver.close();
      receiver = null;
    },
    async close() {
      await demo.close();
      if (receiver) await receiver.close();
      receiver = null;
    },
  };
  t.after(() => rig.close());
  return rig;
}

/**
 * 앱에 보내는 요청을 하나하나 적어 두는 장부.
 * 진행 화면의 접속 기록이 "실제로 보낸 요청과 정확히 같은지"를 비교하는 데 쓴다.
 */
export function createLedger(rig) {
  /** @type {Array<{appNo: number, request: string, status: number, loginLabel: string, fromNeighborScreen: boolean, clientAddress: string}>} */
  const sent = [];
  return {
    sent,
    /**
     * @param {1|2} appNo
     * @param {string} method
     * @param {string} pathname
     * @param {{who?: {loginId: string, cookie: string}|null, neighbor?: boolean, body?: any, via?: string, loginAs?: string}} [options]
     *   who: 누구의 로그인 상태로 보내는가. via: 127.0.0.1 대신 쓸 주소(이 PC의 내부 주소).
     */
    async send(appNo, method, pathname, { who = null, neighbor = false, body, via } = {}) {
      const port = new URL(rig.bases[appNo]).port;
      const base = via ? `http://${via}:${port}` : rig.bases[appNo];
      const res = await call(base, method, pathname, { cookie: who ? who.cookie : undefined, body, headers: neighbor ? NEIGHBOR : undefined });
      let loginLabel = who ? who.loginId : NOT_LOGGED_IN;
      // 로그인 성공 줄에는 방금 로그인한 사람이 적힌다.
      if (pathname === '/api/login' && res.status === 200) loginLabel = res.json.loginId;
      sent.push({
        appNo,
        request: `${method} ${pathname}`,
        status: res.status,
        loginLabel,
        fromNeighborScreen: neighbor,
        clientAddress: via || '127.0.0.1',
      });
      return res;
    },
    /** 로그인하고 그 사람({loginId, cookie})을 돌려준다. */
    async login(appNo, loginId, { neighbor = false, via } = {}) {
      const password = loginId === 'teacher' ? 'teacher1234' : 'demo1234';
      const res = await this.send(appNo, 'POST', '/api/login', { neighbor, via, body: { loginId, password } });
      assert.equal(res.status, 200, `로그인 실패: ${loginId}`);
      assert.ok(res.cookie, '로그인 쿠키가 와야 한다');
      return { loginId, cookie: res.cookie, reply: res.json };
    },
  };
}

/** 접속 기록 화면 줄에서 장부와 비교할 항목만 뽑는다. */
export function logRows(state) {
  return state.accessLog.entries.map((entry) => ({
    appNo: entry.appNo,
    request: entry.request,
    status: entry.status,
    loginLabel: entry.loginLabel,
    fromNeighborScreen: entry.fromNeighborScreen,
    clientAddress: entry.clientAddress.replace(/^::ffff:/, ''),
  }));
}

// --------------------------------------------------------------------------- 프로그램을 실제로 실행하기

/** `node <file>`을 실제로 실행한다. 브라우저는 열지 않는다(DEMO_NO_BROWSER=1). */
export function runProgram(file, env) {
  const child = spawn(process.execPath, [path.join(ROOT, file)], {
    cwd: ROOT,
    env: { ...process.env, DEMO_NO_BROWSER: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output.stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, output, exited, text: () => `${output.stdout}\n${output.stderr}` };
}

/** 끝나기를 기다린다. 시간 안에 끝나지 않으면 강제로 끝내고 실패로 알린다. */
export async function waitExit(proc, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  const result = await Promise.race([proc.exited, timeout]);
  clearTimeout(timer);
  if (result === null) {
    proc.child.kill('SIGKILL');
    await proc.exited;
    assert.fail(`${label}: ${ms}ms 안에 끝나지 않았습니다.\n${proc.text()}`);
  }
  return result;
}

/** 검사가 어떻게 끝나든 실행한 프로그램이 남지 않게 한다. */
export function killLater(t, proc) {
  t.after(async () => {
    if (proc.child.exitCode === null && proc.child.signalCode === null) {
      proc.child.kill('SIGKILL');
      await proc.exited;
    }
  });
}
