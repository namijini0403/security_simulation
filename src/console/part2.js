// 2부의 순서 규칙 (명세 9.1). 순서는 화면이 아니라 여기서 지킨다.
// 이 파일은 어디에도 요청을 보내지 않는다(2부는 데이터를 내보내지 않는다).

import { PART2 } from './content.js';

/** 단계 이름(이 순서로만 나아간다). */
export const PART2_STAGES = Object.freeze([
  'journal', // 1 감정일지
  'facts', // 2 관찰된 사실
  'ai', // 3 AI의 해석
  'firstChoice', // 4 첫 선택
  'context', // 5 추가 맥락 공개
  'secondChoice', // 6 다시 선택
  'compare', // 7 나란히 보기
  'explain', // 8 설명과 문구
]);

const refuse = (error, status = 409) => ({ ok: false, status, error });
const OK = Object.freeze({ ok: true });

function findChoice(id) {
  if (typeof id !== 'string') return null;
  return PART2.choices.find((choice) => choice.id === id) || null;
}

/**
 * 2부의 상태를 만든다.
 *   next()                  다음 단계로(조건이 안 되면 거절)
 *   choose(which, choiceId) which: 'first' | 'second'
 *   openContext()           추가 맥락을 하나 더 연다
 *   reset()                 2부만 처음으로
 *   view()                  지금까지 열린 것만 담은 화면용 값
 * 동작은 {ok: true} 또는 {ok: false, status: 409, error: '<한국어>'}를 돌려준다.
 */
export function createPart2() {
  let stage = 0;
  let firstChoice = null;
  let secondChoice = null;
  let opened = 0;
  const total = PART2.contexts.length;
  const at = (name) => PART2_STAGES.indexOf(name);

  function reset() {
    stage = 0;
    firstChoice = null;
    secondChoice = null;
    opened = 0;
  }

  function openContext() {
    if (stage < at('firstChoice') || firstChoice === null) return refuse(PART2.errors.contextBeforeChoice);
    if (opened >= total) return refuse(PART2.errors.allContextsOpen);
    opened += 1;
    // 네 개를 모두 열면 바로 '다시 선택'으로 넘어간다.
    stage = opened >= total ? at('secondChoice') : at('context');
    return OK;
  }

  function next() {
    switch (PART2_STAGES[stage]) {
      case 'journal':
      case 'facts':
      case 'ai':
      case 'compare':
        stage += 1;
        return OK;
      case 'firstChoice':
        if (firstChoice === null) return refuse(PART2.errors.needFirstChoice);
        return openContext();
      case 'context':
        return refuse(PART2.errors.contextsNotDone);
      case 'secondChoice':
        if (secondChoice === null) return refuse(PART2.errors.needSecondChoice);
        stage = at('compare');
        return OK;
      default:
        return refuse(PART2.errors.last);
    }
  }

  function choose(which, choiceId) {
    if (which !== 'first' && which !== 'second') return refuse(PART2.errors.badWhich);
    const choice = findChoice(choiceId);
    if (which === 'first') {
      if (stage < at('firstChoice')) return refuse(PART2.errors.firstNotYet);
      if (stage > at('firstChoice') || opened > 0) return refuse(PART2.errors.firstLocked);
      if (!choice) return refuse(PART2.errors.badChoice);
      firstChoice = choice.id;
      return OK;
    }
    if (stage < at('secondChoice') || opened < total) return refuse(PART2.errors.secondNotYet);
    if (stage > at('secondChoice')) return refuse(PART2.errors.secondLocked);
    if (!choice) return refuse(PART2.errors.badChoice);
    secondChoice = choice.id;
    return OK;
  }

  /** 지금까지 열린 것만 담는다. 아직 열지 않은 내용은 넣지 않는다. */
  function view() {
    const copy = (choice) => (choice ? { id: choice.id, label: choice.label } : null);
    const first = copy(findChoice(firstChoice));
    const second = copy(findChoice(secondChoice));
    const reached = (name) => stage >= at(name);
    return {
      stage: PART2_STAGES[stage],
      stageNo: stage + 1,
      stageCount: PART2_STAGES.length,
      subject: PART2.subject,
      journal: PART2.journal.map((line) => ({ ...line })),
      facts: reached('facts') ? [...PART2.facts] : null,
      ai: reached('ai') ? { ...PART2.ai } : null,
      choices: reached('firstChoice') ? PART2.choices.map(copy) : null,
      firstChoice: first,
      contextTotal: total,
      contexts: PART2.contexts.slice(0, opened).map((item) => ({ ...item })),
      noContextNote: opened >= total ? PART2.noContextNote : null,
      secondChoice: second,
      // 두 선택을 그대로 나란히 놓는다. 어느 쪽이 맞다고 표시하지 않는다.
      comparison: reached('compare') && first && second
        ? { first, second, changed: first.id !== second.id, message: first.id !== second.id ? PART2.changed : PART2.kept }
        : null,
      explanation: reached('explain')
        ? {
          concepts: PART2.explanation.concepts.map((item) => ({ ...item })),
          role: PART2.explanation.role,
          messages: PART2.explanation.messages.map((item) => ({ ...item })),
        }
        : null,
    };
  }

  return { next, choose, openContext, reset, view };
}
