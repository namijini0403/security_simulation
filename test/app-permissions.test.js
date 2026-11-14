// 성적 관리 앱: 요청·응답(명세 5.2)과 권한 표(5.3), 로그인 상태(4.3), 경계 상황(12).
// 실제 서버를 띄워 실제 요청으로 확인한다.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStudents } from '../src/shared/data.js';
import { createGradeApp } from '../src/app/server.js';
import { startApps, startReceiver, call, login, ALL_GOOD, SUBJECTS } from './app-helpers.js';

const INITIAL = createStudents();
const OWN = 'TEST-1001';
const OTHER = 'TEST-1002';

let apps;
let receiver;
let publicDir;

before(async () => {
  receiver = await startReceiver();
  publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grade-app-'));
  await fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>첫 화면</title>');
  await fs.writeFile(path.join(publicDir, 'neighbor.html'), '<!doctype html><title>옆 사람 화면</title>');
  await fs.writeFile(path.join(publicDir, 'app.js'), '// 화면 코드');
  apps = await startApps({ receiverBase: receiver.base, publicDir });
});

after(async () => {
  await apps.a.whenIdle();
  await apps.b.whenIdle();
  await apps.close();
  await receiver.close();
  await fs.rm(publicDir, { recursive: true, force: true });
});

async function fresh() {
  await apps.a.whenIdle();
  await apps.b.whenIdle();
  apps.a.reset();
  apps.b.reset();
}

// --------------------------------------------------------------------------- 5.3 표의 모든 칸

const REQUESTS = {
  roster: (id) => ['GET', '/api/roster'],
  getOne: (id) => ['GET', `/api/students/${id}`],
  list: (id) => ['GET', '/api/students'],
  putRatings: (id) => ['PUT', `/api/students/${id}/ratings`, { ratings: { 국어: '잘함' } }],
  aiDraft: (id) => ['POST', `/api/students/${id}/ai-draft`],
  remove: (id) => ['DELETE', `/api/students/${id}`],
};

// 사람: none(로그인 없음) / parentOwn(parent01이 자기 아이 대상) / parentOther(parent01이 남의 아이 대상) / teacher
const ACTORS = ['none', 'parentOwn', 'parentOther', 'teacher'];

const EXPECTED = {
  a: {
    roster: [200, 200, 200, 200],
    getOne: [401, 200, 200, 200],
    list: [200, 200, 200, 200],
    putRatings: [200, 200, 200, 200],
    aiDraft: [200, 200, 200, 200],
    remove: [200, 200, 200, 200],
  },
  b: {
    roster: [401, 403, 403, 200],
    getOne: [401, 200, 403, 200],
    list: [401, 403, 403, 200],
    putRatings: [401, 403, 403, 200],
    aiDraft: [401, 403, 403, 200],
    remove: [401, 403, 403, 200],
  },
};

describe('권한 표(5.3)의 모든 칸', () => {
  for (const which of ['a', 'b']) {
    for (const [name, build] of Object.entries(REQUESTS)) {
      ACTORS.forEach((actor, index) => {
        const expected = EXPECTED[which][name][index];
        test(`${which === 'a' ? '1번 앱' : '2번 앱'} · ${name} · ${actor} → ${expected}`, async () => {
          await fresh();
          const base = which === 'a' ? apps.urlA : apps.urlB;
          let cookie;
          if (actor === 'teacher') cookie = await login(base, 'teacher');
          else if (actor !== 'none') cookie = await login(base, 'parent01');
          const target = actor === 'parentOther' ? OTHER : OWN;
          const [method, url, body] = build(target);
          const response = await call(base, method, url, { cookie, body });
          assert.equal(response.status, expected);
          if (expected !== 200) {
            assert.equal(typeof response.json.error, 'string');
            assert.match(response.json.error, /[가-힣]/);
            assert.deepEqual(Object.keys(response.json), ['error']);
          }
        });
      });
    }
  }
});

// --------------------------------------------------------------------------- 성공 응답의 모양

describe('성공 응답의 모양(5.2)', () => {
  for (const which of ['a', 'b']) {
    test(`${which}: 담임으로 아홉 요청`, async () => {
      await fresh();
      const base = which === 'a' ? apps.urlA : apps.urlB;

      const bad = await call(base, 'POST', '/api/login', { body: { loginId: 'teacher', password: 'wrong' } });
      assert.equal(bad.status, 401);
      assert.match(bad.json.error, /[가-힣]/);
      assert.deepEqual(bad.setCookies, []);

      const me0 = await call(base, 'GET', '/api/me');
      assert.equal(me0.status, 401);

      const loggedIn = await call(base, 'POST', '/api/login', { body: { loginId: 'teacher', password: 'teacher1234' } });
      assert.equal(loggedIn.status, 200);
      assert.deepEqual(loggedIn.json, { role: 'teacher', loginId: 'teacher', studentId: null });
      const cookie = loggedIn.cookie;
      assert.match(cookie, which === 'a' ? /^gsid_a=[A-Za-z0-9_-]{32,}$/ : /^gsid_b=[A-Za-z0-9_-]{32,}$/);
      assert.match(loggedIn.setCookies[0], /HttpOnly/);

      const me = await call(base, 'GET', '/api/me', { cookie });
      assert.equal(me.status, 200);
      assert.deepEqual(me.json, { role: 'teacher', loginId: 'teacher', studentId: null });

      const roster = await call(base, 'GET', '/api/roster', { cookie });
      assert.deepEqual(roster.json, INITIAL.map(({ id, name }) => ({ id, name })));

      const one = await call(base, 'GET', '/api/students/TEST-1007', { cookie });
      assert.deepEqual(one.json, INITIAL[6]);

      const all = await call(base, 'GET', '/api/students', { cookie });
      assert.deepEqual(all.json, INITIAL);

      const saved = await call(base, 'PUT', '/api/students/TEST-1007/ratings', { cookie, body: { ratings: { 과학: '잘함' } } });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.json, { ...INITIAL[6], ratings: { ...INITIAL[6].ratings, 과학: '잘함' } });

      const draft = await call(base, 'POST', '/api/students/TEST-1007/ai-draft', { cookie });
      assert.equal(draft.status, 200);
      assert.deepEqual(draft.json, { draft: receiver.state.draft });

      const removed = await call(base, 'DELETE', '/api/students/TEST-1007', { cookie });
      assert.equal(removed.status, 200);

      const out = await call(base, 'POST', '/api/logout', { cookie });
      assert.equal(out.status, 200);
      assert.equal((await call(base, 'GET', '/api/me', { cookie })).status, 401);

      const app = await call(base, 'GET', '/api/app');
      assert.equal(app.status, 200);
      assert.deepEqual(app.json, { label: which === 'a' ? '1번 앱' : '2번 앱' });
    });

    test(`${which}: 학부모 로그인 응답과 /api/me`, async () => {
      await fresh();
      const base = which === 'a' ? apps.urlA : apps.urlB;
      const response = await call(base, 'POST', '/api/login', { body: { loginId: 'parent07', password: 'demo1234' } });
      assert.deepEqual(response.json, { role: 'parent', loginId: 'parent07', studentId: 'TEST-1007' });
      const me = await call(base, 'GET', '/api/me', { cookie: response.cookie });
      assert.deepEqual(me.json, { role: 'parent', loginId: 'parent07', studentId: 'TEST-1007' });
    });

    test(`${which}: 로그인 본문이 이상하면 로그인되지 않는다`, async () => {
      await fresh();
      const base = which === 'a' ? apps.urlA : apps.urlB;
      for (const body of [{}, { loginId: 'teacher' }, { loginId: ['teacher'], password: 'teacher1234' }, [], 'x', null]) {
        const response = await call(base, 'POST', '/api/login', { body });
        assert.equal(response.status, 401, JSON.stringify(body));
        assert.deepEqual(response.setCookies, []);
      }
      const broken = await call(base, 'POST', '/api/login', { rawBody: '{"loginId":' });
      assert.equal(broken.status, 400);
      const huge = await call(base, 'POST', '/api/login', { body: { loginId: 'teacher', password: 'x'.repeat(20000) } });
      assert.ok([400, 413].includes(huge.status));
    });
  }
});

// --------------------------------------------------------------------------- 404·우선순위·400

describe('404, 401/403이 먼저, 400', () => {
  const ghostPaths = (id) => [
    ['GET', `/api/students/${id}`],
    ['PUT', `/api/students/${id}/ratings`, { ratings: { 국어: '잘함' } }],
    ['POST', `/api/students/${id}/ai-draft`],
    ['DELETE', `/api/students/${id}`],
  ];

  test('1번 앱: 로그인 없이 없는 번호 조회는 401, 로그인하면 404', async () => {
    await fresh();
    assert.equal((await call(apps.urlA, 'GET', '/api/students/TEST-9999')).status, 401);
    const cookie = await login(apps.urlA, 'parent01');
    for (const id of ['TEST-9999', 'TEST-1021', 'TEST-1000', 'x', '%E0%A4%A', '__proto__', 'constructor']) {
      const response = await call(apps.urlA, 'GET', `/api/students/${id}`, { cookie });
      assert.equal(response.status, 404, id);
      assert.match(response.json.error, /[가-힣]/);
    }
  });

  test('1번 앱: 누구나 되는 요청은 없는 번호에 404', async () => {
    await fresh();
    for (const [method, url, body] of ghostPaths('TEST-9999').slice(1)) {
      assert.equal((await call(apps.urlA, method, url, { body })).status, 404, url);
    }
  });

  test('2번 앱: 없는 번호여도 401/403이 먼저, 담임은 404', async () => {
    await fresh();
    const parent = await login(apps.urlB, 'parent01');
    const teacher = await login(apps.urlB, 'teacher');
    for (const [method, url, body] of ghostPaths('TEST-9999')) {
      assert.equal((await call(apps.urlB, method, url, { body })).status, 401, url);
      assert.equal((await call(apps.urlB, method, url, { body, cookie: parent })).status, 403, url);
      assert.equal((await call(apps.urlB, method, url, { body, cookie: teacher })).status, 404, url);
    }
  });

  test('2번 앱: 자기 아이가 지워졌으면 학부모에게 404, 남의 아이는 여전히 403', async () => {
    await fresh();
    const teacher = await login(apps.urlB, 'teacher');
    const parent = await login(apps.urlB, 'parent01');
    assert.equal((await call(apps.urlB, 'DELETE', `/api/students/${OWN}`, { cookie: teacher })).status, 200);
    assert.equal((await call(apps.urlB, 'DELETE', `/api/students/${OTHER}`, { cookie: teacher })).status, 200);
    assert.equal((await call(apps.urlB, 'GET', `/api/students/${OWN}`, { cookie: parent })).status, 404);
    assert.equal((await call(apps.urlB, 'GET', `/api/students/${OTHER}`, { cookie: parent })).status, 403);
  });

  for (const which of ['a', 'b']) {
    test(`${which}: 지운 학생은 404, 다시 지워도 404, 명단에서도 빠진다`, async () => {
      await fresh();
      const base = which === 'a' ? apps.urlA : apps.urlB;
      const cookie = await login(base, 'teacher');
      assert.equal((await call(base, 'DELETE', '/api/students/TEST-1005', { cookie })).status, 200);
      assert.equal((await call(base, 'DELETE', '/api/students/TEST-1005', { cookie })).status, 404);
      for (const [method, url, body] of ghostPaths('TEST-1005')) {
        assert.equal((await call(base, method, url, { body, cookie })).status, 404, url);
      }
      const roster = await call(base, 'GET', '/api/roster', { cookie });
      assert.equal(roster.json.length, 19);
      assert.ok(!roster.json.some((entry) => entry.id === 'TEST-1005'));
      const all = await call(base, 'GET', '/api/students', { cookie });
      assert.equal(all.json.length, 19);
    });

    test(`${which}: 평가 값이 올바르지 않으면 400이고 아무것도 바뀌지 않는다`, async () => {
      await fresh();
      const base = which === 'a' ? apps.urlA : apps.urlB;
      const cookie = await login(base, 'teacher');
      const badBodies = [
        { ratings: { 체육: '잘함' } },
        { ratings: { 국어: '최고' } },
        { ratings: { 국어: '잘함', 수학: '잘함', 미술: '보통' } }, // 올바른 것과 섞여 있어도 전부 거절
        { ratings: { 국어: '잘함', 수학: 5 } },
        { ratings: { 국어: null } },
        { ratings: { __proto__: '잘함' } },
        { ratings: { toString: '잘함' } },
        { ratings: {} },
        { ratings: ['잘함'] },
        { ratings: '잘함' },
        { ratings: null },
        {},
        [],
        'x',
      ];
      for (const body of badBodies) {
        const response = await call(base, 'PUT', `/api/students/${OWN}/ratings`, { cookie, rawBody: JSON.stringify(body) });
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.match(response.json.error, /[가-힣]/);
      }
      const raw = await call(base, 'PUT', `/api/students/${OWN}/ratings`, { cookie, rawBody: '{"ratings":{"__proto__":"잘함"}}' });
      assert.equal(raw.status, 400);
      const broken = await call(base, 'PUT', `/api/students/${OWN}/ratings`, { cookie, rawBody: '{"ratings":' });
      assert.equal(broken.status, 400);
      const huge = await call(base, 'PUT', `/api/students/${OWN}/ratings`, {
        cookie,
        body: { ratings: { 국어: '잘함' }, filler: 'x'.repeat(20000) },
      });
      assert.ok([400, 413].includes(huge.status));

      const after = await call(base, 'GET', `/api/students/${OWN}`, { cookie });
      assert.deepEqual(after.json, INITIAL[0]);
      await (which === 'a' ? apps.a : apps.b).whenIdle();
    });

    test(`${which}: 400보다 404가 먼저, 일부 과목만 보내도 된다`, async () => {
      await fresh();
      const base = which === 'a' ? apps.urlA : apps.urlB;
      const cookie = await login(base, 'teacher');
      const ghost = await call(base, 'PUT', '/api/students/TEST-9999/ratings', { cookie, body: { ratings: { 체육: '잘함' } } });
      assert.equal(ghost.status, 404);

      const partial = await call(base, 'PUT', `/api/students/${OWN}/ratings`, { cookie, body: { ratings: { 수학: '잘함', 영어: '보통' } } });
      assert.equal(partial.status, 200);
      assert.deepEqual(partial.json.ratings, { ...INITIAL[0].ratings, 수학: '잘함', 영어: '보통' });
      assert.deepEqual(Object.keys(partial.json.ratings), SUBJECTS);
      const after = await call(base, 'GET', `/api/students/${OWN}`, { cookie });
      assert.deepEqual(after.json, partial.json);
    });
  }

  test('2번 앱: 권한 없는 사람이 잘못된 값을 보내면 400이 아니라 401/403', async () => {
    await fresh();
    const parent = await login(apps.urlB, 'parent01');
    const body = { ratings: { 체육: '잘함' } };
    assert.equal((await call(apps.urlB, 'PUT', `/api/students/${OWN}/ratings`, { body })).status, 401);
    assert.equal((await call(apps.urlB, 'PUT', `/api/students/${OWN}/ratings`, { body, cookie: parent })).status, 403);
  });
});

// --------------------------------------------------------------------------- 실제로 바뀌는가

describe('학부모의 성적 고치기', () => {
  test('1번 앱에서는 실제로 바뀐다(담임 화면에서도 보인다)', async () => {
    await fresh();
    const parent = await login(apps.urlA, 'parent01');
    const response = await call(apps.urlA, 'PUT', `/api/students/${OWN}/ratings`, { cookie: parent, body: { ratings: ALL_GOOD } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.ratings, ALL_GOOD);
    const teacher = await login(apps.urlA, 'teacher');
    const seen = await call(apps.urlA, 'GET', `/api/students/${OWN}`, { cookie: teacher });
    assert.deepEqual(seen.json.ratings, ALL_GOOD);
    // 다른 앱의 사본은 그대로다.
    const teacherB = await login(apps.urlB, 'teacher');
    assert.deepEqual((await call(apps.urlB, 'GET', `/api/students/${OWN}`, { cookie: teacherB })).json, INITIAL[0]);
  });

  test('1번 앱에서는 로그인 없이도 바뀌고 지워진다', async () => {
    await fresh();
    assert.equal((await call(apps.urlA, 'PUT', `/api/students/${OTHER}/ratings`, { body: { ratings: ALL_GOOD } })).status, 200);
    assert.equal((await call(apps.urlA, 'DELETE', '/api/students/TEST-1003')).status, 200);
    const all = await call(apps.urlA, 'GET', '/api/students');
    assert.equal(all.json.length, 19);
    assert.deepEqual(all.json.find((student) => student.id === OTHER).ratings, ALL_GOOD);
  });

  test('2번 앱에서는 바뀌지 않는다', async () => {
    await fresh();
    const parent = await login(apps.urlB, 'parent01');
    assert.equal((await call(apps.urlB, 'PUT', `/api/students/${OWN}/ratings`, { cookie: parent, body: { ratings: ALL_GOOD } })).status, 403);
    assert.equal((await call(apps.urlB, 'DELETE', `/api/students/${OWN}`, { cookie: parent })).status, 403);
    const teacher = await login(apps.urlB, 'teacher');
    assert.deepEqual((await call(apps.urlB, 'GET', '/api/students', { cookie: teacher })).json, INITIAL);
  });
});

// --------------------------------------------------------------------------- 로그인 상태

describe('로그인 상태(4.3)', () => {
  test('한 앱의 로그인은 다른 앱에 통하지 않는다(쿠키를 그대로 보내도)', async () => {
    await fresh();
    const teacherA = await login(apps.urlA, 'teacher');
    const value = teacherA.split('=')[1];
    // 브라우저는 같은 PC의 다른 포트에도 쿠키를 보낸다.
    for (const cookie of [teacherA, `gsid_b=${value}`, `${teacherA}; gsid_b=${value}`]) {
      assert.equal((await call(apps.urlB, 'GET', '/api/me', { cookie })).status, 401);
      assert.equal((await call(apps.urlB, 'GET', '/api/roster', { cookie })).status, 401);
      assert.equal((await call(apps.urlB, 'GET', `/api/students/${OWN}`, { cookie })).status, 401);
    }
    const teacherB = await login(apps.urlB, 'teacher');
    const valueB = teacherB.split('=')[1];
    for (const cookie of [teacherB, `gsid_a=${valueB}`]) {
      assert.equal((await call(apps.urlA, 'GET', '/api/me', { cookie })).status, 401);
      assert.equal((await call(apps.urlA, 'GET', `/api/students/${OWN}`, { cookie })).status, 401);
    }
    // 두 쿠키를 함께 보내면 각 앱은 자기 것만 본다.
    const both = `${teacherA}; ${teacherB}`;
    assert.equal((await call(apps.urlA, 'GET', '/api/me', { cookie: both })).json.loginId, 'teacher');
    assert.equal((await call(apps.urlB, 'GET', '/api/me', { cookie: both })).json.loginId, 'teacher');
  });

  test('두 앱의 쿠키 이름이 다르고 값은 추측할 수 없다', async () => {
    await fresh();
    const one = await login(apps.urlA, 'parent01');
    const two = await login(apps.urlA, 'parent01');
    const other = await login(apps.urlB, 'parent01');
    assert.notEqual(one.split('=')[0], other.split('=')[0]);
    assert.notEqual(one, two);
    assert.ok(one.split('=')[1].length >= 32);
    // 꾸며 낸 값은 통하지 않는다.
    for (const forged of ['gsid_b=teacher', 'gsid_b=', 'gsid_b=undefined', 'gsid_b=__proto__', `gsid_b=${'A'.repeat(43)}`]) {
      assert.equal((await call(apps.urlB, 'GET', '/api/me', { cookie: forged })).status, 401, forged);
      assert.equal((await call(apps.urlB, 'GET', '/api/roster', { cookie: forged })).status, 401, forged);
      assert.equal((await call(apps.urlA, 'GET', `/api/students/${OWN}`, { cookie: forged.replace('gsid_b', 'gsid_a') })).status, 401, forged);
    }
  });

  test('로그아웃하면 그 로그인 상태는 무효다', async () => {
    await fresh();
    for (const [base, name] of [[apps.urlA, 'gsid_a'], [apps.urlB, 'gsid_b']]) {
      const cookie = await login(base, 'teacher');
      const second = await login(base, 'teacher');
      const out = await call(base, 'POST', '/api/logout', { cookie });
      assert.equal(out.status, 200);
      assert.ok(out.setCookies.some((line) => line.startsWith(`${name}=;`) && /Max-Age=0/.test(line)));
      assert.equal((await call(base, 'GET', '/api/me', { cookie })).status, 401);
      assert.equal((await call(base, 'GET', `/api/students/${OWN}`, { cookie })).status, 401);
      // 다른 브라우저의 로그인은 그대로다.
      assert.equal((await call(base, 'GET', '/api/me', { cookie: second })).status, 200);
      // 로그인 없이 로그아웃해도 200.
      assert.equal((await call(base, 'POST', '/api/logout')).status, 200);
    }
  });

  test('2번 앱: 역할·학생을 꾸며 보내도 결과가 바뀌지 않는다', async () => {
    await fresh();
    const parent = await login(apps.urlB, 'parent01');
    const forgedHeaders = {
      'X-Role': 'teacher',
      Role: 'teacher',
      'X-User-Role': 'teacher',
      'X-Login-Id': 'teacher',
      'X-Student-Id': OTHER,
      Authorization: 'Bearer teacher',
      'X-Demo-Screen': 'neighbor',
    };
    const query = `?role=teacher&loginId=teacher&studentId=${OTHER}&admin=1`;
    const extraCookies = `; role=teacher; loginId=teacher; studentId=${OTHER}; gsid_a=teacher`;
    const forgedBody = { role: 'teacher', loginId: 'teacher', studentId: OTHER, ratings: ALL_GOOD };

    const attempts = [
      ['GET', '/api/roster', 403, 401],
      ['GET', '/api/students', 403, 401],
      ['GET', `/api/students/${OTHER}`, 403, 401],
      ['PUT', `/api/students/${OWN}/ratings`, 403, 401],
      ['PUT', `/api/students/${OTHER}/ratings`, 403, 401],
      ['POST', `/api/students/${OWN}/ai-draft`, 403, 401],
      ['DELETE', `/api/students/${OTHER}`, 403, 401],
    ];
    for (const [method, url, asParent, asNobody] of attempts) {
      const body = method === 'GET' || method === 'DELETE' ? undefined : forgedBody;
      const withLogin = await call(apps.urlB, method, url + query, { cookie: parent + extraCookies, headers: forgedHeaders, body });
      assert.equal(withLogin.status, asParent, `${method} ${url}`);
      const withoutLogin = await call(apps.urlB, method, url + query, { cookie: extraCookies.slice(2), headers: forgedHeaders, body });
      assert.equal(withoutLogin.status, asNobody, `${method} ${url}`);
    }
    // 자기 아이는 그대로 볼 수 있고, /api/me도 서버가 기억한 값이다.
    const own = await call(apps.urlB, 'GET', `/api/students/${OWN}${query}`, { cookie: parent + extraCookies, headers: forgedHeaders });
    assert.equal(own.status, 200);
    assert.deepEqual(own.json, INITIAL[0]);
    const me = await call(apps.urlB, 'GET', `/api/me${query}`, { cookie: parent + extraCookies, headers: forgedHeaders });
    assert.deepEqual(me.json, { role: 'parent', loginId: 'parent01', studentId: OWN });
    // 로그인할 때 역할을 꾸며 보내도 계정대로다.
    const sneaky = await call(apps.urlB, 'POST', '/api/login', {
      body: { loginId: 'parent01', password: 'demo1234', role: 'teacher', studentId: OTHER },
    });
    assert.deepEqual(sneaky.json, { role: 'parent', loginId: 'parent01', studentId: OWN });
    assert.equal((await call(apps.urlB, 'GET', `/api/students/${OTHER}`, { cookie: sneaky.cookie })).status, 403);
    // 아무것도 바뀌지 않았다.
    const teacher = await login(apps.urlB, 'teacher');
    assert.deepEqual((await call(apps.urlB, 'GET', '/api/students', { cookie: teacher })).json, INITIAL);
  });
});

// --------------------------------------------------------------------------- 초기화

describe('초기화', () => {
  for (const which of ['a', 'b']) {
    test(`${which}: 학생 20명 복구, 로그인 무효, 기록 비움`, async () => {
      await fresh();
      const base = which === 'a' ? apps.urlA : apps.urlB;
      const app = which === 'a' ? apps.a : apps.b;
      const teacher = await login(base, 'teacher');
      const parent = await login(base, 'parent01');
      await call(base, 'PUT', `/api/students/${OWN}/ratings`, { cookie: teacher, body: { ratings: ALL_GOOD } });
      await call(base, 'DELETE', `/api/students/${OTHER}`, { cookie: teacher });
      await call(base, 'GET', '/api/roster', { cookie: teacher, headers: { 'X-Demo-Screen': 'neighbor' } });
      await call(base, 'GET', `/api/students/${OWN}`, { cookie: teacher, headers: { 'X-Demo-Screen': 'neighbor' } });
      await app.whenIdle();
      assert.ok(app.getAccessLog().length > 0);
      assert.ok(app.getTransferLog().length > 0);
      assert.equal(app.getNeighborSummary().studentCount, 1);

      app.reset();

      assert.deepEqual(app.getAccessLog(), []);
      assert.deepEqual(app.getTransferLog(), []);
      const summary = app.getNeighborSummary();
      assert.equal(summary.studentCount, 0);
      assert.equal(summary.rosterCount, 0);
      assert.deepEqual(summary.students, []);
      // 무효가 된 브라우저는 로그인 안 한 것으로 다룬다.
      assert.equal((await call(base, 'GET', '/api/me', { cookie: teacher })).status, 401);
      assert.equal((await call(base, 'GET', '/api/me', { cookie: parent })).status, 401);
      assert.equal((await call(base, 'GET', `/api/students/${OWN}`, { cookie: parent })).status, 401);
      const again = await login(base, 'teacher');
      assert.deepEqual((await call(base, 'GET', '/api/students', { cookie: again })).json, INITIAL);
    });
  }

  test('한 앱을 초기화해도 다른 앱은 그대로다', async () => {
    await fresh();
    const teacherB = await login(apps.urlB, 'teacher');
    await call(apps.urlB, 'DELETE', `/api/students/${OTHER}`, { cookie: teacherB });
    apps.a.reset();
    assert.equal((await call(apps.urlB, 'GET', '/api/me', { cookie: teacherB })).status, 200);
    assert.equal((await call(apps.urlB, 'GET', '/api/students', { cookie: teacherB })).json.length, 19);
  });
});

// --------------------------------------------------------------------------- 화면 파일과 없는 경로

describe('화면 파일과 없는 경로', () => {
  for (const which of ['a', 'b']) {
    test(`${which}: / 와 /neighbor 는 로그인 없이 열린다`, async () => {
      const base = which === 'a' ? apps.urlA : apps.urlB;
      const index = await call(base, 'GET', '/');
      assert.equal(index.status, 200);
      assert.match(index.headers['content-type'], /text\/html/);
      assert.match(index.text, /첫 화면/);
      const neighbor = await call(base, 'GET', '/neighbor');
      assert.equal(neighbor.status, 200);
      assert.match(neighbor.text, /옆 사람 화면/);
      const script = await call(base, 'GET', '/app.js');
      assert.equal(script.status, 200);
      assert.match(script.headers['content-type'], /javascript/);
    });

    test(`${which}: 없는 경로·맞지 않는 방식은 한국어 404`, async () => {
      const base = which === 'a' ? apps.urlA : apps.urlB;
      const cookie = await login(base, 'teacher');
      const cases = [
        ['GET', '/nothing.html'],
        ['GET', '/api/nothing'],
        ['GET', '/api/students/TEST-1001/ratings'],
        ['GET', '/api/students/TEST-1001/ai-draft'],
        ['GET', '/api/students/TEST-1001/extra/more'],
        ['POST', '/api/roster'],
        ['GET', '/api/login'],
        ['POST', '/'],
        ['GET', '/..%2f..%2fpackage.json'],
        ['GET', '/%2e%2e/%2e%2e/package.json'],
        ['GET', '/api'],
      ];
      for (const [method, url] of cases) {
        const response = await call(base, method, url, { cookie });
        assert.equal(response.status, 404, `${method} ${url}`);
        assert.match(response.json.error, /[가-힣]/);
      }
    });
  }

  test('화면 폴더가 없어도 404로 답하고 요청은 계속 처리한다', async () => {
    const missing = await startApps({ publicDir: path.join(publicDir, 'no-such-folder') });
    try {
      for (const base of [missing.urlA, missing.urlB]) {
        for (const url of ['/', '/neighbor', '/app.js']) {
          const response = await call(base, 'GET', url);
          assert.equal(response.status, 404);
          assert.match(response.json.error, /[가-힣]/);
        }
        assert.equal((await call(base, 'GET', '/api/app')).status, 200);
      }
    } finally {
      await missing.close();
    }
  });
});

// --------------------------------------------------------------------------- 만드는 함수

describe('createGradeApp 설정', () => {
  const good = { label: '1번 앱', checkPermission: false, cookieName: 'gsid_a', getReceiverBase: () => 'http://127.0.0.1:4180' };

  test('꼭 필요한 값이 빠지면 만들지 않는다', () => {
    assert.throws(() => createGradeApp({ ...good, label: '' }));
    assert.throws(() => createGradeApp({ ...good, checkPermission: undefined }));
    assert.throws(() => createGradeApp({ ...good, checkPermission: 'yes' }));
    assert.throws(() => createGradeApp({ ...good, cookieName: 'bad name;' }));
    assert.throws(() => createGradeApp({ ...good, cookieName: undefined }));
    assert.throws(() => createGradeApp({ ...good, getReceiverBase: 'http://127.0.0.1:4180' }));
    const app = createGradeApp(good);
    assert.equal(app.label, '1번 앱');
    assert.equal(typeof app.handler, 'function');
    // 화면 폴더의 기본값은 src/app/public 이다.
    assert.equal(path.resolve(app.publicDir), path.resolve(import.meta.dirname, '..', 'src', 'app', 'public'));
  });
});
