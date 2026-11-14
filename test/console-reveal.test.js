// 공개 장면 (명세 8.1, 8.5): 다섯 시도는 실제 요청이고, 화면에는 실제로 돌아온 값만 쓴다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SUBJECTS, appCall, appLogin, findForbidden, startRig } from './console-helpers.js';

const ALL_GOOD = Object.fromEntries(SUBJECTS.map((subject) => [subject, '잘함']));
const statuses = (reveal, key) => reveal.attempts.map((attempt) => attempt.results[key].status);

test('공개: 다섯 시도가 두 앱에 실제로 가고, 처음 상태에서는 8.5의 표와 같다', async (t) => {
  const rig = await startRig(t);
  const before = await rig.state();
  assert.equal(before.revealed, false);
  assert.deepEqual(before.reveal, { revealed: false, running: false });

  const res = await rig.post('/api/reveal', {});
  assert.equal(res.status, 200);
  const state = res.json.state;
  const reveal = state.reveal;
  assert.equal(state.revealed, true);
  assert.equal(reveal.revealed, true);
  assert.equal(reveal.running, false);
  assert.equal(reveal.runCount, 1);
  assert.equal(reveal.attempts.length, 5);
  assert.deepEqual(reveal.attempts.map((attempt) => attempt.no), [1, 2, 3, 4, 5]);
  assert.deepEqual(reveal.attempts.map((attempt) => attempt.title), [
    '로그인 없이 명단 주소 열기',
    'parent01로 자기 아이 조회',
    'parent01로 TEST-1002 조회',
    'parent01로 반 전체 기록 받기',
    'parent01로 자기 아이 성적 고치기',
  ]);
  assert.deepEqual(reveal.attempts.map((attempt) => attempt.request), [
    'GET /api/roster', 'GET /api/students/TEST-1001', 'GET /api/students/TEST-1002', 'GET /api/students',
    'PUT /api/students/TEST-1001/ratings',
  ]);
  assert.deepEqual(reveal.attempts.map((attempt) => attempt.loginId), [null, 'parent01', 'parent01', 'parent01', 'parent01']);
  assert.deepEqual(statuses(reveal, 'app1'), [200, 200, 200, 200, 200]);
  assert.deepEqual(statuses(reveal, 'app2'), [401, 200, 403, 403, 403]);
  assert.deepEqual(reveal.apps.map((app) => [app.key, app.label, app.loginStatus, app.logoutStatus]), [
    ['app1', '1번 앱', 200, 200], ['app2', '2번 앱', 200, 200],
  ]);

  // 내용도 실제로 받은 것이다.
  const [roster, own, other, all, change] = reveal.attempts;
  assert.equal(roster.results.app1.body.length, 20);
  assert.deepEqual(roster.results.app1.body[0], { id: 'TEST-1001', name: '가상학생01' });
  assert.equal(typeof roster.results.app2.body.error, 'string');
  assert.equal(own.results.app1.body.id, 'TEST-1001');
  assert.equal(own.results.app2.body.id, 'TEST-1001');
  assert.equal(other.results.app1.body.guardianPhone, '010-XXXX-0002');
  assert.deepEqual(Object.keys(other.results.app2.body), ['error']);
  assert.equal(all.results.app1.body.length, 20);
  assert.deepEqual(change.results.app1.body.ratings, ALL_GOOD);
  assert.deepEqual(Object.keys(change.results.app2.body), ['error']);
  for (const attempt of reveal.attempts) {
    for (const key of ['app1', 'app2']) assert.equal(attempt.results[key].error, null);
  }

  // 설명 문구와 비교용 예제 안내
  assert.deepEqual(reveal.notes, [
    "두 앱의 화면은 같습니다. 다른 것은 서버가 '이 사람이 이 요청을 해도 되는가'를 확인하는지뿐입니다.",
    '2번 앱도 다른 기기에서 열리기는 합니다. 로그인에서 막힐 뿐입니다.',
    '데이터를 다른 곳으로 보내는 것은 두 앱이 똑같습니다. 잘 막은 앱이라도 밖으로 나간 데이터는 별개의 문제입니다.',
  ]);
  assert.match(reveal.comparisonNotice, /특정 접근통제 원리를 보여주는 비교용 예제이며 실제 학교 서비스에 그대로 쓸 수 있는 인증 체계가 아닙니다/);
  assert.deepEqual(reveal.appWithoutCheck, { key: 'app1', label: '1번 앱' });
  assert.deepEqual(reveal.appWithCheck, { key: 'app2', label: '2번 앱' });

  // 두 앱의 접속 기록에 실제 요청으로 남아 있고, 옆 사람 화면 표시가 없다.
  for (const [app, expected] of [[rig.app1, [200, 200, 200, 200, 200, 200, 200]], [rig.app2, [401, 200, 200, 403, 403, 403, 200]]]) {
    const log = app.getAccessLog();
    assert.deepEqual(log.map((entry) => `${entry.method} ${entry.path}`), [
      'GET /api/roster', 'POST /api/login', 'GET /api/students/TEST-1001', 'GET /api/students/TEST-1002', 'GET /api/students',
      'PUT /api/students/TEST-1001/ratings', 'POST /api/logout',
    ]);
    assert.deepEqual(log.map((entry) => entry.status), expected);
    assert.ok(log.every((entry) => entry.neighbor === false));
    assert.ok(log.every((entry) => entry.clientAddress === '127.0.0.1' && entry.local === true));
    assert.equal(log[2].loginId, 'parent01');
  }
  assert.deepEqual(state.taken.map((item) => [item.studentCount, item.rosterCount]), [[0, 0], [0, 0]], '공개의 요청은 가져간 것으로 세지 않는다');

  // 다섯 번째 시도는 실제로 바꾼다: 1번 앱만 바뀌고, 그 기록이 받는 쪽에 도착한다.
  const t1 = await appLogin(rig.url1, 'teacher');
  const t2 = await appLogin(rig.url2, 'teacher');
  assert.deepEqual((await appCall(rig.url1, 'GET', '/api/students/TEST-1001', { cookie: t1 })).json.ratings, ALL_GOOD);
  const untouched = (await appCall(rig.url2, 'GET', '/api/students/TEST-1001', { cookie: t2 })).json.ratings;
  assert.ok(Object.values(untouched).includes('노력요함'), '2번 앱은 그대로다');
  await rig.app1.whenIdle();
  const received = rig.receiver.received();
  assert.equal(received.sheet.length, 1);
  assert.equal(received.sheet[0].payload.id, 'TEST-1001');
  assert.deepEqual(received.sheet[0].payload.ratings, ALL_GOOD);
  assert.equal((await rig.state()).receiver.sheetCount, 1);

});

test('공개 뒤에만: 접속 기록에 권한 확인 여부가 붙고, 어느 앱이었는지 나온다', async (t) => {
  const rig = await startRig(t, { receiver: false });
  await appCall(rig.url1, 'GET', '/api/roster');
  await appCall(rig.url2, 'GET', '/api/roster');
  let state = await rig.state();
  assert.deepEqual(findForbidden(JSON.stringify(state)), []);
  assert.ok(state.accessLog.entries.every((entry) => !('permissionChecked' in entry)));

  state = (await rig.post('/api/reveal', {})).json.state;
  assert.equal(state.revealed, true);
  const text = JSON.stringify(state);
  assert.ok(text.includes('permissionChecked'));
  assert.ok(text.includes('appWithoutCheck'));
  for (const entry of state.accessLog.entries) {
    assert.equal(typeof entry.permissionChecked, 'boolean');
    const fromApp = (entry.appKey === 'app1' ? rig.app1 : rig.app2).getAccessLog()
      .find((item) => item.at === entry.at && item.path === entry.path && item.method === entry.method && item.status === entry.status);
    assert.equal(entry.permissionChecked, fromApp.permissionChecked, '앱이 실제로 남긴 값이다');
    if (entry.appKey === 'app1') assert.equal(entry.permissionChecked, false);
    else assert.equal(entry.permissionChecked, !['/api/login', '/api/logout'].includes(entry.path));
    assert.equal(entry.permissionLabel, entry.permissionChecked ? '권한 확인함' : '권한 확인 안 함');
  }
  // 공개 전에 있던 줄에도 붙는다.
  assert.equal(state.accessLog.entries[0].permissionChecked, false);
  assert.equal(state.accessLog.entries[1].permissionChecked, true);

  // 단계를 옮겨도 공개 상태는 유지된다.
  state = (await rig.post('/api/step', { to: 'scene1' })).json.state;
  assert.equal(state.revealed, true);
  assert.equal(state.reveal.attempts.length, 5);
});

test('공개: 다시 누르면 다시 보내고 결과를 새로 쓴다. 기대값이 아니라 실제 값을 보여준다', async (t) => {
  const rig = await startRig(t);
  const first = (await rig.post('/api/reveal', {})).json.state.reveal;
  assert.deepEqual(statuses(first, 'app1'), [200, 200, 200, 200, 200]);
  const count1 = rig.app1.getAccessLog().length;
  const count2 = rig.app2.getAccessLog().length;

  // 1번 앱에서 TEST-1002를 지운다 → 세 번째 시도는 실제로 404가 된다.
  const teacher = await appLogin(rig.url1, 'teacher');
  assert.equal((await appCall(rig.url1, 'DELETE', '/api/students/TEST-1002', { cookie: teacher })).status, 200);

  const second = (await rig.post('/api/reveal', {})).json.state.reveal;
  assert.equal(second.runCount, 2);
  assert.ok(second.ranAt >= first.ranAt);
  assert.deepEqual(statuses(second, 'app1'), [200, 200, 404, 200, 200]);
  assert.deepEqual(statuses(second, 'app2'), [401, 200, 403, 403, 403]);
  assert.equal(typeof second.attempts[2].results.app1.body.error, 'string');
  assert.equal(second.attempts[0].results.app1.body.length, 19, '명단도 지금의 실제 명단이다');
  assert.equal(second.attempts[3].results.app1.body.length, 19);
  assert.equal(rig.app1.getAccessLog().length, count1 + 2 + 7, '다시 일곱 요청이 실제로 갔다');
  assert.equal(rig.app2.getAccessLog().length, count2 + 7);
  await rig.app1.whenIdle();
  assert.equal(rig.receiver.received().sheet.length, 2, '성적 고치기가 다시 실제로 나갔다');

  // 2번 앱에서도 지우면 2번 앱은 403이 404보다 먼저다(명세 5.3).
  const teacher2 = await appLogin(rig.url2, 'teacher');
  await appCall(rig.url2, 'DELETE', '/api/students/TEST-1002', { cookie: teacher2 });
  await appCall(rig.url2, 'DELETE', '/api/students/TEST-1001', { cookie: teacher2 });
  const third = (await rig.post('/api/reveal', {})).json.state.reveal;
  assert.deepEqual(statuses(third, 'app2'), [401, 404, 403, 403, 403]);
});

test('공개: 본문은 받지 않는다(요청으로 대상을 바꿀 수 없다). GET으로는 실행되지 않는다', async (t) => {
  const rig = await startRig(t, { receiver: false });
  const get = await rig.get('/api/reveal');
  assert.equal(get.status, 405);
  assert.equal((await rig.state()).revealed, false);
  assert.equal(rig.app1.getAccessLog().length, 0);

  const res = await rig.post('/api/reveal', { target: 'http://203.0.113.9', loginId: 'teacher', studentId: 'TEST-1010' });
  assert.equal(res.status, 200);
  const log = rig.app1.getAccessLog();
  assert.equal(log.length, 7);
  assert.equal(log[1].loginId, 'parent01');
  assert.ok(log.every((entry) => !entry.path.includes('TEST-1010')));
});
