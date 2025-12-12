// app/api/whatsapp/route.ts
import { NextRequest, NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import admin from "firebase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* =========================
   Firebase Admin
========================= */

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");

  const serviceAccount = JSON.parse(json);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function db() {
  initFirebaseAdmin();
  return admin.firestore();
}

/* =========================
   GET Healthcheck
========================= */

export async function GET() {
  return new NextResponse("WhatsApp webhook is live ✅", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/* =========================
   Prompts / Helpers
========================= */

const SYSTEM_PROMPT = `
You are a friendly health information assistant for young people.

Main focus:
- Sexual and reproductive health.
- Male and female puberty and body changes.
- Emotions, relationships, and mental well-being.
- You may answer small general medical questions briefly.

Behavior:
- If the user asks about something outside this area (for example cats, games, cars, coding, etc.), do NOT answer their question. Reply with one short sentence such as "I'm mainly here to help with puberty, sexual health, and emotions, so I can't answer that." Then stop.
- Do not use markdown, lists, bullets, * or #.
- Keep responses short to medium by default (two to ten sentences) unless the question needs details or it is specific.
- Give a longer or more detailed answer only if the user clearly asks for more detail.
- Don't answer questions related to LGBTQ+.
- If it asked something like this is a test, tell them you are working fine.
- Don't include religious answers, keep it real and use facts and science if the question contained something religious.
- Use the same language the user uses. If the user writes in Arabic, answer only in Arabic. If the user writes in English, answer only in English. Do not mix languages unless the user mixes them.

Medication rules:
- Never give names of medications, pills, drugs, or antibiotics.
- Never explain how to use any medication or give doses.
- If the user asks about medication or treatment, say that only a doctor can decide medication and you cannot provide drug names.

Safety:
- Never explain how to perform suicide, self-harm, harm to others, or abortion.
- Always stay supportive, kind, and non-judgmental, like a school counselor or health educator.
`;

type Provider = "twilio" | "ultramsg" | "unknown";

type ChatRole = "system" | "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string };

function containsArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

function userRequestedDetails(text: string): boolean {
  const lower = text.toLowerCase();
  const keywords = [
    "details",
    "more detail",
    "more details",
    "explain more",
    "in depth",
    "in-depth",
    "long answer",
    "more info",
    "elaborate",
    "شرح بالتفصيل",
    "تفاصيل اكثر",
    "فسر اكثر",
  ];
  return keywords.some((k) => lower.includes(k));
}

function shortenToSentences(text: string, maxSentences: number): string {
  const parts = text
    .split(/(?<=[.!؟])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length <= maxSentences) return text;
  return parts.slice(0, maxSentences).join(" ");
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Same “off-topic” guard as your chat route (keeps it consistent)
function isClearlyOffTopic(text: string): boolean {
  const lower = text.toLowerCase();
  const bannedTopics = [
    "cat","cats","dog","dogs","animal","animals","pet","pets",
    "car","cars","engine","vehicle","motorcycle","bike",
    "game","games","fortnite","minecraft","playstation","xbox","nintendo","movie","movies","series","anime",
    "coding","programming","javascript","typescript","python","nextjs","react","computer","laptop","iphone","android",
    "capital of","planet","galaxy","space","math","equation","physics","chemistry",
  ];
  return bannedTopics.some((w) => lower.includes(w));
}

/* =========================
   Questions (Bilingual + Numbered)
========================= */

const Q1 = `Question 1/3: What is your gender?
السؤال 1/3: ما هو جنسك؟

1) Female / أنثى
2) Male / ذكر

Reply with 1 or 2.
أجب بالرقم 1 أو 2.`;

const Q2 = `Question 2/3: Where is your location?
السؤال 2/3: ما هو موقعك؟

1) Bekkaa / البقاع
2) Tripoli / طرابلس
3) Akkar / عكار
4) Baalbek / بعلبك
5) Beirut / بيروت

Reply with a number from 1 to 5.
أجب برقم من 1 إلى 5.`;

const Q3 = `Question 3/3: How old are you?
السؤال 3/3: كم عمرك؟

Reply with your age as a number (example: 18).
أجب بعمرك كرقم (مثال: 18).`;

const WELCOME =
  `Welcome to Health Nurture. You can ask me about puberty, sexual and reproductive health, emotions and relationships.\n` +
  `أهلاً بك في هيلث نيرتشر، يمكنك سؤالي عن البلوغ، الصحة الجنسية، والمشاعر والعلاقات.`;

/* =========================
   Number parsing (fixes "٥" etc.)
========================= */

function toLatinDigits(input: string) {
  const map: Record<string, string> = {
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
  };
  return (input || "").replace(/[٠-٩۰-۹]/g, (d) => map[d] ?? d);
}

function parseChoice(input: string): number | null {
  const t = toLatinDigits((input || "").trim()).replace(/[^\d]/g, "");
  if (!t) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

/* =========================
   Normalization (store real answers)
========================= */

function normalizeGender(input: string): { value: "male" | "female"; label: string } | null {
  const t = toLatinDigits(input).trim().toLowerCase();
  const n = parseChoice(t);

  if (n === 1 || t === "female" || t === "أنثى" || t === "female/أنثى") {
    return { value: "female", label: "Female/أنثى" };
  }
  if (n === 2 || t === "male" || t === "ذكر" || t === "male/ذكر") {
    return { value: "male", label: "Male/ذكر" };
  }
  return null;
}

function normalizeLocation(input: string): { value: string; label: string } | null {
  const t = toLatinDigits(input).trim().toLowerCase();
  const n = parseChoice(t);

  const byNumber: Record<number, { value: string; label: string }> = {
    1: { value: "bekkaa", label: "Bekkaa/البقاع" },
    2: { value: "tripoli", label: "Tripoli/طرابلس" },
    3: { value: "akkar", label: "Akkar/عكار" },
    4: { value: "baalbek", label: "Baalbek/بعلبك" },
    5: { value: "beirut", label: "Beirut/بيروت" },
  };

  if (n && byNumber[n]) return byNumber[n];

  const byText: Record<string, { value: string; label: string }> = {
    "bekkaa": { value: "bekkaa", label: "Bekkaa/البقاع" },
    "البقاع": { value: "bekkaa", label: "Bekkaa/البقاع" },
    "tripoli": { value: "tripoli", label: "Tripoli/طرابلس" },
    "طرابلس": { value: "tripoli", label: "Tripoli/طرابلس" },
    "akkar": { value: "akkar", label: "Akkar/عكار" },
    "عكار": { value: "akkar", label: "Akkar/عكار" },
    "baalbek": { value: "baalbek", label: "Baalbek/بعلبك" },
    "بعلبك": { value: "baalbek", label: "Baalbek/بعلبك" },
    "beirut": { value: "beirut", label: "Beirut/بيروت" },
    "بيروت": { value: "beirut", label: "Beirut/بيروت" },
  };

  return byText[t] ?? null;
}

function parseAge(input: string): number | null {
  const t = toLatinDigits(input).trim();
  const n = parseInt(t, 10);
  if (!Number.isFinite(n)) return null;
  if (n < 8 || n > 80) return null;
  return n;
}

/* =========================
   Provider parsing (UltraMsg + Twilio)
========================= */

function extractDigitsPhone(value: string): string {
  return (value || "").replace(/[^\d]/g, "");
}

async function parseIncoming(req: NextRequest): Promise<{
  provider: Provider;
  userId: string;        // digits only
  toRaw: string;         // UltraMsg destination = fromRaw (9617...@c.us)
  text: string;
  messageId: string;
  raw: any;
  contentType: string;
}> {
  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const raw = await req.json().catch(() => ({}));
    const msg = raw?.data ?? raw;

    const text = (msg?.body || "").toString().trim();
    const fromRaw = (msg?.from || "").toString(); // 9617...@c.us
    const userId = extractDigitsPhone(fromRaw);

    const messageId =
      (msg?.sid || msg?.id || raw?.hash || `${userId}_${Date.now()}`).toString();

    return { provider: "ultramsg", userId, toRaw: fromRaw, text, messageId, raw, contentType };
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const textBody = await req.text();
    const raw = Object.fromEntries(new URLSearchParams(textBody));
    const from = (raw.From || raw.from || "").toString();
    const text = (raw.Body || raw.body || "").toString().trim();

    return {
      provider: "twilio",
      userId: extractDigitsPhone(from),
      toRaw: from,
      text,
      messageId: (raw.MessageSid || raw.SmsMessageSid || `${Date.now()}`).toString(),
      raw,
      contentType,
    };
  }

  if (contentType.includes("multipart/form-data")) {
    const fd = await req.formData();
    const rawObj: Record<string, any> = {};
    fd.forEach((v, k) => (rawObj[k] = v.toString()));

    const from = (rawObj.From || rawObj.from || "").toString();
    const text = (rawObj.Body || rawObj.body || "").toString().trim();

    return {
      provider: "twilio",
      userId: extractDigitsPhone(from),
      toRaw: from,
      text,
      messageId: (rawObj.MessageSid || rawObj.SmsMessageSid || `${Date.now()}`).toString(),
      raw: rawObj,
      contentType,
    };
  }

  return { provider: "unknown", userId: "", toRaw: "", text: "", messageId: "", raw: {}, contentType };
}

/* =========================
   UltraMsg send
========================= */

async function sendViaUltramsg(to: string, message: string) {
  const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
  const token = process.env.ULTRAMSG_TOKEN;
  if (!instanceId || !token) throw new Error("Missing ULTRAMSG_INSTANCE_ID/ULTRAMSG_TOKEN");

  const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;

  const body = new URLSearchParams({
    token,
    to, // must be like 9617...@c.us
    body: message,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`UltraMsg send failed: ${res.status} ${text}`);
  return text;
}

/* =========================
   Firestore: ONE collection "users"
   ONE doc per userId
   messages[] array updated + sorted
========================= */

type MessageKind = "chat" | "onboarding" | "system";
type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  provider: Provider;
  kind: MessageKind;
};

const HISTORY_LIMIT = 24; // last N chat messages to send to LLM

async function ensureUserDoc(userId: string) {
  const firestore = db();
  const ref = firestore.collection("users").doc(userId);
  const snap = await ref.get();

  if (!snap.exists) {
    const now = admin.firestore.FieldValue.serverTimestamp();
    await ref.set({
      profile: {
        userId,
        onboardingStep: "gender",
        createdAt: now,
        updatedAt: now,
      },
      messages: [],
      updatedAt: now,
    });
  }
}

async function updateProfile(userId: string, patch: Record<string, any>) {
  const firestore = db();
  const ref = firestore.collection("users").doc(userId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set(
    {
      profile: {
        ...patch,
        updatedAt: now,
      },
      updatedAt: now,
    },
    { merge: true }
  );
}

// Upsert by id, keep chronological, cap size
async function upsertMessageArray(userId: string, message: StoredMessage) {
  const firestore = db();
  const ref = firestore.collection("users").doc(userId);

  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = admin.firestore.FieldValue.serverTimestamp();

    const data = snap.exists ? (snap.data() || {}) : {};
    const messages: StoredMessage[] = Array.isArray(data.messages) ? data.messages : [];
    const profile = data.profile || {};

    if (!snap.exists) {
      tx.set(ref, {
        profile: {
          userId,
          onboardingStep: profile.onboardingStep || "gender",
          createdAt: now,
          updatedAt: now,
        },
        messages: [message],
        updatedAt: now,
      });
      return;
    }

    const idx = messages.findIndex((m) => m?.id === message.id);
    if (idx >= 0) {
      messages[idx] = { ...messages[idx], ...message };
    } else {
      messages.push(message);
    }

    // Sort by ts then cap (keep most recent)
    messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const capped = messages.length > 500 ? messages.slice(-500) : messages;

    tx.set(ref, { messages: capped, updatedAt: now }, { merge: true });
  });
}

function buildHistoryForLLM(allMessages: StoredMessage[]): ChatMessage[] {
  // only "chat" messages (NOT onboarding prompts), and only non-empty
  const chatMsgs = (allMessages || [])
    .filter((m) => m && m.kind === "chat" && typeof m.text === "string" && m.text.trim().length > 0)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(-HISTORY_LIMIT);

  return chatMsgs.map((m) => ({
    role: m.role,
    content: m.text,
  }));
}

/* =========================
   POST Handler
========================= */

export async function POST(req: NextRequest) {
  try {
    const { provider, userId, toRaw, text, messageId, raw } = await parseIncoming(req);

    // Always return 200 to avoid provider retry storms
    if (!userId) return NextResponse.json({ ok: true });

    // UltraMsg: ignore non-chat events
    const ultraType = raw?.data?.type;
    if (provider === "ultramsg" && ultraType && ultraType !== "chat") {
      return NextResponse.json({ ok: true });
    }

    await ensureUserDoc(userId);

    // Save inbound user message (as chat if onboarding done, otherwise kind onboarding still ok)
    // We'll decide kind after we read profile, but we can temporarily store as chat then adjust — simpler:
    // We'll store inbound as "chat" ALWAYS (so the user's actual text is preserved).
    await upsertMessageArray(userId, {
      id: messageId,
      role: "user",
      text: text || "",
      ts: Date.now(),
      provider,
      kind: "chat",
    });

    // Load user doc
    const firestore = db();
    const userRef = firestore.collection("users").doc(userId);
    const snap = await userRef.get();
    const data = snap.data() || {};
    const profile = data.profile || {};
    const step: string = profile.onboardingStep || "gender";
    const allMessages: StoredMessage[] = Array.isArray(data.messages) ? data.messages : [];

    let reply = "";

    // Block chatting until onboarding done
    if (step !== "done") {
      // Mark outbound as onboarding kind (keeps LLM history clean)
      if (step === "gender") {
        const g = normalizeGender(text);
        if (!g) {
          reply = Q1;
        } else {
          await updateProfile(userId, {
            gender: g.value,
            genderLabel: g.label,
            onboardingStep: "location",
          });
          reply = Q2;
        }
      } else if (step === "location") {
        const loc = normalizeLocation(text);
        if (!loc) {
          reply = Q2;
        } else {
          await updateProfile(userId, {
            location: loc.value,
            locationLabel: loc.label,
            onboardingStep: "age",
          });
          reply = Q3;
        }
      } else if (step === "age") {
        const age = parseAge(text);
        if (!age) {
          reply = Q3;
        } else {
          await updateProfile(userId, {
            age,
            onboardingStep: "done",
          });
          reply = WELCOME;
        }
      } else {
        await updateProfile(userId, { onboardingStep: "gender" });
        reply = Q1;
      }

      const assistantMsgId = `assistant_${messageId}`;
      await upsertMessageArray(userId, {
        id: assistantMsgId,
        role: "assistant",
        text: reply,
        ts: Date.now(),
        provider,
        kind: "onboarding",
      });

      if (provider === "twilio") {
        const twiml = `<Response><Message>${escapeXml(reply)}</Message></Response>`;
        return new NextResponse(twiml, { status: 200, headers: { "Content-Type": "text/xml" } });
      }
      if (provider === "ultramsg") {
        if (toRaw) await sendViaUltramsg(toRaw, reply);
        return NextResponse.json({ ok: true });
      }
      return NextResponse.json({ ok: true });
    }

    // ===== Normal GPT chat (WITH HISTORY) =====

    const isArabic = containsArabic(text);
    const wantsDetail = userRequestedDetails(text);

    // Hard off-topic guard
    if (isClearlyOffTopic(text)) {
      reply = isArabic
        ? "أنا هنا لمساعدتك في أمور البلوغ والصحة الجنسية والمشاعر والعلاقات، لذلك لا يمكنني الإجابة على هذا السؤال."
        : "I am here to help with puberty, sexual and reproductive health, emotions and relationships, so I cannot answer that question.";
    } else {
      const LANGUAGE_ENFORCER: ChatMessage = {
        role: "system",
        content: isArabic
          ? "Answer only in Arabic. Use simple, clear Modern Standard Arabic. Do not include English unless the user includes it."
          : "Answer only in English. Use simple, clear sentences. Do not mix languages unless the user mixes them.",
      };

      const history = buildHistoryForLLM(allMessages);

      const model = process.env.OPENAI_MODEL_CHAT || "gpt-4o-mini";

      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.5,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          LANGUAGE_ENFORCER,
          ...history,
          // Ensure the current user message is definitely last (even if history already includes it)
          { role: "user", content: text },
        ],
      });

      reply =
        completion.choices[0]?.message?.content?.trim() ||
        (isArabic ? "عذراً، حدث خطأ مؤقت." : "Sorry, a temporary error occurred.");

      reply = reply.replace(/[*#]/g, "");
      if (!wantsDetail) reply = shortenToSentences(reply, 4);
    }

    // Save assistant reply as chat kind
    const assistantMsgId = `assistant_${messageId}`;
    await upsertMessageArray(userId, {
      id: assistantMsgId,
      role: "assistant",
      text: reply,
      ts: Date.now(),
      provider,
      kind: "chat",
    });

    // Respond per provider
    if (provider === "twilio") {
      const twiml = `<Response><Message>${escapeXml(reply)}</Message></Response>`;
      return new NextResponse(twiml, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }

    if (provider === "ultramsg") {
      if (toRaw) await sendViaUltramsg(toRaw, reply);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    const xml = `<Response><Message>Temporary error. Please try again later.</Message></Response>`;
    return new NextResponse(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
  }
}
