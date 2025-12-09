// app/api/tts/route.ts
import { NextRequest, NextResponse } from "next/server";
import { openai } from "@/lib/openai";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();

    if (!text || typeof text !== "string") {
      return NextResponse.json(
        { error: "Missing 'text' in body" },
        { status: 400 }
      );
    }

    // Simple Arabic detection to let you tweak voice/model later if you want
    const isArabic = /[\u0600-\u06FF]/.test(text);

    const model = process.env.OPENAI_MODEL_TTS || "gpt-4o-mini-tts";

    const speech = await openai.audio.speech.create({
      model,
      voice: isArabic ? "alloy" : "alloy", // same voice, auto language
      // NOTE: do NOT pass `format` here – TS doesn't allow it in your SDK version
      input: text,
    });

    // Convert response to Node Buffer
    const audioBuffer = Buffer.from(await speech.arrayBuffer());

    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("TTS route error:", err);
    return NextResponse.json(
      { error: "TTS generation failed" },
      { status: 500 }
    );
  }
}
