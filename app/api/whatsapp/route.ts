import { NextResponse } from "next/server";
import twilio from "twilio";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const msg = String(formData.get("Body") || "").trim();

    // ----- Your AI call -----
    const reply = `You said: ${msg}`;

    // Twilio requires XML TwiML response
    const twiml = `
      <Response>
        <Message>${reply}</Message>
      </Response>
    `.trim();

    return new NextResponse(twiml, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  } catch (err) {
    console.error("WhatsApp webhook error:", err);

    const errorTwiml = `
      <Response>
        <Message>Server error. Try again later.</Message>
      </Response>
    `.trim();

    return new NextResponse(errorTwiml, {
      status: 500,
      headers: { "Content-Type": "text/xml" },
    });
  }
}

export const dynamic = "force-dynamic";
