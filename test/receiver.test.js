// 받는 쪽 프로그램: 다섯 요청, 거절 규칙, 초안 규칙, 화면 파일 (명세 6, 11)
// 실제 서버를 빈 포트에 띄우고 실제 요청으로 확인한다. 브라우저는 열지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReceiver, buildDraft, validateSheetRow, validateAiRequest } from '../src/receiver/server.js';
import { createStudents, SUBJECTS } from '../src/shared/data.js';

const KOREAN = /[가-힣]/;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'receiver', 'public');

/** 내부 주소가 없는 것처럼 꾸며서(다른 기기 쪽으로는 아무것도 열지 않게) 받는 쪽을 띄운다. */
async function start(t, options = {}) {
  const receiver = createReceiver({ switchOptions: { listAddresses: () => [], ...(options.switchOptions || {}) }, ...options, port: 0 });
  t.after(() => receiver.close());
  const { url } = await receiver.listen();
  return { receiver, url };
}

function post(url, body, headers = { 'Content-Type': 'application/json' }) {
  return fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

const student = (number) => createStudents()[number - 1];
const aiBody = (number) => {
  const { id, name, ratings, comment } = student(number);
  return { id, name, ratings, comment };
};

async function received(url) {
  const res = await fetch(`${url}/api/received`);
  assert.equal(res.status, 200);
  return res.json();
}

async function assertRejected(t, url, pathname, body, label) {
  const res = await post(`${url}${pathname}`, body);
  assert.equal(res.status, 400, `${label}: 400이어야 한다`);
  const json = await res.json();
  assert.deepEqual(Object.keys(json), ['error'], label);
  assert.match(json.error, KOREAN, label);
  assert.deepEqual(await received(url), { sheet: [], ai: [] }, `${label}: 아무것도 저장되지 않아야 한다`);
}

test('연결 확인: GET /api/ping', async (t) => {
  const { url } = await start(t);
  const res = await fetch(`${url}/api/ping`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'receiver' });
});

test('처음에는 받은 것이 없다', async (t) => {
  const { url } = await start(t);
  assert.deepEqual(await received(url), { sheet: [], ai: [] });
});

test('온라인 표: 받은 줄이 순서대로 쌓이고, 항목은 {receivedAt, from, payload}다', async (t) => {
  const { url } = await start(t);
  for (const number of [3, 1, 20]) {
    const res = await post(`${url}/sheet/rows`, student(number));
    assert.equal(res.status, 200);
  }
  const { sheet, ai } = await received(url);
  assert.deepEqual(ai, []);
  assert.deepEqual(sheet.map((item) => item.payload.id), ['TEST-1003', 'TEST-1001', 'TEST-1020']);
  for (const item of sheet) {
    assert.deepEqual(Object.keys(item), ['receivedAt', 'from', 'payload']);
    assert.equal(new Date(item.receivedAt).toISOString(), item.receivedAt);
    assert.equal(item.from, '127.0.0.1');
  }
  assert.deepEqual(sheet[0].payload, student(3));
  assert.deepEqual(sheet[2].payload, student(20));
});

test('AI 서비스: 받은 내용을 기록하고 초안을 돌려준다', async (t) => {
  const { url } = await start(t);
  const res = await post(`${url}/ai/draft`, aiBody(1));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(Object.keys(json), ['draft']);
  assert.equal(typeof json.draft, 'string');
  assert.match(json.draft, /사전 작성된 모의 응답/);

  await post(`${url}/ai/draft`, aiBody(2));
  const { sheet, ai } = await received(url);
  assert.deepEqual(sheet, []);
  assert.equal(ai.length, 2);
  assert.deepEqual(Object.keys(ai[0]), ['receivedAt', 'from', 'payload']);
  assert.deepEqual(ai[0].payload, aiBody(1));
  assert.deepEqual(ai[1].payload, aiBody(2));
  assert.equal(ai[0].from, '127.0.0.1');
  assert.ok(ai[0].receivedAt <= ai[1].receivedAt);
});

test('같은 학생을 여러 번 받으면 덮어쓰지 않고 줄이 계속 추가된다', async (t) => {
  const { url } = await start(t);
  const first = student(1);
  const changed = { ...student(1), ratings: Object.fromEntries(SUBJECTS.map((s) => [s, '잘함'])) };
  await post(`${url}/sheet/rows`, first);
  await post(`${url}/sheet/rows`, changed);
  await post(`${url}/sheet/rows`, first);
  await post(`${url}/ai/draft`, aiBody(1));
  await post(`${url}/ai/draft`, aiBody(1));
  const { sheet, ai } = await received(url);
  assert.equal(sheet.length, 3);
  assert.equal(ai.length, 2);
  assert.deepEqual(sheet[0].payload, first);
  assert.deepEqual(sheet[1].payload, changed);
  assert.deepEqual(sheet[2].payload, first);
});

test('모두 지우기: POST /api/clear 뒤에는 비어 있고, 다시 받을 수 있다', async (t) => {
  const { url } = await start(t);
  await post(`${url}/sheet/rows`, student(5));
  await post(`${url}/ai/draft`, aiBody(5));
  const res = await fetch(`${url}/api/clear`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await received(url), { sheet: [], ai: [] });
  await post(`${url}/sheet/rows`, student(6));
  assert.equal((await received(url)).sheet.length, 1);
});

test('거절: 학생 번호가 TEST-1001~TEST-1020 모양이 아니면 저장하지 않는다', async (t) => {
  const { url } = await start(t);
  const badIds = ['TEST-1021', 'TEST-1000', 'TEST-10011', 'TEST-101', 'test-1001', ' TEST-1001', 'TEST-1001 ',
    '20250317', '2025-6-3-17', '홍길동', '', 1001, null, ['TEST-1001'], { id: 'TEST-1001' }];
  for (const id of badIds) {
    await assertRejected(t, url, '/sheet/rows', { ...student(1), id }, `표 id=${JSON.stringify(id)}`);
    await assertRejected(t, url, '/ai/draft', { ...aiBody(1), id }, `AI id=${JSON.stringify(id)}`);
  }
});

test('거절: 정해진 항목 외의 것이 있으면 저장하지 않는다', async (t) => {
  const { url } = await start(t);
  await assertRejected(t, url, '/sheet/rows', { ...student(1), memo: '추가 메모' }, '표 + memo');
  await assertRejected(t, url, '/sheet/rows', { ...student(1), address: '어딘가' }, '표 + address');
  await assertRejected(t, url, '/ai/draft', { ...aiBody(1), guardianPhone: '010-XXXX-0001' }, 'AI + guardianPhone');
  await assertRejected(t, url, '/ai/draft', student(1), 'AI에 전체 기록');
  await assertRejected(t, url, '/sheet/rows', { ...student(1), ratings: { ...student(1).ratings, 체육: '잘함' } }, '표 ratings + 체육');
});

test('거절: 빠진 항목이 있으면 저장하지 않는다', async (t) => {
  const { url } = await start(t);
  for (const key of Object.keys(student(1))) {
    const body = student(1);
    delete body[key];
    await assertRejected(t, url, '/sheet/rows', body, `표 - ${key}`);
  }
  for (const key of Object.keys(aiBody(1))) {
    const body = aiBody(1);
    delete body[key];
    await assertRejected(t, url, '/ai/draft', body, `AI - ${key}`);
  }
  await assertRejected(t, url, '/sheet/rows', {}, '빈 객체');
  await assertRejected(t, url, '/sheet/rows', '', '빈 본문');
  await assertRejected(t, url, '/ai/draft', '', 'AI 빈 본문');
});

test('거절: 평가의 과목이나 값이 정해진 것이 아니면 저장하지 않는다', async (t) => {
  const { url } = await start(t);
  const base = student(1).ratings;
  const wrong = [
    { ...base, 국어: '최우수' },
    { ...base, 국어: 95 },
    { ...base, 국어: null },
    { 국어: '잘함' },
    {},
    null,
    '잘함',
    ['잘함', '잘함', '잘함', '잘함', '잘함'],
    { 국어: '잘함', 수학: '잘함', 사회: '잘함', 과학: '잘함', 체육: '잘함' },
  ];
  for (const ratings of wrong) {
    await assertRejected(t, url, '/sheet/rows', { ...student(1), ratings }, `표 ratings=${JSON.stringify(ratings)}`);
    await assertRejected(t, url, '/ai/draft', { ...aiBody(1), ratings }, `AI ratings=${JSON.stringify(ratings)}`);
  }
});

test('거절: 글자가 아닌 값, 가상 데이터 모양이 아닌 값, 너무 긴 글', async (t) => {
  const { url } = await start(t);
  await assertRejected(t, url, '/sheet/rows', { ...student(1), comment: 123 }, 'comment 숫자');
  await assertRejected(t, url, '/sheet/rows', { ...student(1), comment: { text: '의견' } }, 'comment 객체');
  await assertRejected(t, url, '/sheet/rows', { ...student(1), comment: '가'.repeat(301) }, 'comment 301자');
  await assertRejected(t, url, '/ai/draft', { ...aiBody(1), comment: '가'.repeat(301) }, 'AI comment 301자');
  await assertRejected(t, url, '/sheet/rows', { ...student(1), name: '홍길동' }, '실제 같은 이름');
  await assertRejected(t, url, '/ai/draft', { ...aiBody(1), name: '홍길동' }, 'AI 실제 같은 이름');
  await assertRejected(t, url, '/sheet/rows', { ...student(1), name: '가상학생02' }, '번호가 다른 이름');
  await assertRejected(t, url, '/sheet/rows', { ...student(1), className: '6학년 3반' }, '다른 반 이름');
  await assertRejected(t, url, '/sheet/rows', { ...student(1), guardianName: '김보호' }, '실제 같은 보호자 이름');
  await assertRejected(t, url, '/sheet/rows', { ...student(1), guardianPhone: '010-1234-5678' }, '실제 같은 전화번호');
  await assertRejected(t, url, '/sheet/rows', { ...student(1), guardianPhone: '010-XXXX-0002' }, '번호가 다른 연락처');
  await assertRejected(t, url, '/sheet/rows', [student(1)], '배열');
  await assertRejected(t, url, '/sheet/rows', 'null', 'null');
  await assertRejected(t, url, '/sheet/rows', '"TEST-1001"', '글자 하나');
});

test('거절: 본문이 16KB를 넘으면 400이고 저장하지 않는다', async (t) => {
  const { url } = await start(t);
  const big = { ...student(1), comment: 'a'.repeat(17 * 1024) };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > 16 * 1024);
  await assertRejected(t, url, '/sheet/rows', big, '표 17KB');
  await assertRejected(t, url, '/ai/draft', { ...aiBody(1), comment: 'a'.repeat(17 * 1024) }, 'AI 17KB');
  // 올바른 기록 뒤에 빈칸을 붙여 크기만 넘긴 것도 거절한다.
  await assertRejected(t, url, '/sheet/rows', JSON.stringify(student(1)) + ' '.repeat(16 * 1024), '빈칸으로 부풀림');
  // 훨씬 큰 것도 400으로 거절하고 프로그램은 계속 돈다.
  const res = await post(`${url}/sheet/rows`, 'x'.repeat(300 * 1024));
  assert.equal(res.status, 400);
  assert.deepEqual(await received(url), { sheet: [], ai: [] });
});

test('거절: JSON으로 읽을 수 없는 본문', async (t) => {
  const { url } = await start(t);
  await assertRejected(t, url, '/sheet/rows', '{"id":"TEST-1001",', '잘린 JSON');
  await assertRejected(t, url, '/ai/draft', '안녕하세요', '그냥 글자');
  await assertRejected(t, url, '/sheet/rows', 'id=TEST-1001&name=x', '폼 모양');
});

test('거절된 요청 뒤에도 올바른 요청은 그대로 받는다', async (t) => {
  const { url } = await start(t);
  await post(`${url}/sheet/rows`, { ...student(1), id: 'TEST-1021' });
  const ok = await post(`${url}/sheet/rows`, student(1));
  assert.equal(ok.status, 200);
  assert.equal((await received(url)).sheet.length, 1);
});

test('초안: 미리 써 둔 문장이며 받은 평가의 과목 이름만 끼워 넣는다', () => {
  const allSubjects = new Set(SUBJECTS);
  const templateWords = buildDraft(Object.fromEntries(SUBJECTS.map((s) => [s, '보통'])));
  assert.match(templateWords, /사전 작성된 모의 응답/);
  for (const subject of SUBJECTS) assert.ok(!templateWords.includes(subject), `모두 보통이면 ${subject}가 나오면 안 된다`);

  for (const record of createStudents()) {
    const draft = buildDraft(record.ratings);
    assert.match(draft, /사전 작성된 모의 응답/);
    for (const subject of allSubjects) {
      const value = record.ratings[subject];
      const expected = value === '잘함' || value === '노력요함';
      assert.equal(draft.includes(subject), expected, `${record.id} ${subject}(${value})`);
    }
  }
});

test('초안: 이름·의견 같은 받은 글자는 초안에 들어가지 않고, 같은 평가에는 같은 초안이 나온다', async (t) => {
  const { url } = await start(t);
  const body = aiBody(4);
  const one = await (await post(`${url}/ai/draft`, body)).json();
  const two = await (await post(`${url}/ai/draft`, body)).json();
  assert.equal(one.draft, two.draft);
  assert.equal(one.draft, buildDraft(body.ratings));
  assert.ok(!one.draft.includes(body.name));
  assert.ok(!one.draft.includes(body.comment));
  assert.ok(!one.draft.includes(body.id));
  // 잘함: 국어·영어, 노력요함: 사회 (TEST-1004)
  assert.ok(one.draft.includes('국어') && one.draft.includes('영어') && one.draft.includes('사회'));
  assert.ok(!one.draft.includes('수학') && !one.draft.includes('과학'));
});

test('확인 함수: validateSheetRow / validateAiRequest', () => {
  assert.equal(validateSheetRow(student(1)).ok, true);
  assert.equal(validateAiRequest(aiBody(1)).ok, true);
  assert.equal(validateSheetRow(aiBody(1)).ok, false);
  assert.equal(validateAiRequest(student(1)).ok, false);
  assert.equal(validateSheetRow(JSON.parse(JSON.stringify(student(1)).replace('{', '{"__proto__":{},'))).ok, false);
  assert.match(validateSheetRow({}).error, KOREAN);
});

test('다섯 요청 말고는 없다: 모르는 경로 404, 맞지 않는 방식 405 (한국어)', async (t) => {
  const { url } = await start(t);
  for (const [method, pathname, status] of [
    ['GET', '/api/students', 404],
    ['GET', '/sheet', 404],
    ['GET', '/server.js', 404],
    ['GET', '/..%2fserver.js', 404],
    ['DELETE', '/api/received', 405],
    ['GET', '/sheet/rows', 405],
    ['GET', '/ai/draft', 405],
    ['GET', '/api/clear', 405],
    ['POST', '/api/ping', 405],
  ]) {
    const res = await fetch(`${url}${pathname}`, { method });
    assert.equal(res.status, status, `${method} ${pathname}`);
    assert.match((await res.json()).error, KOREAN);
  }
  assert.deepEqual(await received(url), { sheet: [], ai: [] });
});

test('다른 기기 쪽 문으로 온 요청: 다섯 요청은 되고, 보낸 쪽 주소가 기록된다', async (t) => {
  const receiver = createReceiver({ switchOptions: { listAddresses: () => [] } });
  t.after(() => receiver.close());
  // 스위치가 "다른 기기 쪽 문으로 들어온 요청"이라고 알려 주는 경우를 그대로 만든다(local: false).
  const info = { local: false, clientAddress: '192.168.0.77', samePc: false };
  const door = http.createServer((req, res) => receiver.handler(req, res, info));
  await new Promise((resolve) => door.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { door.close(resolve); door.closeAllConnections(); }));
  const url = `http://127.0.0.1:${door.address().port}`;

  assert.equal((await fetch(`${url}/api/ping`)).status, 200);
  assert.equal((await post(`${url}/sheet/rows`, student(2))).status, 200);
  assert.equal((await post(`${url}/ai/draft`, aiBody(2))).status, 200);
  let data = await received(url);
  assert.equal(data.sheet[0].from, '192.168.0.77');
  assert.equal(data.ai[0].from, '192.168.0.77');
  assert.equal((await fetch(`${url}/api/clear`, { method: 'POST' })).status, 200);
  data = await received(url);
  assert.deepEqual(data, { sheet: [], ai: [] });
});

test('화면 파일: 고정 표시와 흉내 낸 프로그램이라는 안내, 탭, 버튼이 있다', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.ok(html.includes('교육용 실습 / 100% 합성 데이터 / 실제 개인정보 입력 금지'));
  assert.match(html, /흉내 낸/);
  assert.match(html, /실제 (온라인 표|서비스)[^<]*아닙니다/);
  for (const label of ['온라인 표', 'AI 서비스', '받은 내용 모두 지우기', '켜기', '확인', '연장', '끄기']) {
    assert.ok(html.includes(label), `화면에 "${label}"가 있어야 한다`);
  }
  assert.ok(html.includes('전용 실습용 연결에서만 켜세요. 학교 와이파이·공용 와이파이에서는 켜지 마세요'));
  for (const column of ['받은 시각', '보낸 쪽', '학생 번호', '이름', '반', '국어', '수학', '사회', '과학', '영어', '종합의견', '보호자 이름', '보호자 연락처']) {
    assert.ok(html.includes(column), `표에 "${column}" 칸이 있어야 한다`);
  }
});

test('화면 파일: 밖에서 가져오는 것이 없고, 직접 입력하는 칸이 없다', () => {
  const files = fs.readdirSync(PUBLIC_DIR);
  assert.ok(files.includes('index.html'));
  for (const file of files) {
    const text = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    assert.doesNotMatch(text, /https?:\/\//i, `${file}: http(s):// 주소가 없어야 한다`);
    assert.doesNotMatch(text, /(src|href|action)\s*=\s*["']?\s*\/\//i, `${file}: //로 시작하는 주소가 없어야 한다`);
    assert.doesNotMatch(text, /url\(\s*["']?\s*\/\//i, `${file}: url(//…)가 없어야 한다`);
    assert.doesNotMatch(text, /@import|<link[^>]+href\s*=\s*["'](?!\/?[\w.-]+["'])/i, `${file}: 밖의 꾸밈 파일을 가져오지 않는다`);
    assert.doesNotMatch(text, /<input|<textarea|<select|contenteditable|<form/i, `${file}: 입력 칸이 없어야 한다`);
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, `${file}: 받은 값을 글자로만 넣는다`);
    assert.doesNotMatch(text, /\bAPI\b|세션|바인딩/, `${file}: 어려운 낱말을 쓰지 않는다`);
  }
});
