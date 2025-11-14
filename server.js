// nano /root/stata-camera-server/server.jsserver.js
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import os from "os";
import { spawn } from "child_process";

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8062;
const clients = new Set();

// Middleware
app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Rate limit (DDOS dan himoya)
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
); 

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

/* ------------------------ WebSocket ulanish ------------------------ */
wss.on("connection", (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`✅ Yangi client: ${clientIP}`);
  ws.isAlive = true;

  clients.add(ws);
  console.log(`👥 Clientlar soni: ${clients.size}`);

  // Native-level heartbeat javobi (agar client ws ping yuborsa)
  ws.on("ping", () => {
    try {
      ws.pong();
    } catch {}
  });

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("close", (code, reason) => {
    console.log(
      `❌ Client uzildi (${clientIP}) - Code: ${code}, Reason: ${reason}`
    );
    clients.delete(ws);
    console.log(`👥 Qolgan clientlar: ${clients.size}`);
  });

  ws.on("error", (err) => {
    console.error(`🚨 WebSocket xatolik: ${err.message}`);
    clients.delete(ws);
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log("📨 Clientdan kelgan xabar:", message);

      // WS ping/pong
      if (message?.type === "ping") {
        return ws.send(
          JSON.stringify({
            type: "pong",
            timestamp: new Date().toISOString(),
          })
        );
      }

      // 🔄 Hamma clientlarga broadcast qilish (shu clientdan kelgan xabarni)
      const broadcastMsg = JSON.stringify({
        type: "client_message",
        from: clientIP,
        timestamp: new Date().toISOString(),
        payload: message,
      });

      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(broadcastMsg);
          } catch (err) {
            console.error("❌ Broadcast xato:", err.message);
            clients.delete(client);
          }
        }
      });
    } catch (err) {
      console.error("❌ JSON parse xato:", err.message);
    }
  });
});

/* ------------------------ Heartbeat (server → client) ------------------------ */
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log("💀 Murdalik client tozalanmoqda");
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

/* ------------------------ ICMP ping yordamchi funksiyasi ------------------------ */
/**
 * Xavfsiz ICMP ping (spawn orqali, shell yo‘q).
 *  - Windows: ping -n 1 -w <ms> target
 *  - Unix:    ping -c 1 -W <s>  target
 */
function pingHost(target, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const isWin = os.platform().startsWith("win");
    const args = isWin
      ? ["-n", "1", "-w", String(timeoutMs), target]
      : ["-c", "1", "-W", String(Math.ceil(timeoutMs / 1000)), target];

    const cmd = "ping";
    const started = Date.now();
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs + 500);

    child.on("close", (code) => {
      clearTimeout(killTimer);
      const rtt = Date.now() - started;
      resolve({
        ok: code === 0,
        rtt,
        code,
        stdout,
        stderr,
      });
    });
  });
}

/* ------------------------ Input validatsiya (target) ------------------------ */
/**
 * Ruxsat beramiz:
 *  - IPv4: 0-255.0-255.0-255.0-255 (oddiy tekshiruv)
 *  - Hostname: harf/raqam, nuqta, tire (RFC-ga yaqin), uzunligi cheklangan
 *  - IPv6 (oddiy): : va hex belgilar (qisqa tekshiruv)
 */
function isValidTarget(str) {
  if (typeof str !== "string") return false;
  if (str.length > 255) return false;

  const s = str.trim();

  // IPv4
  const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  if (ipv4.test(s)) return true;

  // IPv6 (soddalashtirilgan)
  const ipv6 = /^[0-9a-fA-F:]+$/;
  if (s.includes(":") && ipv6.test(s)) return true;

  // Hostname (label-ler orasida nuqta, label [a-z0-9-], tire bosh/oxirda bo‘lmasin)
  const hostname =
    /^(?=.{1,253}$)(?!-)([a-zA-Z0-9-]{1,63}(?<!-)\.)*[a-zA-Z0-9-]{1,63}$/;
  if (hostname.test(s)) return true;

  return false;
}

/* ------------------------ HTTP ping endpointlari ------------------------ */
// 1) Soddalashtirilgan server ping
app.get("/ping", (req, res) => {
  res.json({
    pong: true,
    timestamp: new Date().toISOString(),
    clients: clients.size,
    uptime: process.uptime(),
  });
});

// 2) Maqsad host/IP ni ICMP orqali ping qilish:
//    Misollar:
//      GET /ping/host?target=192.168.1.64
//      GET /ping/host?target=example.com
app.get(
  "/ping/host",
  rateLimit({
    windowMs: 60 * 1000,
    max: 30, // bu endpointni alohida cheklab qo'yamiz
  }),
  async (req, res) => {
    try {
      const raw = (req.query.target || "").toString().trim();
      if (!raw) {
        return res
          .status(400)
          .json({
            success: false,
            error: "target kerak, masalan: /ping/host?target=192.168.1.64",
          });
      }

      if (!isValidTarget(raw)) {
        return res
          .status(400)
          .json({ success: false, error: "target noto‘g‘ri formatda" });
      }

      const timeoutMs = Math.min(
        Math.max(Number(req.query.timeoutMs) || 2000, 500),
        10000
      ); // 0.5s–10s
      const result = await pingHost(raw, timeoutMs);

      res.json({
        success: result.ok,
        target: raw,
        rtt_ms: result.rtt,
        exitCode: result.code,
        // stdout/stderr diagnostika uchun foydali bo'lishi mumkin
        stdout: result.stdout,
        stderr: result.stderr,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("🚨 /ping/host xato:", err.message);
      res.status(500).json({ success: false, error: "Server xatoligi" });
    }
  }
);

/* ------------------------ Webhook qabul qilish ------------------------ */
app.post("/webhook", (req, res) => {
  try {
    const eventData = req.body;
    if (!eventData) {
      return res.status(400).json({ success: false, error: "Ma'lumot yo‘q" });
    }

    console.log("📩 Hikvision event:", JSON.stringify(eventData, null, 2));

    const message = JSON.stringify({
      type: "hikvision_event",
      timestamp: new Date().toISOString(),
      data: eventData,
    });

    let sentCount = 0;

    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          sentCount++;
        } catch (err) {
          console.error("❌ Clientga yuborishda xato:", err.message);
          clients.delete(client);
        }
      } else {
        clients.delete(client);
      }
    });

    console.log(`✅ ${sentCount} ta clientga yuborildi`);
    res.json({
      success: true,
      clientCount: sentCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("🚨 Webhook xato:", err.message);
    res.status(500).json({ success: false, error: "Server xatoligi" });
  }
});

/* ------------------------ Sog‘liqni tekshirish ------------------------ */
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    clients: clients.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/* ------------------------ Root ------------------------ */
app.get("/", (req, res) => {
  res.json({
    message: "🔐 Hikvision WebSocket Server",
    endpoints: {
      webhook: "POST /webhook",
      health: "GET /health",
      ping: "GET /ping",
      pingHost: "GET /ping/host?target=<host|ip>&timeoutMs=2000",
    },
    websocket: `ws://localhost:${PORT}`,
  });
});

/* ------------------------ Global error handling ------------------------ */
app.use((err, req, res, next) => {
  console.error("🚨 Global xatolik:", err.stack);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

/* ------------------------ Graceful shutdown ------------------------ */
process.on("SIGINT", () => {
  console.log("\n🛑 Server to‘xtatilmoqda...");

  clearInterval(heartbeat);

  clients.forEach((client) => {
    try {
      client.close(1000, "Server shutdown");
    } catch {}
  });

  server.close(() => {
    console.log("✅ Server o‘chirildi");
    process.exit(0);
  });
});

/* ------------------------ Serverni ishga tushirish ------------------------ */
server.listen(PORT, () => {
  console.log(`🚀 HTTP server: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🏓 Ping: http://localhost:${PORT}/ping`);
  console.log(
    `🎯 Host ping: http://localhost:${PORT}/ping/host?target=example.com`
  );
});
