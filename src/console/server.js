// 진행 화면 서버 (명세 7, 8, 9, 10, 11-4, 12)
//
// 발표자만 쓰는 화면의 서버다. 이 서버는 접속 스위치에 등록하지 않는다.
// 부르는 쪽이 http.js의 listen(server, port)로 127.0.0.1에만 열기 때문에,
// 스위치가 켜져 있든 꺼져 있든 다른 기기에서는 연결 자체가 되지 않는다.
// 그에 더해 모든 요청에서 Host를 확인하고(이 프로그램의 주소로 온 요청만),
// 다른 사이트의 화면이 이 PC의 브라우저를 시켜 보낸 요청은 처리하지 않는다.
//
// 요청 (본문·응답은 JSON, 오류는 { "error": "<한국어>" }):
//   GET  /api/state      화면 전체 상태 (?since=<기록 번호>&limit=<줄 수>)
//   POST /api/step       { to: 'next' | 'prev' | '<단계 id>' }
//   POST /api/switch     { action: 'on', confirmed: true } | { action: 'extend' | 'off' | 'dismiss' }
//   POST /api/receiver   { action: 'set', host } | { action: 'ping' }
//   POST /api/reveal     (본문 없음) 다섯 시도를 두 앱에 실제로 보낸다
//   POST /api/part2      { action: 'next' | 'context' | 'reset' } | { action: 'choose', which: 'first'|'second', choice }
//   POST /api/reset      (본문 없음) 전체 초기화
// 동작 요청은 성공하면 200 { state, ... }, 거절하면 { error, state }를 돌려준다(화면이 바로 다시 그릴 수 있게).
//
// 이 서버가 밖으로 보내는 요청은 두 가지뿐이다: 같은 PC(127.0.0.1)의 두 앱, 그리고 확인된 받는 쪽 주소.
// 화면에 나가는 결과(공개 결과, 도착한 것, 연결 확인)는 모두 그 순간 실제로 받은 대답에서 만든다.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { SWITCH_MESSAGES } from '../shared/access-switch.js';
import { isSamePcAddress } from '../shared/address.js';
import { closeServer, readJsonBody, sendError, sendJson, serveStatic } from '../shared/http.js';
import { CLOSING, FIXED_NOTICE, REVEAL, STEPS, TEXT } from './content.js';
import { createPart2 } from './part2.js';
import { runRevealOn } from './reveal.js';

/** 화면 파일 폴더의 기본값: src/console/public/ (없으면 화면 요청에 404로 답한다). */
export const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
/** 한 번에 돌려주는 접속 기록 줄 수의 기본값과 최댓값. */
export const DEFAULT_LOG_LIMIT = 200;
export const MAX_LOG_LIMIT = 500;
/** 받는 쪽의 표·AI 목록에서 한 번에 돌려주는 최대 개수(가장 최근 것). 개수는 따로 알려 준다. */
export const RECEIVED_VIEW_LIMIT = 300;

const BODY_LIMIT_BYTES = 2 * 1024;
const RECEIVER_REPLY_LIMIT = 8 * 1024 * 1024;
const FAILED_TRANSFER_LIMIT = 50;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = (ms) => new Promise((resolve) => { const id = setTimeout(resolve, ms); if (id.unref) id.unref(); });
const isoTime = (at) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? String(at) : date.toISOString();
};

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 진행 화면 서버를 만든다(아직 열지는 않는다).
 *
 *   const consoleApp = createConsole({ apps, accessSwitch: sw, receiverAddress });
 *   await listen(consoleApp.server, 4170);      // http.js의 listen: 127.0.0.1에만 연다. 스위치에는 등록하지 않는다.
 *   await consoleApp.close();
 *
 * @param {object} options
 * @param {Array<{key: string, label: string, app: object, baseUrl: string, checkPermission: boolean}>} options.apps
 *   두 앱. key: 'app1'/'app2'(스위치에 등록한 이름), app: createGradeApp()이 돌려준 것,
 *   baseUrl: 'http://127.0.0.1:<포트>', checkPermission: 그 앱을 만들 때 준 값(공개 뒤에만 화면으로 나간다)
 * @param {object} options.accessSwitch 두 앱을 등록한 접속 스위치
 * @param {object} options.receiverAddress createReceiverAddress()가 돌려준 것(두 앱과 함께 쓰는 설정 하나)
 * @param {string} [options.publicDir] 화면 파일 폴더
 * @param {() => number} [options.now] 시계(기본 Date.now)
 * @param {number} [options.receiverCacheMs] 받는 쪽에 다시 묻기까지의 최소 간격(기본 1000)
 * @param {number} [options.receiverTimeoutMs] 받는 쪽의 대답을 기다리는 시간(기본 1500)
 * @param {number} [options.receiverWaitMs] 상태 요청이 진행 중인 받는 쪽 질의를 기다려 주는 시간(기본 300).
 *   그 안에 끝나지 않으면 직전 결과를 돌려주고, 질의 결과는 다음 요청에 반영된다.
 * @param {number} [options.actionWaitMs] 동작 요청 뒤의 상태가 받는 쪽 질의를 기다려 주는 시간(기본 1200)
 * @param {number} [options.pingTimeoutMs] 연결 확인을 기다리는 시간(기본 2500)
 * @param {number} [options.clearTimeoutMs] 받는 쪽 지우기 요청을 기다리는 시간(기본 2000)
 * @param {number} [options.idleWaitMs] 전체 초기화 때 가는 중인 전송을 기다리는 시간(기본 3500)
 * @param {number} [options.revealTimeoutMs] 공개 요청 하나를 기다리는 시간(기본 3000)
 * @param {number} [options.maxLogEntries] 합친 접속 기록에 남겨 두는 줄 수(기본 2000)
 */
export function createConsole(options) {
  const {
    apps,
    accessSwitch,
    receiverAddress,
    publicDir = DEFAULT_PUBLIC_DIR,
    now = Date.now,
    receiverCacheMs = 1000,
    receiverTimeoutMs = 1500,
    receiverWaitMs = 300,
    actionWaitMs = 1200,
    pingTimeoutMs = 2500,
    clearTimeoutMs = 2000,
    idleWaitMs = 3500,
    revealTimeoutMs = 3000,
    maxLogEntries = 2000,
  } = options || {};

  if (!Array.isArray(apps) || apps.length === 0) throw new TypeError('앱 목록(apps)이 필요합니다.');
  for (const item of apps) {
    if (!item || typeof item.key !== 'string' || typeof item.label !== 'string' || !item.app
      || typeof item.baseUrl !== 'string' || typeof item.checkPermission !== 'boolean') {
      throw new TypeError('앱 항목에는 key, label, app, baseUrl, checkPermission이 필요합니다.');
    }
  }
  if (!accessSwitch || typeof accessSwitch.status !== 'function') throw new TypeError('접속 스위치(accessSwitch)가 필요합니다.');
  if (!receiverAddress || typeof receiverAddress.get !== 'function') throw new TypeError('받는 쪽 주소 설정(receiverAddress)이 필요합니다.');

  // ------------------------------------------------------------------ 상태 (메모리에만 둔다)

  let stepIndex = 0;
  const part2 = createPart2();
  /** 전체 초기화 때마다 커진다. 초기화 전에 시작한 공개의 결과는 버린다. */
  let epoch = 0;
  let closed = false;

  /** 두 앱의 접속 기록을 들어온 순서(= 시간 순서)대로 합친 것. */
  let log = [];
  let logId = 0;
  let logTotal = 0;
  let logEpoch = 1;

  let revealed = false;
  let revealRunning = false;
  let revealResult = null;
  let revealCount = 0;

  let resetting = false;
  let lastReset = null;
  let lastPing = null;

  const unsubscribes = apps.map((item, index) => item.app.subscribe((event) => {
    if (event.type !== 'access' || closed) return;
    logId += 1;
    logTotal += 1;
    log.push({ id: logId, appKey: item.key, appNo: index + 1, entry: event.entry });
    if (log.length > maxLogEntries) log.splice(0, log.length - maxLogEntries);
  }));

  // ------------------------------------------------------------------ 받는 쪽에 실제로 물어보기

  const emptyReceived = (reachable, error, status = null) => ({
    reachable, error, status, checkedAt: reachable === null ? null : now(), sheet: [], ai: [], sheetCount: 0, aiCount: 0,
  });
  /** 가장 최근에 받는 쪽에 물어본 결과. gen은 주소가 바뀌거나 지웠을 때 커진다(옛 질의의 결과를 버리기 위해). */
  const received = { gen: 0, askedAt: -Infinity, view: emptyReceived(null, null), inflight: null };

  async function askReceiver() {
    let base;
    try {
      base = receiverAddress.base();
      const response = await fetch(`${base}/api/received`, {
        redirect: 'error',
        signal: AbortSignal.timeout(receiverTimeoutMs),
      });
      const text = await response.text();
      if (!response.ok || text.length > RECEIVER_REPLY_LIMIT) return emptyReceived(false, TEXT.receiverBadReply, response.status);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return emptyReceived(false, TEXT.receiverBadReply, response.status);
      }
      if (!isPlainObject(body) || !Array.isArray(body.sheet) || !Array.isArray(body.ai)) {
        return emptyReceived(false, TEXT.receiverBadReply, response.status);
      }
      return {
        reachable: true,
        error: null,
        status: response.status,
        checkedAt: now(),
        // 받는 쪽이 돌려준 것 그대로(받은 순서). 너무 많으면 가장 최근 것만 싣고 개수는 따로 알린다.
        sheet: body.sheet.slice(-RECEIVED_VIEW_LIMIT),
        ai: body.ai.slice(-RECEIVED_VIEW_LIMIT),
        sheetCount: body.sheet.length,
        aiCount: body.ai.length,
      };
    } catch {
      return emptyReceived(false, TEXT.receiverUnreachable);
    }
  }

  function startAsk() {
    const gen = received.gen;
    received.askedAt = performance.now();
    const job = askReceiver().then((view) => {
      if (gen === received.gen && !closed) received.view = view;
    }, () => {}).finally(() => {
      if (received.inflight === job) received.inflight = null;
    });
    received.inflight = job;
    return job;
  }

  /**
   * 필요하면 받는 쪽에 다시 묻는다. 한 번에 하나만 묻고, 평소에는 receiverCacheMs 안에 다시 묻지 않는다.
   * force: 방금 무언가 바뀌었으니 간격과 상관없이 새로 묻는다.
   */
  async function refreshReceived({ force = false, waitMs }) {
    if (closed) return;
    if (force && received.inflight) await Promise.race([received.inflight, sleep(waitMs)]);
    if (!received.inflight) {
      if (!force && performance.now() - received.askedAt < receiverCacheMs) return;
      startAsk();
    }
    if (received.inflight) await Promise.race([received.inflight, sleep(waitMs)]);
  }

  /** 주소가 바뀌었거나 받는 쪽을 지웠다: 예전 결과를 버린다. */
  function dropReceived(view = emptyReceived(null, null)) {
    received.gen += 1;
    received.inflight = null;
    received.askedAt = -Infinity;
    received.view = view;
  }

  // ------------------------------------------------------------------ 화면 상태 만들기

  function stepView() {
    const step = STEPS[stepIndex];
    const live = [];
    // ①에서 스위치가 꺼져 있는 동안: "지금은 이 PC에서만 열립니다" (명세 8.4)
    if (step.id === 'scene1' && !accessSwitch.status().on) live.push(SWITCH_MESSAGES.localOnly);
    return {
      index: stepIndex,
      total: STEPS.length,
      id: step.id,
      hasPrev: stepIndex > 0,
      hasNext: stepIndex < STEPS.length - 1,
      current: {
        id: step.id,
        label: step.label,
        title: step.title,
        subtitle: step.subtitle,
        say: [...step.say],
        guide: [...step.guide],
        live,
      },
    };
  }

  function switchView() {
    const status = accessSwitch.status();
    return {
      on: status.on,
      remainingMs: status.remainingMs,
      limitMs: status.limitMs,
      warning: status.warning,
      warningMessage: status.warning ? TEXT.switchWarning : null,
      autoOff: status.autoOff,
      autoOffMessage: status.autoOff ? SWITCH_MESSAGES.autoOff : null,
      localOnlyMessage: status.on ? null : SWITCH_MESSAGES.localOnly,
      scope: status.on ? TEXT.switchScopeOn : TEXT.switchScopeOff,
      confirmWarning: SWITCH_MESSAGES.confirmWarning,
      addresses: status.addresses,
      noInternalAddress: status.noInternalAddress,
      guidance: status.guidance,
      secondLaptopHint: TEXT.secondLaptopHint,
      apps: apps.map((item) => ({
        key: item.key,
        label: item.label,
        port: Number(new URL(item.baseUrl).port),
        localUrl: item.baseUrl,
        localNeighborUrl: `${item.baseUrl}/neighbor`,
        urls: accessSwitch.urlsFor(item.key, '/'),
        neighborUrls: accessSwitch.urlsFor(item.key, '/neighbor'),
      })),
      failures: status.failures.map((failure) => failure.message),
    };
  }

  function logEntryView({ id, appKey, appNo, entry }) {
    const view = {
      id,
      at: entry.at,
      time: entry.time,
      app: entry.app,
      appKey,
      appNo,
      clientAddress: entry.clientAddress,
      samePc: entry.samePc,
      otherDevice: !entry.samePc,
      sourceLabel: entry.samePc ? TEXT.samePc : TEXT.otherDevice,
      notice: entry.samePc ? null : TEXT.otherDeviceNotice,
      loginId: entry.loginId,
      loginLabel: entry.loginId === null ? TEXT.notLoggedIn : entry.loginId,
      method: entry.method,
      path: entry.path,
      request: `${entry.method} ${entry.path}`,
      status: entry.status,
      fromNeighborScreen: entry.neighbor,
    };
    // 권한 확인 여부는 공개 뒤에만 싣는다(명세 8.1, 8.5). 앱이 그 요청에 실제로 남긴 값이다.
    if (revealed) {
      view.permissionChecked = entry.permissionChecked;
      view.permissionLabel = entry.permissionChecked ? REVEAL.permissionChecked : REVEAL.permissionNotChecked;
    }
    return view;
  }

  function accessLogView({ since, limit }) {
    let entries = since === undefined ? log : log.filter((item) => item.id > since);
    entries = entries.slice(-limit).map(logEntryView);
    return { epoch: logEpoch, latestId: logId, total: logTotal, entries };
  }

  function takenView() {
    return apps.map((item) => {
      const summary = item.app.getNeighborSummary();
      return {
        appKey: item.key,
        app: item.label,
        studentCount: summary.studentCount,
        students: summary.students,
        rosterCount: summary.rosterCount,
        rosterLabel: TEXT.rosterLabel(summary.rosterCount),
        rosterViews: summary.rosterViews,
        roster: summary.roster,
      };
    });
  }

  function failedTransfers() {
    const failed = [];
    for (const item of apps) {
      for (const entry of item.app.getTransferLog()) {
        if (entry.ok) continue;
        failed.push({
          at: entry.at,
          time: entry.time,
          app: item.label,
          appKey: item.key,
          kind: entry.kind,
          kindLabel: entry.kind === 'ai' ? TEXT.kindAi : TEXT.kindSheet,
          studentId: entry.studentId,
          status: entry.status,
          error: entry.error,
        });
      }
    }
    failed.sort((a, b) => a.at - b.at);
    return failed.slice(-FAILED_TRANSFER_LIMIT);
  }

  function receiverView() {
    const { host, port } = receiverAddress.get();
    const samePc = isSamePcAddress(host);
    const view = received.view;
    return {
      host,
      port,
      base: `http://${host}:${port}`,
      location: samePc ? 'same-pc' : 'other-device',
      locationLabel: samePc ? TEXT.receiverSamePc : TEXT.receiverOtherDevice,
      reachable: view.reachable,
      checkedAt: view.checkedAt,
      status: view.status,
      error: view.error,
      help: view.reachable === false ? [...TEXT.receiverHelp] : [],
      sheet: view.sheet,
      ai: view.ai,
      sheetCount: view.sheetCount,
      aiCount: view.aiCount,
      failedTransfers: failedTransfers(),
      ping: lastPing,
    };
  }

  function revealView() {
    if (!revealed || !revealResult) return { revealed: false, running: revealRunning };
    const without = apps.find((item) => !item.checkPermission);
    const withCheck = apps.find((item) => item.checkPermission);
    return {
      revealed: true,
      running: revealRunning,
      runCount: revealCount,
      ranAt: revealResult.ranAt,
      ranTime: isoTime(revealResult.ranAt),
      attempts: revealResult.attempts,
      apps: revealResult.apps,
      notes: [...REVEAL.notes],
      comparisonNotice: REVEAL.comparisonNotice.replace('{app}', withCheck ? withCheck.label : ''),
      realRequestNote: REVEAL.realRequestNote,
      appWithoutCheck: without ? { key: without.key, label: without.label } : null,
      appWithCheck: withCheck ? { key: withCheck.key, label: withCheck.label } : null,
    };
  }

  /**
   * 화면 전체 상태.
   * @param {{since?: number, limit?: number, force?: boolean}} [query]
   */
  async function getState({ since, limit = DEFAULT_LOG_LIMIT, force = false, skipReceiver = false } = {}) {
    if (!skipReceiver) await refreshReceived({ force, waitMs: force ? actionWaitMs : receiverWaitMs });
    const step = stepView();
    return {
      now: now(),
      fixedNotice: FIXED_NOTICE,
      revealed,
      step,
      steps: STEPS.map(({ id, label, title, subtitle }) => ({ id, label, title, subtitle })),
      switch: switchView(),
      accessLog: accessLogView({ since, limit }),
      taken: takenView(),
      receiver: receiverView(),
      reveal: revealView(),
      part2: part2.view(),
      // 마무리 문장은 마무리 단계에서만 보낸다.
      closing: step.id === 'closing' ? { sentences: CLOSING.sentences.map((sentence) => ({ ...sentence })) } : null,
      lastReset,
    };
  }

  // ------------------------------------------------------------------ 동작

  function doStep(body) {
    const to = body.to;
    if (to === 'next') {
      if (stepIndex >= STEPS.length - 1) throw new Refusal(409, TEXT.lastStep);
      stepIndex += 1;
      return;
    }
    if (to === 'prev') {
      if (stepIndex <= 0) throw new Refusal(409, TEXT.firstStep);
      stepIndex -= 1;
      return;
    }
    const index = typeof to === 'string' ? STEPS.findIndex((step) => step.id === to) : -1;
    if (index < 0) throw new Refusal(400, TEXT.unknownStep);
    stepIndex = index;
  }

  async function doSwitch(body) {
    switch (body.action) {
      case 'on': {
        // 화면의 경고에서 확인을 눌렀다는 값({confirmed: true})이 정확히 있어야 켜진다.
        const confirmed = Object.hasOwn(body, 'confirmed') && body.confirmed === true;
        const result = await accessSwitch.turnOn(confirmed ? { confirmed: true } : null);
        if (!result.ok) throw new Refusal(400, result.error);
        return;
      }
      case 'extend': {
        const result = accessSwitch.extend();
        if (!result.ok) throw new Refusal(409, result.error);
        return;
      }
      case 'off':
        await accessSwitch.turnOff();
        return;
      case 'dismiss':
        accessSwitch.clearAutoOffNotice();
        return;
      default:
        throw new Refusal(400, TEXT.unknownAction);
    }
  }

  /** 연결 확인: 받는 쪽에 실제로 ping을 보낸다. */
  async function ping() {
    const at = now();
    let base = null;
    const failed = (message, status = null) => ({
      ok: false, at, time: isoTime(at), base, status, message, causes: TEXT.pingCauses.map((item) => ({ ...item })),
    });
    try {
      base = receiverAddress.base();
      const response = await fetch(`${base}/api/ping`, { redirect: 'error', signal: AbortSignal.timeout(pingTimeoutMs) });
      const text = (await response.text()).slice(0, 4096);
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (response.status === 200 && isPlainObject(body) && body.ok === true && body.service === 'receiver') {
        return { ok: true, at, time: isoTime(at), base, status: 200, message: TEXT.pingOk, causes: [] };
      }
      return failed(TEXT.pingWrongReply, response.status);
    } catch (error) {
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return failed(timedOut ? TEXT.pingTimeout : TEXT.pingUnreachable);
    }
  }

  async function doReceiver(body) {
    if (body.action === 'set') {
      const result = receiverAddress.set(body.host);
      if (!result.ok) throw new Refusal(400, result.reason);
      // 주소가 바뀌었으니 예전 주소에서 받은 결과와 연결 확인 결과는 버린다.
      dropReceived();
      lastPing = null;
      return {};
    }
    if (body.action === 'ping') {
      lastPing = await ping();
      return { ping: lastPing };
    }
    throw new Refusal(400, TEXT.unknownAction);
  }

  /** 공개: 두 앱에 같은 다섯 요청을 실제로 보낸다. 다시 누르면 다시 보내고 결과를 바꿔 쓴다. */
  async function doReveal() {
    if (revealRunning) throw new Refusal(409, TEXT.revealRunning);
    revealRunning = true;
    const startedEpoch = epoch;
    try {
      const outcomes = await Promise.all(apps.map((item) => runRevealOn(item.baseUrl, {
        timeoutMs: revealTimeoutMs,
        totalMs: revealTimeoutMs * 2,
      })));
      if (startedEpoch !== epoch || closed) return; // 그 사이에 전체 초기화를 했다: 결과를 쓰지 않는다.
      const ranAt = now();
      revealCount += 1;
      revealResult = {
        ranAt,
        attempts: REVEAL.attempts.map((attempt, index) => ({
          no: attempt.no,
          title: attempt.title,
          method: attempt.method,
          path: attempt.path,
          request: `${attempt.method} ${attempt.path}`,
          loginId: attempt.login ? REVEAL.loginId : null,
          sent: attempt.body === undefined ? null : attempt.body,
          // 앱마다 실제로 돌아온 결과 번호와 내용.
          results: Object.fromEntries(apps.map((item, appIndex) => [item.key, {
            status: outcomes[appIndex].results[index].status,
            body: outcomes[appIndex].results[index].body,
            error: outcomes[appIndex].results[index].error,
          }])),
        })),
        apps: apps.map((item, appIndex) => ({
          key: item.key,
          label: item.label,
          loginStatus: outcomes[appIndex].loginStatus,
          logoutStatus: outcomes[appIndex].logoutStatus,
        })),
      };
      revealed = true;
    } finally {
      revealRunning = false;
    }
  }

  function doPart2(body) {
    let result;
    switch (body.action) {
      case 'next':
        result = part2.next();
        break;
      case 'context':
        result = part2.openContext();
        break;
      case 'choose':
        result = part2.choose(body.which, body.choice);
        break;
      case 'reset':
        part2.reset();
        return;
      default:
        throw new Refusal(400, TEXT.unknownAction);
    }
    if (!result.ok) throw new Refusal(result.status, result.error);
  }

  /** 전체 초기화 (명세 8.6). 받는 쪽 주소와 스위치 상태는 건드리지 않는다. */
  async function doReset() {
    if (resetting) throw new Refusal(409, TEXT.resetRunning);
    resetting = true;
    try {
      epoch += 1;
      for (const item of apps) item.app.reset();
      stepIndex = 0;
      part2.reset();
      revealed = false;
      revealResult = null;
      revealCount = 0;
      log = [];
      logTotal = 0;
      logEpoch += 1;

      // 아직 가는 중인 전송이 받는 쪽에 도착한 다음에 지우기를 요청한다(뒤늦게 도착해 남지 않게).
      await Promise.race([Promise.all(apps.map((item) => item.app.whenIdle())), sleep(idleWaitMs)]);
      let cleared = false;
      try {
        const response = await fetch(`${receiverAddress.base()}/api/clear`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(clearTimeoutMs),
        });
        await response.text();
        cleared = response.status === 200;
      } catch {
        cleared = false;
      }
      // 지우기 요청이 닿지 못했다면 그 실제 결과를 그대로 '닿지 못함'으로 보여준다.
      dropReceived(cleared ? undefined : emptyReceived(false, TEXT.receiverUnreachable));
      if (!cleared) received.askedAt = performance.now();
      const at = now();
      lastReset = { at, time: isoTime(at), receiverCleared: cleared, notice: cleared ? null : TEXT.resetReceiverFailed };
      return { receiverCleared: cleared, notice: lastReset.notice };
    } finally {
      resetting = false;
    }
  }

  /** 동작 요청: 경로 → 실행. 돌려준 값은 응답의 state 옆에 함께 실린다. */
  const actions = {
    '/api/step': { run: (body) => doStep(body) },
    '/api/switch': { run: (body) => doSwitch(body) },
    '/api/receiver': { run: (body) => doReceiver(body), force: (body) => body.action === 'set' },
    '/api/reveal': { run: () => doReveal(), force: () => true },
    '/api/part2': { run: (body) => doPart2(body) },
    '/api/reset': { run: () => doReset(), force: (body, extra) => extra.receiverCleared === true, skip: (extra) => extra.receiverCleared === false },
  };

  // ------------------------------------------------------------------ 접근 제한

  /** 이 프로그램의 주소(127.0.0.1:<포트> 또는 localhost:<포트>)로 온 요청인가. */
  function ownHost(req) {
    const port = req.socket.localPort;
    const host = req.headers.host;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  /** 진행 화면 자신이 보낸 요청인가(다른 사이트·다른 포트의 화면이 보낸 것이 아닌가). */
  function fromOwnScreen(req) {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`) return false;
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
    return true;
  }

  function readQuery(req) {
    const params = new URL(req.url, 'http://x').searchParams;
    const read = (name, min) => {
      const raw = params.get(name);
      if (raw === null) return undefined;
      if (!/^\d{1,12}$/.test(raw) || Number(raw) < min) throw new Refusal(400, TEXT.badQuery);
      return Number(raw);
    };
    const since = read('since', 0);
    const limit = read('limit', 1);
    return { since, limit: limit === undefined ? DEFAULT_LOG_LIMIT : Math.min(limit, MAX_LOG_LIMIT) };
  }

  // ------------------------------------------------------------------ 처리기

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/state') {
      if (req.method !== 'GET') {
        sendError(res, 405, TEXT.wrongMethod);
        return;
      }
      let query;
      try {
        query = readQuery(req);
      } catch (error) {
        sendError(res, error instanceof Refusal ? error.status : 400, error instanceof Refusal ? error.message : TEXT.badQuery);
        return;
      }
      sendJson(res, 200, await getState(query));
      return;
    }

    if (!Object.hasOwn(actions, pathname)) {
      sendError(res, 404, TEXT.notFound);
      return;
    }
    if (req.method !== 'POST') {
      sendError(res, 405, TEXT.wrongMethod);
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, { limitBytes: BODY_LIMIT_BYTES });
    } catch (error) {
      sendError(res, 400, error && error.message ? error.message : TEXT.badBody);
      return;
    }
    if (!isPlainObject(body)) {
      sendError(res, 400, TEXT.badBody);
      return;
    }

    const action = actions[pathname];
    try {
      const extra = (await action.run(body)) || {};
      const force = action.force ? Boolean(action.force(body, extra)) : false;
      const skipReceiver = action.skip ? Boolean(action.skip(extra)) : false;
      sendJson(res, 200, { ...extra, state: await getState({ force, skipReceiver }) });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      // 거절해도 지금 상태를 함께 돌려준다(화면이 바로 다시 그릴 수 있게).
      sendJson(res, error.status, { error: error.message, state: await getState() });
    }
  }

  async function handler(req, res) {
    try {
      if (closed || !ownHost(req)) {
        sendError(res, 403, TEXT.wrongHost);
        return;
      }
      const pathname = (typeof req.url === 'string' ? req.url : '/').split(/[?#]/, 1)[0];
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (!fromOwnScreen(req)) {
          sendError(res, 403, TEXT.foreignPage);
          return;
        }
        await handleApi(req, res, pathname);
        return;
      }

      // 화면 파일(src/console/public/). 폴더나 파일이 없으면 404로 답한다.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, TEXT.wrongMethod);
        return;
      }
      // 화면은 이 프로그램이 내준 파일만 쓴다(밖에서 아무것도 가져오지 않는다).
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const urlPath = pathname === '/' ? '/index.html' : pathname;
      if (!(await serveStatic(req, res, publicDir, { urlPath }))) {
        res.removeHeader('Content-Security-Policy');
        sendError(res, 404, TEXT.notFound);
      }
    } catch {
      if (res.headersSent) res.destroy();
      else sendError(res, 500, TEXT.failed);
    }
  }

  const server = http.createServer((req, res) => { handler(req, res); });

  return {
    /** 진행 화면의 서버. http.js의 listen(server, port)로 127.0.0.1에만 연다. 스위치에는 등록하지 않는다. */
    server,
    handler,
    /** 화면 전체 상태(GET /api/state와 같은 값). */
    getState,
    /** 닫는다: 서버를 닫고 앱 알림 등록을 푼다. 여러 번 불러도 괜찮다. */
    async close() {
      closed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      await closeServer(server);
    },
  };
}
