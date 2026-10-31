// 运行：node --test browser/ReliableRTCPeerConnection.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// 在内存中加载 TypeScript，不生成构建文件，也不需要真实摄像头或网络。
function compile(relativePath) {
  const filename = path.join(__dirname, relativePath);
  return ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

const eventCode = compile("../common/手写事件.ts");
const peerCode = compile("ReliableRTCPeerConnection.ts");

function createEnvironment() {
  let nextTimerId = 1;
  let nextConnectionId = 1;
  let time = 0;
  let constructorRandom = null;
  let randomSeed = 12345;
  const timers = new Map();
  const peers = [];
  const queue = [];
  const held = [];
  const history = [];
  const logs = [];
  let offerGate = null;
  const environment = { peers, history, held, hold: () => false, autoConnect: true };

  const setTimeout = (callback, delay = 0) => {
    const id = nextTimerId++;
    timers.set(id, { callback, at: time + delay });
    return id;
  };
  const clearTimeout = id => timers.delete(id);
  const math = Object.create(Math);
  math.random = () => {
    if (constructorRandom !== null) return constructorRandom;
    randomSeed = (randomSeed * 16807) % 2147483647;
    return randomSeed / 2147483647;
  };

  class FakeRTCPeerConnection {
    constructor() {
      this.id = nextConnectionId++;
      this.localUfrag = `local${this.id}`;
      this.signalingState = "stable";
      this.connectionState = "new";
      this.iceConnectionState = "new";
      this.localDescription = null;
      this.remoteDescription = null;
      this.transceivers = [];
      this.candidateAttempts = [];
      this.acceptedCandidates = [];
      this.negotiationQueued = false;
      this.iceRestartCount = 0;
    }

    addTransceiver(kind) {
      const transceiver = { receiver: { track: { kind } }, sender: { track: null }, direction: "sendrecv" };
      this.transceivers.push(transceiver);
      this.queueNegotiationNeeded();
      return transceiver;
    }

    queueNegotiationNeeded() {
      if (!this.negotiationQueued) {
        this.negotiationQueued = true;
        Promise.resolve().then(() => {
          this.negotiationQueued = false;
          if (this.signalingState === "stable") this.onnegotiationneeded?.({ target: this });
        });
      }
    }

    restartIce() {
      this.localUfrag = `local${this.id}restart${++this.iceRestartCount}`;
      this.queueNegotiationNeeded();
    }

    getTransceivers() {
      return this.transceivers;
    }

    description(type) {
      return {
        type,
        sdp: `v=0\r\no=- ${this.id} 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:${this.localUfrag}\r\na=ice-pwd:password${this.id}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n`,
      };
    }

    async createOffer() {
      assert.notEqual(this.signalingState, "closed");
      if (offerGate) {
        const gate = offerGate;
        offerGate = null;
        gate.started = true;
        await gate.promise;
      }
      return this.description("offer");
    }

    async createAnswer() {
      assert.equal(this.signalingState, "have-remote-offer");
      return this.description("answer");
    }

    async setLocalDescription(description) {
      assert.notEqual(this.signalingState, "closed");
      if (!description) {
        description = this.description(this.signalingState === "have-remote-offer" ? "answer" : "offer");
      }
      if (description.type === "answer") assert.equal(this.signalingState, "have-remote-offer");
      else assert.equal(this.signalingState, "stable");
      this.localDescription = { ...description };
      this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
      Promise.resolve().then(() => {
        if (this.signalingState === "closed") return;
        this.onicecandidate?.({ target: this, candidate: this.candidate() });
        if (description.type === "answer") this.markConnected();
      });
    }

    async setRemoteDescription(description) {
      assert.notEqual(this.signalingState, "closed");
      if (description.type === "answer") assert.equal(this.signalingState, "have-local-offer");
      const previousUfrag = /a=ice-ufrag:([^\r\n]+)/.exec(this.remoteDescription?.sdp ?? "")?.[1];
      const newUfrag = /a=ice-ufrag:([^\r\n]+)/.exec(description.sdp)?.[1];
      if (description.type === "offer" && previousUfrag && previousUfrag !== newUfrag) {
        this.localUfrag = `local${this.id}restart${++this.iceRestartCount}`;
      }
      this.remoteDescription = { ...description };
      this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
      if (description.type === "answer") Promise.resolve().then(() => this.markConnected());
    }

    candidate() {
      return {
        candidate: `candidate:1 1 udp 2122260223 192.0.2.${this.id} 5000 typ host ufrag ${this.localUfrag}`,
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: this.localUfrag,
      };
    }

    async addIceCandidate(candidate) {
      this.candidateAttempts.push(candidate);
      assert.ok(this.remoteDescription, "ICE requires a remote description");
      const remoteUfrag = /a=ice-ufrag:([^\r\n]+)/.exec(this.remoteDescription.sdp)?.[1];
      assert.equal(candidate.usernameFragment, remoteUfrag, "ICE must belong to the remote SDP generation");
      this.acceptedCandidates.push(candidate);
    }

    markConnected() {
      if (!environment.autoConnect) return;
      if (this.signalingState === "closed" || this.connectionState === "connected") return;
      this.connectionState = "connected";
      this.iceConnectionState = "connected";
      this.onconnectionstatechange?.({ target: this });
    }

    setConnectionState(state) {
      this.connectionState = state;
      this.iceConnectionState = state;
      this.onconnectionstatechange?.({ target: this });
    }

    async getStats() {
      if (this.stats) return this.stats;
      return new Map([
        ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
        ["pair", { type: "candidate-pair", id: "pair", state: "succeeded", nominated: true }],
      ]);
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
    RTCPeerConnection: FakeRTCPeerConnection,
    RTCIceCandidate: class {
      constructor(candidate) {
        Object.assign(this, candidate);
      }
    },
    window: { setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  });
  function load(code, require) {
    const module = { exports: {} };
    vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context)(require, module, module.exports);
    return module.exports;
  }
  const eventModule = load(eventCode, () => {
    throw new Error("Unexpected event module import");
  });
  const { ReliableRTCPeerConnection } = load(peerCode, name => {
    assert.equal(name, "../common/手写事件");
    return eventModule;
  });

  environment.withRandom = (value, callback) => {
    constructorRandom = value;
    try {
      return callback();
    } finally {
      constructorRandom = null;
    }
  };
  environment.deferNextOffer = () => {
    const gate = { started: false };
    gate.promise = new Promise(resolve => {
      gate.release = resolve;
    });
    offerGate = gate;
    return gate;
  };
  environment.createPeer = (name, idRandom = 0.5, options = {}) => {
    constructorRandom = idRandom;
    const peer = new ReliableRTCPeerConnection(
      undefined,
      options.maxReconnectAttempts ?? 10,
      options.negotiationTimeoutMs ?? 15000
    );
    constructorRandom = null;
    peer.testName = name;
    peer.on(options.mediaHook ?? "beforeNegotiation", pc => {
      if (!pc.getTransceivers().length) pc.addTransceiver("audio", { direction: "sendrecv" });
    });
    peer.on("signaling", signal => {
      // 使用完整的实际信令对象，模拟 JSON/WebSocket，不能漏掉新增的路由或轮次字段。
      const message = JSON.parse(JSON.stringify(signal));
      const target = peers.find(other => other !== peer);
      const entry = { from: peer, to: target, message };
      history.push(entry);
      assert.ok(history.length < 500, "Signaling must not loop indefinitely");
      if (!target) return;
      if (environment.hold(entry)) held.push(entry);
      else queue.push(entry);
    });
    peers.push(peer);
    if (options.start !== false) peer.start();
    return peer;
  };

  environment.flush = async () => {
    // 只推进微任务和信令；重连/握手超时由测试显式推进，避免真实等待。
    for (let round = 0; round < 100; round++) {
      await Promise.resolve();
      while (queue.length) {
        const { to, message } = queue.shift();
        await to.onSignalingMessage(message);
      }
    }
  };

  environment.advanceTime = async milliseconds => {
    const until = time + milliseconds;
    for (let count = 0; count < 100; count++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      time = timer.at;
      timers.delete(id);
      timer.callback();
      await environment.flush();
    }
    time = until;
  };
  environment.close = () => peers.forEach(peer => peer.close());
  environment.logs = logs;
  return environment;
}

async function connectPair(environment, options) {
  const first = environment.createPeer("first", 0.1, options);
  await environment.flush(); // 首个 join 没有接收者，模拟另一端尚未上线。
  const second = environment.createPeer("second", 0.9, options);
  await environment.flush();
  assert.notEqual(first.role, second.role, "Sequential joins must elect complementary roles");
  for (const peer of [first, second]) {
    assert.ok(peer.peerConnection?.localDescription, `${peer.testName} needs local SDP`);
    assert.ok(peer.peerConnection?.remoteDescription, `${peer.testName} needs remote SDP`);
    assert.equal(peer.peerConnection.signalingState, "stable");
  }
  return {
    first,
    second,
    offerer: first.role === "offer" ? first : second,
    answerer: first.role === "answer" ? first : second,
  };
}

test("start sends the initial join after listeners are attached", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const peer = environment.createPeer("first", 0.5, { start: false });
  assert.equal(environment.history.length, 0);
  peer.start();
  const joins = environment.history.filter(({ message }) => message.type === "join");
  assert.equal(joins.length, 1);
  assert.equal(typeof joins[0].message.data, "string");
  assert.ok(joins[0].message.data.length > 0);
  assert.equal(peer.isClosed, false);
});

test("sequential joins recover the missing first join and negotiate both SDPs", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { first, second } = await connectPair(environment);
  assert.ok(
    environment.history.some(({ from, to, message }) => from === first && to === second && message.type === "join")
  );
  assert.ok(environment.history.some(({ from, message }) => from === second && message.type === "offer"));
});

test("simultaneous joins finish without a join reply loop", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const first = environment.createPeer("first", 0.1);
  const second = environment.createPeer("second", 0.9);
  await environment.flush();
  assert.notEqual(first.role, second.role);
  assert.equal(first.peerConnection.signalingState, "stable");
  assert.equal(second.peerConnection.signalingState, "stable");
  assert.equal(environment.history.filter(({ message }) => message.type === "offer").length, 1);
  assert.equal(environment.history.filter(({ message }) => message.type === "answer").length, 1);
});

test("a duplicate join does not destroy an established connection", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  await connectPair(environment);
  const join = environment.history.find(({ to, message }) => to && message.type === "join" && !message.targetId);
  const connection = join.to.peerConnection;
  const before = environment.history.length;
  await join.to.onSignalingMessage(join.message);
  await environment.flush();
  assert.equal(join.to.peerConnection, connection);
  assert.equal(connection.signalingState, "stable");
  assert.equal(environment.history.slice(before).filter(({ message }) => message.type === "offer").length, 0);
});

test("answerer reconnect notifies the remote peer and completes a new handshake", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { offerer, answerer } = await connectPair(environment);
  const previousOffererConnection = offerer.peerConnection;
  const previousAnswererConnection = answerer.peerConnection;
  const before = environment.history.length;
  answerer.reconnect();
  await environment.flush();
  assert.ok(
    environment.history.slice(before).some(({ from, message }) => from === answerer && message.type === "join")
  );
  assert.notEqual(answerer.peerConnection, previousAnswererConnection);
  assert.notEqual(offerer.peerConnection, previousOffererConnection);
  assert.equal(answerer.peerConnection.signalingState, "stable");
  assert.equal(offerer.peerConnection.signalingState, "stable");
  assert.ok(answerer.peerConnection.remoteDescription);
  assert.ok(offerer.peerConnection.remoteDescription);
});

test("both peers can reconnect simultaneously and converge on one handshake", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { first, second } = await connectPair(environment);
  const oldFirstConnection = first.peerConnection;
  const oldSecondConnection = second.peerConnection;
  const before = environment.history.length;
  environment.withRandom(0.2, () => first.reconnect());
  environment.withRandom(0.8, () => second.reconnect());
  await environment.flush();
  assert.notEqual(first.role, second.role);
  assert.notEqual(first.peerConnection, oldFirstConnection);
  assert.notEqual(second.peerConnection, oldSecondConnection);
  assert.equal(first.peerConnection.signalingState, "stable");
  assert.equal(second.peerConnection.signalingState, "stable");
  assert.equal(environment.history.slice(before).filter(({ message }) => message.type === "offer").length, 1);
  assert.equal(environment.history.slice(before).filter(({ message }) => message.type === "answer").length, 1);
});

test("join acknowledgements do not reset the reconnect attempt limit", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  // SDP 可以交换成功，但 ICE 一直未连通，因此不能清零失败计数。
  environment.autoConnect = false;
  const { first } = await connectPair(environment, { maxReconnectAttempts: 2 });
  const before = environment.history.length;
  for (const idRandom of [0.15, 0.2, 0.25]) {
    environment.withRandom(idRandom, () => first.reconnect());
    await environment.flush();
  }
  assert.equal(
    environment.history
      .slice(before)
      .filter(({ from, message }) => from === first && message.type === "join" && !message.targetId).length,
    2
  );
  assert.equal(first.peerConnection, null);
});

test("media added only in beforeCreateOfferAnswer still starts negotiation", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { first, second } = await connectPair(environment, { mediaHook: "beforeCreateOfferAnswer" });
  assert.ok(first.peerConnection.getTransceivers().length);
  assert.ok(second.peerConnection.getTransceivers().length);
});

test("a late answer from the previous session cannot consume the current offer", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { offerer } = await connectPair(environment);
  const oldAnswer = environment.history.find(({ to, message }) => to === offerer && message.type === "answer").message;
  environment.hold = ({ message }) => message.type === "answer";
  environment.withRandom(0.95, () => offerer.reconnect());
  await environment.flush();
  assert.equal(offerer.peerConnection.signalingState, "have-local-offer");
  const currentConnection = offerer.peerConnection;
  const pendingAnswer = environment.held.find(({ to }) => to === offerer);
  assert.ok(pendingAnswer, "The new offer needs its own answer");
  const previousRemoteDescription = currentConnection.remoteDescription;
  await offerer.onSignalingMessage(oldAnswer);
  assert.equal(offerer.peerConnection, currentConnection);
  assert.equal(currentConnection.signalingState, "have-local-offer");
  assert.equal(currentConnection.remoteDescription, previousRemoteDescription);
  await offerer.onSignalingMessage(pendingAnswer.message);
  await environment.flush();
  assert.equal(currentConnection.signalingState, "stable");
  assert.equal(currentConnection.remoteDescription.sdp, pendingAnswer.message.data);
});

test("a late candidate from the previous session is not added to the new connection", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { offerer } = await connectPair(environment);
  const oldCandidate = environment.history.find(
    ({ to, message }) => to === offerer && message.type === "candidate"
  ).message;
  environment.withRandom(0.95, () => offerer.reconnect());
  await environment.flush();
  const currentConnection = offerer.peerConnection;
  const before = currentConnection.candidateAttempts.length;
  await offerer.onSignalingMessage(oldCandidate);
  await environment.flush();
  assert.equal(currentConnection.candidateAttempts.length, before);
  assert.ok(currentConnection.acceptedCandidates.length, "Current-session ICE must still be accepted");
});

test("a previous answer in the same session cannot consume a renegotiation offer", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { offerer } = await connectPair(environment);
  const oldAnswer = environment.history.find(({ to, message }) => to === offerer && message.type === "answer").message;
  const currentConnection = offerer.peerConnection;
  environment.hold = ({ message }) => message.type === "answer";
  currentConnection.addTransceiver("video", { direction: "sendrecv" });
  await environment.flush();
  assert.equal(currentConnection.signalingState, "have-local-offer");
  const previousRemoteDescription = currentConnection.remoteDescription;
  await offerer.onSignalingMessage(oldAnswer);
  assert.equal(currentConnection.signalingState, "have-local-offer");
  assert.equal(currentConnection.remoteDescription, previousRemoteDescription);
  const currentAnswer = environment.held.find(({ to }) => to === offerer);
  assert.ok(currentAnswer);
  await offerer.onSignalingMessage(currentAnswer.message);
  await environment.flush();
  assert.equal(currentConnection.signalingState, "stable");
});

test("a previous candidate in the same session is ignored after renegotiation", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { offerer } = await connectPair(environment);
  const oldCandidate = environment.history.find(
    ({ to, message }) => to === offerer && message.type === "candidate"
  ).message;
  const connection = offerer.peerConnection;
  connection.addTransceiver("video", { direction: "sendrecv" });
  await environment.flush();
  assert.equal(offerer.peerConnection, connection);
  assert.equal(connection.signalingState, "stable");
  const before = connection.candidateAttempts.length;
  await offerer.onSignalingMessage(oldCandidate);
  await environment.flush();
  assert.equal(connection.candidateAttempts.length, before);
});

test("ICE restart candidates wait for the new answer instead of using the old remote SDP", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { offerer, answerer } = await connectPair(environment);
  const connection = offerer.peerConnection;
  const previousRemoteDescription = connection.remoteDescription;
  const before = connection.candidateAttempts.length;
  environment.hold = ({ message }) => message.type === "answer";
  connection.restartIce();
  await environment.flush();
  assert.equal(offerer.peerConnection, connection);
  assert.equal(connection.signalingState, "have-local-offer");
  assert.equal(connection.remoteDescription, previousRemoteDescription);
  assert.equal(connection.candidateAttempts.length, before, "New ICE must not be applied against the previous answer");
  const currentAnswer = environment.held.find(({ to }) => to === offerer);
  assert.ok(currentAnswer);
  await offerer.onSignalingMessage(currentAnswer.message);
  await environment.flush();
  assert.equal(connection.signalingState, "stable");
  assert.equal(connection.candidateAttempts.length, before + 1);
  assert.equal(connection.acceptedCandidates.at(-1).usernameFragment, answerer.peerConnection.localUfrag);
});

test("overlapping duplicate offers do not rebuild the connection or create two answers", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  environment.createPeer("first", 0.1);
  await environment.flush();
  environment.hold = ({ message }) => message.type === "offer";
  environment.createPeer("second", 0.9);
  await environment.flush();
  const offer = environment.held.find(({ message }) => message.type === "offer");
  assert.ok(offer);
  const connection = offer.to.peerConnection;
  await Promise.all([offer.to.onSignalingMessage(offer.message), offer.to.onSignalingMessage(offer.message)]);
  await environment.flush();
  assert.equal(offer.to.peerConnection, connection);
  assert.equal(connection.signalingState, "stable");
  assert.equal(
    environment.history.filter(({ from, message }) => from === offer.to && message.type === "answer").length,
    1
  );
  assert.equal(offer.from.peerConnection.signalingState, "stable");
});

test("closing while createOffer is pending prevents a late SDP from being sent", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  environment.createPeer("first", 0.1);
  await environment.flush();
  const gate = environment.deferNextOffer();
  const second = environment.createPeer("second", 0.9);
  await environment.flush();
  assert.equal(gate.started, true);
  second.close();
  const before = environment.history.length;
  gate.release();
  await environment.flush();
  assert.equal(second.peerConnection, null);
  assert.equal(
    environment.history.slice(before).filter(({ from, message }) => from === second && message.type === "offer").length,
    0
  );
});

test("closing before start sends no join", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const peer = environment.createPeer("first", 0.5, { start: false });
  peer.close();
  await environment.flush();
  assert.equal(environment.history.length, 0);
  assert.equal(peer.peerConnection, null);
});

test("closing in beforeNegotiation sends no acknowledgement or later reconnect", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const first = environment.createPeer("first", 0.1, { negotiationTimeoutMs: 40, maxReconnectAttempts: 2 });
  let closedAt = -1;
  first.on("beforeNegotiation", () => {
    first.close();
    closedAt = environment.history.length;
  });
  await environment.flush();
  environment.createPeer("second", 0.9, { negotiationTimeoutMs: 40, maxReconnectAttempts: 2 });
  await environment.flush();
  assert.ok(closedAt >= 0, "The setup hook must have run");
  assert.equal(first.isClosed, true);
  assert.equal(first.peerConnection, null);
  assert.equal(environment.history.slice(closedAt).filter(({ from }) => from === first).length, 0);
  await environment.advanceTime(200);
  assert.equal(environment.history.slice(closedAt).filter(({ from }) => from === first).length, 0);
});

test("a one-time beforeNegotiation failure immediately retries the handshake", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const first = environment.createPeer("first", 0.1);
  let setupCalls = 0;
  first.on("beforeNegotiation", () => {
    setupCalls++;
    if (setupCalls === 1) throw new Error("Simulated one-time media setup failure");
  });
  await environment.flush();
  const second = environment.createPeer("second", 0.9);
  await environment.flush();
  assert.ok(setupCalls >= 2, "The failed setup must be retried without waiting for a timer");
  assert.ok(
    environment.history.filter(({ from, message }) => from === first && message.type === "join" && !message.targetId)
      .length >= 2
  );
  for (const peer of [first, second]) {
    assert.equal(peer.peerConnection.signalingState, "stable");
    assert.ok(peer.peerConnection.localDescription);
    assert.ok(peer.peerConnection.remoteDescription);
  }
});

test("waiting without a remote id does not negotiate or retry", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const peer = environment.createPeer("first", 0.1, { negotiationTimeoutMs: 40, maxReconnectAttempts: 2 });
  await environment.flush();
  assert.equal(peer.peerConnection, null);
  await environment.advanceTime(200);
  assert.equal(
    environment.history.filter(({ from, message }) => from === peer && message.type === "join" && !message.targetId)
      .length,
    1
  );
  assert.equal(peer.peerConnection, null);
});

test("a remote leave clears that peer and ignores its later join", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { first, second } = await connectPair(environment, { negotiationTimeoutMs: 40 });
  const remoteId = environment.history.find(
    ({ from, message }) => from === second && message.type === "join" && !message.targetId
  ).message.data;
  let left = 0;
  first.on("remoteClose", () => left++);
  const before = environment.history.length;
  await first.onSignalingMessage({ type: "leave" });
  assert.equal(left, 1);
  assert.equal(first.peerConnection, null);
  await first.onSignalingMessage({ type: "leave" });
  assert.equal(left, 1);
  await environment.advanceTime(80);
  assert.equal(environment.history.slice(before).filter(({ from }) => from === first).length, 0);
  await first.onSignalingMessage({ type: "join", data: remoteId });
  await environment.flush();
  assert.equal(first.peerConnection, null);
  await first.onSignalingMessage({ type: "join", data: "a-new-peer" });
  await environment.flush();
  assert.ok(first.peerConnection);
});

test("a missing answer times out and starts a fresh handshake", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  environment.createPeer("first", 0.1, { negotiationTimeoutMs: 40 });
  await environment.flush();
  environment.hold = ({ message }) => message.type === "answer";
  const second = environment.createPeer("second", 0.9, { negotiationTimeoutMs: 40 });
  await environment.flush();
  assert.equal(second.peerConnection.signalingState, "have-local-offer");
  const previousConnection = second.peerConnection;
  const before = environment.history.length;
  await environment.advanceTime(41);
  assert.ok(environment.history.slice(before).some(({ from, message }) => from === second && message.type === "join"));
  assert.notEqual(second.peerConnection, previousConnection);
});

test("recovering from disconnected cancels the delayed reconnect", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { first } = await connectPair(environment);
  const connection = first.peerConnection;
  const before = environment.history.length;
  environment.withRandom(0.5, () => connection.setConnectionState("disconnected"));
  await environment.advanceTime(2000);
  assert.equal(first.peerConnection, connection, "Transient disconnection should allow native recovery");
  connection.setConnectionState("connected");
  await environment.advanceTime(6000);
  assert.equal(first.peerConnection, connection);
  assert.equal(
    environment.history.slice(before).filter(({ from, message }) => from === first && message.type === "join").length,
    0
  );
});

test("repeated failed events schedule only one delayed reconnect", async t => {
  const environment = createEnvironment();
  t.after(environment.close);
  const { first, second } = await connectPair(environment);
  const oldConnection = first.peerConnection;
  const before = environment.history.length;
  environment.withRandom(0.5, () => {
    oldConnection.setConnectionState("failed");
    oldConnection.setConnectionState("failed");
  });
  await environment.advanceTime(499);
  assert.equal(first.peerConnection, oldConnection);
  await environment.advanceTime(1);
  assert.notEqual(first.peerConnection, oldConnection);
  assert.equal(first.peerConnection.connectionState, "connected");
  assert.equal(second.peerConnection.connectionState, "connected");
  await environment.advanceTime(1000);
  assert.equal(
    environment.history
      .slice(before)
      .filter(({ from, message }) => from === first && message.type === "join" && !message.targetId).length,
    1
  );
});

for (const useTransport of [true, false]) {
  test(
    useTransport
      ? "ICE stats follow the transport's selected candidate pair"
      : "ICE stats fall back to a nominated successful pair without transport selection",
    async t => {
      const environment = createEnvironment();
      t.after(environment.close);
      const { first } = await connectPair(environment);
      const connection = first.peerConnection;
      connection.stats = new Map([
        [
          "selected",
          {
            type: "candidate-pair",
            id: "selected",
            nominated: true,
            state: "succeeded",
            localCandidateId: "local",
            remoteCandidateId: "remote",
          },
        ],
        [
          "local",
          {
            type: "local-candidate",
            id: "local",
            address: "192.0.2.10",
            protocol: "udp",
            relatedAddress: "10.0.0.10",
            url: "stun:selected.example.test",
          },
        ],
        ["remote", { type: "remote-candidate", id: "remote", address: "192.0.2.20", protocol: "udp" }],
        [
          "decoy",
          {
            type: "candidate-pair",
            id: "decoy",
            nominated: useTransport,
            state: "succeeded",
            localCandidateId: "decoy-local",
            remoteCandidateId: "decoy-remote",
          },
        ],
        ["decoy-local", { type: "local-candidate", id: "decoy-local", address: "198.51.100.10", protocol: "tcp" }],
        ["decoy-remote", { type: "remote-candidate", id: "decoy-remote", address: "198.51.100.20", protocol: "tcp" }],
      ]);
      if (useTransport) connection.stats.set("transport", { type: "transport", selectedCandidatePairId: "selected" });
      environment.logs.length = 0;
      await first.printSelectedIceCandidatePair();
      const output = environment.logs.flat().join("\n");
      assert.match(output, /192\.0\.2\.10/);
      assert.match(output, /192\.0\.2\.20/);
      assert.match(output, /stun:selected\.example\.test/);
      assert.doesNotMatch(output, /198\.51\.100\./);
    }
  );
}

for (const action of ["start", "reconnect"]) {
  test(`calling ${action} in beforeNegotiation abandons the old setup before sending its acknowledgement`, async t => {
    const environment = createEnvironment();
    t.after(environment.close);
    const first = environment.createPeer("first", 0.1);
    await environment.flush();
    let oldConnection = null;
    let restartedAt = -1;
    first.on("beforeNegotiation", pc => {
      if (oldConnection) return;
      oldConnection = pc;
      restartedAt = environment.history.length;
      environment.withRandom(0.2, () => first[action]());
    });
    const second = environment.createPeer("second", 0.9);
    await environment.flush();
    assert.ok(oldConnection, "The synchronous restart hook should run");
    assert.equal(oldConnection.connectionState, "closed");
    assert.notEqual(first.peerConnection, oldConnection);
    const outgoing = environment.history.slice(restartedAt).filter(({ from }) => from === first);
    assert.ok(outgoing.length);
    assert.equal(outgoing[0].message.type, "join");
    assert.equal(outgoing[0].message.targetId, undefined, "Old setup must not acknowledge before the new join request");
    for (const peer of [first, second]) {
      assert.equal(peer.peerConnection.signalingState, "stable");
      assert.ok(peer.peerConnection.localDescription);
      assert.ok(peer.peerConnection.remoteDescription);
    }
  });
}
