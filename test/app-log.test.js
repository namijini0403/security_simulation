// 성적 관리 앱: 접속 기록과 '옆 기기가 가져간 것'(명세 8.2), 구분되는 낱말이 없음(5.1, 11-7).

import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createStudents } from '../src/shared/data.js';
import { closeServer, listen } from '../src/shared/http.js';
import { createGradeApp } from '../src/app/server.js';
import { startApps, startReceiver, call, login, ALL_GOOD, NEIGHBOR } from './app-helpers.js';

const INITIAL = createStudents();
const ROSTER = INITIAL.map(({ id, name }) => ({ id, name }));

let apps;
let receiver;
let clock;

before(async () => {
  receiver = await startReceiver();
  clock = { value: Date.parse('2026-03-02T09:00:00.000Z') };
  apps = await startApps({ receiverBase: receiver.base, now: () => clock.value });
});

after(async () => {
  await apps.a.whenIdle();
  await apps.b.whenIdle();
  await apps.close();
  await receiver.close();
});

beforeEach(async () => {
  await apps.a.whenIdle();
  await apps.b.whenIdle();
  apps.a.reset();
  apps.b.reset();
});

const brief = (entry) => [entry.method, entry.path, entry.status, entry.loginId, entry.permissionChecked, entry.neighbor];

describe('접속 기록', () => {
  test('1번 앱: 요청마다 한 줄, 권한 확인은 언제나 "안 함"', async () => {
    const base = apps.urlA;
    await call(base, 'GET', '/');
    await call(base, 'GET', '/api/app');
    await call(base, 'GET', '/api/roster?x=1', { headers: NEIGHBOR });
    await call(base, 'GET', '/api/students/TEST-1001', { headers: NEIGHBOR });
    await call(base, 'POST', '/api/login', { body: { loginId: 'parent01', password: 'nope' } });
    const cookie = await login(base, 'parent01');
    await call(base, 'GET', '/api/me', { cookie });
    await call(base, 'GET', '/api/students/TEST-1002', { cookie, headers: NEIGHBOR });
    await call(base, 'GET', '/api/students', { cookie });
    await call(base, 'PUT', '/api/students/TEST-1001/ratings', { cookie, body: { ratings: ALL_GOOD } });
    await call(base, 'POST', '/api/students/TEST-1001/ai-draft', { cookie });
    await call(base, 'DELETE', '/api/students/TEST-1003', { cookie });
    await call(base, 'GET', '/api/students/TEST-1003', { cookie });
    await call(base, 'POST', '/api/logout', { cookie });
    await call(base, 'GET', '/api/me', { cookie });

    const log = apps.a.getAccessLog();
    assert.deepEqual(log.map(brief), [
      ['GET', '/', 404, null, false, false],
      ['GET', '/api/app', 200, null, false, false],
      ['GET', '/api/roster', 200, null, false, true],
      ['GET', '/api/students/TEST-1001', 401, null, false, true],
      ['POST', '/api/login', 401, null, false, false],
      ['POST', '/api/login', 200, 'parent01', false, false],
      ['GET', '/api/me', 200, 'parent01', false, false],
      ['GET', '/api/students/TEST-1002', 200, 'parent01', false, true],
      ['GET', '/api/students', 200, 'parent01', false, false],
      ['PUT', '/api/students/TEST-1001/ratings', 200, 'parent01', false, false],
      ['POST', '/api/students/TEST-1001/ai-draft', 200, 'parent01', false, false],
      ['DELETE', '/api/students/TEST-1003', 200, 'parent01', false, false],
      ['GET', '/api/students/TEST-1003', 404, 'parent01', false, false],
      ['POST', '/api/logout', 200, 'parent01', false, false],
      ['GET', '/api/me', 401, null, false, false],
    ]);

    for (const entry of log) {
      assert.equal(entry.app, '1번 앱');
      assert.equal(entry.time, '2026-03-02T09:00:00.000Z');
      assert.equal(entry.at, clock.value);
      assert.equal(entry.clientAddress, '127.0.0.1');
      assert.equal(entry.samePc, true);
      assert.equal(entry.local, true);
    }
    assert.deepEqual(log.map((entry) => entry.seq), [...log.map((entry) => entry.seq)].sort((x, y) => x - y));
    assert.equal(new Set(log.map((entry) => entry.seq)).size, log.length);

    // 나간 내용: 학생 조회 두 가지의 200과 명단의 200에만 붙는다.
    assert.deepEqual(log[2].roster, ROSTER);
    assert.equal(log[2].students, null);
    assert.equal(log[3].students, null);
    assert.deepEqual(log[7].students, [INITIAL[1]]);
    assert.equal(log[7].roster, null);
    assert.deepEqual(log[8].students, INITIAL);
    for (const index of [0, 1, 4, 5, 6, 9, 10, 11, 12, 13, 14]) {
      assert.equal(log[index].students, null, String(index));
      assert.equal(log[index].roster, null, String(index));
    }
    // 2번 앱에는 아무것도 적히지 않았다.
    assert.deepEqual(apps.b.getAccessLog(), []);
  });

  test('2번 앱: 로그인·로그아웃을 뺀 모든 요청이 "확인함"', async () => {
    const base = apps.urlB;
    await call(base, 'GET', '/neighbor');
    await call(base, 'GET', '/api/app');
    await call(base, 'GET', '/api/roster', { headers: NEIGHBOR });
    await call(base, 'POST', '/api/login', { body: { loginId: 'parent01', password: 'nope' } });
    const cookie = await login(base, 'parent01');
    await call(base, 'GET', '/api/me', { cookie });
    await call(base, 'GET', '/api/students/TEST-1001', { cookie, headers: NEIGHBOR });
    await call(base, 'GET', '/api/students/TEST-1002', { cookie, headers: NEIGHBOR });
    await call(base, 'GET', '/api/students', { cookie });
    await call(base, 'PUT', '/api/students/TEST-1001/ratings', { cookie, body: { ratings: ALL_GOOD } });
    await call(base, 'POST', '/api/logout', { cookie });
    await call(base, 'GET', '/api/nothing');

    const log = apps.b.getAccessLog();
    assert.deepEqual(log.map(brief), [
      ['GET', '/neighbor', 404, null, true, false],
      ['GET', '/api/app', 200, null, true, false],
      ['GET', '/api/roster', 401, null, true, true],
      ['POST', '/api/login', 401, null, false, false],
      ['POST', '/api/login', 200, 'parent01', false, false],
      ['GET', '/api/me', 200, 'parent01', true, false],
      ['GET', '/api/students/TEST-1001', 200, 'parent01', true, true],
      ['GET', '/api/students/TEST-1002', 403, 'parent01', true, true],
      ['GET', '/api/students', 403, 'parent01', true, false],
      ['PUT', '/api/students/TEST-1001/ratings', 403, 'parent01', true, false],
      ['POST', '/api/logout', 200, 'parent01', false, false],
      ['GET', '/api/nothing', 404, null, true, false],
    ]);
    assert.ok(log.every((entry) => entry.app === '2번 앱'));
    assert.deepEqual(log[6].students, [INITIAL[0]]);
    assert.ok(log.filter((entry, index) => index !== 6).every((entry) => entry.students === null && entry.roster === null));
  });

  test('기록은 그 순간의 사본이다(나중에 고쳐도 바뀌지 않고, 밖에서 고칠 수도 없다)', async () => {
    const base = apps.urlA;
    const cookie = await login(base, 'parent01');
    await call(base, 'GET', '/api/students/TEST-1001', { cookie, headers: NEIGHBOR });
    await call(base, 'PUT', '/api/students/TEST-1001/ratings', { cookie, body: { ratings: ALL_GOOD } });
    const log = apps.a.getAccessLog();
    assert.deepEqual(log[1].students, [INITIAL[0]]);
    assert.throws(() => { log[1].students[0].name = '바꿈'; });
    try { log.length = 0; } catch { /* 고정된 배열이어도 괜찮다 */ }
    assert.equal(apps.a.getAccessLog().length, 3);
    assert.deepEqual(apps.a.getNeighborSummary().students, [INITIAL[0]]);
  });

  test('다른 기기에서 온 요청은 그렇게 적힌다(스위치가 넘겨준 값 그대로)', async () => {
    const app = createGradeApp({ label: '1번 앱', checkPermission: false, cookieName: 'gsid_a', getReceiverBase: () => receiver.base });
    const server = http.createServer((req, res) => app.handler(req, res, { local: false, clientAddress: '192.168.0.77', samePc: false }));
    const port = await listen(server, 0);
    try {
      await call(`http://127.0.0.1:${port}`, 'GET', '/api/roster', { headers: NEIGHBOR });
      const [entry] = app.getAccessLog();
      assert.equal(entry.clientAddress, '192.168.0.77');
      assert.equal(entry.samePc, false);
      assert.equal(entry.local, false);
      assert.equal(entry.neighbor, true);
    } finally {
      await closeServer(server);
    }
  });

  test('sinceSeq로 새 줄만 받을 수 있고, 새 줄이 생기면 알려 준다', async () => {
    const events = [];
    const stop = apps.a.subscribe((event) => events.push(event));
    await call(apps.urlA, 'GET', '/api/roster');
    const first = apps.a.getAccessLog();
    await call(apps.urlA, 'GET', '/api/app');
    const newer = apps.a.getAccessLog({ sinceSeq: first[0].seq });
    assert.deepEqual(newer.map((entry) => entry.path), ['/api/app']);
    assert.deepEqual(events.map((event) => [event.type, event.entry.path]), [['access', '/api/roster'], ['access', '/api/app']]);
    stop();
    await call(apps.urlA, 'GET', '/api/app');
    assert.equal(events.length, 2);
  });
});

describe('옆 기기가 가져간 것', () => {
  test('표시가 붙은 요청만, 학생 조회 두 가지의 200만, 서로 다른 학생 수로 센다', async () => {
    const base = apps.urlA;
    const cookie = await login(base, 'parent01');
    const empty = apps.a.getNeighborSummary();
    assert.deepEqual(empty, { app: '1번 앱', studentCount: 0, students: [], rosterCount: 0, roster: [], rosterViews: 0 });

    // 표시 없는 요청(담임·학부모 화면, 공개 장면)은 세지 않는다.
    await call(base, 'GET', '/api/students/TEST-1005', { cookie });
    await call(base, 'GET', '/api/students', { cookie });
    await call(base, 'GET', '/api/roster', { cookie });
    assert.equal(apps.a.getNeighborSummary().studentCount, 0);
    assert.equal(apps.a.getNeighborSummary().rosterCount, 0);

    // 표시가 다른 값이면 세지 않는다.
    await call(base, 'GET', '/api/students/TEST-1005', { cookie, headers: { 'X-Demo-Screen': 'teacher' } });
    assert.equal(apps.a.getNeighborSummary().studentCount, 0);

    // 거절된 요청은 세지 않는다.
    await call(base, 'GET', '/api/students/TEST-1001', { headers: NEIGHBOR }); // 401
    await call(base, 'GET', '/api/students/TEST-9999', { cookie, headers: NEIGHBOR }); // 404
    assert.equal(apps.a.getNeighborSummary().studentCount, 0);

    // 한 명씩, 같은 학생을 여러 번 가져가도 1명.
    await call(base, 'GET', '/api/students/TEST-1002', { cookie, headers: NEIGHBOR });
    await call(base, 'GET', '/api/students/TEST-1002', { cookie, headers: NEIGHBOR });
    await call(base, 'GET', '/api/students/TEST-1001', { cookie, headers: NEIGHBOR });
    await call(base, 'GET', '/api/students/TEST-1002', { cookie, headers: { 'x-demo-screen': 'neighbor' } });
    let summary = apps.a.getNeighborSummary();
    assert.equal(summary.studentCount, 2);
    assert.deepEqual(summary.students, [INITIAL[1], INITIAL[0]]); // 처음 가져간 순서

    // 성적 고치기의 응답은 세지 않는다. AI 초안·삭제도.
    await call(base, 'PUT', '/api/students/TEST-1007/ratings', { cookie, headers: NEIGHBOR, body: { ratings: ALL_GOOD } });
    await call(base, 'POST', '/api/students/TEST-1008/ai-draft', { cookie, headers: NEIGHBOR });
    await call(base, 'DELETE', '/api/students/TEST-1020', { cookie, headers: NEIGHBOR });
    assert.equal(apps.a.getNeighborSummary().studentCount, 2);

    // 명단은 따로 센다.
    await call(base, 'GET', '/api/roster', { headers: NEIGHBOR });
    await call(base, 'GET', '/api/roster', { headers: NEIGHBOR });
    summary = apps.a.getNeighborSummary();
    assert.equal(summary.studentCount, 2);
    assert.equal(summary.rosterCount, 19);
    assert.equal(summary.rosterViews, 2);
    assert.deepEqual(summary.roster, ROSTER.slice(0, 19));

    // 반 전체 받기: 지금 있는 19명 전부. 이미 가져간 학생은 다시 세지 않는다.
    await call(base, 'GET', '/api/students', { cookie, headers: NEIGHBOR });
    summary = apps.a.getNeighborSummary();
    assert.equal(summary.studentCount, 19);
    assert.equal(new Set(summary.students.map((student) => student.id)).size, 19);
    // 보여줄 기록은 가장 최근에 가져간 내용이다(TEST-1007은 고친 뒤의 값).
    assert.deepEqual(summary.students.find((student) => student.id === 'TEST-1007').ratings, ALL_GOOD);
    assert.deepEqual(summary.students.find((student) => student.id === 'TEST-1002'), INITIAL[1]);
    for (const student of summary.students) {
      assert.deepEqual(Object.keys(student), ['id', 'name', 'className', 'ratings', 'comment', 'guardianName', 'guardianPhone']);
    }

    // 앱마다 따로 센다.
    assert.equal(apps.b.getNeighborSummary().studentCount, 0);
    assert.equal(apps.b.getNeighborSummary().app, '2번 앱');
  });

  test('반 전체 수집(한 명씩 20번): 1번 앱은 20명, 2번 앱은 자기 아이 1명', async () => {
    for (const [base, app, expected] of [[apps.urlA, apps.a, 20], [apps.urlB, apps.b, 1]]) {
      const cookie = await login(base, 'parent01');
      const statuses = [];
      for (const student of INITIAL) {
        statuses.push((await call(base, 'GET', `/api/students/${student.id}`, { cookie, headers: NEIGHBOR })).status);
      }
      assert.equal(statuses.filter((status) => status === 200).length, expected);
      const summary = app.getNeighborSummary();
      assert.equal(summary.studentCount, expected);
      assert.deepEqual(summary.students, INITIAL.slice(0, expected));
      assert.equal(summary.rosterCount, 0);
    }
  });

  test('수집 도중 지워진 번호는 404로 세고 계속한다', async () => {
    const cookie = await login(apps.urlA, 'parent01');
    await call(apps.urlA, 'DELETE', '/api/students/TEST-1004');
    const statuses = [];
    for (const student of INITIAL) {
      statuses.push((await call(apps.urlA, 'GET', `/api/students/${student.id}`, { cookie, headers: NEIGHBOR })).status);
    }
    assert.deepEqual(statuses, INITIAL.map((student) => (student.id === 'TEST-1004' ? 404 : 200)));
    assert.equal(apps.a.getNeighborSummary().studentCount, 19);
  });

  test('2번 앱에서 담임 화면이 아닌 옆 사람 화면은 명단을 받지 못한다', async () => {
    const cookie = await login(apps.urlB, 'parent01');
    await call(apps.urlB, 'GET', '/api/roster', { headers: NEIGHBOR });
    await call(apps.urlB, 'GET', '/api/roster', { cookie, headers: NEIGHBOR });
    await call(apps.urlB, 'GET', '/api/students', { cookie, headers: NEIGHBOR });
    const summary = apps.b.getNeighborSummary();
    assert.deepEqual([summary.studentCount, summary.rosterCount, summary.rosterViews], [0, 0, 0]);
  });

  test('기록이 길어져 오래된 줄이 밀려나도 인원 수는 유지된다', async () => {
    const small = await startApps({ receiverBase: receiver.base, maxLogEntries: 5 });
    try {
      const cookie = await login(small.urlA, 'parent01');
      for (const student of INITIAL.slice(0, 8)) {
        await call(small.urlA, 'GET', `/api/students/${student.id}`, { cookie, headers: NEIGHBOR });
      }
      await call(small.urlA, 'GET', '/api/roster', { headers: NEIGHBOR });
      for (let i = 0; i < 6; i += 1) await call(small.urlA, 'GET', '/api/app');
      const log = small.a.getAccessLog();
      assert.equal(log.length, 5);
      assert.ok(log.every((entry) => entry.path === '/api/app'));
      const summary = small.a.getNeighborSummary();
      assert.equal(summary.studentCount, 8);
      assert.deepEqual(summary.students, INITIAL.slice(0, 8));
      assert.equal(summary.rosterCount, 20);
    } finally {
      await small.close();
    }
  });
});

describe('옆 사람 화면 표시는 권한에 영향이 없다', () => {
  test('표시가 있든 없든 결과 번호가 같다(두 앱, 모든 요청, 모든 사람)', async () => {
    const requests = (id) => [
      ['GET', '/api/roster'],
      ['GET', `/api/students/${id}`],
      ['GET', '/api/students'],
      ['PUT', `/api/students/${id}/ratings`, { ratings: { 국어: '잘함' } }],
      ['POST', `/api/students/${id}/ai-draft`],
      ['GET', '/api/me'],
      ['GET', '/api/app'],
      ['GET', '/api/students/TEST-9999'],
      ['DELETE', `/api/students/${id}`],
    ];
    for (const base of [apps.urlA, apps.urlB]) {
      for (const who of [null, 'parent01', 'teacher']) {
        for (const target of ['TEST-1001', 'TEST-1002']) {
          const results = [];
          for (const headers of [undefined, NEIGHBOR]) {
            await apps.a.whenIdle();
            await apps.b.whenIdle();
            apps.a.reset();
            apps.b.reset();
            const cookie = who ? await login(base, who) : undefined;
            const statuses = [];
            for (const [method, url, body] of requests(target)) {
              statuses.push((await call(base, method, url, { cookie, headers, body })).status);
            }
            results.push(statuses);
          }
          assert.deepEqual(results[0], results[1], `${base} ${who} ${target}`);
        }
      }
    }
  });
});

describe('두 앱은 응답으로 구분할 수 없다', () => {
  // guardianName/guardianPhone은 명세가 정한 항목 이름이므로 뺀다.
  const TELLING = /unsafe|insecure|secur|vuln|guard(?!ian)|leak|weak|strict|protect|취약|안전|허술|막아|보안/i;

  async function collect(base) {
    const out = [];
    const record = async (label, method, url, options) => {
      const response = await call(base, method, url, options);
      out.push({ label, status: response.status, headers: response.headers, text: response.text, setCookies: response.setCookies });
      return response;
    };
    await record('roster-none', 'GET', '/api/roster');
    await record('one-none', 'GET', '/api/students/TEST-1001');
    await record('me-none', 'GET', '/api/me');
    await record('login-bad', 'POST', '/api/login', { body: { loginId: 'teacher', password: 'x' } });
    await record('app', 'GET', '/api/app');
    await record('missing', 'GET', '/api/none');
    await record('page', 'GET', '/');
    await record('page-teacher', 'GET', '/teacher');
    const parentLogin = await record('login-parent', 'POST', '/api/login', { body: { loginId: 'parent01', password: 'demo1234' } });
    const parent = parentLogin.cookie;
    await record('own', 'GET', '/api/students/TEST-1001', { cookie: parent });
    await record('other', 'GET', '/api/students/TEST-1002', { cookie: parent });
    await record('all-parent', 'GET', '/api/students', { cookie: parent });
    await record('put-parent', 'PUT', '/api/students/TEST-1001/ratings', { cookie: parent, body: { ratings: ALL_GOOD } });
    await record('logout', 'POST', '/api/logout', { cookie: parent });
    const teacherLogin = await record('login-teacher', 'POST', '/api/login', { body: { loginId: 'teacher', password: 'teacher1234' } });
    const teacher = teacherLogin.cookie;
    await record('t-me', 'GET', '/api/me', { cookie: teacher });
    await record('t-roster', 'GET', '/api/roster', { cookie: teacher });
    await record('t-put-bad', 'PUT', '/api/students/TEST-1003/ratings', { cookie: teacher, body: { ratings: { 체육: '잘함' } } });
    await record('t-put', 'PUT', '/api/students/TEST-1003/ratings', { cookie: teacher, body: { ratings: { 국어: '보통' } } });
    await record('t-draft', 'POST', '/api/students/TEST-1003/ai-draft', { cookie: teacher });
    await record('t-delete', 'DELETE', '/api/students/TEST-1003', { cookie: teacher });
    await record('t-gone', 'GET', '/api/students/TEST-1003', { cookie: teacher });
    return out;
  }

  test('응답 본문·머리글·쿠키에 구분되는 낱말이 없고, 담임 흐름의 응답은 완전히 같다', async () => {
    const fromA = await collect(apps.urlA);
    const fromB = await collect(apps.urlB);
    for (const [list, name] of [[fromA, 'a'], [fromB, 'b']]) {
      for (const item of list) {
        const everything = `${item.text}\n${JSON.stringify(item.headers)}\n${item.setCookies.join('\n')}`;
        assert.doesNotMatch(everything, TELLING, `${name} ${item.label}`);
        assert.doesNotMatch(everything, /permission|checked|권한 확인/i, `${name} ${item.label}`);
      }
    }
    const normalize = (item) => ({
      label: item.label,
      status: item.status,
      text: item.text.replace(/[12]번 앱/g, 'N번 앱'),
      headerNames: Object.keys(item.headers).filter((key) => !['date', 'content-length'].includes(key)).sort(),
      contentType: item.headers['content-type'],
      cookies: item.setCookies.map((line) => line.replace(/^gsid_[ab]=[^;]*/, 'gsid_x=…')),
    });
    const sameInBoth = ['one-none', 'me-none', 'login-bad', 'app', 'missing', 'page', 'page-teacher', 'login-parent', 'own', 'logout',
      'login-teacher', 't-me', 't-roster', 't-put-bad', 't-put', 't-draft', 't-delete', 't-gone'];
    for (const label of sameInBoth) {
      assert.deepEqual(
        normalize(fromA.find((item) => item.label === label)),
        normalize(fromB.find((item) => item.label === label)),
        label,
      );
    }
    // 쿠키 이름은 서로 다르지만 어느 쪽인지 알려 주지 않는다.
    assert.match(fromA.find((item) => item.label === 'login-teacher').setCookies[0], /^gsid_a=/);
    assert.match(fromB.find((item) => item.label === 'login-teacher').setCookies[0], /^gsid_b=/);
  });
});
