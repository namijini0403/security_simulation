// 가상 데이터 (명세 4.1, 4.2)
//
// 이 파일의 모든 값은 코드가 만든 가짜 값이다. 실제 사람·학교·사건과 관계가 없다.
// 무작위 값을 쓰지 않으므로 실행할 때마다 같은 값이 나온다.

/** 과목 5개 (순서 고정). */
export const SUBJECTS = Object.freeze(['국어', '수학', '사회', '과학', '영어']);

/** 평가 값 3개. */
export const RATING_VALUES = Object.freeze(['잘함', '보통', '노력요함']);

export const CLASS_NAME = '6학년 가상반';
export const STUDENT_COUNT = 20;

export const PARENT_PASSWORD = 'demo1234';
export const TEACHER_LOGIN_ID = 'teacher';
export const TEACHER_PASSWORD = 'teacher1234';

// 학생별 초기 평가. 글자 하나가 과목 하나(국어·수학·사회·과학·영어 순서)다.
//   잘 = 잘함, 보 = 보통, 노 = 노력요함
// 첫 줄(TEST-1001)에는 '노'가 들어 있어야 한다(성적 고치기 장면용).
const RATING_CODES = Object.freeze({ 잘: '잘함', 보: '보통', 노: '노력요함' });
const INITIAL_RATINGS = Object.freeze([
  '보노잘보노', // 01
  '잘잘보잘보', // 02
  '보보보잘잘', // 03
  '잘보노보잘', // 04
  '노보보잘보', // 05
  '잘잘잘보잘', // 06
  '보잘보노보', // 07
  '보보잘잘노', // 08
  '잘노보보보', // 09
  '보잘잘보잘', // 10
  '노보잘보보', // 11
  '잘보보잘잘', // 12
  '보보노잘보', // 13
  '잘잘보보노', // 14
  '보노보잘잘', // 15
  '잘보잘노보', // 16
  '보잘보보잘', // 17
  '노잘보잘보', // 18
  '잘보보보잘', // 19
  '보보잘노잘', // 20
]);

// 담임 종합의견. 미리 써 둔 가상 문장이며 특정 인물·학교·행사를 가리키지 않는다.
const COMMENTS = Object.freeze([
  '수업 시간에 질문을 자주 하며 궁금한 것을 끝까지 알아보려 합니다. 계산 문제는 천천히 다시 확인하는 연습이 도움이 되겠습니다.',
  '맡은 일을 꼼꼼하게 마무리합니다. 발표할 때 목소리를 조금 더 크게 내면 좋겠습니다.',
  '모둠 활동에서 친구의 의견을 잘 들어 줍니다. 자신의 생각도 자주 말해 보도록 격려하고 있습니다.',
  '책 읽기를 좋아하고 읽은 내용을 자기 말로 잘 정리합니다.',
  '실험과 관찰 활동에 즐겁게 참여합니다. 글로 정리하는 부분은 꾸준히 연습하고 있습니다.',
  '여러 과목에 고르게 관심을 보이며 학습 준비가 잘 되어 있습니다.',
  '차분한 태도로 수업에 참여합니다. 어려운 문제를 만나도 쉽게 포기하지 않습니다.',
  '친구들과 사이좋게 지내며 교실 정리에 먼저 나섭니다. 낱말 익히기에 조금 더 시간을 들이면 좋겠습니다.',
  '글쓰기에서 자기 생각을 또렷하게 드러냅니다. 수학은 기초 연산을 다시 다지는 중입니다.',
  '수업 내용을 빠르게 이해하고 친구에게 친절하게 설명해 줍니다.',
  '그림이나 표로 생각을 나타내는 것을 좋아합니다. 긴 글을 읽을 때는 중심 내용을 찾는 연습을 함께 하고 있습니다.',
  '정해진 약속을 잘 지키며 학습 계획을 스스로 세웁니다.',
  '과학 시간에 관찰한 것을 자세히 기록합니다. 사회 시간에는 자료를 읽는 연습이 더 필요합니다.',
  '발표를 자신 있게 하며 친구들의 발표에도 귀를 기울입니다.',
  '새로운 활동을 시작할 때 적극적으로 참여합니다. 풀이 과정을 차근차근 적는 습관을 기르고 있습니다.',
  '모둠에서 역할을 나누고 의견을 모으는 일을 잘합니다.',
  '꾸준히 노력하는 모습이 돋보입니다. 한 학기 동안 과제를 빠짐없이 냈습니다.',
  '수학 문제를 여러 방법으로 풀어 보려 합니다. 글을 소리 내어 읽는 연습을 함께 하고 있습니다.',
  '친구를 잘 배려하고 도움이 필요한 친구를 먼저 챙깁니다.',
  '궁금한 점을 스스로 찾아보는 습관이 있습니다. 실험 결과를 정리하는 부분은 조금 더 연습이 필요합니다.',
]);

const twoDigits = (number) => String(number).padStart(2, '0');

/**
 * 학생 번호 만들기: 1 → 'TEST-1001', 20 → 'TEST-1020'.
 * @param {number} number 1~20
 * @returns {string}
 */
export function studentIdForNumber(number) {
  if (!Number.isInteger(number) || number < 1 || number > STUDENT_COUNT) {
    throw new RangeError(`학생 순번은 1부터 ${STUDENT_COUNT}까지입니다: ${number}`);
  }
  return `TEST-10${twoDigits(number)}`;
}

/**
 * 학생 번호 형식 확인. 'TEST-1001' ~ 'TEST-1020'인 문자열만 true.
 * (받는 쪽 프로그램이 실제 정보가 들어오지 못하게 막을 때도 쓴다.)
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidStudentId(id) {
  if (typeof id !== 'string' || id.length !== 9) return false;
  const match = /^TEST-10(\d\d)$/.exec(id);
  if (!match) return false;
  const number = Number(match[1]);
  return number >= 1 && number <= STUDENT_COUNT;
}

function ratingsFromCodes(codes) {
  const ratings = {};
  SUBJECTS.forEach((subject, index) => {
    ratings[subject] = RATING_CODES[codes[index]];
  });
  return ratings;
}

/**
 * 학생 기록 20명을 새로 만들어 돌려준다. 부를 때마다 값은 같고 객체는 새것이다.
 * 두 앱이 각자 한 번씩 불러 자기만의 사본을 가지면 된다(초기화할 때도 다시 부른다).
 * @returns {Array<{id: string, name: string, className: string,
 *   ratings: Record<string, string>, comment: string,
 *   guardianName: string, guardianPhone: string}>}
 */
export function createStudents() {
  const students = [];
  for (let number = 1; number <= STUDENT_COUNT; number += 1) {
    const nn = twoDigits(number);
    students.push({
      id: studentIdForNumber(number),
      name: `가상학생${nn}`,
      className: CLASS_NAME,
      ratings: ratingsFromCodes(INITIAL_RATINGS[number - 1]),
      comment: COMMENTS[number - 1],
      guardianName: `가상보호자${nn}`,
      guardianPhone: `010-XXXX-00${nn}`,
    });
  }
  return students;
}

/**
 * 고정된 실습용 계정 21개(학부모 20 + 담임 1)의 새 사본.
 * @returns {Array<{loginId: string, password: string, role: 'parent'|'teacher', studentId: string|null}>}
 */
export function listAccounts() {
  const accounts = [];
  for (let number = 1; number <= STUDENT_COUNT; number += 1) {
    accounts.push({
      loginId: `parent${twoDigits(number)}`,
      password: PARENT_PASSWORD,
      role: 'parent',
      studentId: studentIdForNumber(number),
    });
  }
  accounts.push({ loginId: TEACHER_LOGIN_ID, password: TEACHER_PASSWORD, role: 'teacher', studentId: null });
  return accounts;
}

/**
 * 로그인 확인. 맞으면 `{role, loginId, studentId}`(명세 5.2의 응답 형식), 틀리면 null.
 * 문자열이 아닌 값은 모두 틀린 것으로 다룬다.
 * @param {unknown} loginId
 * @param {unknown} password
 * @returns {{role: 'parent'|'teacher', loginId: string, studentId: string|null} | null}
 */
export function findAccount(loginId, password) {
  if (typeof loginId !== 'string' || typeof password !== 'string') return null;
  const account = listAccounts().find((item) => item.loginId === loginId && item.password === password);
  if (!account) return null;
  return { role: account.role, loginId: account.loginId, studentId: account.studentId };
}
