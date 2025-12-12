// app/api/whatsapp/route.ts
import { NextRequest, NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import admin from "firebase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* =========================
   Firebase Admin (server)
========================= */

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) {
    throw new Error(
      "Missing FIREBASE_SERVICE_ACCOUNT_JSON (Firebase service account JSON as a single-line env var)."
    );
  }

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
   GET
========================= */

export async function GET() {
  return new NextResponse("WhatsApp webhook is live ✅", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/* =========================
   Prompts + Helpers
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

/* =========================
   UltraMsg + Twilio parsing
========================= */

async function parseIncoming(req: NextRequest): Promise<{
  provider: Provider;
  from: string;
  body: string;
  raw: any;
  contentType: string;
}> {
  const contentType = req.headers.get("content-type") || "";

  // UltraMsg JSON: message is inside raw.data.*
  if (contentType.includes("application/json")) {
    const raw = await req.json().catch(() => ({}));
    const msg = raw?.data ?? raw;
    const from = (msg?.from || raw?.from || "").toString(); // 9617...@c.us
    const body = (msg?.body || raw?.body || "").toString().trim();
    return { provider: "ultramsg", from, body, raw, contentType };
  }

  // Twilio x-www-form-urlencoded
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const raw = Object.fromEntries(new URLSearchParams(text));
    const from = (raw.From || raw.from || "").toString();
    const body = (raw.Body || raw.body || "").toString().trim();
    return { provider: "twilio", from, body, raw, contentType };
  }

  // multipart/form-data
  if (contentType.includes("multipart/form-data")) {
    const fd = await req.formData();
    const raw: Record<string, any> = {};
    fd.forEach((v, k) => (raw[k] = v.toString()));
    const from = (raw.From || raw.from || "").toString();
    const body = (raw.Body || raw.body || "").toString().trim();
    return { provider: "twilio", from, body, raw, contentType };
  }

  const rawText = await req.text().catch(() => "");
  return {
    provider: "unknown",
    from: "",
    body: "",
    raw: { rawText },
    contentType,
  };
}

/* =========================
   UltraMsg send
========================= */

async function sendViaUltramsg(to: string, message: string) {
  const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
  const token = process.env.ULTRAMSG_TOKEN;
  if (!instanceId || !token)
    throw new Error("Missing ULTRAMSG_INSTANCE_ID/ULTRAMSG_TOKEN");

  const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;

  const body = new URLSearchParams({
    token,
    to, // 9617...@c.us
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
   Firestore persistence
========================= */

async function ensureUser(phone: string) {
  const firestore = db();
  const userRef = firestore.collection("users").doc(phone);
  const snap = await userRef.get();

  if (!snap.exists) {
    await userRef.set({
      phone,
      onboardingStep: "gender",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const created = await userRef.get();
    return created.data()!;
  }

  return snap.data()!;
}

async function updateUser(phone: string, patch: Record<string, any>) {
  const firestore = db();
  const userRef = firestore.collection("users").doc(phone);
  await userRef.set(
    {
      ...patch,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function saveMessage(
  phone: string,
  role: "user" | "assistant",
  text: string,
  provider: Provider
) {
  const firestore = db();
  const userRef = firestore.collection("users").doc(phone);
  const msgRef = userRef.collection("messages").doc();
  await msgRef.set({
    role,
    text,
    provider,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* =========================
   Onboarding questions (Bilingual)
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
   Normalization (numbers + text)
   Save real answers to Firestore
========================= */

function normalizeGender(
  input: string
): { value: "male" | "female"; label: string } | null {
  const t = input.trim().toLowerCase();

  if (t === "1" || t === "female" || t === "أنثى" || t === "female/أنثى") {
    return { value: "female", label: "Female/أنثى" };
  }
  if (t === "2" || t === "male" || t === "ذكر" || t === "male/ذكر") {
    return { value: "male", label: "Male/ذكر" };
  }
  return null;
}

function normalizeLocation(
  input: string
): { value: string; label: string } | null {
  const t = input.trim().toLowerCase();

  const byNumber: Record<string, { value: string; label: string }> = {
    "1": { value: "bekkaa", label: "Bekkaa/البقاع" },
    "2": { value: "tripoli", label: "Tripoli/طرابلس" },
    "3": { value: "akkar", label: "Akkar/عكار" },
    "4": { value: "baalbek", label: "Baalbek/بعلبك" },
    "5": { value: "beirut", label: "Beirut/بيروت" },
  };
  if (byNumber[t]) return byNumber[t];

  const byText: Record<string, { value: string; label: string }> = {
    bekkaa: { value: "bekkaa", label: "Bekkaa/البقاع" },
    البقاع: { value: "bekkaa", label: "Bekkaa/البقاع" },
    "bekkaa/البقاع": { value: "bekkaa", label: "Bekkaa/البقاع" },

    tripoli: { value: "tripoli", label: "Tripoli/طرابلس" },
    طرابلس: { value: "tripoli", label: "Tripoli/طرابلس" },
    "tripoli/طرابلس": { value: "tripoli", label: "Tripoli/طرابلس" },

    akkar: { value: "akkar", label: "Akkar/عكار" },
    عكار: { value: "akkar", label: "Akkar/عكار" },
    "akkar/عكار": { value: "akkar", label: "Akkar/عكار" },

    baalbek: { value: "baalbek", label: "Baalbek/بعلبك" },
    بعلبك: { value: "baalbek", label: "Baalbek/بعلbك" }, // typo safe not needed
    "baalbek/بعلبك": { value: "baalbek", label: "Baalbek/بعلبك" },

    beirut: { value: "beirut", label: "Beirut/بيروت" },
    بيروت: { value: "beirut", label: "Beirut/بيروت" },
    "beirut/بيروت": { value: "beirut", label: "Beirut/بيروت" },
  };

  return byText[t] ?? null;
}

function parseAge(input: string): number | null {
  const n = Number(input.trim());
  if (!Number.isFinite(n)) return null;
  if (n < 8 || n > 80) return null; // adjust if you want
  return Math.floor(n);
}

/* =========================
   POST
========================= */

export async function POST(req: NextRequest) {
  try {
    const { provider, from, body, raw } = await parseIncoming(req);

    const phoneId = (from || "").trim();
    if (!phoneId) return NextResponse.json({ ok: true });

    // Save inbound message
    await ensureUser(phoneId);
    await saveMessage(phoneId, "user", body || "", provider);

    // Ignore non-chat types from UltraMsg if present
    const ultraType = raw?.data?.type;
    if (provider === "ultramsg" && ultraType && ultraType !== "chat") {
      return NextResponse.json({ ok: true });
    }

    // Load user
    const firestore = db();
    const userRef = firestore.collection("users").doc(phoneId);
    const userSnap = await userRef.get();
    const user = userSnap.data() || { onboardingStep: "gender" };

    let reply: string;

    // Block chatting until onboarding is done
    const step = user.onboardingStep || "gender";

    if (step !== "done") {
      if (step === "gender") {
        const g = normalizeGender(body);
        if (!g) {
          reply = Q1;
        } else {
          await updateUser(phoneId, {
            gender: g.value,
            genderLabel: g.label,
            onboardingStep: "location",
          });
          reply = Q2;
        }
      } else if (step === "location") {
        const loc = normalizeLocation(body);
        if (!loc) {
          reply = Q2;
        } else {
          await updateUser(phoneId, {
            location: loc.value,
            locationLabel: loc.label,
            onboardingStep: "age",
          });
          reply = Q3;
        }
      } else if (step === "age") {
        const age = parseAge(body);
        if (!age) {
          reply = Q3;
        } else {
          await updateUser(phoneId, {
            age,
            onboardingStep: "done",
          });
          reply = WELCOME;
        }
      } else {
        // unknown step -> restart
        await updateUser(phoneId, { onboardingStep: "gender" });
        reply = Q1;
      }
    } else {
      // Normal GPT chat after onboarding
      const isArabic = containsArabic(body);
      const wantsDetail = userRequestedDetails(body);

      const LANGUAGE_ENFORCER = {
        role: "system" as const,
        content: isArabic
          ? "Answer only in Arabic. Use simple, clear Modern Standard Arabic. Do not include English unless the user includes it."
          : "Answer only in English. Use simple, clear sentences. Do not mix languages unless the user mixes them.",
      };

      const model = process.env.OPENAI_MODEL_CHAT || "gpt-4o-mini";

      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.5,
        messages: [
          { role: "system" as const, content: SYSTEM_PROMPT },
          LANGUAGE_ENFORCER,
          { role: "user" as const, content: body },
        ],
      });

      reply =
        completion.choices[0]?.message?.content?.trim() ||
        "Sorry, something went wrong while answering your question.";

      reply = reply.replace(/[*#]/g, "");
      if (!wantsDetail) reply = shortenToSentences(reply, 4);
    }

    // Save outbound message
    await saveMessage(phoneId, "assistant", reply, provider);

    // Respond per provider
    if (provider === "twilio") {
      const twiml = `<Response><Message>${escapeXml(reply)}</Message></Response>`;
      return new NextResponse(twiml, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }

    if (provider === "ultramsg") {
      await sendViaUltramsg(phoneId, reply);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    // Always 200 to avoid retries storms
    const xml = `<Response><Message>Temporary error. Please try again later.</Message></Response>`;
    return new NextResponse(xml, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }
}
