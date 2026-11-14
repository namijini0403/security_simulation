import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  SUBJECTS,
  RATING_VALUES,
  CLASS_NAME,
  STUDENT_COUNT,
  createStudents,
  isValidStudentId,
  studentIdForNumber,
  listAccounts,
  findAccount,
  PARENT_PASSWORD,
  TEACHER_LOGIN_ID,
  TEACHER_PASSWORD,
} from '../src/shared/data.js';

const pad = (n) => String(n).padStart(2, '0');

test('과목과 평가 값 목록이 명세와 같다', () => {
  assert.deepEqual([...SUBJECTS], ['국어', '수학', '사회', '과학', '영어']);
  assert.deepEqual([...RATING_VALUES], ['잘함', '보통', '노력요함']);
  assert.equal(CLASS_NAME, '6학년 가상반');
  assert.equal(STUDENT_COUNT, 20);
});

test('학생은 정확히 20명이고 모든 항목의 형식이 맞다', () => {
  const students = createStudents();
  assert.equal(students.length, 20);
  students.forEach((s, index) => {
    const nn = pad(index + 1);
    assert.deepEqual(Object.keys(s), [
      'id', 'name', 'className', 'ratings', 'comment', 'guardianName', 'guardianPhone',
    ]);
    assert.equal(s.id, `TEST-10${nn}`);
    assert.equal(s.name, `가상학생${nn}`);
    assert.equal(s.className, '6학년 가상반');
    assert.equal(s.guardianName, `가상보호자${nn}`);
    assert.equal(s.guardianPhone, `010-XXXX-00${nn}`);
    assert.deepEqual(Object.keys(s.ratings), ['국어', '수학', '사회', '과학', '영어']);
    for (const value of Object.values(s.ratings)) {
      assert.ok(RATING_VALUES.includes(value), `${s.id} 평가 값: ${value}`);
    }
    assert.equal(typeof s.comment, 'string');
    assert.ok(s.comment.length >= 10, `${s.id} 의견이 너무 짧다`);
    assert.ok(s.comment.length <= 200, `${s.id} 의견이 너무 길다`);
    assert.doesNotMatch(s.comment, /\d{3}-\d{3,4}-\d{4}/, '의견에 전화번호 모양이 없어야 한다');
    assert.doesNotMatch(s.comment, /초등학교|중학교|교육청/, '의견에 실제 기관을 떠올리게 하는 낱말이 없어야 한다');
  });
  assert.equal(new Set(students.map((s) => s.id)).size, 20);
});

test('TEST-1001의 초기 평가에는 노력요함이 적어도 하나 있다', () => {
  const first = createStudents()[0];
  assert.equal(first.id, 'TEST-1001');
  assert.ok(Object.values(first.ratings).includes('노력요함'));
});

test('세 가지 평가 값이 반 전체에 모두 쓰인다', () => {
  const used = new Set(createStudents().flatMap((s) => Object.values(s.ratings)));
  assert.deepEqual([...used].sort(), [...RATING_VALUES].sort());
});

test('부를 때마다 같은 값이고, 다른 실행에서도 같은 값이다', () => {
  assert.deepEqual(createStudents(), createStudents());
  const moduleUrl = new URL('../src/shared/data.js', import.meta.url).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then((m) => process.stdout.write(JSON.stringify(m.createStudents())));`;
  const run = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), createStudents());
});

test('받은 사본을 고쳐도 다음 사본과 다른 사본에 영향이 없다', () => {
  const a = createStudents();
  const b = createStudents();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.notEqual(a[0].ratings, b[0].ratings);
  a[0].ratings['국어'] = '바뀜';
  a[0].name = '바뀜';
  a.pop();
  assert.notEqual(b[0].ratings['국어'], '바뀜');
  const c = createStudents();
  assert.equal(c.length, 20);
  assert.equal(c[0].name, '가상학생01');
  assert.notEqual(c[0].ratings['국어'], '바뀜');
  assert.deepEqual(b, c);
});

test('학생 번호 형식 확인: TEST-1001 ~ TEST-1020만 맞다', () => {
  for (let n = 1; n <= 20; n += 1) {
    assert.equal(isValidStudentId(`TEST-10${pad(n)}`), true);
    assert.equal(studentIdForNumber(n), `TEST-10${pad(n)}`);
  }
  const rejected = [
    'TEST-1000', 'TEST-1021', 'TEST-1099', 'TEST-10011', 'TEST-101', 'test-1001', ' TEST-1001',
    'TEST-1001 ', 'TEST-1001\n', 'XTEST-1001', 'TEST-2001', '', null, undefined, 1001, {}, ['TEST-1001'],
  ];
  for (const value of rejected) {
    assert.equal(isValidStudentId(value), false, `거절해야 함: ${JSON.stringify(value)}`);
  }
  assert.throws(() => studentIdForNumber(0));
  assert.throws(() => studentIdForNumber(21));
});

test('계정: 학부모 20개와 담임 1개', () => {
  const accounts = listAccounts();
  assert.equal(accounts.length, 21);
  assert.equal(PARENT_PASSWORD, 'demo1234');
  assert.equal(TEACHER_LOGIN_ID, 'teacher');
  assert.equal(TEACHER_PASSWORD, 'teacher1234');
  for (let n = 1; n <= 20; n += 1) {
    const account = accounts[n - 1];
    assert.deepEqual(account, {
      loginId: `parent${pad(n)}`,
      password: 'demo1234',
      role: 'parent',
      studentId: `TEST-10${pad(n)}`,
    });
  }
  assert.deepEqual(accounts[20], {
    loginId: 'teacher', password: 'teacher1234', role: 'teacher', studentId: null,
  });
  // 사본이므로 고쳐도 원본이 바뀌지 않는다.
  accounts[0].password = 'x';
  assert.equal(listAccounts()[0].password, 'demo1234');
});

test('로그인 확인: 맞으면 역할과 담당 학생, 틀리면 null', () => {
  assert.deepEqual(findAccount('parent07', 'demo1234'), {
    role: 'parent', loginId: 'parent07', studentId: 'TEST-1007',
  });
  assert.deepEqual(findAccount('teacher', 'teacher1234'), {
    role: 'teacher', loginId: 'teacher', studentId: null,
  });
  assert.equal(findAccount('parent07', 'teacher1234'), null);
  assert.equal(findAccount('teacher', 'demo1234'), null);
  assert.equal(findAccount('parent21', 'demo1234'), null);
  assert.equal(findAccount('parent00', 'demo1234'), null);
  assert.equal(findAccount('PARENT01', 'demo1234'), null);
  assert.equal(findAccount('', ''), null);
  assert.equal(findAccount(undefined, undefined), null);
  assert.equal(findAccount({ toString: () => 'teacher' }, 'teacher1234'), null);
  assert.equal(findAccount('__proto__', 'demo1234'), null);
});
