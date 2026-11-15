// 성적 관리 앱 화면 파일 검사 (명세 5.1, 5.5, 11의 1·2·6·7).
// 실제 서버 두 개(권한을 확인하지 않는 쪽 / 확인하는 쪽)를 띄워 실제 요청으로 확인한다.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import vm from 'node:vm';

import { DEFAULT_PUBLIC_DIR } from '../src/app/server.js';
import { ALL_GOOD, NEIGHBOR, call, startApps } from './app-helpers.js';

const BANNER = '교육용 실습 / 100% 합성 데이터 / 실제 개인정보 입력 금지';
const TITLE = '6학년 가상반 성적 관리 시스템 (교육용 가상 데이터)';
const LOGIN_NOTICE = '교육용 계정이며 실제 인증 체계를 대신하지 않습니다';
const NEIGHBOR_SENTENCE = '주소창이나 브라우저 기본 도구로 누구나 할 수 있는 요청을 버튼으로 옮긴 것입니다';
const NEIGHBOR_BUTTONS = [
  '명단 주소 직접 열기',
  '학부모로 로그인',
  '내 아이 성적표 조회',
  '학생번호만 바꿔 조회',
  '반 전체 수집',
  '숨겨진 담임 기능 부르기',
  '내 아이 성적 고치기',
];
const MAIN_LABELS = ['로그인', '로그아웃', '내 아이 성적표', '반 명단', '성적 저장', 'AI 종합의견 초안 만들기', '학생 기록 삭제'];
const FORBIDDEN = ['unsafe', 'insecure', 'secure', 'vuln', 'leak', 'guard', 'protect', 'safe', '취약', '안전', '허술', '막아', '보호'];

const FILES = fs.readdirSync(DEFAULT_PUBLIC_DIR).sort();
const read = (name) => fs.readFileSync(path.join(DEFAULT_PUBLIC_DIR, name), 'utf8');
const studentId = (n) => `TEST-10${String(n).padStart(2, '0')}`;

async function bytes(base, urlPath) {
  const response = await fetch(base + urlPath);
  return { status: response.status, type: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) };
}

describe('화면 파일: 두 앱이 똑같이 내보낸다', () => {
  let apps;
  before(async () => {
    apps = await startApps({ publicDir: DEFAULT_PUBLIC_DIR });
  });
  after(async () => {
    await apps.close();
  });

  test('화면 폴더에 필요한 파일이 있다', () => {
    for (const name of ['index.html', 'neighbor.html']) assert.ok(FILES.includes(name), name);
    for (const name of FILES) assert.match(name, /^[a-z0-9.-]+\.(html|css|js)$/, name);
  });

  test('/, /neighbor 와 모든 파일의 바이트가 두 앱에서 같고, 폴더의 파일 그대로다', async () => {
    const targets = [['/', 'index.html'], ['/neighbor', 'neighbor.html'], ...FILES.map((name) => [`/${name}`, name])];
    for (const [urlPath, name] of targets) {
      const a = await bytes(apps.urlA, urlPath);
      const b = await bytes(apps.urlB, urlPath);
      assert.equal(a.status, 200, urlPath);
      assert.equal(b.status, 200, urlPath);
      assert.equal(a.type, b.type, urlPath);
      assert.ok(a.body.equals(b.body), `${urlPath} 가 두 앱에서 다르다`);
      assert.ok(a.body.equals(fs.readFileSync(path.join(DEFAULT_PUBLIC_DIR, name))), urlPath);
    }
  });

  test('앱 이름은 /api/app 에서만 온다(파일에는 없다)', async () => {
    assert.deepEqual((await call(apps.urlA, 'GET', '/api/app')).json, { label: '1번 앱' });
    assert.deepEqual((await call(apps.urlB, 'GET', '/api/app')).json, { label: '2번 앱' });
    for (const name of FILES) {
      assert.doesNotMatch(read(name), /[12]번 앱/, name);
    }
    assert.match(read('index.js'), /\/api\/app/);
    assert.match(read('neighbor.js'), /\/api\/app/);
  });
});

describe('화면 파일의 내용', () => {
  test('구분되는 낱말이 없다(파일 이름 포함)', () => {
    for (const name of FILES) {
      const text = `${name}\n${read(name)}`
        .replaceAll('guardianName', '')
        .replaceAll('guardianPhone', '')
        .replaceAll('보호자', '')
        .toLowerCase();
      for (const word of FORBIDDEN) {
        assert.ok(!text.includes(word), `${name} 에 '${word}' 가 있다`);
      }
    }
  });

  test('외부 주소를 가리키는 것이 없다', () => {
    for (const name of FILES) {
      const text = read(name);
      assert.doesNotMatch(text, /https?:/i, name);
      assert.doesNotMatch(text, /(^|[^:/])\/\/[A-Za-z0-9]/, name); // '//host' 모양
      assert.doesNotMatch(text, /@import|url\(/i, name);
      assert.doesNotMatch(text, /<(img|iframe|video|audio|object|embed)\b/i, name);
    }
    for (const name of FILES.filter((file) => file.endsWith('.html'))) {
      const refs = [...read(name).matchAll(/\b(?:src|href)="([^"]*)"/g)].map((match) => match[1]);
      for (const ref of refs) {
        assert.ok(ref === 'data:,' || FILES.includes(ref), `${name} 가 폴더에 없는 '${ref}' 를 부른다`);
      }
    }
  });

  test('고정 표시·제목·로그인 안내·옆 사람 화면 문장이 있다', () => {
    const main = read('index.html');
    const neighbor = read('neighbor.html');
    for (const html of [main, neighbor]) {
      assert.ok(html.includes(BANNER));
      assert.ok(html.includes(`<title>${TITLE}</title>`));
      assert.ok(html.indexOf(BANNER) < html.indexOf('<header'), '고정 표시는 맨 위에 있다');
    }
    assert.ok(main.includes(`<h1>${TITLE}</h1>`));
    assert.ok(main.includes(LOGIN_NOTICE));
    assert.ok(neighbor.includes(NEIGHBOR_SENTENCE));
  });

  test('메인 화면의 메뉴 이름이 있고, 저장 뒤에는 "저장되었습니다"만 보여준다', () => {
    const main = read('index.html') + read('index.js');
    for (const label of MAIN_LABELS) assert.ok(main.includes(label), label);
    assert.ok(read('index.js').includes("'저장되었습니다'"));
    // 다른 곳으로 보낸다는 말이 어느 화면 파일에도 없다.
    for (const name of FILES) {
      assert.doesNotMatch(read(name), /받는 쪽|온라인 표|전송|보냈|보냅니다|receiver/i, name);
    }
  });

  test('옆 사람 화면의 버튼 일곱 개가 순서대로 있고 로그아웃도 있다', () => {
    const neighbor = read('neighbor.html');
    let last = -1;
    for (const label of NEIGHBOR_BUTTONS) {
      const at = neighbor.indexOf(`>${label}</button>`);
      assert.ok(at > last, label);
      last = at;
    }
    assert.ok(neighbor.includes('>로그아웃</button>'));
    assert.equal((neighbor.match(/<button\b/g) || []).length, NEIGHBOR_BUTTONS.length + 1);
  });

  test('옆 사람 화면에는 미리 써 둔 결과가 없다', () => {
    const neighbor = read('neighbor.html');
    assert.doesNotMatch(neighbor, /\b(200|400|401|403|404|500|502)\b/);
    assert.doesNotMatch(neighbor, /가상학생|가상보호자|010-|성공|실패/);
    assert.match(neighbor, /<div class="feed" id="feed"><\/div>/);
    assert.match(neighbor, /<div id="collect-table"><\/div>/);
    // 결과 번호는 스크립트에도 글자로 박혀 있지 않다(비교용 200 하나만 쓴다).
    assert.doesNotMatch(read('neighbor.js'), /\b(401|403|404)\b/);
  });

  test('표시는 옆 사람 화면만 붙인다', () => {
    const neighborJs = read('neighbor.js');
    assert.match(neighborJs, /'X-Demo-Screen'/);
    assert.match(neighborJs, /'neighbor'/);
    // 요청은 한 곳(ask)에서만 보내고, 거기서 표시를 붙인다.
    assert.equal((neighborJs.match(/\bfetch\(/g) || []).length, 1);
    assert.match(neighborJs, /headers\[SCREEN_HEADER\] = SCREEN_MARK;[\s\S]{0,400}fetch\(path, init\)/);
    assert.doesNotMatch(read('neighbor.html'), /<script(?![^>]*\bsrc=)/, '끼워 넣은 스크립트가 없다');
    for (const name of ['index.html', 'index.js', 'styles.css']) {
      assert.doesNotMatch(read(name), /x-demo-screen/i, name);
      assert.doesNotMatch(read(name), /neighbor/i, name);
    }
    assert.doesNotMatch(read('index.html'), /<script(?![^>]*\bsrc=)/);
    assert.match(read('index.html'), /<script src="index\.js"><\/script>/);
    assert.match(read('neighbor.html'), /<script src="neighbor\.js"><\/script>/);
  });

  test('타이핑하는 칸은 로그인 칸 두 개뿐이다', () => {
    const main = read('index.html');
    const formStart = main.indexOf('<form id="login-form"');
    const formEnd = main.indexOf('</form>');
    assert.ok(formStart > 0 && formEnd > formStart);
    const inputs = [...main.matchAll(/<input\b[^>]*>/g)];
    assert.deepEqual(inputs.map((match) => /type="([^"]*)"/.exec(match[0])[1]), ['text', 'password']);
    for (const match of inputs) assert.ok(match.index > formStart && match.index < formEnd);
    assert.doesNotMatch(read('neighbor.html'), /<input\b/i);
    for (const name of FILES) {
      const text = read(name);
      assert.doesNotMatch(text, /<textarea|contenteditable|type="file"/i, name);
      assert.doesNotMatch(text, /createElement\(\s*['"](input|textarea)['"]/i, name);
      assert.doesNotMatch(text, /prompt\(/, name);
    }
    // 학생번호 고르기는 고르는 칸이다.
    assert.match(read('neighbor.html'), /<select id="pick-id"><\/select>/);
  });

  test('서버가 준 값은 textContent 로만 그린다', () => {
    for (const name of FILES.filter((file) => file.endsWith('.js'))) {
      const text = read(name);
      assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/, name);
      assert.match(text, /textContent/, name);
    }
  });

  test('반 전체 수집 간격은 이름 붙인 값(약 0.15초)이다', () => {
    const neighborJs = read('neighbor.js');
    assert.match(neighborJs, /var COLLECT_GAP_MS = 150;/);
    assert.match(neighborJs, /setTimeout\(step, COLLECT_GAP_MS\)/);
  });

  test('스크립트 파일이 문법 검사를 통과한다', () => {
    const scripts = FILES.filter((file) => file.endsWith('.js'));
    assert.ok(scripts.length >= 2);
    for (const name of scripts) {
      const result = spawnSync(process.execPath, ['--check', path.join(DEFAULT_PUBLIC_DIR, name)], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
  });
});

// 화면 스크립트를 아주 작은 흉내 화면(필요한 만큼만 만든 요소) 위에서 그대로 실행한다.
// fetch가 거절되는 상황(서버가 꺼졌거나 연결이 끊김)에서 화면이 어떻게 되는지 본다.
function fakePage(html, fetchImpl) {
  function node(tag) {
    const listeners = {};
    const classes = new Set();
    const self = {
      tag,
      children: [],
      textContent: '',
      className: '',
      value: '',
      disabled: false,
      style: {},
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      get firstChild() { return self.children[0] || null; },
      appendChild(child) { self.children.push(child); return child; },
      insertBefore(child, before) {
        const at = before ? self.children.indexOf(before) : -1;
        if (at < 0) self.children.push(child); else self.children.splice(at, 0, child);
        return child;
      },
      removeChild(child) { self.children.splice(self.children.indexOf(child), 1); return child; },
      setAttribute() {},
      getAttribute() { return null; },
      querySelectorAll() { return []; },
      addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
      fire(type) { for (const handler of listeners[type] || []) handler({ preventDefault() {} }); },
      /** 이 요소와 그 아래의 글자를 모두 이은 것. */
      text() { return [self.textContent, ...self.children.map((child) => child.text())].join(' '); },
    };
    return self;
  }
  const byId = {};
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) byId[id] = node('div');
  const document = {
    readyState: 'complete',
    hidden: false,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => node(tag),
    addEventListener() {},
  };
  const timers = [];
  const context = {
    document,
    window: { addEventListener() {} },
    fetch: fetchImpl,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    JSON, String, Array, Object, Promise, encodeURIComponent,
  };
  return { byId, context, timers };
}
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

describe('연결이 되지 않을 때의 화면 (fetch가 거절됨)', () => {
  const failing = (calls) => (urlPath, init) => {
    calls.push(`${init.method} ${urlPath}`);
    return Promise.reject(new TypeError('Failed to fetch'));
  };

  test('옆 사람 화면: 반 전체 수집이 멈추고 버튼이 다시 눌리며, 결과 번호를 지어내지 않고 "연결하지 못했습니다"를 보여준다', async () => {
    const calls = [];
    const page = fakePage(read('neighbor.html'), failing(calls));
    vm.runInNewContext(read('neighbor.js'), page.context);
    await settle();
    const feed = page.byId.feed;
    assert.equal(feed.children.length, 0, '화면을 열 때의 확인 요청은 결과 목록에 넣지 않는다');
    assert.equal(page.byId.who.textContent, '로그인 안 함');

    calls.length = 0;
    page.byId['btn-collect'].fire('click');
    assert.equal(page.byId['btn-collect'].disabled, true, '수집하는 동안에는 눌리지 않는다');
    await settle();
    assert.equal(page.byId['btn-collect'].disabled, false, '연결이 안 되면 버튼이 다시 눌린다');
    assert.deepEqual(calls, ['GET /api/students/TEST-1001'], '첫 요청이 가지 못했으면 나머지 19개를 보내지 않는다');
    assert.equal(page.timers.length, 0, '다음 요청을 예약하지 않는다');
    assert.equal(feed.children.length, 1);
    const entry = feed.children[0].text();
    assert.match(entry, /GET \/api\/students\/TEST-1001/);
    assert.match(entry, /연결하지 못했습니다/);
    assert.match(entry, /Failed to fetch/, '브라우저가 실제로 알려 준 내용을 그대로 붙인다');
    assert.match(entry, /결과 번호\s+응답 없음/);
    assert.doesNotMatch(entry.split('결과 번호')[1], /\d|null|undefined/, '결과 번호를 지어내지 않는다');
    assert.equal(page.byId['count-got'].textContent, '0');
    assert.equal(page.byId['count-refused'].textContent, '0', '서버가 거절한 것이 아니므로 거절로 세지 않는다');

    // 다시 누르면 다시 시도한다(새로 고침이 필요 없다).
    page.byId['btn-collect'].fire('click');
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(page.byId['btn-collect'].disabled, false);

    // 다른 버튼들도 같은 표시를 남긴다.
    for (const id of ['btn-roster', 'btn-login', 'btn-mine', 'btn-pick', 'btn-list', 'btn-fix', 'logout']) {
      const before = feed.children.length;
      page.byId[id].fire('click');
      await settle();
      assert.equal(feed.children.length, before + 1, id);
      assert.match(feed.children[0].text(), /연결하지 못했습니다/, id);
      assert.match(feed.children[0].text(), /결과 번호\s+응답 없음/, id);
    }
    assert.equal(page.byId.who.textContent, '로그인 안 함');
  });

  test('옆 사람 화면: 수집 도중에 연결이 끊기면 그때까지 받은 것은 남기고 거기서 멈춘다', async () => {
    const calls = [];
    const record = (id) => ({ id, name: `가상학생${id.slice(-2)}`, ratings: {}, comment: '', guardianName: '', guardianPhone: '' });
    const fetchImpl = (urlPath, init) => {
      calls.push(`${init.method} ${urlPath}`);
      const id = urlPath.split('/').pop();
      if (!urlPath.startsWith('/api/students/') || calls.filter((line) => line.includes('/api/students/')).length > 3) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(record(id))) });
    };
    const page = fakePage(read('neighbor.html'), fetchImpl);
    vm.runInNewContext(read('neighbor.js'), page.context);
    await settle();
    calls.length = 0;
    page.byId['btn-collect'].fire('click');
    for (let i = 0; i < 6; i += 1) {
      await settle();
      const next = page.timers.shift();
      if (next) next();
    }
    await settle();
    assert.equal(calls.length, 4, '네 번째 요청이 가지 못한 뒤에는 더 보내지 않는다');
    assert.equal(page.byId['count-got'].textContent, '3');
    assert.equal(page.byId['count-refused'].textContent, '0');
    assert.equal(page.byId['btn-collect'].disabled, false);
    assert.match(page.byId.feed.children[0].text(), /연결하지 못했습니다/);
    assert.match(page.byId.feed.children[1].text(), /결과 번호\s+200/);
  });

  test('메인 화면: 연결이 안 되면 로그인 화면에 "연결하지 못했습니다"가 나오고, 결과 번호를 지어내지 않는다', async () => {
    const calls = [];
    const page = fakePage(read('index.html'), failing(calls));
    vm.runInNewContext(read('index.js'), page.context);
    await settle();
    assert.equal(page.byId['login-view'].classList.contains('hidden'), false, '로그인 화면이 보인다');
    assert.match(page.byId['login-msg'].textContent, /연결하지 못했습니다/);
    page.byId['login-msg'].textContent = '';
    page.byId['login-form'].fire('submit');
    await settle();
    assert.match(page.byId['login-msg'].textContent, /로그인하지 못했습니다/);
    assert.match(page.byId['login-msg'].textContent, /연결하지 못했습니다/);
    assert.doesNotMatch(page.byId['login-msg'].textContent, /결과 번호|null|undefined/);
    // 담임 화면의 버튼들
    page.byId['teacher-refresh'].fire('click');
    await settle();
    assert.match(page.byId['roster-list'].text(), /명단을 불러오지 못했습니다.*연결하지 못했습니다/);
    assert.doesNotMatch(page.byId['roster-list'].text(), /결과 번호|null|undefined/);
    page.byId['teacher-logout'].fire('click');
    await settle();
    assert.match(page.byId['login-msg'].textContent, /연결하지 못/);
  });

  test('연결 실패는 요청을 보내는 한 곳(ask)에서 받아 결과로 바꾼다', () => {
    for (const name of ['index.js', 'neighbor.js']) {
      const script = read(name);
      assert.equal((script.match(/\bfetch\(/g) || []).length, 1, name);
      assert.match(script, /status: null/, name);
      assert.doesNotMatch(script, /status: 0\b/, name);
    }
  });
});

// 옆 사람 화면의 버튼이 보내는 요청을 같은 순서로 실제로 보낸다(표시 포함).
// 화면에 나올 결과 번호가 무엇인지 여기서 확인한다.
describe('옆 사람 화면의 버튼이 보내는 요청', () => {
  let apps;
  before(async () => {
    apps = await startApps({ publicDir: DEFAULT_PUBLIC_DIR });
  });
  after(async () => {
    await apps.a.whenIdle();
    await apps.b.whenIdle();
    await apps.close();
  });

  async function pressAll(base) {
    const seen = {};
    const send = (method, urlPath, cookie, body) => call(base, method, urlPath, { cookie, body, headers: NEIGHBOR });
    // 화면이 열릴 때
    seen.app = (await send('GET', '/api/app')).status;
    seen.meBefore = (await send('GET', '/api/me')).status;
    // 1. 명단 주소 직접 열기 (로그인 없이)
    seen.roster = (await send('GET', '/api/roster')).status;
    // 2. 학부모로 로그인
    const loggedIn = await send('POST', '/api/login', undefined, { loginId: 'parent01', password: 'demo1234' });
    seen.login = loggedIn.status;
    seen.loginId = loggedIn.json.loginId;
    const cookie = loggedIn.cookie;
    // 3. 내 아이 성적표 조회
    const mine = await send('GET', '/api/students/TEST-1001', cookie);
    seen.mine = mine.status;
    seen.mineRecord = mine.json;
    // 4. 학생번호만 바꿔 조회
    seen.other = (await send('GET', '/api/students/TEST-1002', cookie)).status;
    // 5. 반 전체 수집
    seen.collect = [];
    for (let n = 1; n <= 20; n += 1) {
      seen.collect.push((await send('GET', `/api/students/${studentId(n)}`, cookie)).status);
    }
    // 6. 숨겨진 담임 기능 부르기
    seen.list = (await send('GET', '/api/students', cookie)).status;
    // 7. 내 아이 성적 고치기
    const fixed = await send('PUT', '/api/students/TEST-1001/ratings', cookie, { ratings: ALL_GOOD });
    seen.fix = fixed.status;
    seen.fixBody = fixed.json;
    // 로그아웃
    seen.logout = (await send('POST', '/api/logout', cookie)).status;
    seen.meAfter = (await send('GET', '/api/me', cookie)).status;
    return seen;
  }

  test('권한을 확인하지 않는 앱: 전부 200', async () => {
    const seen = await pressAll(apps.urlA);
    assert.equal(seen.app, 200);
    assert.equal(seen.meBefore, 401);
    assert.equal(seen.roster, 200);
    assert.equal(seen.login, 200);
    assert.equal(seen.loginId, 'parent01');
    assert.equal(seen.mine, 200);
    assert.deepEqual(Object.keys(seen.mineRecord), ['id', 'name', 'className', 'ratings', 'comment', 'guardianName', 'guardianPhone']);
    assert.equal(seen.other, 200);
    assert.deepEqual(seen.collect, Array(20).fill(200));
    assert.equal(seen.list, 200);
    assert.equal(seen.fix, 200);
    assert.deepEqual(seen.fixBody.ratings, ALL_GOOD);
    assert.equal(seen.logout, 200);
    assert.equal(seen.meAfter, 401);
    const summary = apps.a.getNeighborSummary();
    assert.equal(summary.studentCount, 20);
    assert.equal(summary.rosterCount, 20);
  });

  test('권한을 확인하는 앱: 자기 아이만 200', async () => {
    const seen = await pressAll(apps.urlB);
    assert.equal(seen.app, 200);
    assert.equal(seen.meBefore, 401);
    assert.equal(seen.roster, 401);
    assert.equal(seen.login, 200);
    assert.equal(seen.mine, 200);
    assert.equal(seen.other, 403);
    assert.deepEqual(seen.collect, [200, ...Array(19).fill(403)]);
    assert.equal(seen.list, 403);
    assert.equal(seen.fix, 403);
    assert.equal(typeof seen.fixBody.error, 'string');
    assert.equal(seen.logout, 200);
    const summary = apps.b.getNeighborSummary();
    assert.equal(summary.studentCount, 1);
    assert.equal(summary.rosterCount, 0);
  });

  test('로그인 없이 버튼을 누르면 조회는 두 앱 모두 401', async () => {
    for (const base of [apps.urlA, apps.urlB]) {
      const response = await call(base, 'GET', '/api/students/TEST-1001', { headers: NEIGHBOR });
      assert.equal(response.status, 401);
      assert.equal(typeof response.json.error, 'string');
    }
  });

  test('수집 도중 지워진 번호는 404이고 나머지는 계속 받는다', async () => {
    const teacher = (await call(apps.urlA, 'POST', '/api/login', { body: { loginId: 'teacher', password: 'teacher1234' } })).cookie;
    assert.equal((await call(apps.urlA, 'DELETE', '/api/students/TEST-1005', { cookie: teacher })).status, 200);
    const parent = (await call(apps.urlA, 'POST', '/api/login', {
      body: { loginId: 'parent01', password: 'demo1234' },
      headers: NEIGHBOR,
    })).cookie;
    const statuses = [];
    for (let n = 1; n <= 20; n += 1) {
      statuses.push((await call(apps.urlA, 'GET', `/api/students/${studentId(n)}`, { cookie: parent, headers: NEIGHBOR })).status);
    }
    assert.equal(statuses[4], 404);
    assert.equal(statuses.filter((status) => status === 200).length, 19);
  });
});
