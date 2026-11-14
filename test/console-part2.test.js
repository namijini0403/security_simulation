// 2부 (명세 9): 순서는 서버가 지킨다. 아직 열지 않은 것은 보내지 않는다. 데이터는 어디로도 나가지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as content from '../src/console/content.js';
import { startRig } from './console-helpers.js';

const KOREAN = /[가-힣]/;
const CONTEXTS = [
  '주말 대회 연습으로 며칠 늦게 잤습니다.',
  '못 먹는 반찬이 나온 날이었습니다.',
  '단짝이 결석했습니다.',
  '금요일 방과후 활동이 재미있어서 더 있고 싶었습니다.',
];
const AI_TEXT = '정서적 위축과 가정 내 스트레스가 의심됩니다. 보호자 면담과 전문 상담 연계를 권고합니다.';

async function act(rig, body, expected = 200) {
  const res = await rig.post('/api/part2', body);
  assert.equal(res.status, expected, `${JSON.stringify(body)} → ${res.status} ${res.text}`);
  if (expected !== 200) {
    assert.match(res.json.error, KOREAN);
    assert.ok(res.json.state.part2, '거절해도 지금 상태를 함께 돌려준다');
  }
  return res.json.state.part2;
}

test('2부: 순서대로 열리고, 아직 열지 않은 것은 보내지 않는다', async (t) => {
  const rig = await startRig(t, { receiver: false });
  let p = (await rig.state()).part2;
  assert.equal(p.stage, 'journal');
  assert.equal(p.stageNo, 1);
  assert.equal(p.stageCount, 8);
  assert.equal(p.subject, '가상학생07');
  assert.deepEqual(p.journal, [
    { day: '월', text: '피곤해요.' },
    { day: '화', text: '급식 안 먹었어요.' },
    { day: '수', text: '친구랑 안 놀았어요.' },
    { day: '목', text: '그냥 그래요.' },
    { day: '금', text: '집에 가기 싫어요.' },
  ]);
  const hidden = (state) => JSON.stringify(state);
  assert.equal(p.facts, null);
  assert.equal(p.ai, null);
  assert.equal(p.choices, null);
  assert.deepEqual(p.contexts, []);
  assert.equal(p.comparison, null);
  assert.equal(p.explanation, null);
  assert.ok(!hidden(p).includes('정서적 위축'));
  assert.ok(!hidden(p).includes('단짝'));
  assert.ok(!hidden(p).includes('앵커링'));

  p = await act(rig, { action: 'next' });
  assert.equal(p.stage, 'facts');
  assert.equal(p.facts.length, 3);
  assert.ok(p.facts[0].includes('5일 중 4일'));
  assert.ok(p.facts[2].includes('이유는 일지에 적혀 있지 않'));
  assert.equal(p.ai, null);

  p = await act(rig, { action: 'next' });
  assert.equal(p.stage, 'ai');
  assert.deepEqual(p.ai, { label: '사전 작성된 모의 응답입니다. 실제 AI를 호출하지 않았습니다', text: AI_TEXT });
  assert.equal(p.choices, null);

  p = await act(rig, { action: 'next' });
  assert.equal(p.stage, 'firstChoice');
  assert.deepEqual(p.choices.map((choice) => choice.label), ['바로 상담 의뢰·보호자 연락', '학생과 먼저 대화', '며칠 더 관찰']);
  assert.deepEqual(p.choices.map((choice) => choice.id), ['refer', 'talk', 'observe']);
  assert.equal(p.firstChoice, null);
  assert.equal(p.contextTotal, 4);

  p = await act(rig, { action: 'choose', which: 'first', choice: 'refer' });
  assert.deepEqual(p.firstChoice, { id: 'refer', label: '바로 상담 의뢰·보호자 연락' });
  p = await act(rig, { action: 'choose', which: 'first', choice: 'talk' }); // 맥락을 열기 전에는 고쳐 누를 수 있다
  assert.equal(p.firstChoice.id, 'talk');

  for (let i = 0; i < 4; i += 1) {
    p = await act(rig, { action: 'context' });
    assert.equal(p.contexts.length, i + 1);
    assert.deepEqual(p.contexts.map((item) => item.context), CONTEXTS.slice(0, i + 1));
    for (const later of CONTEXTS.slice(i + 1)) assert.ok(!hidden(p).includes(later), '아직 열지 않은 맥락은 보내지 않는다');
    assert.equal(p.stage, i < 3 ? 'context' : 'secondChoice');
  }
  assert.deepEqual(p.contexts.map((item) => item.day), ['월', '화', '수', '금']);
  assert.equal(p.contexts[0].journal, '피곤해요.');
  assert.match(p.noContextNote, /목/);
  assert.equal(p.secondChoice, null);
  assert.equal(p.comparison, null);

  p = await act(rig, { action: 'choose', which: 'second', choice: 'observe' });
  assert.equal(p.secondChoice.id, 'observe');
  assert.equal(p.comparison, null, '나란히 보기는 다음 단계에서');
  p = await act(rig, { action: 'next' });
  assert.equal(p.stage, 'compare');
  assert.deepEqual(p.comparison, {
    first: { id: 'talk', label: '학생과 먼저 대화' },
    second: { id: 'observe', label: '며칠 더 관찰' },
    changed: true,
    message: '선택이 바뀌었습니다',
  });
  assert.equal(p.explanation, null);

  p = await act(rig, { action: 'next' });
  assert.equal(p.stage, 'explain');
  assert.equal(p.stageNo, 8);
  const explanation = hidden(p.explanation);
  assert.ok(explanation.includes('앵커링'));
  assert.ok(explanation.includes('자동화 편향'));
  assert.ok(explanation.includes('독립적으로 판단하고 검증'));
  assert.deepEqual(p.explanation.messages.map((message) => message.text), [
    '학생이 표현한 감정은 관찰 자료이지, 학생의 심리 상태에 대한 확정적인 진단이 아닙니다.',
    'AI가 생성한 해석은 검증 가능한 가설로 취급해야 하며, 교사는 학생의 직접적인 설명과 관찰, 맥락을 바탕으로 독립적으로 판단해야 합니다.',
    '학생의 개인정보·민감정보를 외부 AI 서비스에 보내면 안 됩니다.',
  ]);
  assert.deepEqual(p.explanation.messages.map((message) => message.emphasis), [true, false, true]);
  await act(rig, { action: 'next' }, 409);

  // 2부는 어디에도 요청을 보내지 않았다.
  assert.equal(rig.app1.getAccessLog().length, 0);
  assert.equal(rig.app2.getAccessLog().length, 0);
  assert.equal(rig.app1.getTransferLog().length + rig.app2.getTransferLog().length, 0);
});

test('2부: 순서를 어기는 요청은 409로 거절하고 아무것도 바뀌지 않는다', async (t) => {
  const rig = await startRig(t, { receiver: false });
  // 일지 단계: 선택도 맥락도 아직이다.
  await act(rig, { action: 'context' }, 409);
  await act(rig, { action: 'choose', which: 'first', choice: 'talk' }, 409);
  await act(rig, { action: 'choose', which: 'second', choice: 'talk' }, 409);
  let p = await act(rig, { action: 'next' });
  p = await act(rig, { action: 'next' });
  await act(rig, { action: 'context' }, 409);
  p = await act(rig, { action: 'next' });
  assert.equal(p.stage, 'firstChoice');

  // 첫 선택 전에는 맥락을 열 수 없고 다음으로도 못 간다.
  p = await act(rig, { action: 'context' }, 409);
  assert.deepEqual(p.contexts, []);
  p = await act(rig, { action: 'next' }, 409);
  assert.equal(p.stage, 'firstChoice');

  // 정해진 세 가지가 아닌 값
  for (const choice of ['diagnose', '', null, 3, 'toString', '__proto__', ['talk'], undefined]) {
    p = await act(rig, { action: 'choose', which: 'first', choice }, 409);
    assert.equal(p.firstChoice, null);
  }
  for (const which of ['third', undefined, 1]) await act(rig, { action: 'choose', which, choice: 'talk' }, 409);

  p = await act(rig, { action: 'choose', which: 'first', choice: 'talk' });
  await act(rig, { action: 'choose', which: 'second', choice: 'talk' }, 409);
  p = await act(rig, { action: 'context' });
  assert.equal(p.stage, 'context');

  // 맥락이 열리기 시작하면 첫 선택은 바꿀 수 없다.
  p = await act(rig, { action: 'choose', which: 'first', choice: 'refer' }, 409);
  assert.equal(p.firstChoice.id, 'talk');
  // 네 개를 모두 열기 전에는 다시 선택할 수 없고 다음으로도 못 간다.
  p = await act(rig, { action: 'choose', which: 'second', choice: 'refer' }, 409);
  assert.equal(p.secondChoice, null);
  await act(rig, { action: 'next' }, 409);
  await act(rig, { action: 'context' });
  await act(rig, { action: 'context' });
  p = await act(rig, { action: 'choose', which: 'second', choice: 'refer' }, 409);
  assert.equal(p.contexts.length, 3);
  p = await act(rig, { action: 'context' });
  assert.equal(p.contexts.length, 4);
  p = await act(rig, { action: 'context' }, 409);
  assert.equal(p.contexts.length, 4);

  // 다시 선택하기 전에는 나란히 보기로 못 간다.
  await act(rig, { action: 'next' }, 409);
  await act(rig, { action: 'choose', which: 'first', choice: 'refer' }, 409);
  await act(rig, { action: 'choose', which: 'second', choice: 'nope' }, 409);
  p = await act(rig, { action: 'choose', which: 'second', choice: 'talk' });
  p = await act(rig, { action: 'next' });
  assert.deepEqual(p.comparison, {
    first: { id: 'talk', label: '학생과 먼저 대화' },
    second: { id: 'talk', label: '학생과 먼저 대화' },
    changed: false,
    message: '선택이 유지되었습니다',
  });
  // 나란히 본 뒤에는 선택을 바꿀 수 없다.
  await act(rig, { action: 'choose', which: 'second', choice: 'refer' }, 409);

  const unknown = await rig.post('/api/part2', { action: 'skip' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, KOREAN);
});

test('2부만 처음으로: 선택과 열어 둔 것이 비워지고, 진행 단계와 나머지는 그대로다', async (t) => {
  const rig = await startRig(t, { receiver: false });
  await rig.post('/api/step', { to: 'part2' });
  await rig.post('/api/reveal', {});
  for (const body of [{ action: 'next' }, { action: 'next' }, { action: 'next' }, { action: 'choose', which: 'first', choice: 'observe' }, { action: 'context' }]) {
    await act(rig, body);
  }
  const res = await rig.post('/api/part2', { action: 'reset' });
  assert.equal(res.status, 200);
  const state = res.json.state;
  assert.equal(state.part2.stage, 'journal');
  assert.equal(state.part2.firstChoice, null);
  assert.deepEqual(state.part2.contexts, []);
  assert.equal(state.part2.ai, null);
  assert.equal(state.step.id, 'part2');
  assert.equal(state.revealed, true);
  assert.ok(state.accessLog.entries.length > 0);
});

test('2부 내용: 진단명·분류·점수·등급이 없고, 정답 표시가 없다', () => {
  const text = JSON.stringify(content.PART2);
  for (const word of ['우울', '불안장애', 'ADHD', '장애', '증후군', '위험도', '위험군', '고위험', '등급', '점수', '%', '정답', '올바른 선택', '틀린']) {
    assert.ok(!text.includes(word), word);
  }
  assert.ok(!/\d+\s*점/.test(text));
  assert.equal(content.PART2.ai.text, AI_TEXT);
  assert.equal(content.PART2.contexts.length, 4);
  assert.equal(content.PART2.journal.length, 5);
  for (const word of ['교육청', '우수사례', '선도학교', '연구학교', '초등학교']) assert.ok(!text.includes(word), word);
});
