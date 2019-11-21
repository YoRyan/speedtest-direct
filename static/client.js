'use strict'; (async () => {

const STUN_SERVERS = ["stun:stun.l.google.com:19302"];
const REPORT_INTERVAL = 200;
const BPMS2MBPS = 1e-3*1e-3*8*1e3;

class Semaphore {
        constructor(value) {
                if (typeof value !== "number" || value < 0)
                        throw "semaphore value must be a non-negative integer";
                this.value = value;
                this.waiting = [];
        }
        up() {
                this.value++;
                let consumer = this.waiting.shift();
                if (consumer !== undefined)
                        consumer();
        }
        async down() {
                if (this.value === 0)
                        await new Promise((resolve, reject) => {
                                this.waiting.push(resolve);
                        });
                this.value--;
        }
}
class Queue {
        constructor(capacity) {
                if (typeof capacity !== "number" || capacity <= 0)
                        throw "queue capacity must be a positive integer";
                this.queue = [];
                this.semProduce = new Semaphore(capacity);
                this.semConsume = new Semaphore(0);
        }
        async put(value) {
                await this.semProduce.down();
                this.queue.push(value);
                this.semConsume.up();
        }
        async get() {
                await this.semConsume.down();
                let value = this.queue.shift();
                this.semProduce.up();
                return value;
        }
}
class Channel extends Queue {
        constructor() { super(1); }
}

class AsyncWebSocket {
        constructor(url, protocols = []) {
                this.ws = new WebSocket(url, protocols);
        }
        open() {
                return new Promise(async (resolve, reject) => {
                        let op = await select([this.ws, "open"], [this.ws, "error"]);
                        if (op.name === "open")
                                resolve();
                        else
                                reject(op.event);
                });
        }
        send(data) { this.ws.send(data); }
        read() {
                return new Promise(async (resolve, reject) => {
                        let op = await select([this.ws, "message"],
                                              [this.ws, "error"]);
                        if (op.name === "message")
                                resolve(op.event.data);
                        else
                                reject(op.event);
                });
        }
}
class SignalSocket {
        constructor() {
                this.aws = new AsyncWebSocket(...arguments);
                this.counter = 0;
                this.pending = new Map();
                this.readq = new Queue(100);
                this.err = null;
        }
        async open() {
                await this.aws.open();
                new Promise((resolve, reject) => { this.readLoop(); });
        }
        async readLoop() {
                while (true) {
                        let packet;
                        try {
                                packet = JSON.parse(await this.aws.read());
                        } catch (err) {
                                this.error(err);
                                break;
                        }
                        if (packet.Id !== undefined) {
                                this.pending.get(packet.Id).put(packet);
                                this.pending.delete(packet.Id);
                        } else if (packet.Datab64 !== undefined) {
                                this.readq.put(packet);
                        }
                }
        }
        error(err) {
                this.err = err;
                this.readq.put(null);
                this.pending.forEach((q, id) => { q.put(null); });
                this.pending = new Map();
        }
        async send(data, destination) {
                const id = ++this.counter;
                let wait = new Channel();
                this.pending.set(id, wait);
                this.aws.send(JSON.stringify({ Datab64: btoa(JSON.stringify(data)),
                                               Dest: destination, Id: id }));
                const ack = await wait.get();
                if (ack === null)
                        throw this.err;
                return ack;
        }
        async read() {
                const packet = await this.readq.get();
                if (packet === null)
                        throw this.err;
                return { Data: JSON.parse(atob(packet.Datab64)),
                         Src: packet.Src, Dest: packet.Dest };
        }
}

async function main() {
        let testButton = document.querySelector("#controls button");
        let testSize = document.querySelector("#controls select");
        testButton.disabled = testSize.disabled = true;

        const wsp = location.protocol === "https:" ? "wss" : "ws";
        let ss = new SignalSocket(`${wsp}://${location.host}/signal`);
        await ss.open();

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
        let ping = rtc.createDataChannel("ping", { negotiated: true, id: 0 });
        let speed = rtc.createDataChannel("ping", { negotiated: true, id: 1 });
        await Promise.all([select([ping, "open"]), select([speed, "open"])]);

        /* Start background ping. */
        let latencyDisplay = document.querySelector("#latency > span");
        new Promise(async (resolve, reject) => {
                let waitFor = (channel, test) => {
                        let handler = (event, resolve) => {
                                if (test(event.data))
                                        resolve();
                                else
                                        channel.send(event.data);
                        };
                        return new Promise((resolve, reject) => {
                                channel.onmessage = (event) => {
                                        handler(event, resolve);
                                };
                        });
                };
                while (true) {
                        const t0 = Date.now();
                        ping.send(t0);
                        await waitFor(ping, (v) => v === String(t0));
                        const t1 = Date.now();
                        latencyDisplay.textContent = `${t1 - t0} ms`;
                        await sleep(1000);
                }
        });

        /* Run speed tests. */
        while (true) {
                let speedDownDisplay = document.getElementById("#speed-down > span");
                let speedUpDisplay = document.getElementById("#speed-up > span");

                testButton.disabled = testSize.disabled = false;
                let op = await select([testButton, "click"], [speed, "message"]);
                testButton.disabled = testSize.disabled = true;
                let runTest = async (test, display) => {
                        let average = 0.0;
                        let i = 0;
                        for await (let v of test) {
                                average = (average*i + v)/(i + 1);
                                i++;
                                showSpeed(display, v);
                        }
                        showSpeed(display, average);
                };
                let showSpeed = (display, value) => {
                        let text;
                        if (value < 1.0)
                                text = `${Math.round(value*1e3*1e1)/1e1} Kbps`;
                        else
                                text = `${Math.round(value*1e1)/1e1} Mbps`;
                        display.textContent = text;
                };
                if (op.target === testButton) {
                        const testBytes = parseInt(testSize.value);
                        speed.send(testBytes);
                        await runTest(sendSpeedTest(speed, testBytes),
                                      speedUpDisplay);
                        await runTest(receiveSpeedTest(speed), speedDownDisplay);
                } else if (op.target === speed) {
                        const testBytes = parseInt(op.event.data);
                        await runTest(receiveSpeedTest(speed), speedDownDisplay);
                        await runTest(sendSpeedTest(speed, testBytes),
                                      speedUpDisplay);
                }
        }
}
async function pair(socket) {
        const id = (await socket.send({}, 0)).You;

        let popup = document.createElement("div");
        popup.setAttribute("id", "connect");
        document.body.appendChild(popup);

        let identLabel = document.createElement("p");
        identLabel.appendChild(document.createTextNode("Your identifier is:"));
        identLabel.setAttribute("id", "connect-label");
        popup.appendChild(identLabel);

        let ident = document.createElement("p");
        ident.appendChild(document.createTextNode(idWords(id).join(" ")));
        ident.setAttribute("id", "connect-ident");
        popup.appendChild(ident);

        let form = document.createElement("form");
        popup.appendChild(form);

        let formLabel = document.createElement("p");
        formLabel.appendChild(document.createTextNode("Identifier to connect to:"));
        form.appendChild(formLabel);

        let formField = document.createElement("input");
        formField.setAttribute("type", "text");
        form.appendChild(formField);

        let formSubmit = document.createElement("input");
        formSubmit.setAttribute("type", "submit");
        form.appendChild(formSubmit);

        form.addEventListener("submit", async (event) => {
                event.preventDefault();
                const inputId = wordsId(...formField.value.split(" "));
                if (inputId === -1)
                        formLabel.textContent = "Invalid identifier.";
                else if (inputId === id)
                        formLabel.textContent = "You cannot connect to yourself.";
                else
                        await socket.send("PING", inputId);
        });

        const msg = await socket.read();
        if (msg.Data === "PING") {
                await socket.send("PONG", msg.Src);
                popup.parentNode.removeChild(popup);
                return -msg.Src;
        } else if (msg.Data === "PONG") {
                popup.parentNode.removeChild(popup);
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
                const v = words.findIndex((w) => w === arguments[i]);
                if (v === -1)
                        return -1;
                id += v*Math.pow(words.length, arguments.length - i - 1);
        }
        return id;
}
async function readFrom(socket, id) {
        let msg;
        do
                msg = await socket.read();
        while (msg.Src !== id);
        return msg;
}
async function* sendSpeedTest(channel, totalBytes) {
        const buffer = new ArrayBuffer(16*1e3);
        const nBuf = Math.ceil(totalBytes/buffer.byteLength);
        let flush = async (ch) => {
                while (ch.bufferedAmount > 0)
                        await sleep(0);
        };
        for (let i = 0, i0 = 0, t0 = Date.now(); i < nBuf; i++) {
                const now = Date.now();
                if (now - t0 >= REPORT_INTERVAL) {
                        yield (i - i0)*buffer.byteLength/(now - t0)*BPMS2MBPS;
                        i0 = i;
                        t0 = now;
                }
                channel.send(buffer);
                await flush(channel);
        }
        channel.send("END");
        await flush(channel);
}
async function* receiveSpeedTest(channel) {
        let received;
        for (let i = 0, bytes = 0, t0 = Date.now(); received !== "END"; i++) {
                const now = Date.now();
                if (now - t0 >= REPORT_INTERVAL) {
                        yield bytes/(now - t0)*BPMS2MBPS;
                        bytes = 0;
                        t0 = now;
                }
                let op = await select([channel, "message"], [channel, "error"]);
                if (op.name === "error")
                        throw op.event;
                received = op.event.data;
                if (received.byteLength !== undefined) /* chrome */
                        bytes += received.byteLength;
                else if (received.size !== undefined) /* firefox */
                        bytes += received.size;
        }
}
function sleep(ms) {
        return new Promise((resolve, reject) => {
                if (typeof ms === "number" && ms >= 0)
                        setTimeout(() => { resolve(); }, ms);
                else
                        reject("invalid timeout value");
        });
}
function select() {
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
                        let eventName = sources[i][1];
                        let handler = (ev) => {
                                cleanup();
                                resolve({ target: target, name: eventName,
                                          event: ev});
                        };
                        toRemove.set([target, eventName], handler);
                        target.addEventListener(eventName, handler);
                }
        });
}

main();

})();
