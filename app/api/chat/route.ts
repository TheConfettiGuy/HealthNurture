// app/api/chat/route.ts
import { openai } from "@/lib/openai";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ClientMessage = {
  role: "user" | "assistant";
  content: string;
};

// Detect Arabic vs English
function containsArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

// Shorten to a few sentences unless user asked for more
function shortenToSentences(text: string, maxSentences: number): string {
  const parts = text
    .split(/(?<=[.!؟])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length <= maxSentences) return text;
  return parts.slice(0, maxSentences).join(" ");
}

// Detect explicit request for more detail
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

// Obvious out-of-scope topics (cats, games, cars, coding, etc.)
function isClearlyOffTopic(text: string): boolean {
  const lower = text.toLowerCase();

  const bannedTopics = [
    // animals / pets
    "cat",
    "cats",
    "dog",
    "dogs",
    "animal",
    "animals",
    "pet",
    "pets",
    // vehicles
    "car",
    "cars",
    "engine",
    "vehicle",
    "motorcycle",
    "bike",
    // games / entertainment
    "game",
    "games",
    "fortnite",
    "minecraft",
    "playstation",
    "xbox",
    "nintendo",
    "movie",
    "movies",
    "series",
    "anime",
    // coding / tech
    "coding",
    "programming",
    "javascript",
    "typescript",
    "python",
    "nextjs",
    "react",
    "computer",
    "laptop",
    "iphone",
    "android",
    // general knowledge
    "capital of",
    "planet",
    "galaxy",
    "space",
    "math",
    "equation",
    "physics",
    "chemistry",
  ];

  return bannedTopics.some((w) => lower.includes(w));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const clientMessages = body?.messages as ClientMessage[] | undefined;
    const model = process.env.OPENAI_MODEL_CHAT || "gpt-4o-mini";

    if (!clientMessages || clientMessages.length === 0) {
      return NextResponse.json(
        { error: "Missing 'messages' array" },
        { status: 400 }
      );
    }

    // Last user message (for language + detail + off-topic check)
    const lastUser = clientMessages
      .filter((m) => m.role === "user")
      .slice(-1)[0];

    const lastUserText = lastUser?.content ?? "";
    const isArabic = containsArabic(lastUserText);
    const wantsDetail = userRequestedDetails(lastUserText);

    // Hard off-topic guard: never answer clearly unrelated stuff
    if (isClearlyOffTopic(lastUserText)) {
      const msg = isArabic
        ? "أنا هنا لمساعدتك في أمور البلوغ والصحة الجنسية والمشاعر والعلاقات، لذلك لا يمكنني الإجابة على هذا السؤال."
        : "I am here to help with puberty, sexual and reproductive health, emotions and relationships, so I cannot answer that question.";
      return NextResponse.json({
        message: { role: "assistant", content: msg },
      });
    }

    // System prompt with your rules
    const SYSTEM_PROMPT: ChatMessage = {
      role: "system",
      content: `
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
`,
    };

    const LANGUAGE_ENFORCER: ChatMessage = {
      role: "system",
      content: isArabic
        ? "Answer only in Arabic. Use simple, clear Modern Standard Arabic. Do not include English unless the user includes it."
        : "Answer only in English. Use simple, clear sentences. Do not mix languages unless the user mixes them.",
    };

    // Map client messages to OpenAI format
    const history: ChatMessage[] = clientMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const completion = await openai.chat.completions.create({
      model,
      messages: [SYSTEM_PROMPT, LANGUAGE_ENFORCER, ...history],
      temperature: 0.5,
    });

    let output = completion.choices[0]?.message?.content?.trim() || "";

    // Strip stray markdown symbols
    output = output.replace(/[*#]/g, "");

    // Short answer by default
    if (!wantsDetail) {
      output = shortenToSentences(output, 4);
    }

    return NextResponse.json({
      message: { role: "assistant", content: output },
    });
  } catch (err) {
    console.error("Chat API error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
