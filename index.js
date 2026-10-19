const fs = require("fs");
const path = require("path");
const { Zalo, ThreadType } = require("zca-js");

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const ZALO_CREDS_PATH = path.join(__dirname, "zalo-credentials.json");
const FIREBASE_CREDS_PATH = path.join(__dirname, "firebase-credentials.json");
const COLLECTION = "van_ban";

const GROUP_FILE = path.join(__dirname, "danh_sach_202_nhom.txt");
const SKIP_FILE = path.join(__dirname, "bo_qua_nhom.txt");
const GROUP_MAP = new Map();
const SKIPPED_GROUPS = new Set();
const SKIP_SET = new Set();

const TELEGRAM_BOT_TOKEN = "8909257392:AAG9kRxzryLLepvGDMKs_u44dnPY7hEm1lY";
const TELEGRAM_CHAT_ID = "928852403";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const serviceAccount = JSON.parse(fs.readFileSync(FIREBASE_CREDS_PATH, "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
console.log(`✅ Firebase OK (${serviceAccount.project_id})`);

const zalo = new Zalo();

function getText(data = {}) {
  const raw = data.content ?? data.msg ?? "";
  if (typeof raw === "object") {
    const r = raw.title || raw.description || raw.text || raw.name;
    return r ? String(r).trim() : "[Tin nhắn có tệp đính kèm]";
  }
  const text = String(raw).trim();
  return text || "[Tin nhắn có tệp đính kèm]";
}

function getGroupName(message) {
  const d = message.data || {};
  return d.threadName || d.groupName || message.threadName || String(message.threadId);
}

function parseGroupLine(line) {
  const clean = line.replace(/#.*$/, "").trim();
  if (!clean) return null;
  const parts = clean.split("|").map((s) => s.trim());
  const ten = parts[0] || "";
  const threadId = (parts[1] || "").replace(/\D/g, "");
  const mem = parts[2] || "";
  const chatId = parts[3] || "";
  if (!threadId) return null;
  return { threadId, ten, mem, chatId };
}

function loadGroupMap() {
  if (!fs.existsSync(GROUP_FILE)) {
    console.log(`⚠️ Chưa có ${path.basename(GROUP_FILE)}`);
    return;
  }
  try {
    GROUP_MAP.clear();
    const lines = fs.readFileSync(GROUP_FILE, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const row = parseGroupLine(line);
      if (!row) continue;
      GROUP_MAP.set(row.threadId, {
        chatId: row.chatId,
        ten: row.ten || row.threadId,
        mem: row.mem,
      });
    }
    console.log(`📋 ${path.basename(GROUP_FILE)}: ${GROUP_MAP.size} nhóm`);
  } catch (e) {
    console.error(`❌ ${path.basename(GROUP_FILE)}:`, e.message);
  }
}

function watchGroupFile() {
  loadGroupMap();
  fs.watchFile(GROUP_FILE, { interval: 5000 }, () => loadGroupMap());
}

function loadSkipSet() {
  if (!fs.existsSync(SKIP_FILE)) return;
  try {
    SKIP_SET.clear();
    const lines = fs.readFileSync(SKIP_FILE, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const id = line.replace(/#.*$/, "").trim().replace(/\D/g, "");
      if (id) SKIP_SET.add(id);
    }
    console.log(`🚫 ${path.basename(SKIP_FILE)}: ${SKIP_SET.size} nhóm`);
  } catch (e) {
    console.error(`❌ ${path.basename(SKIP_FILE)}:`, e.message);
  }
}

function watchSkipFile() {
  loadSkipSet();
  fs.watchFile(SKIP_FILE, { interval: 5000 }, () => loadSkipSet());
}

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.startsWith("DAN_") || !chatId) return;
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const raw = await res.text();
      console.error("❌ Telegram:", res.status, raw.slice(0, 200));
    }
  } catch (e) {
    console.error("❌ Telegram:", e.message);
  }
}

async function save(message) {
  const data = message.data || {};
  const threadId = String(message.threadId ?? "");
  const isGroup = message.type === ThreadType.Group;
  const text = getText(data);
  const sender = data.dName || data.senderName || data.displayName || data.uidFrom || "Không rõ";
  const group = getGroupName(message);
  const ts = data.ts ? new Date(Number(data.ts)) : new Date();

  if (isGroup && SKIP_SET.has(threadId)) {
    if (!SKIPPED_GROUPS.has(threadId)) {
      SKIPPED_GROUPS.add(threadId);
      console.log(`🚫 Bỏ qua nhóm ${threadId} (${path.basename(SKIP_FILE)})`);
    }
    return;
  }

  const dest = GROUP_MAP.get(threadId);

  if (isGroup && !dest) {
    if (!SKIPPED_GROUPS.has(threadId)) {
      SKIPPED_GROUPS.add(threadId);
      console.log(`⏭️ Bỏ qua nhóm lạ ${threadId} (${group}) — không có trong ${path.basename(GROUP_FILE)}`);
    }
    return;
  }

  const doc = {
    loai: "ALL",
    noi_dung: text,
    tin_goc: text,
    nguoi_gui: sender,
    nguoi_ky: sender,
    threadId,
    threadName: dest?.ten || group,
    loai_hoi: isGroup ? "GROUP" : "DM",
    created_at: FieldValue.serverTimestamp(),
    gio_gui: ts.toISOString(),
  };

  try {
    await db.collection(COLLECTION).add(doc);
    console.log(
      `[${ts.toLocaleTimeString("vi-VN")}] ${isGroup ? "NHÓM" : "DM"} ${doc.threadName} | ${sender}: ${text.slice(0, 80)}`
    );
    const header = isGroup ? `👥 ${doc.threadName}` : `💬 ${sender}`;
    await sendTelegram(dest?.chatId || TELEGRAM_CHAT_ID, `${header}\n👤 ${sender}\n\n${text}`);
  } catch (e) {
    console.error("❌ Firebase:", e.message);
  }
}

async function main() {
  const api = fs.existsSync(ZALO_CREDS_PATH)
    ? await zalo.login(JSON.parse(fs.readFileSync(ZALO_CREDS_PATH, "utf8")))
    : await zalo.loginQR();

  if (!fs.existsSync(ZALO_CREDS_PATH)) {
    fs.writeFileSync(ZALO_CREDS_PATH, JSON.stringify(api.getContext(), null, 2));
    console.log("💾 Đã lưu phiên đăng nhập Zalo");
  }

  // Tự lưu phiên Zalo mới nhất để không phải quét QR lại lần nào nữa
  function saveContext(reason) {
    try {
      fs.writeFileSync(ZALO_CREDS_PATH, JSON.stringify(api.getContext(), null, 2));
      console.log(`💾 Đã cập nhật phiên Zalo (${reason})`);
    } catch (e) {
      console.error("❌ Lưu phiên Zalo:", e.message);
    }
  }
  setInterval(() => saveContext("định kỳ 30 phút"), 30 * 60 * 1000);

  console.log("✅ Đã đăng nhập! Đang lắng nghe MỌI nhóm + tin nhắn riêng...");

  watchGroupFile();
  watchSkipFile();

  api.listener.on("connected", () => { saveContext("kết nối mới"); console.log("🔌 Kết nối Zalo đã mở"); });
  api.listener.on("disconnected", (code, reason) => console.log(`⚠️ Mất kết nối Zalo (${code}) ${reason || ""}`));
  api.listener.on("closed", (code, reason) => console.log(`⚠️ Kết nối Zalo đã đóng (${code}) ${reason || ""}`));
  api.listener.on("error", (e) => console.error("❌ Listener:", e?.message || e));

  api.listener.on("message", async (message) => {
    try {
      if (message.isSelf) return;
      await save(message);
    } catch (e) {
      console.error("❌ Xử lý tin nhắn:", e.message);
    }
  });

  api.listener.start();
  console.log("🚀 Đang chạy. Mọi tin nhắn mới sẽ lên Firestore và hiện trên Dashboard.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
