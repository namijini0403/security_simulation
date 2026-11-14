// 안내 문서와 더블클릭 실행 파일 검사 (명세 3, 12, 13, 14).
//
// 문서(README.md, PRESENTER_GUIDE.md, NETWORK_GUIDE.md)에 적힌 단추·칸·단계 이름, 주소, 계정이
// 실제 화면 파일과 글자 그대로 같은지, 꼭 있어야 하는 경고가 있는지 확인한다.
// 약속: 문서에서 작은따옴표로 묶은 말('다음' 등)은 화면에 실제로 나오는 글자다. 다른 용도로 작은따옴표를 쓰지 않는다.
// 서버를 띄우지 않고 파일만 읽는다.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLOSING, FIXED_NOTICE, PART2, REVEAL, STEPS, TEXT } from '../src/console/content.js';
import { SWITCH_MESSAGES } from '../src/shared/access-switch.js';
import { DEFAULT_PORTS } from '../src/shared/config.js';
import { PARENT_PASSWORD, TEACHER_LOGIN_ID, TEACHER_PASSWORD, findAccount } from '../src/shared/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const DOCS = {
  readme: read('README.md'),
  presenter: read('PRESENTER_GUIDE.md'),
  network: read('NETWORK_GUIDE.md'),
};
const DOC_NAMES = { readme: 'README.md', presenter: 'PRESENTER_GUIDE.md', network: 'NETWORK_GUIDE.md' };

// ---------------------------------------------------------------- 화면에 실제로 나오는 글자 모음

const SCREEN = {
  consoleHtml: read('src', 'console', 'public', 'index.html'),
  consoleJs: read('src', 'console', 'public', 'console.js'),
  appHtml: read('src', 'app', 'public', 'index.html'),
  appJs: read('src', 'app', 'public', 'index.js'),
  neighborHtml: read('src', 'app', 'public', 'neighbor.html'),
  neighborJs: read('src', 'app', 'public', 'neighbor.js'),
  receiverHtml: read('src', 'receiver', 'public', 'index.html'),
  receiverJs: read('src', 'receiver', 'public', 'receiver.js'),
};

const APP_LABELS = ['1번 앱', '2번 앱'];

/** 화면에 나올 수 있는 글자를 모두 이어 붙인 것. 문서의 작은따옴표 안 글자는 여기에 그대로 들어 있어야 한다. */
const CORPUS = [
  ...Object.values(SCREEN),
  read('src', 'console', 'content.js'),
  read('src', 'shared', 'access-switch.js'),
  read('src', 'demo.js'),
  // 화면이 글자를 이어 붙여 만드는 것
  ...APP_LABELS.map((label) => `${label} 옆 사람 화면`),
].join('\n');

/** HTML 파일에서 단추 글자를 뽑는다(안쪽 태그는 뺀다). */
function buttonLabels(html) {
  const labels = [];
  for (const match of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
    const text = match[1].replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, '').replace(/<[^>]*>/g, '').trim();
    if (text) labels.push(text);
  }
  return labels;
}

/** 문서에서 코드 블록과 `코드` 표시를 뺀 본문. */
function prose(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/** 문서에서 작은따옴표로 묶은 말을 모두 뽑는다. */
function quotedLabels(markdown) {
  const found = [];
  for (const line of prose(markdown).split('\n')) {
    for (const match of line.matchAll(/'([^'\n]+)'/g)) found.push({ label: match[1], line: line.trim() });
  }
  return found;
}

function assertContains(docKey, text, why) {
  assert.ok(DOCS[docKey].includes(text), `${DOC_NAMES[docKey]}에 "${text}"가 있어야 합니다${why ? ` (${why})` : ''}`);
}

// ---------------------------------------------------------------- 화면 글자와 문서

describe('문서에 적힌 화면 글자', () => {
  for (const key of Object.keys(DOCS)) {
    test(`${DOC_NAMES[key]}: 작은따옴표로 묶은 말은 모두 실제 화면에 있는 글자다`, () => {
      const labels = quotedLabels(DOCS[key]);
      assert.ok(labels.length >= 5, '작은따옴표로 묶은 화면 글자가 있어야 합니다');
      const wrong = labels.filter((item) => !CORPUS.includes(item.label));
      assert.deepEqual(
        wrong.map((item) => `'${item.label}'  ←  ${item.line.slice(0, 80)}`),
        [],
        '화면에 없는 글자를 작은따옴표로 묶었습니다. 화면의 글자와 똑같이 고치거나 작은따옴표를 빼 주세요',
      );
    });

    test(`${DOC_NAMES[key]}: 작은따옴표가 줄마다 짝이 맞는다`, () => {
      const odd = prose(DOCS[key]).split('\n').filter((line) => (line.match(/'/g) || []).length % 2 === 1);
      assert.deepEqual(odd, []);
    });
  }

  test('옆 사람 화면의 단추 일곱 개가 발표 안내서에 글자 그대로 있다', () => {
    const box = SCREEN.neighborHtml.match(/<div class="buttons">([\s\S]*?)<\/section>/);
    assert.ok(box, '옆 사람 화면에서 단추 묶음을 찾지 못했습니다');
    const labels = buttonLabels(box[1]);
    assert.equal(labels.length, 7);
    for (const label of labels) assertContains('presenter', `'${label}'`);
    // 문서에 적은 순서도 화면과 같다.
    const positions = labels.map((label) => DOCS.presenter.indexOf(`'${label}'`));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  });

  test('진행 화면의 단추와 칸 이름이 발표 안내서에 글자 그대로 있다', () => {
    const buttons = buttonLabels(SCREEN.consoleHtml);
    for (const label of ['이전', '다음', '전체 초기화', '초기화 실행', '켜기', '확인', '연장', '끄기', '알림 닫기',
      '주소 적용', '연결 확인', '공개', '2부 다음 단계', '2부만 처음으로', '2부 되돌리기']) {
      assert.ok(buttons.includes(label), `진행 화면에 '${label}' 단추가 있어야 합니다`);
      assertContains('presenter', `'${label}'`);
    }
    assert.ok(SCREEN.consoleJs.includes("'맥락 하나 더 보기'"));
    assertContains('presenter', "'맥락 하나 더 보기'");

    const headings = [...SCREEN.consoleHtml.matchAll(/<h[23][^>]*>([^<]+?)\s*(?:<|$)/g)].map((match) => match[1].trim());
    for (const label of ['다른 기기 접속', '접속 기록', '옆 기기가 가져간 것', '받는 쪽에 도착한 것', '말할 문장', '화면에서 할 일',
      '새 창으로 열기 (이 PC)', '이 PC의 내부 주소', '두 번째 노트북에 입력할 주소', '온라인 표', 'AI 서비스']) {
      assert.ok(headings.includes(label), `진행 화면에 '${label}' 칸이 있어야 합니다`);
      assertContains('presenter', `'${label}'`);
    }
    assert.ok(SCREEN.consoleHtml.includes('<label for="receiver-host">받는 쪽 주소</label>'));
    for (const key of ['presenter', 'network']) assertContains(key, "'받는 쪽 주소'");
    for (const label of APP_LABELS) assertContains('presenter', `'${label} 옆 사람 화면'`);
  });

  test('받는 쪽 화면의 단추가 문서에 글자 그대로 있다', () => {
    const buttons = buttonLabels(SCREEN.receiverHtml);
    for (const label of ['켜기', '확인', '연장', '끄기']) {
      assert.ok(buttons.includes(label), `받는 쪽 화면에 '${label}' 단추가 있어야 합니다`);
      assertContains('network', `'${label}'`);
    }
    for (const label of ['받은 내용 모두 지우기', '지우기']) {
      assert.ok(buttons.includes(label), `받는 쪽 화면에 '${label}' 단추가 있어야 합니다`);
      assertContains('presenter', `'${label}'`);
    }
    assert.ok(SCREEN.receiverHtml.includes("첫 번째 노트북 진행 화면의 '받는 쪽 주소' 칸에 입력할 주소"));
    assertContains('network', "첫 번째 노트북 진행 화면의 '받는 쪽 주소' 칸에 입력할 주소");
  });

  test('성적 관리 앱의 단추와 계정이 발표 안내서에 글자 그대로 있다', () => {
    const buttons = [...buttonLabels(SCREEN.appHtml), '삭제'];
    assert.ok(SCREEN.appJs.includes("'삭제'"));
    for (const label of ['로그인', '성적 저장', 'AI 종합의견 초안 만들기', '학생 기록 삭제', '삭제']) {
      assert.ok(buttons.includes(label), `앱 화면에 '${label}' 단추가 있어야 합니다`);
      assertContains('presenter', `'${label}'`);
    }
  });

  test('단계 이름과 발표자가 말할 문장이 진행 화면과 같다', () => {
    for (const step of STEPS) {
      assertContains('presenter', `'${step.label}'`, '단계 단추');
      if (step.title !== step.label) assertContains('presenter', step.title, '단계 제목');
    }
    // 1부 단계와 공개·2부에서 말할 문장은 진행 화면의 문장 그대로 싣는다.
    for (const step of STEPS.filter((item) => item.id !== 'closing')) {
      for (const sentence of step.say) assertContains('presenter', sentence, `${step.label} 단계에서 말할 문장`);
    }
    assertContains('presenter', STEPS.find((item) => item.id === 'closing').say[0]);
    for (const note of REVEAL.notes) assertContains('presenter', note, '공개 장면의 설명');
    for (const attempt of REVEAL.attempts) assertContains('presenter', attempt.title, '공개 장면의 시도');
    for (const choice of PART2.choices) assertContains('presenter', `'${choice.label}'`, '2부 선택지');
    for (const message of PART2.explanation.messages) assertContains('presenter', message.text, '2부 문구');
    assertContains('presenter', `'${PART2.kept}'`);
    assertContains('presenter', `'${PART2.changed}'`);
    assertContains('presenter', PART2.subject);
    assertContains('presenter', CLOSING.sentences.find((item) => item.emphasis).text, '가장 강조하는 문장');
    assertContains('presenter', FIXED_NOTICE);
    assertContains('presenter', SWITCH_MESSAGES.confirmWarning, '스위치를 켤 때의 경고');
    assertContains('network', SWITCH_MESSAGES.confirmWarning, '스위치를 켤 때의 경고');
    assertContains('presenter', `'${SWITCH_MESSAGES.autoOff}'`);
    assertContains('presenter', TEXT.switchWarning, '2분 남았을 때의 알림');
    assertContains('presenter', TEXT.pingOk);
    assertContains('network', TEXT.pingOk);
    assertContains('presenter', `'${TEXT.otherDeviceNotice}'`);
  });
});

// ---------------------------------------------------------------- 주소와 계정

describe('문서에 적힌 주소와 계정', () => {
  test('README에 네 개의 주소가 기본 포트 그대로 있다', () => {
    const rows = {
      '진행 화면': DEFAULT_PORTS.console,
      '1번 앱': DEFAULT_PORTS.app1,
      '2번 앱': DEFAULT_PORTS.app2,
      '받는 쪽': DEFAULT_PORTS.receiver,
    };
    for (const [name, port] of Object.entries(rows)) {
      const row = DOCS.readme.split('\n').find((line) => line.startsWith(`| ${name}`) && line.includes('http://127.0.0.1:'));
      assert.ok(row, `README의 주소 표에 '${name}' 줄이 있어야 합니다`);
      assert.ok(row.includes(`\`http://127.0.0.1:${port}\``), `'${name}'의 주소는 http://127.0.0.1:${port} 입니다: ${row}`);
    }
  });

  test('세 문서에 적힌 포트는 모두 기본 포트 넷 중 하나다', () => {
    const allowed = new Set(Object.values(DEFAULT_PORTS).map(String));
    for (const key of Object.keys(DOCS)) {
      const ports = [...DOCS[key].matchAll(/(?:\d{1,3}(?:\.\d{1,3}){3}|[`(]):(\d{4,5})\b/g)].map((match) => match[1]);
      assert.ok(ports.length > 0, `${DOC_NAMES[key]}에 주소가 있어야 합니다`);
      assert.deepEqual(ports.filter((port) => !allowed.has(port)), [], `${DOC_NAMES[key]}에 기본 포트가 아닌 번호가 있습니다`);
    }
    // 두 번째 노트북에 입력할 주소의 보기는 1번 앱의 옆 사람 화면이다.
    assertContains('network', `:${DEFAULT_PORTS.app1}/neighbor`);
    assertContains('presenter', `:${DEFAULT_PORTS.app1}/neighbor`);
    assertContains('readme', `http://127.0.0.1:${DEFAULT_PORTS.app1}/neighbor`);
  });

  test('계정의 ID와 비밀번호가 실제로 로그인되는 값이다', () => {
    for (const key of ['readme', 'presenter']) {
      for (const value of [TEACHER_LOGIN_ID, TEACHER_PASSWORD, PARENT_PASSWORD, 'parent01']) {
        assertContains(key, `\`${value}\``);
      }
    }
    assertContains('readme', '`parent20`');
    assert.equal(findAccount(TEACHER_LOGIN_ID, TEACHER_PASSWORD).role, 'teacher');
    assert.equal(findAccount('parent01', PARENT_PASSWORD).studentId, 'TEST-1001');
    assert.equal(findAccount('parent20', PARENT_PASSWORD).studentId, 'TEST-1020');
    // 문서에 `코드`로 적은 로그인 ID와 비밀번호 모양의 말은 모두 실제 계정 값이다.
    const known = new Set([TEACHER_LOGIN_ID, TEACHER_PASSWORD, PARENT_PASSWORD]);
    for (const key of Object.keys(DOCS)) {
      for (const match of DOCS[key].matchAll(/`((?:parent\d+|teacher\w*|demo\w+))`/g)) {
        const value = match[1];
        const ok = known.has(value) || (/^parent\d{2}$/.test(value) && findAccount(value, PARENT_PASSWORD) !== null);
        assert.ok(ok, `${DOC_NAMES[key]}의 \`${value}\`는 실제 계정 값이 아닙니다`);
      }
    }
  });

  test('문서에 적힌 학생 번호는 실제로 있는 번호다', () => {
    for (const key of Object.keys(DOCS)) {
      for (const match of DOCS[key].matchAll(/TEST-(\d+)/g)) {
        const number = Number(match[1]);
        assert.ok(match[1].length === 4 && number >= 1001 && number <= 1020, `${DOC_NAMES[key]}: TEST-${match[1]}`);
      }
    }
  });
});

// ---------------------------------------------------------------- 꼭 있어야 하는 경고와 안내

describe('문서에 꼭 있어야 하는 내용', () => {
  const must = (key, pattern, what) => assert.match(DOCS[key], pattern, `${DOC_NAMES[key]}: ${what}`);

  test('README의 경고와 안내', () => {
    must('readme', /가상 데이터 전용/, '가상 데이터 전용');
    must('readme', /실제 학생·학부모의 정보를 어떤 방법으로도 넣지 마세요/, '실제 정보 입력 금지');
    must('readme', /인터넷에 올리지 마세요/, '배포 금지');
    must('readme', /학교 와이파이, 공용 와이파이에서는 절대 켜지 마세요/, '학교·공용 와이파이 금지');
    must('readme', /전용 실습용 연결에서만/, '전용 연결에서만');
    must('readme', /1번 앱은 일부러 허술하게 만든 앱/, '1번 앱은 일부러 허술하다');
    must('readme', /실제 서비스로 쓰면 안 됩니다/, '실제 서비스로 쓰지 말 것');
    must('readme', /비교용 예제/, '2번 앱은 비교용 예제');
    must('readme', /그대로 쓸 수 있는 인증 체계가 아닙니다/, '2번 앱은 인증 체계가 아니다');
    must('readme', /Node\.js 22 이상/, 'Node.js 22 이상');
    must('readme', /https:\/\/nodejs\.org/, 'Node.js 공식 사이트');
    must('readme', /LTS/, 'LTS 설치 파일');
    must('readme', /https:\/\/github\.com\/namijini0403\/security_simulation/, '저장소 주소');
    must('readme', /Download ZIP/, 'ZIP으로 내려받기');
    must('readme', /git clone/, 'git clone');
    must('readme', /두 번째 노트북에도/, '두 번째 노트북에서 내려받기');
    for (const command of ['npm run demo', 'npm run receiver', 'npm test']) assertContains('readme', `\`${command}\``);
    must('readme', /npm test[\s\S]{0,200}내부 주소에 임시로 문을/, 'npm test가 잠깐 문을 연다는 안내');
    must('readme', /포트를 이미 다른 프로그램이 쓰고 있어서/, '포트가 이미 쓰이고 있을 때');
    must('readme', /브라우저가 저절로 열리지 않습니다/, '브라우저가 열리지 않을 때');
    must('readme', /방화벽 알림 창/, 'Windows 방화벽');
    must('readme', /확인되지 않은 개발자/, 'macOS 실행 차단');
    must('readme', /chmod \+x/, 'chmod +x');
    must('readme', /Ctrl\+C/, '끝내는 법');
    must('readme', /MIT/, '라이선스');
    must('readme', /실제 Mac에서는 실행해 보지 못했습니다/, 'macOS에서 확인하지 못했다는 사실');
    must('readme', /실제 노트북 두 대[\s\S]{0,200}확인하지 못했습니다/, '두 대로 확인하지 못했다는 사실');
    assert.ok(fs.existsSync(path.join(ROOT, 'LICENSE')));
  });

  test('발표 안내서의 필수 안내', () => {
    must('presenter', /발표 전 점검표/, '발표 전 점검표');
    must('presenter', /프로젝터는 \*\*첫 번째 노트북에만\*\*/, '프로젝터는 첫 번째 노트북만');
    must('presenter', /스위치가 꺼져 있으므로 열리지 않습니다/, '①에서 접속 실패를 먼저 보여 준다');
    must('presenter', /숫자가 멈출 때까지[\s\S]{0,80}맨 앞에/, '②에서 옆 사람 화면을 맨 앞에 둔다');
    must('presenter', /가상학생01, 가상학생02가 아닌 학생/, '④에서 지울 학생');
    must('presenter', /TEST-1001[\s\S]{0,80}TEST-1002/, '공개가 쓰는 두 학생');
    must('presenter', /다섯 번째 시도[\s\S]{0,200}실제로 모두 '잘함'으로 바뀌고/, '공개의 다섯 번째 시도는 실제로 바뀐다');
    must('presenter', /단정하지 않습니다/, '④에서 단정하지 않는다');
    must('presenter', /삭제 범위를 따로 관리해야/, '④의 원리');
    must('presenter', /손을 들게 합니다/, '2부에서 손을 받는다');
    must('presenter', /어느 선택이 정답이라고 말하지 않습니다/, '2부에 정답은 없다');
    must('presenter', /30분이 지나면 자동으로 꺼집니다/, '30분 제한');
    must('presenter', /2분이 남으면/, '2분 알림');
    must('presenter', /노트북 한 대로 진행하는 방법/, '한 대로 진행하는 방법');
    must('presenter', /한 대로는 보여 줄 수 없는 것/, '한 대로 보여 줄 수 없는 것');
    must('presenter', /도중에 문제가 생겼을 때/, '복구');
    must('presenter', /발표가 끝난 뒤/, '끝난 뒤');
    must('presenter', /어디서나 열린다”고 말하지 않습니다/, '어디서나 열린다고 말하지 않는다');
    must('presenter', /직접 확인하지 못했습니다/, '두 대로 확인하지 못했다는 사실');
    // 단정하는 문장이 없어야 한다(명세 8.4, 13).
    assert.doesNotMatch(DOCS.presenter, /반드시 남습니다|항상 남습니다|반드시 접속됩니다|항상 접속됩니다/);
  });

  test('연결 안내서의 필수 안내', () => {
    must('network', /학교 와이파이, 공용 와이파이[^\n]*절대 켜지 마세요/, '학교·공용 와이파이 금지');
    must('network', /왜 안 되나요/, '금지하는 이유');
    must('network', /휴대폰 핫스팟/, '휴대폰 핫스팟');
    must('network', /별도 공유기/, '별도 공유기');
    must('network', /개인 네트워크”에만/, '방화벽은 개인 네트워크에만');
    must('network', /방화벽을 끄지 마세요/, '방화벽을 끄지 않는다');
    must('network', /macOS/, 'macOS 방화벽');
    must('network', /항상 접속되는 것은 아닙니다/, '항상 접속되는 것은 아니다');
    must('network', /절대 접속되지 않는 것도 아닙니다/, '절대 안 되는 것도 아니다');
    for (const cause of ['스위치가 꺼져 있거나', '서로 다른 연결', '기기끼리의 통신을 막는', '방화벽이 막고 있다', '주소나 포트를 잘못', '주소가 바뀌었다']) {
      assertContains('network', cause, '접속이 안 될 때의 원인');
    }
    must('network', /끝난 뒤 끄기/, '끝난 뒤 끄기');
    must('network', /직접 확인하지 못했습니다/, '두 대로 확인하지 못했다는 사실');
    assert.doesNotMatch(DOCS.network, /방화벽을 (끄면|꺼 두면|해제하면) 됩니다|반드시 접속됩니다|항상 접속됩니다/);
  });
});

// ---------------------------------------------------------------- 더블클릭 실행 파일

describe('더블클릭 실행 파일', () => {
  const LAUNCHERS = [
    { name: '시연 시작.bat', program: 'src\\demo.js', label: '시연 프로그램' },
    { name: '받는 쪽 시작.bat', program: 'src\\receiver\\main.js', label: '받는 쪽 프로그램' },
    { name: '시연 시작.command', program: 'src/demo.js', label: '시연 프로그램' },
    { name: '받는 쪽 시작.command', program: 'src/receiver/main.js', label: '받는 쪽 프로그램' },
  ];
  /** 실행 파일이 해서는 안 되는 일: 설정 바꾸기, 권한 올리기, 내려받기·설치. */
  const FORBIDDEN = /\b(netsh|runas|sudo|powershell|pwsh|curl|wget|bitsadmin|certutil|msiexec|winget\s+\w|choco\s+\w|brew\s+\w|reg\s+add|sc\s+config|Start-Process|Invoke-WebRequest|advfirewall|socketfilterfw)\b/i;

  test('네 파일이 모두 있고 README와 package.json의 실행 대상과 맞는다', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    assert.equal(scripts.demo, 'node src/demo.js');
    assert.equal(scripts.receiver, 'node src/receiver/main.js');
    for (const item of LAUNCHERS) {
      assert.ok(fs.existsSync(path.join(ROOT, item.name)), `${item.name} 파일이 있어야 합니다`);
      assertContains('readme', `\`${item.name}\``);
      assert.ok(fs.existsSync(path.join(ROOT, item.program.replaceAll('\\', '/'))), `${item.program}`);
    }
  });

  for (const item of LAUNCHERS) {
    test(`${item.name}: 형식과 내용`, () => {
      const bytes = fs.readFileSync(path.join(ROOT, item.name));
      assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'BOM이 없어야 합니다');
      const text = bytes.toString('utf8');
      assert.ok(!text.includes('�'), 'UTF-8로 저장해야 합니다');
      assert.ok(text.includes(item.program), `${item.program}을 실행해야 합니다`);
      assert.ok(text.includes(item.label));
      assert.ok(text.includes('https://nodejs.org'), 'Node.js를 구하는 곳을 알려야 합니다');
      assert.ok(text.includes('LTS'));
      assert.match(text, /Node\.js 22 이상|Node\.js \$REQUIRED 이상/);

      const code = text.split(/\r?\n/).filter((line) => !/^\s*(rem\b|#|::|echo\b)/i.test(line)).join('\n');
      assert.doesNotMatch(code, FORBIDDEN, '설정을 바꾸거나 권한을 올리거나 무언가를 내려받으면 안 됩니다');

      if (item.name.endsWith('.bat')) {
        assert.equal((text.match(/(?<!\r)\n/g) || []).length, 0, '.bat 파일의 줄 끝은 CRLF여야 합니다');
        assert.ok(text.startsWith('@echo off\r\n'));
        assert.match(text, /^chcp 65001 >nul\r$/m, '한글이 깨지지 않게 코드 페이지를 UTF-8로 바꿔야 합니다');
        // cmd.exe는 코드 페이지를 바꾼 뒤 실행하는 부분에 한글이 있으면 읽는 위치를 잃는다.
        // 그래서 마지막 exit 줄까지는 ASCII만 쓰고, 한글 문구는 그 뒤의 "::[이름]문구" 줄에 둔다.
        const end = text.lastIndexOf('\r\nexit /b %RC%\r\n');
        assert.ok(end > 0, '실행 부분은 exit /b %RC% 로 끝나야 합니다');
        const executed = text.slice(0, end);
        assert.doesNotMatch(executed, /[^\x00-\x7f]/, '실행되는 부분에는 ASCII 글자만 있어야 합니다');
        assert.doesNotMatch(executed, /^\s*(goto\b|:[A-Za-z])/im, 'goto와 :이름표를 쓰지 않습니다');
        assert.match(executed, /cd \/d "%~dp0"/, '이 파일이 있는 폴더로 가야 합니다');
        // 실행 부분이 찾는 문구 이름은 모두 아래쪽에 있어야 한다.
        const names = new Set([...executed.matchAll(/\/c:"::\[([a-z-]+)\]"/g)].map((match) => match[1]));
        for (const name of [...names, 'folder', 'files', 'none', 'old']) {
          assert.ok(text.slice(end).includes(`\r\n::[${name}]`), `"::[${name}]" 문구가 있어야 합니다`);
        }
      } else {
        assert.ok(!text.includes('\r'), '.command 파일의 줄 끝은 LF여야 합니다');
        assert.ok(text.startsWith('#!/bin/bash\n'));
        assert.match(text, /cd "\$\(dirname "\$0"\)"/, '이 파일이 있는 폴더로 가야 합니다');
      }
    });
  }

  test('시연용과 받는 쪽용 실행 파일은 실행 대상과 이름만 다르다', () => {
    for (const ext of ['bat', 'command']) {
      const [demo, receiver] = LAUNCHERS.filter((item) => item.name.endsWith(`.${ext}`));
      const expected = read(demo.name).replaceAll(demo.program, receiver.program).replaceAll(demo.label, receiver.label);
      assert.equal(read(receiver.name), expected);
    }
  });

  test('.gitattributes가 줄 끝을 고정한다', () => {
    const attributes = read('.gitattributes');
    assert.match(attributes, /^\*\.bat\s+text\s+eol=crlf\s*$/m);
    assert.match(attributes, /^\*\.command\s+text\s+eol=lf\s*$/m);
  });
});
