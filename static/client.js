'use strict'; (async () => {

const STUN_SERVERS = ["stun:stun.l.google.com:19302"];
const REPORT_INTERVAL = 200;

class Semaphore {
        constructor(value) {
                if (typeof value !== "number" || value < 0)
                        throw "semaphore value must be a non-negative integer";
                this._value = value;
                this._waiting = [];
        }
        up() {
                this._value++;
                let consumer = this._waiting.shift();
                if (consumer !== undefined)
                        consumer();
        }
        async down() {
                if (this._value === 0)
                        await new Promise((resolve, reject) => {
                                this._waiting.push(resolve);
                        });
                this._value--;
        }
}
class Queue {
        constructor(capacity) {
                if (typeof capacity !== "number" || capacity <= 0)
                        throw "queue capacity must be a positive integer";
                this._queue = [];
                this._semProduce = new Semaphore(capacity);
                this._semConsume = new Semaphore(0);
        }
        async put(value) {
                await this._semProduce.down();
                this._queue.push(value);
                this._semConsume.up();
        }
        async get() {
                await this._semConsume.down();
                let value = this._queue.shift();
                this._semProduce.up();
                return value;
        }
}
class Channel extends Queue {
        constructor() { super(1); }
}

class AsyncWebSocket {
        constructor(url, protocols = []) {
                this._ws = new WebSocket(url, protocols);
        }
        async open() {
                await new Promise(async (resolve, reject) => {
                        let op = await select([this._ws, "open", "error"]);
                        if (op.name === "open")
                                resolve();
                        else
                                reject(op.event);
                });
                return this;
        }
        send(data) { this._ws.send(data); }
        async *read() {
                while (true)
                        yield await new Promise(async (resolve, reject) => {
                                let op = await select(
                                        [this._ws, "message", "error"]);
                                if (op.name === "message")
                                        resolve(op.event.data);
                                else
                                        reject(op.event);
                        });
        }
}
class SignalSocket {
        constructor() {
                this._aws = new AsyncWebSocket(...arguments);
                this._counter = 0;
                this._pending = new Map();
                this._readq = new Queue(100);
                this._err = null;
        }
        async open() {
                await this._aws.open();
                new Promise((resolve, reject) => { this._readLoop(); });
                return this;
        }
        async _readLoop() {
                try {
                        for await (let msg of this._aws.read()) {
                                let packet = JSON.parse(msg);
                                if (packet.Id !== undefined) {
                                        this._pending.get(packet.Id).put(packet);
                                        this._pending.delete(packet.Id);
                                } else if (packet.Datab64 !== undefined) {
                                        await this._readq.put(packet);
                                }
                        }
                } catch (err) {
                        await this._error(err);
                }
        }
        async _error(err) {
                this._err = err;
                await this._readq.put(null);
                this._pending.forEach((q, id) => { q.put(null); });
                this._pending = new Map();
        }
        async send(data, destination) {
                const id = ++this._counter;
                let wait = new Channel();
                this._pending.set(id, wait);
                this._aws.send(JSON.stringify({ Datab64: btoa(JSON.stringify(data)),
                                                Dest: destination, Id: id }));
                const ack = await wait.get();
                if (ack === null)
                        throw this._err;
                return ack;
        }
        async *read() {
                while (true) {
                        const packet = await this._readq.get();
                        if (packet === null)
                                throw this._err;
                        yield { Data: JSON.parse(atob(packet.Datab64)),
                                Src: packet.Src, Dest: packet.Dest };
                }
        }
}
class PingTest {
        constructor(channel, side) {
                this._channel = channel;
                this._side = side;
                this._callbacks = new Map();
                new Promise((resolve, reject) => { this._loop(); });
        }
        async _loop() {
                while (true) {
                        let op = await select(
                                [this._channel, "message", "error", "close"]);
                        if (op.name !== "message")
                                break;
                        let packet = JSON.parse(op.event.data);
                        if (packet.side === this._side
                            && this._callbacks.has(packet.key)) {
                                let callback = this._callbacks.get(packet.key);
                                this._callbacks.delete(packet.key);
                                callback();
                        } else if (packet.side !== this._side) {
                                this._channel.send(op.event.data);
                        }
                }
        }
        async *run() {
                while (true) {
                        const t0 = Date.now();
                        await new Promise((resolve, reject) => {
                                this._send(t0, resolve);
                        });
                        yield Date.now() - t0;
                        await sleep(1000);
                }
        }
        _send(theKey, callback) {
                const packet = {side: this._side, key: theKey };
                this._callbacks.set(theKey, callback);
                this._channel.send(JSON.stringify(packet));
        }
}
class SpeedTest {
        constructor(channel, totalBytes, callback) {
                this._channel = channel;
                this._total = totalBytes;
                this._callback = callback;
        }
        async run(sendFirst) {
                let upload = async () => {
                        this._callback("UPLOAD-START", undefined);
                        for await (let speed of this._upload())
                                this._callback("UPLOAD", speed);
                        this._callback("UPLOAD-END", undefined);
                };
                let download = async () => {
                        this._callback("DOWNLOAD-START", undefined);
                        for await (let speed of this._download())
                                this._callback("DOWNLOAD", speed);
                        this._callback("DOWNLOAD-END", undefined);
                };
                if (sendFirst) {
                        await upload();
                        await download();
                } else {
                        await download();
                        await upload();
                }
        }
        async *_upload() {
                const buffer = new ArrayBuffer(16*1e3);
                const nBuf = Math.ceil(this._total/buffer.byteLength);
                let flush = async (ch) => {
                        while (ch.bufferedAmount > 0)
                                await sleep(0);
                };
                for (let i = 0, i0 = 0, t0 = Date.now(); i < nBuf; i++) {
                        const now = Date.now();
                        if (now - t0 >= REPORT_INTERVAL) {
                                yield (i - i0)*buffer.byteLength/(now - t0)*1e3;
                                i0 = i;
                                t0 = now;
                        }
                        this._channel.send(buffer);
                        await flush(this._channel);
                }
                let ack = new Promise(async (resolve, reject) => {
                        let op = await select([this._channel, "message", "error"]);
                        if (op.name === "error" || op.event.data !== "END-ACK")
                                throw op.event;
                        resolve();
                });
                this._channel.send("END");
                await flush(this._channel);
                await ack;
        }
        async *_download() {
                let bytes = 0;
                let t0 = Date.now();
                let received;
                do {
                        const now = Date.now();
                        if (now - t0 >= REPORT_INTERVAL) {
                                yield bytes/(now - t0)*1e3;
                                bytes = 0;
                                t0 = now;
                        }
                        let op = await select([this._channel, "message", "error"]);
                        if (op.name === "error")
                                throw op.event;
                        received = op.event.data;
                        if (received.byteLength !== undefined) /* chrome */
                                bytes += received.byteLength;
                        else if (received.size !== undefined) /* firefox */
                                bytes += received.size;
                } while (received !== "END");
                this._channel.send("END-ACK");
        }
}
class AsyncGeneratorLoop {
        constructor(generator, callback) {
                this._generator = generator;
                this._callback = callback;
                this._run = false;
                this._loop = null;
        }
        start() {
                if (this._run)
                        return this;
                this._run = true;
                this._loop = new Promise(async (resolve, reject) => {
                        while (this._run) {
                                const v = (await this._generator.next()).value;
                                this._callback(v);
                        }
                        resolve();
                });
                return this;
        }
        async stop() {
                if (!this._run)
                        return;
                this._run = false;
                await this._loop;
        }
}

async function main() {
        let testButton = document.querySelector("#controls button");
        let testSize = document.querySelector("#controls select");
        testButton.disabled = testSize.disabled = true;

        const wsp = location.protocol === "https:" ? "wss" : "ws";
        let ss = await (new SignalSocket(`${wsp}://${location.host}/signal`)).open();
        const pairId = await pair(ss);
        const initiator = pairId > 0;
        const otherId = Math.abs(pairId);

        /* Exchange SDP, ICE, and data channels. */
        let rtc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVERS }]});
        if (initiator)
                rtc.addEventListener("negotiationneeded", async (event) => {
                        await rtc.setLocalDescription(await rtc.createOffer());
                        await ss.send({ offer: rtc.localDescription }, otherId);
                });
        rtc.addEventListener("icecandidate", async (event) => {
                if (event.candidate)
                        await ss.send({ candidate: event.candidate }, otherId);
        });
        new Promise(async (resolve, reject) => {
                while (true) {
                        const msg = (await readFrom(ss, otherId)).Data;
                        if (msg.answer !== undefined) {
                                await rtc.setRemoteDescription(msg.answer);
                        } else if (msg.offer !== undefined) {
                                await rtc.setRemoteDescription(msg.offer);
                                await rtc.setLocalDescription(
                                        await rtc.createAnswer());
                                await ss.send(
                                        { answer: rtc.localDescription }, otherId);
                        } else if (msg.candidate !== undefined) {
                                await rtc.addIceCandidate(msg.candidate);
                        }
                }
        });
        let ping = rtc.createDataChannel(
                "ping", { negotiated: true, id: 0, maxRetransmits: 1000 });
        let speed = rtc.createDataChannel(
                "ping", { negotiated: true, id: 1, maxRetransmits: 1000 });
        await Promise.all([select([ping, "open"]), select([speed, "open"])]);

        /* Run ping and speed tests. */
        while (true) {
                let speedDownDisplay = document.querySelector("#speed-down > span");
                let speedUpDisplay = document.querySelector("#speed-up > span");
                let latencyDisplay = document.querySelector("#latency > span");
                testButton.disabled = testSize.disabled = false;

                let pingTest = new PingTest(ping, Number(initiator));
                let pingLoop = new AsyncGeneratorLoop(pingTest.run(), (ms) => {
                        latencyDisplay.textContent = `${ms} ms`;
                }).start();

                let op = await select(
                        [testButton, "click"], [speed, "message", "error"]);
                if (op.name === "error")
                        throw op.event;
                testButton.disabled = testSize.disabled = true;

                await pingLoop.stop();
                latencyDisplay.textContent = "";

                let speedBytes;
                switch (op.target) {
                case testButton:
                        speedBytes = parseInt(testSize.value);
                        speed.send(String(speedBytes));
                        let op2 = await select([speed, "message", "error"]);
                        if (op2.name === "error" || op2.event.data !== "TEST-ACK")
                                throw op2.event;
                        break;
                case speed:
                        speedBytes = parseInt(op.event.data);
                        speed.send("TEST-ACK");
                        break;
                default:
                        throw op.target;
                }
                let fmtSpeed = (v) => {
                        const m = v*1e-3*1e-3*8;
                        if (m < 1.0)
                                return `${Math.round(m*1e3*1e1)/1e1} Kbps`;
                        else
                                return `${Math.round(m*1e1)/1e1} Mbps`;
                };
                let speedUpT0 = 0, speedDownT0 = 0;
                let speedTest = new SpeedTest(speed, speedBytes, (dir, s) => {
                        switch (dir) {
                        case "UPLOAD-START":
                                speedUpT0 = Date.now();
                                break;
                        case "UPLOAD":
                                speedUpDisplay.textContent = fmtSpeed(s);
                                break;
                        case "UPLOAD-END":
                                speedUpDisplay.textContent = fmtSpeed(
                                        speedBytes/(Date.now() - speedUpT0)*1e3);
                                break;
                        case "DOWNLOAD-START":
                                speedDownT0 = Date.now();
                                break;
                        case "DOWNLOAD":
                                speedDownDisplay.textContent = fmtSpeed(s);
                                break;
                        case "DOWNLOAD-END":
                                speedDownDisplay.textContent = fmtSpeed(
                                        speedBytes/(Date.now() - speedDownT0)*1e3);
                                break;
                        default:
                                throw dir;
                        }
                });
                await speedTest.run(op.target === testButton);
        }
}
async function pair(socket) {
        const id = (await socket.send({}, 0)).You;

        let template = document.getElementById("connect").content;
        let popup = template.getElementById("connect-popup");
        document.body.insertBefore(template, document.body.firstChild);

        let ident = document.getElementById("my-ident");
        ident.textContent = idWords(id).join(" ");

        let form = popup.querySelector("form");
        let label = form.querySelector("label");
        let input = document.getElementById("their-ident");
        form.addEventListener("submit", async (event) => {
                event.preventDefault();
                const inputId = wordsId(...input.value.split(" "));
                if (inputId === -1)
                        label.textContent = "Invalid identifier.";
                else if (inputId === id)
                        label.textContent = "You cannot connect to yourself.";
                else
                        await socket.send("PING", inputId);
        });

        const msg = (await socket.read().next()).value;
        if (msg.Data === "PING") {
                await socket.send("PONG", msg.Src);
                popup.remove();
                return -msg.Src;
        } else if (msg.Data === "PONG") {
                popup.remove();
                return msg.Src;
        }
}
function idWords(id) {
        const words = Bip39Words;
        let digits = [];
        let v = id;
        do {
                digits.splice(0, 0, v%words.length);
                v = Math.floor(v/words.length);
        } while (v > 0);
        return digits.map((d) => words[d]);
}
function wordsId() {
        const words = Bip39Words;
        let id = 0;
        for (let i = arguments.length - 1; i >= 0; i--) {
                const v = words.findIndex((w) => w === arguments[i].toLowerCase());
                if (v === -1)
                        return -1;
                id += v*Math.pow(words.length, arguments.length - i - 1);
        }
        return id;
}
async function readFrom(socket, id) {
        let gen = socket.read();
        let msg;
        do
                msg = (await gen.next()).value;
        while (msg.Src !== id);
        return msg;
}
async function sleep(ms) {
        return new Promise((resolve, reject) => {
                if (typeof ms === "number" && ms >= 0)
                        setTimeout(() => { resolve(); }, ms);
                else
                        reject("invalid timeout value");
        });
}
async function select() {
        let sources = arguments;
        return new Promise((resolve, reject) => {
                let toRemove = new Map();
                let cleanup = () => {
                        toRemove.forEach((handler, source, map) => {
                                let target = source[0];
                                let eventName = source[1];
                                target.removeEventListener(eventName, handler);
                        });
                };
                for (let i = 0; i < sources.length; i++) {
                        let target = sources[i][0];
                        let events = sources[i][Symbol.iterator]();
                        events.next();
                        for (const eventName of events) {
                                let handler = (ev) => {
                                        cleanup();
                                        resolve({ target: target, name: eventName,
                                                  event: ev});
                                };
                                toRemove.set([target, eventName], handler);
                                target.addEventListener(eventName, handler);
                        }
                }
        });
}

main();

})();
