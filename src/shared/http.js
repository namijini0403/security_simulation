// 작은 서버 도구 모음: 본문 읽기, 응답 보내기, 화면 파일, 쿠키, 브라우저 열기, 시작 실패 안내.
// Node.js에 들어 있는 것만 쓴다. 이 파일을 불러오는 것만으로는 아무 일도 일어나지 않는다
// (프로그램을 끝내는 동작은 부르는 쪽이 함수를 직접 불렀을 때만 실행된다).

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

// --------------------------------------------------------------------------- 본문 읽기

/** readJsonBody의 기본 크기 제한(바이트). */
export const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;

// 제한을 넘긴 뒤에도 이만큼까지는 조용히 흘려 버린다(그래야 거절 응답이 상대에게 닿는다).
// 그보다 더 보내면 연결을 끊는다.
const DRAIN_ALLOWANCE_BYTES = 1024 * 1024;

/**
 * readJsonBody가 실패할 때 던지는 오류.
 *   code 'BODY_TOO_LARGE'    (status 413) 크기 제한을 넘음
 *   code 'BODY_INVALID_JSON' (status 400) JSON으로 읽을 수 없음
 *   code 'BODY_ABORTED'      (status 400) 받는 도중 끊김
 * message는 화면에 그대로 보여줄 수 있는 한국어 문장이다.
 * status는 권장값일 뿐이다. 부르는 쪽이 code를 보고 다른 번호로 바꿔도 된다
 * (예: 받는 쪽 프로그램은 BODY_TOO_LARGE도 400으로 응답한다).
 */
export class BodyError extends Error {
  /**
   * @param {'BODY_TOO_LARGE'|'BODY_INVALID_JSON'|'BODY_ABORTED'} code
   * @param {number} status
   * @param {string} message
   */
  constructor(code, status, message) {
    super(message);
    this.name = 'BodyError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 요청 본문을 JSON으로 읽는다. 본문이 비어 있으면 `{}`를 돌려준다.
 * 실패하면 BodyError로 거절한다(위 설명 참고). 크기는 글자 수가 아니라 바이트로 센다.
 * @param {import('node:http').IncomingMessage} req
 * @param {{limitBytes?: number}} [options] 기본 64KB. 제한과 같은 크기까지는 받는다.
 * @returns {Promise<any>}
 */
export function readJsonBody(req, { limitBytes = DEFAULT_BODY_LIMIT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new BodyError(
      'BODY_TOO_LARGE',
      413,
      `보낸 내용이 너무 큽니다. (허용 크기: ${Math.floor(limitBytes / 1024)}KB)`,
    );
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (settled) {
        if (total > limitBytes + DRAIN_ALLOWANCE_BYTES) req.destroy();
        return;
      }
      if (total > limitBytes) {
        fail(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (total === 0) {
        resolve({});
        return;
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(text));
      } catch {
        reject(new BodyError('BODY_INVALID_JSON', 400, '보낸 내용의 형식이 올바르지 않습니다.'));
      }
    });
    const aborted = () => fail(new BodyError('BODY_ABORTED', 400, '내용을 받는 도중에 연결이 끊겼습니다.'));
    req.on('aborted', aborted);
    req.on('error', aborted);

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) fail(tooLarge());
  });
}

// --------------------------------------------------------------------------- 응답 보내기

/**
 * JSON 응답을 보낸다 (UTF-8, 저장하지 않음 표시 포함).
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} value
 * @param {Record<string, string | string[]>} [headers] 덧붙일 머리글
 */
export function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value === undefined ? null : value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/**
 * 오류 응답 `{ "error": "<한국어 설명>" }`을 보낸다 (명세 5.2).
 * @param {import('node:http').ServerResponse} res
 * @param {number} status 예: 400, 401, 403, 404, 502
 * @param {string} message 화면에 보여줄 한국어 설명
 */
export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// --------------------------------------------------------------------------- 화면 파일

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

/** 요청 경로를 폴더 안의 파일 경로 마디들로 바꾼다. 받아들일 수 없으면 null. */
function safeSegments(rawPath, indexFile) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) return null;
  let pathname = rawPath.split(/[?#]/, 1)[0];
  try {
    pathname = decodeURIComponent(pathname); // 한 번만 푼다.
  } catch {
    return null;
  }
  // 폴더 밖으로 나가거나 운영체제가 다르게 해석할 수 있는 글자는 받지 않는다.
  if (/[\0-\x1f\\:*?"<>|]/.test(pathname)) return null;
  const segments = pathname.split('/').slice(1);
  if (segments[segments.length - 1] === '') segments[segments.length - 1] = indexFile;
  for (const segment of segments) {
    if (segment === '' || segment.startsWith('.') || segment.endsWith('.') || segment.endsWith(' ')) return null;
  }
  return segments;
}

/**
 * 정해진 폴더 안의 화면 파일을 보낸다 (GET·HEAD만). 폴더 밖의 파일은 어떤 경로로도 나가지 않는다.
 * 보냈으면 true, 보낼 파일이 없거나 받아들일 수 없는 경로면 false를 돌려준다.
 * false일 때는 아무것도 보내지 않았으므로 부르는 쪽이 404 등을 보낸다.
 *
 *   if (!(await serveStatic(req, res, publicDir))) sendError(res, 404, '찾을 수 없습니다.');
 *   await serveStatic(req, res, publicDir, { urlPath: '/neighbor.html' }); // 주소 /neighbor 에 연결할 때
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rootDir 화면 파일 폴더
 * @param {{urlPath?: string, index?: string}} [options]
 *   urlPath: req.url 대신 쓸 경로('/'로 시작). index: '/'로 끝나는 경로에 쓸 파일 이름(기본 index.html)
 * @returns {Promise<boolean>}
 */
export async function serveStatic(req, res, rootDir, { urlPath, index = 'index.html' } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const segments = safeSegments(urlPath === undefined ? req.url : urlPath, index);
  if (segments === null) return false;

  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...segments);
  if (!target.startsWith(root + path.sep)) return false;

  let body;
  try {
    // 바로가기(링크)를 따라간 실제 위치도 폴더 안이어야 한다.
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    if (!realTarget.startsWith(realRoot + path.sep)) return false;
    const stat = await fs.stat(realTarget);
    if (!stat.isFile()) return false;
    body = await fs.readFile(realTarget);
  } catch {
    return false;
  }

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

// --------------------------------------------------------------------------- 쿠키

const COOKIE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * 요청의 쿠키를 모두 읽는다. 같은 이름이 여러 번 오면 첫 번째 값을 쓴다.
 * @param {{headers: {cookie?: string}}} req
 * @returns {Record<string, string>} (물려받은 속성이 없는 객체)
 */
export function parseCookies(req) {
  const cookies = Object.create(null);
  const header = req && req.headers ? req.headers.cookie : undefined;
  if (typeof header !== 'string') return cookies;
  for (const piece of header.split(';')) {
    const at = piece.indexOf('=');
    if (at < 1) continue;
    const name = piece.slice(0, at).trim();
    if (name === '' || name in cookies) continue;
    let value = piece.slice(at + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // 풀 수 없는 값은 그대로 둔다.
    }
    cookies[name] = value;
  }
  return cookies;
}

/**
 * 쿠키 하나를 읽는다. 없으면 undefined.
 * @param {{headers: {cookie?: string}}} req
 * @param {string} name 앱마다 다른 이름을 써야 한다(같은 PC의 두 앱은 쿠키를 함께 받는다)
 * @returns {string | undefined}
 */
export function readCookie(req, name) {
  return parseCookies(req)[name];
}

function appendSetCookie(res, line) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader('Set-Cookie', [...list, line]);
}

/**
 * 쿠키를 쓴다: `Path=/; HttpOnly; SameSite=Lax`가 항상 붙는다. 응답을 보내기 전에 부른다.
 * @param {import('node:http').ServerResponse} res
 * @param {string} name 영문·숫자·`_`·`-`만 (앱마다 다른 이름)
 * @param {string} value
 * @param {{maxAgeSeconds?: number}} [options] 생략하면 브라우저를 닫을 때까지
 */
export function setCookie(res, name, value, { maxAgeSeconds } = {}) {
  if (typeof name !== 'string' || !COOKIE_NAME.test(name)) {
    throw new TypeError(`쿠키 이름이 올바르지 않습니다: ${String(name)}`);
  }
  let line = `${name}=${encodeURIComponent(String(value))}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAgeSeconds !== undefined) line += `; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
  appendSetCookie(res, line);
}

/**
 * 쿠키를 지운다(로그아웃).
 * @param {import('node:http').ServerResponse} res
 * @param {string} name
 */
export function clearCookie(res, name) {
  setCookie(res, name, '', { maxAgeSeconds: 0 });
}

// --------------------------------------------------------------------------- 브라우저 열기

const BROWSER_URL = /^http:\/\/[A-Za-z0-9.\-[\]:]+(\/[A-Za-z0-9\-._~/?&=%#]*)?$/;

/**
 * 기본 브라우저로 주소를 연다 (Windows·macOS·Linux).
 * 환경 변수 DEMO_NO_BROWSER=1이면 열지 않는다. 열지 못해도 프로그램은 계속 돈다
 * (그럴 때는 부르는 쪽이 주소를 화면에 적어 주면 된다).
 * @param {string} url 'http://127.0.0.1:4170/' 같은 주소. 다른 모양은 열지 않는다.
 * @param {{env?: Record<string, string | undefined>, platform?: string, spawn?: Function}} [options] 검사용
 * @returns {boolean} 여는 명령을 실행했으면 true
 */
export function openBrowser(url, { env = process.env, platform = process.platform, spawn = nodeSpawn } = {}) {
  if (env.DEMO_NO_BROWSER === '1') return false;
  if (typeof url !== 'string' || !BROWSER_URL.test(url)) return false;
  let command;
  let args;
  if (platform === 'win32') {
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- 서버 열기·닫기

/**
 * 서버를 연다. 기본은 같은 PC 전용(127.0.0.1)이다.
 * 실패하면 원래 오류에 `port`, `host`를 붙여 거절한다(`code`는 'EADDRINUSE' 등).
 * 여러 서버를 차례로 열다가 하나라도 실패하면, 부르는 쪽은 이미 연 것을 모두 닫고
 * exitOnStartupError(error)로 알린 뒤 끝내면 된다("일부만 뜬 채로 계속 돌지 않는다").
 * @param {import('node:net').Server} server
 * @param {number} port 0이면 빈 포트 자동 선택
 * @param {string} [host]
 * @returns {Promise<number>} 실제로 열린 포트
 */
export function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      error.port = port;
      error.host = host;
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen({ port, host, exclusive: true });
    } catch (error) {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      error.port = port;
      error.host = host;
      reject(error);
    }
  });
}

/**
 * 서버를 닫는다. 살아 있는 연결도 끊는다. 열려 있지 않거나 여러 번 불러도 괜찮다.
 * @param {import('node:net').Server} server
 * @returns {Promise<void>}
 */
export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

// --------------------------------------------------------------------------- 시작 실패 안내

/**
 * "포트가 이미 쓰이고 있음" 안내문 (명세 12).
 * @param {number} port
 * @returns {string}
 */
export function portInUseMessage(port) {
  return `${port}번 포트를 이미 다른 프로그램이 쓰고 있어서 시작할 수 없습니다.\n`
    + '이 프로그램을 먼저 실행해 둔 창이 있으면 그 창을 닫은 뒤 다시 실행해 주세요.';
}

/**
 * 시작 실패 오류를 화면에 보여줄 한국어 안내문으로 바꾼다.
 * @param {any} error listen()이 거절한 오류
 * @returns {string}
 */
export function describeStartupError(error) {
  const code = error && error.code;
  const port = error && error.port;
  if (code === 'EADDRINUSE') return portInUseMessage(port);
  if (code === 'EACCES') {
    return `${port}번 포트를 열 권한이 없어서 시작할 수 없습니다.\n다른 포트 번호로 바꿔 실행해 주세요.`;
  }
  const detail = error && error.message ? ` (원인: ${error.message})` : '';
  return `프로그램을 시작하지 못했습니다.${detail}\n창을 닫고 다시 실행해 주세요.`;
}

/**
 * 시작 실패를 한국어로 알리고 프로그램을 끝낸다(종료 번호 1).
 * 부르기 전에 이미 연 서버를 모두 닫아 둔다.
 * @param {any} error
 * @param {{log?: (line: string) => void, exit?: (code: number) => void}} [options] 검사용
 */
export function exitOnStartupError(error, { log = console.error, exit = process.exit } = {}) {
  log(`\n[시작하지 못했습니다]\n${describeStartupError(error)}\n`);
  exit(1);
}

/** 필요한 Node.js 최소 버전. */
export const REQUIRED_NODE_MAJOR = 22;

/**
 * Node.js 버전 확인 (명세 12).
 * @param {string} [version] 기본: 지금 실행 중인 버전
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function checkNodeVersion(version = process.versions.node) {
  const match = /^v?(\d+)\./.exec(String(version));
  const major = match ? Number(match[1]) : NaN;
  if (major >= REQUIRED_NODE_MAJOR) return { ok: true };
  return {
    ok: false,
    message: `이 프로그램은 Node.js ${REQUIRED_NODE_MAJOR} 이상에서 실행됩니다. (지금 버전: ${String(version) || '알 수 없음'})\n`
      + `Node.js ${REQUIRED_NODE_MAJOR} 이상을 설치한 뒤 다시 실행해 주세요.`,
  };
}

/**
 * Node.js 버전이 낮으면 한국어로 알리고 프로그램을 끝낸다(종료 번호 1). 괜찮으면 true.
 * 프로그램 시작 부분에서 부른다.
 * @param {{version?: string, log?: (line: string) => void, exit?: (code: number) => void}} [options] 검사용
 * @returns {boolean}
 */
export function ensureNodeVersion({ version = process.versions.node, log = console.error, exit = process.exit } = {}) {
  const result = checkNodeVersion(version);
  if (result.ok) return true;
  log(`\n[시작하지 못했습니다]\n${result.message}\n`);
  exit(1);
  return false;
}
