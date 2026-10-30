// 运行：node --test browser/ReliableVideoRTC.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function compile(relativePath) {
  const filename = path.join(__dirname, relativePath);
  return ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

const eventCode = compile("../common/手写事件.ts");
const peerCode = compile("ReliableRTCPeerConnection.ts");
const videoCode = compile("ReliableVideoRTC.ts");
const TURN = { urls: "turn:relay.example.test:3478", username: "user", credential: "password" };
const clone = value => JSON.parse(JSON.stringify(value));
const turnUrls = config =>
  Array.from(config.iceServers ?? [])
    .flatMap(server => [server.urls].flat())
    .filter(url => /^turns?:/i.test(url));

// 直接验证基类的 TURN 写入，并保留视频子类继承行为；原生接口使用轻量模拟。
function createEnvironment(options = {}) {
  let time = 0;
  let nextTimer = 1;
  let randomCounter = 1;
  let autoReply = false;
  const timers = new Map();
  const inbox = [];
  const signals = [];
  const connections = [];
  const logs = [];
  const setTimeout = (callback, delay = 0) => {
    const id = nextTimer++;
    timers.set(id, { callback, at: time + delay });
    return id;
  };
  const clearTimeout = id => timers.delete(id);
  const math = Object.create(Math);
  math.random = () => ++randomCounter / 2000;

  class FakePC {
    constructor(config) {
      this.config = clone(config);
      this.signalingState = "stable";
      this.connectionState = "new";
      this.iceConnectionState = "new";
      this.transceivers = [];
      connections.push(this);
    }

    dispatch(type) {
      const event = { type, target: this };
      this[`on${type}`]?.(event);
    }

    setIceState(state) {
      this.iceConnectionState = state;
      this.dispatch("iceconnectionstatechange");
    }

    connect() {
      this.setIceState("connected");
      this.connectionState = "connected";
      this.dispatch("connectionstatechange");
    }

    getConfiguration() {
      return clone(this.config);
    }

    getTransceivers() {
      return this.transceivers;
    }

    addTransceiver(kind) {
      const transceiver = {
        receiver: { track: { kind } },
        sender: { track: null, replaceTrack: async () => {} },
        direction: "sendrecv",
      };
      this.transceivers.push(transceiver);
      return transceiver;
    }

    async getStats() {
      return new Map([["transport", { type: "transport", selectedCandidatePairId: "pair" }]]);
    }

    close() {
      this.signalingState = "closed";
      this.connectionState = "closed";
      this.iceConnectionState = "closed";
    }
  }

  const context = vm.createContext({
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    Math: math,
    RTCPeerConnection: FakePC,
    RTCRtpSender: { getCapabilities: () => null },
    navigator: { mediaCapabilities: { decodingInfo: async () => ({ supported: true, powerEfficient: true }) } },
    window: { setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
  });
  function load(code, require) {
    const module = { exports: {} };
    vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context)(require, module, module.exports);
    return module.exports;
  }
  const eventModule = load(eventCode, () => {
    throw new Error("Unexpected import");
  });
  const peerModule = load(peerCode, () => eventModule);
  const { ReliableRTCPeerConnection } = peerModule;
  const { ReliableVideoRTC } = load(videoCode, () => peerModule);
  const stream = { getVideoTracks: () => [], getAudioTracks: () => [] };
  const rtc = options.video
    ? new ReliableVideoRTC(stream, null, true, options.rtcConfig, options.maxReconnectAttempts)
    : new ReliableRTCPeerConnection(options.rtcConfig, options.maxReconnectAttempts);
  rtc.on("signaling", signal => {
    signals.push(clone(signal));
    // 使用公开 join 协议确认新连接，不读取任何私有 ID 或私有状态。
    if (autoReply && signal.type === "join" && signal.targetId === undefined) {
      inbox.push({ type: "join", data: "zzzzzz", targetId: signal.data });
    }
  });
  rtc.start();
  const environment = { rtc, connections, signals, logs };
  environment.flush = async () => {
    for (let round = 0; round < 40; round++) {
      await Promise.resolve();
      while (inbox.length) await rtc.onSignalingMessage(inbox.shift());
    }
  };
  environment.begin = async () => {
    autoReply = true;
    await rtc.onSignalingMessage({ type: "join", data: "zzzzzz" });
    await environment.flush();
    assert.ok(rtc.peerConnection, "The public handshake should initialize a PC");
    return rtc.peerConnection;
  };
  environment.advance = async milliseconds => {
    const until = time + milliseconds;
    let callbacks = 0;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++callbacks < 100, "Failed TURN loading must not create an immediate retry loop");
      const [id, timer] = next;
      time = timer.at;
      timers.delete(id);
      timer.callback();
      await environment.flush();
    }
    time = until;
    await environment.flush();
  };
  environment.close = () => rtc.close();
  environment.pauseReplies = () => {
    autoReply = false;
  };
  return environment;
}

test("TURN fallback is opt-in and leaves the original constructor behavior intact", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const pc = await environment.begin();
  await environment.advance(5000);
  assert.equal(environment.rtc.peerConnection, pc);
  assert.deepEqual(turnUrls(pc.getConfiguration()), []);
});

test("ReliableVideoRTC inherits setTurnServers without changing its constructor arguments", async t => {
  const environment = createEnvironment({ video: true });
  t.after(environment.close);
  assert.equal(environment.rtc.constructor.name, "ReliableVideoRTC");
  const directPC = await environment.begin();
  assert.equal(environment.rtc.isConnected(), false);
  assert.deepEqual(turnUrls(directPC.getConfiguration()), []);
  environment.rtc.setTurnServers(TURN);
  await environment.flush();
  assert.equal(directPC.connectionState, "closed");
  assert.notEqual(environment.rtc.peerConnection, directPC);
  assert.deepEqual(turnUrls(environment.rtc.peerConnection.getConfiguration()), [TURN.urls]);
});

test("setTurnServers rebuilds an unconnected PC with TURN", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const firstPC = await environment.begin();
  assert.equal(environment.rtc.isConnected(), false);
  environment.rtc.setTurnServers(TURN);
  await environment.flush();
  assert.notEqual(environment.rtc.peerConnection, firstPC);
  assert.equal(firstPC.connectionState, "closed");
  assert.deepEqual(turnUrls(environment.rtc.peerConnection.getConfiguration()), [TURN.urls]);
});

test("an early direct connection keeps TURN for later without rebuilding", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const pc = await environment.begin();
  pc.connect();
  assert.equal(environment.rtc.isConnected(), true);
  const connectionCount = environment.connections.length;
  const signalCount = environment.signals.length;
  environment.rtc.setTurnServers(TURN);
  await environment.flush();
  assert.equal(environment.rtc.peerConnection, pc);
  assert.equal(environment.connections.length, connectionCount);
  assert.equal(environment.signals.length, signalCount);
  assert.deepEqual(turnUrls(environment.rtc.rtcConfig), [TURN.urls]);
});

test("ICE connected without DTLS completion also counts as connected", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const pc = await environment.begin();
  pc.setIceState("completed");
  assert.equal(pc.connectionState, "new");
  assert.equal(environment.rtc.isConnected(), true);
  environment.rtc.setTurnServers(TURN);
  await environment.flush();
  assert.equal(environment.rtc.peerConnection, pc);
  assert.deepEqual(turnUrls(environment.rtc.rtcConfig), [TURN.urls]);
});

test("setTurnServers reads ICE state at call time without an extra event", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const pc = await environment.begin();
  pc.iceConnectionState = "completed";
  assert.equal(pc.connectionState, "new");
  const connectionCount = environment.connections.length;
  const signalCount = environment.signals.length;
  environment.rtc.setTurnServers(TURN);
  await environment.flush();
  assert.equal(environment.rtc.peerConnection, pc);
  assert.equal(environment.connections.length, connectionCount);
  assert.equal(environment.signals.length, signalCount);
  assert.deepEqual(turnUrls(environment.rtc.rtcConfig), [TURN.urls]);
});

test("close keeps supplied TURN and does not open another PC", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  await environment.begin();
  environment.rtc.close();
  const signalCount = environment.signals.length;
  environment.rtc.setTurnServers(TURN);
  await environment.flush();
  assert.equal(environment.rtc.peerConnection, null);
  assert.equal(environment.signals.length, signalCount);
  assert.deepEqual(turnUrls(environment.rtc.rtcConfig), [TURN.urls]);
});

test("empty or STUN-only servers do not change the PC or configuration", async t => {
  for (const response of [[], { urls: "stun:only.example.test" }]) {
    const environment = createEnvironment();
    t.after(environment.close);
    await environment.begin();
    const pc = environment.rtc.peerConnection;
    const before = clone(environment.rtc.rtcConfig);
    assert.throws(() => environment.rtc.setTurnServers(response), /turn:/);
    assert.equal(environment.rtc.peerConnection, pc);
    assert.deepEqual(clone(environment.rtc.rtcConfig), before);
  }
});

test("a TURN URL is detected inside mixed urls and an array can be appended", async t => {
  const environment = createEnvironment({
    rtcConfig: { iceServers: [{ urls: "stun:first.example.test" }, { urls: "stun:second.example.test" }] },
  });
  t.after(environment.close);
  const mixed = { ...TURN, urls: ["stun:stun.example.test", "turns:relay.example.test:443"] };
  const backup = { ...TURN, urls: "turns:backup.example.test:443" };
  await environment.begin();
  assert.equal(environment.rtc.isConnected(), false);
  environment.rtc.setTurnServers([mixed, backup]);
  await environment.flush();
  assert.deepEqual(turnUrls(environment.rtc.peerConnection.getConfiguration()), [
    "turns:relay.example.test:443",
    backup.urls,
  ]);
  assert.equal(environment.rtc.peerConnection.getConfiguration().iceServers.length, 4);
});

test("enabled TURN is reused on normal reconnect without setting it again", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  await environment.begin();
  environment.rtc.setTurnServers(TURN);
  await environment.flush();
  environment.rtc.reconnect();
  await environment.flush();
  assert.deepEqual(turnUrls(environment.rtc.peerConnection.getConfiguration()), [TURN.urls]);
});

test("TURN merging does not mutate configuration shared by callers or other instances", async t => {
  const shared = { iceServers: [{ urls: ["stun:shared.example.test"] }] };
  const first = createEnvironment({ rtcConfig: shared });
  const second = createEnvironment({ rtcConfig: shared });
  t.after(first.close);
  t.after(second.close);
  await first.begin();
  await second.begin();
  first.rtc.setTurnServers(TURN);
  await first.flush();
  assert.deepEqual(turnUrls(first.rtc.peerConnection.getConfiguration()), [TURN.urls]);
  assert.deepEqual(shared, { iceServers: [{ urls: ["stun:shared.example.test"] }] });
  assert.deepEqual(turnUrls(second.rtc.rtcConfig), []);
  assert.deepEqual(turnUrls(second.rtc.peerConnection.getConfiguration()), []);
});

test("setTurnServers honors the existing maximum reconnect attempt limit", async t => {
  const environment = createEnvironment({ maxReconnectAttempts: 0 });
  t.after(environment.close);
  await environment.begin();
  const requestCount = environment.signals.filter(signal => signal.type === "join" && !signal.targetId).length;
  environment.rtc.setTurnServers(TURN);
  await environment.flush();
  assert.equal(environment.rtc.peerConnection, null);
  assert.equal(environment.connections.length, 1, "Applying TURN cannot bypass the base reconnect limit");
  assert.equal(environment.signals.filter(signal => signal.type === "join" && !signal.targetId).length, requestCount);
  assert.deepEqual(turnUrls(environment.rtc.rtcConfig), [TURN.urls]);
});
