const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const axios = require('axios');
const moment = require('moment');

// ==========================================
// 1. CONFIGURATION
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN || '8889433297:AAHOsY7hJdm2otvMb08nWgZ1LbKnkQPoOsQ';
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '6806297257');
const API_URL = "https://draw.ar-lottery01.com/WinGo/";
const REQUIRED_CHANNEL = '@Wingo30sec_joel'; // Apnar official channel

// ==========================================
// 2. FIREBASE SETUP
// ==========================================
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    serviceAccount = require('./firebase-key.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || "https://gen-lang-client-0567997904-default-rtdb.firebaseio.com"
});
const db = admin.database();

// ==========================================
// 3. BOT INITIALIZATION
// ==========================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userStates = {};

// ==========================================
// 4. PREDICTION ENGINE (WIN GO 30S)
// ==========================================
function safeNums(list) {
    return (Array.isArray(list) ? list : []).map(x => parseInt(x?.number, 10)).filter(n => Number.isInteger(n) && n >= 0 && n <= 9);
}
function softmaxScores(a) {
    const e = a.map(v => Math.exp(Math.max(-20, Math.min(20, v))));
    const s = e.reduce((x, y) => x + y, 0) || 1;
    return e.map(v => v / s);
}
function argMax(a) {
    let k = 0;
    for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i;
    return k;
}
function lastRun(a) {
    if (!a.length) return { value: null, len: 0 };
    let len = 1;
    while (len < a.length && a[len] === a[0]) len++;
    return { value: a[0], len };
}
function getEngineColor(n) {
    if (n === 0 || n === 5) return 'VIOLET';
    return n % 2 === 0 ? 'RED' : 'GREEN';
}
function engineSize(n) { return n >= 5 ? 'Big' : 'Small'; }

function bypassEngine(list) {
    const nums = safeNums(list).slice(0, 120);
    if (nums.length < 5) return { size: 'Big', color: 'GREEN', number: 7, confidence: 88 };

    const recent = nums.slice(0, 30);
    const freq = Array(10).fill(0);
    const global = Array(10).fill(0);

    recent.forEach((n, i) => { freq[n] += Math.max(0.25, 1 - i / Math.max(30, recent.length)); });
    nums.forEach(n => global[n]++);

    const trans = Array.from({ length: 10 }, () => Array(10).fill(0));
    for (let i = 0; i < nums.length - 1; i++) trans[nums[i + 1]][nums[i]]++;
    const last = nums[0];
    const nextByLast = Array(10).fill(0);
    for (let n = 0; n < 10; n++) nextByLast[n] = trans[n][last] || 0;

    const gap = Array(10).fill(nums.length);
    for (let i = 0; i < nums.length; i++) { if (gap[nums[i]] === nums.length) gap[nums[i]] = i; }
    const maxGap = Math.max(...gap, 1);

    const big = recent.filter(n => n >= 5).length;
    const bigPct = big / (recent.length || 1);
    const smallPct = 1 - bigPct;

    const st = { Big: { Big: 0, Small: 0 }, Small: { Big: 0, Small: 0 } };
    for (let i = 0; i < nums.length - 1; i++) {
        const a = engineSize(nums[i]), b = engineSize(nums[i + 1]);
        st[b][a]++;
    }

    const lastSize = engineSize(last);
    const bigTrans = ((st.Big[lastSize] || 0) + 1) / ((st.Big[lastSize] || 0) + (st.Small[lastSize] || 0) + 2);
    const smallTrans = ((st.Small[lastSize] || 0) + 1) / ((st.Big[lastSize] || 0) + (st.Small[lastSize] || 0) + 2);

    const run = lastRun(nums);
    const sizeScore = {
        Big: 0.45 * bigPct + 0.25 * bigTrans + 0.30 * (run.len >= 3 ? (lastSize === 'Big' ? 0.35 : 0.65) : 0.5),
        Small: 0.45 * smallPct + 0.25 * smallTrans + 0.30 * (run.len >= 3 ? (lastSize === 'Small' ? 0.35 : 0.65) : 0.5)
    };

    const sp = softmaxScores([sizeScore.Big, sizeScore.Small]);
    const size = sp[0] >= sp[1] ? 'Big' : 'Small';
    const sizeConf = Math.round(Math.max(sp[0], sp[1]) * 100);

    const totalF = freq.reduce((a, b) => a + b, 0) || 1;
    const totalT = nextByLast.reduce((a, b) => a + b, 0) || 1;
    const score = Array(10).fill(0);

    for (let n = 0; n < 10; n++) {
        const f = freq[n] / totalF;
        const g = global[n] / (nums.length || 1);
        const t = nextByLast[n] / totalT;
        const gapScore = gap[n] / maxGap;
        score[n] = 0.42 * f + 0.30 * t + 0.18 * g + 0.10 * gapScore;
        if (engineSize(n) !== size) score[n] *= 0.82;
    }

    const np = softmaxScores(score);
    const number = argMax(np);
    const sorted = [...np].sort((a, b) => b - a);
    const numConf = Math.round(sorted[0] * 100);

    const cp = { RED: 0, GREEN: 0, VIOLET: 0 };
    np.forEach((p, n) => cp[getEngineColor(n)] += p);
    const colors = Object.entries(cp).sort((a, b) => b[1] - a[1]);
    const color = colors[0][0];
    const colorConf = Math.round(colors[0][1] * 100);

    let confidence = Math.round(sizeConf * 0.30 + numConf * 0.35 + colorConf * 0.20 + 15);
    confidence = Math.max(82, Math.min(99, confidence));

    return { size, color, number, confidence };
}

// ==========================================
// 5. SUBSCRIPTION CHECKER
// ==========================================
async function checkSubscription(userId) {
    try {
        const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) {
        return false;
    }
}

// ==========================================
// 6. ADMIN COMMANDS
// ==========================================
bot.onText(/\/genkey (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId !== ADMIN_ID) return bot.sendMessage(chatId, "⛔️ Unauthorized! Only Admin can generate keys.");

    const days = parseInt(match[1]);
    const key = 'VIP-' + Math.random().toString(36).substring(2, 8).toUpperCase() + `-${days}D`;
    
    await db.ref('vip_keys/' + key).set({
        days: days,
        used: false,
        createdAt: Date.now()
    });

    bot.sendMessage(chatId, `✅ **New VIP Key Generated**\n\n🔑 Key: \`${key}\`\n⏳ Validity: ${days} Days`, {parse_mode: "Markdown"});
});

// ==========================================
// 7. USER START & AUTH
// ==========================================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    const isSubscribed = await checkSubscription(chatId);
    if (!isSubscribed) {
        return bot.sendMessage(chatId, `📢 **Channel Join Required!**\n\nPlease join our official channel first to unlock signals:\n👉 https://t.me/Wingo30sec_joel\n\nAfter joining, send /start again.`, {parse_mode: "Markdown"});
    }

    const userRef = db.ref('users/' + chatId);
    const snapshot = await userRef.once('value');
    
    if (snapshot.exists() && snapshot.val().expiry > Date.now()) {
        return sendMainMenu(chatId);
    } else {
        bot.sendMessage(chatId, "👋 Welcome to **Predictor Pro VIP (WinGo 30s)**!\n\n🔒 Please enter your **VIP Secret Key**:", {parse_mode: "Markdown"});
        userStates[chatId] = 'WAITING_FOR_KEY';
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';

    if (userStates[chatId] === 'WAITING_FOR_KEY' && !text.startsWith('/')) {
        const keyRef = db.ref('vip_keys/' + text);
        const keySnap = await keyRef.once('value');

        if (keySnap.exists() && !keySnap.val().used) {
            const days = keySnap.val().days;
            const expiry = Date.now() + (days * 24 * 60 * 60 * 1000);
            
            await keyRef.update({ used: true, usedBy: chatId });
            await db.ref('users/' + chatId).set({
                joinedAt: Date.now(),
                expiry: expiry,
                game: 30,
                mode: 'ALL'
            });

            delete userStates[chatId];
            bot.sendMessage(chatId, `🎉 **VIP Activated Successfully!**\n\nValid until: ${moment(expiry).format('DD MMM YYYY, hh:mm A')}`, {parse_mode: "Markdown"});
            sendMainMenu(chatId);
        } else {
            bot.sendMessage(chatId, "❌ Invalid or already used Secret Key. Try again.");
        }
    }
});

// ==========================================
// 8. MENU & MODE SELECTION
// ==========================================
function sendMainMenu(chatId) {
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🎯 Mode: Color + Big/Small (ALL)", callback_data: "setmode_ALL" }],
                [{ text: "🔴 Mode: Only Color", callback_data: "setmode_COL" }, { text: "📊 Mode: Only Big/Small", callback_data: "setmode_BS" }],
                [{ text: "👤 My VIP Profile", callback_data: "profile" }]
            ]
        }
    };
    bot.sendMessage(chatId, "⚙️ **WIN GO 30S VIP CONTROL PANEL**\n\nChoose your preferred prediction mode below. Signals will be sent automatically 6 seconds before every draw.", {parse_mode: "Markdown", ...options});
}

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const action = query.data;

    const snap = await db.ref('users/' + chatId).once('value');
    if (!snap.exists() || snap.val().expiry < Date.now()) {
        return bot.answerCallbackQuery(query.id, { text: "⚠️ Subscription expired. Send /start", show_alert: true });
    }

    if (action.startsWith('setmode_')) {
        const mode = action.split('_')[1];
        await db.ref('users/' + chatId).update({ mode: mode });
        bot.answerCallbackQuery(query.id, { text: `✅ Mode updated to ${mode}` });
    } else if (action === 'profile') {
        const u = snap.val();
        bot.sendMessage(chatId, `👤 **VIP PROFILE**\n\n⏱ Game: WinGo 30s\n🎯 Mode: ${u.mode}\n⏳ Expiry: ${moment(u.expiry).format('DD MMM, hh:mm A')}`, {parse_mode: "Markdown"});
        bot.answerCallbackQuery(query.id);
    }
});

// ==========================================
// 9. 30S ENGINE & RESULT TRACKING
// ==========================================
let lastPeriod30 = null;
let fetching30 = false;
let activeSignals = {};

async function checkAndSendSignals() {
    if (fetching30) return;
    fetching30 = true;
    try {
        const url = `${API_URL}WinGo_30S/GetHistoryIssuePage.json?t=${Date.now()}`;
        const res = await axios.get(url);
        
        if (res.data && res.data.data && res.data.data.list) {
            const list = res.data.data.list;
            const latestIssue = String(list[0].issueNumber);
            const actualNumber = parseInt(list[0].number, 10);
            const actualSize = actualNumber >= 5 ? 'Big' : 'Small';
            const actualColor = getEngineColor(actualNumber);

            // Result Checking & Win/Loss/Jackpot Update
            if (activeSignals[latestIssue]) {
                const sig = activeSignals[latestIssue];
                let resultText = "❌ LOSS";
                
                if (sig.predNumber === actualNumber) {
                    resultText = "🔥 JACKPOT (Exact Number Match!) 🔥";
                } else if (sig.predSize === actualSize || sig.predColor === actualColor) {
                    resultText = "✅ WIN 🟢";
                }

                const resultMsg = `📊 **RESULT UPDATE - Period: \`${latestIssue}\`**\n━━━━━━━━━━━━━━━━━━\n🎲 **Winning Number:** ${actualNumber} (${actualSize} | ${actualColor})\n🎯 **Outcome:** ${resultText}\n━━━━━━━━━━━━━━━━━━`;
                
                sig.users.forEach(uid => {
                    bot.sendMessage(uid, resultMsg, {parse_mode: "Markdown"});
                });

                delete activeSignals[latestIssue];
            }

            // Next Prediction
            const nextPeriod = String(BigInt(latestIssue) + 1n);
            if (lastPeriod30 !== nextPeriod) {
                lastPeriod30 = nextPeriod;
                const prediction = bypassEngine(list);
                
                activeSignals[nextPeriod] = {
                    predSize: prediction.size,
                    predColor: prediction.color,
                    predNumber: prediction.number,
                    users: []
                };

                const usersSnap = await db.ref('users').once('value');
                const users = usersSnap.val();
                
                if (users) {
                    Object.keys(users).forEach(uid => {
                        const u = users[uid];
                        if (u.expiry > Date.now()) {
                            activeSignals[nextPeriod].users.push(uid);

                            let target = "";
                            let emoji = prediction.color === 'RED' ? '🔴' : prediction.color === 'GREEN' ? '🟢' : '🟣';
                            
                            if (u.mode === 'BS') target = `🔮 **Target:** ${prediction.size}`;
                            else if (u.mode === 'COL') target = `🔮 **Target:** ${emoji} ${prediction.color}`;
                            else target = `🔮 **Target:** ${prediction.size} | ${emoji} ${prediction.color} (N${prediction.number})`;

                            const msg = `🎰 **WIN GO 30s - LIVE SIGNAL** 🎰\n━━━━━━━━━━━━━━━━━━\n📌 **Period:** \`${nextPeriod}\`\n${target}\n📊 **Confidence:** ${prediction.confidence}%\n💰 **Multiplier:** BET 1X\n━━━━━━━━━━━━━━━━━━\n⚡️ *Predictor Pro VIP*`;
                            
                            bot.sendMessage(uid, msg, {parse_mode: "Markdown"});
                        }
                    });
                }
            }
        }
    } catch (e) {
        console.error("[Error] 30s fetch failed:", e.message);
    }
    fetching30 = false;
}

setInterval(() => {
    const now = new Date();
    const pass = now.getSeconds() % 30;
    const remaining = 30 - pass;

    if (remaining === 6) {
        checkAndSendSignals();
    }
}, 1000);

console.log("🚀 WinGo 30s VIP Bot with Channel Sub & Result Tracker is Running...");