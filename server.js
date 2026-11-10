// Office Life Simulator 2D — server lokal (tanpa dependensi, cukup Node.js 18+)
//   Murid : http://localhost:3000/
//   Guru  : http://localhost:3000/guru   (butuh kata sandi guru)
// Ganti kata sandi:  GURU_PASSWORD=rahasia node server.js     Ganti port: PORT=8080 node server.js
// Kode ruangan TETAP (bukan acak). Ganti dengan: ROOM_CODE=KELAS7A node server.js   (huruf/angka, maks. 12 karakter)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto"), os = require("os");
const PORT = +process.env.PORT || 3000;
const PASSWORD = process.env.GURU_PASSWORD || "guru123";
const ROOM_CODE = (process.env.ROOM_CODE || "KELAS").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "KELAS";
const MAX_PEERS = 60, MAX_MSG = 256 * 1024, MAX_RATE = 200; // pesan/detik per murid

const GAME = fs.readFileSync(path.join(__dirname, "public", "game.html"), "utf8");
const page = role => GAME.replace("<head>", '<head><script>window.ROLE="' + role + '"</script>');
const HEAD = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };

const server = http.createServer((req, res) => {
  const p = req.url.split("?")[0].replace(/\/+$/, "") || "/";
  if (p === "/") { res.writeHead(200, HEAD); return res.end(page("murid")); }
  if (p === "/guru") { res.writeHead(200, { ...HEAD, "X-Robots-Tag": "noindex" }); return res.end(page("guru")); }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Tidak ditemukan");
});

// ---------- WebSocket minimal (RFC 6455) ----------
function send(c, obj) {
  if (c.dead) return;
  const p = Buffer.from(JSON.stringify(obj));
  let h;
  if (p.length < 126) h = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  try { c.sock.write(Buffer.concat([h, p])); } catch (e) {}
}
function parse(c, chunk) {
  c.buf = Buffer.concat([c.buf, chunk]);
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const fin = !!(b[0] & 0x80), op = b[0] & 15, masked = !!(b[1] & 0x80);
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > MAX_MSG) return kill(c);
    if (!masked) return kill(c);
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4), data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);
    if (op === 8) return kill(c);
    if (op === 10) { c.alive = true; continue; }
    if (op === 9) { c.sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
    if (op === 1 || op === 0) {
      c.frag = c.frag ? Buffer.concat([c.frag, data]) : data;
      if (c.frag.length > MAX_MSG) return kill(c);
      if (fin) { const t = c.frag.toString("utf8"); c.frag = null; onMessage(c, t); }
    }
  }
}
function kill(c) { if (!c.dead) { try { c.sock.destroy(); } catch (e) {} onClose(c); } }

// ---------- Ruang (kantor) ----------
const rooms = new Map(); // kode -> { host, peers: Map(cid -> client), nextCid }
const same = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m.t !== "string") return;
  if (m.t === "host") { // hanya guru dengan kata sandi benar
    if (c.room) return;
    if (!same(m.pw || "", PASSWORD)) { setTimeout(() => send(c, { t: "err", msg: "Kata sandi guru salah." }), 600); return; }
    const code = ROOM_CODE, old = rooms.get(code);
    if (old) kill(old.host); // guru memuat ulang / pindah perangkat: sambungan lama diputus, murid menyambung ulang otomatis
    rooms.set(code, { host: c, peers: new Map(), nextCid: 1 });
    c.room = code; c.role = "host"; send(c, { t: "hosted", code });
    console.log("[guru] kantor dibuka:", code); return;
  }
  if (m.t === "ping") return;
  if (m.t === "join") { // murid: hanya bisa masuk ke kantor yang sudah dibuka guru
    if (c.room) return;
    const code = String(m.code || "").trim().toUpperCase(), r = rooms.get(code);
    if (!r) return send(c, { t: "err", msg: "Kode kantor tidak ditemukan. Minta kode terbaru ke guru." });
    if (r.peers.size >= MAX_PEERS) return send(c, { t: "err", msg: "Kantor sudah penuh." });
    c.room = code; c.role = "peer"; c.cid = r.nextCid++; r.peers.set(c.cid, c);
    send(c, { t: "joined" }); send(r.host, { t: "peer-open", cid: c.cid }); return;
  }
  if (m.t === "data" && c.room) {
    const r = rooms.get(c.room); if (!r) return;
    if (c.role === "host") { const p = r.peers.get(m.to); if (p) send(p, { t: "data", d: m.d }); }
    else {
      const now = Date.now(); if (now - (c.rt || 0) > 1000) { c.rt = now; c.rc = 0; }
      if (++c.rc > MAX_RATE) return;
      send(r.host, { t: "data", cid: c.cid, d: m.d });
    }
  }
}
function onClose(c) {
  if (c.dead) return; c.dead = true;
  const r = rooms.get(c.room); if (!r) return;
  if (c.role === "host") {
    rooms.delete(c.room); console.log("[guru] kantor ditutup:", c.room);
    for (const p of r.peers.values()) { send(p, { t: "host-left" }); try { p.sock.end(); } catch (e) {} }
  } else { r.peers.delete(c.cid); send(r.host, { t: "peer-close", cid: c.cid }); }
}
server.on("upgrade", (req, sock) => {
  if (req.url.split("?")[0] !== "/ws" || !req.headers["sec-websocket-key"]) return sock.destroy();
  const acc = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + "\r\n\r\n");
  const c = { sock, buf: Buffer.alloc(0), room: null, role: null, dead: false, alive: true };
  sock.setNoDelay(true);
  sock.on("data", d => parse(c, d)); sock.on("close", () => onClose(c)); sock.on("error", () => onClose(c));
});

setInterval(() => { // deteksi sambungan mati (WiFi putus, laptop tidur)
  for (const r of rooms.values()) for (const c of [r.host, ...r.peers.values()]) {
    if (c.dead) continue;
    if (!c.alive) { kill(c); continue; }
    c.alive = false; try { c.sock.write(Buffer.from([0x89, 0])); } catch (e) {}
  }
}, 20000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("\nOffice Life Simulator 2D berjalan.\n");
  console.log("  Kode ruangan (tetap): " + ROOM_CODE + "   <- dibagikan ke murid\n");
  console.log("  Murid : http://localhost:" + PORT + "/");
  console.log("  Guru  : http://localhost:" + PORT + "/guru   (kata sandi: " + (process.env.GURU_PASSWORD ? "sesuai GURU_PASSWORD" : PASSWORD + "  <- ganti dengan GURU_PASSWORD") + ")");
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === "IPv4" && !i.internal).map(i => i.address);
  ips.forEach(ip => console.log("  Murid di jaringan yang sama (WiFi): http://" + ip + ":" + PORT + "/"));
  console.log("");
});
