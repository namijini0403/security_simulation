// 받는 쪽 프로그램 (명세 6, 7)
//
// 실제 온라인 표·AI 서비스를 교육용으로 흉내 낸 별도 프로그램이다.
//   - 받은 것은 메모리에만 둔다(파일로 저장하지 않는다). 프로그램을 끄면 사라진다.
//   - 진짜 AI를 부르지 않는다. 이 프로그램은 밖으로 어떤 요청도 보내지 않는다.
//   - 다른 기기가 쓸 수 있는 것은 아래 다섯 요청뿐이다. 화면과 스위치 조작은 같은 PC에서만 된다.
//
//   GET  /api/ping      연결 확인
//   POST /sheet/rows    '온라인 표'에 한 줄 추가 (학생 전체 기록)
//   POST /ai/draft      'AI 서비스'가 받은 내용 기록 + 미리 써 둔 초안 반환
//   GET  /api/received  받은 것 전부
//   POST /api/clear     받은 것 전부 지우기

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccessSwitch, SWITCH_MESSAGES } from '../shared/access-switch.js';
import { RATING_VALUES, SUBJECTS, createStudents, isValidStudentId } from '../shared/data.js';
import { readJsonBody, sendError, sendJson, serveStatic } from '../shared/http.js';

/** 받는 본문의 크기 제한: 16KB (명세 6). */
export const BODY_LIMIT_BYTES = 16 * 1024;
/** 표와 AI 서비스가 각각 담아 두는 최대 개수(메모리가 끝없이 차지 않게). */
export const DEFAULT_MAX_ITEMS = 2000;

/** 온라인 표가 받는 항목(이것 말고는 받지 않는다). */
export const SHEET_KEYS = Object.freeze(['id', 'name', 'className', 'ratings', 'comment', 'guardianName', 'guardianPhone']);
/** AI 서비스가 받는 항목. */
export const AI_KEYS = Object.freeze(['id', 'name', 'ratings', 'comment']);

/** 스위치 조작 요청의 경로(같은 PC에서만 된다). */
export const SWITCH_PATHS = Object.freeze({
  status: '/local/switch', // GET: 지금 상태
  on: '/local/switch/on', // POST {confirmed: true}: 켜기
  extend: '/local/switch/extend', // POST: 연장
  off: '/local/switch/off', // POST: 끄기
  dismiss: '/local/switch/dismiss', // POST: "자동으로 꺼졌습니다" 알림 닫기
});

/** 화면 파일(같은 PC에서만 열린다). 주소 → 폴더 안의 파일. */
const SCREEN_FILES = Object.freeze({
  '/': '/index.html',
  '/index.html': '/index.html',
  '/receiver.css': '/receiver.css',
  '/receiver.js': '/receiver.js',
});

const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const MESSAGES = Object.freeze({
  notObject: '보낸 내용의 형식이 올바르지 않습니다. 정해진 항목을 담은 기록 하나를 보내 주세요.',
  badId: '학생 번호가 실습용 번호(TEST-1001 ~ TEST-1020)가 아니어서 받지 않았습니다.',
  badRatings: '평가 내용이 올바르지 않아서 받지 않았습니다. 과목은 국어·수학·사회·과학·영어, 값은 잘함·보통·노력요함만 받습니다.',
  badComment: '종합의견이 그 학생 번호의 실습용 가상 문장과 달라서 받지 않았습니다. 이 프로그램은 가상 데이터만 받습니다.',
  notSynthetic: '실습용 가상 데이터의 모양이 아니어서 받지 않았습니다. 이 프로그램은 가상 데이터만 받습니다.',
  tooLarge: `보낸 내용이 너무 커서 받지 않았습니다. (허용 크기: ${BODY_LIMIT_BYTES / 1024}KB)`,
  invalidJson: '보낸 내용의 형식이 올바르지 않아서 받지 않았습니다.',
  full: '받은 내용이 너무 많이 쌓여서 더 받지 않았습니다. 받는 쪽 화면에서 "받은 내용 모두 지우기"를 눌러 주세요.',
  notFound: '받는 쪽 프로그램에 없는 주소입니다.',
  wrongMethod: '이 주소에서는 쓸 수 없는 요청 방식입니다.',
  screenLocalOnly: '받는 쪽 화면은 받는 쪽 프로그램을 실행한 PC에서만 열 수 있습니다.',
  switchLocalOnly: '다른 기기 접속 스위치는 받는 쪽 프로그램을 실행한 PC에서만 조작할 수 있습니다.',
  foreignPage: '받는 쪽 화면에서 보낸 요청이 아니어서 처리하지 않았습니다.',
});

// --------------------------------------------------------------------------- 받은 내용 확인

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** 항목 이름이 정해진 것과 정확히 같은가(빠진 것도, 더 있는 것도 안 된다). */
function hasExactKeys(object, keys) {
  const actual = Object.keys(object);
  return actual.length === keys.length && keys.every((key) => own(object, key));
}

function ratingsOk(ratings) {
  if (!isPlainObject(ratings) || !hasExactKeys(ratings, SUBJECTS)) return false;
  return SUBJECTS.every((subject) => typeof ratings[subject] === 'string' && RATING_VALUES.includes(ratings[subject]));
}

/**
 * 코드가 만든 가상 기록(번호 → 기록). 받는 값은 이것과 비교한다.
 * 평가 다섯 개 말고는 어느 항목도 이 기록과 한 글자도 달라서는 안 된다
 * (어떤 기능도 이름·반·의견·보호자 정보를 바꾸지 않는다). 그래서 손으로 쓴 글이 들어올 자리가 없다.
 */
const GENERATED = new Map(createStudents().map((record) => [record.id, record]));

/** 정해진 항목 → 빠진 항목·더 있는 항목을 알려 주는 한국어 설명. */
function keysError(body, keys) {
  const missing = keys.filter((key) => !own(body, key));
  const extra = Object.keys(body).filter((key) => !keys.includes(key));
  const parts = [];
  if (missing.length > 0) parts.push(`빠진 항목이 있습니다(${missing.length}개)`);
  if (extra.length > 0) parts.push(`정해지지 않은 항목이 들어 있습니다(${extra.length}개)`);
  return `${parts.join(', ')}. 정해진 항목(${keys.join(', ')})만 받으므로 저장하지 않았습니다.`;
}

function validate(body, keys) {
  if (!isPlainObject(body)) return { ok: false, error: MESSAGES.notObject };
  if (!hasExactKeys(body, keys)) return { ok: false, error: keysError(body, keys) };
  if (!isValidStudentId(body.id)) return { ok: false, error: MESSAGES.badId };
  // 그 번호의 가상 기록과 비교한다(명세 4.1). 평가 말고는 글자 하나까지 같아야 받는다.
  const generated = GENERATED.get(body.id);
  if (!generated) return { ok: false, error: MESSAGES.badId };
  for (const key of keys) {
    if (key === 'id' || key === 'ratings' || key === 'comment') continue;
    if (body[key] !== generated[key]) return { ok: false, error: MESSAGES.notSynthetic };
  }
  if (!ratingsOk(body.ratings)) return { ok: false, error: MESSAGES.badRatings };
  if (body.comment !== generated.comment) return { ok: false, error: MESSAGES.badComment };
  return { ok: true };
}

/**
 * '온라인 표'로 온 본문 확인: 학생 전체 기록(항목 7개)이어야 한다.
 * @param {unknown} body
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateSheetRow(body) {
  return validate(body, SHEET_KEYS);
}

/**
 * 'AI 서비스'로 온 본문 확인: id, name, ratings, comment 네 항목이어야 한다.
 * @param {unknown} body
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateAiRequest(body) {
  return validate(body, AI_KEYS);
}

// --------------------------------------------------------------------------- 초안(미리 써 둔 문장)

/**
 * AI 종합의견 초안. 진짜 AI를 부르지 않는다. 미리 써 둔 문장에 `잘함`/`노력요함`인 과목 이름만 끼워 넣는다.
 * 이름·의견 같은 받은 글자는 쓰지 않는다.
 * @param {Record<string, string>} ratings 과목 → 평가 (확인을 통과한 값)
 * @returns {string}
 */
export function buildDraft(ratings) {
  const pick = (value) => SUBJECTS.filter((subject) => own(ratings, subject) && ratings[subject] === value);
  const strong = pick('잘함');
  const effort = pick('노력요함');
  const sentences = ['[사전 작성된 모의 응답] 한 학기 동안 수업에 성실하게 참여했습니다.'];
  if (strong.length > 0) sentences.push(`${strong.join(', ')} 시간에 배운 내용을 잘 이해하고 스스로 해내는 모습을 보였습니다.`);
  if (effort.length > 0) sentences.push(`${effort.join(', ')} 시간에는 기초를 다지는 꾸준한 연습이 더 필요합니다.`);
  if (strong.length === 0 && effort.length === 0) sentences.push('여러 과목을 고르게 배우고 있습니다.');
  sentences.push('다음 학기에도 꾸준히 성장하기를 기대합니다.');
  sentences.push('(실제 AI가 쓴 글이 아니라 교육용으로 미리 써 둔 문장입니다.)');
  return sentences.join(' ');
}

// --------------------------------------------------------------------------- 받는 쪽 만들기

function pathOf(req) {
  const url = typeof req.url === 'string' ? req.url : '';
  return url.split(/[?#]/, 1)[0];
}

/**
 * 같은 PC의 브라우저가 "받는 쪽 화면"에서 보낸 요청인가.
 * 다른 사이트의 화면이 이 PC의 브라우저를 시켜 스위치를 조작하는 것을 막는다.
 */
function fromOwnScreen(req, { navigation = false } = {}) {
  const port = req.socket.localPort;
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  // 화면을 여는 것 자체는 다른 곳의 링크를 눌러서 와도 된다(이 프로그램의 주소로 왔는지만 본다).
  if (navigation) return true;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

/**
 * 받는 쪽 프로그램을 만든다(아직 열지는 않는다. listen()을 불러야 열린다).
 *
 *   const receiver = createReceiver({ port: 4180 });
 *   const { port, url } = await receiver.listen();   // 127.0.0.1에서만 열린다(스위치를 켜기 전까지)
 *   await receiver.close();
 *
 * @param {object} [options]
 * @param {number} [options.port] 기본 0(빈 포트 자동 선택)
 * @param {number} [options.limitMs] 다른 기기 접속이 자동으로 꺼지기까지의 시간(기본 30분)
 * @param {number} [options.warningMs] 알림을 시작하는 남은 시간(기본 2분)
 * @param {object} [options.switchOptions] createAccessSwitch에 그대로 넘길 나머지 값(검사용: now, listAddresses, clientAddressOf 등)
 * @param {number} [options.maxItems] 표와 AI 서비스가 각각 담아 두는 최대 개수
 * @param {string} [options.publicDir] 화면 파일 폴더
 */
export function createReceiver(options = {}) {
  const {
    port: defaultPort = 0,
    limitMs,
    warningMs,
    switchOptions = {},
    maxItems = DEFAULT_MAX_ITEMS,
    publicDir = DEFAULT_PUBLIC_DIR,
  } = options;

  const switchConfig = { ...switchOptions };
  if (limitMs !== undefined) switchConfig.limitMs = limitMs;
  if (warningMs !== undefined) switchConfig.warningMs = warningMs;
  const accessSwitch = createAccessSwitch(switchConfig);

  /** 받은 것. 메모리에만 있다. */
  const store = { sheet: [], ai: [] };
  let listening = null;

  function switchView() {
    const status = accessSwitch.status();
    const mine = status.servers.find((server) => server.name === 'receiver');
    return {
      on: status.on,
      remainingMs: status.remainingMs,
      limitMs: status.limitMs,
      warning: status.warning,
      autoOff: status.autoOff,
      autoOffMessage: status.autoOff ? SWITCH_MESSAGES.autoOff : null,
      /** 이 PC의 내부 주소 전부 */
      addresses: status.addresses,
      /** 지금 실제로 다른 기기에서 열 수 있는 주소(진행 화면의 '받는 쪽 주소' 칸에 넣을 값) */
      openAddresses: mine ? mine.urls.map((url) => new URL(url).hostname) : [],
      noInternalAddress: status.noInternalAddress,
      guidance: status.guidance,
      failures: status.failures.map((failure) => failure.message),
      port: mine ? mine.port : null,
    };
  }

  /** 본문을 읽어 확인하고 저장한다. 저장했으면 받은 본문을, 거절했으면 null을 돌려준다(응답은 이미 보냈다). */
  async function receive(req, res, info, kind, check) {
    let body;
    try {
      body = await readJsonBody(req, { limitBytes: BODY_LIMIT_BYTES });
    } catch (error) {
      // 크기를 넘긴 것도 400으로 거절한다(명세 6).
      sendError(res, 400, error && error.code === 'BODY_TOO_LARGE' ? MESSAGES.tooLarge : MESSAGES.invalidJson);
      return null;
    }
    const checked = check(body);
    if (!checked.ok) {
      sendError(res, 400, checked.error);
      return null;
    }
    if (store[kind].length >= maxItems) {
      sendError(res, 507, MESSAGES.full);
      return null;
    }
    // 같은 학생이 다시 와도 덮어쓰지 않고 뒤에 붙인다.
    store[kind].push({ receivedAt: new Date().toISOString(), from: String(info.clientAddress), payload: body });
    return body;
  }

  const openRoutes = {
    '/api/ping': { method: 'GET', run: (req, res) => sendJson(res, 200, { ok: true, service: 'receiver' }) },
    '/sheet/rows': {
      method: 'POST',
      run: async (req, res, info) => {
        if (await receive(req, res, info, 'sheet', validateSheetRow)) sendJson(res, 200, { ok: true });
      },
    },
    '/ai/draft': {
      method: 'POST',
      run: async (req, res, info) => {
        const body = await receive(req, res, info, 'ai', validateAiRequest);
        if (body) sendJson(res, 200, { draft: buildDraft(body.ratings) });
      },
    },
    '/api/received': { method: 'GET', run: (req, res) => sendJson(res, 200, { sheet: store.sheet, ai: store.ai }) },
    '/api/clear': {
      method: 'POST',
      run: (req, res) => {
        store.sheet = [];
        store.ai = [];
        sendJson(res, 200, { ok: true });
      },
    },
  };

  const switchRoutes = {
    [SWITCH_PATHS.status]: { method: 'GET', run: (req, res) => sendJson(res, 200, switchView()) },
    [SWITCH_PATHS.on]: {
      method: 'POST',
      run: async (req, res) => {
        let body;
        try {
          body = await readJsonBody(req, { limitBytes: 1024 });
        } catch {
          sendError(res, 400, SWITCH_MESSAGES.needConfirm);
          return;
        }
        // 화면의 경고에서 확인을 눌렀다는 값({confirmed: true})이 정확히 있어야 켜진다.
        const confirmed = isPlainObject(body) && own(body, 'confirmed') && body.confirmed === true;
        const result = await accessSwitch.turnOn(confirmed ? { confirmed: true } : null);
        if (!result.ok) sendError(res, 400, result.error);
        else sendJson(res, 200, switchView());
      },
    },
    [SWITCH_PATHS.extend]: {
      method: 'POST',
      run: (req, res) => {
        const result = accessSwitch.extend();
        if (!result.ok) sendError(res, 409, result.error);
        else sendJson(res, 200, switchView());
      },
    },
    [SWITCH_PATHS.off]: {
      method: 'POST',
      run: async (req, res) => {
        await accessSwitch.turnOff();
        sendJson(res, 200, switchView());
      },
    },
    [SWITCH_PATHS.dismiss]: {
      method: 'POST',
      run: (req, res) => {
        accessSwitch.clearAutoOffNotice();
        sendJson(res, 200, switchView());
      },
    },
  };

  /**
   * 요청 처리기. 스위치가 `(req, res, info)`로 부른다.
   * info.local(같은 PC 쪽 문으로 들어왔는가)은 꾸밀 수 없는 값이다.
   */
  async function handler(req, res, info) {
    const pathname = pathOf(req);

    // 1) 다른 기기도 쓸 수 있는 다섯 요청
    if (own(openRoutes, pathname)) {
      const route = openRoutes[pathname];
      if (req.method !== route.method) {
        sendError(res, 405, MESSAGES.wrongMethod);
        return;
      }
      await route.run(req, res, info);
      return;
    }

    // 2) 같은 PC에서만 되는 것: 스위치 조작, 화면
    const isSwitch = own(switchRoutes, pathname);
    const isScreen = own(SCREEN_FILES, pathname);
    if (!isSwitch && !isScreen) {
      sendError(res, 404, MESSAGES.notFound);
      return;
    }
    if (!info || info.local !== true) {
      sendError(res, 403, isSwitch ? MESSAGES.switchLocalOnly : MESSAGES.screenLocalOnly);
      return;
    }
    if (!fromOwnScreen(req, { navigation: isScreen })) {
      sendError(res, 403, MESSAGES.foreignPage);
      return;
    }
    if (isSwitch) {
      const route = switchRoutes[pathname];
      if (req.method !== route.method) {
        sendError(res, 405, MESSAGES.wrongMethod);
        return;
      }
      await route.run(req, res, info);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, MESSAGES.wrongMethod);
      return;
    }
    // 화면은 이 프로그램이 내준 파일만 쓴다(밖에서 아무것도 가져오지 않는다).
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!(await serveStatic(req, res, publicDir, { urlPath: SCREEN_FILES[pathname] }))) {
      sendError(res, 404, MESSAGES.notFound);
    }
  }

  return {
    /** 이 프로그램의 다른 기기 접속 스위치. */
    accessSwitch,
    handler,
    /**
     * 연다. 처음에는 같은 PC(127.0.0.1)에서만 열린다.
     * 열지 못하면 거절한다(오류에 code와 port가 들어 있다. 예: 'EADDRINUSE').
     * @param {number} [port] 생략하면 만들 때 준 값
     * @returns {Promise<{port: number, url: string}>} url은 'http://127.0.0.1:<포트>'
     */
    async listen(port = defaultPort) {
      if (listening) return listening;
      const opened = await accessSwitch.listen({ name: 'receiver', port, handler });
      listening = { port: opened.port, url: `http://127.0.0.1:${opened.port}` };
      return listening;
    },
    /** 받은 것의 사본(검사·확인용). */
    received() {
      return { sheet: [...store.sheet], ai: [...store.ai] };
    },
    /** 닫는다: 다른 기기 접속도 끝나고, 타이머와 연결을 모두 정리한다. */
    async close() {
      await accessSwitch.close();
    },
  };
}
