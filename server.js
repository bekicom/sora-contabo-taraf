import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";

const app = express();
const server = createServer(app);

// Middleware
app.use(express.json({ limit: "10mb" })); // bodyParser.json() o'rniga
app.use(express.urlencoded({ extended: true }));

// CORS sozlamalari (agar kerak bo'lsa)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// 🔹 WebSocket serverni HTTP server bilan birlashtirib ishlatish
const wss = new WebSocketServer({ server });

// Clientlar uchun Set ishlatish (array o'rniga)
const clients = new Set();

// WebSocket ulanish
wss.on("connection", (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`✅ Yangi client ulandi: ${clientIP}`);

  clients.add(ws);
  console.log(`👥 Jami clientlar soni: ${clients.size}`);

  // Ping/Pong heartbeat
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // Client uzilgan paytda
  ws.on("close", (code, reason) => {
    console.log(
      `❌ Client uzildi: ${clientIP}, Code: ${code}, Reason: ${reason}`
    );
    clients.delete(ws);
    console.log(`👥 Qolgan clientlar: ${clients.size}`);
  });

  // Xatoliklarni handle qilish
  ws.on("error", (error) => {
    console.error(`🚨 WebSocket xatoligi: ${error.message}`);
    clients.delete(ws);
  });

  // Client message qabul qilish (agar kerak bo'lsa)
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      console.log("📨 Clientdan kelgan message:", message);
    } catch (error) {
      console.error("❌ JSON parse xatoligi:", error.message);
    }
  });
});

// 🔹 Heartbeat - uzilgan connectionlarni tozalash
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log("💀 Dead connection tozalanmoqda");
      clients.delete(ws);
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000); // Har 30 soniyada

// 🔹 Hikvision webhook
app.post("/webhook", (req, res) => {
  try {
    const eventData = req.body;

    // Ma'lumot validatsiyasi
    if (!eventData) {
      return res.status(400).json({
        success: false,
        error: "Ma'lumot topilmadi",
      });
    }

    console.log("📩 Hikvision event:", JSON.stringify(eventData, null, 2));

    // Clientlar sonini tekshirish
    if (clients.size === 0) {
      console.log("⚠️ Hech qanday client ulanmagan");
      return res.json({
        success: true,
        message: "Event qabul qilindi, lekin clientlar yo'q",
        clientCount: 0,
      });
    }

    // Faqat ochiq connectionlarga yuborish
    let sentCount = 0;
    const message = JSON.stringify({
      type: "hikvision_event",
      timestamp: new Date().toISOString(),
      data: eventData,
    });

    clients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        try {
          client.send(message);
          sentCount++;
        } catch (error) {
          console.error("❌ Clientga yuborishda xatolik:", error.message);
          clients.delete(client);
        }
      } else {
        // Yopilgan connectionlarni tozalash
        clients.delete(client);
      }
    });

    console.log(`✅ ${sentCount} ta clientga yuborildi`);

    res.json({
      success: true,
      clientCount: sentCount,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("🚨 Webhook xatoligi:", error.message);
    res.status(500).json({
      success: false,
      error: "Server xatoligi",
    });
  }
});

// 🔹 Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    clients: clients.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// 🔹 Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "Hikvision WebSocket Server",
    endpoints: {
      webhook: "POST /webhook",
      health: "GET /health",
    },
    websocket: "ws://localhost:PORT",
  });
});

// 🔹 Error handling middleware
app.use((err, req, res, next) => {
  console.error("🚨 Server xatoligi:", err.stack);
  res.status(500).json({
    success: false,
    error: "Internal Server Error",
  });
});

// 🔹 Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Server to'xtatilmoqda...");

  clearInterval(heartbeat);

  // Barcha clientlarni yopish
  clients.forEach((client) => {
    client.close(1000, "Server shutdown");
  });

  server.close(() => {
    console.log("✅ Server muvaffaqiyatli to'xtatildi");
    process.exit(0);
  });
});

// 🔹 Serverni ishga tushirish
const PORT = process.env.PORT || 8050;
server.listen(PORT, () => {
  console.log(`🚀 Server ${PORT}-portda ishlayapti`);
  console.log(`🔗 HTTP: http://localhost:${PORT}`);
  console.log(`🔗 WebSocket: ws://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
