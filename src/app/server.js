// 성적 관리 앱 서버 (명세 4.3, 5.2, 5.3, 5.4, 8.2)
//
// 1번 앱과 2번 앱은 이 코드 하나로 만든다. 두 앱이 다른 점은 설정 하나뿐이다:
// 서버가 "이 사람이 이 요청을 해도 되는가"를 확인하는지(checkPermission).
// 그 밖의 것(경로, 응답 모양, 문구, 다른 곳으로 보내기)은 완전히 같다.
//
// 이 파일은 포트를 열지 않는다. 부르는 쪽이 handler를 접속 스위치(access-switch.js)에 등록한다.
// 브라우저로 나가는 것(경로, 머리글, 쿠키 이름, 응답, 오류 문구)에는 어느 앱인지 알 수 있는 것을 넣지 않는다.
// '권한을 확인했는가'는 서버 안의 접속 기록에만 남는다.

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { receiverBaseUrl } from '../shared/address.js';
import { RATING_VALUES, SUBJECTS, createStudents, findAccount } from '../shared/data.js';
import {
  BodyError,
  clearCookie,
  readCookie,
  readJsonBody,
  sendError,
  sendJson,
  serveStatic,
  setCookie,
} from '../shared/http.js';

/** 화면 파일 폴더의 기본값: src/app/public/ */
export const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
/** 받는 쪽으로 보낼 때 기다리는 시간의 기본값(밀리초). */
export const DEFAULT_FORWARD_TIMEOUT_MS = 3000;
/** 접속 기록·전송 기록에 남겨 두는 줄 수의 기본값(가장 최근 것부터). */
export const DEFAULT_MAX_LOG_ENTRIES = 2000;
/** 옆 사람 화면이 자기 요청에 붙이는 표시. 화면 표시용일 뿐 권한에는 아무 영향이 없다. */
export const NEIGHBOR_HEADER = 'x-demo-screen';
export const NEIGHBOR_HEADER_VALUE = 'neighbor';
/** 메인 화면 파일이 담임 화면부터 그리는 주소. 어떤 화면을 그릴지만 정한다. 권한에는 아무 영향이 없다. */
export const TEACHER_PAGE_PATH = '/teacher';

const BODY_LIMIT_BYTES = 4 * 1024;
const RECEIVER_REPLY_LIMIT = 64 * 1024;
const PATH_LOG_LIMIT = 200;
const COOKIE_NAME = /^[A-Za-z0-9_-]+$/;

const TEXT = Object.freeze({
  needLogin: '로그인이 필요합니다.',
  loginFailed: '로그인 ID 또는 비밀번호가 맞지 않습니다.',
  notAllowed: '이 요청을 할 수 있는 권한이 없습니다.',
  noStudent: '해당 학생 기록을 찾을 수 없습니다.',
  notFound: '요청한 주소를 찾을 수 없습니다.',
  badBody: '보낸 내용의 형식이 올바르지 않습니다.',
  badRatings: '평가 내용이 올바르지 않습니다. 과목은 국어·수학·사회·과학·영어, 값은 잘함·보통·노력요함 중에서 골라 주세요.',
  noRatings: '고칠 과목을 하나 이상 골라 주세요.',
  draftFailed: 'AI 서비스에 연결하지 못해 초안을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  failed: '요청을 처리하는 중에 문제가 생겼습니다.',
  // 아래는 진행 화면의 전송 기록에만 쓰인다(앱 화면으로는 나가지 않는다).
  unreachable: '받는 쪽에 닿지 못했습니다.',
  timedOut: '받는 쪽이 제때 대답하지 않았습니다.',
  refused: (status) => `받는 쪽이 받아들이지 않았습니다. (결과 번호 ${status})`,
  noDraft: '받는 쪽이 초안을 돌려주지 않았습니다.',
  badDestination: (reason) => `받는 쪽 주소가 올바르지 않아 보내지 않았습니다. ${reason}`,
});

const deny = (status, error) => Object.freeze({ status, body: Object.freeze({ error }) });
const NEED_LOGIN = deny(401, TEXT.needLogin);
const NOT_ALLOWED = deny(403, TEXT.notAllowed);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** 학생 기록의 사본(항목 순서는 명세 4.1 그대로). */
function copyStudent(student) {
  return {
    id: student.id,
    name: student.name,
    className: student.className,
    ratings: { ...student.ratings },
    comment: student.comment,
    guardianName: student.guardianName,
    guardianPhone: student.guardianPhone,
  };
}

/** 요청 주소에서 경로만 떼어 낸다(물음표 뒤는 보지 않는다). */
function pathnameOf(req) {
  const url = typeof req.url === 'string' ? req.url : '/';
  return url.split(/[?#]/, 1)[0];
}

/**
 * 방식과 경로로 어떤 요청인지 알아낸다. 아는 요청이 아니면 null.
 * @returns {{name: string, id?: string} | null}
 */
function matchRoute(method, pathname) {
  const fixed = {
    '/api/login': ['POST', 'login'],
    '/api/logout': ['POST', 'logout'],
    '/api/me': ['GET', 'me'],
    '/api/app': ['GET', 'app'],
    '/api/roster': ['GET', 'roster'],
    '/api/students': ['GET', 'list'],
  };
  if (Object.hasOwn(fixed, pathname)) {
    const [wanted, name] = fixed[pathname];
    return method === wanted ? { name } : null;
  }
  const match = /^\/api\/students\/([^/]+)(\/ratings|\/ai-draft)?$/.exec(pathname);
  if (!match) return null;
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    id = ''; // 풀 수 없는 번호는 없는 학생으로 다룬다.
  }
  if (match[2] === undefined) {
    if (method === 'GET') return { name: 'getOne', id };
    if (method === 'DELETE') return { name: 'remove', id };
    return null;
  }
  if (match[2] === '/ratings') return method === 'PUT' ? { name: 'putRatings', id } : null;
  return method === 'POST' ? { name: 'aiDraft', id } : null;
}

/**
 * 받는 쪽 주소 확인. 주입된 함수가 돌려준 값이 'http://<주소>:<포트>' 글자이든 {host, port}이든
 * 주소와 포트만 꺼내서 receiverBaseUrl()로 다시 만든다(같은 PC·사설 IPv4가 아니면 예외).
 */
function checkedReceiverBase(value) {
  let host;
  let port;
  if (typeof value === 'string') {
    const match = /^http:\/\/([0-9.]+):([0-9]{1,5})$/.exec(value);
    if (!match) throw new Error('http://<숫자 주소>:<포트> 모양이 아닙니다.');
    host = match[1];
    port = Number(match[2]);
  } else if (isPlainObject(value)) {
    host = value.host;
    port = value.port;
  } else {
    throw new Error('받는 쪽 주소가 정해지지 않았습니다.');
  }
  return receiverBaseUrl(host, port);
}

/**
 * @typedef {object} RequestInfo 접속 스위치가 처리기에 넘겨주는 값 (access-switch.js)
 * @property {boolean} local 같은 PC 쪽 문으로 들어온 요청인가
 * @property {string} clientAddress 요청을 보낸 주소
 * @property {boolean} samePc 보낸 주소가 이 PC 자신인가
 */

/**
 * @typedef {object} StudentRecord 명세 4.1의 기록
 * @property {string} id
 * @property {string} name
 * @property {string} className
 * @property {Record<string, string>} ratings
 * @property {string} comment
 * @property {string} guardianName
 * @property {string} guardianPhone
 */

/**
 * @typedef {object} AccessLogEntry 접속 기록 한 줄 (명세 8.2). 고칠 수 없게 고정되어 있다.
 * @property {number} seq 1부터 커지는 번호(초기화해도 다시 1로 돌아가지 않는다)
 * @property {number} at 시각(밀리초)
 * @property {string} time 시각(ISO 형식)
 * @property {string} app 앱 이름('1번 앱' / '2번 앱')
 * @property {string} clientAddress 보낸 주소
 * @property {boolean} samePc 같은 PC인가(false면 다른 기기)
 * @property {boolean} local 같은 PC 쪽 문(127.0.0.1)으로 들어왔는가
 * @property {string | null} loginId 로그인한 사람(없으면 null). 로그인 성공 줄에는 방금 로그인한 사람,
 *   로그아웃 줄에는 로그아웃한 사람이 적힌다.
 * @property {string} method
 * @property {string} path 경로(물음표 뒤는 뺀다)
 * @property {number} status 결과 번호
 * @property {boolean} permissionChecked 서버가 "이 사람이 이 요청을 해도 되는가"를 확인했는가(명세 5.3)
 * @property {boolean} neighbor 옆 사람 화면 표시가 붙어 있었는가
 * @property {StudentRecord[] | null} students GET /api/students/:id, GET /api/students가 200으로 내보낸 기록
 * @property {Array<{id: string, name: string}> | null} roster GET /api/roster가 200으로 내보낸 명단
 */

/**
 * @typedef {object} TransferLogEntry 받는 쪽으로 보낸 기록 한 줄 (명세 5.4). 고정되어 있다.
 * @property {number} seq
 * @property {number} at 결과가 나온 시각(밀리초)
 * @property {string} time 같은 시각(ISO 형식)
 * @property {string} app 앱 이름
 * @property {'sheet' | 'ai'} kind 'sheet' = 온라인 표(/sheet/rows), 'ai' = AI 서비스(/ai/draft)
 * @property {string} studentId
 * @property {string | null} destination 보낸 주소 전체(주소가 올바르지 않아 보내지 않았으면 null)
 * @property {boolean} ok 받는 쪽이 받았는가
 * @property {number | null} status 받는 쪽이 돌려준 결과 번호(닿지 못했으면 null)
 * @property {string | null} error 실패 이유(한국어). 성공이면 null
 */

/**
 * @typedef {object} NeighborSummary '옆 기기가 가져간 것' (명세 8.2의 세는 규칙)
 * @property {string} app 앱 이름
 * @property {number} studentCount 가져간 서로 다른 학생 수
 * @property {StudentRecord[]} students 가져간 기록(처음 가져간 순서, 내용은 가장 최근에 가져간 것)
 * @property {number} rosterCount "명단 열람: N명"의 N(명단으로 나간 서로 다른 학생 수). studentCount에 넣지 않는다
 * @property {Array<{id: string, name: string}>} roster 명단으로 나간 항목(처음 나간 순서)
 * @property {number} rosterViews 명단을 받아 간 횟수
 */

/**
 * 성적 관리 앱 하나를 만든다. 앱마다 학생 사본과 로그인 상태를 따로 가진다.
 *
 *   const app1 = createGradeApp({ label: '1번 앱', checkPermission: false, cookieName: 'gsid_a', getReceiverBase });
 *   const app2 = createGradeApp({ label: '2번 앱', checkPermission: true, cookieName: 'gsid_b', getReceiverBase });
 *   await sw.listen({ name: 'app1', port: 4173, handler: app1.handler });
 *
 * @param {object} options
 * @param {string} options.label 화면에 나오는 중립적인 이름('1번 앱' / '2번 앱')
 * @param {boolean} options.checkPermission 서버가 "이 사람이 이 요청을 해도 되는가"를 확인하는가(두 앱의 유일한 차이)
 * @param {string} options.cookieName 로그인 상태를 담는 쿠키 이름. 두 앱이 서로 달라야 한다(영문·숫자·`_`·`-`)
 * @param {() => (string | {host: string, port: number})} options.getReceiverBase 지금의 받는 쪽 주소.
 *   'http://192.168.0.10:4180' 모양의 글자 또는 {host, port}. 보낼 때마다 부른다. 진행 화면만 정한다.
 * @param {string} [options.publicDir] 화면 파일 폴더(기본 src/app/public/)
 * @param {() => number} [options.now] 시계(기본 Date.now)
 * @param {number} [options.forwardTimeoutMs] 받는 쪽을 기다리는 시간(기본 3000)
 * @param {number} [options.maxLogEntries] 기록에 남겨 두는 줄 수(기본 2000)
 */
export function createGradeApp(options) {
  const {
    label,
    checkPermission,
    cookieName,
    getReceiverBase,
    publicDir = DEFAULT_PUBLIC_DIR,
    now = Date.now,
    forwardTimeoutMs = DEFAULT_FORWARD_TIMEOUT_MS,
    maxLogEntries = DEFAULT_MAX_LOG_ENTRIES,
  } = options || {};

  if (typeof label !== 'string' || label === '') throw new TypeError('앱 이름(label)이 필요합니다.');
  if (typeof checkPermission !== 'boolean') throw new TypeError('checkPermission은 true 또는 false여야 합니다.');
  if (typeof cookieName !== 'string' || !COOKIE_NAME.test(cookieName)) throw new TypeError('쿠키 이름(cookieName)이 올바르지 않습니다.');
  if (typeof getReceiverBase !== 'function') throw new TypeError('받는 쪽 주소를 돌려주는 함수(getReceiverBase)가 필요합니다.');
  if (typeof publicDir !== 'string' || publicDir === '') throw new TypeError('화면 파일 폴더(publicDir)가 올바르지 않습니다.');
  if (typeof now !== 'function') throw new TypeError('시계(now)는 함수여야 합니다.');
  if (!(forwardTimeoutMs > 0)) throw new TypeError('forwardTimeoutMs는 0보다 커야 합니다.');
  if (!Number.isInteger(maxLogEntries) || maxLogEntries < 1) throw new TypeError('maxLogEntries는 1 이상의 정수여야 합니다.');

  // ------------------------------------------------------------------ 상태 (메모리에만 둔다)

  /** @type {Map<string, StudentRecord>} 학생 번호 → 기록 */
  let students = new Map();
  /** @type {Map<string, {loginId: string, role: 'parent'|'teacher', studentId: string|null}>} 로그인 상태 */
  let sessions = new Map();
  /** @type {AccessLogEntry[]} */
  let accessLog = [];
  /** @type {TransferLogEntry[]} */
  let transferLog = [];
  /** @type {Map<string, StudentRecord>} 옆 사람 화면이 가져간 학생(번호 → 가장 최근 내용) */
  let taken = new Map();
  /** @type {Map<string, {id: string, name: string}>} 옆 사람 화면이 명단으로 본 학생 */
  let rosterSeen = new Map();
  let rosterViews = 0;
  let accessSeq = 0;
  let transferSeq = 0;
  /** 초기화할 때마다 커진다. 초기화 전에 시작한 전송의 결과는 기록에 넣지 않는다. */
  let epoch = 0;
  /** 아직 끝나지 않은 전송. */
  const pending = new Set();
  const listeners = new Set();

  function loadStudents() {
    students = new Map(createStudents().map((student) => [student.id, student]));
  }
  loadStudents();

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 알림을 받는 쪽의 오류가 앱을 멈추게 하지 않는다.
      }
    }
  }

  function timeText(at) {
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? String(at) : date.toISOString();
  }

  // ------------------------------------------------------------------ 로그인 상태

  /** 이 앱의 쿠키에 담긴 값으로 서버가 기억한 로그인 상태를 찾는다. 역할·담당 학생은 여기서만 나온다. */
  function sessionOf(req) {
    const sid = readCookie(req, cookieName);
    if (typeof sid !== 'string' || sid === '') return null;
    const session = sessions.get(sid);
    return session ? { sid, ...session } : null;
  }

  // ------------------------------------------------------------------ 누가 무엇을 할 수 있는가 (명세 5.3)

  /**
   * 거절이면 {status, body}, 해도 되면 null.
   * 역할과 담당 학생은 서버가 기억한 로그인 상태(session)에서만 가져온다.
   * 주소·본문·머리글·다른 쿠키의 값은 여기까지 오지 않는다.
   */
  function decide(routeName, studentId, session) {
    if (routeName === 'me') return session ? null : NEED_LOGIN;

    if (!checkPermission) {
      // 로그인했는지만 본다(이것은 권한 확인이 아니다).
      if (routeName === 'getOne' && !session) return NEED_LOGIN;
      return null;
    }

    switch (routeName) {
      case 'page':
      case 'app':
      case 'unknown':
        return null; // 누구에게나 열려 있다.
      case 'getOne':
        if (!session) return NEED_LOGIN;
        if (session.role === 'teacher') return null;
        if (session.role === 'parent' && session.studentId === studentId) return null;
        return NOT_ALLOWED;
      case 'roster':
      case 'list':
      case 'putRatings':
      case 'aiDraft':
      case 'remove':
        if (!session) return NEED_LOGIN;
        return session.role === 'teacher' ? null : NOT_ALLOWED;
      default:
        return NOT_ALLOWED;
    }
  }

  // ------------------------------------------------------------------ 다른 곳으로 보내기 (명세 5.4)

  /**
   * 받는 쪽으로 보낸다. 목적지는 주입된 getReceiverBase()가 정한 주소 하나뿐이다.
   * 결과는 전송 기록에 남는다. 거절하지 않는 약속을 돌려준다.
   * @returns {Promise<{ok: boolean, status: number|null, error: string|null, reply: any}>}
   */
  function forward(kind, pathname, payload, studentId) {
    const startedEpoch = epoch;
    const job = (async () => {
      let destination = null;
      let outcome;
      try {
        try {
          destination = checkedReceiverBase(getReceiverBase()) + pathname;
        } catch (error) {
          throw Object.assign(new Error(TEXT.badDestination(error && error.message ? error.message : '')), { known: true });
        }
        const response = await fetch(destination, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload),
          redirect: 'error', // 다른 곳으로 가라는 응답은 따르지 않는다.
          signal: AbortSignal.timeout(forwardTimeoutMs),
        });
        const text = await response.text();
        let reply = null;
        if (text.length <= RECEIVER_REPLY_LIMIT) {
          try {
            reply = JSON.parse(text);
          } catch {
            reply = null;
          }
        }
        if (!response.ok) {
          outcome = { ok: false, status: response.status, error: TEXT.refused(response.status), reply: null };
        } else if (kind === 'ai' && !(isPlainObject(reply) && typeof reply.draft === 'string')) {
          outcome = { ok: false, status: response.status, error: TEXT.noDraft, reply: null };
        } else {
          outcome = { ok: true, status: response.status, error: null, reply };
        }
      } catch (error) {
        let message = TEXT.unreachable;
        if (error && error.known) message = error.message;
        else if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) message = TEXT.timedOut;
        outcome = { ok: false, status: null, error: message, reply: null };
      }

      if (startedEpoch === epoch) {
        const at = now();
        transferSeq += 1;
        const entry = deepFreeze({
          seq: transferSeq,
          at,
          time: timeText(at),
          app: label,
          kind,
          studentId,
          destination,
          ok: outcome.ok,
          status: outcome.status,
          error: outcome.error,
        });
        transferLog.push(entry);
        if (transferLog.length > maxLogEntries) transferLog.splice(0, transferLog.length - maxLogEntries);
        emit({ type: 'transfer', entry });
      }
      return outcome;
    })();
    pending.add(job);
    const done = () => pending.delete(job);
    job.then(done, done);
    return job;
  }

  // ------------------------------------------------------------------ 요청 하나하나

  /**
   * 본문의 평가 값을 확인한다. 올바르면 {ratings}, 아니면 {error}.
   * 본문의 다른 항목(역할, 학생 번호, 주소 따위)은 읽지 않는다.
   */
  function readRatings(body) {
    if (!isPlainObject(body) || !Object.hasOwn(body, 'ratings') || !isPlainObject(body.ratings)) {
      return { error: TEXT.badRatings };
    }
    const subjects = Object.keys(body.ratings);
    if (subjects.length === 0) return { error: TEXT.noRatings };
    const ratings = {};
    for (const subject of subjects) {
      const value = body.ratings[subject];
      if (!SUBJECTS.includes(subject) || typeof value !== 'string' || !RATING_VALUES.includes(value)) {
        return { error: TEXT.badRatings };
      }
      ratings[subject] = value;
    }
    return { ratings };
  }

  async function readBody(req) {
    try {
      return { body: await readJsonBody(req, { limitBytes: BODY_LIMIT_BYTES }) };
    } catch (error) {
      if (error instanceof BodyError) return { error: error.message };
      throw error;
    }
  }

  /**
   * API 요청을 처리해 보낼 것을 정한다(보내지는 않는다).
   * @returns {Promise<{status: number, body: any, loginId?: string|null, setSid?: string, clearSid?: boolean,
   *   students?: StudentRecord[], roster?: Array<{id: string, name: string}>}>}
   */
  async function runApi(req, route, session) {
    if (route.name === 'login') {
      const read = await readBody(req);
      if (read.error) return { status: 400, body: { error: read.error } };
      const body = isPlainObject(read.body) ? read.body : {};
      const account = findAccount(body.loginId, body.password);
      if (!account) return { status: 401, body: { error: TEXT.loginFailed }, loginId: null };
      if (session) sessions.delete(session.sid); // 같은 브라우저의 이전 로그인은 끝낸다.
      const sid = crypto.randomBytes(32).toString('base64url');
      sessions.set(sid, { loginId: account.loginId, role: account.role, studentId: account.studentId });
      return {
        status: 200,
        body: { role: account.role, loginId: account.loginId, studentId: account.studentId },
        loginId: account.loginId,
        setSid: sid,
      };
    }

    if (route.name === 'logout') {
      if (session) sessions.delete(session.sid);
      return { status: 200, body: { ok: true }, clearSid: true };
    }

    // 여기부터는 "해도 되는가"를 먼저 본다. 401/403은 404·400보다 먼저다(명세 5.3).
    const denied = decide(route.name, route.id, session);
    if (denied) return denied;

    switch (route.name) {
      case 'me':
        return { status: 200, body: { role: session.role, loginId: session.loginId, studentId: session.studentId } };

      case 'app':
        return { status: 200, body: { label } };

      case 'roster': {
        const roster = [...students.values()].map(({ id, name }) => ({ id, name }));
        return { status: 200, body: roster, roster };
      }

      case 'list': {
        const records = [...students.values()].map(copyStudent);
        return { status: 200, body: records, students: records };
      }

      default:
        break;
    }

    // 학생 한 명을 가리키는 요청: 없는 번호(지워진 학생 포함)는 404.
    const student = students.get(route.id);
    if (!student) return { status: 404, body: { error: TEXT.noStudent } };

    switch (route.name) {
      case 'getOne': {
        const record = copyStudent(student);
        return { status: 200, body: record, students: [record] };
      }

      case 'putRatings': {
        const read = await readBody(req);
        if (read.error) return { status: 400, body: { error: read.error } };
        const checked = readRatings(read.body);
        if (checked.error) return { status: 400, body: { error: checked.error } };
        // 본문을 읽는 사이에 지워졌을 수 있다.
        const current = students.get(route.id);
        if (!current) return { status: 404, body: { error: TEXT.noStudent } };
        Object.assign(current.ratings, checked.ratings);
        const record = copyStudent(current);
        // 앱 서버가 전체 기록을 '온라인 표'로 보낸다. 응답은 기다리지 않는다(결과는 전송 기록에 남는다).
        forward('sheet', '/sheet/rows', copyStudent(current), current.id);
        return { status: 200, body: record };
      }

      case 'aiDraft': {
        const payload = { id: student.id, name: student.name, ratings: { ...student.ratings }, comment: student.comment };
        const outcome = await forward('ai', '/ai/draft', payload, student.id);
        if (!outcome.ok) return { status: 502, body: { error: TEXT.draftFailed } };
        return { status: 200, body: { draft: outcome.reply.draft } };
      }

      case 'remove':
        students.delete(route.id); // 받는 쪽으로는 아무것도 보내지 않는다.
        return { status: 200, body: { ok: true } };

      default:
        return { status: 404, body: { error: TEXT.notFound } };
    }
  }

  // ------------------------------------------------------------------ 접속 기록 (명세 8.2)

  function record(req, info, pathname, route, result) {
    const neighbor = String(req.headers[NEIGHBOR_HEADER] ?? '').trim().toLowerCase() === NEIGHBOR_HEADER_VALUE;
    const ok = result.status === 200;
    const sentStudents = ok && (route === 'getOne' || route === 'list') && Array.isArray(result.students)
      ? result.students.map(copyStudent)
      : null;
    const sentRoster = ok && route === 'roster' && Array.isArray(result.roster)
      ? result.roster.map(({ id, name }) => ({ id, name }))
      : null;

    const at = now();
    accessSeq += 1;
    const entry = deepFreeze({
      seq: accessSeq,
      at,
      time: timeText(at),
      app: label,
      clientAddress: String(info && info.clientAddress !== undefined ? info.clientAddress : ''),
      samePc: Boolean(info && info.samePc),
      local: Boolean(info && info.local),
      loginId: result.loginId === undefined ? null : result.loginId,
      method: String(req.method),
      path: pathname.length > PATH_LOG_LIMIT ? `${pathname.slice(0, PATH_LOG_LIMIT)}…` : pathname,
      status: result.status,
      // 1번 앱은 언제나 '확인 안 함'. 2번 앱은 로그인·로그아웃을 뺀 모든 요청이 '확인함'.
      permissionChecked: checkPermission && route !== 'login' && route !== 'logout',
      neighbor,
      students: sentStudents,
      roster: sentRoster,
    });
    accessLog.push(entry);
    if (accessLog.length > maxLogEntries) accessLog.splice(0, accessLog.length - maxLogEntries);

    // '옆 기기가 가져간 것'은 기록과 따로 모아 둔다(오래된 줄이 밀려나도 인원 수가 유지된다).
    if (neighbor && sentStudents) {
      for (const student of entry.students) taken.set(student.id, student);
    }
    if (neighbor && sentRoster) {
      rosterViews += 1;
      for (const item of entry.roster) {
        if (!rosterSeen.has(item.id)) rosterSeen.set(item.id, item);
      }
    }
    emit({ type: 'access', entry });
  }

  // ------------------------------------------------------------------ 처리기

  function sendResult(res, result) {
    if (result.setSid) setCookie(res, cookieName, result.setSid);
    if (result.clearSid) clearCookie(res, cookieName);
    sendJson(res, result.status, result.body);
  }

  /**
   * 요청 처리기. 접속 스위치에 등록한다: `sw.listen({ name, port, handler: app.handler })`.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {RequestInfo} info
   * @returns {Promise<void>}
   */
  async function handler(req, res, info) {
    const pathname = pathnameOf(req);
    const method = String(req.method);
    let routeName = 'unknown';
    let loginId = null;
    try {
      const session = sessionOf(req);
      loginId = session ? session.loginId : null;
      const isApi = pathname === '/api' || pathname.startsWith('/api/');
      const route = isApi ? matchRoute(method, pathname) : null;

      if (route) {
        routeName = route.name;
        const result = await runApi(req, route, session);
        const who = result.loginId === undefined ? loginId : result.loginId;
        record(req, info, pathname, routeName, { status: result.status, students: result.students, roster: result.roster, loginId: who });
        sendResult(res, result);
        return;
      }

      // 화면 파일. 누구에게나 열려 있다(2번 앱에서는 그 판단도 같은 곳에서 한다).
      if (!isApi && (method === 'GET' || method === 'HEAD')) {
        routeName = 'page';
        const denied = decide('page', undefined, session);
        if (!denied) {
          let urlPath;
          if (pathname === '/') urlPath = '/index.html';
          else if (pathname === '/neighbor') urlPath = '/neighbor.html';
          // 메인 화면 파일을 한 번 더 내주는 주소. 화면이 로그인 화면 대신 담임 화면을 그릴 뿐이고,
          // 자료를 내줄지는 그 화면이 보내는 요청마다 decide()가 정한다(이 낱말은 decide()에 닿지 않는다).
          else if (pathname === TEACHER_PAGE_PATH) urlPath = '/index.html';
          else urlPath = pathname;
          if (await serveStatic(req, res, publicDir, { urlPath })) {
            record(req, info, pathname, routeName, { status: 200, body: null, loginId });
            return;
          }
        }
      }

      const result = { status: 404, body: { error: TEXT.notFound }, loginId };
      record(req, info, pathname, routeName, result);
      sendResult(res, result);
    } catch {
      record(req, info, pathname, routeName, { status: 500, body: null, loginId });
      if (res.headersSent) res.destroy();
      else sendError(res, 500, TEXT.failed);
    }
  }

  // ------------------------------------------------------------------ 밖에서 쓰는 것

  return {
    /** 앱 이름('1번 앱' / '2번 앱'). */
    label,
    /** 화면 파일 폴더. */
    publicDir,
    handler,

    /**
     * 초기화: 학생 20명 원상 복구, 모든 로그인 상태 무효, 접속 기록·전송 기록·'가져간 것' 비우기.
     * 초기화 전에 시작해 아직 끝나지 않은 전송의 결과는 기록에 넣지 않는다.
     */
    reset() {
      epoch += 1;
      loadStudents();
      sessions = new Map();
      accessLog = [];
      transferLog = [];
      taken = new Map();
      rosterSeen = new Map();
      rosterViews = 0;
      emit({ type: 'reset' });
    },

    /**
     * 접속 기록(오래된 것부터). 가장 최근 maxLogEntries줄까지만 남아 있다.
     * @param {{sinceSeq?: number}} [query] sinceSeq보다 번호가 큰 줄만 받는다
     * @returns {AccessLogEntry[]} 새 배열(각 줄은 고정된 객체)
     */
    getAccessLog({ sinceSeq } = {}) {
      return typeof sinceSeq === 'number' ? accessLog.filter((entry) => entry.seq > sinceSeq) : [...accessLog];
    },

    /**
     * 받는 쪽으로 보낸 기록(결과가 나온 순서). 성공과 실패가 모두 들어 있다.
     * @param {{sinceSeq?: number}} [query]
     * @returns {TransferLogEntry[]}
     */
    getTransferLog({ sinceSeq } = {}) {
      return typeof sinceSeq === 'number' ? transferLog.filter((entry) => entry.seq > sinceSeq) : [...transferLog];
    },

    /**
     * '옆 기기가 가져간 것' (명세 8.2): 옆 사람 화면 표시가 붙은 요청 가운데
     * GET /api/students/:id · GET /api/students가 200으로 돌려준 서로 다른 학생. 명단은 따로 센다.
     * @returns {NeighborSummary}
     */
    getNeighborSummary() {
      return {
        app: label,
        studentCount: taken.size,
        students: [...taken.values()],
        rosterCount: rosterSeen.size,
        roster: [...rosterSeen.values()],
        rosterViews,
      };
    },

    /**
     * 진행 중인 전송이 모두 끝나면(성공이든 실패든) 이행된다. 거절하지 않는다.
     * @returns {Promise<void>}
     */
    async whenIdle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },

    /**
     * 새 일이 생길 때마다 불릴 함수를 등록한다:
     *   {type: 'access', entry: AccessLogEntry} | {type: 'transfer', entry: TransferLogEntry} | {type: 'reset'}
     * @param {(event: {type: 'access'|'transfer'|'reset', entry?: object}) => void} listener
     * @returns {() => void} 등록을 푸는 함수
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
