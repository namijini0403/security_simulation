// 진행 화면 서버: 접근 제한, 단계, 스위치, 접속 기록, 가져간 것, 받는 쪽, 전체 초기화 (명세 7, 8, 10, 11, 12)
// 실제 서버를 빈 포트에 띄우고 실제 요청으로 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as content from '../src/console/content.js';
import {
  NEIGHBOR, SUBJECTS, appCall, appLogin, findForbidden, rawRequest, startRig, waitFor,
} from './console-helpers.js';

const STEP_IDS = ['start', 'scene1', 'scene2', 'scene3', 'scene4', 'reveal', 'part2', 'closing'];
const KOREAN = /[가-힣]/;

// --------------------------------------------------------------------------- 접근 제한

test('접근 제한: 이 프로그램의 주소가 아닌 Host로 온 요청은 모든 경로에서 거절한다', async (t) => {
  const rig = await startRig(t, { receiver: false });
  const port = rig.demo.ports.console;

  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    const ok = await rawRequest(port, { path: '/api/state', headers: { Host: host } });
    assert.equal(ok.status, 200, host);
  }
  for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `192.168.0.10:${port}`]) {
    for (const path of ['/api/state', '/', '/nothing']) {
      const bad = await rawRequest(port, { path, headers: { Host: host } });
      assert.equal(bad.status, 403, `${host} ${path}`);
      assert.match(bad.json.error, KOREAN);
    }
    const post = await rawRequest(port, {
      method: 'POST', path: '/api/step', headers: { Host: host, 'Content-Type': 'application/json' }, body: '{"to":"next"}',
    });
    assert.equal(post.status, 403);
  }
  assert.equal((await rig.state()).step.id, 'start', '거절된 요청은 아무것도 바꾸지 않는다');
});

test('접근 제한: 다른 사이트의 화면이 보낸 요청(Origin·Sec-Fetch-Site)은 상태를 바꾸지 못한다', async (t) => {
  const rig = await startRig(t, { receiver: false });

  const foreign = await rig.post('/api/step', { to: 'next' }, { headers: { Origin: 'http://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.match(foreign.json.error, KOREAN);
  const otherPort = await rig.post('/api/step', { to: 'next' }, { headers: { Origin: rig.url1 } });
  assert.equal(otherPort.status, 403, '같은 PC의 다른 포트(앱)에서 온 요청도 거절한다');
  for (const site of ['cross-site', 'same-site']) {
    const cross = await rig.post('/api/switch', { action: 'on', confirmed: true }, { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(cross.status, 403, site);
  }
  const crossRead = await rig.get('/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossRead.status, 403);

  const state = await rig.state();
  assert.equal(state.step.id, 'start');
  assert.equal(state.switch.on, false);

  const own = await rig.post('/api/step', { to: 'next' }, { headers: { Origin: rig.base, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(own.status, 200);
  assert.equal(own.json.state.step.id, 'scene1');
});

test('없는 경로·틀린 방식·깨진 본문은 한국어 오류로 답한다. 화면 폴더가 없어도 멈추지 않는다', async (t) => {
  const rig = await startRig(t, { receiver: false, consolePublicDir: undefined });
  const missing = await rig.get('/api/nothing');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, KOREAN);
  const wrong = await rig.get('/api/step');
  assert.equal(wrong.status, 405);
  assert.match(wrong.json.error, KOREAN);
  const broken = await rig.post('/api/step', '{oops');
  assert.equal(broken.status, 400);
  assert.match(broken.json.error, KOREAN);
  const page = await rig.get('/no-such-file.html');
  assert.equal(page.status, 404);
  assert.match(page.json.error, KOREAN);
});

// --------------------------------------------------------------------------- 단계

test('단계: 시작 → ① → ② → ③ → ④ → 공개 → 2부 → 마무리, 다음·이전·바로 가기와 양 끝', async (t) => {
  const rig = await startRig(t, { receiver: false });
  let state = await rig.state();
  assert.deepEqual(state.steps.map((step) => step.id), STEP_IDS);
  assert.deepEqual(state.steps.map((step) => step.label), ['시작', '①', '②', '③', '④', '공개', '2부', '마무리']);
  assert.equal(state.step.index, 0);
  assert.equal(state.step.total, 8);
  assert.equal(state.step.hasPrev, false);
  assert.equal(state.step.hasNext, true);

  const before = await rig.post('/api/step', { to: 'prev' });
  assert.equal(before.status, 409);
  assert.match(before.json.error, KOREAN);
  assert.equal(before.json.state.step.id, 'start');

  for (const id of STEP_IDS.slice(1)) {
    const next = await rig.post('/api/step', { to: 'next' });
    assert.equal(next.status, 200);
    state = next.json.state;
    assert.equal(state.step.id, id);
    const current = state.step.current;
    assert.equal(current.id, id);
    assert.ok(current.title.length > 0);
    assert.ok(current.say.length >= 1 && current.say.length <= 3, `${id}: 발표자 문장은 1~3개`);
    for (const sentence of current.say) assert.match(sentence, KOREAN);
    assert.ok(current.guide.length >= 1);
  }
  assert.equal(state.step.hasNext, false);
  const after = await rig.post('/api/step', { to: 'next' });
  assert.equal(after.status, 409);
  assert.equal(after.json.state.step.id, 'closing');

  const prev = await rig.post('/api/step', { to: 'prev' });
  assert.equal(prev.json.state.step.id, 'part2');
  const jump = await rig.post('/api/step', { to: 'scene2' });
  assert.equal(jump.status, 200);
  assert.equal(jump.json.state.step.id, 'scene2');
  assert.equal(jump.json.state.step.index, 2);

  for (const bad of [{ to: 'nowhere' }, { to: 3 }, {}, { to: '__proto__' }]) {
    const res = await rig.post('/api/step', bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(res.json.error, KOREAN);
    assert.equal(res.json.state.step.id, 'scene2');
  }
});

test('단계 문구: ④의 메시지가 있고 단정하는 문구가 없다. ①은 스위치가 꺼져 있으면 "지금은 이 PC에서만 열립니다"', async (t) => {
  const rig = await startRig(t, { receiver: false });
  let state = (await rig.post('/api/step', { to: 'scene1' })).json.state;
  assert.ok(state.step.current.live.includes('지금은 이 PC에서만 열립니다'));
  assert.equal(state.switch.localOnlyMessage, '지금은 이 PC에서만 열립니다');

  state = (await rig.post('/api/switch', { action: 'on', confirmed: true })).json.state;
  assert.equal(state.switch.on, true);
  assert.ok(!JSON.stringify(state.step.current).includes('지금은 이 PC에서만 열립니다'));
  assert.equal(state.switch.localOnlyMessage, null);

  state = (await rig.post('/api/step', { to: 'scene4' })).json.state;
  const text = [...state.step.current.say, ...state.step.current.guide].join('\n');
  assert.ok(text.includes('앱이 어디에서 실행되는지와 데이터가 어디로 가는지는 별개입니다.'));
  assert.ok(text.includes('삭제 범위를 따로 관리'));
  const all = JSON.stringify(content.STEPS);
  for (const overclaim of ['반드시 남', '영원히', '절대 지워지지', '무조건', '항상 접속', '언제나 열']) {
    assert.ok(!all.includes(overclaim), overclaim);
  }
  for (const jargon of ['API', 'HTTP', '엔드포인트', '세션', '쿠키', '서버', 'GET', 'PUT']) {
    assert.ok(!all.includes(jargon), `단계 문구에 어려운 낱말: ${jargon}`);
  }
});

test('공개 전: 단계 문구와 진행 화면이 돌려주는 모든 내용에 어느 앱인지 드러나는 것이 없다', async (t) => {
  const rig = await startRig(t);
  assert.deepEqual(findForbidden(JSON.stringify(content.STEPS)), []);

  // 접속 기록·가져간 것·전송이 모두 채워진 상태에서 본다.
  for (const url of [rig.url1, rig.url2]) {
    await appCall(url, 'GET', '/api/roster', { headers: NEIGHBOR });
    const cookie = await appLogin(url, 'parent01');
    await appCall(url, 'GET', '/api/students/TEST-1002', { cookie, headers: NEIGHBOR });
    const teacher = await appLogin(url, 'teacher');
    await appCall(url, 'PUT', '/api/students/TEST-1003/ratings', { cookie: teacher, body: { ratings: { 국어: '보통' } } });
  }
  await rig.app1.whenIdle();
  await rig.app2.whenIdle();
  await rig.post('/api/switch', { action: 'on', confirmed: true });
  await rig.post('/api/receiver', { action: 'ping' });

  for (const id of STEP_IDS) {
    const res = await rig.post('/api/step', { to: id });
    let text = JSON.stringify(res.json);
    if (id === 'closing') {
      // 마무리의 첫 문장(명세 10)은 "안전"이라는 낱말을 쓰지만 어느 앱인지와는 무관한 고정 문장이다.
      assert.ok(text.includes('작동하는 앱이 안전한 앱은 아닙니다.'));
      text = text.replaceAll('작동하는 앱이 안전한 앱은 아닙니다.', '');
    } else {
      assert.equal(res.json.state.closing, null, '마무리 문장은 마무리 단계에서만 보낸다');
    }
    assert.deepEqual(findForbidden(text), [], `단계 ${id}`);
    assert.equal(res.json.state.revealed, false);
    assert.ok(res.json.state.accessLog.entries.length > 0);
    for (const entry of res.json.state.accessLog.entries) assert.ok(!('permissionChecked' in entry));
  }
  // 2부를 끝까지 진행해도 마찬가지다.
  const steps = [
    { action: 'next' }, { action: 'next' }, { action: 'next' }, { action: 'choose', which: 'first', choice: 'refer' },
    { action: 'context' }, { action: 'context' }, { action: 'context' }, { action: 'context' },
    { action: 'choose', which: 'second', choice: 'talk' }, { action: 'next' }, { action: 'next' },
  ];
  await rig.post('/api/step', { to: 'part2' });
  for (const body of steps) {
    const res = await rig.post('/api/part2', body);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(findForbidden(JSON.stringify(res.json)), []);
  }
});

// --------------------------------------------------------------------------- 스위치

test('스위치: 처음엔 꺼짐, 확인 없이 켜지지 않음, 켜기·연장·끄기', async (t) => {
  const rig = await startRig(t, { receiver: false, limitMs: 60000, warningMs: 1000 });
  let state = await rig.state();
  assert.equal(state.switch.on, false);
  assert.equal(state.switch.remainingMs, 0);
  assert.equal(state.switch.limitMs, 60000);
  assert.equal(state.switch.confirmWarning, '전용 실습용 연결에서만 켜세요. 학교 와이파이·공용 와이파이에서는 켜지 마세요');
  assert.deepEqual(state.switch.apps.map((app) => app.key), ['app1', 'app2']);
  assert.deepEqual(state.switch.apps.map((app) => app.label), ['1번 앱', '2번 앱']);
  assert.equal(state.switch.apps[0].localUrl, rig.url1);
  assert.equal(state.switch.apps[1].localNeighborUrl, `${rig.url2}/neighbor`);
  assert.deepEqual(state.switch.apps[0].neighborUrls, []);

  for (const body of [{ action: 'on' }, { action: 'on', confirmed: 'true' }, { action: 'on', confirmed: 1 }, { action: 'on', confirmed: false }]) {
    const res = await rig.post('/api/switch', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.json.error, KOREAN);
    assert.equal(res.json.state.switch.on, false);
  }
  const early = await rig.post('/api/switch', { action: 'extend' });
  assert.equal(early.status, 409);
  assert.match(early.json.error, KOREAN);
  const unknown = await rig.post('/api/switch', { action: 'explode' });
  assert.equal(unknown.status, 400);

  const on = await rig.post('/api/switch', { action: 'on', confirmed: true });
  assert.equal(on.status, 200);
  state = on.json.state;
  assert.equal(state.switch.on, true);
  assert.ok(state.switch.remainingMs > 50000 && state.switch.remainingMs <= 60000);
  assert.equal(state.switch.warning, false);
  if (state.switch.noInternalAddress) {
    assert.match(state.switch.guidance, /내부 주소를 찾지 못했습니다/);
    assert.deepEqual(state.switch.apps[0].neighborUrls, []);
  } else {
    assert.equal(state.switch.guidance, null);
    const first = state.switch.addresses[0];
    assert.ok(state.switch.apps[0].neighborUrls.includes(`http://${first}:${rig.demo.ports.app1}/neighbor`));
    assert.ok(state.switch.apps[1].neighborUrls.includes(`http://${first}:${rig.demo.ports.app2}/neighbor`));
    assert.equal(state.switch.apps[0].neighborUrls.length, state.switch.addresses.length, '내부 주소가 여러 개면 모두');
  }
  assert.ok(!JSON.stringify(state.switch).includes(`:${rig.demo.ports.console}`), '진행 화면 주소는 다른 기기용 주소에 없다');

  await new Promise((resolve) => setTimeout(resolve, 120));
  const beforeExtend = (await rig.state()).switch.remainingMs;
  const extended = await rig.post('/api/switch', { action: 'extend' });
  assert.equal(extended.status, 200);
  assert.ok(extended.json.state.switch.remainingMs > beforeExtend, '연장하면 그때부터 다시 제한 시간');

  const off = await rig.post('/api/switch', { action: 'off' });
  assert.equal(off.status, 200);
  assert.equal(off.json.state.switch.on, false);
  assert.equal(off.json.state.switch.autoOff, false);
  assert.equal(off.json.state.switch.autoOffMessage, null);
});

test('스위치: 시간이 지나면 자동으로 꺼지고 알림이 나오며, 알림을 닫을 수 있다. 2분 남음 알림', async (t) => {
  const rig = await startRig(t, { receiver: false, limitMs: 400, warningMs: 300 });
  await rig.post('/api/switch', { action: 'on', confirmed: true });
  const warned = await waitFor(async () => {
    const state = await rig.state();
    return state.switch.on && state.switch.warning ? state : null;
  }, 3000, '남은 시간 알림이 켜지지 않았습니다');
  assert.match(warned.switch.warningMessage, KOREAN);

  const state = await waitFor(async () => {
    const current = await rig.state();
    return current.switch.on ? null : current;
  }, 5000, '자동으로 꺼지지 않았습니다');
  assert.equal(state.switch.autoOff, true);
  assert.equal(state.switch.autoOffMessage, '다른 기기 접속이 자동으로 꺼졌습니다');
  assert.equal(state.switch.warning, false);

  const dismissed = await rig.post('/api/switch', { action: 'dismiss' });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.json.state.switch.autoOff, false);
  assert.equal(dismissed.json.state.switch.autoOffMessage, null);
});

// --------------------------------------------------------------------------- 접속 기록

test('접속 기록: 두 앱의 실제 요청이 시간 순서로 합쳐지고, 다른 기기 요청이 표시된다', async (t) => {
  const rig = await startRig(t, {
    receiver: false,
    // 보낸 주소만 검사용으로 바꿔 끼운다(다른 기기에서 온 요청의 표시를 확인하기 위해).
    switchOptions: { clientAddressOf: (req) => req.headers['x-test-from'] || req.socket.remoteAddress },
  });
  assert.deepEqual((await rig.state()).accessLog.entries, []);

  await appCall(rig.url1, 'GET', '/api/roster');
  await appCall(rig.url2, 'GET', '/api/roster');
  const cookie = await appLogin(rig.url1, 'parent03');
  await appCall(rig.url1, 'GET', '/api/students/TEST-1004?x=1', { cookie, headers: { 'x-test-from': '192.168.77.5', ...NEIGHBOR } });
  await appCall(rig.url2, 'GET', '/api/students/TEST-1004', { headers: { 'x-test-from': '10.1.2.3' } });

  const state = await rig.state();
  const log = state.accessLog;
  assert.equal(log.entries.length, 5);
  assert.equal(log.total, 5);
  assert.deepEqual(log.entries.map((entry) => [entry.appNo, entry.request, entry.status]), [
    [1, 'GET /api/roster', 200],
    [2, 'GET /api/roster', 401],
    [1, 'POST /api/login', 200],
    [1, 'GET /api/students/TEST-1004', 200],
    [2, 'GET /api/students/TEST-1004', 401],
  ]);
  const ids = log.entries.map((entry) => entry.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(log.latestId, ids[4]);
  for (let i = 1; i < 5; i += 1) assert.ok(log.entries[i].at >= log.entries[i - 1].at);

  const [first, , loginEntry, other, other2] = log.entries;
  assert.equal(first.app, '1번 앱');
  assert.equal(first.appKey, 'app1');
  assert.equal(first.clientAddress, '127.0.0.1');
  assert.equal(first.samePc, true);
  assert.equal(first.otherDevice, false);
  assert.equal(first.sourceLabel, '같은 PC');
  assert.equal(first.notice, null);
  assert.equal(first.loginId, null);
  assert.equal(first.method, 'GET');
  assert.equal(first.path, '/api/roster');
  assert.equal(first.fromNeighborScreen, false);
  assert.match(first.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(loginEntry.loginId, 'parent03');

  assert.equal(other.clientAddress, '192.168.77.5');
  assert.equal(other.samePc, false);
  assert.equal(other.otherDevice, true);
  assert.equal(other.sourceLabel, '다른 기기');
  assert.equal(other.notice, '다른 기기에서 접근 요청 수신');
  assert.equal(other.loginId, 'parent03');
  assert.equal(other.fromNeighborScreen, true);
  assert.equal(other2.otherDevice, true);
  assert.equal(other2.app, '2번 앱');
  assert.ok(!('students' in other), '기록 줄에는 학생 기록을 싣지 않는다');

  // 이어 받기와 최근 N줄
  const since = await rig.state(`?since=${ids[2]}`);
  assert.deepEqual(since.accessLog.entries.map((entry) => entry.id), ids.slice(3));
  assert.equal(since.accessLog.total, 5);
  const none = await rig.state(`?since=${ids[4]}`);
  assert.deepEqual(none.accessLog.entries, []);
  const latest = await rig.state('?limit=2');
  assert.deepEqual(latest.accessLog.entries.map((entry) => entry.id), ids.slice(3));
  for (const bad of ['?since=abc', '?limit=0', '?limit=-3', '?since=1e9x']) {
    const res = await rig.get(`/api/state${bad}`);
    assert.equal(res.status, 400, bad);
    assert.match(res.json.error, KOREAN);
  }
});

// --------------------------------------------------------------------------- 옆 기기가 가져간 것

test('옆 기기가 가져간 것: 앱마다 따로, 앱이 센 값 그대로. 명단은 따로 센다', async (t) => {
  const rig = await startRig(t, { receiver: false });
  let state = await rig.state();
  assert.deepEqual(state.taken.map((item) => [item.appKey, item.app, item.studentCount, item.rosterCount]), [
    ['app1', '1번 앱', 0, 0], ['app2', '2번 앱', 0, 0],
  ]);
  assert.equal(state.taken[0].rosterLabel, '명단 열람: 0명');

  await appCall(rig.url1, 'GET', '/api/roster', { headers: NEIGHBOR });
  const c1 = await appLogin(rig.url1, 'parent01');
  await appCall(rig.url1, 'GET', '/api/students/TEST-1001', { cookie: c1, headers: NEIGHBOR });
  await appCall(rig.url1, 'GET', '/api/students/TEST-1002', { cookie: c1, headers: NEIGHBOR });
  await appCall(rig.url1, 'GET', '/api/students/TEST-1002', { cookie: c1, headers: NEIGHBOR });
  await appCall(rig.url1, 'GET', '/api/students/TEST-1005', { cookie: c1 }); // 표시 없음: 세지 않는다
  await appCall(rig.url2, 'GET', '/api/roster', { headers: NEIGHBOR }); // 401
  const c2 = await appLogin(rig.url2, 'parent01');
  await appCall(rig.url2, 'GET', '/api/students/TEST-1001', { cookie: c2, headers: NEIGHBOR });
  await appCall(rig.url2, 'GET', '/api/students/TEST-1002', { cookie: c2, headers: NEIGHBOR }); // 403

  state = await rig.state();
  const [one, two] = state.taken;
  assert.deepEqual(JSON.parse(JSON.stringify(rig.app1.getNeighborSummary().students)), one.students);
  assert.equal(one.studentCount, 2);
  assert.equal(one.studentCount, rig.app1.getNeighborSummary().studentCount);
  assert.deepEqual(one.students.map((student) => student.id), ['TEST-1001', 'TEST-1002']);
  const record = one.students[1];
  assert.equal(record.name, '가상학생02');
  assert.deepEqual(Object.keys(record.ratings), SUBJECTS);
  assert.ok(record.comment.length > 0);
  assert.equal(record.guardianName, '가상보호자02');
  assert.equal(record.guardianPhone, '010-XXXX-0002');
  assert.equal(one.rosterCount, 20);
  assert.equal(one.rosterLabel, '명단 열람: 20명');
  assert.equal(one.rosterViews, 1);
  assert.equal(one.roster.length, 20);
  assert.equal(two.studentCount, 1);
  assert.deepEqual(two.students.map((student) => student.id), ['TEST-1001']);
  assert.equal(two.rosterCount, 0);
  assert.equal(two.rosterLabel, '명단 열람: 0명');
});

// --------------------------------------------------------------------------- 받는 쪽

test('받는 쪽에 도착한 것: 받는 쪽에 실제로 물어본 결과이며, 같은 PC면 그렇게 표시한다', async (t) => {
  const rig = await startRig(t);
  let state = await rig.state();
  assert.equal(state.receiver.host, '127.0.0.1');
  assert.equal(state.receiver.port, rig.receiverPort);
  assert.equal(state.receiver.base, `http://127.0.0.1:${rig.receiverPort}`);
  assert.equal(state.receiver.location, 'same-pc');
  assert.equal(state.receiver.locationLabel, '같은 PC 안의 별도 프로그램');
  assert.equal(state.receiver.reachable, true);
  assert.equal(state.receiver.error, null);
  assert.deepEqual(state.receiver.sheet, []);
  assert.deepEqual(state.receiver.ai, []);

  const teacher = await appLogin(rig.url1, 'teacher');
  const saved = await appCall(rig.url1, 'PUT', '/api/students/TEST-1007/ratings', { cookie: teacher, body: { ratings: { 수학: '잘함' } } });
  assert.equal(saved.status, 200);
  const draft = await appCall(rig.url1, 'POST', '/api/students/TEST-1007/ai-draft', { cookie: teacher });
  assert.equal(draft.status, 200);
  await rig.app1.whenIdle();

  state = await rig.state();
  assert.equal(state.receiver.sheetCount, 1);
  assert.equal(state.receiver.aiCount, 1);
  assert.deepEqual(state.receiver.sheet, JSON.parse(JSON.stringify(rig.receiver.received().sheet)), '받는 쪽이 가진 것 그대로');
  assert.deepEqual(state.receiver.ai, JSON.parse(JSON.stringify(rig.receiver.received().ai)));
  assert.equal(state.receiver.sheet[0].payload.id, 'TEST-1007');
  assert.equal(state.receiver.sheet[0].payload.ratings.수학, '잘함');
  assert.equal(state.receiver.sheet[0].payload.guardianPhone, '010-XXXX-0007');
  assert.match(state.receiver.sheet[0].receivedAt, /^\d{4}-/);
  assert.deepEqual(Object.keys(state.receiver.ai[0].payload).sort(), ['comment', 'id', 'name', 'ratings']);
  assert.deepEqual(state.receiver.failedTransfers, []);

  // 원본을 지워도 받는 쪽에는 그대로다.
  await appCall(rig.url1, 'DELETE', '/api/students/TEST-1007', { cookie: teacher });
  state = await rig.state();
  assert.equal(state.receiver.sheetCount, 1);
  assert.equal(state.receiver.aiCount, 1);

  // 받는 쪽에서 직접 지우면 다음 조회에 그대로 반영된다(미리 정해 둔 화면이 아니다).
  await fetch(`http://127.0.0.1:${rig.receiverPort}/api/clear`, { method: 'POST' });
  state = await rig.state();
  assert.equal(state.receiver.sheetCount, 0);
  assert.deepEqual(state.receiver.ai, []);
});

test('받는 쪽이 꺼져 있으면: "받는 쪽에 닿지 못했습니다"와 조치, 실패한 전송이 보인다', async (t) => {
  const rig = await startRig(t, { receiver: false, receiverTimeoutMs: 800, receiverWaitMs: 3000 });
  let state = await rig.state();
  assert.equal(state.receiver.reachable, false);
  assert.equal(state.receiver.error, '받는 쪽에 닿지 못했습니다');
  assert.ok(state.receiver.help.length >= 2);
  for (const line of state.receiver.help) assert.match(line, KOREAN);
  assert.deepEqual(state.receiver.sheet, []);
  assert.equal(state.receiver.sheetCount, 0);

  const teacher = await appLogin(rig.url1, 'teacher');
  const saved = await appCall(rig.url1, 'PUT', '/api/students/TEST-1003/ratings', { cookie: teacher, body: { ratings: { 수학: '잘함' } } });
  assert.equal(saved.status, 200, '성적 저장 자체는 성공');
  const draft = await appCall(rig.url2, 'POST', '/api/students/TEST-1004/ai-draft', { cookie: await appLogin(rig.url2, 'teacher') });
  assert.equal(draft.status, 502);
  await rig.app1.whenIdle();
  await rig.app2.whenIdle();

  state = await rig.state();
  assert.equal(state.receiver.failedTransfers.length, 2);
  const [a, b] = state.receiver.failedTransfers;
  assert.deepEqual([a.appKey, a.app, a.kind, a.kindLabel, a.studentId], ['app1', '1번 앱', 'sheet', '온라인 표', 'TEST-1003']);
  assert.deepEqual([b.appKey, b.kind, b.kindLabel, b.studentId], ['app2', 'ai', 'AI 서비스', 'TEST-1004']);
  assert.match(a.error, /받는 쪽/);
  assert.equal(a.status, null);
  assert.match(a.time, /^\d{4}-/);
});

test('받는 쪽이 다른 기기 주소이면 "다른 기기"로 표시한다 (닿지 못해도 표시는 주소로 정한다)', async (t) => {
  const rig = await startRig(t, { receiver: false, receiverTimeoutMs: 300, receiverWaitMs: 400 });
  // TEST-NET이 아닌 사설 주소 가운데 이 PC의 주소가 아닌 것.
  const own = (await rig.state()).switch.addresses;
  const host = ['10.255.254.253', '192.168.254.253'].find((candidate) => !own.includes(candidate));
  const set = await rig.post('/api/receiver', { action: 'set', host });
  assert.equal(set.status, 200);
  assert.equal(set.json.state.receiver.host, host);
  assert.equal(set.json.state.receiver.location, 'other-device');
  assert.equal(set.json.state.receiver.locationLabel, '다른 기기');
  assert.equal(set.json.state.receiver.base, `http://${host}:${rig.receiverPort}`);

  if (own.length > 0) {
    const mine = await rig.post('/api/receiver', { action: 'set', host: own[0] });
    assert.equal(mine.json.state.receiver.location, 'same-pc', '이 PC의 내부 주소는 같은 PC다');
  }
});

test('받는 쪽 질의는 몰아서 보내지 않는다: 연달아 물어도 1초에 한 번 정도', async (t) => {
  let hits = 0;
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/api/received') hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"sheet":[],"ai":[]}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const { startDemo } = await import('../src/demo.js');
  const demo = await startDemo({
    ports: { console: 0, app1: 0, app2: 0, receiver: server.address().port }, openBrowser: false, log: () => {},
  });
  t.after(() => demo.close());
  for (let i = 0; i < 12; i += 1) {
    const res = await fetch(`${demo.urls.console}/api/state`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).receiver.reachable, true);
  }
  assert.ok(hits >= 1 && hits <= 2, `받는 쪽 질의 횟수: ${hits}`);
});

test('받는 쪽 주소: 이름·공인 주소·포트 붙은 것·IPv6·빈 값은 이유와 함께 거절, 사설 주소는 받아들인다', async (t) => {
  const rig = await startRig(t, { receiverTimeoutMs: 300, receiverWaitMs: 400 });
  const rejected = [
    'receiver.example.com', 'localhost', '8.8.8.8', '203.0.113.7', `127.0.0.1:${rig.receiverPort}`, 'http://127.0.0.1',
    '::1', 'fe80::1', '', '   ', '192.168.0.300', '0x7f.0.0.1', '127.0.0.1/admin', null, 7, undefined,
  ];
  const reasons = new Set();
  for (const host of rejected) {
    const res = await rig.post('/api/receiver', { action: 'set', host });
    assert.equal(res.status, 400, String(host));
    assert.match(res.json.error, KOREAN);
    reasons.add(res.json.error);
    assert.equal(res.json.state.receiver.host, '127.0.0.1', '거절되면 주소는 그대로다');
  }
  assert.ok(reasons.size >= 4, '이유를 구분해서 알린다');
  assert.match((await rig.post('/api/receiver', { action: 'set', host: '8.8.8.8' })).json.error, /인터넷 주소로는 보내지 않습니다/);

  // 두 앱이 같은 설정 하나를 읽는다.
  assert.deepEqual(rig.demo.receiverAddress.get(), { host: '127.0.0.1', port: rig.receiverPort });
  const ok = await rig.post('/api/receiver', { action: 'set', host: ' 127.0.0.2 ' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.state.receiver.host, '127.0.0.2');
  assert.equal(ok.json.state.receiver.port, rig.receiverPort, '포트는 받는 쪽 포트로 고정');
  assert.deepEqual(rig.demo.receiverAddress.get(), { host: '127.0.0.2', port: rig.receiverPort });

  const teacher = await appLogin(rig.url2, 'teacher');
  await appCall(rig.url2, 'PUT', '/api/students/TEST-1003/ratings', { cookie: teacher, body: { ratings: { 수학: '잘함' } } });
  await rig.app2.whenIdle();
  const transfer = rig.app2.getTransferLog()[0];
  assert.equal(transfer.destination, `http://127.0.0.2:${rig.receiverPort}/sheet/rows`, '앱은 진행 화면이 정한 주소로만 보낸다');

  const unknown = await rig.post('/api/receiver', { action: 'port', port: 80 });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.state.receiver.port, rig.receiverPort);
});

test('연결 확인: 실제로 ping을 보내 성공을 알리고, 실패하면 원인 후보와 조치를 알린다', async (t) => {
  const rig = await startRig(t);
  const ok = await rig.post('/api/receiver', { action: 'ping' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ping.ok, true);
  assert.equal(ok.json.ping.status, 200);
  assert.match(ok.json.ping.message, KOREAN);
  assert.deepEqual(ok.json.ping.causes, []);
  assert.equal(ok.json.ping.base, `http://127.0.0.1:${rig.receiverPort}`);
  assert.deepEqual(ok.json.state.receiver.ping, ok.json.ping);

  await rig.stopReceiver();
  const fail = await rig.post('/api/receiver', { action: 'ping' });
  assert.equal(fail.status, 200);
  assert.equal(fail.json.ping.ok, false);
  assert.equal(fail.json.ping.status, null);
  assert.match(fail.json.ping.message, /받는 쪽에 닿지 못했습니다/);
  const causes = fail.json.ping.causes.map((item) => item.cause);
  assert.deepEqual(causes, [
    '받는 쪽 프로그램이 꺼져 있음', '받는 쪽 스위치가 꺼져 있음', '방화벽', '두 노트북이 같은 연결이 아님', '기기 간 통신을 막는 와이파이',
  ]);
  for (const item of fail.json.ping.causes) assert.match(item.action, KOREAN);
  assert.equal(fail.json.state.receiver.ping.ok, false);
});

test('연결 확인: 받는 쪽 프로그램이 아닌 것이 대답하면 성공으로 치지 않는다', async (t) => {
  const rig = await startRig(t, { receiver: false });
  // 받는 쪽 포트에 1번 앱과 같은 "다른 프로그램"이 있는 상황: 받는 쪽 포트 자리에 임시 서버를 띄운다.
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true,"service":"something-else"}');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(rig.receiverPort, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const res = await rig.post('/api/receiver', { action: 'ping' });
  assert.equal(res.json.ping.ok, false);
  assert.equal(res.json.ping.status, 200, '실제로 돌아온 번호는 그대로 보여준다');
  assert.ok(res.json.ping.causes.length > 0);
});

// --------------------------------------------------------------------------- 마무리

test('마무리: 일곱 문장이 순서대로 있고 여섯 번째가 가장 강조된다', async (t) => {
  const rig = await startRig(t, { receiver: false });
  const state = (await rig.post('/api/step', { to: 'closing' })).json.state;
  const sentences = state.closing.sentences;
  assert.deepEqual(sentences.map((sentence) => sentence.text), [
    '작동하는 앱이 안전한 앱은 아닙니다.',
    '로컬 실행은 개인정보 보호를 보증하지 않습니다.',
    'AI가 코드를 만들었다고 해서 시스템의 위험까지 책임져 주는 것은 아닙니다.',
    '학생이 표현한 감정은 관찰 자료이지, 학생의 심리 상태에 대한 확정적인 진단이 아닙니다.',
    '학생의 개인정보·민감정보를 외부 AI 서비스에 보내면 안 됩니다.',
    '개발은 자유롭게, 개인정보 처리는 신중하게.',
    '학교에서 학생·학부모의 개인정보를 처리하는 앱은 개인정보 수집의 필요성, 최소 수집, 학교의 공식 검토·승인, 접근통제, 운영 책임이 확인되기 전까지 실제 사용을 시작해서는 안 됩니다.',
  ]);
  assert.deepEqual(sentences.map((sentence) => sentence.no), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(sentences.map((sentence) => sentence.emphasis), [false, false, false, false, false, true, false]);
});

// --------------------------------------------------------------------------- 전체 초기화

test('전체 초기화: 두 앱·단계·2부·공개·기록이 처음으로 돌아가고 받는 쪽도 비운다. 주소와 스위치는 유지', async (t) => {
  const rig = await startRig(t, { limitMs: 60000 });
  await rig.post('/api/switch', { action: 'on', confirmed: true });
  await rig.post('/api/step', { to: 'scene4' });
  await rig.post('/api/part2', { action: 'next' });

  const parent = await appLogin(rig.url1, 'parent01');
  await appCall(rig.url1, 'GET', '/api/students/TEST-1002', { cookie: parent, headers: NEIGHBOR });
  await appCall(rig.url1, 'PUT', '/api/students/TEST-1001/ratings', { cookie: parent, body: { ratings: { 국어: '잘함', 수학: '잘함' } } });
  await appCall(rig.url1, 'DELETE', '/api/students/TEST-1009', { cookie: parent });
  const parent2 = await appLogin(rig.url2, 'parent01');
  const reveal = await rig.post('/api/reveal', {});
  assert.equal(reveal.status, 200);
  await rig.app1.whenIdle();

  let state = await rig.state();
  assert.equal(state.revealed, true);
  assert.ok(state.receiver.sheetCount >= 2);
  assert.ok(state.accessLog.entries.length > 0);
  assert.equal(state.taken[0].studentCount, 1);
  const epochBefore = state.accessLog.epoch;

  const reset = await rig.post('/api/reset', {});
  assert.equal(reset.status, 200);
  assert.equal(reset.json.receiverCleared, true);
  assert.equal(reset.json.notice, null);
  state = reset.json.state;
  assert.equal(state.step.id, 'start');
  assert.equal(state.revealed, false);
  assert.equal(state.reveal.attempts, undefined);
  assert.ok(!JSON.stringify(state).includes('permissionChecked'));
  assert.equal(state.part2.stage, 'journal');
  assert.deepEqual(state.accessLog.entries, []);
  assert.equal(state.accessLog.total, 0);
  assert.ok(state.accessLog.epoch > epochBefore, '화면이 기록을 비울 수 있게 번호가 바뀐다');
  assert.deepEqual(state.taken.map((item) => item.studentCount), [0, 0]);
  assert.equal(state.receiver.sheetCount, 0);
  assert.equal(state.receiver.aiCount, 0);
  assert.deepEqual(rig.receiver.received(), { sheet: [], ai: [] }, '받는 쪽이 실제로 비워졌다');
  assert.equal(state.lastReset.receiverCleared, true);
  // 유지되는 것
  assert.equal(state.receiver.host, '127.0.0.1');
  assert.equal(state.switch.on, true);
  assert.ok(state.switch.remainingMs > 0);

  // 학생 20명 원상 복구, 로그인 무효
  const teacher = await appLogin(rig.url1, 'teacher');
  const all = await appCall(rig.url1, 'GET', '/api/students', { cookie: teacher });
  assert.equal(all.json.length, 20);
  assert.ok(Object.values(all.json[0].ratings).includes('노력요함'), 'TEST-1001의 초기 평가로 돌아왔다');
  assert.equal((await appCall(rig.url1, 'GET', '/api/me', { cookie: parent })).status, 401);
  assert.equal((await appCall(rig.url2, 'GET', '/api/me', { cookie: parent2 })).status, 401);
});

test('전체 초기화: 받는 쪽에 닿지 못하면 알리고, 나머지는 그대로 초기화한다', async (t) => {
  const rig = await startRig(t, { receiver: false, receiverTimeoutMs: 500, receiverWaitMs: 600 });
  assert.equal((await rig.post('/api/receiver', { action: 'set', host: '127.0.0.3' })).status, 200);
  await rig.post('/api/step', { to: 'scene2' });
  await appCall(rig.url1, 'DELETE', '/api/students/TEST-1009');
  const reset = await rig.post('/api/reset', {});
  assert.equal(reset.status, 200);
  assert.equal(reset.json.receiverCleared, false);
  assert.equal(reset.json.notice, '받는 쪽은 지우지 못했습니다. 받는 쪽 화면에서 직접 지우세요');
  assert.equal(reset.json.state.lastReset.notice, '받는 쪽은 지우지 못했습니다. 받는 쪽 화면에서 직접 지우세요');
  assert.equal(reset.json.state.lastReset.receiverCleared, false);
  assert.equal(reset.json.state.step.id, 'start');
  assert.equal(reset.json.state.receiver.host, '127.0.0.3', '받는 쪽 주소는 유지한다');
  assert.equal(reset.json.state.switch.on, false);
  assert.equal((await appCall(rig.url1, 'GET', '/api/roster')).json.length, 20);
});

test('전체 초기화: 아직 가는 중이던 전송이 받는 쪽에 도착한 뒤에 지운다', async (t) => {
  const rig = await startRig(t);
  const teacher = await appLogin(rig.url1, 'teacher');
  for (let i = 1; i <= 5; i += 1) {
    await appCall(rig.url1, 'PUT', `/api/students/TEST-100${i}/ratings`, { cookie: teacher, body: { ratings: { 수학: '잘함' } } });
  }
  const reset = await rig.post('/api/reset', {}); // 전송을 기다리지 않고 바로 초기화
  assert.equal(reset.json.receiverCleared, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(rig.receiver.received().sheet, [], '초기화 뒤에 뒤늦게 도착한 것이 없다');
});

// --------------------------------------------------------------------------- 화면 파일

test('화면 파일: 폴더가 있으면 / 가 index.html로 열리고, 폴더 밖의 파일은 나가지 않는다', async (t) => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-screen-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>진행 화면</title>');
  await fs.writeFile(path.join(dir, 'console.js'), '// 화면');
  const rig = await startRig(t, { receiver: false, consolePublicDir: dir });

  const page = await rig.get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.ok(page.text.includes('진행 화면'));
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.equal((await rig.get('/console.js')).status, 200);
  assert.equal((await rig.get('/missing.css')).status, 404);
  for (const escape of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/..\..\package.json']) {
    const res = await rig.get(escape);
    assert.equal(res.status, 404, escape);
    assert.ok(!res.text.includes('local-is-not-safe-demo'));
  }
  assert.equal((await rig.post('/', {})).status, 405);
});
