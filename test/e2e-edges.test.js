// 처음부터 끝까지(2): 발표 도중 받는 쪽이 꺼졌을 때, 두 앱을 구분할 수 없음, 실제 정보가 들어올 통로가 없음,
// 그리고 두 프로그램을 실제로 실행해 보기 (명세 5.3, 5.4, 6, 8.6, 11, 12, 15).
//
// 진짜 시연 프로그램과 진짜 받는 쪽 프로그램을 함께 띄우고 실제 요청으로만 확인한다. 브라우저는 열지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createStudents } from '../src/shared/data.js';
import {
  ALL_GOOD, NEIGHBOR, ROOT, call, killLater, runProgram, startTalk, tryConnect, waitExit, waitFor,
} from './e2e-helpers.js';

const INITIAL = createStudents();
const initialOf = (id) => structuredClone(INITIAL.find((student) => student.id === id));
const KOREAN = /[가-힣]/;

async function loginAs(base, loginId) {
  const res = await call(base, 'POST', '/api/login', { body: { loginId, password: loginId === 'teacher' ? 'teacher1234' : 'demo1234' } });
  assert.equal(res.status, 200);
  return res.cookie;
}

// --------------------------------------------------------------------------- 받는 쪽이 도중에 꺼졌을 때

test('발표 도중 받는 쪽이 꺼지면: 성적 저장은 그대로 되고, AI 초안은 502, 진행 화면이 닿지 못했다고 알린다', async (t) => {
  const rig = await startTalk(t, { forwardTimeoutMs: 2500 });
  const app1 = rig.bases[1];
  const teacher = await loginAs(app1, 'teacher');

  // 꺼지기 전: 정상적으로 도착한다.
  assert.equal((await call(app1, 'PUT', '/api/students/TEST-1003/ratings', { cookie: teacher, body: { ratings: { 국어: '잘함' } } })).status, 200);
  const up = await waitFor(async () => {
    const state = await rig.state();
    return state.receiver.sheetCount === 1 ? state : null;
  }, 5000, '꺼지기 전의 저장이 도착하지 않았다');
  assert.equal(up.receiver.reachable, true);
  assert.deepEqual(up.receiver.help, []);

  await rig.stopReceiver();
  assert.notEqual(await tryConnect('127.0.0.1', rig.receiverPort), 'open');

  // 성적 저장 자체는 성공한다(200). 앱 화면에는 전송 실패가 드러나지 않는다.
  const saved = await call(app1, 'PUT', '/api/students/TEST-1004/ratings', { cookie: teacher, body: { ratings: { 수학: '노력요함' } } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { ...initialOf('TEST-1004'), ratings: { ...initialOf('TEST-1004').ratings, 수학: '노력요함' } });
  assert.equal((await call(app1, 'GET', '/api/students/TEST-1004', { cookie: teacher })).json.ratings.수학, '노력요함');

  // AI 초안은 502와 한국어 설명.
  const draft = await call(app1, 'POST', '/api/students/TEST-1004/ai-draft', { cookie: teacher });
  assert.equal(draft.status, 502);
  assert.deepEqual(Object.keys(draft.json), ['error']);
  assert.match(draft.json.error, KOREAN);

  // 진행 화면: "받는 쪽에 닿지 못했습니다"와 조치, 실패한 전송 두 건.
  const down = await waitFor(async () => {
    const state = await rig.state();
    return state.receiver.reachable === false && state.receiver.failedTransfers.length === 2 ? state : null;
  }, 8000, '진행 화면이 받는 쪽에 닿지 못했다고 알리지 않았다');
  assert.equal(down.receiver.error, '받는 쪽에 닿지 못했습니다');
  assert.equal(down.receiver.help.length, 3);
  assert.ok(down.receiver.help.every((line) => KOREAN.test(line)));
  // 닿지 못하는 동안에는 예전에 받아 둔 것을 지금 것처럼 보여주지 않는다.
  assert.deepEqual([down.receiver.sheetCount, down.receiver.aiCount], [0, 0]);
  assert.deepEqual(down.receiver.failedTransfers.map((item) => [item.app, item.kindLabel, item.studentId, item.status]), [
    ['1번 앱', '온라인 표', 'TEST-1004', null],
    ['1번 앱', 'AI 서비스', 'TEST-1004', null],
  ]);
  assert.ok(down.receiver.failedTransfers.every((item) => KOREAN.test(item.error)));

  // 연결 확인도 실제로 실패하고 원인 후보 다섯 가지를 알려 준다.
  const ping = await rig.press('/api/receiver', { action: 'ping' });
  assert.equal(ping.status, 200);
  assert.equal(ping.json.ping.ok, false);
  assert.equal(ping.json.ping.causes.length, 5);

  // 받는 쪽 주소를 다른 값으로 바꿔 둔다(초기화 뒤에도 유지되는지 보기 위해). 같은 PC 주소이고 아무도 듣지 않는다.
  const set = await rig.press('/api/receiver', { action: 'set', host: '127.0.0.9' });
  assert.equal(set.status, 200);
  assert.equal(set.json.state.receiver.host, '127.0.0.9');

  // 전체 초기화: 받는 쪽은 지우지 못했다고 알리고, 나머지는 그대로 초기화한다.
  const reset = await rig.press('/api/reset');
  assert.equal(reset.status, 200);
  assert.equal(reset.json.receiverCleared, false);
  assert.equal(reset.json.notice, '받는 쪽은 지우지 못했습니다. 받는 쪽 화면에서 직접 지우세요');
  const state = reset.json.state;
  assert.equal(state.lastReset.receiverCleared, false);
  assert.equal(state.lastReset.notice, reset.json.notice);
  assert.equal(state.receiver.reachable, false);
  assert.equal(state.receiver.host, '127.0.0.9', '받는 쪽 주소는 초기화해도 그대로다');
  assert.equal(state.receiver.port, rig.receiverPort);
  assert.deepEqual(state.receiver.failedTransfers, []);
  assert.deepEqual(state.accessLog.entries, []);
  assert.equal((await call(app1, 'GET', '/api/me', { cookie: teacher })).status, 401, '로그인도 무효가 됐다');
  const again = await loginAs(app1, 'teacher');
  assert.deepEqual((await call(app1, 'GET', '/api/students', { cookie: again })).json, INITIAL);
});

// --------------------------------------------------------------------------- 로그인 상태는 서버가 기억한 것만 통한다

test('한 앱의 로그인은 다른 앱에 통하지 않고, 브라우저가 역할을 꾸며 보내도 2번 앱의 권한은 바뀌지 않는다', async (t) => {
  const rig = await startTalk(t);
  const [app1, app2] = [rig.bases[1], rig.bases[2]];
  const teacher1 = await loginAs(app1, 'teacher');
  const parent2 = await loginAs(app2, 'parent01');
  const [name1, value1] = teacher1.split('=');
  const [name2] = parent2.split('=');
  assert.notEqual(name1, name2, '두 앱은 로그인 상태를 서로 다른 이름으로 보관한다');

  // 1번 앱의 담임 로그인을 2번 앱에 그대로(또는 2번 앱의 이름으로 바꿔) 보내도 로그인 안 한 것으로 다뤄진다.
  for (const cookie of [teacher1, `${name2}=${value1}`]) {
    assert.equal((await call(app2, 'GET', '/api/me', { cookie })).status, 401);
    assert.equal((await call(app2, 'GET', '/api/students', { cookie })).status, 401);
  }
  // 같은 브라우저처럼 두 쿠키를 함께 보내면 2번 앱은 자기 것(학부모)만 본다.
  const together = `${teacher1}; ${parent2}`;
  assert.equal((await call(app2, 'GET', '/api/me', { cookie: together })).json.loginId, 'parent01');
  assert.equal((await call(app2, 'GET', '/api/students', { cookie: together })).status, 403);
  assert.equal((await call(app1, 'GET', '/api/me', { cookie: together })).json.loginId, 'teacher');

  // 역할·담당 학생을 주소, 본문, 머리글, 다른 쿠키로 꾸며 보내도 2번 앱의 결과는 그대로다.
  const forged = {
    cookie: `${parent2}; role=teacher; loginId=teacher; studentId=TEST-1002`,
    headers: { 'X-Role': 'teacher', 'X-Login-Id': 'teacher', 'X-Student-Id': 'TEST-1002', 'X-Demo-Screen': 'neighbor', Authorization: 'Bearer teacher' },
  };
  const before = (await call(app2, 'GET', '/api/students/TEST-1001', { cookie: parent2 })).json;
  assert.equal((await call(app2, 'GET', '/api/students/TEST-1002?role=teacher&loginId=teacher&studentId=TEST-1002', forged)).status, 403);
  assert.equal((await call(app2, 'GET', '/api/students?role=teacher', forged)).status, 403);
  assert.equal((await call(app2, 'GET', '/api/roster?role=teacher', forged)).status, 403);
  const put = await call(app2, 'PUT', '/api/students/TEST-1001/ratings?role=teacher', {
    ...forged, body: { ratings: ALL_GOOD, role: 'teacher', loginId: 'teacher', studentId: 'TEST-1001' },
  });
  assert.equal(put.status, 403);
  assert.equal((await call(app2, 'DELETE', '/api/students/TEST-1001?role=teacher', forged)).status, 403);
  assert.deepEqual((await call(app2, 'GET', '/api/me', forged)).json, { role: 'parent', loginId: 'parent01', studentId: 'TEST-1001' });
  assert.deepEqual((await call(app2, 'GET', '/api/students/TEST-1001', { cookie: parent2 })).json, before, '아무것도 바뀌지 않았다');
  assert.deepEqual(before, initialOf('TEST-1001'));

  // 로그아웃하면 그 로그인 상태는 무효다.
  assert.equal((await call(app2, 'POST', '/api/logout', { cookie: parent2 })).status, 200);
  assert.equal((await call(app2, 'GET', '/api/students/TEST-1001', { cookie: parent2 })).status, 401);
  // 진행 화면에는 이 요청들이 실제 결과 번호 그대로 남아 있다.
  const state = await rig.state();
  const forgedRows = state.accessLog.entries.filter((entry) => entry.appNo === 2 && [403].includes(entry.status));
  assert.equal(forgedRows.length, 6);
  assert.ok(forgedRows.every((entry) => entry.loginLabel === 'parent01'));
});

// --------------------------------------------------------------------------- 두 앱은 구분할 수 없다

/** 응답 머리글에서 비교할 것만 남긴다(시각은 뺀다. 쿠키는 따로 본다). */
function comparableHeaders(headers) {
  const copy = { ...headers };
  delete copy.date;
  delete copy['set-cookie'];
  return copy;
}

const FORBIDDEN_WORDS = ['unsafe', 'insecure', 'secure', 'vulnerab', 'protected', 'hardened', '취약', '허술', '안전', '막아', '보안', '권한 확인', '확인 안 함'];

function forbiddenIn(text) {
  const lower = text.toLowerCase();
  return FORBIDDEN_WORDS.filter((word) => lower.includes(word));
}

test('두 앱의 화면 파일은 바이트까지 같고, 응답은 5.3 표가 정한 칸(거절된 요청의 결과 번호와 내용)에서만 다르다', async (t) => {
  const rig = await startTalk(t);
  const [a, b] = [rig.bases[1], rig.bases[2]];

  // ---- 화면 파일: 폴더의 모든 파일과 /, /neighbor
  const dir = path.join(ROOT, 'src', 'app', 'public');
  const files = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile());
  assert.ok(files.includes('index.html') && files.includes('neighbor.html') && files.includes('index.js') && files.includes('neighbor.js'));
  const pages = [['/', 'index.html'], ['/neighbor', 'neighbor.html'], ...files.map((name) => [`/${name}`, name])];
  for (const [url, file] of pages) {
    const [ra, rb] = [await call(a, 'GET', url), await call(b, 'GET', url)];
    assert.equal(ra.status, 200, url);
    assert.equal(rb.status, 200, url);
    const disk = fs.readFileSync(path.join(dir, file));
    assert.ok(ra.bytes.equals(rb.bytes), `${url}: 두 앱이 내보낸 바이트가 다르다`);
    assert.ok(ra.bytes.equals(disk), `${url}: 폴더의 파일과 다르다`);
    assert.deepEqual(comparableHeaders(ra.headers), comparableHeaders(rb.headers), `${url}: 머리글이 다르다`);
    assert.deepEqual(ra.setCookies, []);
    assert.deepEqual(forbiddenIn(ra.text), [], `${url}: 구분되는 낱말`);
    assert.deepEqual(forbiddenIn(file), []);
    assert.ok(!ra.text.includes('1번 앱') && !ra.text.includes('2번 앱'), '앱 이름은 파일에 없다(/api/app에서만 온다)');
  }
  // 앱 이름만 다르다(중립적인 이름).
  assert.deepEqual((await call(a, 'GET', '/api/app')).json, { label: '1번 앱' });
  assert.deepEqual((await call(b, 'GET', '/api/app')).json, { label: '2번 앱' });

  // ---- 응답: 같은 요청을 같은 순서로 두 앱에 보낸다.
  const texts = [];
  /** 두 앱에 같은 요청을 보내고 둘의 응답을 돌려준다. */
  async function both(method, pathname, cookies, body) {
    const ra = await call(a, method, pathname, { cookie: cookies ? cookies.a : undefined, body, headers: NEIGHBOR });
    const rb = await call(b, method, pathname, { cookie: cookies ? cookies.b : undefined, body, headers: NEIGHBOR });
    texts.push(ra.text, rb.text, JSON.stringify(ra.headers), JSON.stringify(rb.headers));
    return { ra, rb };
  }
  const same = ({ ra, rb }, label) => {
    assert.equal(ra.status, rb.status, `${label}: 결과 번호`);
    assert.equal(ra.text, rb.text, `${label}: 내용`);
    assert.deepEqual(comparableHeaders(ra.headers), comparableHeaders(rb.headers), `${label}: 머리글`);
  };
  async function loginBoth(loginId) {
    const password = loginId === 'teacher' ? 'teacher1234' : 'demo1234';
    const pair = await both('POST', '/api/login', null, { loginId, password });
    same(pair, `로그인 ${loginId}`);
    // 쿠키는 이름만 다르다(같은 PC에서 두 앱의 로그인이 섞이지 않게, 명세 4.3). 이름에도 구분되는 낱말은 없다.
    const shape = (line) => line.replace(/^[^=]+=[^;]+/, 'NAME=VALUE');
    assert.equal(shape(pair.ra.setCookies[0]), shape(pair.rb.setCookies[0]));
    const names = [pair.ra.setCookies[0].split('=')[0], pair.rb.setCookies[0].split('=')[0]];
    assert.notEqual(names[0], names[1]);
    assert.deepEqual(forbiddenIn(names.join(' ')), []);
    return { a: pair.ra.cookie, b: pair.rb.cookie };
  }

  // 요청 목록. expected: [1번 앱, 2번 앱]의 결과 번호(명세 5.3 표 + 공통 규칙).
  const requestsFor = (deleteId) => [
    { name: 'roster', method: 'GET', path: '/api/roster' },
    { name: 'getOwn', method: 'GET', path: '/api/students/TEST-1001' },
    { name: 'getOther', method: 'GET', path: '/api/students/TEST-1002' },
    { name: 'list', method: 'GET', path: '/api/students' },
    { name: 'put', method: 'PUT', path: '/api/students/TEST-1001/ratings', body: { ratings: ALL_GOOD } },
    { name: 'draft', method: 'POST', path: '/api/students/TEST-1001/ai-draft' },
    { name: 'delete', method: 'DELETE', path: `/api/students/${deleteId}` },
    { name: 'missing', method: 'GET', path: '/api/students/TEST-1099' },
    { name: 'me', method: 'GET', path: '/api/me' },
    { name: 'unknown', method: 'GET', path: '/api/nothing-here' },
  ];
  const TABLE = {
    teacher: { roster: [200, 200], getOwn: [200, 200], getOther: [200, 200], list: [200, 200], put: [200, 200], draft: [200, 200], delete: [200, 200], missing: [404, 404], me: [200, 200], unknown: [404, 404] },
    parent: { roster: [200, 403], getOwn: [200, 200], getOther: [200, 403], list: [200, 403], put: [200, 403], draft: [200, 403], delete: [200, 403], missing: [404, 403], me: [200, 200], unknown: [404, 404] },
    none: { roster: [200, 401], getOwn: [401, 401], getOther: [401, 401], list: [200, 401], put: [200, 401], draft: [200, 401], delete: [200, 401], missing: [401, 401], me: [401, 401], unknown: [404, 404] },
  };

  const refusals = { 401: new Set(), 403: new Set() };
  let differing = 0;
  // 담임을 먼저 한다: 두 앱 모두에서 같은 일이 일어나므로 그 뒤의 상태도 같다.
  const actors = [
    ['teacher', await loginBoth('teacher'), 'TEST-1020'],
    ['parent', await loginBoth('parent01'), 'TEST-1019'],
    ['none', null, 'TEST-1018'],
  ];
  for (const [actor, cookies, deleteId] of actors) {
    for (const request of requestsFor(deleteId)) {
      const label = `${actor} · ${request.method} ${request.path}`;
      const pair = await both(request.method, request.path, cookies, request.body);
      const [wantA, wantB] = TABLE[actor][request.name];
      assert.equal(pair.ra.status, wantA, `${label}: 1번 앱`);
      assert.equal(pair.rb.status, wantB, `${label}: 2번 앱`);
      for (const res of [pair.ra, pair.rb]) {
        if (res.status === 401 || res.status === 403) {
          assert.deepEqual(Object.keys(res.json), ['error'], `${label}: 거절 응답에는 설명만 있다`);
          refusals[res.status].add(res.text);
        }
      }
      if (wantA === wantB) {
        // 표가 같다고 한 칸: 결과 번호, 내용, 머리글이 완전히 같다.
        same(pair, label);
      } else {
        // 표가 다르다고 한 칸: 다른 것은 거절의 결과 번호와 그 설명뿐이고, 응답의 모양(머리글 이름)은 같다.
        differing += 1;
        assert.ok(wantB === 401 || wantB === 403);
        assert.deepEqual(Object.keys(pair.ra.headers).sort(), Object.keys(pair.rb.headers).sort(), `${label}: 머리글 이름`);
        assert.equal(pair.ra.headers['content-type'], pair.rb.headers['content-type']);
      }
    }
  }
  // 5.3 표에서 두 앱이 다른 칸은 정확히 이만큼이다(학부모 6칸 + 없는 번호 1칸, 로그인 없음 5칸).
  assert.equal(differing, 12);
  // 거절 문구는 종류마다 하나뿐이다. 1번 앱 자신이 쓰는 401 문구와 2번 앱의 401 문구가 같다(문구로 구분되지 않는다).
  assert.equal(refusals[401].size, 1);
  assert.equal(refusals[403].size, 1);

  // 틀린 비밀번호도 같다.
  same(await both('POST', '/api/login', null, { loginId: 'parent01', password: 'wrong' }), '틀린 비밀번호');
  // 로그아웃도 같다.
  const parentAgain = await loginBoth('parent02');
  same(await both('POST', '/api/logout', parentAgain), '로그아웃');

  // 모든 응답 본문과 머리글에 구분되는 낱말이 없다.
  assert.ok(texts.length > 120);
  assert.deepEqual(forbiddenIn(texts.join('\n')), []);
});

// --------------------------------------------------------------------------- 실제 정보가 들어올 통로가 없다

/** 화면 파일에서 값을 넣을 수 있는 요소를 찾는다. */
function inputsOf(html) {
  const tags = [...html.matchAll(/<(input|textarea|select)\b[^>]*>/gi)].map((match) => {
    const id = /\bid="([^"]*)"/i.exec(match[0]);
    const type = /\btype="([^"]*)"/i.exec(match[0]);
    return { tag: match[1].toLowerCase(), id: id ? id[1] : null, type: type ? type[1].toLowerCase() : null };
  });
  return {
    typed: tags.filter((item) => item.tag === 'textarea' || (item.tag === 'input' && !['button', 'submit', 'checkbox', 'radio', 'hidden'].includes(item.type))),
    all: tags,
    editable: /contenteditable/i.test(html),
    file: /type\s*=\s*["']?file/i.test(html),
  };
}

/** 스크립트가 타이핑 칸·파일 올리기·가져오기를 만들지 않는가. */
function scriptMakesInlet(script) {
  return [
    /createElement\(\s*['"](input|textarea)['"]\s*\)/i, /contentEditable/i, /FileReader/, /DataTransfer/, /type\s*=\s*['"]file['"]/i,
    /addEventListener\(\s*['"](drop|paste)['"]/i, /\bprompt\s*\(/, /innerHTML/, /showOpenFilePicker/,
  ].filter((pattern) => pattern.test(script)).map(String);
}

test('실제 정보가 들어올 통로가 없다: 받는 쪽은 가상 데이터가 아니면 거절하고, 화면에는 로그인 칸과 받는 쪽 주소 칸 말고 타이핑하는 칸이 없다', async (t) => {
  const rig = await startTalk(t);
  const receiver = rig.receiverBase;
  const valid = initialOf('TEST-1003');

  // ---- 받는 쪽: 가상 데이터의 모양이 아니면 저장하지 않는다.
  const refusedRows = [
    ['실제처럼 보이는 번호', { ...valid, id: '2024-6-3-17' }],
    ['번호 형식이 조금 다름', { ...valid, id: 'TEST-1021' }],
    ['실제처럼 보이는 이름', { ...valid, name: '김아무개' }],
    ['실제처럼 보이는 학급', { ...valid, className: '6학년 3반' }],
    ['실제처럼 보이는 보호자 이름', { ...valid, guardianName: '김보호자' }],
    ['실제 전화번호 모양', { ...valid, guardianPhone: '010-1234-5678' }],
    ['정해지지 않은 항목', { ...valid, address: '어느 동네', memo: '메모' }],
    ['정해지지 않은 평가 값', { ...valid, ratings: { ...valid.ratings, 국어: '92점' } }],
    ['정해지지 않은 과목', { ...valid, ratings: { ...valid.ratings, 체육: '잘함' } }],
    ['너무 긴 의견', { ...valid, comment: '가'.repeat(400) }],
  ];
  for (const [label, row] of refusedRows) {
    const res = await call(receiver, 'POST', '/sheet/rows', { body: row });
    assert.equal(res.status, 400, label);
    assert.match(res.json.error, KOREAN, label);
  }
  const big = await call(receiver, 'POST', '/sheet/rows', { body: { ...valid, comment: '가'.repeat(17 * 1024) } });
  assert.equal(big.status, 400, '16KB를 넘는 본문');
  const { guardianName: _n, guardianPhone: _p, className: _c, ...aiValid } = valid;
  for (const [label, body] of [
    ['AI: 실제처럼 보이는 번호', { ...aiValid, id: 'S-1' }],
    ['AI: 실제처럼 보이는 이름', { ...aiValid, name: '김아무개' }],
    ['AI: 정해지지 않은 항목(보호자 연락처)', { ...aiValid, guardianPhone: '010-XXXX-0003' }],
  ]) {
    assert.equal((await call(receiver, 'POST', '/ai/draft', { body })).status, 400, label);
  }
  assert.equal((await call(receiver, 'POST', '/sheet/rows', { rawBody: '이것은 JSON이 아니다' })).status, 400);
  assert.deepEqual(await rig.held(), { sheet: [], ai: [] }, '거절한 것은 하나도 저장하지 않았다');
  // 받는 쪽에는 파일 올리기·가져오기 같은 다른 통로가 없다.
  for (const [method, pathname] of [['POST', '/upload'], ['POST', '/import'], ['PUT', '/sheet/rows'], ['POST', '/api/received']]) {
    assert.ok([404, 405].includes((await call(receiver, method, pathname, { body: valid })).status), `${method} ${pathname}`);
  }
  // 진행 화면에도 그대로 보인다: 도착한 것 없음.
  const state = await rig.state();
  assert.deepEqual([state.receiver.sheetCount, state.receiver.aiCount], [0, 0]);
  // 가상 데이터는 받는다(거절만 하는 것이 아니다).
  assert.equal((await call(receiver, 'POST', '/sheet/rows', { body: valid })).status, 200);
  assert.equal((await rig.held()).sheet.length, 1);

  // ---- 두 앱: 평가 값 세 가지 말고는 아무 글자도 기록에 넣을 수 없다.
  for (const appNo of [1, 2]) {
    const base = rig.bases[appNo];
    const teacher = await loginAs(base, 'teacher');
    // 본문에 이름·의견·연락처를 끼워 보내도 평가만 바뀐다.
    const sneaky = await call(base, 'PUT', '/api/students/TEST-1007/ratings', {
      cookie: teacher,
      body: { ratings: { 국어: '잘함' }, name: '김아무개', comment: '실제 의견', guardianPhone: '010-1234-5678', id: 'REAL-1' },
    });
    assert.equal(sneaky.status, 200);
    assert.deepEqual(sneaky.json, { ...initialOf('TEST-1007'), ratings: { ...initialOf('TEST-1007').ratings, 국어: '잘함' } });
    // 정해진 값이 아닌 글자는 400이고 아무것도 바뀌지 않는다.
    for (const ratings of [{ 국어: '아주 잘함' }, { 국어: '김아무개' }, { 메모: '잘함' }]) {
      assert.equal((await call(base, 'PUT', '/api/students/TEST-1007/ratings', { cookie: teacher, body: { ratings } })).status, 400);
    }
    // 학생을 새로 만들거나 기록 전체를 바꾸거나 파일을 올리는 요청은 없다.
    for (const [method, pathname] of [
      ['POST', '/api/students'], ['PUT', '/api/students/TEST-1007'], ['PATCH', '/api/students/TEST-1007'],
      ['POST', '/api/upload'], ['POST', '/api/import'], ['PUT', '/api/students/TEST-1007/comment'],
    ]) {
      assert.equal((await call(base, method, pathname, { cookie: teacher, body: { name: '김아무개' } })).status, 404, `${method} ${pathname}`);
    }
    assert.deepEqual((await call(base, 'GET', '/api/students/TEST-1007', { cookie: teacher })).json.comment, initialOf('TEST-1007').comment);
    // 요청으로 보낼 곳을 바꿀 수 없다: 주소를 끼워 보내도 정해 둔 받는 쪽으로만 간다.
    await call(base, 'PUT', '/api/students/TEST-1008/ratings?receiver=http://203.0.113.5:4180', {
      cookie: teacher, body: { ratings: { 국어: '보통' }, receiver: 'http://203.0.113.5:4180', receiverHost: '203.0.113.5' },
      headers: { 'X-Receiver': 'http://203.0.113.5:4180', 'X-Forwarded-Host': '203.0.113.5' },
    });
    await rig.demo.apps[`app${appNo}`].whenIdle();
    const transfers = rig.demo.apps[`app${appNo}`].getTransferLog();
    assert.ok(transfers.length >= 2);
    assert.ok(transfers.every((entry) => entry.ok && entry.destination === `${receiver}/sheet/rows`), '보낸 곳은 정해 둔 받는 쪽뿐이다');
  }

  // ---- 진행 화면의 받는 쪽 주소 칸: 같은 PC·사설 주소가 아니면 받아들이지 않는다.
  for (const host of ['example.com', 'localhost', '8.8.8.8', '203.0.113.5', '127.0.0.1:9999', 'http://127.0.0.1', '::1', '']) {
    const res = await rig.press('/api/receiver', { action: 'set', host });
    assert.equal(res.status, 400, `받는 쪽 주소 "${host}"`);
    assert.match(res.json.error, KOREAN);
    assert.equal(res.json.state.receiver.host, '127.0.0.1', '거절된 주소는 적용되지 않는다');
  }

  // ---- 화면 파일(진짜 프로그램이 내보낸 것): 타이핑하는 칸
  for (const appNo of [1, 2]) {
    const base = rig.bases[appNo];
    const main = inputsOf((await call(base, 'GET', '/')).text);
    assert.deepEqual(main.typed.map((item) => [item.id, item.type]), [['login-id', 'text'], ['login-pw', 'password']], '메인 화면: 로그인 칸 두 개뿐');
    assert.deepEqual(main.all.map((item) => item.id), ['login-id', 'login-pw']);
    const neighbor = inputsOf((await call(base, 'GET', '/neighbor')).text);
    assert.deepEqual(neighbor.typed, [], '옆 사람 화면: 타이핑하는 칸이 없다');
    assert.deepEqual(neighbor.all.map((item) => [item.tag, item.id]), [['select', 'pick-id']], '고르는 칸 하나뿐(학생 번호)');
    for (const page of [main, neighbor]) assert.ok(!page.editable && !page.file);
    for (const script of ['/index.js', '/neighbor.js']) {
      assert.deepEqual(scriptMakesInlet((await call(base, 'GET', script)).text), [], script);
    }
  }
  const consolePage = inputsOf((await call(rig.consoleBase, 'GET', '/')).text);
  assert.deepEqual(consolePage.all.map((item) => [item.tag, item.id, item.type]), [['input', 'receiver-host', 'text']], '진행 화면: 받는 쪽 주소 칸 하나뿐');
  assert.ok(!consolePage.editable && !consolePage.file);
  assert.deepEqual(scriptMakesInlet((await call(rig.consoleBase, 'GET', '/console.js')).text), []);
  const receiverPage = inputsOf((await call(receiver, 'GET', '/')).text);
  assert.deepEqual(receiverPage.all, [], '받는 쪽 화면: 입력하는 칸이 없다');
  assert.ok(!receiverPage.editable && !receiverPage.file);
  assert.deepEqual(scriptMakesInlet((await call(receiver, 'GET', '/receiver.js')).text), []);
});

// --------------------------------------------------------------------------- 두 프로그램을 실제로 실행해 보기

test('실행: node src/receiver/main.js 와 node src/demo.js 를 실제로 띄우면 시연 프로그램이 받는 쪽 프로그램으로 실제로 보낸다. 끝내면 아무것도 남지 않는다', async (t) => {
  // 받는 쪽 프로그램을 먼저 띄운다(빈 포트).
  const receiverProc = runProgram('src/receiver/main.js', { RECEIVER_PORT: '0' });
  killLater(t, receiverProc);
  const receiverMatch = await waitFor(
    () => /받는 쪽 화면: http:\/\/127\.0\.0\.1:(\d+)\//.exec(receiverProc.output.stdout),
    15000,
    () => `받는 쪽 프로그램이 주소를 알려 주지 않았습니다.\n${receiverProc.text()}`,
  );
  const receiverPort = Number(receiverMatch[1]);
  const receiver = `http://127.0.0.1:${receiverPort}`;

  // 시연 프로그램을 그 받는 쪽 포트를 알려 주고 띄운다.
  const demoProc = runProgram('src/demo.js', { CONSOLE_PORT: '0', APP1_PORT: '0', APP2_PORT: '0', RECEIVER_PORT: String(receiverPort) });
  killLater(t, demoProc);
  const consoleMatch = await waitFor(
    () => /진행 화면: http:\/\/127\.0\.0\.1:(\d+)\//.exec(demoProc.output.stdout),
    15000,
    () => `시연 프로그램이 주소를 알려 주지 않았습니다.\n${demoProc.text()}`,
  );
  const consoleBase = `http://127.0.0.1:${consoleMatch[1]}`;
  const appPorts = [...demoProc.output.stdout.matchAll(/([12])번 앱: http:\/\/127\.0\.0\.1:(\d+)\//g)].map((match) => Number(match[2]));
  assert.equal(appPorts.length, 2);
  const [app1, app2] = appPorts.map((port) => `http://127.0.0.1:${port}`);
  assert.match(demoProc.output.stdout, new RegExp(`받는 쪽 주소\\(처음 값\\): http://127\\.0\\.0\\.1:${receiverPort}`));
  for (const proc of [receiverProc, demoProc]) {
    assert.match(proc.output.stdout, /교육용 실습 \/ 100% 합성 데이터 \/ 실제 개인정보 입력 금지/);
    assert.match(proc.output.stdout, /지금은 이 PC에서만 열립니다/);
    assert.equal(proc.output.stderr, '');
  }

  // 화면이 실제로 열린다.
  assert.match((await call(consoleBase, 'GET', '/')).text, /진행 화면/);
  assert.match((await call(app1, 'GET', '/')).text, /성적 관리 시스템/);
  assert.match((await call(app2, 'GET', '/neighbor')).text, /옆 사람 화면/);
  assert.match((await call(receiver, 'GET', '/')).text, /받는 쪽/);
  assert.deepEqual((await call(receiver, 'GET', '/api/ping')).json, { ok: true, service: 'receiver' });

  // 처음 상태
  const first = (await call(consoleBase, 'GET', '/api/state')).json;
  assert.equal(first.step.id, 'start');
  assert.equal(first.switch.on, false);
  assert.equal(first.receiver.port, receiverPort);
  assert.equal(first.receiver.reachable, true);
  assert.equal((await call(consoleBase, 'POST', '/api/receiver', { body: { action: 'ping' } })).json.ping.ok, true);

  // 1번 앱에서 담임이 저장·초안 → 따로 실행한 받는 쪽 프로그램에 실제로 도착한다.
  const teacher = await loginAs(app1, 'teacher');
  assert.equal((await call(app1, 'PUT', '/api/students/TEST-1009/ratings', { cookie: teacher, body: { ratings: { 수학: '잘함' } } })).status, 200);
  const draft = await call(app1, 'POST', '/api/students/TEST-1009/ai-draft', { cookie: teacher });
  assert.equal(draft.status, 200);
  assert.ok(draft.json.draft.includes('사전 작성된 모의 응답'));
  const held = await waitFor(async () => {
    const now = (await call(receiver, 'GET', '/api/received')).json;
    return now.sheet.length === 1 && now.ai.length === 1 ? now : null;
  }, 5000, '받는 쪽 프로그램에 도착하지 않았습니다.');
  assert.equal(held.sheet[0].payload.id, 'TEST-1009');
  assert.equal(held.sheet[0].payload.ratings.수학, '잘함');
  assert.equal(held.ai[0].payload.id, 'TEST-1009');
  // 진행 화면도 그것을 보여준다.
  await waitFor(async () => {
    const now = (await call(consoleBase, 'GET', '/api/state')).json;
    return now.receiver.sheetCount === 1 && now.receiver.aiCount === 1;
  }, 5000, '진행 화면에 도착한 것이 나타나지 않았습니다.');
  // 2번 앱은 같은 프로그램 안에 있지만 로그인 없이는 막혀 있다.
  assert.equal((await call(app1, 'GET', '/api/roster')).status, 200);
  assert.equal((await call(app2, 'GET', '/api/roster')).status, 401);

  // 둘 다 끝낸다: 아무것도 듣고 있지 않아야 한다.
  demoProc.child.kill();
  receiverProc.child.kill();
  await waitExit(demoProc, 10000, '시연 프로그램 끝내기');
  await waitExit(receiverProc, 10000, '받는 쪽 프로그램 끝내기');
  for (const port of [Number(consoleMatch[1]), ...appPorts, receiverPort]) {
    assert.notEqual(await tryConnect('127.0.0.1', port), 'open', `${port}번 포트가 아직 열려 있다`);
  }
});
