// app/api/stt/route.ts
import { NextResponse } from "next/server";
import { openai } from "@/lib/openai"; // same openai client you use for chat

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const languageHint = formData.get("language") as string | null;

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing audio file" },
        { status: 400 }
      );
    }

    // Call OpenAI transcription
    const result = await openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe", // or "gpt-4o-transcribe" etc.
      temperature: 0,
      // Optional hint: only "ar" or "en" to avoid Turkish / random languages
      language:
        languageHint === "ar" ? "ar" : languageHint === "en" ? "en" : undefined,
      response_format: "json",
    });

    // result.text contains the transcription
    return NextResponse.json({ text: result.text ?? "" });
  } catch (err: any) {
    console.error("STT route error:", err);
    return NextResponse.json(
      { error: "STT server error", details: String(err?.message ?? err) },
      { status: 500 }
    );
  }
}

export const dynamic = "force-dynamic";
