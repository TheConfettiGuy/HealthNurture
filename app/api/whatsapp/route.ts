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
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "Missing FIREBASE_SERVICE_ACCOUNT_JSON (Firebase service account JSON as a single-line env var)"
    );
  }

  // It must be single-line JSON. private_key must contain \n (escaped) inside the string.
  const serviceAccount = JSON.parse(raw);

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function db() {
  initFirebaseAdmin();
  return admin.firestore();
}

/* =========================
   Prompts / helpers
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

/* =========================
   UltraMsg parsing
   (works even if you swap providers later)
========================= */

type ParsedInbound = {
  provider: "ultramsg";
  messageId: string; // stable-ish id
  fromUserId: string; // phone-only id (e.g. 96170062123)
  text: string;
  raw: any;
};

function extractDigitsPhone(value: string): string {
  // "96170062123@c.us" -> "96170062123"
  return (value || "").replace(/[^\d]/g, "");
}

async function parseInbound(req: NextRequest): Promise<ParsedInbound | null> {
  const ct = req.headers.get("content-type") || "";

  // UltraMsg sends application/json
  if (ct.includes("application/json")) {
    const raw = await req.json().catch(() => null);
    if (!raw) return null;

    // Typical UltraMsg payload (based on your logs):
    // raw.event_type === "message_received"
    // raw.data.body, raw.data.from, raw.data.sid, raw.data.id
    const msg = raw.data || raw?.raw?.data || raw?.data;
    const bodyText = (msg?.body || "").toString().trim();
    const from = (msg?.from || "").toString();
    const sid = (msg?.sid || msg?.id || raw?.hash || "").toString();

    const fromUserId = extractDigitsPhone(from);

    return {
      provider: "ultramsg",
      messageId: sid || `${fromUserId}_${Date.now()}`,
      fromUserId,
      text: bodyText,
      raw,
    };
  }

  // If some other provider hits this endpoint, you can extend here later.
  return null;
}

/* =========================
   Firestore: upsert message inside array
========================= */

type MessageItem = {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number; // epoch ms
  provider: "ultramsg";
};

async function upsertMessageArray(params: {
  userId: string;
  message: MessageItem;
}) {
  const firestore = db();
  const ref = firestore.collection("wa_users").doc(params.userId);

  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    const now = admin.firestore.FieldValue.serverTimestamp();

    if (!snap.exists) {
      tx.set(
        ref,
        {
          profile: {
            userId: params.userId,
            createdAt: now,
            updatedAt: now,
          },
          messages: [params.message],
          updatedAt: now,
        },
        { merge: true }
      );
      return;
    }

    const data = snap.data() || {};
    const messages: MessageItem[] = Array.isArray(data.messages)
      ? data.messages
      : [];

    const idx = messages.findIndex((m) => m?.id === params.message.id);

    if (idx >= 0) {
      // update existing message object (same id)
      messages[idx] = {
        ...messages[idx],
        ...params.message,
        ts: messages[idx].ts ?? params.message.ts, // keep original ts if it exists
      };
    } else {
      // append to end (chronological by write order / ts)
      messages.push(params.message);
    }

    tx.set(
      ref,
      {
        messages,
        updatedAt: now,
      },
      { merge: true }
    );
  });
}

/* =========================
   GET (health check)
========================= */

export async function GET() {
  return new NextResponse("WhatsApp webhook is live ✅", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/* =========================
   POST (UltraMsg webhook)
========================= */

export async function POST(req: NextRequest) {
  try {
    const inbound = await parseInbound(req);

    if (!inbound) {
      return NextResponse.json(
        { ok: false, error: "Unsupported payload/content-type" },
        { status: 400 }
      );
    }

    const body = inbound.text;
    const userId = inbound.fromUserId;

    console.log("Incoming WhatsApp msg:", {
      provider: inbound.provider,
      contentType: req.headers.get("content-type"),
      from: userId,
      body,
      raw: inbound.raw,
    });

    if (!userId) {
      return NextResponse.json(
        { ok: false, error: "Missing sender id" },
        { status: 200 }
      );
    }

    if (!body) {
      // Save the inbound anyway (optional). Here we skip responding.
      await upsertMessageArray({
        userId,
        message: {
          id: inbound.messageId,
          role: "user",
          text: "",
          ts: Date.now(),
          provider: "ultramsg",
        },
      });

      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // Save USER message (upsert by messageId)
    await upsertMessageArray({
      userId,
      message: {
        id: inbound.messageId,
        role: "user",
        text: body,
        ts: Date.now(),
        provider: "ultramsg",
      },
    });

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

    let reply =
      completion.choices[0]?.message?.content?.trim() ||
      "Sorry, something went wrong while answering your question.";

    reply = reply.replace(/[*#]/g, "");
    if (!wantsDetail) reply = shortenToSentences(reply, 4);

    // Save ASSISTANT message (new id so it always appends)
    const assistantId = `assistant_${inbound.messageId}`;
    await upsertMessageArray({
      userId,
      message: {
        id: assistantId,
        role: "assistant",
        text: reply,
        ts: Date.now(),
        provider: "ultramsg",
      },
    });

    /**
     * IMPORTANT:
     * UltraMsg typically does NOT send your reply automatically from webhook response.
     * You must send reply via UltraMsg "send message" API from your server.
     *
     * If you already have sending logic elsewhere, keep it there.
     * If you want, I can add the UltraMsg send call here (needs instanceId + token env vars).
     */
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}
