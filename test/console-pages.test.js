// 진행 화면 파일 검사 (명세 7, 8, 9, 10, 11의 2·6·7·9).
// 진짜 시연 프로그램을 빈 포트에 띄워 화면 파일이 그대로 나오는지 보고, 파일 내용이 지켜야 할 선을 확인한다.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { CLOSING, PART2, REVEAL, STEPS, TEXT } from '../src/console/content.js';
import { DEFAULT_PUBLIC_DIR } from '../src/console/server.js';
import { SWITCH_MESSAGES } from '../src/shared/access-switch.js';
import { findForbidden, startRig } from './console-helpers.js';

const FILES = fs.readdirSync(DEFAULT_PUBLIC_DIR).sort();
const TEXT_FILES = FILES.filter((name) => /\.(html|css|js)$/.test(name));
const HTML_FILES = FILES.filter((name) => name.endsWith('.html'));
const JS_FILES = FILES.filter((name) => name.endsWith('.js'));
const read = (name) => fs.readFileSync(path.join(DEFAULT_PUBLIC_DIR, name), 'utf8');

/** 상태에서 읽어 오는 항목 이름. 글자가 아니라 이름이므로 낱말 검사에서 뺀다(값은 공개 뒤에만 서버가 보낸다). */
const STATE_FIELD_NAMES = ['permissionChecked', 'permissionLabel', 'appWithoutCheck', 'appWithCheck'];

const BUTTONS = [
  '이전', '다음', '전체 초기화', '초기화 실행', '취소', '닫기',
  '켜기', '확인', '연장', '끄기', '알림 닫기',
  '주소 적용', '연결 확인',
  '공개', '2부 다음 단계', '2부만 처음으로', '2부 되돌리기', '맥락 하나 더 보기',
];
const HEADINGS = ['다른 기기 접속', '접속 기록', '옆 기기가 가져간 것', '받는 쪽에 도착한 것', '온라인 표', 'AI 서비스'];

/** 문구 묶음에서 글자만 모두 꺼낸다. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
}

describe('진행 화면 파일: 서버가 그대로 내보낸다', () => {
  test('화면 폴더에 필요한 파일이 있다', () => {
    assert.ok(FILES.includes('index.html'));
    assert.ok(JS_FILES.length > 0 && FILES.some((name) => name.endsWith('.css')));
    for (const name of FILES) assert.match(name, /^[a-z0-9.-]+\.(html|css|js|ico)$/, name);
  });

  test('/ 와 폴더의 모든 파일이 200으로, 폴더의 바이트 그대로 나온다', async (t) => {
    const rig = await startRig(t);
    const targets = [['/', 'index.html'], ...FILES.map((name) => [`/${name}`, name])];
    for (const [urlPath, name] of targets) {
      const response = await fetch(rig.base + urlPath);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200, urlPath);
      assert.ok(body.equals(fs.readFileSync(path.join(DEFAULT_PUBLIC_DIR, name))), urlPath);
      const policy = response.headers.get('content-security-policy') || '';
      assert.match(policy, /default-src 'none'/, urlPath);
      assert.match(policy, /script-src 'self'/, urlPath);
      assert.match(policy, /style-src 'self'/, urlPath);
    }
    assert.match((await fetch(`${rig.base}/`)).headers.get('content-type'), /^text\/html/);
  });

  test('화면이 부르는 파일은 모두 폴더에 있고, 화면이 쓰는 요청 주소는 서버에 있다', async (t) => {
    const rig = await startRig(t);
    for (const name of HTML_FILES) {
      const refs = [...read(name).matchAll(/\b(?:src|href)="([^"]*)"/g)].map((match) => match[1]);
      assert.ok(refs.length > 0, name);
      for (const ref of refs) assert.ok(FILES.includes(ref), `${name} 가 폴더에 없는 '${ref}' 를 부른다`);
    }
    const script = JS_FILES.map(read).join('\n');
    const used = [...new Set([...script.matchAll(/['"`](\/api\/[a-z0-9]+)/g)].map((match) => match[1]))].sort();
    assert.deepEqual(used, ['/api/part2', '/api/receiver', '/api/reset', '/api/reveal', '/api/state', '/api/step', '/api/switch']);
    assert.equal((await rig.get('/api/state?since=0&limit=300')).status, 200);
    // 동작 주소는 모두 있는 주소다(없는 주소라면 404가 온다). 여기서는 아무것도 바꾸지 않는 잘못된 요청으로 확인한다.
    for (const pathname of used.filter((item) => item !== '/api/state' && item !== '/api/reveal' && item !== '/api/reset')) {
      const response = await rig.post(pathname, { action: '없는 동작', to: '없는 단계' });
      assert.notEqual(response.status, 404, pathname);
      assert.ok(response.json && response.json.state, `${pathname} 는 거절해도 상태를 함께 돌려준다`);
    }
  });
});

describe('진행 화면 파일의 내용', () => {
  test('외부 주소를 가리키는 것이 없다', () => {
    for (const name of TEXT_FILES) {
      const text = read(name);
      assert.doesNotMatch(text, /https?:/i, name);
      assert.doesNotMatch(text, /(^|[^:/])\/\/[A-Za-z0-9]/m, name); // '//host' 모양
      // 모양 파일이 밖에서 가져오는 것(스크립트의 new URL(...)은 주소를 읽는 것이라 해당하지 않는다).
      if (!name.endsWith('.js')) assert.doesNotMatch(text, /@import|url\(/i, name);
      assert.doesNotMatch(text, /<(img|iframe|video|audio|object|embed|base|form)\b/i, name);
      assert.doesNotMatch(text, /\bdata:/i, name);
    }
  });

  test('화면 안에 직접 쓴 스크립트·모양·이벤트 처리가 없다(서버의 콘텐츠 보안 정책과 맞는다)', () => {
    for (const name of HTML_FILES) {
      const html = read(name);
      assert.doesNotMatch(html, /<style\b/i, name);
      assert.doesNotMatch(html, /\sstyle\s*=/i, name);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, name);
      assert.doesNotMatch(html, /javascript:/i, name);
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      assert.ok(scripts.length > 0, name);
      for (const [, attrs, body] of scripts) {
        assert.match(attrs, /\bsrc="[a-z0-9.-]+\.js"/, name);
        assert.equal(body.trim(), '', name);
      }
    }
    for (const name of JS_FILES) {
      const script = read(name);
      // 서버가 준 값은 textContent로만 넣는다.
      assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\.style\b|setAttribute\('style'/, name);
      assert.match(script, /textContent/, name);
      // 브라우저의 기본 확인 창을 쓰지 않는다(화면 안에서 확인을 받는다).
      assert.doesNotMatch(script, /\b(confirm|alert|prompt)\(/, name);
    }
  });

  test('스크립트 파일은 문법 오류가 없다', () => {
    for (const name of JS_FILES) {
      const result = spawnSync(process.execPath, ['--check', path.join(DEFAULT_PUBLIC_DIR, name)], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
  });

  test('공개 전에 드러나면 안 되는 낱말이 파일에 없다(파일 이름 포함)', () => {
    for (const name of TEXT_FILES) {
      let text = `${name}\n${read(name)}`;
      for (const field of STATE_FIELD_NAMES) text = text.replaceAll(field, '');
      assert.deepEqual(findForbidden(text), [], name);
      // 앱 이름도 파일에 적지 않는다(서버 상태에서 온다).
      assert.doesNotMatch(text, /[12]번 앱/, name);
    }
    // 공개 뒤에만 나가는 글자는 한 글자도 파일에 없다.
    const files = TEXT_FILES.map(read).join('\n');
    for (const line of strings([REVEAL.notes, REVEAL.comparisonNotice, REVEAL.realRequestNote, REVEAL.permissionChecked, REVEAL.permissionNotChecked])) {
      assert.ok(!files.includes(line), `파일에 공개 뒤의 문구가 있다: ${line}`);
    }
  });

  test('결과를 미리 적어 두지 않는다: 결과 번호 숫자와 서버의 문구가 파일에 없다', () => {
    for (const name of TEXT_FILES) {
      const text = read(name);
      const numbers = [...text.matchAll(/(?<![\w.#-])(200|401|403|404)(?![\w-])/g)].map((match) => match[0]);
      assert.deepEqual(numbers, [], `${name} 에 결과 번호가 적혀 있다`);
    }
    const files = TEXT_FILES.map(read).join('\n');
    // 단계 문구, 2부 내용, 마무리 문장, 스위치·받는 쪽 안내는 서버 상태에서만 온다.
    const fromServer = [
      ...STEPS.flatMap((step) => [...step.say, ...step.guide, step.subtitle]),
      ...strings(PART2),
      ...CLOSING.sentences.map((sentence) => sentence.text),
      ...strings(SWITCH_MESSAGES),
      TEXT.switchScopeOn, TEXT.switchWarning, TEXT.secondLaptopHint, TEXT.otherDeviceNotice, TEXT.notLoggedIn,
      TEXT.receiverSamePc, TEXT.receiverUnreachable, TEXT.receiverBadReply, ...TEXT.receiverHelp,
      TEXT.pingOk, TEXT.pingUnreachable, TEXT.pingTimeout, TEXT.pingWrongReply, ...strings(TEXT.pingCauses),
      TEXT.resetReceiverFailed, TEXT.revealRunning, TEXT.revealNoReply,
    ].filter((line) => line.length >= 6);
    assert.ok(fromServer.length > 80);
    for (const line of fromServer) {
      assert.ok(!files.includes(line), `파일에 서버의 문구가 그대로 있다: ${line}`);
    }
  });

  test('직접 타이핑하는 칸은 받는 쪽 주소 하나뿐이다', () => {
    const html = HTML_FILES.map(read).join('\n');
    const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map((match) => match[0]);
    assert.equal(inputs.length, 1);
    assert.match(inputs[0], /type="text"/);
    assert.match(inputs[0], /id="receiver-host"/);
    assert.doesNotMatch(html, /<(textarea|select)\b|contenteditable/i);
    const script = JS_FILES.map(read).join('\n');
    assert.doesNotMatch(script, /createElement\(\s*['"`](input|textarea|select|form)['"`]/i);
    assert.doesNotMatch(script, /contentEditable|type\s*=\s*['"`]file/i);
  });

  test('버튼과 영역 이름이 있다', () => {
    const all = TEXT_FILES.map(read).join('\n');
    const html = read('index.html');
    for (const label of BUTTONS) assert.ok(all.includes(`>${label}<`) || all.includes(`'${label}'`), `버튼 '${label}'`);
    for (const heading of HEADINGS) assert.match(html, new RegExp(`<h[23][^>]*>${heading}[ <]`), `영역 '${heading}'`);
    assert.ok(html.includes('연결이 끊겼습니다 — 시연 프로그램이 켜져 있는지 확인하세요'));
    assert.ok(all.includes('결과 번호'));
    assert.match(html, /<html lang="ko">/);
  });

  test('켜기 요청은 경고에서 확인을 누른 자리에서만 보낸다', () => {
    const script = JS_FILES.map(read).join('\n');
    assert.equal([...script.matchAll(/confirmed:\s*true/g)].length, 1);
    const at = script.indexOf('confirmed: true');
    const handler = script.lastIndexOf("on('", at);
    assert.ok(script.slice(handler, at).startsWith("on('btn-switch-yes'"), '확인 버튼의 처리 안에 있다');
    // 전체 초기화와 2부 되돌리기도 화면 안의 확인 버튼에서만 보낸다.
    assert.equal([...script.matchAll(/'\/api\/reset'/g)].length, 1);
    assert.ok(script.slice(script.lastIndexOf("on('", script.indexOf("'/api/reset'")), script.indexOf("'/api/reset'")).startsWith("on('btn-reset-yes'"));
    const part2Reset = script.indexOf("{ action: 'reset' }");
    assert.ok(script.slice(script.lastIndexOf("on('", part2Reset), part2Reset).startsWith("on('btn-part2-reset-yes'"));
  });
});
