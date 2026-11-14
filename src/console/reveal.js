// 공개 장면의 다섯 시도 (명세 8.5).
// 같은 PC(127.0.0.1)의 앱 하나에 실제 요청을 보내고, 돌아온 결과 번호와 내용을 그대로 모은다.
// 기대값을 대신 넣지 않는다. 대답을 받지 못한 시도는 status가 null이다.
// 옆 사람 화면 표시는 붙이지 않는다(가져간 것으로 세지 않는다).

import { PARENT_PASSWORD } from '../shared/data.js';
import { REVEAL, TEXT } from './content.js';

const BODY_LIMIT = 256 * 1024;

/** 받은 본문을 그대로 돌려준다(JSON이면 값으로, 아니면 글자로). */
function parseBody(text) {
  if (text === '') return null;
  if (text.length > BODY_LIMIT) return `${text.slice(0, 2000)}…`;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

/**
 * 한 앱에 다섯 시도를 보낸다. 매번 새로 로그인하고 끝나면 로그아웃한다.
 * 어떤 경우에도 거절하지 않는다(실패는 결과에 담는다).
 * @param {string} baseUrl 'http://127.0.0.1:<포트>' (같은 PC의 앱만)
 * @param {{timeoutMs?: number, totalMs?: number}} [options] 요청 하나·전체를 기다리는 시간
 * @returns {Promise<{loginStatus: number|null, logoutStatus: number|null,
 *   results: Array<{no: number, status: number|null, body: any, error: string|null}>}>}
 */
export async function runRevealOn(baseUrl, { timeoutMs = 3000, totalMs = 6000 } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(baseUrl)) throw new Error('공개 요청은 같은 PC의 앱에만 보냅니다.');
  const overall = AbortSignal.timeout(totalMs);

  /** 실제 요청 하나. 쿠키는 손으로 넘긴다. */
  async function send(method, path, { cookie, body } = {}) {
    try {
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
      const response = await fetch(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.any([overall, AbortSignal.timeout(timeoutMs)]),
      });
      const text = await response.text();
      const cookies = response.headers.getSetCookie().map((line) => line.split(';', 1)[0]).filter((pair) => !pair.endsWith('='));
      return { status: response.status, body: parseBody(text), error: null, cookie: cookies.join('; ') };
    } catch {
      return { status: null, body: null, error: TEXT.revealNoReply, cookie: '' };
    }
  }

  const results = [];
  let cookie = '';
  let loginStatus = null;
  let loggedIn = false;
  for (const attempt of REVEAL.attempts) {
    if (attempt.login && !loggedIn) {
      // 앱의 로그인 요청을 그대로 쓴다.
      const login = await send('POST', '/api/login', { body: { loginId: REVEAL.loginId, password: PARENT_PASSWORD } });
      loginStatus = login.status;
      cookie = login.status === 200 ? login.cookie : '';
      loggedIn = true;
    }
    const sent = await send(attempt.method, attempt.path, { cookie: attempt.login ? cookie : '', body: attempt.body });
    results.push({ no: attempt.no, status: sent.status, body: sent.body, error: sent.error });
  }
  const logout = await send('POST', '/api/logout', { cookie });
  return { loginStatus, logoutStatus: logout.status, results };
}
