// 성적 관리 앱: 다른 곳으로 보내기(명세 5.4). 받는 쪽을 대신하는 임시 서버로 실제 전송을 확인한다.

import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStudents } from '../src/shared/data.js';
import { startApps, startReceiver, closedPort, call, login, ALL_GOOD } from './app-helpers.js';

const INITIAL = createStudents();

let apps;
let receiver;

before(async () => {
  receiver = await startReceiver();
  apps = await startApps({ receiverBase: receiver.base, forwardTimeoutMs: 400 });
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
  receiver.state.mode = 'ok';
  receiver.state.requests.length = 0;
  apps.receiver.base = receiver.base;
});

const pick = (which) => (which === 'a'
  ? { base: apps.urlA, app: apps.a, label: '1번 앱' }
  : { base: apps.urlB, app: apps.b, label: '2번 앱' });

describe('받는 쪽으로 보내기 (두 앱 동일)', () => {
  const seen = {};

  for (const which of ['a', 'b']) {
    test(`${which}: 성적 저장 → 온라인 표에 전체 기록, AI 초안 → 네 항목만`, async () => {
      const { base, app, label } = pick(which);
      const cookie = await login(base, 'teacher');

      const saved = await call(base, 'PUT', '/api/students/TEST-1004/ratings', { cookie, body: { ratings: { 사회: '잘함' } } });
      assert.equal(saved.status, 200);
      await app.whenIdle();

      const expectedRecord = { ...INITIAL[3], ratings: { ...INITIAL[3].ratings, 사회: '잘함' } };
      assert.equal(receiver.state.requests.length, 1);
      const sheet = receiver.state.requests[0];
      assert.equal(sheet.method, 'POST');
      assert.equal(sheet.path, '/sheet/rows');
      assert.match(sheet.contentType, /^application\/json/);
      assert.deepEqual(sheet.body, expectedRecord);
      assert.deepEqual(Object.keys(sheet.body), ['id', 'name', 'className', 'ratings', 'comment', 'guardianName', 'guardianPhone']);

      const draft = await call(base, 'POST', '/api/students/TEST-1004/ai-draft', { cookie });
      assert.equal(draft.status, 200);
      assert.deepEqual(draft.json, { draft: receiver.state.draft });
      assert.equal(receiver.state.requests.length, 2);
      const ai = receiver.state.requests[1];
      assert.equal(ai.method, 'POST');
      assert.equal(ai.path, '/ai/draft');
      assert.deepEqual(ai.body, {
        id: 'TEST-1004',
        name: expectedRecord.name,
        ratings: expectedRecord.ratings,
        comment: expectedRecord.comment,
      });
      assert.deepEqual(Object.keys(ai.body), ['id', 'name', 'ratings', 'comment']);

      const transfers = app.getTransferLog();
      assert.equal(transfers.length, 2);
      assert.deepEqual(
        transfers.map(({ app: name, kind, studentId, ok, status, error, destination }) => ({ name, kind, studentId, ok, status, error, destination })),
        [
          { name: label, kind: 'sheet', studentId: 'TEST-1004', ok: true, status: 200, error: null, destination: `${receiver.base}/sheet/rows` },
          { name: label, kind: 'ai', studentId: 'TEST-1004', ok: true, status: 200, error: null, destination: `${receiver.base}/ai/draft` },
        ],
      );
      assert.ok(!Number.isNaN(Date.parse(transfers[0].time)));
      assert.ok(transfers[1].seq > transfers[0].seq);

      seen[which] = { requests: structuredClone(receiver.state.requests), saved: saved.json, draft: draft.json };
    });
  }

  test('두 앱이 보낸 내용과 돌려준 응답이 완전히 같다', () => {
    assert.ok(seen.a && seen.b);
    assert.deepEqual(seen.a, seen.b);
  });

  test('1번 앱: 학부모·로그인 없는 사람이 고쳐도 똑같이 나간다', async () => {
    const parent = await login(apps.urlA, 'parent01');
    await call(apps.urlA, 'PUT', '/api/students/TEST-1001/ratings', { cookie: parent, body: { ratings: ALL_GOOD } });
    await call(apps.urlA, 'POST', '/api/students/TEST-1002/ai-draft');
    await apps.a.whenIdle();
    assert.deepEqual(receiver.state.requests.map((request) => request.path), ['/sheet/rows', '/ai/draft']);
    assert.deepEqual(receiver.state.requests[0].body, { ...INITIAL[0], ratings: ALL_GOOD });
    assert.equal(receiver.state.requests[1].body.id, 'TEST-1002');
  });

  for (const which of ['a', 'b']) {
    test(`${which}: 거절·실패한 요청과 삭제는 아무것도 보내지 않는다`, async () => {
      const { base, app } = pick(which);
      const cookie = await login(base, 'teacher');
      const parent = await login(base, 'parent05');
      await call(base, 'PUT', '/api/students/TEST-9999/ratings', { cookie, body: { ratings: ALL_GOOD } }); // 404
      await call(base, 'PUT', '/api/students/TEST-1001/ratings', { cookie, body: { ratings: { 체육: '잘함' } } }); // 400
      await call(base, 'POST', '/api/students/TEST-9999/ai-draft', { cookie }); // 404
      await call(base, 'GET', '/api/students/TEST-1005', { cookie: parent });
      await call(base, 'GET', '/api/students', { cookie });
      await call(base, 'GET', '/api/roster', { cookie });
      if (which === 'b') {
        await call(base, 'PUT', '/api/students/TEST-1005/ratings', { cookie: parent, body: { ratings: ALL_GOOD } }); // 403
        await call(base, 'POST', '/api/students/TEST-1005/ai-draft', { cookie: parent }); // 403
        await call(base, 'PUT', '/api/students/TEST-1005/ratings', { body: { ratings: ALL_GOOD } }); // 401
      }
      assert.equal((await call(base, 'DELETE', '/api/students/TEST-1006', { cookie })).status, 200);
      assert.equal((await call(base, 'DELETE', '/api/students/TEST-1006', { cookie })).status, 404);
      await app.whenIdle();
      assert.deepEqual(receiver.state.requests, []);
      assert.deepEqual(app.getTransferLog(), []);
    });

    test(`${which}: 저장한 뒤 지워도 받는 쪽으로는 지우라는 요청이 가지 않는다`, async () => {
      const { base, app } = pick(which);
      const cookie = await login(base, 'teacher');
      await call(base, 'PUT', '/api/students/TEST-1008/ratings', { cookie, body: { ratings: { 영어: '보통' } } });
      await call(base, 'DELETE', '/api/students/TEST-1008', { cookie });
      await app.whenIdle();
      assert.equal(receiver.state.requests.length, 1);
      assert.equal(receiver.state.requests[0].path, '/sheet/rows');
      assert.equal(receiver.state.requests[0].body.id, 'TEST-1008');
    });

    test(`${which}: 요청으로는 목적지를 바꿀 수 없다`, async () => {
      const { base, app } = pick(which);
      const decoy = await startReceiver();
      try {
        const cookie = await login(base, 'teacher');
        const tricks = `?receiver=${encodeURIComponent(decoy.base)}&receiverBase=${encodeURIComponent(decoy.base)}&url=${encodeURIComponent(decoy.base)}`;
        const headers = { 'X-Receiver': decoy.base, 'X-Forwarded-Host': `127.0.0.1:${decoy.port}`, Referer: decoy.base, Origin: decoy.base };
        const body = { ratings: { 국어: '보통' }, receiver: decoy.base, receiverBase: decoy.base, url: decoy.base, host: '127.0.0.1', port: decoy.port };
        assert.equal((await call(base, 'PUT', `/api/students/TEST-1009/ratings${tricks}`, { cookie, headers, body })).status, 200);
        assert.equal((await call(base, 'POST', `/api/students/TEST-1009/ai-draft${tricks}`, { cookie, headers, body })).status, 200);
        await app.whenIdle();
        assert.deepEqual(decoy.state.requests, []);
        assert.equal(receiver.state.requests.length, 2);
      } finally {
        await decoy.close();
      }
    });
  }
});

describe('받는 쪽에 닿지 못할 때', () => {
  for (const which of ['a', 'b']) {
    test(`${which}: 받는 쪽이 꺼져 있으면 저장은 200, 전송 실패는 기록, AI 초안은 502`, async () => {
      const { base, app } = pick(which);
      apps.receiver.base = `http://127.0.0.1:${await closedPort()}`;
      const cookie = await login(base, 'teacher');

      const saved = await call(base, 'PUT', '/api/students/TEST-1010/ratings', { cookie, body: { ratings: { 국어: '노력요함' } } });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.ratings.국어, '노력요함');
      assert.deepEqual(Object.keys(saved.json), Object.keys(INITIAL[9])); // 응답에 전송 결과가 섞이지 않는다
      await app.whenIdle();

      // 저장은 실제로 되어 있다.
      assert.equal((await call(base, 'GET', '/api/students/TEST-1010', { cookie })).json.ratings.국어, '노력요함');

      const draft = await call(base, 'POST', '/api/students/TEST-1010/ai-draft', { cookie });
      assert.equal(draft.status, 502);
      assert.deepEqual(Object.keys(draft.json), ['error']);
      assert.match(draft.json.error, /[가-힣]/);

      const transfers = app.getTransferLog();
      assert.equal(transfers.length, 2);
      assert.deepEqual(transfers.map((entry) => [entry.kind, entry.ok, entry.status, entry.studentId]), [
        ['sheet', false, null, 'TEST-1010'],
        ['ai', false, null, 'TEST-1010'],
      ]);
      for (const entry of transfers) assert.match(entry.error, /[가-힣]/);
    });

    test(`${which}: 받는 쪽이 오류를 돌려줘도 같다`, async () => {
      const { base, app } = pick(which);
      receiver.state.mode = 'error';
      const cookie = await login(base, 'teacher');
      assert.equal((await call(base, 'PUT', '/api/students/TEST-1011/ratings', { cookie, body: { ratings: { 국어: '잘함' } } })).status, 200);
      await app.whenIdle();
      const draft = await call(base, 'POST', '/api/students/TEST-1011/ai-draft', { cookie });
      assert.equal(draft.status, 502);
      await app.whenIdle();
      assert.deepEqual(app.getTransferLog().map((entry) => [entry.kind, entry.ok, entry.status]), [
        ['sheet', false, 500],
        ['ai', false, 500],
      ]);
    });

    test(`${which}: 받는 쪽이 초안 없이 200을 돌려주면 502`, async () => {
      const { base, app } = pick(which);
      receiver.state.mode = 'bad-draft';
      const cookie = await login(base, 'teacher');
      const draft = await call(base, 'POST', '/api/students/TEST-1011/ai-draft', { cookie });
      assert.equal(draft.status, 502);
      const [entry] = app.getTransferLog();
      assert.equal(entry.ok, false);
    });

    test(`${which}: 받는 쪽이 대답하지 않으면 정해진 시간 뒤에 포기한다`, async () => {
      const { base, app } = pick(which);
      receiver.state.mode = 'hang';
      const cookie = await login(base, 'teacher');
      const started = Date.now();
      const saved = await call(base, 'PUT', '/api/students/TEST-1012/ratings', { cookie, body: { ratings: { 국어: '잘함' } } });
      assert.equal(saved.status, 200);
      const draft = await call(base, 'POST', '/api/students/TEST-1012/ai-draft', { cookie });
      assert.equal(draft.status, 502);
      await app.whenIdle();
      assert.ok(Date.now() - started < 3000, '화면이 멈춘 것처럼 보이지 않아야 한다');
      assert.deepEqual(app.getTransferLog().map((entry) => entry.ok), [false, false]);
    });

    test(`${which}: 받는 쪽 주소가 사설 주소가 아니면 아예 보내지 않는다`, async () => {
      const { base, app } = pick(which);
      const cookie = await login(base, 'teacher');
      const bad = [
        'http://8.8.8.8:4180',
        'http://example.com:4180',
        'http://localhost:4180',
        `${receiver.base}@8.8.8.8`,
        `${receiver.base}/x`,
        `https://127.0.0.1:${receiver.port}`,
        `http://127.0.0.1:${receiver.port}#@8.8.8.8`,
        'http://127.0.0.1',
        '',
        null,
        { host: 'example.com', port: receiver.port },
        { host: '8.8.8.8', port: receiver.port },
      ];
      for (const value of bad) {
        apps.receiver.base = value;
        const saved = await call(base, 'PUT', '/api/students/TEST-1013/ratings', { cookie, body: { ratings: { 국어: '잘함' } } });
        assert.equal(saved.status, 200, String(value));
        const draft = await call(base, 'POST', '/api/students/TEST-1013/ai-draft', { cookie });
        assert.equal(draft.status, 502, String(value));
      }
      await app.whenIdle();
      assert.deepEqual(receiver.state.requests, []);
      const transfers = app.getTransferLog();
      assert.equal(transfers.length, bad.length * 2);
      assert.ok(transfers.every((entry) => entry.ok === false && entry.status === null && /[가-힣]/.test(entry.error)));
    });

    test(`${which}: 받는 쪽 주소를 {host, port}로 줘도 된다`, async () => {
      const { base, app } = pick(which);
      apps.receiver.base = { host: '127.0.0.1', port: receiver.port };
      const cookie = await login(base, 'teacher');
      await call(base, 'PUT', '/api/students/TEST-1014/ratings', { cookie, body: { ratings: { 국어: '잘함' } } });
      await app.whenIdle();
      assert.equal(receiver.state.requests.length, 1);
      assert.equal(app.getTransferLog()[0].ok, true);
    });
  }

  test('받는 쪽이 다른 곳으로 가라고 해도 따라가지 않는다', async () => {
    const http = await import('node:http');
    const { listen, closeServer } = await import('../src/shared/http.js');
    const decoy = await startReceiver();
    const redirector = http.createServer((req, res) => {
      req.resume();
      res.writeHead(307, { Location: `${decoy.base}${req.url}` });
      res.end();
    });
    const port = await listen(redirector, 0);
    try {
      apps.receiver.base = `http://127.0.0.1:${port}`;
      const cookie = await login(apps.urlA, 'teacher');
      assert.equal((await call(apps.urlA, 'PUT', '/api/students/TEST-1015/ratings', { cookie, body: { ratings: { 국어: '잘함' } } })).status, 200);
      assert.equal((await call(apps.urlA, 'POST', '/api/students/TEST-1015/ai-draft', { cookie })).status, 502);
      await apps.a.whenIdle();
      assert.deepEqual(decoy.state.requests, []);
      assert.deepEqual(apps.a.getTransferLog().map((entry) => entry.ok), [false, false]);
    } finally {
      await closeServer(redirector);
      await decoy.close();
    }
  });
});
