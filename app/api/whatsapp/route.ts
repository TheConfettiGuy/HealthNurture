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
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // required for TEMP upload
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
  return new NextResponse("WhatsApp webhook is live ✅ (UltraMsg)", {
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
- If the user asks about something outside this area (for example cats, games, cars, coding, etc.), do NOT answer their question.
  Reply with one short sentence such as "I'm mainly here to help with puberty, sexual health, and emotions, so I can't answer that." Then stop.
- HOWEVER: normal greetings and small talk like "hi", "hello", "how are you" are allowed. Reply politely then guide them back to allowed topics.
- Do not use markdown, lists, bullets, * or #.
- Keep responses short to medium by default unless the user clearly asks for more detail.
- Don't answer questions related to LGBTQ+.
- If asked "this is a test" say you are working fine.
- No religious answers; use facts and science.
- Use the same language the user uses. Do not mix languages unless the user mixes them.

Medication rules:
- Never give names of medications, pills, drugs, or antibiotics.
- Never explain how to use any medication or give doses.
- If the user asks about medication or treatment, say that only a doctor can decide medication and you cannot provide drug names.

Safety:
- Never explain how to perform suicide, self-harm, harm to others, or abortion.
- Always stay supportive, kind, and non-judgmental, like a school counselor or health educator.
`;

type Provider = "ultramsg";

function containsArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text || "");
}

function userRequestedDetails(text: string): boolean {
  const lower = (text || "").toLowerCase();
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
  const parts = (text || "")
    .split(/(?<=[.!؟])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length <= maxSentences) return text;
  return parts.slice(0, maxSentences).join(" ");
}

function isGreeting(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;

  const greetings = [
    "hi", "hello", "hey", "how are you", "how r u", "hru", "good morning", "good evening",
    "مرحبا", "مرحباً", "اهلا", "أهلا", "هلا", "هاي", "كيفك", "كيف حالك", "شو الأخبار", "صباح الخير", "مساء الخير",
  ];

  return greetings.some((g) => t === g || t.includes(g));
}

function greetingReply(isArabic: boolean): string {
  return isArabic
    ? "أهلاً! أنا تمام. كيف فيني ساعدك اليوم؟ اسألني عن البلوغ، الصحة الجنسية والإنجابية، أو المشاعر والعلاقات."
    : "Hey! I’m doing well — thanks for asking. How can I help you today? You can ask me about puberty, sexual and reproductive health, emotions, or relationships.";
}

/* =========================
   Onboarding Questions (Bilingual + Numbered)
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
   Number parsing (Arabic digits)
========================= */

function toLatinDigits(input: string) {
  const map: Record<string, string> = {
    "٠": "0","١": "1","٢": "2","٣": "3","٤": "4","٥": "5","٦": "6","٧": "7","٨": "8","٩": "9",
    "۰": "0","۱": "1","۲": "2","۳": "3","۴": "4","۵": "5","۶": "6","۷": "7","۸": "8","۹": "9",
  };
  return (input || "").replace(/[٠-٩۰-۹]/g, (d) => map[d] ?? d);
}

function parseChoice(input: string): number | null {
  const t = toLatinDigits((input || "").trim()).replace(/[^\d]/g, "");
  if (!t) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeGender(input: string): { value: "male" | "female"; label: string } | null {
  const t = toLatinDigits(input).trim().toLowerCase();
  const n = parseChoice(t);

  if (n === 1 || t === "female" || t === "أنثى") return { value: "female", label: "Female/أنثى" };
  if (n === 2 || t === "male" || t === "ذكر") return { value: "male", label: "Male/ذكر" };
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
    "bekkaa": byNumber[1], "البقاع": byNumber[1],
    "tripoli": byNumber[2], "طرابلس": byNumber[2],
    "akkar": byNumber[3], "عكار": byNumber[3],
    "baalbek": byNumber[4], "بعلبك": byNumber[4],
    "beirut": byNumber[5], "بيروت": byNumber[5],
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
   UltraMsg: parse webhook payload
========================= */

function extractDigitsPhone(value: string): string {
  return (value || "").replace(/[^\d]/g, "");
}

async function parseUltraMsgIncoming(req: NextRequest): Promise<{
  provider: Provider;
  userId: string;        // digits only (doc id)
  toRaw: string;         // 9617...@c.us
  text: string;
  messageId: string;
  raw: any;
  hasVoice: boolean;
  voiceUrl?: string;
}> {
  const raw = await req.json().catch(() => ({}));

  // UltraMsg commonly: { event_type, data: {...} }
  const data = raw?.data ?? raw;

  const text = (data?.body || "").toString().trim();
  const fromRaw = (data?.from || "").toString(); // 9617...@c.us
  const userId = extractDigitsPhone(fromRaw);

  const messageId =
    (data?.sid || data?.id || raw?.hash || `${userId}_${Date.now()}`).toString();

  // Voice notes: UltraMsg varies by plan/settings.
  // Try common patterns:
  const type = (data?.type || "").toString().toLowerCase(); // "chat", "audio", "ptt", "voice"
  const voiceUrl =
    (data?.media || data?.mediaUrl || data?.url || raw?.media || raw?.mediaUrl) as string | undefined;

  const hasVoice = Boolean(voiceUrl) || ["audio", "voice", "ptt"].includes(type);

  return {
    provider: "ultramsg",
    userId,
    toRaw: fromRaw,
    text,
    messageId,
    raw,
    hasVoice,
    voiceUrl: voiceUrl ? String(voiceUrl) : undefined,
  };
}

/* =========================
   UltraMsg: send text + voice
========================= */

async function sendViaUltramsgText(to: string, message: string) {
  const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
  const token = process.env.ULTRAMSG_TOKEN;
  if (!instanceId || !token) throw new Error("Missing ULTRAMSG_INSTANCE_ID/ULTRAMSG_TOKEN");

  const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;

  const body = new URLSearchParams({
    token,
    to,
    body: message,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const txt = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`UltraMsg text send failed: ${res.status} ${txt}`);
}

async function sendViaUltramsgVoice(to: string, audioUrl: string) {
  const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
  const token = process.env.ULTRAMSG_TOKEN;
  if (!instanceId || !token) throw new Error("Missing ULTRAMSG_INSTANCE_ID/ULTRAMSG_TOKEN");

  const url = `https://api.ultramsg.com/${instanceId}/messages/voice`;

  const body = new URLSearchParams({
    token,
    to,
    audio: audioUrl, // must be a URL UltraMsg can fetch
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const txt = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`UltraMsg voice send failed: ${res.status} ${txt}`);
}

/* =========================
   Firestore: one collection "users"
   One doc per user, messages array
========================= */

type MessageItem = {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  provider: Provider;
};

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

async function upsertMessageArray(userId: string, message: MessageItem) {
  const firestore = db();
  const ref = firestore.collection("users").doc(userId);

  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = admin.firestore.FieldValue.serverTimestamp();

    const data = snap.exists ? (snap.data() || {}) : {};
    const messages: MessageItem[] = Array.isArray(data.messages) ? data.messages : [];
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
    if (idx >= 0) messages[idx] = { ...messages[idx], ...message, ts: messages[idx].ts ?? message.ts };
    else messages.push(message);

    messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    tx.set(ref, { messages, updatedAt: now }, { merge: true });
  });
}

function getRecentHistoryForLLM(all: MessageItem[], limit: number) {
  return (all || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(-limit)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
}

/* =========================
   Voice: Transcribe + TTS (TEMP upload then delete)
   Firestore stores only transcript text (NOT audio)
========================= */

async function transcribeAudioFromUrl(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch voice: ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const file = new File([buf], "voice-note", { type: "application/octet-stream" });

  const tr: any = await openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file,
    response_format: "text",
  });

  return (tr?.text || "").toString().trim();
}

function pickVoice(isArabic: boolean): string {
  return isArabic ? "alloy" : "alloy";
}

async function ttsToMp3Buffer(text: string, voice: string) {
  const ttsModel = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const audio = await openai.audio.speech.create({
    model: ttsModel,
    voice,
    input: text,
  });
  return Buffer.from(await audio.arrayBuffer());
}

async function uploadTempMp3GetSignedUrlAndDelete(
  userId: string,
  messageId: string,
  mp3: Buffer
) {
  initFirebaseAdmin();

  const bucket = admin.storage().bucket();
  if (!bucket) throw new Error("Missing Firebase storageBucket (FIREBASE_STORAGE_BUCKET)");

  const path = `tmp_wa_tts/${userId}/${messageId}.mp3`;
  const file = bucket.file(path);

  await file.save(mp3, {
    contentType: "audio/mpeg",
    resumable: false,
    metadata: { cacheControl: "no-store" },
  });

  const [signedUrl] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 1000 * 60 * 5, // 5 minutes
  });

  // Return BOTH url + deleter
  return {
    signedUrl,
    cleanup: async () => {
      try {
        await file.delete({ ignoreNotFound: true });
      } catch {}
    },
  };
}

/* =========================
   POST Handler (UltraMsg only)
========================= */

export async function POST(req: NextRequest) {
  try {
    const { provider, userId, toRaw, text, messageId, raw, hasVoice, voiceUrl } =
      await parseUltraMsgIncoming(req);

    if (!userId) return NextResponse.json({ ok: true });

    // Ignore non-message events if present
    const eventType = raw?.event_type;
    if (eventType && eventType !== "message_received") return NextResponse.json({ ok: true });

    await ensureUserDoc(userId);

    // If voice note: transcribe and use transcript as the saved user message text
    let userText = (text || "").trim();
    let inboundWasVoice = false;

    if (hasVoice && voiceUrl) {
      try {
        const transcript = await transcribeAudioFromUrl(voiceUrl);
        if (transcript) {
          userText = transcript;
          inboundWasVoice = true;
        }
      } catch (e) {
        console.error("Voice transcription failed:", e);
      }
    }

    // Save inbound (ONLY transcript/text)
    await upsertMessageArray(userId, {
      id: messageId,
      role: "user",
      text: userText || "",
      ts: Date.now(),
      provider,
    });

    // Load user
    const firestore = db();
    const userRef = firestore.collection("users").doc(userId);
    const snap = await userRef.get();
    const data = snap.data() || {};
    const profile = data.profile || {};
    const step = profile.onboardingStep || "gender";

    const isArabic = containsArabic(userText);
    const wantsDetail = userRequestedDetails(userText);

    let reply = "";

    // After onboarding: greetings allowed
    if (step === "done" && isGreeting(userText)) {
      reply = greetingReply(isArabic);
    } else if (step !== "done") {
      // Onboarding gate
      if (step === "gender") {
        const g = normalizeGender(userText);
        if (!g) reply = Q1;
        else {
          await updateProfile(userId, {
            gender: g.value,
            genderLabel: g.label,
            onboardingStep: "location",
          });
          reply = Q2;
        }
      } else if (step === "location") {
        const loc = normalizeLocation(userText);
        if (!loc) reply = Q2;
        else {
          await updateProfile(userId, {
            location: loc.value,
            locationLabel: loc.label,
            onboardingStep: "age",
          });
          reply = Q3;
        }
      } else if (step === "age") {
        const age = parseAge(userText);
        if (!age) reply = Q3;
        else {
          await updateProfile(userId, { age, onboardingStep: "done" });
          reply = WELCOME;
        }
      } else {
        await updateProfile(userId, { onboardingStep: "gender" });
        reply = Q1;
      }
    } else {
      // GPT chat WITH CONTEXT
      const LANGUAGE_ENFORCER = {
        role: "system" as const,
        content: isArabic
          ? "Answer only in Arabic. Use simple, clear Modern Standard Arabic. Do not include English unless the user includes it."
          : "Answer only in English. Use simple, clear sentences. Do not mix languages unless the user mixes them.",
      };

      const model = process.env.OPENAI_MODEL_CHAT || "gpt-4o-mini";
      const history = getRecentHistoryForLLM(data.messages || [], 16);

      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.5,
        messages: [
          { role: "system" as const, content: SYSTEM_PROMPT },
          LANGUAGE_ENFORCER,
          ...history,
        ],
      });

      reply =
        completion.choices[0]?.message?.content?.trim() ||
        (isArabic ? "عذرًا، صار في مشكلة بسيطة. جرّب مرة ثانية." : "Sorry — something went wrong. Please try again.");

      reply = reply.replace(/[*#]/g, "");
      if (!wantsDetail) reply = shortenToSentences(reply, 4);
    }

    // Save outbound text
    const assistantMsgId = `assistant_${messageId}`;
    await upsertMessageArray(userId, {
      id: assistantMsgId,
      role: "assistant",
      text: reply,
      ts: Date.now(),
      provider,
    });

    // Send back:
    // - Always send text
    // - If inbound was voice and onboarding is done => also send voice reply
    await sendViaUltramsgText(toRaw, reply);

    if (step === "done" && inboundWasVoice) {
      try {
        const voice = pickVoice(isArabic);
        const mp3 = await ttsToMp3Buffer(reply, voice);

        // TEMP upload => signed URL => send => delete
        const { signedUrl, cleanup } = await uploadTempMp3GetSignedUrlAndDelete(
          userId,
          assistantMsgId,
          mp3
        );

        try {
          await sendViaUltramsgVoice(toRaw, signedUrl);
        } finally {
          await cleanup(); // delete the file no matter what
        }
      } catch (e) {
        console.error("Voice reply failed (kept text reply):", e);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    // Always 200 to avoid provider retry storms
    return NextResponse.json({ ok: true });
  }
}
