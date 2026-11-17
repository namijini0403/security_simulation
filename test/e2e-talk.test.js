// 처음부터 끝까지: 발표 전체를 실제 프로그램과 실제 요청으로 그대로 따라 한다 (명세 15, 8.4, 11).
//
// 진짜 시연 프로그램(진행 화면 + 1번 앱 + 2번 앱)과 진짜 받는 쪽 프로그램을 함께 띄우고,
// 옆 사람 화면·담임 화면·진행 화면의 버튼이 보내는 것과 같은 요청을 순서대로 보낸다.
// 각 지점에서 "발표자가 진행 화면에서 보게 될 것"을 진행 화면의 실제 응답(GET /api/state)으로 확인한다.
// 브라우저는 열지 않는다. 대신하는 서버는 없다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listInternalAddresses } from '../src/shared/address.js';
import { createStudents } from '../src/shared/data.js';
import { findForbidden } from './console-helpers.js';
import {
  ALL_GOOD, NOT_LOGGED_IN, SUBJECTS, call, createLedger, logRows, startTalk, studentId, tryConnect, waitFor,
} from './e2e-helpers.js';

const INITIAL = createStudents();
const initialOf = (id) => structuredClone(INITIAL.find((student) => student.id === id));
const LAN = listInternalAddresses();
const MOCK_LABEL = '사전 작성된 모의 응답';

test('발표 전체: 시작 → ① → ② → ③ → ④ → 공개 → 2부 → 마무리 → 전체 초기화', async (t) => {
  const rig = await startTalk(t);
  const ledger = createLedger(rig);
  const { press } = rig;
  /** 발표 내내 이어지는 값. */
  const talk = { parent: {}, teacher: {}, sheetBeforeReveal: 0 };

  /** 접속 기록이 지금까지 실제로 보낸 요청과 정확히 같은가(순서, 앱, 요청, 결과 번호, 로그인한 사람, 표시). */
  async function logMatchesLedger(label) {
    const state = await rig.state();
    assert.deepEqual(logRows(state), ledger.sent, `접속 기록이 실제 요청과 다르다: ${label}`);
    assert.equal(state.accessLog.total, ledger.sent.length);
    return state;
  }
  const taken = (state, appNo) => state.taken[appNo - 1];
  const goTo = async (id) => {
    const res = await press('/api/step', { to: 'next' });
    assert.equal(res.status, 200);
    assert.equal(res.json.state.step.id, id);
  };

  await t.test('시작: 스위치 꺼짐, 두 앱 모두 20명, 가져간 것·도착한 것 없음, 공개 전', async () => {
    const state = await rig.state();
    assert.equal(state.step.id, 'start');
    assert.equal(state.fixedNotice, '교육용 실습 / 100% 합성 데이터 / 실제 개인정보 입력 금지');
    assert.equal(state.switch.on, false);
    assert.equal(state.switch.limitMs, 30 * 60 * 1000);
    assert.equal(state.switch.localOnlyMessage, '지금은 이 PC에서만 열립니다');
    // 두 번째 노트북에 입력할 주소는 스위치가 꺼져 있는 동안에는 나오지 않는다.
    for (const app of state.switch.apps) {
      assert.deepEqual(app.urls, []);
      assert.deepEqual(app.neighborUrls, []);
    }
    assert.deepEqual(state.accessLog.entries, []);
    assert.deepEqual(state.taken.map((item) => [item.app, item.studentCount, item.rosterCount]), [['1번 앱', 0, 0], ['2번 앱', 0, 0]]);
    assert.equal(state.receiver.reachable, true);
    assert.equal(state.receiver.host, '127.0.0.1');
    assert.equal(state.receiver.port, rig.receiverPort);
    assert.equal(state.receiver.locationLabel, '같은 PC 안의 별도 프로그램');
    assert.deepEqual([state.receiver.sheetCount, state.receiver.aiCount], [0, 0]);
    assert.deepEqual(state.receiver.failedTransfers, []);
    assert.equal(state.revealed, false);
    assert.deepEqual(state.reveal, { revealed: false, running: false });
    assert.equal(state.part2.stage, 'journal');
    assert.equal(state.closing, null);
    assert.deepEqual(await rig.held(), { sheet: [], ai: [] });

    // 두 앱 모두 실제로 20명을 갖고 있다(담임으로 실제 로그인해서 확인). 내용은 초기값 그대로다.
    for (const appNo of [1, 2]) {
      const teacher = await ledger.login(appNo, 'teacher');
      const list = await ledger.send(appNo, 'GET', '/api/students', { who: teacher });
      assert.equal(list.status, 200);
      assert.deepEqual(list.json, INITIAL);
      assert.equal((await ledger.send(appNo, 'POST', '/api/logout', { who: teacher })).status, 200);
    }
    const after = await logMatchesLedger('시작');
    // 담임 화면의 요청은 '가져간 것'으로 세지 않는다.
    assert.deepEqual(after.taken.map((item) => item.studentCount), [0, 0]);
  });

  await t.test('①: 로그인 없이 명단 주소를 직접 열면 1번 앱에서 명단이 나간다', async () => {
    await goTo('scene1');
    const before = await rig.state();
    assert.deepEqual(before.step.current.live, ['지금은 이 PC에서만 열립니다']);

    const roster = await ledger.send(1, 'GET', '/api/roster', { neighbor: true });
    assert.equal(roster.status, 200);
    assert.equal(roster.json.length, 20);
    assert.deepEqual(roster.json[0], { id: 'TEST-1001', name: '가상학생01' });
    assert.deepEqual(Object.keys(roster.json[19]), ['id', 'name'], '명단에는 번호와 이름만 있다');

    const state = await logMatchesLedger('① 명단');
    const last = state.accessLog.entries.at(-1);
    assert.equal(last.app, '1번 앱');
    assert.equal(last.request, 'GET /api/roster');
    assert.equal(last.status, 200);
    assert.equal(last.loginLabel, NOT_LOGGED_IN);
    assert.equal(last.sourceLabel, '같은 PC');
    // "명단 열람"에는 나오고, 가져간 인원 수에는 들어가지 않는다.
    assert.equal(taken(state, 1).rosterLabel, '명단 열람: 20명');
    assert.equal(taken(state, 1).rosterViews, 1);
    assert.equal(taken(state, 1).studentCount, 0);
    assert.deepEqual(taken(state, 1).students, []);
    assert.equal(taken(state, 2).rosterCount, 0);
  });

  await t.test('①: 확인 없이는 스위치가 켜지지 않는다', async () => {
    for (const body of [{ action: 'on' }, { action: 'on', confirmed: 'true' }, { action: 'on', confirmed: false }]) {
      const res = await press('/api/switch', body);
      assert.equal(res.status, 400);
      assert.match(res.json.error, /확인/);
      assert.equal(res.json.state.switch.on, false);
    }
  });

  await t.test('①: 이 PC의 내부 주소로는 스위치를 켜기 전에 열리지 않고, 켜면 열리고, 끄면 다시 닫힌다. 진행 화면은 끝까지 열리지 않는다', async (st) => {
    if (LAN.length === 0) {
      st.skip('이 PC에 내부 주소(사설 IPv4)가 없어서 확인하지 못함');
      return;
    }
    const lan = LAN[0];
    const { app1, app2, console: consolePort } = rig.ports;

    // 켜기 전: 내부 주소로는 두 앱도 진행 화면도 연결 자체가 되지 않는다.
    // (거절되는 연결은 Windows에서 하나에 2초쯤 걸리므로 한꺼번에 시도한다.)
    const closedBefore = await Promise.all([
      ...[app1, app2, consolePort].map((port) => tryConnect(lan, port)),
      fetch(`http://${lan}:${app1}/neighbor`, { signal: AbortSignal.timeout(5000) }).then(() => 'open', () => 'failed'),
    ]);
    assert.ok(closedBefore.every((result) => result !== 'open'), `켜기 전에 내부 주소로 열렸다: ${closedBefore}`);
    // 스위치가 막은 시도는 접속 기록에 남지 않는다(앱까지 오지 않았으므로).
    await logMatchesLedger('① 꺼진 동안의 시도');

    // 켜도 로그인 상태가 유지되는지 보려고 먼저 2번 앱에 담임으로 로그인해 둔다.
    const teacher = await ledger.login(2, 'teacher');

    const on = await press('/api/switch', { action: 'on', confirmed: true });
    assert.equal(on.status, 200);
    const sw = on.json.state.switch;
    assert.equal(sw.on, true);
    assert.ok(sw.remainingMs > 29 * 60 * 1000 && sw.remainingMs <= 30 * 60 * 1000, '남은 시간은 30분에서 시작한다');
    assert.ok(sw.addresses.includes(lan));
    assert.ok(sw.apps[0].neighborUrls.includes(`http://${lan}:${app1}/neighbor`), '두 번째 노트북에 입력할 주소가 나온다');
    assert.ok(sw.apps[1].neighborUrls.includes(`http://${lan}:${app2}/neighbor`));
    assert.deepEqual(on.json.state.step.current.live, [], '켜지면 "이 PC에서만 열립니다"가 사라진다');
    assert.equal(on.json.state.step.id, 'scene1', '진행 단계는 그대로다');

    // 켠 뒤: 내부 주소로 옆 사람 화면이 실제로 열리고, 그 화면의 첫 버튼(명단)이 실제로 된다.
    const page = await ledger.send(1, 'GET', '/neighbor', { via: lan });
    assert.equal(page.status, 200);
    assert.match(page.text, /옆 사람 화면/);
    const roster = await ledger.send(1, 'GET', '/api/roster', { via: lan, neighbor: true });
    assert.equal(roster.status, 200);
    assert.equal(roster.json.length, 20);
    // 2번 앱도 열리기는 한다. 로그인에서 막힐 뿐이다.
    assert.equal((await ledger.send(2, 'GET', '/neighbor', { via: lan })).status, 200);
    assert.equal((await ledger.send(2, 'GET', '/api/roster', { via: lan, neighbor: true })).status, 401);
    // 켜기 전에 한 로그인이 그대로 통한다(프로그램을 다시 실행하지 않았다).
    const me = await ledger.send(2, 'GET', '/api/me', { who: teacher, via: lan });
    assert.equal(me.status, 200);
    assert.equal(me.json.loginId, 'teacher');

    const state = await logMatchesLedger('① 켠 뒤');
    const viaLan = state.accessLog.entries.filter((entry) => entry.clientAddress.endsWith(lan));
    assert.equal(viaLan.length, 5);
    // 이 검사는 같은 PC에서 보낸 것이므로 '다른 기기'로 표시되지 않는 것이 맞다(실제 다른 기기 줄은 사람이 두 대로 확인한다).
    assert.ok(viaLan.every((entry) => entry.samePc === true && entry.sourceLabel === '같은 PC'));

    // 진행 화면은 켜져 있어도 내부 주소로는 연결 자체가 되지 않는다.
    const consoleViaLan = await Promise.all(sw.addresses.flatMap((address) => [
      tryConnect(address, consolePort),
      fetch(`http://${address}:${consolePort}/api/state`, { signal: AbortSignal.timeout(5000) }).then(() => 'open', () => 'failed'),
    ]));
    assert.ok(consoleViaLan.every((result) => result !== 'open'), `내부 주소로 진행 화면이 열렸다: ${consoleViaLan}`);

    // 끄면: 다시 연결되지 않는다. 같은 PC 주소로는 계속 열려 있고 로그인도 그대로다.
    const off = await press('/api/switch', { action: 'off' });
    assert.equal(off.json.state.switch.on, false);
    assert.deepEqual(off.json.state.switch.apps[0].neighborUrls, []);
    const closedAfter = await Promise.all([
      ...[app1, app2, consolePort].map((port) => tryConnect(lan, port)),
      fetch(`http://${lan}:${app1}/api/roster`, { signal: AbortSignal.timeout(5000) }).then(() => 'open', () => 'failed'),
    ]);
    assert.ok(closedAfter.every((result) => result !== 'open'), `끈 뒤에도 내부 주소로 열려 있다: ${closedAfter}`);
    assert.equal((await ledger.send(2, 'GET', '/api/me', { who: teacher })).status, 200);
    assert.equal((await ledger.send(2, 'POST', '/api/logout', { who: teacher })).status, 200);
    await logMatchesLedger('① 끈 뒤');
  });

  await t.test('②: 1번 앱 — 학부모로 로그인해 번호만 바꾸면 반 전체 20명이 나간다', async () => {
    await goTo('scene2');
    const rosterViewsBefore = taken(await rig.state(), 1).rosterViews;

    talk.parent[1] = await ledger.login(1, 'parent01', { neighbor: true });
    assert.deepEqual(talk.parent[1].reply, { role: 'parent', loginId: 'parent01', studentId: 'TEST-1001' });

    const mine = await ledger.send(1, 'GET', '/api/students/TEST-1001', { who: talk.parent[1], neighbor: true });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.json, initialOf('TEST-1001'));
    assert.ok(Object.values(mine.json.ratings).includes('노력요함'), 'TEST-1001의 초기 평가에는 노력요함이 있다');
    assert.equal(taken(await rig.state(), 1).studentCount, 1);

    const other = await ledger.send(1, 'GET', '/api/students/TEST-1002', { who: talk.parent[1], neighbor: true });
    assert.equal(other.status, 200);
    assert.equal(other.json.guardianPhone, '010-XXXX-0002');
    assert.equal(taken(await rig.state(), 1).studentCount, 2);

    // 반 전체 수집: 한 명씩 20번. 인원 수가 실제 응답에 맞춰 올라간다.
    let got = 0;
    for (let n = 1; n <= 20; n += 1) {
      const res = await ledger.send(1, 'GET', `/api/students/${studentId(n)}`, { who: talk.parent[1], neighbor: true });
      assert.equal(res.status, 200);
      got += 1;
      assert.equal(taken(await rig.state(), 1).studentCount, Math.max(2, got), `${n}번째 요청 뒤`);
    }
    const state = await logMatchesLedger('② 1번 앱');
    assert.equal(taken(state, 1).studentCount, 20);
    // 가져간 것은 이름·성적·의견·보호자 연락처까지 들어 있는 기록 전체다.
    assert.deepEqual(taken(state, 1).students, INITIAL);
    assert.equal(taken(state, 1).rosterViews, rosterViewsBefore, '학생 조회는 명단 열람으로 세지 않는다');
    assert.equal(taken(state, 2).studentCount, 0);
  });

  await t.test('②: 2번 앱 — 같은 순서로 해도 자기 아이 1명뿐이고 19번은 거절된다', async () => {
    assert.equal((await ledger.send(2, 'GET', '/api/roster', { neighbor: true })).status, 401);
    talk.parent[2] = await ledger.login(2, 'parent01', { neighbor: true });
    assert.equal((await ledger.send(2, 'GET', '/api/roster', { who: talk.parent[2], neighbor: true })).status, 403);
    assert.equal((await ledger.send(2, 'GET', '/api/students/TEST-1001', { who: talk.parent[2], neighbor: true })).status, 200);
    assert.equal((await ledger.send(2, 'GET', '/api/students/TEST-1002', { who: talk.parent[2], neighbor: true })).status, 403);

    const statuses = [];
    for (let n = 1; n <= 20; n += 1) {
      const res = await ledger.send(2, 'GET', `/api/students/${studentId(n)}`, { who: talk.parent[2], neighbor: true });
      statuses.push(res.status);
      if (res.status !== 200) assert.deepEqual(Object.keys(res.json), ['error'], '거절 응답에는 기록이 들어 있지 않다');
    }
    assert.equal(statuses.filter((status) => status === 200).length, 1);
    assert.equal(statuses.filter((status) => status === 403).length, 19);
    assert.equal(statuses[0], 200);

    const state = await logMatchesLedger('② 2번 앱');
    assert.equal(taken(state, 2).studentCount, 1);
    assert.deepEqual(taken(state, 2).students.map((student) => student.id), ['TEST-1001']);
    assert.equal(taken(state, 2).rosterCount, 0);
    assert.equal(taken(state, 1).studentCount, 20, '1번 앱의 수는 따로 센다');
  });

  await t.test('③: 1번 앱 — 학부모가 담임 기능을 그냥 부르면 반 전체가 나오고 성적이 실제로 바뀐다. 바뀐 기록은 받는 쪽에도 도착한다', async () => {
    await goTo('scene3');
    const list = await ledger.send(1, 'GET', '/api/students', { who: talk.parent[1], neighbor: true });
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 20);

    const fix = await ledger.send(1, 'PUT', '/api/students/TEST-1001/ratings', { who: talk.parent[1], neighbor: true, body: { ratings: ALL_GOOD } });
    assert.equal(fix.status, 200);
    const changed = { ...initialOf('TEST-1001'), ratings: { ...ALL_GOOD } };
    assert.deepEqual(fix.json, changed);

    // 로그인하지 않은 브라우저가 주소 끝에 teacher 를 붙여 연다. 메인 화면 파일이 오고,
    // 그 화면(담임 화면)이 부르는 명단과 반 전체 기록이 로그인 없이 그대로 나온다. 방금 바뀐 성적도 들어 있다.
    const direct = await ledger.send(1, 'GET', '/teacher');
    assert.equal(direct.status, 200);
    assert.equal(direct.text, (await ledger.send(1, 'GET', '/')).text, '첫 화면과 같은 파일이다');
    const openRoster = await ledger.send(1, 'GET', '/api/roster');
    assert.equal(openRoster.status, 200);
    assert.equal(openRoster.json.length, 20);
    const openAll = await ledger.send(1, 'GET', '/api/students');
    assert.equal(openAll.status, 200);
    assert.deepEqual(openAll.json.find((student) => student.id === 'TEST-1001'), changed);

    // 담임 화면에서 실제로 바뀐 것이 보인다.
    talk.teacher[1] = await ledger.login(1, 'teacher');
    const seen = await ledger.send(1, 'GET', '/api/students/TEST-1001', { who: talk.teacher[1] });
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.json.ratings, ALL_GOOD);
    assert.notDeepEqual(seen.json.ratings, initialOf('TEST-1001').ratings);

    // 이 성적 고치기 요청 하나로 이미 받는 쪽 온라인 표에 한 줄이 도착한다(④보다 먼저).
    const state = await waitFor(async () => {
      const now = await rig.state();
      return now.receiver.sheetCount === 1 ? now : null;
    }, 5000, '③의 성적 고치기가 받는 쪽에 도착하지 않았다');
    assert.equal(state.receiver.reachable, true);
    assert.deepEqual(state.receiver.sheet[0].payload, changed, '전체 기록이 그대로 도착한다');
    assert.deepEqual(Object.keys(state.receiver.sheet[0].payload), ['id', 'name', 'className', 'ratings', 'comment', 'guardianName', 'guardianPhone']);
    assert.match(state.receiver.sheet[0].from, /127\.0\.0\.1$/);
    assert.ok(!Number.isNaN(Date.parse(state.receiver.sheet[0].receivedAt)));
    assert.equal(state.receiver.aiCount, 0);
    // 진행 화면이 보여주는 것은 받는 쪽 프로그램이 실제로 갖고 있는 것과 같다.
    assert.deepEqual(state.receiver.sheet, (await rig.held()).sheet);

    // 성적 고치기의 응답은 '가져간 것'으로 세지 않는다. 반 전체 받기는 이미 가져간 20명과 같은 학생들이다.
    assert.equal(taken(state, 1).studentCount, 20);
    assert.deepEqual(logRows(state), ledger.sent);
  });

  await t.test('③: 2번 앱 — 같은 요청이 403이고 아무것도 바뀌지 않으며 받는 쪽에도 가지 않는다', async () => {
    const list = await ledger.send(2, 'GET', '/api/students', { who: talk.parent[2], neighbor: true });
    assert.equal(list.status, 403);
    assert.deepEqual(Object.keys(list.json), ['error']);
    const fix = await ledger.send(2, 'PUT', '/api/students/TEST-1001/ratings', { who: talk.parent[2], neighbor: true, body: { ratings: ALL_GOOD } });
    assert.equal(fix.status, 403);

    // 같은 주소(/teacher)를 2번 앱에서 열면 화면 파일은 똑같이 오지만, 그 화면이 부르는 요청은 로그인이 없어 거절된다.
    const direct = await ledger.send(2, 'GET', '/teacher');
    assert.equal(direct.status, 200);
    assert.equal(direct.text, (await ledger.send(1, 'GET', '/teacher')).text, '두 앱이 같은 파일을 내준다');
    for (const urlPath of ['/api/roster', '/api/students']) {
      const refused = await ledger.send(2, 'GET', urlPath);
      assert.equal(refused.status, 401, urlPath);
      assert.deepEqual(Object.keys(refused.json), ['error']);
    }

    talk.teacher[2] = await ledger.login(2, 'teacher');
    const seen = await ledger.send(2, 'GET', '/api/students/TEST-1001', { who: talk.teacher[2] });
    assert.deepEqual(seen.json, initialOf('TEST-1001'), '2번 앱의 기록은 그대로다');

    await rig.demo.apps.app2.whenIdle();
    const state = await logMatchesLedger('③ 2번 앱');
    assert.equal(state.receiver.sheetCount, 1, '거절된 요청은 받는 쪽으로 아무것도 보내지 않는다');
    assert.equal(taken(state, 2).studentCount, 1);
  });

  await t.test('④: 담임이 1번 앱에서 성적 저장·AI 초안 → 받는 쪽에 도착. 학생 기록 삭제 → 앱에서는 사라지고 받는 쪽에는 그대로', async () => {
    await goTo('scene4');
    const teacher = talk.teacher[1];
    const target = 'TEST-1005'; // 발표 안내서대로 TEST-1001·TEST-1002가 아닌 학생

    const saved = await ledger.send(1, 'PUT', `/api/students/${target}/ratings`, { who: teacher, body: { ratings: { 국어: '잘함', 수학: '노력요함' } } });
    assert.equal(saved.status, 200);
    const record = { ...initialOf(target), ratings: { ...initialOf(target).ratings, 국어: '잘함', 수학: '노력요함' } };
    assert.deepEqual(saved.json, record);
    assert.deepEqual(Object.keys(saved.json).sort(), Object.keys(initialOf(target)).sort(), '저장 응답은 다른 곳으로 보낸다는 것을 알리지 않는다');

    const draft = await ledger.send(1, 'POST', `/api/students/${target}/ai-draft`, { who: teacher });
    assert.equal(draft.status, 200);
    assert.deepEqual(Object.keys(draft.json), ['draft']);
    assert.ok(draft.json.draft.includes(MOCK_LABEL), '초안에 모의 응답 표시가 있다');
    assert.match(draft.json.draft, /국어, 과학 시간에 배운 내용을 잘 이해/);
    assert.match(draft.json.draft, /수학 시간에는 기초를 다지는/);

    const arrived = await waitFor(async () => {
      const now = await rig.state();
      return now.receiver.sheetCount === 2 && now.receiver.aiCount === 1 ? now : null;
    }, 5000, '④의 저장·초안이 받는 쪽에 도착하지 않았다');
    assert.deepEqual(arrived.receiver.sheet[1].payload, record);
    // AI 서비스로는 네 항목만 간다(보호자 정보는 가지 않는다).
    assert.deepEqual(arrived.receiver.ai[0].payload, { id: target, name: record.name, ratings: record.ratings, comment: record.comment });
    const heldBefore = await rig.held();
    assert.deepEqual([heldBefore.sheet.length, heldBefore.ai.length], [2, 1]);
    assert.deepEqual(arrived.receiver.sheet, heldBefore.sheet);
    assert.deepEqual(arrived.receiver.ai, heldBefore.ai);
    assert.deepEqual(arrived.receiver.failedTransfers, []);

    // 삭제
    const removed = await ledger.send(1, 'DELETE', `/api/students/${target}`, { who: teacher });
    assert.equal(removed.status, 200);
    assert.equal((await ledger.send(1, 'GET', `/api/students/${target}`, { who: teacher })).status, 404);
    const roster = await ledger.send(1, 'GET', '/api/roster', { who: teacher });
    assert.equal(roster.json.length, 19);
    assert.ok(!roster.json.some((item) => item.id === target));
    assert.equal((await ledger.send(1, 'DELETE', `/api/students/${target}`, { who: teacher })).status, 404, '이미 지운 학생을 다시 지우면 404');

    // 2번 앱에는 그대로 있다(앱마다 자기 사본).
    const inApp2 = await ledger.send(2, 'GET', `/api/students/${target}`, { who: talk.teacher[2] });
    assert.equal(inApp2.status, 200);
    assert.deepEqual(inApp2.json, initialOf(target));

    // 삭제는 받는 쪽으로 아무것도 보내지 않았고, 받는 쪽은 받은 것을 그대로 갖고 있다.
    await rig.demo.apps.app1.whenIdle();
    assert.deepEqual(await rig.held(), heldBefore);
    const transfers = rig.demo.apps.app1.getTransferLog();
    assert.deepEqual(transfers.map((entry) => [entry.kind, entry.studentId, entry.ok]), [
      ['sheet', 'TEST-1001', true], ['sheet', target, true], ['ai', target, true],
    ]);
    assert.ok(transfers.every((entry) => entry.destination.startsWith(`${rig.receiverBase}/`)), '보낸 곳은 정해 둔 받는 쪽 하나뿐이다');
    const state = await logMatchesLedger('④');
    assert.deepEqual([state.receiver.sheetCount, state.receiver.aiCount], [2, 1]);
    assert.ok(state.receiver.sheet.some((item) => item.payload.id === target), '지운 학생의 기록이 받는 쪽에는 남아 있다');
  });

  await t.test('④: 다른 곳으로 보내는 것은 2번 앱도 똑같다', async () => {
    const teacher = talk.teacher[2];
    const saved = await ledger.send(2, 'PUT', '/api/students/TEST-1006/ratings', { who: teacher, body: { ratings: { 영어: '보통' } } });
    assert.equal(saved.status, 200);
    const draft = await ledger.send(2, 'POST', '/api/students/TEST-1006/ai-draft', { who: teacher });
    assert.equal(draft.status, 200);
    assert.ok(draft.json.draft.includes(MOCK_LABEL));

    const state = await waitFor(async () => {
      const now = await rig.state();
      return now.receiver.sheetCount === 3 && now.receiver.aiCount === 2 ? now : null;
    }, 5000, '2번 앱의 저장·초안이 받는 쪽에 도착하지 않았다');
    assert.deepEqual(state.receiver.sheet[2].payload, saved.json);
    assert.equal(state.receiver.ai[1].payload.id, 'TEST-1006');
    assert.deepEqual(Object.keys(state.receiver.ai[1].payload), ['id', 'name', 'ratings', 'comment']);
    talk.sheetBeforeReveal = 3;
  });

  await t.test('공개 전: 진행 화면 어디에도 어느 앱인지, 권한을 확인했는지가 나오지 않는다', async () => {
    const res = await call(rig.consoleBase, 'GET', '/api/state?limit=500');
    assert.equal(res.json.revealed, false);
    assert.deepEqual(res.json.reveal, { revealed: false, running: false });
    assert.ok(res.json.accessLog.entries.length > 60);
    for (const entry of res.json.accessLog.entries) {
      assert.ok(!('permissionChecked' in entry) && !('permissionLabel' in entry));
    }
    assert.deepEqual(findForbidden(res.text), []);
  });

  await t.test('공개: 다섯 시도를 두 앱에 실제로 보내고, 돌아온 값이 8.5의 표와 같다', async () => {
    await goTo('reveal');
    const beforeLog = (await rig.state()).accessLog.entries.length;
    assert.equal(beforeLog, ledger.sent.length);

    const res = await press('/api/reveal');
    assert.equal(res.status, 200);
    const state = res.json.state;
    assert.equal(state.revealed, true);
    const reveal = state.reveal;
    assert.equal(reveal.revealed, true);
    assert.equal(reveal.runCount, 1);
    assert.deepEqual(reveal.attempts.map((attempt) => attempt.request), [
      'GET /api/roster', 'GET /api/students/TEST-1001', 'GET /api/students/TEST-1002', 'GET /api/students', 'PUT /api/students/TEST-1001/ratings',
    ]);
    assert.deepEqual(reveal.attempts.map((attempt) => attempt.loginId), [null, 'parent01', 'parent01', 'parent01', 'parent01']);
    assert.deepEqual(reveal.attempts.map((attempt) => attempt.results.app1.status), [200, 200, 200, 200, 200]);
    assert.deepEqual(reveal.attempts.map((attempt) => attempt.results.app2.status), [401, 200, 403, 403, 403]);
    assert.deepEqual(reveal.attempts[4].sent, { ratings: ALL_GOOD });
    // 내용도 실제로 돌아온 것이다: 1번 앱의 명단은 ④에서 한 명을 지웠으므로 19명이다.
    assert.equal(reveal.attempts[0].results.app1.body.length, 19);
    assert.equal(reveal.attempts[3].results.app1.body.length, 19);
    assert.equal(reveal.attempts[2].results.app1.body.id, 'TEST-1002');
    assert.deepEqual(reveal.attempts[1].results.app2.body, initialOf('TEST-1001'));
    for (const index of [0, 2, 3, 4]) assert.deepEqual(Object.keys(reveal.attempts[index].results.app2.body), ['error']);
    assert.deepEqual(reveal.apps.map((app) => [app.key, app.loginStatus, app.logoutStatus]), [['app1', 200, 200], ['app2', 200, 200]]);

    // 공개 뒤에만 나오는 것
    assert.deepEqual(reveal.appWithoutCheck, { key: 'app1', label: '1번 앱' });
    assert.deepEqual(reveal.appWithCheck, { key: 'app2', label: '2번 앱' });
    assert.equal(reveal.notes.length, 3);
    assert.match(reveal.comparisonNotice, /^2번 앱은 .*비교용 예제.*실제 학교 서비스에 그대로 쓸 수 있는 인증 체계가 아닙니다/);
    for (const entry of state.accessLog.entries) {
      const expected = entry.appNo === 2 && !['POST /api/login', 'POST /api/logout'].includes(entry.request);
      assert.equal(entry.permissionChecked, expected, `${entry.app} ${entry.request}`);
      assert.equal(entry.permissionLabel, expected ? '권한 확인함' : '권한 확인 안 함');
    }

    // 다섯 시도는 실제 요청이다: 두 앱의 접속 기록에 그대로 남는다(로그인·로그아웃 포함, 앱마다 7줄).
    const added = state.accessLog.entries.slice(beforeLog);
    assert.equal(added.length, 14);
    const rowsOf = (appNo) => added.filter((entry) => entry.appNo === appNo).map((entry) => [entry.request, entry.status, entry.loginLabel]);
    const expectedRows = (statuses) => [
      ['GET /api/roster', statuses[0], NOT_LOGGED_IN],
      ['POST /api/login', 200, 'parent01'],
      ['GET /api/students/TEST-1001', statuses[1], 'parent01'],
      ['GET /api/students/TEST-1002', statuses[2], 'parent01'],
      ['GET /api/students', statuses[3], 'parent01'],
      ['PUT /api/students/TEST-1001/ratings', statuses[4], 'parent01'],
      ['POST /api/logout', 200, 'parent01'],
    ];
    assert.deepEqual(rowsOf(1), expectedRows([200, 200, 200, 200, 200]));
    assert.deepEqual(rowsOf(2), expectedRows([401, 200, 403, 403, 403]));
    // 공개가 보낸 요청은 '가져간 것'으로 세지 않는다.
    assert.ok(added.every((entry) => entry.fromNeighborScreen === false));
    assert.deepEqual(state.taken.map((item) => item.studentCount), [20, 1]);

    // 다섯 번째 시도는 1번 앱에서 실제로 받아들여졌으므로 그 기록이 받는 쪽에 한 줄 더 간다(2번 앱에서는 가지 않는다).
    const arrived = await waitFor(async () => {
      const now = await rig.state();
      return now.receiver.sheetCount === talk.sheetBeforeReveal + 1 ? now : null;
    }, 5000, '공개의 다섯 번째 시도가 받는 쪽에 도착하지 않았다');
    assert.equal(arrived.receiver.sheet.at(-1).payload.id, 'TEST-1001');
    assert.deepEqual(arrived.receiver.sheet.at(-1).payload.ratings, ALL_GOOD);
    assert.equal(arrived.receiver.aiCount, 2);
    // 2번 앱의 TEST-1001은 여전히 초기값이다.
    const inApp2 = await call(rig.bases[2], 'GET', '/api/students/TEST-1001', { cookie: talk.teacher[2].cookie });
    assert.deepEqual(inApp2.json, initialOf('TEST-1001'));

    // 다시 누르면 다시 보낸다(받는 쪽에 한 줄이 또 간다).
    const again = await press('/api/reveal');
    assert.equal(again.json.state.reveal.runCount, 2);
    assert.deepEqual(again.json.state.reveal.attempts.map((attempt) => attempt.results.app2.status), [401, 200, 403, 403, 403]);
    await waitFor(async () => (await rig.state()).receiver.sheetCount === talk.sheetBeforeReveal + 2, 5000, '두 번째 공개가 받는 쪽에 도착하지 않았다');
  });

  await t.test('2부: 순서대로만 나아가고, 순서를 어기는 요청은 거절된다. 데이터는 어디로도 나가지 않는다', async () => {
    await goTo('part2');
    const heldBefore = await rig.held();
    const logBefore = (await rig.state()).accessLog.total;
    const p2 = async (body) => {
      const res = await press('/api/part2', body);
      return { status: res.status, error: res.json.error, view: res.json.state.part2 };
    };
    const refused = async (body, stage) => {
      const res = await p2(body);
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.match(res.error, /[가-힣]/);
      assert.equal(res.view.stage, stage, '거절된 요청은 아무것도 바꾸지 않는다');
      return res;
    };

    let view = (await rig.state()).part2;
    assert.equal(view.stage, 'journal');
    assert.equal(view.subject, '가상학생07');
    assert.equal(view.journal.length, 5);
    assert.deepEqual([view.facts, view.ai, view.choices, view.comparison, view.explanation], [null, null, null, null, null]);
    assert.deepEqual(view.contexts, []);

    // 위반: 첫 선택 전에 맥락 열기·선택하기
    await refused({ action: 'context' }, 'journal');
    await refused({ action: 'choose', which: 'first', choice: 'talk' }, 'journal');

    assert.equal((await p2({ action: 'next' })).view.stage, 'facts');
    view = (await p2({ action: 'next' })).view;
    assert.equal(view.stage, 'ai');
    assert.match(view.ai.label, /사전 작성된 모의 응답입니다\. 실제 AI를 호출하지 않았습니다/);
    view = (await p2({ action: 'next' })).view;
    assert.equal(view.stage, 'firstChoice');
    assert.deepEqual(view.choices.map((choice) => choice.label), ['바로 상담 의뢰·보호자 연락', '학생과 먼저 대화', '며칠 더 관찰']);

    // 위반: 첫 선택 없이 다음으로, 첫 선택 없이 맥락, 없는 선택지, 다시 선택 먼저
    await refused({ action: 'next' }, 'firstChoice');
    await refused({ action: 'context' }, 'firstChoice');
    await refused({ action: 'choose', which: 'first', choice: '없는 선택지' }, 'firstChoice');
    await refused({ action: 'choose', which: 'second', choice: 'talk' }, 'firstChoice');

    view = (await p2({ action: 'choose', which: 'first', choice: 'refer' })).view;
    assert.deepEqual(view.firstChoice, { id: 'refer', label: '바로 상담 의뢰·보호자 연락' });

    // 맥락은 누를 때마다 하나씩, 모두 네 개
    view = (await p2({ action: 'context' })).view;
    assert.equal(view.stage, 'context');
    assert.equal(view.contexts.length, 1);
    await refused({ action: 'next' }, 'context'); // 네 개를 다 열기 전에는 넘어갈 수 없다
    await refused({ action: 'choose', which: 'second', choice: 'observe' }, 'context'); // 다시 선택도 아직
    await refused({ action: 'choose', which: 'first', choice: 'talk' }, 'context'); // 첫 선택은 이제 바꿀 수 없다
    for (const count of [2, 3, 4]) {
      view = (await p2({ action: 'context' })).view;
      assert.equal(view.contexts.length, count);
    }
    assert.equal(view.stage, 'secondChoice');
    assert.deepEqual(view.contexts.map((item) => item.day), ['월', '화', '수', '금']);
    await refused({ action: 'context' }, 'secondChoice'); // 다섯 번째는 없다
    await refused({ action: 'next' }, 'secondChoice'); // 다시 선택 없이 나란히 보기로 갈 수 없다

    view = (await p2({ action: 'choose', which: 'second', choice: 'observe' })).view;
    assert.deepEqual(view.firstChoice.id, 'refer', '첫 선택은 그대로 남아 있다');
    view = (await p2({ action: 'next' })).view;
    assert.equal(view.stage, 'compare');
    assert.deepEqual(view.comparison, {
      first: { id: 'refer', label: '바로 상담 의뢰·보호자 연락' },
      second: { id: 'observe', label: '며칠 더 관찰' },
      changed: true,
      message: '선택이 바뀌었습니다',
    });
    await refused({ action: 'choose', which: 'second', choice: 'talk' }, 'compare');

    view = (await p2({ action: 'next' })).view;
    assert.equal(view.stage, 'explain');
    assert.deepEqual(view.explanation.concepts.map((item) => item.term), ['앵커링', '자동화 편향']);
    assert.ok(view.explanation.messages.some((item) => item.text === '학생이 표현한 감정은 관찰 자료이지, 학생의 심리 상태에 대한 확정적인 진단이 아닙니다.'));
    assert.ok(view.explanation.messages.some((item) => item.text === '학생의 개인정보·민감정보를 외부 AI 서비스에 보내면 안 됩니다.'));
    await refused({ action: 'next' }, 'explain');

    // 2부 동안 받는 쪽에는 아무것도 가지 않았고, 두 앱에도 요청이 가지 않았다.
    assert.deepEqual(await rig.held(), heldBefore);
    assert.equal((await rig.state()).accessLog.total, logBefore);
  });

  await t.test('마무리: 일곱 문장이 차례로 나온다', async () => {
    await goTo('closing');
    const state = await rig.state();
    assert.equal(state.step.hasNext, false);
    assert.deepEqual(state.closing.sentences.map((sentence) => sentence.no), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(state.closing.sentences[5].text, '개발은 자유롭게, 개인정보 처리는 신중하게.');
    assert.deepEqual(state.closing.sentences.map((sentence) => sentence.emphasis), [false, false, false, false, false, true, false]);
    assert.equal((await press('/api/step', { to: 'next' })).status, 409);
  });

  await t.test('전체 초기화: 모두 처음으로 돌아가고 받는 쪽도 비워진다. 받는 쪽 주소와 스위치 상태는 그대로다', async () => {
    // 스위치를 켜 둔 채로 초기화한다(스위치 상태가 유지되는지 보기 위해).
    const on = await press('/api/switch', { action: 'on', confirmed: true });
    assert.equal(on.json.state.switch.on, true);
    const before = await rig.state();
    assert.ok(before.accessLog.total > 80);
    assert.ok(before.receiver.sheetCount >= 5);
    assert.equal(before.revealed, true);

    const res = await press('/api/reset');
    assert.equal(res.status, 200);
    assert.equal(res.json.receiverCleared, true);
    assert.equal(res.json.notice, null);
    const state = res.json.state;
    assert.equal(state.step.id, 'start');
    assert.deepEqual(state.accessLog.entries, []);
    assert.equal(state.accessLog.total, 0);
    assert.deepEqual(state.taken.map((item) => [item.studentCount, item.rosterCount, item.rosterViews]), [[0, 0, 0], [0, 0, 0]]);
    assert.equal(state.revealed, false);
    assert.deepEqual(state.reveal, { revealed: false, running: false });
    assert.equal(state.part2.stage, 'journal');
    assert.deepEqual([state.part2.firstChoice, state.part2.secondChoice, state.part2.contexts], [null, null, []]);
    assert.equal(state.closing, null);
    assert.equal(state.receiver.reachable, true);
    assert.deepEqual([state.receiver.sheetCount, state.receiver.aiCount], [0, 0]);
    assert.deepEqual(state.receiver.failedTransfers, []);
    assert.equal(state.lastReset.receiverCleared, true);
    assert.deepEqual(findForbidden(JSON.stringify(state)), [], '초기화 뒤에는 다시 공개 전 상태다');
    // 받는 쪽 프로그램이 실제로 비워졌다.
    assert.deepEqual(await rig.held(), { sheet: [], ai: [] });

    // 받는 쪽 주소와 스위치 상태는 유지된다(남은 시간도 다시 시작하지 않는다).
    assert.equal(state.receiver.host, before.receiver.host);
    assert.equal(state.receiver.port, before.receiver.port);
    assert.equal(state.switch.on, true);
    assert.ok(state.switch.remainingMs <= before.switch.remainingMs);

    // 모든 로그인 상태가 무효다: 예전 쿠키로는 로그인 안 한 것으로 다뤄진다.
    for (const appNo of [1, 2]) {
      for (const who of [talk.parent[appNo], talk.teacher[appNo]]) {
        assert.equal((await call(rig.bases[appNo], 'GET', '/api/me', { cookie: who.cookie })).status, 401);
      }
      assert.equal((await call(rig.bases[appNo], 'GET', '/api/students/TEST-1001', { cookie: talk.teacher[appNo].cookie })).status, 401);
    }
    // 두 앱의 학생 20명이 원래대로 돌아왔다(지운 학생, 고친 성적 모두).
    for (const appNo of [1, 2]) {
      const login = await call(rig.bases[appNo], 'POST', '/api/login', { body: { loginId: 'teacher', password: 'teacher1234' } });
      const list = await call(rig.bases[appNo], 'GET', '/api/students', { cookie: login.cookie });
      assert.deepEqual(list.json, INITIAL);
    }
    for (const subject of SUBJECTS) assert.ok(subject in INITIAL[0].ratings);

    const off = await press('/api/switch', { action: 'off' });
    assert.equal(off.json.state.switch.on, false);
  });
});
