// 다른 기기 접속 스위치 (명세 7, 11-3·4, 12)
//
// 한 프로그램이 자기 서버들을 "같은 PC 전용"과 "같은 연결의 다른 기기에도 열림" 사이에서
// 프로그램을 다시 실행하지 않고 오가게 해 준다.
//
// 동작 방식
//   - 등록한 서버는 항상 127.0.0.1:<포트>에서만 듣는다(같은 PC 쪽 문).
//   - 스위치를 켜면 이 PC의 내부 주소(사설 IPv4)마다 <내부 주소>:<같은 포트>에서 듣는 문을
//     하나씩 더 연다(다른 기기 쪽 문). 모든 주소(0.0.0.0)로 여는 일은 없다.
//     두 문은 같은 처리기를 부르므로 메모리의 상태(로그인, 데이터)는 그대로다.
//   - 스위치를 끄면 다른 기기 쪽 문을 닫고 그 문으로 들어와 있던 연결도 모두 끊는다.
//     그래서 꺼진 동안 다른 기기에서는 연결 자체가 되지 않는다.
//   - 스위치에 등록하지 않은 서버(진행 화면)는 이 스위치와 무관하다. http.js의 listen()으로
//     127.0.0.1에만 열면 어떤 경우에도 다른 기기에서 열리지 않는다.

import http from 'node:http';

import { isPrivateOrLoopback, isLoopback, isSamePcAddress, listInternalAddresses, parseIPv4 } from './address.js';
import { listen as listenOn, sendError } from './http.js';

/** 자동으로 꺼지기까지의 시간: 30분. */
export const DEFAULT_LIMIT_MS = 30 * 60 * 1000;
/** 남은 시간이 이만큼 이하이면 눈에 띄게 알린다: 2분. */
export const DEFAULT_WARNING_MS = 2 * 60 * 1000;
/** 켜져 있는 동안 이 PC의 내부 주소가 바뀌었는지 다시 살피는 간격. */
export const DEFAULT_RESCAN_MS = 5000;

/** 화면에 그대로 쓸 수 있는 문구. */
export const SWITCH_MESSAGES = Object.freeze({
  /** 켜기 전에 보여줄 경고. */
  confirmWarning: '전용 실습용 연결에서만 켜세요. 학교 와이파이·공용 와이파이에서는 켜지 마세요',
  needConfirm: '경고를 읽고 확인을 눌러야 켤 수 있습니다.',
  localOnly: '지금은 이 PC에서만 열립니다',
  autoOff: '다른 기기 접속이 자동으로 꺼졌습니다',
  notOn: '다른 기기 접속이 꺼져 있어서 연장할 수 없습니다. 먼저 켜 주세요.',
  noInternalAddress: '이 PC의 내부 주소를 찾지 못했습니다. 와이파이나 핫스팟에 연결되어 있는지 확인해 주세요. '
    + '연결한 뒤에는 자동으로 다시 찾습니다. 주소는 Windows에서는 명령 프롬프트에 ipconfig를 입력해서, '
    + 'macOS에서는 시스템 설정의 네트워크에서 직접 확인할 수 있습니다.',
  forbidden: '허용되지 않은 주소에서 온 요청입니다. 같은 PC나 같은 연결 안의 기기에서만 접속할 수 있습니다.',
  closed: '프로그램을 끝내는 중이라 켤 수 없습니다.',
  handlerFailed: '요청을 처리하는 중에 문제가 생겼습니다.',
});

/**
 * 요청 하나를 처리할지 판단한다(스위치가 요청마다 부른다).
 *   - 다른 기기 쪽 문으로 왔는데 스위치가 꺼져 있다 → 'drop' (응답 없이 연결을 끊는다)
 *   - 보낸 주소가 같은 PC·사설 주소가 아니다        → 'forbid' (403과 한국어 설명)
 *   - 그 밖                                          → 'serve'
 * @param {{viaLan: boolean, switchOn: boolean, clientAddress: unknown}} input
 *   viaLan: 다른 기기 쪽 문(내부 주소)으로 들어온 요청인가
 * @returns {{action: 'serve'} | {action: 'drop'} | {action: 'forbid', status: 403, error: string}}
 */
export function decideRequest({ viaLan, switchOn, clientAddress }) {
  if (viaLan && !switchOn) return { action: 'drop' };
  if (!isPrivateOrLoopback(clientAddress)) {
    return { action: 'forbid', status: 403, error: SWITCH_MESSAGES.forbidden };
  }
  return { action: 'serve' };
}

/**
 * @typedef {object} RequestInfo 처리기가 세 번째 인자로 받는 값
 * @property {boolean} local 같은 PC 쪽 문(127.0.0.1)으로 들어온 요청이면 true.
 *   꾸밀 수 없는 값이므로 "같은 PC에서만 허용"(스위치 조작, 받는 쪽 화면)은 이 값으로 판단한다.
 * @property {string} clientAddress 요청을 보낸 주소
 * @property {boolean} samePc 보낸 주소가 이 PC 자신인가(접속 기록의 "같은 PC / 다른 기기" 표시용).
 *   같은 PC의 브라우저가 내부 주소로 접속하면 local은 false, samePc는 true다.
 */

/**
 * @typedef {object} SwitchStatus
 * @property {boolean} on 켜져 있는가
 * @property {number} remainingMs 자동으로 꺼지기까지 남은 시간(꺼져 있으면 0)
 * @property {number} limitMs 한 번 켜거나 연장했을 때의 시간
 * @property {boolean} warning 켜져 있고 남은 시간이 warningMs 이하인가("2분 남음" 알림)
 * @property {boolean} autoOff 마지막으로 꺼진 것이 시간 초과 때문인가(다시 켜거나 clearAutoOffNotice()를 부르면 false)
 * @property {{type: 'on'|'extend'|'off'|'auto-off', at: number, message: string|null} | null} lastEvent
 *   마지막으로 일어난 일. auto-off이면 message가 "다른 기기 접속이 자동으로 꺼졌습니다"
 * @property {string[]} addresses 이 PC의 내부 주소(사설 IPv4) 전부
 * @property {boolean} noInternalAddress 내부 주소를 찾지 못했는가
 * @property {string|null} guidance 내부 주소를 찾지 못했을 때 보여줄 안내(찾았으면 null)
 * @property {Array<{name: string, port: number, urls: string[]}>} servers 등록된 서버와,
 *   지금 다른 기기에서 열 수 있는 주소('http://192.168.0.10:4173' 모양, 꺼져 있으면 빈 배열)
 * @property {Array<{name: string, address: string, port: number, message: string}>} failures
 *   켜져 있는데 열지 못한 주소(예: 그 주소의 포트를 다른 프로그램이 쓰는 중)
 */

/**
 * 다른 기기 접속 스위치를 만든다. 프로그램마다 하나씩 만든다.
 *
 *   const sw = createAccessSwitch();
 *   const app1 = await sw.listen({ name: 'app1', port: 4173, handler: (req, res, info) => { ... } });
 *   await sw.turnOn({ confirmed: true });   // 화면에서 경고를 확인한 뒤에만
 *   sw.urlsFor('app1', '/neighbor');        // ['http://192.168.0.10:4173/neighbor']
 *   sw.extend(); await sw.turnOff(); await sw.close();
 *
 * @param {object} [options]
 * @param {number} [options.limitMs] 자동으로 꺼지기까지의 시간(기본 30분)
 * @param {number} [options.warningMs] 알림을 시작하는 남은 시간(기본 2분)
 * @param {() => number} [options.now] 시계(기본 Date.now). 검사용
 * @param {(fn: () => void, ms: number) => any} [options.setTimer] 기본 setTimeout. 검사용
 * @param {(id: any) => void} [options.clearTimer] 기본 clearTimeout. 검사용
 * @param {() => string[]} [options.listAddresses] 이 PC의 내부 주소 찾기(기본 listInternalAddresses). 검사용.
 *   돌려준 값 중 사설 IPv4가 아닌 것은 무시한다.
 * @param {(req: http.IncomingMessage) => unknown} [options.clientAddressOf] 요청을 보낸 주소 알아내기
 *   (기본 req.socket.remoteAddress). 검사용
 * @param {number} [options.rescanMs] 켜져 있는 동안 내부 주소를 다시 살피는 간격(기본 5초, 0이면 하지 않음)
 * @param {(status: SwitchStatus) => void} [options.onChange] 상태가 바뀔 때마다 불린다
 */
export function createAccessSwitch(options = {}) {
  const {
    limitMs = DEFAULT_LIMIT_MS,
    warningMs = DEFAULT_WARNING_MS,
    now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    listAddresses = listInternalAddresses,
    clientAddressOf = (req) => req.socket.remoteAddress,
    rescanMs = DEFAULT_RESCAN_MS,
    onChange,
  } = options;

  /**
   * 등록된 서버. lan은 다른 기기 쪽 문(내부 주소 → 기록)이다.
   * @type {Map<string, {name: string, port: number, ready: boolean, handler: Function,
   *   server: http.Server, sockets: Set<import('node:net').Socket>,
   *   lan: Map<string, {server: http.Server, sockets: Set<import('node:net').Socket>, open: boolean}>}>}
   */
  const entries = new Map();
  const listeners = new Set();
  if (typeof onChange === 'function') listeners.add(onChange);

  let on = false;
  let closed = false;
  let deadline = 0;
  let timerId = null;
  let rescanId = null;
  let autoOff = false;
  let lastEvent = null;
  /** 켜져 있는 동안 마지막으로 살핀 내부 주소. */
  let scanned = [];
  let failures = [];
  /** 문을 열고 닫는 작업은 한 번에 하나씩 차례로 한다. */
  let syncChain = Promise.resolve();
  let ownCache = { at: -Infinity, list: [] };

  /** 내부 주소 목록. 사설 IPv4가 아닌 값은 어떤 경우에도 쓰지 않는다. */
  function safeAddresses() {
    let list;
    try {
      list = listAddresses();
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) return [];
    const result = [];
    for (const address of list) {
      if (parseIPv4(address) === null || !isPrivateOrLoopback(address) || isLoopback(address)) continue;
      if (!result.includes(address)) result.push(address);
    }
    return result;
  }

  function ownAddresses() {
    const at = Date.now();
    if (at - ownCache.at > 2000) ownCache = { at, list: safeAddresses() };
    return ownCache.list;
  }

  function emit() {
    if (listeners.size === 0) return;
    const snapshot = status();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // 알림을 받는 쪽의 오류가 스위치를 멈추게 하지 않는다.
      }
    }
  }

  function trackSockets(server, sockets, isLan) {
    server.on('connection', (socket) => {
      if (closed || (isLan && !on)) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }

  function makeRequestListener(entry, viaLan) {
    return (req, res) => {
      expireIfDue();
      const clientAddress = clientAddressOf(req);
      const decision = decideRequest({ viaLan, switchOn: on, clientAddress });
      if (decision.action === 'drop') {
        req.socket.destroy();
        return;
      }
      if (decision.action === 'forbid') {
        sendError(res, decision.status, decision.error);
        return;
      }
      /** @type {RequestInfo} */
      const info = {
        local: !viaLan,
        clientAddress: /** @type {string} */ (clientAddress),
        samePc: isSamePcAddress(clientAddress, ownAddresses()),
      };
      const failed = () => {
        if (res.headersSent) res.destroy();
        else sendError(res, 500, SWITCH_MESSAGES.handlerFailed);
      };
      try {
        const result = entry.handler(req, res, info);
        if (result && typeof result.catch === 'function') result.catch(failed);
      } catch {
        failed();
      }
    };
  }

  // ------------------------------------------------------------------ 다른 기기 쪽 문

  /** 문 하나를 지금 바로 닫는다: 새 연결을 더 받지 않고, 들어와 있던 연결을 모두 끊는다. */
  function shutLanNow(record) {
    record.open = false;
    for (const socket of record.sockets) socket.destroy();
    record.sockets.clear();
    if (record.server.listening) {
      record.server.close(() => {});
      record.server.closeAllConnections();
    }
  }

  /** 닫히는 것이 끝날 때까지 기다린다. */
  function lanFullyClosed(record) {
    return new Promise((resolve) => {
      shutLanNow(record);
      if (!record.server.listening) {
        resolve();
        return;
      }
      record.server.once('close', resolve);
    });
  }

  async function openLan(entry, address) {
    // 주소를 묶기 직전에 다시 확인한다: 그 사이에 꺼졌으면 아예 열지 않는다.
    if (!on || closed) return;
    const server = http.createServer(makeRequestListener(entry, true));
    const record = { server, sockets: new Set(), open: false };
    trackSockets(server, record.sockets, true);
    entry.lan.set(address, record);
    try {
      await listenOn(server, entry.port, address);
    } catch (error) {
      if (entry.lan.get(address) === record) entry.lan.delete(address);
      failures.push({
        name: entry.name,
        address,
        port: entry.port,
        message: error && error.code === 'EADDRINUSE'
          ? `${address} 주소의 ${entry.port}번 포트를 다른 프로그램이 쓰고 있어서 열지 못했습니다.`
          : `${address} 주소로는 열지 못했습니다. 연결 상태를 확인해 주세요.`,
      });
      return;
    }
    // 여는 사이에 스위치가 꺼졌거나 이 문이 더 필요 없어졌으면 바로 닫는다.
    if (!on || closed || entry.lan.get(address) !== record) {
      if (entry.lan.get(address) === record) entry.lan.delete(address);
      await lanFullyClosed(record);
      return;
    }
    record.open = true;
  }

  async function syncOnce() {
    const wanted = on && !closed ? safeAddresses() : [];
    scanned = wanted;
    failures = [];
    const work = [];
    for (const entry of entries.values()) {
      for (const [address, record] of [...entry.lan]) {
        // 필요 없어진 문과, 이미 닫혀 버린 문(꺼질 때 닫았거나 다른 이유로 닫힌 것)의 기록을 치운다.
        // 문을 여닫는 작업은 한 번에 하나씩만 하므로, 여기서 열려 있지 않은 기록은 모두 죽은 기록이다.
        // 치워 두어야 아래에서 필요한 문을 새로 연다.
        const dead = !record.open || !record.server.listening;
        if (dead || !wanted.includes(address) || !entry.ready) {
          entry.lan.delete(address);
          work.push(lanFullyClosed(record));
        }
      }
    }
    await Promise.all(work);
    if (!on || closed) return; // 닫는 동안 꺼졌으면 열지 않는다.
    const opening = [];
    for (const entry of entries.values()) {
      if (!entry.ready) continue;
      for (const address of wanted) {
        if (!entry.lan.has(address)) opening.push(openLan(entry, address));
      }
    }
    await Promise.all(opening);
  }

  /** 지금 상태(켜짐/꺼짐, 내부 주소)에 맞게 다른 기기 쪽 문을 열고 닫는다. */
  function sync() {
    const run = syncChain.then(syncOnce);
    syncChain = run.catch(() => {});
    return run;
  }

  // ------------------------------------------------------------------ 시간

  function stopTimer() {
    if (timerId !== null) {
      clearTimer(timerId);
      timerId = null;
    }
  }

  function armTimer() {
    stopTimer();
    timerId = setTimer(() => {
      timerId = null;
      if (!on) return;
      if (now() >= deadline) switchOff('auto-off');
      else armTimer();
    }, Math.max(0, deadline - now()));
  }

  function stopRescan() {
    if (rescanId !== null) {
      clearInterval(rescanId);
      rescanId = null;
    }
  }

  function startRescan() {
    stopRescan();
    if (!(rescanMs > 0)) return;
    rescanId = setInterval(() => {
      if (!on) return;
      const current = safeAddresses();
      const changed = current.length !== scanned.length || current.some((address, i) => address !== scanned[i]);
      // 열려 있어야 하는데 열려 있지 않은 문이 있으면 그것도 고친다.
      const broken = [...entries.values()].some(
        (entry) => entry.ready && current.some((address) => {
          const record = entry.lan.get(address);
          return record === undefined || !record.open || !record.server.listening;
        }),
      );
      if (changed || broken || failures.length > 0) {
        sync().then(() => { if (changed || broken) emit(); }, () => {});
      }
    }, rescanMs);
    if (typeof rescanId.unref === 'function') rescanId.unref();
  }

  /** 스위치를 끈다. 부르는 즉시 다른 기기 쪽 문이 닫힌다. 돌려주는 약속은 정리가 끝나면 이행된다. */
  function switchOff(type) {
    on = false;
    deadline = 0;
    stopTimer();
    stopRescan();
    autoOff = type === 'auto-off';
    lastEvent = { type, at: now(), message: autoOff ? SWITCH_MESSAGES.autoOff : null };
    for (const entry of entries.values()) {
      for (const record of entry.lan.values()) shutLanNow(record);
    }
    const done = sync().catch(() => {});
    emit();
    return done;
  }

  /** 제한 시간이 지났으면(타이머가 늦더라도) 지금 끈다. */
  function expireIfDue() {
    if (on && now() >= deadline) switchOff('auto-off');
  }

  // ------------------------------------------------------------------ 밖에서 쓰는 것

  /** @returns {SwitchStatus} */
  function status() {
    expireIfDue();
    const addresses = on ? [...scanned] : (closed ? [] : safeAddresses());
    const remainingMs = on ? Math.max(0, deadline - now()) : 0;
    const noInternalAddress = addresses.length === 0;
    return {
      on,
      remainingMs,
      limitMs,
      warning: on && remainingMs <= warningMs,
      autoOff,
      lastEvent: lastEvent ? { ...lastEvent } : null,
      addresses,
      noInternalAddress,
      guidance: noInternalAddress ? SWITCH_MESSAGES.noInternalAddress : null,
      servers: [...entries.values()].filter((entry) => entry.ready).map((entry) => ({
        name: entry.name,
        port: entry.port,
        urls: openAddresses(entry).map((address) => `http://${address}:${entry.port}`),
      })),
      failures: failures.map((failure) => ({ ...failure })),
    };
  }

  function openAddresses(entry) {
    if (!on) return [];
    return scanned.filter((address) => {
      const record = entry.lan.get(address);
      return record !== undefined && record.open && record.server.listening;
    });
  }

  return {
    /**
     * 서버 하나를 스위치에 등록하고 127.0.0.1:<port>에서 연다(스위치가 켜져 있으면 내부 주소로도 연다).
     * 처리기는 `(req, res, info)`로 불린다(info는 RequestInfo). 처리기가 불리기 전에 스위치가
     * 보낸 주소를 확인하므로, 사설 주소가 아닌 요청은 처리기까지 오지 않는다(403).
     * 열지 못하면 거절한다: 오류에 `code`('EADDRINUSE' 등)와 `port`가 들어 있고, 그 서버는 등록되지 않는다.
     * 부르는 쪽은 이때 `await sw.close()`로 나머지를 모두 닫고 exitOnStartupError(error)를 부르면 된다.
     * @param {{name: string, port: number, handler: (req: http.IncomingMessage, res: http.ServerResponse, info: RequestInfo) => any}} server
     *   name: urlsFor()와 status().servers에서 쓰는 이름. port: 0이면 빈 포트 자동 선택
     * @returns {Promise<{name: string, port: number, server: http.Server}>} port는 실제로 열린 포트,
     *   server는 같은 PC 쪽 문(직접 닫지 말고 sw.close()를 쓴다)
     */
    async listen({ name, port, handler }) {
      if (closed) throw new Error('이미 닫힌 스위치에는 서버를 등록할 수 없습니다.');
      if (typeof name !== 'string' || name === '') throw new TypeError('서버 이름이 필요합니다.');
      if (typeof handler !== 'function') throw new TypeError('요청 처리기가 필요합니다.');
      if (entries.has(name)) throw new Error(`같은 이름의 서버가 이미 등록되어 있습니다: ${name}`);

      const entry = { name, port, ready: false, handler, server: null, sockets: new Set(), lan: new Map() };
      entry.server = http.createServer(makeRequestListener(entry, false));
      trackSockets(entry.server, entry.sockets, false);
      entries.set(name, entry);
      try {
        entry.port = await listenOn(entry.server, port, '127.0.0.1');
      } catch (error) {
        entries.delete(name);
        throw error;
      }
      if (closed) {
        entries.delete(name);
        for (const socket of entry.sockets) socket.destroy();
        await new Promise((resolve) => entry.server.close(resolve));
        throw new Error('이미 닫힌 스위치에는 서버를 등록할 수 없습니다.');
      }
      entry.ready = true;
      if (on) await sync();
      return { name, port: entry.port, server: entry.server };
    },

    /**
     * 켠다. `{ confirmed: true }`(화면의 경고에서 확인을 누름)가 정확히 있어야 한다.
     * 없으면 켜지 않고 `{ok: false, error}`를 돌려준다. 이미 켜져 있으면 남은 시간은 그대로다(연장은 extend()).
     * @param {{confirmed: true}} confirmation
     * @returns {Promise<{ok: boolean, error?: string, status: SwitchStatus}>}
     */
    async turnOn(confirmation) {
      if (closed) return { ok: false, error: SWITCH_MESSAGES.closed, status: status() };
      if (confirmation === null || typeof confirmation !== 'object' || confirmation.confirmed !== true) {
        return { ok: false, error: SWITCH_MESSAGES.needConfirm, status: status() };
      }
      expireIfDue();
      if (!on) {
        on = true;
        autoOff = false;
        deadline = now() + limitMs;
        lastEvent = { type: 'on', at: now(), message: null };
        armTimer();
        startRescan();
      }
      await sync();
      emit();
      return { ok: true, status: status() };
    },

    /**
     * 끈다. 부르는 즉시 꺼진 상태가 되고 다른 기기 쪽 문과 그 연결이 닫힌다.
     * 약속은 정리가 끝나면 이행된다. 이미 꺼져 있으면 아무 일도 하지 않는다.
     * @returns {Promise<{ok: true, status: SwitchStatus}>}
     */
    async turnOff() {
      expireIfDue();
      if (on) await switchOff('off');
      else await syncChain;
      return { ok: true, status: status() };
    },

    /**
     * 연장: 지금부터 다시 limitMs. 꺼져 있으면 `{ok: false, error}`.
     * @returns {{ok: boolean, error?: string, status: SwitchStatus}}
     */
    extend() {
      expireIfDue();
      if (!on) return { ok: false, error: SWITCH_MESSAGES.notOn, status: status() };
      deadline = now() + limitMs;
      lastEvent = { type: 'extend', at: now(), message: null };
      armTimer();
      emit();
      return { ok: true, status: status() };
    },

    /** 지금 상태. 부를 때 제한 시간이 지나 있으면 그 자리에서 꺼진다. */
    status,

    /**
     * 이 PC의 내부 주소를 다시 살펴서, 켜져 있으면 새 주소로 문을 열고 사라진 주소의 문을 닫는다.
     * (켜져 있는 동안에는 rescanMs마다 자동으로도 한다.)
     * @returns {Promise<SwitchStatus>}
     */
    async refresh() {
      expireIfDue();
      await sync();
      emit();
      return status();
    },

    /**
     * 두 번째 노트북에 입력할 주소 목록. 예: urlsFor('app1', '/neighbor') → ['http://192.168.0.10:4173/neighbor'].
     * 내부 주소가 여러 개면 모두 들어 있다. 꺼져 있거나 내부 주소를 찾지 못했으면 빈 배열이다.
     * @param {string} name listen()에 준 이름
     * @param {string} [path] '/'로 시작하는 경로(기본 '/')
     * @returns {string[]}
     */
    urlsFor(name, path = '/') {
      expireIfDue();
      const entry = entries.get(name);
      if (!entry || !entry.ready) return [];
      const suffix = path.startsWith('/') ? path : `/${path}`;
      return openAddresses(entry).map((address) => `http://${address}:${entry.port}${suffix}`);
    },

    /**
     * 상태가 바뀔 때(켜짐·연장·꺼짐·자동 꺼짐·주소 바뀜) 불릴 함수를 등록한다.
     * @param {(status: SwitchStatus) => void} listener
     * @returns {() => void} 등록을 푸는 함수
     */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** "자동으로 꺼졌습니다" 알림을 확인했을 때 부른다(status().autoOff가 false가 된다). */
    clearAutoOffNotice() {
      if (!autoOff) return;
      autoOff = false;
      emit();
    },

    /**
     * 프로그램을 끝낼 때 부른다: 스위치를 끄고, 등록된 서버를 모두 닫고, 연결과 타이머를 모두 정리한다.
     * 그 뒤로는 다시 켜거나 서버를 등록할 수 없다. 여러 번 불러도 괜찮다.
     * @returns {Promise<void>}
     */
    async close() {
      const wasOn = on;
      closed = true;
      on = false;
      deadline = 0;
      stopTimer();
      stopRescan();
      if (wasOn) lastEvent = { type: 'off', at: now(), message: null };
      const closing = [];
      for (const entry of entries.values()) {
        for (const record of entry.lan.values()) shutLanNow(record);
        for (const socket of entry.sockets) socket.destroy();
        entry.sockets.clear();
        if (entry.server.listening) {
          closing.push(new Promise((resolve) => entry.server.close(resolve)));
          entry.server.closeAllConnections();
        }
      }
      await Promise.all(closing);
      await sync().catch(() => {});
      entries.clear();
      if (wasOn) emit();
      listeners.clear();
    },
  };
}
